/** ABI of packages/foundry/contracts/SwapGuard.sol (functions, events and errors the treasury uses). */
export const swapGuardAbi = [
  {
    type: "function",
    name: "swapHbarForStable",
    stateMutability: "payable",
    inputs: [
      { name: "slippageBps", type: "uint16" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "stableOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "preview",
    stateMutability: "view",
    inputs: [{ name: "tinybar", type: "uint256" }],
    outputs: [
      { name: "oracleOut", type: "uint256" },
      { name: "poolQuote", type: "uint256" },
      { name: "inBand", type: "bool" },
    ],
  },
  { type: "error", name: "ZeroValue", inputs: [] },
  {
    type: "error",
    name: "DeadlinePassed",
    inputs: [
      { name: "deadline", type: "uint256" },
      { name: "nowTs", type: "uint256" },
    ],
  },
  { type: "error", name: "BadPrice", inputs: [{ name: "answer", type: "int256" }] },
  {
    type: "error",
    name: "StalePrice",
    inputs: [
      { name: "updatedAt", type: "uint256" },
      { name: "nowTs", type: "uint256" },
    ],
  },
  { type: "error", name: "SlippageOutOfRange", inputs: [{ name: "slippageBps", type: "uint16" }] },
  {
    type: "error",
    name: "PoolPriceOutOfBand",
    inputs: [
      { name: "oracleOut", type: "uint256" },
      { name: "poolOut", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "GuardedSwap",
    inputs: [
      { name: "treasury", type: "address", indexed: true },
      { name: "hbarIn", type: "uint256", indexed: false },
      { name: "stableOut", type: "uint256", indexed: false },
      { name: "oracleOut", type: "uint256", indexed: false },
      { name: "poolQuote", type: "uint256", indexed: false },
      { name: "roundId", type: "uint80", indexed: false },
      { name: "price", type: "int256", indexed: false },
    ],
  },
] as const;
