/**
 * Paced presenter demo for a screen recording: the script does the on-chain work and opens the right
 * pages, the presenter only narrates.   yarn next:dev   (in another terminal)   yarn treasury:video
 *   --pace <s>       seconds to pause after each step (default 8)
 *   --manual         wait for Enter instead of pausing
 *   --timelock <s>   timelock of the live proposal (default 75; 180 with --manual; 240 with --hashpack)
 *   --hashpack       second signature comes from signer 1 in the browser (falls back to signer 3 after 3 min)
 *   --no-veto        skip the veto demo
 *   --no-open        print URLs instead of opening the browser
 * Uses the live testnet treasury in deployments/testnet.json. Video runs are NOT proofs: docs/proofs.json is never written.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createPublicClient, decodeErrorResult, encodeFunctionData, http } from "viem";
import { explain, hbarPaymentProposal, swapGuardAbi, TESTNET, toLongZeroAddress, withRetry } from "../src";
import { announce, signProposal, submitProposal, vetoProposal } from "./lib/actions";
import { parseArgs } from "./lib/args";
import { hashscan, log, mirror, operatorClient, readDeployment } from "./lib/network";
import { anyOneKey, loadOrCreateSigners, scriptSigners } from "./lib/signers";

const args = parseArgs();
const PACE = Number(args.pace ?? 8);
const MANUAL = args.manual === "true";
const OPEN = args["no-open"] !== "true";
const HASHPACK = args.hashpack === "true";
const VETO = args["no-veto"] !== "true" && args.veto !== "false";
const TIMELOCK = Number(args.timelock ?? (HASHPACK ? 240 : MANUAL ? 180 : 75));
const DASHBOARD = "http://localhost:3000";
const TOTAL_STEPS = 6;
const started = Date.now();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let client: ReturnType<typeof operatorClient>["client"] | undefined;
const rl = MANUAL ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;

function finish(code: number): never {
  rl?.close();
  try {
    client?.close();
  } catch {
    /* already closed */
  }
  process.exit(code);
}
process.on("SIGINT", () => {
  console.log("\nInterrupted. Bye.");
  finish(130);
});

function banner(n: number, title: string, explanation: string) {
  const line = `━━ ${n}/${TOTAL_STEPS} · ${title} ━━`;
  console.log(`\n\n${line}\n${explanation}\n`);
}

