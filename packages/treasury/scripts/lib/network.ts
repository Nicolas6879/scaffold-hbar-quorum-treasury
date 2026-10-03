import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { MirrorClient, TESTNET } from "../../src";
import { loadEnv, REPO_ROOT, requireEnv } from "./env";

export function parsePrivateKey(value: string): PrivateKey {
  const v = value.trim().replace(/^0x/, "");
  // DER strings carry their own type; raw 32-byte hex is ambiguous, so prefer ECDSA (what portal.hedera.com issues).
  if (v.startsWith("302")) return PrivateKey.fromStringDer(v);
  return process.env.OPERATOR_KEY_TYPE === "ED25519" ? PrivateKey.fromStringED25519(v) : PrivateKey.fromStringECDSA(v);
}

export function operatorClient(): { client: Client; operatorId: AccountId; operatorKey: PrivateKey } {
  loadEnv();
  if ((process.env.HEDERA_NETWORK ?? "testnet") !== "testnet") {
    throw new Error("These scripts target testnet. Mainnet support is a deliberate opt-in (see docs/CUSTOMIZE.md).");
  }
  const operatorId = AccountId.fromString(requireEnv("OPERATOR_ID"));
  const operatorKey = parsePrivateKey(requireEnv("OPERATOR_KEY"));
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);
  client.setMaxAttempts(10);
  return { client, operatorId, operatorKey };
}

export const mirror = new MirrorClient(TESTNET.mirrorUrl);

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
