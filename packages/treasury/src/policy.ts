import { DEFAULT_POLICY } from "./config";

/**
 * Where a spend goes, decided from its USD value (valued with Chainlink by the caller).
 *
 * What the network enforces: the ops account cannot spend more than its USDC allowance,
 * quorum proposals cannot run without the threshold key, and the timelock/veto window is
 * real (`waitForExpiry`). What this function decides is *routing*: it lives in the template,
 * so a team that bypasses the UI can still send any quorum proposal it likes.
 */
export interface SpendPolicy {
  /** USDC (6 decimals) the ops account may still spend under its allowance. */
  opsBudgetRemainingUsd6: bigint;
  timelockSec: number;
  longTimelockThresholdUsd6: bigint;
  longTimelockSec: number;
}

export type Route =
  | { kind: "ops-budget"; reason: string }
  | { kind: "quorum"; timelockSec: number; reason: string };

export function defaultPolicy(opsBudgetRemainingUsd6: bigint): SpendPolicy {
  return {
    opsBudgetRemainingUsd6,
    timelockSec: DEFAULT_POLICY.timelockSec,
    longTimelockThresholdUsd6: DEFAULT_POLICY.longTimelockThresholdUsd6,
    longTimelockSec: DEFAULT_POLICY.longTimelockSec,
  };
}

/**
 * @param usd6 USD value of the spend (6 decimals).
 * @param isUsdcPayment Only USDC payments can come out of the ops allowance (the budget is a USDC allowance).
 */
export function routeSpend(usd6: bigint, policy: SpendPolicy, isUsdcPayment: boolean): Route {
  if (usd6 <= 0n) throw new Error("Spend amount must be positive");
  if (policy.longTimelockSec < policy.timelockSec) {
    throw new Error("Long timelock must be at least the normal timelock");
  }
  if (isUsdcPayment && usd6 <= policy.opsBudgetRemainingUsd6) {
    return { kind: "ops-budget", reason: "Within the ops USDC allowance: one signer, no timelock" };
  }
  if (usd6 > policy.longTimelockThresholdUsd6) {
    return {
      kind: "quorum",
      timelockSec: policy.longTimelockSec,
      reason: "Above the large-payment threshold: quorum plus the long veto window",
    };
  }
  return {
    kind: "quorum",
    timelockSec: policy.timelockSec,
    reason: isUsdcPayment ? "Exceeds the remaining ops budget: needs the quorum" : "Non-USDC spends always need the quorum",
  };
}
