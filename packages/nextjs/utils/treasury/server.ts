// Server-only module: imported exclusively from server components and route handlers.
import {
  KeyNode,
  MirrorClient,
  MirrorSchedule,
  ProposalStatus,
  ReconciledProposal,
  TESTNET,
  decodeScheduleBody,
  describeProposal,
  keyFromMirror,
  parseIndexMessage,
  proposalStatus,
  readPriceRound,
  reconcile,
} from "@sh/treasury";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";

/** Public deployment record written by `yarn treasury:setup` / `treasury:demo` (ids only, no secrets). */
export interface Deployment {
  treasuryId?: string;
  opsAccountId?: string;
  indexTopicId?: string;
  swapGuardUsdcId?: string;
  swapGuardDemoId?: string;
  demoStableTokenId?: string;
}

export interface Proof {
  id: string;
  claim: string;
  hashscan: string;
  mirrorPath: string;
  signedBy?: string;
  test?: string;
}

/** Files live at the repo root; Next runs from packages/nextjs. */
function readRootJson<T>(relative: string, fallback: T): T {
  for (const base of [path.join(process.cwd(), "../.."), process.cwd()]) {
    const file = path.join(base, relative);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  }
  return fallback;
}

export function loadDeployment(): Deployment {
  const d = readRootJson<Deployment>("deployments/testnet.json", {});
  // Point the UI at your own treasury without editing files.
  return { ...d, treasuryId: process.env.NEXT_PUBLIC_TREASURY_ID || d.treasuryId };
}

export const loadProofs = () => readRootJson<Proof[]>("docs/proofs.json", []);

const mirror = new MirrorClient(TESTNET.mirrorUrl, (url, init) =>
  fetch(url, { ...init, next: { revalidate: 5 } } as RequestInit),
);

export interface ProposalView {
  scheduleId: string;
  title: string;
  summary: string;
  status: ProposalStatus;
  flag: ReconciledProposal["flag"];
  usdValue6?: string;
  signedVia?: string;
  announcedAt: string;
  memo: string;
}

export interface TreasuryView {
  deployment: Deployment;
  treasuryKey: KeyNode | null;
  hbarTinybar: number;
  usdcUnits: number;
  opsAllowance: { remaining: number; granted: number } | null;
  hbarUsd: number | null;
  priceUpdatedAt: number | null;
  proposals: ProposalView[];
  indexErrors: number;
  error: string | null;
}

/** Everything the dashboard shows. Never throws: an unreachable mirror becomes a visible error, not a 500. */
export async function loadTreasury(): Promise<TreasuryView> {
  const deployment = loadDeployment();
  const empty: TreasuryView = {
    deployment,
    treasuryKey: null,
    hbarTinybar: 0,
    usdcUnits: 0,
    opsAllowance: null,
    hbarUsd: null,
    priceUpdatedAt: null,
    proposals: [],
    indexErrors: 0,
    error: null,
  };
  if (!deployment.treasuryId) return { ...empty, error: "No treasury configured yet. Run `yarn treasury:setup`." };
  try {
    const [account, price] = await Promise.all([mirror.getAccount(deployment.treasuryId), readPrice()]);
    const treasuryKey = account.key ? keyFromMirror(account.key) : null;
    const allowance =
      deployment.opsAccountId &&
      (await mirror
        .getTokenAllowance(deployment.treasuryId, deployment.opsAccountId, TESTNET.usdc.tokenId)
        .catch(() => null));

    let proposals: ProposalView[] = [];
    let indexErrors = 0;
    if (deployment.indexTopicId && treasuryKey) {
      const parsed = (await mirror.listTopicMessages(deployment.indexTopicId, 200)).map(parseIndexMessage);
      indexErrors = parsed.filter(p => !p.ok).length;
      const ids = [...new Set(parsed.flatMap(p => (p.ok ? [p.entry.scheduleId] : [])))].slice(-30);
      const schedules = new Map<string, MirrorSchedule | null>(
        await Promise.all(ids.map(async id => [id, await mirror.getSchedule(id).catch(() => null)] as const)),
      );
      const now = Date.now() / 1000;
      proposals = await Promise.all(
        reconcile(parsed, schedules, deployment.treasuryId).map(async r => {
          const s = r.schedule;
          const inner = s?.executed_timestamp
            ? ((await mirror.getScheduledTransaction(s.executed_timestamp).catch(() => null))?.result ?? null)
            : null;
          const status: ProposalStatus = s
            ? proposalStatus(s, treasuryKey, now, inner)
            : { state: "expired", signed: 0, required: 0, secondsLeft: null, innerResult: null };
          return {
            scheduleId: r.entry.scheduleId,
            title: r.entry.title,
            summary: s
              ? describeProposal(decodeScheduleBody(s.transaction_body), { hbar: formatHbar })
              : "Not found on the ledger",
            status,
            flag: r.flag,
            usdValue6: r.entry.usdValue6,
            signedVia: r.entry.signedVia,
            announcedAt: r.announcedAt,
            memo: s?.memo ?? "",
          };
        }),
      );
      proposals.reverse();
    }

    return {
      ...empty,
      treasuryKey,
      hbarTinybar: account.balance.balance,
      usdcUnits: account.balance.tokens.find(t => t.token_id === TESTNET.usdc.tokenId)?.balance ?? 0,
      opsAllowance: allowance ? { remaining: allowance.amount, granted: allowance.amount_granted } : null,
      hbarUsd: price?.usd ?? null,
      priceUpdatedAt: price?.updatedAt ?? null,
      proposals,
      indexErrors,
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function loadSchedule(id: string) {
  const deployment = loadDeployment();
  const schedule = await mirror.getSchedule(id);
  const account = deployment.treasuryId ? await mirror.getAccount(deployment.treasuryId) : null;
  const key = account?.key ? keyFromMirror(account.key) : null;
  const inner = schedule.executed_timestamp
    ? ((await mirror.getScheduledTransaction(schedule.executed_timestamp))?.result ?? null)
    : null;
  const decoded = decodeScheduleBody(schedule.transaction_body);
  return {
    schedule,
    decoded,
    summary: describeProposal(decoded, { hbar: formatHbar }),
    status: key ? proposalStatus(schedule, key, Date.now() / 1000, inner) : null,
    isTreasuryProposal: schedule.payer_account_id === deployment.treasuryId,
    treasuryKey: key,
  };
}

async function readPrice() {
  try {
    const client = createPublicClient({ transport: http(TESTNET.jsonRpcUrl) });
    const round = await readPriceRound(client as never, TESTNET.chainlinkHbarUsd);
    return { usd: Number(round.answer) / 10 ** round.decimals, updatedAt: Number(round.updatedAt) };
  } catch {
    return null;
  }
}

export function formatHbar(tinybar: bigint | number): string {
  return `${(Number(tinybar) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 4 })} HBAR`;
}
