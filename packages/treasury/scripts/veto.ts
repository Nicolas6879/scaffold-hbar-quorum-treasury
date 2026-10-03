/**
 *   yarn treasury:veto -- --schedule 0.0.123 [--as 1]
 * Any single signer can delete a proposal before its timelock ends (minority veto).
 */
import { explain } from "../src";
import { vetoProposal } from "./lib/actions";
import { parseArgs } from "./lib/args";
import { hashscan, log, operatorClient } from "./lib/network";
import { loadOrCreateSigners, scriptSigners } from "./lib/signers";

async function main() {
  const args = parseArgs();
  if (!args.schedule) throw new Error("--schedule 0.0.x is required");
  const { client } = operatorClient();
  const signer = scriptSigners(loadOrCreateSigners()).find(s => s.index === Number(args.as ?? 3));
  if (!signer) throw new Error(`Signer ${args.as ?? 3} has no local key.`);
  const txId = await vetoProposal(client, args.schedule, signer.privateKey);
  log(`Vetoed by signer ${signer.index}`, hashscan("transaction", txId));
  client.close();
}

main().catch(error => {
  console.error(explain(error));
  process.exit(1);
});
