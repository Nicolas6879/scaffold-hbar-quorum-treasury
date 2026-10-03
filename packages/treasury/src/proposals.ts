import {
  AccountAllowanceApproveTransaction,
  AccountId,
  AccountUpdateTransaction,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  HbarUnit,
  Key,
  ScheduleCreateTransaction,
  Timestamp,
  TokenId,
  Transaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { encodeFunctionData } from "viem";
import { LIMITS } from "./config";
import { swapGuardAbi } from "./swap-guard-abi";

/**
 * Builders for treasury proposals. Every proposal is a ScheduleCreate that:
 *  - is paid by the treasury (so the treasury KeyList threshold must sign it),
 *  - waits for its expiration time before executing (`waitForExpiry`): that window is the veto window,
 *  - can be deleted by the veto key (the schedule admin key) until it executes.
 */
export interface ProposalCommon {
  treasuryId: string;
  /** Schedule admin key: whoever holds it can veto. The template uses a 1-of-N KeyList of the signers. */
  vetoKey: Key;
  /** Unix seconds when the proposal executes (end of the timelock). */
  executeAt: number;
  memo: string;
  /** Unix seconds "now", injectable for tests. */
  nowSec?: number;
}

export class ProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalValidationError";
  }
}

export function validateCommon(p: ProposalCommon): void {
  const now = p.nowSec ?? Math.floor(Date.now() / 1000);
  if (new TextEncoder().encode(p.memo).length > LIMITS.maxMemoBytes) {
    throw new ProposalValidationError(`Memo is longer than ${LIMITS.maxMemoBytes} bytes`);
  }
  if (p.executeAt <= now) throw new ProposalValidationError("Execution time must be in the future");
  if (p.executeAt - now > LIMITS.maxScheduleLifetimeSec) {
    throw new ProposalValidationError("Execution time must be within 62 days (HIP-423)");
  }
}

function schedule(inner: Transaction, p: ProposalCommon): ScheduleCreateTransaction {
  validateCommon(p);
  return new ScheduleCreateTransaction()
    .setScheduledTransaction(inner)
    .setPayerAccountId(AccountId.fromString(p.treasuryId))
    .setAdminKey(p.vetoKey)
    .setExpirationTime(new Timestamp(p.executeAt, 0))
    .setWaitForExpiry(true)
    .setScheduleMemo(p.memo);
}

export function hbarPaymentProposal(p: ProposalCommon & { to: string; tinybar: bigint }) {
  if (p.tinybar <= 0n) throw new ProposalValidationError("Amount must be positive");
  if (p.to === p.treasuryId) throw new ProposalValidationError("Cannot pay the treasury itself");
  const amount = Hbar.from(p.tinybar.toString(), HbarUnit.Tinybar);
  const inner = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(p.treasuryId), amount.negated())
    .addHbarTransfer(AccountId.fromString(p.to), amount);
  return schedule(inner, p);
}

export function tokenPaymentProposal(p: ProposalCommon & { to: string; tokenId: string; amount: bigint }) {
  if (p.amount <= 0n) throw new ProposalValidationError("Amount must be positive");
  if (p.to === p.treasuryId) throw new ProposalValidationError("Cannot pay the treasury itself");
  const token = TokenId.fromString(p.tokenId);
  const inner = new TransferTransaction()
    .addTokenTransfer(token, AccountId.fromString(p.treasuryId), -Number(p.amount))
    .addTokenTransfer(token, AccountId.fromString(p.to), Number(p.amount));
  return schedule(inner, p);
}

/**
 * Swap `tinybar` HBAR for USDC through SwapGuard. The swap runs when the timelock ends, so the guard's
 * deadline must be after `executeAt`; the guard re-checks Chainlink at that moment, not at proposal time.
 */
export function swapProposal(
  p: ProposalCommon & { swapGuardId: string; tinybar: bigint; slippageBps: number; deadline: number; gas?: number },
) {
  if (p.tinybar <= 0n) throw new ProposalValidationError("Amount must be positive");
  if (p.slippageBps < LIMITS.minSwapSlippageBps || p.slippageBps > 1000) {
    throw new ProposalValidationError("Slippage must be between 30 and 1000 bps (the pool fee is 30 bps)");
  }
  if (p.deadline <= p.executeAt) {
    throw new ProposalValidationError("Swap deadline must be after the execution time, or the swap will always revert");
  }
  const data = encodeFunctionData({
    abi: swapGuardAbi,
    functionName: "swapHbarForStable",
    args: [p.slippageBps, BigInt(p.deadline)],
  });
  const inner = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(p.swapGuardId))
    .setGas(p.gas ?? 1_500_000)
    .setPayableAmount(Hbar.from(p.tinybar.toString(), HbarUnit.Tinybar))
    .setFunctionParameters(Buffer.from(data.slice(2), "hex"));
  return schedule(inner, p);
}

/** Set the ops account's USDC budget. Replaces (not adds to) any previous allowance. */
export function budgetProposal(p: ProposalCommon & { opsAccountId: string; tokenId: string; amount: bigint }) {
  if (p.amount < 0n) throw new ProposalValidationError("Budget cannot be negative (use 0 to revoke)");
  if (p.opsAccountId === p.treasuryId) throw new ProposalValidationError("The ops account must differ from the treasury");
  const inner = new AccountAllowanceApproveTransaction().approveTokenAllowance(
    TokenId.fromString(p.tokenId),
    AccountId.fromString(p.treasuryId),
    AccountId.fromString(p.opsAccountId),
    Number(p.amount),
  );
  return schedule(inner, p);
}

/**
 * Replace the treasury key (add/remove a signer, change M-of-N). The network requires the current
 * threshold AND the new key to sign, so new signers must also ScheduleSign before execution.
 */
export function rotateSignersProposal(p: ProposalCommon & { newKey: Key }) {
  const inner = new AccountUpdateTransaction().setAccountId(AccountId.fromString(p.treasuryId)).setKey(p.newKey);
  return schedule(inner, p);
}
