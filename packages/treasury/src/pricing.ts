import { LIMITS } from "./config";

/** One Chainlink round, as returned by `latestRoundData()` plus the feed's `decimals()`. */
export interface PriceRound {
  roundId: bigint;
  /** Price of 1 HBAR in USD, scaled by 10^decimals. */
  answer: bigint;
  /** Unix seconds. */
  updatedAt: bigint;
  decimals: number;
}

export class BadPriceError extends Error {
  constructor(answer: bigint) {
    super(`Chainlink returned a non-positive price (${answer}); refusing to value the proposal`);
    this.name = "BadPriceError";
  }
}

export class StalePriceError extends Error {
  constructor(
    readonly ageSec: bigint,
    readonly maxAgeSec: number,
  ) {
    super(`Chainlink price is ${ageSec}s old (limit ${maxAgeSec}s); try again after the next update`);
    this.name = "StalePriceError";
  }
}

/** Throws unless the round is usable at `nowSec`. Mirrors the checks SwapGuard.sol does on-chain. */
export function assertUsablePrice(round: PriceRound, nowSec: number, maxAgeSec: number = LIMITS.defaultMaxPriceAgeSec) {
  if (round.answer <= 0n) throw new BadPriceError(round.answer);
  const age = BigInt(nowSec) - round.updatedAt;
  if (age > BigInt(maxAgeSec)) throw new StalePriceError(age, maxAgeSec);
  if (round.updatedAt > BigInt(nowSec) + 60n) {
    throw new Error(`Chainlink round is timestamped in the future (${round.updatedAt} > ${nowSec})`);
  }
}

/** USD value (6 decimals) of a tinybar amount, rounded down. */
export function tinybarToUsd6(tinybar: bigint, round: PriceRound): bigint {
  if (round.answer <= 0n) throw new BadPriceError(round.answer);
  // usd6 = tinybar / 1e8 * answer / 10^dec * 1e6 = tinybar * answer / (10^dec * 100)
  return (tinybar * round.answer) / (10n ** BigInt(round.decimals) * 100n);
}

/** Tinybar needed to cover `usd6`, rounded UP so a USD budget is never under-funded. */
export function usd6ToTinybar(usd6: bigint, round: PriceRound): bigint {
  if (round.answer <= 0n) throw new BadPriceError(round.answer);
  const numerator = usd6 * 10n ** BigInt(round.decimals) * 100n;
  return (numerator + round.answer - 1n) / round.answer;
}

/** Minimal AggregatorV3 ABI for viem. */
export const aggregatorV3Abi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** The subset of a viem PublicClient we need, so tests can pass a fake. */
export interface ContractReader {
  readContract(args: { address: `0x${string}`; abi: typeof aggregatorV3Abi; functionName: string }): Promise<unknown>;
}

export async function readPriceRound(client: ContractReader, feed: `0x${string}`): Promise<PriceRound> {
  const [decimals, data] = await Promise.all([
    client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "decimals" }),
    client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" }),
  ]);
  const [roundId, answer, , updatedAt] = data as readonly [bigint, bigint, bigint, bigint, bigint];
  return { roundId, answer, updatedAt, decimals: Number(decimals) };
}
