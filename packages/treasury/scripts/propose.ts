/**
 * Create a proposal from the command line (the UI does the same in the browser).
 *   yarn treasury:propose -- --type hbar  --to 0.0.98 --amount 1 [--title "..."] [--timelock 300]
 *   yarn treasury:propose -- --type usdc  --to 0.0.98 --amount 2.5
 *   yarn treasury:propose -- --type budget --amount 10          (USDC the ops account may spend)
 *   yarn treasury:propose -- --type swap  --amount 1 [--guard demo|usdc] [--slippage 100]
 * The proposer is signer 2 by default (`--as 3` to change). Signer 1 may live in HashPack.
 */
import { createPublicClient, http } from "viem";
import {
  budgetProposal,
  defaultPolicy,
  hbarPaymentProposal,
  hbarToTinybar,
  ProposalType,
  readPriceRound,
  routeSpend,
  swapProposal,
  TESTNET,
  tinybarToUsd6,
  tokenPaymentProposal,
  parseUnits,
  truncateUtf8,
} from "../src";
import { anyOneKey, loadOrCreateSigners, scriptSigners } from "./lib/signers";
import { announce, submitProposal } from "./lib/actions";
import { parseArgs } from "./lib/args";
import { hashscan, log, mirror, operatorClient, readDeployment } from "./lib/network";

async function main() {
  const args = parseArgs();
  const { client } = operatorClient();
  const d = readDeployment();
  if (!d.treasuryId || !d.indexTopicId) throw new Error("Run yarn treasury:setup first.");
  const signers = loadOrCreateSigners();
  const proposer = scriptSigners(signers).find(s => s.index === Number(args.as ?? 2));
  if (!proposer) throw new Error(`Signer ${args.as ?? 2} has no local key (it may be a HashPack signer).`);

  const now = Math.floor(Date.now() / 1000);
  const timelock = Number(args.timelock ?? 300);
  if (!Number.isInteger(timelock) || timelock < 1) throw new Error("--timelock must be a whole number of seconds");
  const common = {
    treasuryId: d.treasuryId,
    vetoKey: anyOneKey(signers),
    executeAt: now + timelock,
    memo: `${truncateUtf8(args.title ?? `${args.type} proposal`, 60)} #${now}`,
  };

  const evm = createPublicClient({ transport: http(TESTNET.jsonRpcUrl) });
  const round = await readPriceRound(evm as never, TESTNET.chainlinkHbarUsd);

  let schedule;
  let type: ProposalType;
  let usdValue6: bigint;
  switch (args.type) {
    case "hbar": {
      const tinybar = hbarToTinybar(args.amount ?? "1");
      schedule = hbarPaymentProposal({ ...common, to: args.to ?? "0.0.98", tinybar });
      type = "hbar-payment";
      usdValue6 = tinybarToUsd6(tinybar, round);
      break;
    }
    case "usdc": {
      const amount = parseUnits(args.amount ?? "1", TESTNET.usdc.decimals);
      schedule = tokenPaymentProposal({ ...common, to: args.to ?? "0.0.98", tokenId: TESTNET.usdc.tokenId, amount });
      type = "token-payment";
      usdValue6 = amount;
      break;
    }
    case "budget": {
      if (!d.opsAccountId) throw new Error("No ops account in deployments/testnet.json");
      const amount = parseUnits(args.amount ?? "10", TESTNET.usdc.decimals);
      schedule = budgetProposal({ ...common, opsAccountId: d.opsAccountId, tokenId: TESTNET.usdc.tokenId, amount });
      type = "budget";
      usdValue6 = amount;
      break;
    }
    case "swap": {
      const guard = args.guard === "usdc" ? d.swapGuardUsdcId : d.swapGuardDemoId;
      if (!guard) throw new Error("Deploy the guards first: yarn treasury:demo -- --step guards");
      const tinybar = hbarToTinybar(args.amount ?? "1");
      schedule = swapProposal({
        ...common,
        swapGuardId: guard,
        tinybar,
        slippageBps: Number(args.slippage ?? 100),
        deadline: common.executeAt + 24 * 3600,
      });
      type = "swap";
      usdValue6 = tinybarToUsd6(tinybar, round);
      break;
    }
    default:
      throw new Error("--type must be hbar, usdc, budget or swap");
  }

  if ((type === "hbar-payment" || type === "token-payment") && usdValue6 > 0n) {
    // Advisory only: the quorum can still approve anything, but say how the policy would route this spend.
    const allowance = d.opsAccountId
      ? await mirror.getTokenAllowance(d.treasuryId, d.opsAccountId, TESTNET.usdc.tokenId).catch(() => null)
      : null;
    const route = routeSpend(usdValue6, defaultPolicy(BigInt(allowance?.amount ?? 0)), type === "token-payment");
    log("Policy route", route.reason);
  }

  const { scheduleId } = await submitProposal(client, schedule, proposer.privateKey);
  await announce(
    client,
    d.indexTopicId,
    { scheduleId, type, title: args.title ?? common.memo, usdValue6: usdValue6.toString(), chainlinkRound: round.roundId.toString(), signedVia: "script" },
    proposer.privateKey,
  );
  log(`Proposal ${scheduleId} created by signer ${proposer.index} (1 of 2)`, hashscan("schedule", scheduleId));
  log(`Executes at ${new Date(common.executeAt * 1000).toISOString()} unless vetoed`);
  console.log(`\nSecond signature:  yarn treasury:sign -- --schedule ${scheduleId} --as 3   (or sign with HashPack in the UI)`);
  client.close();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
