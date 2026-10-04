/**
 * Threshold-key model and signature progress.
 *
 * The mirror node returns a simple account key as `{_type: "ED25519" | "ECDSA_SECP256K1", key: hex}`
 * and a KeyList / ThresholdKey as `{_type: "ProtobufEncoded", key: hex}`. We decode that protobuf
 * ourselves (it is a tiny, stable message) so the UI can say "1 of 2 signatures" without the SDK.
 */

export type KeyNode =
  | { type: "ed25519" | "ecdsa"; publicKey: string }
  | { type: "threshold"; threshold: number; keys: KeyNode[] }
  | { type: "contract"; contractNum: string }
  | { type: "unsupported"; field: number };

export interface MirrorKey {
  _type: string;
  key: string;
}

/** Decode a mirror-node account/admin key into a {@link KeyNode}. */
export function keyFromMirror(mirrorKey: MirrorKey): KeyNode {
  const hex = mirrorKey.key.toLowerCase();
  switch (mirrorKey._type) {
    case "ED25519":
      return { type: "ed25519", publicKey: hex };
    case "ECDSA_SECP256K1":
      return { type: "ecdsa", publicKey: hex };
    case "ProtobufEncoded":
      return decodeKeyProto(hexToBytes(hex));
    default:
      throw new Error(`Unsupported mirror key type: ${mirrorKey._type}`);
  }
}

// ---------------------------------------------------------------------------
// Minimal protobuf reader for the HAPI `Key` message.
//   Key { ed25519 = 2 bytes; thresholdKey = 5; keyList = 6; ECDSA_secp256k1 = 7 bytes; contractID = 1; ... }
//   ThresholdKey { threshold = 1 uint32; keys = 2 KeyList }
//   KeyList { keys = 1 repeated Key }
// ---------------------------------------------------------------------------

interface Field {
  number: number;
  wireType: number;
  varint?: bigint;
  bytes?: Uint8Array;
}

