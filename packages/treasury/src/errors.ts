/**
 * Hedera status codes a treasury user actually hits, mapped to what to do about them.
 * Codes are matched as strings so this works with SDK errors, receipts and mirror results alike.
 */

export interface StatusInfo {
  message: string;
  /** Transient: the same request may succeed if retried. */
  retryable: boolean;
}

export const STATUS_INFO: Record<string, StatusInfo> = {
  NO_NEW_VALID_SIGNATURES: {
    message: "You already signed this proposal (or your key is not part of the treasury).",
    retryable: false,
  },
  SCHEDULE_ALREADY_EXECUTED: { message: "This proposal has already executed.", retryable: false },
  SCHEDULE_ALREADY_DELETED: { message: "This proposal was vetoed.", retryable: false },
  IDENTICAL_SCHEDULE_ALREADY_CREATED: {
    message: "An identical proposal already exists; sign that one instead of creating a duplicate.",
    retryable: false,
  },
  INVALID_SCHEDULE_ID: { message: "No proposal with this schedule id exists on this network.", retryable: false },
  SCHEDULE_IS_IMMUTABLE: { message: "This proposal was created without a veto key and cannot be deleted.", retryable: false },
  SCHEDULE_EXPIRATION_TIME_TOO_FAR_IN_FUTURE: {
    message: "Proposals can expire at most 62 days ahead (HIP-423).",
    retryable: false,
  },
  SCHEDULE_EXPIRATION_TIME_MUST_BE_HIGHER_THAN_CONSENSUS_TIME: {
    message: "The expiration time is already in the past.",
    retryable: false,
  },
  SCHEDULE_EXPIRY_IS_BUSY: {
    message: "Too many proposals expire in that second; pick a slightly different time.",
    retryable: true,
  },
  INVALID_SIGNATURE: { message: "The signature does not match the required key.", retryable: false },
  INSUFFICIENT_PAYER_BALANCE: { message: "The treasury cannot pay the fee for this transaction.", retryable: false },
  INSUFFICIENT_ACCOUNT_BALANCE: { message: "The treasury balance is too low for this payment.", retryable: false },
  SPENDER_DOES_NOT_HAVE_ALLOWANCE: { message: "The ops account has no budget allowance from the treasury.", retryable: false },
  AMOUNT_EXCEEDS_ALLOWANCE: { message: "This spend exceeds the remaining ops budget; propose it to the quorum.", retryable: false },
  TOKEN_NOT_ASSOCIATED_TO_ACCOUNT: { message: "The receiving account is not associated with this token.", retryable: false },
  CONTRACT_REVERT_EXECUTED: { message: "The contract call reverted (see the revert reason).", retryable: false },
  BUSY: { message: "The node is busy.", retryable: true },
  PLATFORM_TRANSACTION_NOT_CREATED: { message: "The node did not accept the transaction in time.", retryable: true },
  PLATFORM_NOT_ACTIVE: { message: "The node is not active.", retryable: true },
};

/** Extract a known status code from anything thrown by the SDK, a receipt or a mirror result. */
export function statusOf(error: unknown): string | null {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : JSON.stringify(error);
  if (!text) return null;
  const match = Object.keys(STATUS_INFO).find(code => new RegExp(`\\b${code}\\b`).test(text));
  return match ?? null;
}

export function explain(error: unknown): string {
  const code = statusOf(error);
  if (code) return `${STATUS_INFO[code]!.message} (${code})`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wallet (WalletConnect / HashPack) failures in words a user can act on. Falls back to {@link explain},
 * so ledger status codes such as NO_NEW_VALID_SIGNATURES keep their own message.
 */
export function explainWalletError(error: unknown): string {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : (JSON.stringify(error) ?? "");
  if (/reject|denied|declin|cancel|user closed|closed (the )?modal/i.test(text)) {
    return "You rejected the request in your wallet. Nothing was sent.";
  }
  if (/(session|pairing).*(expired|not found|deleted|disconnect)|no matching key|^expired/i.test(text)) {
    return "Your wallet session expired. Disconnect, connect HashPack again and retry.";
  }
  if (/\b(chain|namespace)\b|ledger|wrong network|different network/i.test(text)) {
    return "The wallet is on a different network. Switch HashPack to Hedera testnet and reconnect.";
  }
  return explain(error);
}

export function isRetryable(error: unknown): boolean {
  const code = statusOf(error);
  if (code) return STATUS_INFO[code]!.retryable;
  // `AbortSignal.timeout` rejects with a TimeoutError; undici reports a dropped connection as "fetch failed".
  if (error instanceof Error && (error.name === "TimeoutError" || error.message === "fetch failed")) return true;
  const status = (error as { status?: number } | null)?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Retry transient failures with exponential backoff and full jitter. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 4, baseDelayMs = 500, sleep = ms => new Promise(r => setTimeout(r, ms)), random = Math.random } =
    options;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      await sleep(Math.floor(random() * baseDelayMs * 2 ** attempt));
    }
  }
}
