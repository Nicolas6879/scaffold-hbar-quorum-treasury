import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env";

/**
 * A proof is a claim plus a mirror-node query that anyone can re-run without trusting this repo.
 * `expect` maps dot-paths in the mirror JSON to expected values (strings compare exactly,
 * `{ ">": n }` compares numbers).
 */
export interface Proof {
  id: string;
  claim: string;
  hashscan: string;
  mirrorPath: string;
  expect: Record<string, string | number | boolean | null | { ">": number }>;
  /** Who produced the signatures for this proof: be explicit about scripted vs wallet signers. */
  signedBy?: string;
  test?: string;
}

export const PROOFS_FILE = resolve(REPO_ROOT, "docs/proofs.json");

export function readProofs(): Proof[] {
  return existsSync(PROOFS_FILE) ? (JSON.parse(readFileSync(PROOFS_FILE, "utf8")) as Proof[]) : [];
}

export function saveProof(proof: Proof): void {
  const proofs = readProofs().filter(p => p.id !== proof.id);
  proofs.push(proof);
  writeFileSync(PROOFS_FILE, `${JSON.stringify(proofs, null, 2)}\n`);
}

/** SDK "0.0.5@1700000000.123456789" → mirror "0.0.5-1700000000-123456789". */
export function mirrorTxId(sdkTxId: string): string {
  const [account, timestamp] = sdkTxId.split("@");
  const [seconds, nanos] = timestamp!.split(".");
  return `${account}-${seconds}-${nanos}`;
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc == null ? undefined : (acc as Record<string, unknown>)[key]), obj);
}

export function checkExpectations(body: unknown, expect: Proof["expect"]): string[] {
  const failures: string[] = [];
  for (const [path, expected] of Object.entries(expect)) {
    const actual = getPath(body, path);
    if (expected !== null && typeof expected === "object") {
      if (!(typeof actual === "number" && actual > expected[">"])) failures.push(`${path}: expected > ${expected[">"]}, got ${String(actual)}`);
    } else if (actual !== expected) {
      failures.push(`${path}: expected ${String(expected)}, got ${String(actual)}`);
    }
  }
  return failures;
}