/** Open a URL in the presenter's browser; never throws, always prints the URL. */
function openUrl(url: string) {
  console.log(`  → ${url}`);
  if (!OPEN || !/^https?:\/\/[^\s"'`$]+$/.test(url)) return;
  let wsl = false;
  try {
    wsl = /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    /* not Linux */
  }
  const cmd = wsl
    ? `(command -v wslview >/dev/null 2>&1 && wslview "${url}") || cmd.exe /c start "" "${url.replace(/&/g, "^&")}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  try {
    const child = spawn("sh", ["-c", cmd], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* printing the URL is enough */
  }
}

/** Pause for --pace seconds, or until Enter with --manual. */
async function pause() {
  if (MANUAL) {
    await new Promise<void>(resolve => rl!.question("  [Enter to continue] ", () => resolve()));
  } else {
    console.log(`  (pausing ${PACE}s)`);
    await sleep(PACE * 1000);
  }
}

/** Run a network step; on failure print a clear message and stop (or fall back when `fallback` is given). */
async function guarded<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error(`\n✗ ${what} failed: ${explain(error)}`);
    return finish(1);
  }
}

/** Pull the revert data out of whatever shape viem / the relay wrapped it in. */
function revertData(error: unknown): `0x${string}` | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length) {
    const e = queue.shift() as { data?: unknown; cause?: unknown; details?: unknown; message?: unknown } | null;
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    if (typeof e.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(e.data)) return e.data as `0x${string}`;
    if (e.data && typeof e.data === "object") queue.push(e.data);
    queue.push(e.cause);
  }
  // Fallback: the relay sometimes only embeds the revert data in the error text (skip the request calldata).
  const text = error instanceof Error ? `${error.message}` : "";
  const m = /(?:data|reason)[^0x]{0,20}(0x[0-9a-fA-F]{8,})/.exec(text);
  return m ? (m[1] as `0x${string}`) : null;
}

const usdc = (n: bigint) => (Number(n) / 1e6).toFixed(4);

/** Live read-only call: the treasury asks the guard for a swap against the public (mispriced) pool. */
async function liveGuardRefusal(guardEvm: `0x${string}`, treasuryEvm: `0x${string}`): Promise<string | null> {
  const evm = createPublicClient({ transport: http(TESTNET.jsonRpcUrl) });
  const data = encodeFunctionData({
    abi: swapGuardAbi,
    functionName: "swapHbarForStable",
    args: [100, BigInt(Math.floor(Date.now() / 1000) + 600)],
  });
  try {
    // The relay takes value in weibar (18 dp): 1 HBAR = 1e18.
    await evm.call({ account: treasuryEvm, to: guardEvm, data, value: 10n ** 18n });
    return null; // did not revert: unexpected
  } catch (error) {
    const raw = revertData(error);
    if (!raw) return null;
    try {
      const decoded = decodeErrorResult({ abi: swapGuardAbi, data: raw });
      if (decoded.errorName === "PoolPriceOutOfBand") {
        const [oracleOut, poolOut] = decoded.args as readonly [bigint, bigint];
        return `Chainlink says ${usdc(oracleOut)} USDC, pool offers ${usdc(poolOut)} USDC for 1 HBAR → refused (PoolPriceOutOfBand)`;
      }
      return `Guard reverted with ${decoded.errorName}`;
    } catch {
      return null;
    }
  }
}

async function main() {
  // 0. Preflight
  console.log("Quorum Treasury · presenter demo");
  const dashboardUp = await fetch(DASHBOARD, { signal: AbortSignal.timeout(8000) })
    .then(r => r.ok)
    .catch(() => false);
  if (!dashboardUp) {
    console.error("Start the dashboard first: yarn next:dev");
    return finish(1);
  }
  const d = readDeployment();
  if (!d.treasuryId || !d.indexTopicId || !d.swapGuardUsdcId) {
    console.error("deployments/testnet.json is incomplete. Run yarn treasury:setup and yarn treasury:demo -- --step guards.");
    return finish(1);
  }
  let op;
  try {
    op = operatorClient();
  } catch (error) {
    console.error(`Operator key missing or invalid: ${explain(error)}`);
    return finish(1);
  }
  client = op.client;
  const signers = loadOrCreateSigners();
  const local = scriptSigners(signers);
  const s2 = local.find(s => s.index === 2);
  const s3 = local.find(s => s.index === 3);
  if (!s2 || !s3) {
    console.error("Signers 2 and 3 need local keys (SIGNER2_KEY / SIGNER3_KEY in .env.local).");
    return finish(1);
  }
  const treasury = await guarded("Reading the treasury from the mirror node", () => mirror.getAccount(d.treasuryId!));
  const usdcBal = treasury.balance.tokens.find(t => t.token_id === TESTNET.usdc.tokenId)?.balance ?? 0;
  log(`Treasury ${d.treasuryId}`, `${(treasury.balance.balance / 1e8).toFixed(4)} HBAR · ${(usdcBal / 1e6).toFixed(2)} USDC`);
  log(`Keys OK: operator, signer 2, signer 3 (signer 1 = ${signers[0]!.privateKey ? "local key" : "HashPack"})`);
  log(`Pace ${MANUAL ? "manual" : `${PACE}s`} · timelock ${TIMELOCK}s · veto demo ${VETO ? "on" : "off"} · browser ${OPEN ? "on" : "off"}`);

  // 1. Dashboard
  banner(1, "The treasury", "A treasury that is just a Hedera account with a 2-of-3 key. No multisig contract.");
  openUrl(`${DASHBOARD}/`);
  log("Treasury account", hashscan("account", d.treasuryId));
  await pause();

  // 2. Guard refusal, live
  banner(2, "The guard refuses a bad pool", "SwapGuard checks Chainlink at execution time. The public SaucerSwap USDC pool is ~22x off, so it reverts.");
  const live = await liveGuardRefusal(toLongZeroAddress(d.swapGuardUsdcId) as `0x${string}`,toLongZeroAddress(d.treasuryId) as `0x${string}`);
  if (live) console.log(`  LIVE eth_call from the treasury: ${live}`);
  else console.log("  Live eth_call unavailable (relay did not return the revert). Showing the recorded proof instead:");
  let proofUrl = hashscan("contract", d.swapGuardUsdcId);
  try {
    const proofs = JSON.parse(readFileSync(new URL("../../../docs/proofs.json", import.meta.url), "utf8")) as { id: string; claim: string; hashscan: string }[];
    const p = proofs.find(x => x.id === "guard-rejects-public-pool");
    if (p) {
      proofUrl = p.hashscan;
      if (!live) console.log(`  RECORDED: ${p.claim}`);
    }
  } catch {
    /* keep the contract link */
  }
  openUrl(proofUrl);
  await pause();

  // 3. Live proposal by signer 2
  banner(3, "A live payment proposal", `Signer 2 proposes paying 1 HBAR to 0.0.98 with a ${TIMELOCK}s timelock. One signature is not enough.`);
  const now = Math.floor(Date.now() / 1000);
  const common = { treasuryId: d.treasuryId, vetoKey: anyOneKey(signers), executeAt: now + TIMELOCK };
  const proposed = await guarded("Creating the proposal", async () => {
    const schedule = hbarPaymentProposal({ ...common, memo: `Pay 1 HBAR (video) #${now % 1e6}`, to: "0.0.98", tinybar: 100_000_000n });
    const p = await submitProposal(client!, schedule, s2.privateKey);
    await announce(client!, d.indexTopicId!, { scheduleId: p.scheduleId, type: "hbar-payment", title: "Pay 1 HBAR to 0.0.98", signedVia: "script" }, s2.privateKey);
    return p.scheduleId;
  });
  console.log(`Signer 2 proposed ${proposed}. 1 of 2 signatures.`);
  log("Schedule on HashScan", hashscan("schedule", proposed));
  openUrl(`${DASHBOARD}/proposals/${proposed}`);
  await pause();

  // 4. Second signature
  banner(
    4,
    "The second signature",
    HASHPACK ? "Sign it now with HashPack in the browser (falls back to signer 3 after 3 minutes)." : "Signer 3 signs with their own ScheduleSign. Quorum reached: now it waits out the timelock.",
  );
  let signedByHashpack = false;
  if (HASHPACK) {
    console.log("Sign it now with HashPack in the browser");
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !signedByHashpack) {
      await sleep(3000);
      const s = await mirror.getSchedule(proposed).catch(() => null);
      if (s && s.signatures.length >= 2) signedByHashpack = true;
    }
    if (signedByHashpack) log("Second signature detected on the mirror node");
    else console.log("No HashPack signature after 3 minutes; signer 3 signs instead.");
  } else {
    await pause();
  }
  if (!signedByHashpack) {
    await guarded("Signer 3 signing", () => signProposal(client!, proposed, s3.privateKey));
    log("Signer 3 signed. 2 of 2 signatures: timelocked, the veto window is open.");
  }
  await mirror.waitFor(() => mirror.getSchedule(proposed).catch(() => null), x => (x?.signatures.length ?? 0) >= 2, { attempts: 10, intervalMs: 2000 }).catch(() => undefined);
  openUrl(`${DASHBOARD}/proposals/${proposed}`);
  await pause();

  // 5. Veto demo
  if (VETO) {
    banner(5, "One signer vetoes", "A second proposal gets its quorum, then any single signer deletes it during the timelock.");
    const vetoed = await guarded("Veto demo", async () => {
      const t = Math.floor(Date.now() / 1000);
      const schedule = hbarPaymentProposal({ ...common, executeAt: t + Math.max(TIMELOCK, 120), memo: `Suspicious payout (video) #${t % 1e6}`, to: "0.0.98", tinybar: 500_000_000n });
      const p = await submitProposal(client!, schedule, s2.privateKey);
      await announce(client!, d.indexTopicId!, { scheduleId: p.scheduleId, type: "hbar-payment", title: "Suspicious payout of 5 HBAR", signedVia: "script" }, s2.privateKey);
      await signProposal(client!, p.scheduleId, s3.privateKey);
      log(`Proposal ${p.scheduleId} has 2 of 2 signatures`);
      await vetoProposal(client!, p.scheduleId, s2.privateKey);
      return p.scheduleId;
    });
    const s = await mirror.waitFor(() => mirror.getSchedule(vetoed).catch(() => null), x => Boolean(x?.deleted), { attempts: 15, intervalMs: 2000 }).catch(() => null);
    console.log(`Signer 2 vetoed ${vetoed}${s?.deleted ? " (deleted on the ledger)" : " (mirror still catching up)"}. Nothing moved.`);
    openUrl(`${DASHBOARD}/proposals/${vetoed}`);
    await pause();
  } else {
    console.log(`\n(step 5 skipped: --no-veto)`);
  }

  // 6. Execution + audit + budget
  banner(6, "It executes by itself", "No one pressed execute: the network runs the scheduled payment when the timelock ends. The HCS index is reconciled with the ledger.");
  console.log("  Waiting for the timelock to finish (mirror node lags a few seconds)...");
  const executed = await mirror
    .waitFor(() => mirror.getSchedule(proposed).catch(() => null), x => Boolean(x?.executed_timestamp), { attempts: Math.ceil((TIMELOCK + 90) / 4), intervalMs: 4000 })
    .catch(() => null);
  if (!executed?.executed_timestamp) {
    console.error(`✗ Schedule ${proposed} did not execute in time (check ${hashscan("schedule", proposed)}).`);
    return finish(1);
  }
  const inner = await guarded("Reading the inner transaction", () => withRetry(() => mirror.getScheduledTransaction(executed.executed_timestamp!)));
  if (inner?.result !== "SUCCESS") {
    console.error(`✗ Inner transaction result: ${inner?.result ?? "unknown"}`);
    return finish(1);
  }
  console.log(`SUCCESS · inner transaction result ${inner.result} at ${executed.executed_timestamp}`);
  openUrl(hashscan("schedule", proposed));
  await pause();
  openUrl(`${DASHBOARD}/audit`);
  await pause();
  openUrl(`${DASHBOARD}/budget`);
  await pause();

  // 7. End
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n\n━━ Done ━━\nVerify every recorded proof yourself, no keys needed:  yarn verify:proofs\nTotal elapsed: ${Math.floor(secs / 60)}m ${secs % 60}s`);
  finish(0);
}

main().catch(error => {
  console.error(`\n✗ ${explain(error)}`);
  finish(1);
});
