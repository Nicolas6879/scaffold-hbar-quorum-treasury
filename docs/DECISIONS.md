# Design decisions

Each decision: what we chose, what we rejected, and what it costs. Costs are Hedera's published USD fees (docs.hedera.com/networks/fees) at the time of writing.

## 1. Threshold keys instead of a multisig contract

**Chose:** the treasury is an ordinary account whose key is a 2-of-3 `KeyList`.
**Rejected:** a Safe-style Solidity wallet.
**Why:** the network already verifies M-of-N signatures for every transaction type — HBAR, HTS tokens, allowances, contract calls, key updates — with no contract to audit or upgrade, and ED25519 and ECDSA keys can sit in the same list. A contract wallet would only see what passes through it and would need its own HTS association, allowance and gas handling.
**Cost:** a transfer from the treasury is a normal transfer fee; the scheduling overhead is below.
**When not to:** if you need programmable conditions on *every* outgoing payment (e.g. "never more than X per day, on-chain"), you need a contract or HIP-1195 hooks once they are live on mainnet.

## 2. Scheduled transactions as proposals (and how this differs from `payments-scheduler`)

**Chose:** HIP-423 long-term schedules (`ScheduleCreate` → `ScheduleSign` → execution at `expirationTime`).
**Rejected:** an off-chain signature-collection server; contract-driven scheduling (HIP-1215).
**Why:** a schedule is a public, on-ledger proposal with its signatures attached; anyone can verify it on HashScan. The official `payments-scheduler` template uses HIP-1215, where a **contract** schedules calls to itself for recurring payments; here **humans** approve one-off payments asynchronously. Different primitive, different job.
**Cost:** ScheduleCreate ≈ $0.01 (+$0.09 when the inner transaction is a contract call), ScheduleSign ≈ $0.001, ScheduleDelete ≈ $0.001.
**Gotcha:** with `waitForExpiry` the network executes lazily, on the first transaction after the expiration second. Signatures are evaluated against the account's key at that moment.

## 3. Always `waitForExpiry`, and a minority veto

**Chose:** every proposal waits for its expiration time; the schedule admin key is 1-of-3.
**Rejected:** executing as soon as 2 sign (no time to object); a 2-of-3 admin key (a quorum that can approve can also skip the veto, so it adds nothing).
**Why:** the threat a treasury quorum cannot stop is *two* signers colluding or two keys being stolen. A veto window during which any one signer can delete the proposal is the only cheap defence.
**Cost:** one signer can block payments (griefing). For a 3-person founding team that trade-off is usually right; change `anyOneKey` in `scripts/lib/signers.ts` if it is not for you.

## 4. The ops budget is a USDC allowance

**Chose:** the quorum approves an HTS allowance (HIP-336) of USDC from the treasury to an ops account controlled by any one signer.
**Rejected:** an HBAR cap (it is not a USD budget: its value moves with the price); keeping a separate funded hot wallet (money leaves the treasury before anyone spends it).
**Why:** the network enforces the cap (`AMOUNT_EXCEEDS_ALLOWANCE`), the money stays in the treasury until spent, and USDC is actually dollars.
**Costs and limits:** allowances do not reset — a new approval replaces the old amount; up to 100 allowances per owner. The spender must be the payer of the transfer.

## 5. SwapGuard: Chainlink on-chain, symmetric band, output to `msg.sender`

**Chose:** a stateless contract that refuses to swap if the SaucerSwap V1 quote is outside ±3 % of Chainlink HBAR/USD and derives `amountOutMin` from the oracle.
**Rejected:** a client-side price check (a schedule executes later, so prices must be checked at execution time, on-chain); a one-sided `minOut` check (the real testnet pool is ~22× *above* the oracle — a one-sided check would happily trade against a pool that is obviously broken); a `recipient` parameter (an extra way to send funds elsewhere).
**Assumptions:** the stablecoin is worth $1; the slippage floor is 30 bps because the pool fee is 0.3 %.
**Cost:** one contract call (≈ $0.09 scheduling surcharge + gas; a swap uses ~150k gas, the template allows 1.5M).

## 6. An HCS index of proposals

**Chose:** every proposal made through the template is announced on a topic only signers can write to.
**Rejected:** relying on the mirror node alone (it cannot list schedules by payer); a database (another server to trust).
**Why:** it adds the human intent the ledger does not have (title, invoice hash, USD value and Chainlink round at proposal time), costs ≈ $0.0001 per message, and the UI reconciles it with the ledger instead of trusting it.
**Limit:** schedules created outside the template are not indexed.

## 7. One operator account for setup

**Chose:** `treasury:setup` creates the signer keys, the accounts and the topic from one funded account and is idempotent.
**Rejected:** asking a developer for three funded accounts.
**Why:** the friction of "get three testnet accounts" stops people before they see anything work.

## Checklist: can you explain your own treasury?

1. Why does a proposal start at "1 of 2"? *(The proposer's signature on ScheduleCreate counts.)*
2. What happens if SwapGuard reverts when the timelock ends? *(The schedule is executed; the child transaction shows `CONTRACT_REVERT_EXECUTED`; nothing moved.)*
3. Can the ops account spend HBAR? *(Only its own small fee balance; the budget is USDC from the treasury.)*
4. What stops two signers from paying themselves? *(Nothing on-chain except the veto window — which is why it is mandatory.)*
5. You rotated signer 3. What happens to proposals signer 3 already signed? *(Those signatures stop counting at execution.)*
