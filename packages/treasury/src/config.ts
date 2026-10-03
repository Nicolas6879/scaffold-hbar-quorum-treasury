/**
 * Network constants. Every address here was read from Hedera testnet on 2026-10-03
 * (see docs/TESTNET_PROOF.md for the mirror-node queries that confirm them).
 */
export const TESTNET = {
  name: "testnet",
  mirrorUrl: "https://testnet.mirrornode.hedera.com",
  jsonRpcUrl: "https://testnet.hashio.io/api",
  chainId: 296,
  hashscan: "https://hashscan.io/testnet",
  /** Chainlink HBAR/USD price feed proxy (AggregatorV3Interface, 8 decimals). */
  chainlinkHbarUsd: "0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a",
  saucerswap: {
    /** SaucerSwap V1 RouterV3 (0.0.19264). */
    routerId: "0.0.19264",
    routerEvm: "0x0000000000000000000000000000000000004b40",
    /** WHBAR *token* (0.0.15058). This is the address that goes in swap paths, not the WHBAR contract. */
    whbarTokenId: "0.0.15058",
    whbarTokenEvm: "0x0000000000000000000000000000000000003ad2",
  },
  /** USD Coin used by SaucerSwap testnet: 6 decimals, no custom fees. */
  usdc: { tokenId: "0.0.5449", decimals: 6 },
} as const;

export type NetworkConfig = typeof TESTNET;

export const LIMITS = {
  /** HIP-423: a schedule may expire at most 62 days after creation. */
  maxScheduleLifetimeSec: 5_356_800,
  /** Schedule memo hard limit enforced by the network. */
  maxMemoBytes: 100,
  /** Treat a Chainlink round older than this as stale (testnet updates every 3–272 min). */
  defaultMaxPriceAgeSec: 6 * 60 * 60,
  /** SaucerSwap V1 charges 0.3 %, so any slippage tolerance below this can never fill. */
  minSwapSlippageBps: 30,
} as const;

/** Defaults a team can override per treasury. */
export const DEFAULT_POLICY = {
  /** Timelock for ordinary quorum proposals. The demo uses minutes, real teams use hours. */
  timelockSec: 48 * 60 * 60,
  /** Proposals worth more than this get the long timelock. USD, 6 decimals. */
  longTimelockThresholdUsd6: 10_000_000_000n,
  longTimelockSec: 7 * 24 * 60 * 60,
} as const;
