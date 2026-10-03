/**
 *   yarn treasury:sign -- --schedule 0.0.123 --as 3
 * Decodes the proposal first so the signer sees exactly what they approve.
 */
import { decodeScheduleBody, describeProposal, explain } from "../src";
import { signProposal } from "./lib/actions";
import { parseArgs } from "./lib/args";
import { hashscan, log, mirror, operatorClient } from "./lib/network";
import { loadOrCreateSigners, scriptSigners } from "./lib/signers";

async function main() {
  const args = parseArgs();
  if (!args.schedule) throw new Error("--schedule 0.0.x is required");
  const { client } = operatorClient();
  const signer = scriptSigners(loadOrCreateSigners()).find(s => s.index === Number(args.as ?? 3));
  if (!signer) throw new Error(`Signer ${args.as ?? 3} has no local key; sign with HashPack in the UI.`);
  const schedule = await mirror.getSchedule(args.schedule);
  log("You are approving", describeProposal(decodeScheduleBody(schedule.transaction_body)));
  try {
    const txId = await signProposal(client, args.schedule, signer.privateKey);
    log(`Signed by signer ${signer.index}`, hashscan("transaction", txId));
  } catch (error) {
    console.error(explain(error));
    process.exitCode = 1;
  }
  client.close();
}

main().catch(error => {
  console.error(explain(error));
  process.exit(1);
});