function* readFields(buf: Uint8Array): Generator<Field> {
  let pos = 0;
  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (pos >= buf.length) throw new Error("Truncated protobuf varint");
      const byte = buf[pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("Protobuf varint too long");
    }
  };
  while (pos < buf.length) {
    const tag = Number(readVarint());
    const number = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      yield { number, wireType, varint: readVarint() };
    } else if (wireType === 2) {
      const length = Number(readVarint());
      if (pos + length > buf.length) throw new Error("Truncated protobuf field");
      yield { number, wireType, bytes: buf.subarray(pos, pos + length) };
      pos += length;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType} in a Key`);
    }
  }
}

export function decodeKeyProto(buf: Uint8Array): KeyNode {
  for (const field of readFields(buf)) {
    switch (field.number) {
      case 2:
        return { type: "ed25519", publicKey: bytesToHex(field.bytes!) };
      case 7:
        return { type: "ecdsa", publicKey: bytesToHex(field.bytes!) };
      case 5:
        return decodeThreshold(field.bytes!);
      case 6:
        // A plain KeyList means "all of them".
        return allOf(decodeKeyList(field.bytes!));
      case 1:
      case 8:
        return { type: "contract", contractNum: decodeContractNum(field.bytes!) };
      default:
        return { type: "unsupported", field: field.number };
    }
  }
  throw new Error("Empty Key message");
}

function decodeThreshold(buf: Uint8Array): KeyNode {
  let threshold = 0;
  let keys: KeyNode[] = [];
  for (const field of readFields(buf)) {
    if (field.number === 1) threshold = Number(field.varint);
    if (field.number === 2) keys = decodeKeyList(field.bytes!);
  }
  if (threshold < 1 || threshold > keys.length) {
    throw new Error(`Invalid threshold key: ${threshold} of ${keys.length}`);
  }
  return { type: "threshold", threshold, keys };
}

function decodeKeyList(buf: Uint8Array): KeyNode[] {
  const keys: KeyNode[] = [];
  for (const field of readFields(buf)) if (field.number === 1) keys.push(decodeKeyProto(field.bytes!));
  return keys;
}

function decodeContractNum(buf: Uint8Array): string {
  let num = 0n;
  for (const field of readFields(buf)) if (field.number === 3) num = field.varint ?? 0n;
  return num.toString();
}

const allOf = (keys: KeyNode[]): KeyNode => ({ type: "threshold", threshold: keys.length, keys });

// ---------------------------------------------------------------------------
// Signature progress
// ---------------------------------------------------------------------------

/**
 * `signedPrefixes` are hex public-key prefixes as the mirror node reports them for a schedule
 * (`signatures[].public_key_prefix`, base64 there — convert with {@link base64ToHex}).
 */
export function isSatisfied(node: KeyNode, signedPrefixes: Iterable<string>): boolean {
  const prefixes = normalizePrefixes(signedPrefixes);
  return satisfied(node, prefixes);
}

function satisfied(node: KeyNode, prefixes: string[]): boolean {
  switch (node.type) {
    case "ed25519":
    case "ecdsa":
      return matchesAny(node.publicKey, prefixes);
    case "threshold":
      return node.keys.filter(k => satisfied(k, prefixes)).length >= node.threshold;
    default:
      // Contract keys are satisfied by contract calls, never by a ScheduleSign.
      return false;
  }
}

export interface Progress {
  /** Top-level members whose (sub)key is satisfied. */
  signed: number;
  required: number;
  complete: boolean;
  /** Indexes of the top-level members that have signed. */
  signedMembers: number[];
}

/** "1 of 2" style progress for the top level of a threshold key. */
export function signatureProgress(node: KeyNode, signedPrefixes: Iterable<string>): Progress {
  const prefixes = normalizePrefixes(signedPrefixes);
  if (node.type !== "threshold") {
    const ok = satisfied(node, prefixes);
    return { signed: ok ? 1 : 0, required: 1, complete: ok, signedMembers: ok ? [0] : [] };
  }
  const signedMembers = node.keys.flatMap((k, i) => (satisfied(k, prefixes) ? [i] : []));
  return {
    signed: signedMembers.length,
    required: node.threshold,
    complete: signedMembers.length >= node.threshold,
    signedMembers,
  };
}

/** Flatten all simple public keys in a key tree (used to check whether a signer belongs to the quorum). */
export function memberKeys(node: KeyNode): string[] {
  if (node.type === "threshold") return node.keys.flatMap(memberKeys);
  if (node.type === "ed25519" || node.type === "ecdsa") return [node.publicKey];
  return [];
}

export function isMember(node: KeyNode, publicKey: string): boolean {
  const key = stripDerPrefix(publicKey.toLowerCase());
  return memberKeys(node).some(k => k === key);
}

function matchesAny(publicKey: string, prefixes: string[]): boolean {
  const key = stripDerPrefix(publicKey.toLowerCase());
  return prefixes.some(p => p.length > 0 && key.startsWith(p));
}

function normalizePrefixes(prefixes: Iterable<string>): string[] {
  return [...new Set([...prefixes].map(p => stripDerPrefix(p.toLowerCase().replace(/^0x/, ""))))];
}

/** SDK `toStringDer()` keys carry an ASN.1 prefix; the mirror node and the protobuf use raw keys. */
export function stripDerPrefix(hex: string): string {
  const ED25519_DER = "302a300506032b6570032100";
  const ECDSA_DER = "302d300706052b8104000a032200";
  if (hex.startsWith(ED25519_DER)) return hex.slice(ED25519_DER.length);
  if (hex.startsWith(ECDSA_DER)) return hex.slice(ECDSA_DER.length);
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error("Invalid hex string");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export function base64ToHex(b64: string): string {
  return bytesToHex(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
}

/** 1-based signer number of `publicKey` among the quorum's simple keys, or null if it is not a member. */
export function signerNumber(node: KeyNode, publicKey: string): number | null {
  const key = stripDerPrefix(publicKey.toLowerCase());
  const index = memberKeys(node).indexOf(key);
  return index === -1 ? null : index + 1;
}

/** True when `publicKey` is covered by one of the schedule's signature prefixes (hex, e.g. via {@link base64ToHex}). */
export function hasSignedWith(publicKey: string, signedPrefixes: Iterable<string>): boolean {
  return matchesAny(publicKey, normalizePrefixes(signedPrefixes));
}

/** Short display form of a public key: first 8 hex chars plus an ellipsis. */
export const shortKey = (publicKey: string): string => `${stripDerPrefix(publicKey.toLowerCase()).slice(0, 8)}…`;
