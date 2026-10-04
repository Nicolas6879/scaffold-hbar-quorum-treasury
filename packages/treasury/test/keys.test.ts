import { proto } from "@hiero-ledger/proto";
import { KeyList } from "@hiero-ledger/sdk";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeKeyProto,
  hasSignedWith,
  hexToBytes,
  isMember,
  isSatisfied,
  keyFromMirror,
  KeyNode,
  shortKey,
  signatureProgress,
  signerNumber,
  stripDerPrefix,
} from "../src/keys";
import { EC_KEYS, ED_KEYS, mirrorKeyOf, rawPublicKey, threshold } from "./helpers";

const [a, b, c] = [ED_KEYS[0]!, EC_KEYS[1]!, ED_KEYS[2]!];
const mixed2of3 = keyFromMirror(mirrorKeyOf(threshold(2, [a, b, c])));

describe("decoding mirror-node keys", () => {
  it("decodes a mixed ED25519/ECDSA 2-of-3 threshold key", () => {
    expect(mixed2of3).toEqual({
      type: "threshold",
      threshold: 2,
      keys: [
        { type: "ed25519", publicKey: rawPublicKey(a) },
        { type: "ecdsa", publicKey: rawPublicKey(b) },
        { type: "ed25519", publicKey: rawPublicKey(c) },
      ],
    });
  });

  it("treats a plain KeyList as all-of-N", () => {
    const node = keyFromMirror(mirrorKeyOf(new KeyList([a.publicKey, b.publicKey])));
    expect(node).toMatchObject({ type: "threshold", threshold: 2 });
  });

  it("decodes nested threshold keys", () => {
    const inner = new KeyList([b.publicKey, c.publicKey], 1);
    const outer = new KeyList([a.publicKey, inner], 2);
    const node = keyFromMirror(mirrorKeyOf(outer));
    expect(node.type === "threshold" && node.keys[1]).toMatchObject({ type: "threshold", threshold: 1 });
  });

  it("decodes simple keys reported by type", () => {
    expect(keyFromMirror({ _type: "ED25519", key: "AB" })).toEqual({ type: "ed25519", publicKey: "ab" });
    expect(keyFromMirror({ _type: "ECDSA_SECP256K1", key: "02aa" })).toEqual({ type: "ecdsa", publicKey: "02aa" });
    expect(() => keyFromMirror({ _type: "RSA_3072", key: "00" })).toThrow(/Unsupported/);
  });

  it("rejects corrupt protobuf instead of guessing", () => {
    expect(() => decodeKeyProto(hexToBytes("2aff"))).toThrow(/Truncated/);
    expect(() => decodeKeyProto(new Uint8Array())).toThrow(/Empty/);
  });

  it("rejects an impossible threshold (3 of 1)", () => {
    const bytes = proto.Key.encode({
      thresholdKey: { threshold: 3, keys: { keys: [{ ed25519: new Uint8Array(32).fill(0x11) }] } },
    }).finish();
    expect(() => decodeKeyProto(bytes)).toThrow(/Invalid threshold/);
  });
});

describe("signature progress", () => {
  it("reports 1 of 2 after the proposer signs", () => {
    expect(signatureProgress(mixed2of3, [rawPublicKey(a)])).toEqual({ signed: 1, required: 2, complete: false, signedMembers: [0] });
  });

  it("is complete with any two of the three, regardless of key type", () => {
    expect(signatureProgress(mixed2of3, [rawPublicKey(b), rawPublicKey(c)]).complete).toBe(true);
  });

  it("ignores duplicate signatures from the same key", () => {
    expect(signatureProgress(mixed2of3, [rawPublicKey(a), rawPublicKey(a)]).signed).toBe(1);
  });

  it("ignores signatures from keys outside the treasury", () => {
    expect(signatureProgress(mixed2of3, [rawPublicKey(EC_KEYS[0]!), rawPublicKey(ED_KEYS[1]!)]).signed).toBe(0);
  });

  it("matches the short public-key prefixes the mirror node may report", () => {
    expect(isSatisfied(mixed2of3, [rawPublicKey(a).slice(0, 12), rawPublicKey(c).slice(0, 12)])).toBe(true);
  });

  it("accepts DER-encoded keys from the SDK", () => {
    expect(isSatisfied(mixed2of3, [a.publicKey.toStringDer(), b.publicKey.toStringDer()])).toBe(true);
    expect(stripDerPrefix(a.publicKey.toStringDer())).toBe(rawPublicKey(a));
  });

  it("never treats a contract key as signable", () => {
    const node: KeyNode = { type: "threshold", threshold: 1, keys: [{ type: "contract", contractNum: "5" }] };
    expect(isSatisfied(node, ["00"])).toBe(false);
  });

  it("identifies members of the quorum", () => {
    expect(isMember(mixed2of3, b.publicKey.toStringDer())).toBe(true);
    expect(isMember(mixed2of3, rawPublicKey(EC_KEYS[2]!))).toBe(false);
  });

  it("property: progress equals the number of distinct member signers, complete iff ≥ threshold", () => {
    const pool = [...ED_KEYS, ...EC_KEYS];
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: pool.length }),
        fc.uniqueArray(fc.integer({ min: 0, max: pool.length - 1 }), { minLength: 1, maxLength: pool.length }),
        fc.array(fc.integer({ min: 0, max: pool.length - 1 })),
        (t, memberIdx, signerIdx) => {
          const members = memberIdx.map(i => pool[i]!);
          const thr = Math.min(t, members.length);
          const node = keyFromMirror(mirrorKeyOf(threshold(thr, members)));
          const signers = signerIdx.map(i => rawPublicKey(pool[i]!));
          const expected = new Set(signerIdx.filter(i => memberIdx.includes(i))).size;
          const p = signatureProgress(node, signers);
          expect(p.signed).toBe(expected);
          expect(p.complete).toBe(expected >= thr);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("signer identification for the browser wallet", () => {
  it("numbers members 1-based and rejects outsiders (DER or raw)", () => {
    const outsider = EC_KEYS[0]!;
    expect(signerNumber(mixed2of3, rawPublicKey(a))).toBe(1);
    expect(signerNumber(mixed2of3, b.publicKey.toStringDer())).toBe(2);
    expect(signerNumber(mixed2of3, rawPublicKey(outsider))).toBeNull();
  });

  it("detects whether a signature prefix landed for a key", () => {
    const prefix = rawPublicKey(c).slice(0, 12);
    expect(hasSignedWith(rawPublicKey(c), [prefix])).toBe(true);
    expect(hasSignedWith(rawPublicKey(a), [prefix])).toBe(false);
    expect(hasSignedWith(rawPublicKey(a), [])).toBe(false);
  });

  it("shortens keys", () => {
    expect(shortKey(`302a300506032b6570032100${"ab".repeat(32)}`)).toBe("abababab…");
  });
});
