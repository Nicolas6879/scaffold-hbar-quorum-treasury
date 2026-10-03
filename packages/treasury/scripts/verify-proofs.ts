/**
 * Re-check every claim in docs/proofs.json against the public mirror node. Needs no keys or env vars.
 *   yarn verify:proofs
 */
import { TESTNET } from "../src";
import { checkExpectations, readProofs } from "./lib/proofs";

async function main() {
  const proofs = readProofs();
  if (proofs.length === 0) throw new Error("docs/proofs.json is empty — run yarn treasury:demo first");
  let failed = 0;
  for (const proof of proofs) {
    const url = `${TESTNET.mirrorUrl}${proof.mirrorPath}`;
    let failures: string[];
    try {
      const res = await fetch(url);
      failures = res.ok ? checkExpectations(await res.json(), proof.expect) : [`HTTP ${res.status}`];
    } catch (error) {
      failures = [error instanceof Error ? error.message : String(error)];
    }
    if (failures.length === 0) console.log(`✓ ${proof.claim}\n    ${proof.hashscan}`);
    else {
      failed++;
      console.log(`✗ ${proof.claim}\n    ${url}\n    ${failures.join("\n    ")}`);
    }
  }
  console.log(`\n${proofs.length - failed}/${proofs.length} proofs verified against ${TESTNET.mirrorUrl}`);
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
