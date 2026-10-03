import { proto } from "@hiero-ledger/proto";
import { Key, KeyList, PrivateKey, Transaction } from "@hiero-ledger/sdk";
import type { MirrorSchedule } from "../src/status";

/** Deterministic test keys (never used on any network). */
export const ED_KEYS = [1, 2, 3].map(i => PrivateKey.fromStringED25519(`${"0".repeat(63)}${i}`));
export const EC_KEYS = [1, 2, 3].map(i => PrivateKey.fromStringECDSA(`${"0".repeat(63)}${i}`));

export const rawPublicKey = (k: PrivateKey) => k.publicKey.toStringRaw();

/** Protobuf-encoded key as the mirror node returns it for KeyLists: `{_type: "ProtobufEncoded", key: hex}`. */
export function mirrorKeyOf(key: Key): { _type: string; key: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const protoKey = (key as any)._toProtobufKey() as proto.IKey;
  return { _type: "ProtobufEncoded", key: Buffer.from(proto.Key.encode(protoKey).finish()).toString("hex") };
}

export function threshold(n: number, keys: PrivateKey[]): KeyList {
  return new KeyList(keys.map(k => k.publicKey), n);
}

/** Base64 `SchedulableTransactionBody` of a ScheduleCreate's inner transaction, like the mirror's `transaction_body`. */
export function scheduledBodyBase64(inner: Transaction): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (inner as any)._getScheduledTransactionBody() as proto.ISchedulableTransactionBody;
  return Buffer.from(proto.SchedulableTransactionBody.encode(body).finish()).toString("base64");
}

export function b64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

export function schedule(overrides: Partial<MirrorSchedule> = {}): MirrorSchedule {
  return {
    schedule_id: "0.0.900",
    creator_account_id: "0.0.10",
    payer_account_id: "0.0.500",
    admin_key: null,
    consensus_timestamp: "1800000000.000000001",
    deleted: false,
    executed_timestamp: null,
    expiration_time: "1800000300.000000000",
    memo: "pay contractor",
    wait_for_expiry: true,
    signatures: [],
    transaction_body: "",
    ...overrides,
  };
}

export function signedBy(...keys: PrivateKey[]): MirrorSchedule["signatures"] {
  return keys.map((k, i) => ({
    public_key_prefix: b64(rawPublicKey(k)),
    signature: "c2ln",
    type: k.type === "ED25519" ? "ED25519" : "ECDSA_SECP256K1",
    consensus_timestamp: `18000000${10 + i}.000000000`,
  }));
}
