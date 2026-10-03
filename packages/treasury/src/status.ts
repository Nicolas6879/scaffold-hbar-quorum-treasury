import { KeyNode, base64ToHex, signatureProgress } from "./keys";

/** Shape of `GET /api/v1/schedules/{id}` (fields we use). */
export interface MirrorSchedule {
  schedule_id: string;
  creator_account_id: string;
  payer_account_id: string;
  admin_key: { _type: string; key: string } | null;
  consensus_timestamp: string;
  deleted: boolean;
  executed_timestamp: string | null;
  expiration_time: string | null;
  memo: string;
  wait_for_expiry: boolean;
  signatures: { public_key_prefix: string; signature: string; type: string; consensus_timestamp: string }[];
  transaction_body: string;
}

export type ProposalState =
  /** Not enough signatures yet. */
  | "collecting-signatures"
  /** Quorum reached; waiting for the expiration time (veto window open). */
  | "timelocked"
  /** Expiration passed with quorum; the network runs it on the next transaction (lazy execution). */
  | "executing"
  /** Executed and the inner transaction succeeded. */
  | "executed"
  /** Executed but the inner transaction failed (e.g. INSUFFICIENT_PAYER_BALANCE, CONTRACT_REVERT_EXECUTED). */
  | "failed"
  /** Deleted with the admin key during the veto window. */
  | "vetoed"
  /** Expired without enough signatures. */
  | "expired";

export interface ProposalStatus {
  state: ProposalState;
  signed: number;
  required: number;
  /** Seconds until execution/expiry, when relevant. */
  secondsLeft: number | null;
  innerResult: string | null;
}

/** Mirror timestamps are "seconds.nanoseconds" strings. */
export function timestampToSeconds(ts: string): number {
  const [seconds = "0", nanos = "0"] = ts.split(".");
  return Number(seconds) + Number(`0.${nanos}`);
}

/**
 * @param treasuryKey The key the schedule needs (the payer's key — the treasury KeyList).
 * @param innerResult `result` of the scheduled child transaction, when executed (from `/transactions?scheduled=true`).
 */
export function proposalStatus(
  schedule: MirrorSchedule,
  treasuryKey: KeyNode,
  nowSec: number,
  innerResult: string | null = null,
): ProposalStatus {
  const prefixes = schedule.signatures.map(s => base64ToHex(s.public_key_prefix));
  const progress = signatureProgress(treasuryKey, prefixes);
  const expiresAt = schedule.expiration_time ? timestampToSeconds(schedule.expiration_time) : null;
  const base = { signed: progress.signed, required: progress.required, innerResult };

  if (schedule.deleted) return { ...base, state: "vetoed", secondsLeft: null };
  if (schedule.executed_timestamp) {
    const ok = innerResult === null || innerResult === "SUCCESS";
    return { ...base, state: ok ? "executed" : "failed", secondsLeft: null };
  }
  const secondsLeft = expiresAt === null ? null : Math.max(0, Math.ceil(expiresAt - nowSec));
  if (!progress.complete) {
    if (expiresAt !== null && nowSec >= expiresAt) return { ...base, state: "expired", secondsLeft: 0 };
    return { ...base, state: "collecting-signatures", secondsLeft };
  }
  if (!schedule.wait_for_expiry) {
    // Without the timelock the network executes as soon as the threshold is met; the mirror
    // may simply not have caught up yet.
    return { ...base, state: "executing", secondsLeft: 0 };
  }
  if (expiresAt !== null && nowSec >= expiresAt) return { ...base, state: "executing", secondsLeft: 0 };
  return { ...base, state: "timelocked", secondsLeft };
}

/** States where a signer can still act. */
export const canSign = (s: ProposalState) => s === "collecting-signatures";
/** Veto is possible until the network executes the schedule. */
export const canVeto = (s: ProposalState) => s === "collecting-signatures" || s === "timelocked";
