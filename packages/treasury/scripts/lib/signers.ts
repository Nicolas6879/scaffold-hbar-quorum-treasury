import { KeyList, PrivateKey, PublicKey } from "@hiero-ledger/sdk";
import { upsertEnvLocal } from "./env";
import { parsePrivateKey } from "./network";

export interface Signer {
  index: 1 | 2 | 3;
  publicKey: PublicKey;
  /** Absent when the signer lives in a wallet (HashPack): that signer signs in the browser. */
  privateKey?: PrivateKey;
}

/**
 * Three signers. Signer 1 can be your HashPack account (SIGNER1_PUBLIC_KEY); otherwise the script
 * generates keys and stores them in .env.local. Key types are mixed on purpose (ED25519 + ECDSA)
 * to show that a Hedera threshold key does not care.
 */
export function loadOrCreateSigners(): Signer[] {
  const generated: Record<string, string> = {};
  const signers = ([1, 2, 3] as const).map(index => {
    const existing = process.env[`SIGNER${index}_KEY`];
    if (existing) {
      const privateKey = parsePrivateKey(existing);
      return { index, publicKey: privateKey.publicKey, privateKey };
    }
    if (index === 1 && process.env.SIGNER1_PUBLIC_KEY) {
      return { index, publicKey: PublicKey.fromString(process.env.SIGNER1_PUBLIC_KEY) };
    }
    const privateKey = index === 2 ? PrivateKey.generateECDSA() : PrivateKey.generateED25519();
    generated[`SIGNER${index}_KEY`] = privateKey.toStringDer();
    return { index, publicKey: privateKey.publicKey, privateKey };
  });
  if (Object.keys(generated).length > 0) upsertEnvLocal(generated);
  return signers;
}

/** The treasury key: any 2 of the 3 signers. */
export const quorumKey = (signers: Signer[], threshold = 2) => new KeyList(signers.map(s => s.publicKey), threshold);

/** Any 1 of the 3: the veto key (schedule admin key), the HCS index submit key and the ops account key. */
export const anyOneKey = (signers: Signer[]) => new KeyList(signers.map(s => s.publicKey), 1);

export function scriptSigners(signers: Signer[]): (Signer & { privateKey: PrivateKey })[] {
  return signers.filter((s): s is Signer & { privateKey: PrivateKey } => Boolean(s.privateKey));
}
