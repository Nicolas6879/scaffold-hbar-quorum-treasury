import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { MirrorClient, MirrorHttpError, MirrorSchedule, TESTNET } from "../../src";
import { loadEnv, REPO_ROOT, requireEnv } from "./env";

/** @param name The env var the value came from; used in the error, which never includes the value itself. */
export function parsePrivateKey(value: string, name = "private key"): PrivateKey {
  const v = value.trim().replace(/^0x/, "");
  try {
    // DER strings carry their own type; raw 32-byte hex is ambiguous, so prefer ECDSA (what portal.hedera.com issues).
    if (v.startsWith("302")) return PrivateKey.fromStringDer(v);
    return process.env.OPERATOR_KEY_TYPE === "ED25519" ? PrivateKey.fromStringED25519(v) : PrivateKey.fromStringECDSA(v);
  } catch {
    throw new Error(`${name} is not a valid private key (expected a DER string or 32-byte hex). Check .env.local.`);
  }
}

/** Run start-up work (env, keys) and print its message, not a stack trace, if it fails. */
export function orExit<T>(init: () => T): T {
  try {
    return init();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

function parseAccountId(value: string, name: string): AccountId {
  try {
    return AccountId.fromString(value.trim());
  } catch {
    throw new Error(`${name} must look like 0.0.1234 (got "${value}"). Check .env.local.`);
  }
}

export function operatorClient(): { client: Client; operatorId: AccountId; operatorKey: PrivateKey } {
  loadEnv();
  if ((process.env.HEDERA_NETWORK ?? "testnet") !== "testnet") {
    throw new Error("These scripts target testnet. Mainnet support is a deliberate opt-in (see docs/CUSTOMIZE.md).");
  }
  const operatorId = parseAccountId(requireEnv("OPERATOR_ID"), "OPERATOR_ID");
  const operatorKey = parsePrivateKey(requireEnv("OPERATOR_KEY"), "OPERATOR_KEY");
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  client.setMaxAttempts(10);
  return { client, operatorId, operatorKey };
}

export const mirror = new MirrorClient(TESTNET.mirrorUrl);

/**
 * `mirror.getSchedule` for a schedule that may have been created seconds ago: the mirror node answers
 * 404 until it has ingested the ScheduleCreate, so wait briefly before concluding the id is wrong.
 */
export async function getScheduleWhenIndexed(scheduleId: string): Promise<MirrorSchedule> {
  const schedule = await mirror
    .waitFor(
      () =>
        mirror.getSchedule(scheduleId).catch(error => {
          if (error instanceof MirrorHttpError && error.status === 404) return null;
          throw error;
        }),
      found => found !== null,
      { attempts: 6, intervalMs: 1500 },
    )
    .catch(error => {
      if (error instanceof MirrorHttpError) throw error;
      throw new Error(`Schedule ${scheduleId} was not found on the mirror node. Check the id, or retry in a few seconds if it was just created.`);
    });
  return schedule!;
}

/** Public deployment record (ids and public keys only — never secrets). Committed for the demo treasury. */
export interface Deployment {
  network: "testnet";
  treasuryId?: string;
  opsAccountId?: string;
  indexTopicId?: string;
  signerPublicKeys?: string[];
  usdcTokenId?: string;
  swapGuardUsdcId?: string;
  swapGuardUsdcEvm?: string;
  demoStableTokenId?: string;
  swapGuardDemoId?: string;
  swapGuardDemoEvm?: string;
  demoPoolEvm?: string;
  demoPoolSeeded?: boolean;
}

export const DEPLOYMENT_FILE = resolve(REPO_ROOT, "deployments/testnet.json");

export function readDeployment(): Deployment {
  return existsSync(DEPLOYMENT_FILE) ? (JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment) : { network: "testnet" };
}

export function writeDeployment(update: Partial<Deployment>): Deployment {
  const next = { ...readDeployment(), ...update };
  mkdirSync(resolve(REPO_ROOT, "deployments"), { recursive: true });
  writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export const hashscan = (kind: "account" | "topic" | "token" | "contract" | "schedule" | "transaction", id: string) =>
  `${TESTNET.hashscan}/${kind}/${id}`;

export function log(step: string, detail = ""): void {
  console.log(`• ${step}${detail ? `  ${detail}` : ""}`);
}
