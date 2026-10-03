# Agent instructions

Briefing for coding agents (Cursor, Claude Code, Codex) working in a project scaffolded from **Quorum Treasury**. Read this before changing anything; the invariants below are what keeps the treasury safe.

Use the package manager the project was created with (`packageManager` in root `package.json` or the lockfile). Examples use `yarn`; with npm use `npm run <script>`.

## What this app is

A team treasury on Hedera made of ledger primitives, not a wallet contract:
- Treasury account with a 2-of-3 `KeyList`; proposals are `ScheduleCreate` transactions paid by the treasury with `waitForExpiry` (timelock) and a 1-of-3 admin key (veto).
- An ops account (any 1 signer) spends a USDC allowance approved by the quorum.
- `SwapGuard.sol` swaps HBAR → stablecoin on SaucerSwap V1 only within ±3 % of Chainlink HBAR/USD.
- Proposals are announced on an HCS topic (`quorum-treasury/v1` JSON) and reconciled with the ledger by the UI.

## Map

| Path | What lives there |
|---|---|
| `packages/treasury/src/` | Library shared by scripts and UI. `proposals.ts` builders · `decode.ts` schedule body → readable · `status.ts` lifecycle · `keys.ts` KeyList decoding + signature progress · `policy.ts` USD routing · `pricing.ts` Chainlink · `mirror.ts` mirror client · `hcs-index.ts` index format + reconciliation · `errors.ts` status codes + retry · `ids.ts`/`units.ts` conversions |
| `packages/treasury/scripts/` | CLI: `setup`, `propose`, `sign`, `veto`, `demo`, `verify-proofs`; helpers in `scripts/lib/` |
| `packages/treasury/test/` | Vitest (+ fast-check). Fixtures are built with the SDK, no network |
| `packages/foundry/contracts/SwapGuard.sol` | The only contract. Interfaces in `contracts/interfaces/` |
| `packages/foundry/test/` | Unit, fuzz, invariant and opt-in fork tests (`FORK=1`) |
| `packages/nextjs/app/` | Routes `/`, `/proposals`, `/proposals/[id]`, `/new`, `/budget`, `/audit`, `/debug` |
| `packages/nextjs/utils/treasury/server.ts` | Server-side data loading (never throws to the page) |
| `packages/nextjs/services/hedera/walletConnect.ts` | HashPack via WalletConnect (lazy, optional) |
| `deployments/testnet.json` | Public ids of the demo treasury. No secrets |
| `docs/proofs.json` | Testnet claims + mirror queries checked by `yarn verify:proofs` |

## Commands

```bash
yarn test                 # treasury vitest + forge tests
yarn treasury:test        # library only
yarn foundry:test         # contracts only
yarn lint                 # next lint + forge fmt --check + treasury types
yarn next:check-types
yarn next:build
yarn next:dev             # http://localhost:3000
yarn treasury:setup       # needs OPERATOR_ID / OPERATOR_KEY in .env.local
yarn treasury:propose -- --type hbar --to 0.0.98 --amount 1
yarn treasury:sign -- --schedule 0.0.x --as 3
yarn treasury:veto -- --schedule 0.0.x --as 1
yarn verify:proofs        # no keys needed
```

Foundry must be **v1.7.1** (`foundryup -i v1.7.1`); forge ≥ 1.8 breaks deploys through the Hashio relay.

## Invariants — do not break these

1. Every proposal goes through `schedule()` in `proposals.ts`: payer = treasury, `waitForExpiry = true`, admin key = veto key, expiration ≤ 62 days, memo ≤ 100 bytes. Do not add a path that executes without the timelock.
2. Signers each submit their own `ScheduleSign`. Never collect signature bytes from wallets and combine them (hedera-wallet-connect #694 rebuilds transaction bodies, so combined signatures break).
3. Anything `decodeSchedulableBody` cannot recognise must be shown as unknown/unsafe, never summarised optimistically.
4. `SwapGuard` sends output only to `msg.sender`, keeps no balance, and checks Chainlink at execution time. Do not add a recipient parameter, owner, or storage.
5. `assertUsablePrice` (TS) and `_freshPrice` (Solidity) must agree: positive answer, not stale, not from the future.
6. Pages must render with no env vars and must not fetch at build time (keep `export const dynamic = "force-dynamic"`, catch mirror errors).
7. Never write private keys anywhere but `.env.local` (gitignored). `deployments/*.json` and `docs/proofs.json` contain public data only.
8. Docs must not claim more than the code does. If a check lives off-chain (routing policy), say so.

## Hedera specifics agents get wrong

- **Units:** HBAR in tinybar (8 dp). Inside the EVM `msg.value` is tinybar; only the JSON-RPC relay uses weibar (18 dp). USD/USDC use 6 dp. Amounts are `bigint`.
- **Ids:** `0.0.x` ↔ long-zero EVM address via `ids.ts`. ECDSA accounts may also have an EVM alias that is *not* long-zero; resolve it through the mirror node.
- **Schedulable transactions:** `TokenAssociate` is not schedulable (hence auto-association). `ContractCall`, `CryptoTransfer`, `CryptoApproveAllowance`, `ConsensusSubmitMessage`, `CryptoUpdate` are.
- **Execution is lazy** after `expirationTime`; the mirror node lags a few seconds. Use `MirrorClient.waitFor`, do not assume immediacy.
- **A failed inner transaction still marks the schedule executed.** Read the child transaction's `result`.
- **Mirror `/schedules` filters only by creator.** List proposals from the HCS index.
- **SaucerSwap V1:** the swap path uses the WHBAR *token* (0.0.15058), not the WHBAR contract. One pool per pair.

## Recipes

- **New proposal type:** see `docs/CUSTOMIZE.md` → "Add a proposal type" (builder, decoder branch, index type, round-trip test).
- **Change M-of-N:** `quorumKey(signers, threshold)` in `scripts/lib/signers.ts`; existing treasuries rotate via `rotateSignersProposal`.
- **New page:** server component under `packages/nextjs/app/`, data from `utils/treasury/server.ts`, `dynamic = "force-dynamic"`.
- **Contract change:** update `SwapGuard.sol`, its ABI in `packages/treasury/src/swap-guard-abi.ts`, and tests in `packages/foundry/test/`; run `yarn foundry:lint`.

## Definition of done

`yarn lint`, `yarn test` and `yarn next:build` pass; new behaviour has a test; README/docs updated if user-visible; no secrets staged (`git diff --cached | grep -i key`).
