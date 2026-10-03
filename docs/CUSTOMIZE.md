# Make it yours

## Change M-of-N

`packages/treasury/scripts/lib/signers.ts`:

```ts
export const quorumKey = (signers: Signer[], threshold = 2) => new KeyList(signers.map(s => s.publicKey), threshold);
```

Add signers to `loadOrCreateSigners` (e.g. `SIGNER4_KEY`) and pass a different threshold. For an existing treasury, use a **rotation proposal** (`rotateSignersProposal`) instead of recreating it: the network requires the current threshold *and* the new key to sign. The UI's progress bar reads the threshold from the mirror node, so it adapts automatically.

## Add a proposal type (4 files)

Example: "pay an NFT" or "submit an HCS message from the treasury".

1. `src/proposals.ts` — a builder returning `schedule(innerTx, common)`. Validate amounts and ids there; the shared `validateCommon` already checks memo size and the 62-day limit.
2. `src/decode.ts` — add a branch in `decodeSchedulableBody` for the new body field and a line in `describeProposal`. Anything you do not decode is shown as "do not sign unless you know what it is".
3. `src/hcs-index.ts` — add the type to `ProposalType` / `TYPES`.
4. Tests — add a round-trip case to `test/proposals-decode.test.ts` (build → `_getScheduledTransactionBody` → decode). Then wire it into `scripts/propose.ts` and, if you want it in the browser, `components/treasury/NewProposalForm.tsx`.

Remember: only transactions on the network's schedulable list work (`ContractCall`, `CryptoTransfer`, `CryptoApproveAllowance`, `ConsensusSubmitMessage`, `CryptoUpdate`, token mint/burn/update…). `TokenAssociate` is **not** schedulable — that is why the treasury uses unlimited auto-association.

## Change the routing policy

`src/policy.ts` → `routeSpend(usd6, policy, isUsdcPayment)`. Thresholds are in USD with 6 decimals. Defaults (48 h window, 7 days above $10k) live in `src/config.ts` (`DEFAULT_POLICY`). Keep in mind this is template logic, not a ledger rule.

## Use a different oracle, pool or stablecoin

`SwapGuard` takes everything in the constructor (router, AggregatorV3 feed, WHBAR token, stable token and its decimals, max price age, band). Deploy with env overrides:

```bash
SAUCERSWAP_V1_ROUTER=0x... CHAINLINK_HBAR_USD=0x... STABLE_TOKEN=0x... BAND_BPS=200 yarn foundry:deploy --network hedera_testnet
```

Supra or Pyth feeds work if you wrap them in the `IAggregatorV3` interface. Run `FORK=1 forge test --match-contract SwapGuardForkTest --fork-url https://testnet.hashio.io/api` to see how a pool compares with the oracle before you deploy.

## Mainnet

1. `src/config.ts`: add a `MAINNET` block (mirror `https://mainnet.mirrornode.hedera.com`, Hashio mainnet, the mainnet Chainlink HBAR/USD proxy, SaucerSwap mainnet router and USDC `0.0.456858`).
2. `scripts/lib/network.ts` refuses anything but testnet on purpose; change it deliberately.
3. Use real wallets for every signer (no script keys), a long default timelock, and get the contract reviewed.

## Ask a coding agent

`AGENTS.md` lists the invariants an agent must not break and the recipes above. A good prompt: *"Add a proposal type that schedules a TokenMint from the treasury, following docs/CUSTOMIZE.md, with a round-trip test."*
