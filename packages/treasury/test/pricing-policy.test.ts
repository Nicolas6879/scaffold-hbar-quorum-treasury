import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { routeSpend, defaultPolicy, SpendPolicy } from "../src/policy";
import {
  assertUsablePrice,
  BadPriceError,
  PriceRound,
  readPriceRound,
  StalePriceError,
  tinybarToUsd6,
  usd6ToTinybar,
} from "../src/pricing";

// The live testnet round read on 2026-10-03: $0.10212, 8 decimals.
const ROUND: PriceRound = { roundId: 7n, answer: 10_212_000n, updatedAt: 1_800_000_000n, decimals: 8 };
const NOW = 1_800_000_100;

describe("Chainlink price checks", () => {
  it("accepts a fresh positive price", () => {
    expect(() => assertUsablePrice(ROUND, NOW)).not.toThrow();
  });

  it.each([0n, -1n])("rejects a non-positive answer (%s)", answer => {
    expect(() => assertUsablePrice({ ...ROUND, answer }, NOW)).toThrow(BadPriceError);
  });

  it("rejects a stale round and accepts one exactly at the limit", () => {
    expect(() => assertUsablePrice(ROUND, Number(ROUND.updatedAt) + 3600, 3600)).not.toThrow();
    expect(() => assertUsablePrice(ROUND, Number(ROUND.updatedAt) + 3601, 3600)).toThrow(StalePriceError);
  });

  it("rejects a round timestamped in the future", () => {
    expect(() => assertUsablePrice({ ...ROUND, updatedAt: BigInt(NOW + 3600) }, NOW)).toThrow(/future/);
  });

  it("values tinybar in USD (6 decimals)", () => {
    expect(tinybarToUsd6(100n * 100_000_000n, ROUND)).toBe(10_212_000n); // 100 HBAR = $10.212
  });

  it("rounds a USD budget up so it is never under-funded", () => {
    const tinybar = usd6ToTinybar(10_000_000n, ROUND); // $10
    expect(tinybarToUsd6(tinybar, ROUND)).toBeGreaterThanOrEqual(10_000_000n);
    expect(tinybarToUsd6(tinybar - 1n, ROUND)).toBeLessThan(10_000_000n);
  });

  it("never loses more than one unit in a USD → tinybar → USD round trip", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.bigInt({ min: 1_000n, max: 10n ** 10n }), (usd6, answer) => {
        const round = { ...ROUND, answer };
        const back = tinybarToUsd6(usd6ToTinybar(usd6, round), round);
        expect(back >= usd6).toBe(true);
      }),
    );
  });

  it("reads decimals and latestRoundData through an injected client", async () => {
    const client = {
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "decimals" ? 8 : [7n, 10_212_000n, 0n, 1_800_000_000n, 7n],
    };
    await expect(readPriceRound(client, "0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a")).resolves.toEqual(ROUND);
  });
});

describe("spend routing", () => {
  const policy: SpendPolicy = {
    opsBudgetRemainingUsd6: 500_000_000n, // $500
    timelockSec: 3600,
    longTimelockThresholdUsd6: 10_000_000_000n, // $10k
    longTimelockSec: 86_400,
  };

  it("sends a USDC spend within the budget to the ops account", () => {
    expect(routeSpend(500_000_000n, policy, true).kind).toBe("ops-budget");
  });

  it("sends a USDC spend over the remaining budget to the quorum", () => {
    expect(routeSpend(500_000_001n, policy, true)).toMatchObject({ kind: "quorum", timelockSec: 3600 });
  });

  it("always sends non-USDC spends to the quorum, even small ones", () => {
    expect(routeSpend(1n, policy, false)).toMatchObject({ kind: "quorum" });
  });

  it("gives large spends the long timelock (boundary is exclusive)", () => {
    expect(routeSpend(10_000_000_000n, policy, false)).toMatchObject({ timelockSec: 3600 });
    expect(routeSpend(10_000_000_001n, policy, false)).toMatchObject({ timelockSec: 86_400 });
  });

  it("rejects zero/negative spends and inconsistent policies", () => {
    expect(() => routeSpend(0n, policy, true)).toThrow();
    expect(() => routeSpend(1n, { ...policy, longTimelockSec: 10 }, true)).toThrow(/Long timelock/);
  });

  it("builds a default policy from the remaining budget", () => {
    expect(defaultPolicy(5n).opsBudgetRemainingUsd6).toBe(5n);
  });
});
