/**
 * Produce the public testnet proofs listed in docs/TESTNET_PROOF.md, one step at a time.
 *   yarn treasury:demo -- --step <guards|reject|payment|veto|budget|pool|swap|rotate|all>
 * Every step records a claim + mirror query in docs/proofs.json; `yarn verify:proofs` re-checks them.
 * Signatures here come from script keys and are labelled as such; the HashPack-signed proof is made in the UI.
 */
import {
  AccountAllowanceApproveTransaction,
  AccountId,
  Client,
  ContractCreateFlow,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  HbarUnit,
  KeyList,
  PrivateKey,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TokenId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, encodeAbiParameters, encodeFunctionData, http, parseAbi } from "viem";
import {
  budgetProposal,
  fromLongZeroAddress,
  hbarPaymentProposal,
  readPriceRound,
  rotateSignersProposal,
  swapProposal,
  TESTNET,
  toLongZeroAddress,
  swapGuardAbi,
} from "../src";
import { announce, signProposal, submitProposal, vetoProposal } from "./lib/actions";
import { parseArgs } from "./lib/args";
import { REPO_ROOT } from "./lib/env";
import { hashscan, log, mirror, operatorClient, readDeployment, writeDeployment } from "./lib/network";
import { mirrorTxId, saveProof } from "./lib/proofs";
import { anyOneKey, loadOrCreateSigners, scriptSigners } from "./lib/signers";

const args = parseArgs();
const { client, operatorId, operatorKey } = operatorClient();
const signers = loadOrCreateSigners();
const local = scriptSigners(signers);
const evm = createPublicClient({ transport: http(TESTNET.jsonRpcUrl) });
const TIMELOCK = Number(args.timelock ?? 90);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} missing — run the earlier demo steps first`);
  return value;
}

function common(memo: string) {
  const d = readDeployment();
  return {
    treasuryId: need(d.treasuryId, "treasury"),
    vetoKey: anyOneKey(signers),
    executeAt: Math.floor(Date.now() / 1000) + TIMELOCK,
    memo: `${memo} #${Date.now() % 1e6}`,
  };
}

/** Propose with signer A, approve with signer B, announce on the index, wait for the timelock to end. */
async function proposeAndApprove(schedule: Parameters<typeof submitProposal>[1], title: string, type: Parameters<typeof announce>[2]["type"], approve = true) {
  const d = readDeployment();
  const [a, b] = [local[0]!, local[1]!];
  const { scheduleId } = await submitProposal(client, schedule, a.privateKey);
  await announce(client, need(d.indexTopicId, "index topic"), { scheduleId, type, title, signedVia: "script" }, a.privateKey);
  log(`Proposed ${scheduleId}`, hashscan("schedule", scheduleId));
  if (approve) {
    await signProposal(client, scheduleId, b.privateKey);
    log(`Second signature (signer ${b.index}); waiting for the ${TIMELOCK}s timelock`);
  }
  return scheduleId;
}

async function waitExecuted(scheduleId: string) {
  const s = await mirror.waitFor(
    () => mirror.getSchedule(scheduleId),
    x => Boolean(x.executed_timestamp),
    { attempts: 60, intervalMs: 5000 },
  );
  const inner = await mirror.getScheduledTransaction(s.executed_timestamp!);
  log(`Executed at ${s.executed_timestamp}: ${inner?.result}`);
  return { schedule: s, inner };
}

function bytecode(name: string): string {
  const artifact = JSON.parse(readFileSync(resolve(REPO_ROOT, `packages/foundry/out/${name}.sol/${name}.json`), "utf8"));
  return artifact.bytecode.object as string;
}

