import type { MirrorTopicMessage } from "./mirror";
import type { MirrorSchedule } from "./status";

/**
 * The proposal index. The mirror node cannot list schedules by payer, so every proposal created
 * through the template is announced on an HCS topic whose submit key is any one of the treasury
 * signers. The message adds the human intent (title, description, invoice hash) and the Chainlink
 * round used to value it. The UI reconciles the index with the ledger and flags differences.
 */
export const INDEX_VERSION = "quorum-treasury/v1";

export type ProposalType = "hbar-payment" | "token-payment" | "swap" | "budget" | "rotate-signers";

export interface IndexMessage {
  v: typeof INDEX_VERSION;
  scheduleId: string;
  type: ProposalType;
  title: string;
  description?: string;
  /** sha256 of an attached invoice/document, hex. */
  invoiceHash?: string;
  /** USD value at proposal time, 6 decimals, as a decimal string (JSON has no bigint). */
  usdValue6?: string;
  chainlinkRound?: string;
  /** How the proposer signed the ScheduleCreate: "hashpack" | "script". Self-reported, shown as such. */
  signedVia?: "hashpack" | "script";
}

const TYPES: ProposalType[] = ["hbar-payment", "token-payment", "swap", "budget", "rotate-signers"];
const SCHEDULE_ID = /^\d+\.\d+\.\d+$/;
/** HCS messages above 1024 bytes are chunked; keep index entries in one chunk. */
export const MAX_INDEX_MESSAGE_BYTES = 1024;

export function encodeIndexMessage(msg: Omit<IndexMessage, "v">): string {
  const full: IndexMessage = { v: INDEX_VERSION, ...msg };
  const problem = validate(full);
  if (problem) throw new Error(`Invalid index message: ${problem}`);
  const json = JSON.stringify(full);
  if (new TextEncoder().encode(json).length > MAX_INDEX_MESSAGE_BYTES) {
    throw new Error("Index message too large; shorten the description");
  }
  return json;
}

export type ParsedIndexEntry =
  | { ok: true; entry: IndexMessage; sequence: number; timestamp: string; payer: string }
  | { ok: false; reason: string; sequence: number };

/** Parse a raw mirror topic message (base64). Never throws: foreign or corrupt messages are reported. */
export function parseIndexMessage(raw: MirrorTopicMessage): ParsedIndexEntry {
  const sequence = raw.sequence_number;
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw.message), c => c.charCodeAt(0))));
  } catch {
    return { ok: false, reason: "not JSON", sequence };
  }
  if (typeof data !== "object" || data === null) return { ok: false, reason: "not an object", sequence };
  const v = (data as { v?: unknown }).v;
  if (v !== INDEX_VERSION) return { ok: false, reason: `unknown version ${String(v)}`, sequence };
  const problem = validate(data as IndexMessage);
  if (problem) return { ok: false, reason: problem, sequence };
  return { ok: true, entry: data as IndexMessage, sequence, timestamp: raw.consensus_timestamp, payer: raw.payer_account_id };
}

function validate(m: IndexMessage): string | null {
  if (typeof m.scheduleId !== "string" || !SCHEDULE_ID.test(m.scheduleId)) return "scheduleId must be a 0.0.x id";
  if (!TYPES.includes(m.type)) return `unknown type ${String(m.type)}`;
  if (typeof m.title !== "string" || m.title.trim().length === 0 || m.title.length > 120) return "title must be 1-120 chars";
  if (m.invoiceHash !== undefined && !/^[0-9a-f]{64}$/.test(String(m.invoiceHash))) return "invoiceHash must be sha256 hex";
  if (m.usdValue6 !== undefined && (typeof m.usdValue6 !== "string" || !/^\d+$/.test(m.usdValue6))) {
    return "usdValue6 must be an integer string";
  }
  if (m.signedVia !== undefined && m.signedVia !== "hashpack" && m.signedVia !== "script") {
    return 'signedVia must be "hashpack" or "script"';
  }
  return null;
}

export type ReconcileFlag =
  | "ok"
  /** Indexed but the schedule does not exist on the ledger (typo, other network, or never created). */
  | "missing-on-ledger"
  /** The schedule is paid by a different account than this treasury. */
  | "wrong-payer"
  /** Announced more than once; only the first announcement counts. */
  | "duplicate-announcement";

export interface ReconciledProposal {
  entry: IndexMessage;
  schedule: MirrorSchedule | null;
  flag: ReconcileFlag;
  announcedAt: string;
}

/** Join index entries with ledger schedules. `schedules` is keyed by schedule id. */
export function reconcile(
  entries: ParsedIndexEntry[],
  schedules: Map<string, MirrorSchedule | null>,
  treasuryId: string,
): ReconciledProposal[] {
  const seen = new Set<string>();
  const out: ReconciledProposal[] = [];
  for (const e of entries) {
    if (!e.ok) continue;
    const schedule = schedules.get(e.entry.scheduleId) ?? null;
    let flag: ReconcileFlag = "ok";
    if (seen.has(e.entry.scheduleId)) flag = "duplicate-announcement";
    else if (!schedule) flag = "missing-on-ledger";
    else if (schedule.payer_account_id !== treasuryId) flag = "wrong-payer";
    seen.add(e.entry.scheduleId);
    out.push({ entry: e.entry, schedule, flag, announcedAt: e.timestamp });
  }
  return out;
}
