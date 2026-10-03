import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const ENV_LOCAL = resolve(REPO_ROOT, ".env.local");

/** Minimal dotenv: KEY=VALUE lines, # comments, optional quotes. Existing process.env wins. */
export function loadEnv(file = ENV_LOCAL): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    const [, key, raw] = match;
    if (process.env[key!] === undefined) process.env[key!] = raw!.replace(/^["']|["']$/g, "");
  }
}

export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing ${key}. Add it to .env.local (see .env.example) — never commit that file.`);
  }
  return value;
}

/** Add or replace KEY=VALUE lines in .env.local (gitignored). Used to store generated signer keys. */
export function upsertEnvLocal(values: Record<string, string>, file = ENV_LOCAL): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex(l => l.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
    process.env[key] = value;
  }
  writeFileSync(file, `${lines.filter((l, i, all) => l !== "" || i < all.length - 1).join("\n")}\n`, { mode: 0o600 });
}