async function deployGuard(stableEvm: `0x${string}`, label: string) {
  const params = encodeAbiParameters(
    parseAbi(["constructor(address,address,address,address,uint8,uint256,uint16)"])[0]!.inputs,
    [TESTNET.saucerswap.routerEvm, TESTNET.chainlinkHbarUsd, TESTNET.saucerswap.whbarTokenEvm, stableEvm, 6, 6n * 3600n, 300],
  );
  const response = await new ContractCreateFlow()
    .setBytecode(bytecode("SwapGuard"))
    .setConstructorParameters(Buffer.from(params.slice(2), "hex"))
    .setGas(1_500_000)
    .execute(client);
  const receipt = await response.getReceipt(client);
  const id = receipt.contractId!.toString();
  log(`SwapGuard (${label}) deployed`, hashscan("contract", id));
  return { id, evm: toLongZeroAddress(id) };
}

const steps: Record<string, () => Promise<void>> = {
  async guards() {
    const d = readDeployment();
    if (!d.swapGuardUsdcId) {
      const g = await deployGuard(toLongZeroAddress(TESTNET.usdc.tokenId), "USDC 0.0.5449");
      writeDeployment({ swapGuardUsdcId: g.id, swapGuardUsdcEvm: g.evm });
    }
  },

  /** Proof 1: the guard refuses the real, mispriced public WHBAR/USDC pool — directly and through a proposal. */
  async reject() {
    const d = readDeployment();
    const guard = need(d.swapGuardUsdcId, "USDC guard");
    const data = encodeFunctionData({ abi: swapGuardAbi, functionName: "swapHbarForStable", args: [100, BigInt(Math.floor(Date.now() / 1000) + 3600)] });
    const direct = new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(guard))
      .setGas(800_000)
      .setPayableAmount(new Hbar(1))
      .setFunctionParameters(Buffer.from(data.slice(2), "hex"));
    const response = await direct.execute(client);
    const txId = response.transactionId.toString();
    try {
      await response.getReceipt(client);
      throw new Error("Expected the guard to revert against the public pool");
    } catch (error) {
      if (!String(error).includes("CONTRACT_REVERT_EXECUTED")) throw error;
    }
    log("Direct call reverted (pool out of band)", hashscan("transaction", txId));
    saveProof({
      id: "guard-rejects-public-pool",
      claim: "SwapGuard refuses the public SaucerSwap WHBAR/USDC pool because it is ~22x away from Chainlink HBAR/USD",
      hashscan: hashscan("transaction", txId),
      mirrorPath: `/api/v1/contracts/results/${mirrorTxId(txId)}`,
      expect: { result: "CONTRACT_REVERT_EXECUTED" },
      signedBy: "operator (direct call)",
      test: "SwapGuardTest.test_RejectsPoolFarAboveOracle",
    });
  },

  /** Proofs 2–3: threshold-key treasury; payment proposed, co-signed, executed when the timelock ended. */
  async payment() {
    const d = readDeployment();
    saveProof({
      id: "treasury-threshold-key",
      claim: "The treasury account is controlled by a 2-of-3 threshold key (no multisig contract)",
      hashscan: hashscan("account", need(d.treasuryId, "treasury")),
      mirrorPath: `/api/v1/accounts/${d.treasuryId}`,
      expect: { "key._type": "ProtobufEncoded" },
    });
    const schedule = hbarPaymentProposal({ ...common("Pay 1 HBAR"), to: "0.0.98", tinybar: 100_000_000n });
    const id = await proposeAndApprove(schedule, "Pay 1 HBAR to 0.0.98", "hbar-payment");
    const { schedule: s, inner } = await waitExecuted(id);
    saveProof({
      id: "payment-executed-after-timelock",
      claim: "A 2-of-3 approved payment waited for its timelock (waitForExpiry) and then executed",
      hashscan: hashscan("schedule", id),
      mirrorPath: `/api/v1/schedules/${id}`,
      expect: { wait_for_expiry: true, deleted: false, "signatures.1.type": s.signatures[1]!.type },
      signedBy: `script signers ${local[0]!.index} and ${local[1]!.index}`,
      test: "status.test.ts › is timelocked once quorum is reached",
    });
    if (inner?.result !== "SUCCESS") throw new Error(`Payment inner result ${inner?.result}`);
  },

  /** Proof 4: minority veto during the timelock. */
  async veto() {
    const schedule = hbarPaymentProposal({ ...common("Suspicious payout"), to: "0.0.98", tinybar: 500_000_000n });
    const id = await proposeAndApprove(schedule, "Suspicious payout of 5 HBAR", "hbar-payment");
    await vetoProposal(client, id, local[2]?.privateKey ?? local[0]!.privateKey);
    const s = await mirror.waitFor(() => mirror.getSchedule(id), x => x.deleted, { attempts: 20, intervalMs: 3000 });
    log(`Vetoed ${id}`, String(s.deleted));
    saveProof({
      id: "minority-veto",
      claim: "One signer vetoed a fully-approved proposal during its timelock (ScheduleDelete with the 1-of-3 admin key)",
      hashscan: hashscan("schedule", id),
      mirrorPath: `/api/v1/schedules/${id}`,
      expect: { deleted: true, executed_timestamp: null },
      signedBy: "script signers",
      test: "status.test.ts › is vetoed when deleted",
    });
  },

  /** Proof 5: USDC budget for the ops account, spent within the allowance, and refused beyond it. */
  async budget() {
    const d = readDeployment();
    const treasury = need(d.treasuryId, "treasury");
    const ops = need(d.opsAccountId, "ops account");
    const usdc = TokenId.fromString(TESTNET.usdc.tokenId);
    const treasuryAccount = await mirror.getAccount(treasury);
    const usdcBalance = treasuryAccount.balance.tokens.find(t => t.token_id === TESTNET.usdc.tokenId)?.balance ?? 0;
    if (usdcBalance < 3_000_000) {
      throw new Error(
        `Treasury holds ${usdcBalance / 1e6} USDC; send it at least 3 USDC (0.0.5449) first, e.g. from a SaucerSwap testnet swap.`,
      );
    }
    const schedule = budgetProposal({ ...common("Ops budget 2 USDC"), opsAccountId: ops, tokenId: TESTNET.usdc.tokenId, amount: 2_000_000n });
    const id = await proposeAndApprove(schedule, "Monthly ops budget: 2 USDC", "budget");
    await waitExecuted(id);

    // The spender must pay for an approved transfer, so the ops account (1-of-3) is the payer.
    const opsClient = Client.forTestnet().setOperator(AccountId.fromString(ops), local[0]!.privateKey);
    const spend = async (amount: number) => {
      const response = await new TransferTransaction()
        .addApprovedTokenTransfer(usdc, AccountId.fromString(treasury), -amount)
        .addTokenTransfer(usdc, AccountId.fromString("0.0.98"), amount)
        .execute(opsClient);
      const txId = response.transactionId.toString();
      try {
        await response.getReceipt(opsClient);
        return { txId, ok: true };
      } catch (error) {
        if (String(error).includes("AMOUNT_EXCEEDS_ALLOWANCE")) return { txId, ok: false };
        throw error;
      }
    };
    const ok = await spend(1_500_000);
    log("Ops spent 1.5 USDC with one signature", hashscan("transaction", ok.txId));
    const refused = await spend(1_000_000);
    opsClient.close();
    if (!ok.ok || refused.ok) throw new Error("Allowance did not behave as expected");
    log("Ops tried 1 more USDC: refused by the network", hashscan("transaction", refused.txId));
    saveProof({
      id: "budget-spend",
      claim: "The ops account (any 1 signer) spent 1.5 USDC of its 2 USDC allowance from the treasury",
      hashscan: hashscan("transaction", ok.txId),
      mirrorPath: `/api/v1/transactions/${mirrorTxId(ok.txId)}`,
      expect: { "transactions.0.result": "SUCCESS" },
      signedBy: `script signer ${local[0]!.index}`,
    });
    saveProof({
      id: "budget-enforced",
      claim: "Spending beyond the remaining allowance is rejected by the network (AMOUNT_EXCEEDS_ALLOWANCE)",
      hashscan: hashscan("transaction", refused.txId),
      mirrorPath: `/api/v1/transactions/${mirrorTxId(refused.txId)}`,
      expect: { "transactions.0.result": "AMOUNT_EXCEEDS_ALLOWANCE" },
      test: "errors-mirror.test.ts › maps AMOUNT_EXCEEDS_ALLOWANCE",
    });
  },

  /** Testnet-only: a WHBAR/tUSD pool seeded at the Chainlink price, because the public USDC pool is ~22x off. */
  async pool() {
    let d = readDeployment();
    if (!d.demoStableTokenId) {
      const receipt = await (
        await new TokenCreateTransaction()
          .setTokenName("Quorum Treasury demo USD (testnet only)")
          .setTokenSymbol("tUSD")
          .setDecimals(6)
          .setInitialSupply(1_000_000_000_000)
          .setTreasuryAccountId(operatorId)
          .setAdminKey(operatorKey.publicKey)
          .execute(client)
      ).getReceipt(client);
      d = writeDeployment({ demoStableTokenId: receipt.tokenId!.toString() });
      log("tUSD created", hashscan("token", d.demoStableTokenId!));
    }
    const tusd = need(d.demoStableTokenId, "tUSD");
    const tusdEvm = toLongZeroAddress(tusd);
    const factory = "0x00000000000000000000000000000000000026e7" as const;
    const factoryAbi = parseAbi([
      "function getPair(address,address) view returns (address)",
      "function createPair(address,address) payable returns (address)",
      "function pairCreateFee() view returns (uint256)",
    ]);
    let pair = await evm.readContract({ address: factory, abi: factoryAbi, functionName: "getPair", args: [TESTNET.saucerswap.whbarTokenEvm, tusdEvm] });
    if (/^0x0+$/.test(pair)) {
      const feeTinycents = await evm.readContract({ address: factory, abi: factoryAbi, functionName: "pairCreateFee" });
      const rate = (await (await fetch(`${TESTNET.mirrorUrl}/api/v1/network/exchangerate`)).json()) as {
        current_rate: { cent_equivalent: number; hbar_equivalent: number };
        next_rate: { cent_equivalent: number; hbar_equivalent: number };
      };
      const toTinybar = (r: { cent_equivalent: number; hbar_equivalent: number }) =>
        (feeTinycents * BigInt(r.hbar_equivalent)) / BigInt(r.cent_equivalent);
      const fee = [toTinybar(rate.current_rate), toTinybar(rate.next_rate)].reduce((a, b) => (a > b ? a : b)) * 102n / 100n;
      const data = encodeFunctionData({ abi: factoryAbi, functionName: "createPair", args: [TESTNET.saucerswap.whbarTokenEvm, tusdEvm] });
      await (
        await new ContractExecuteTransaction()
          .setContractId(ContractId.fromString(fromLongZeroAddress(factory)))
          .setGas(8_000_000)
          .setPayableAmount(Hbar.from(fee.toString(), HbarUnit.Tinybar))
          .setFunctionParameters(Buffer.from(data.slice(2), "hex"))
          .execute(client)
      ).getReceipt(client);
      pair = await evm.readContract({ address: factory, abi: factoryAbi, functionName: "getPair", args: [TESTNET.saucerswap.whbarTokenEvm, tusdEvm] });
      log("WHBAR/tUSD pair created", pair);
    }
    writeDeployment({ demoPoolEvm: pair });

    // Seed at the Chainlink price: liquidity HBAR × price = tUSD.
    const round = await readPriceRound(evm as never, TESTNET.chainlinkHbarUsd);
    const hbar = BigInt(args.liquidity ?? 60);
    const tinybar = hbar * 100_000_000n;
    const tusdAmount = (tinybar * round.answer * 1_000_000n) / (100_000_000n * 10n ** BigInt(round.decimals));
    await (
      await new AccountAllowanceApproveTransaction()
        .approveTokenAllowance(TokenId.fromString(tusd), operatorId, AccountId.fromString(TESTNET.saucerswap.routerId), Number(tusdAmount))
        .execute(client)
    ).getReceipt(client);
    const routerAbi = parseAbi(["function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)"]);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const data = encodeFunctionData({
      abi: routerAbi,
      functionName: "addLiquidityETH",
      args: [tusdEvm, tusdAmount, (tusdAmount * 99n) / 100n, (tinybar * 99n) / 100n, toLongZeroAddress(operatorId.toString()), deadline],
    });
    const response = await new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(TESTNET.saucerswap.routerId))
      .setGas(2_000_000)
      .setPayableAmount(new Hbar(Number(hbar)))
      .setFunctionParameters(Buffer.from(data.slice(2), "hex"))
      .execute(client);
    await response.getReceipt(client);
    log(`Seeded ${hbar} HBAR + ${Number(tusdAmount) / 1e6} tUSD at $${Number(round.answer) / 10 ** round.decimals}/HBAR`, hashscan("transaction", response.transactionId.toString()));

    if (!readDeployment().swapGuardDemoId) {
      const g = await deployGuard(tusdEvm, "demo tUSD");
      writeDeployment({ swapGuardDemoId: g.id, swapGuardDemoEvm: g.evm });
    }
  },

  /** Proof 6: a treasury swap through the guard on an in-band pool, executed by the schedule. */
  async swap() {
    const d = readDeployment();
    const schedule = swapProposal({
      ...common("Swap 1 HBAR via SwapGuard"),
      swapGuardId: need(d.swapGuardDemoId, "demo guard"),
      tinybar: 100_000_000n,
      slippageBps: 150,
      deadline: Math.floor(Date.now() / 1000) + TIMELOCK + 3600,
    });
    const id = await proposeAndApprove(schedule, "Swap 1 HBAR for tUSD through SwapGuard", "swap");
    const { inner } = await waitExecuted(id);
    saveProof({
      id: "guarded-swap-executed",
      claim: "A 2-of-3 swap proposal executed through SwapGuard on a pool within 3% of Chainlink (testnet tUSD pool, seeded by the template)",
      hashscan: hashscan("schedule", id),
      mirrorPath: `/api/v1/schedules/${id}`,
      expect: { deleted: false, wait_for_expiry: true },
      signedBy: "script signers",
      test: "SwapGuardTest.test_SwapAtOraclePrice_SendsStableToCaller",
    });
    if (inner?.result !== "SUCCESS") throw new Error(`Swap inner result ${inner?.result}`);
    const guard = await mirror.getAccount(need(d.swapGuardDemoId, "demo guard"));
    log(`SwapGuard HBAR balance after swap: ${guard.balance.balance} (must be 0)`);
  },

  /** Proof 7: rotate signer 3 out for a new key (needs 2 old signatures + the new key). */
  async rotate() {
    const newSigner = PrivateKey.generateED25519();
    const keys = [signers[0]!.publicKey, signers[1]!.publicKey, newSigner.publicKey];
    const schedule = rotateSignersProposal({ ...common("Rotate signer 3"), newKey: new KeyList(keys, 2) });
    const id = await proposeAndApprove(schedule, "Replace signer 3", "rotate-signers");
    await signProposal(client, id, newSigner);
    const { inner } = await waitExecuted(id);
    log(`Rotation result ${inner?.result}. New signer 3 key stored as SIGNER3_KEY_ROTATED in .env.local`);
    saveProof({
      id: "signer-rotation",
      claim: "Signers were rotated by a scheduled AccountUpdate approved by 2 of the old signers and the new key",
      hashscan: hashscan("schedule", id),
      mirrorPath: `/api/v1/schedules/${id}`,
      expect: { deleted: false },
      signedBy: "script signers + new key",
    });
  },
};

async function main() {
  const order = ["guards", "reject", "payment", "veto", "budget", "pool", "swap"];
  const requested = args.step === "all" ? order : [args.step ?? "guards"];
  if (local.length < 2) throw new Error("The demo needs at least two signers with local keys.");
  for (const step of requested) {
    const run = steps[step];
    if (!run) throw new Error(`Unknown step ${step}`);
    console.log(`\n== ${step}`);
    await run();
    await sleep(1000);
  }
  client.close();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  client.close();
  process.exit(1);
});
