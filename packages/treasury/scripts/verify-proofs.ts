/**
 * Re-check every claim in docs/proofs.json against the public mirror node. Needs no keys or env vars.
 *   yarn verify:proofs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TESTNET } from "../src";
import { REPO_ROOT } from "./lib/env";
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
  if (process.argv.includes("--write-md")) writeMarkdown(proofs);
  if (failed > 0) process.exit(1);
}

/** Render docs/TESTNET_PROOF.md from docs/proofs.json so the two can never disagree. */
function writeMarkdown(proofs: ReturnType<typeof readProofs>) {
  const rows = proofs.map(
    (p, i) =>
      `| ${i + 1} | ${p.claim} | [HashScan](${p.hashscan}) | \`curl -s ${TESTNET.mirrorUrl}${p.mirrorPath}\` | ${p.signedBy ?? "—"} | ${p.test ? `\`${p.test}\`` : "—"} |`,
  );
  const md = `# Proof it runs on Hedera testnet

Generated from [\`proofs.json\`](proofs.json) by \`yarn verify:proofs -- --write-md\`. Every row is re-checked against the
public mirror node in CI; you can run any \`curl\` yourself without trusting this repository.

| # | Claim | Explorer | Check it yourself | Signed by | Mirrors test |
|---|---|---|---|---|---|
${rows.join("\n")}

**About "Signed by":** a signature from HashPack and one from a script key are indistinguishable on the ledger. The column
is the author's declaration; the threshold, the timelock, the veto and the allowance cap are what the ledger proves.

**About the swap proofs:** the only SaucerSwap V1 WHBAR/USDC pool on testnet is priced ~22× away from Chainlink, so SwapGuard
refuses it (row 1). The executed swap uses a WHBAR/tUSD pool the demo seeds at the Chainlink price; tUSD is a testnet-only
stand-in for USDC.
`;
  writeFileSync(resolve(REPO_ROOT, "docs/TESTNET_PROOF.md"), md);
  console.log("Wrote docs/TESTNET_PROOF.md");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
