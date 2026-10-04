# Architecture

Three packages, one rule: **the ledger enforces, the template decides and explains.**

```
packages/foundry    SwapGuard.sol           on-chain: oracle + pool checks for treasury swaps
packages/treasury   @sh/treasury            pure TypeScript shared by scripts and UI
packages/nextjs     dashboard               reads the mirror node, signs with HashPack
```

## Accounts and keys

| Entity | Key | Why |
|---|---|---|
| Treasury account | `KeyList(threshold 2)` of the three signer public keys | Nothing leaves without 2 signatures. Mixed ED25519/ECDSA is fine. `maxAutoAssociations = -1` because `TokenAssociate` cannot be scheduled. |
| Ops account | `KeyList(threshold 1)` of the same keys | Any one signer pays small bills — but it holds no money of its own: it spends the treasury's USDC through an allowance the quorum approved. |
| Schedule admin key (on every proposal) | `KeyList(threshold 1)` | Minority veto: any one signer can `ScheduleDelete` before execution. |
| HCS index topic | submit key `KeyList(threshold 1)`, no admin key | Only signers can announce proposals; nobody can delete the topic. |

## A proposal, end to end

1. **Value it** (`pricing.ts`, `policy.ts`): read Chainlink HBAR/USD (`latestRoundData`, staleness ≤ 6 h), convert the amount to USD (6 decimals), route it: inside the ops budget → no proposal needed; above the long-timelock threshold → 7-day window; otherwise the normal window. This step is advisory: `treasury:propose` prints the route, the ledger does not enforce it.
2. **Build it** (`proposals.ts`): a `ScheduleCreateTransaction` with `payerAccountId = treasury`, `waitForExpiry = true`, `expirationTime = now + window` (≤ 62 days, HIP-423), `adminKey = veto key`, memo ≤ 100 bytes. Inner transaction: `TransferTransaction` (HBAR or USDC), `AccountAllowanceApproveTransaction` (budget), `ContractExecuteTransaction` → SwapGuard, or `AccountUpdateTransaction` (rotate signers).
3. **Propose** (`scripts/lib/actions.ts` or the `/new` page): the proposer signs the ScheduleCreate — that signature already counts, so the proposal starts at 1 of 2 — and posts a `quorum-treasury/v1` JSON entry to the HCS index.
4. **Approve**: each other signer submits their own `ScheduleSign` (HashPack via `executeWithSigner`, or `yarn treasury:sign`). Signatures are never collected and combined client-side.
5. **Wait**: with the threshold met the schedule sits until `expirationTime`; the UI shows "veto window open" and a countdown. Any signer can veto.
6. **Execute**: at expiry the network runs the inner transaction as the treasury. If it fails (e.g. SwapGuard reverts), the schedule is still marked executed and the failure is on the child transaction (`/transactions?timestamp=<executed_timestamp>`); the UI shows "executed · inner tx failed" with the code.

## Reading state (`mirror.ts`, `status.ts`, `hcs-index.ts`)

- `/api/v1/schedules/{id}` gives signatures (public-key prefixes, base64), `executed_timestamp`, `deleted`, `wait_for_expiry`, `expiration_time` and the base64 `SchedulableTransactionBody`.
- The treasury key comes from `/api/v1/accounts/{id}` as `ProtobufEncoded`; `keys.ts` decodes the protobuf (no SDK needed) and counts which top-level members signed. Signatures are checked against the **current** key, so a rotation invalidates old signers on pending proposals — exactly what the network does.
- `/schedules` can only be filtered by creator, so the list of proposals comes from the HCS index, and each entry is reconciled with the ledger (`missing-on-ledger`, `wrong-payer`, `duplicate-announcement` are flagged, not hidden).
- Retries: 429/5xx and transient Hedera codes (`BUSY`, `SCHEDULE_EXPIRY_IS_BUSY`, `PLATFORM_TRANSACTION_NOT_CREATED`) back off with full jitter; 4xx and permanent codes surface immediately with a human explanation (`errors.ts`).

## SwapGuard (`packages/foundry/contracts/SwapGuard.sol`)

```
swapHbarForStable(slippageBps, deadline) payable
  require msg.value > 0, deadline not passed, 30 ≤ slippageBps ≤ 1000
  (round, price) = Chainlink.latestRoundData()       // price > 0, updatedAt within maxPriceAge, not in the future
  oracleOut = msg.value(tinybar) × price × 10^stableDec / 10^(8 + feedDec)
  poolQuote = router.getAmountsOut(msg.value, [WHBAR, stable])[1]
  require |poolQuote − oracleOut| ≤ bandBps × oracleOut          // symmetric: too good is as suspicious as too bad
  router.swapExactETHForTokens{value}(oracleOut × (1 − slippage), path, to = msg.sender, deadline)
```

No state, no owner, no custody: output goes straight to `msg.sender` (the treasury when called by a schedule) and an invariant test drives 128k random calls to show the contract never ends a transaction holding HBAR. Units: inside the Hedera EVM `msg.value` is tinybar (8 decimals); only the JSON-RPC relay uses weibar.

## Why the UI is "read-only first"

Every route is a server component marked `dynamic`, reading the mirror node at request time and turning failures into a visible message instead of a 500. Without `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` nothing tries to load a wallet. That keeps the gate's "routes answer 200 with no env vars" true by construction.
