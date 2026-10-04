# Proof it runs on Hedera testnet

Generated from [`proofs.json`](proofs.json) by `yarn verify:proofs -- --write-md`. Every row is re-checked against the
public mirror node in CI; you can run any `curl` yourself without trusting this repository.

| # | Claim | Explorer | Check it yourself | Signed by | Mirrors test |
|---|---|---|---|---|---|
| 1 | SwapGuard refuses the public SaucerSwap WHBAR/USDC pool: PoolPriceOutOfBand(oracle 0.1016 USDC, pool 2.2373 USDC for 1 HBAR) — ~22x away from Chainlink | [HashScan](https://hashscan.io/testnet/transaction/0.0.5525497@1791075440.982494874) | `curl -s https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0.0.5525497-1791075440-982494874` | operator (direct call) | `SwapGuardTest.test_RejectsPoolFarAboveOracle` |
| 2 | The treasury account is controlled by a 2-of-3 threshold key (no multisig contract) | [HashScan](https://hashscan.io/testnet/account/0.0.10849917) | `curl -s https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10849917` | — | — |
| 3 | A 2-of-3 approved payment waited for its timelock (waitForExpiry) and then executed | [HashScan](https://hashscan.io/testnet/schedule/0.0.10849942) | `curl -s https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10849942` | script signers 2 and 3 | `status.test.ts › is timelocked once quorum is reached` |
| 4 | One signer vetoed a fully-approved proposal during its timelock (ScheduleDelete with the 1-of-3 admin key) | [HashScan](https://hashscan.io/testnet/schedule/0.0.10849966) | `curl -s https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10849966` | script signers | `status.test.ts › is vetoed when deleted` |
| 5 | Signers were rotated by a scheduled AccountUpdate approved by 2 of the old signers and the new key | [HashScan](https://hashscan.io/testnet/schedule/0.0.10849985) | `curl -s https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10849985` | script signers + new key | — |
| 6 | Signer rotation co-signed from HashPack: the quorum key was replaced by a scheduled AccountUpdate after its timelock | [HashScan](https://hashscan.io/testnet/schedule/0.0.10859122) | `curl -s https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.5525497-1791129519-717167133?scheduled=true` | HashPack (signer 1) + script signer 2 + new key | `proposals-decode.test.ts › key rotation round trip` |
| 7 | The rotation's ScheduleSign was paid and submitted by the HashPack account 0.0.7615675 (signer 1) | [HashScan](https://hashscan.io/testnet/transaction/1791130494.104352104) | `curl -s https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7615675-1791130476-156452062` | HashPack | — |
| 8 | A payment approved by HashPack + one script signer executed only after its timelock | [HashScan](https://hashscan.io/testnet/schedule/0.0.10859128) | `curl -s https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.5525497-1791129534-959848766?scheduled=true` | HashPack (signer 1) + script signer 2 | — |
| 9 | The payment's ScheduleSign was paid and submitted by the HashPack account 0.0.7615675 (signer 1) | [HashScan](https://hashscan.io/testnet/transaction/1791130565.504593104) | `curl -s https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7615675-1791130554-386829261` | HashPack | — |
| 10 | The ops account (any 1 signer) spent 1.5 USDC of its 2 USDC allowance from the treasury | [HashScan](https://hashscan.io/testnet/transaction/0.0.10849918@1791133987.303785744) | `curl -s https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10849918-1791133987-303785744` | script signer 2 | — |
| 11 | Spending beyond the remaining allowance is rejected by the network (AMOUNT_EXCEEDS_ALLOWANCE) | [HashScan](https://hashscan.io/testnet/transaction/0.0.10849918@1791133984.830583839) | `curl -s https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10849918-1791133984-830583839` | — | `errors-mirror.test.ts › maps AMOUNT_EXCEEDS_ALLOWANCE` |
| 12 | A 2-of-3 swap proposal executed through SwapGuard on a pool within 3% of Chainlink (testnet tUSD pool, seeded by the template) | [HashScan](https://hashscan.io/testnet/schedule/0.0.10859924) | `curl -s https://testnet.mirrornode.hedera.com/api/v1/contracts/results?timestamp=1791134266.126739104` | script signers | `SwapGuardTest.test_SwapAtOraclePrice_SendsStableToCaller` |

**About "Signed by":** a signature from HashPack and one from a script key are indistinguishable on the ledger. The column
is the author's declaration; the threshold, the timelock, the veto and the allowance cap are what the ledger proves.

**About the swap proofs:** the only SaucerSwap V1 WHBAR/USDC pool on testnet is priced ~22× away from Chainlink, so SwapGuard
refuses it (row 1). The executed swap uses a WHBAR/tUSD pool the demo seeds at the Chainlink price; tUSD is a testnet-only
stand-in for USDC.
