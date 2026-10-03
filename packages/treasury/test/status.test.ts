import { describe, expect, it } from "vitest";
import { keyFromMirror } from "../src/keys";
import { canSign, canVeto, proposalStatus, timestampToSeconds } from "../src/status";
import { EC_KEYS, ED_KEYS, mirrorKeyOf, schedule, signedBy, threshold } from "./helpers";

const [a, b, c] = [ED_KEYS[0]!, EC_KEYS[1]!, ED_KEYS[2]!];
const key = keyFromMirror(mirrorKeyOf(threshold(2, [a, b, c])));
const EXPIRES = 1_800_000_300;

describe("proposal lifecycle", () => {
  it("collects signatures before quorum", () => {
    const s = proposalStatus(schedule({ signatures: signedBy(a) }), key, EXPIRES - 100);
    expect(s).toMatchObject({ state: "collecting-signatures", signed: 1, required: 2, secondsLeft: 100 });
    expect(canSign(s.state) && canVeto(s.state)).toBe(true);
  });

  it("is timelocked once quorum is reached but before expiry: the veto window", () => {
    const s = proposalStatus(schedule({ signatures: signedBy(a, b) }), key, EXPIRES - 60);
    expect(s).toMatchObject({ state: "timelocked", secondsLeft: 60 });
    expect(canSign(s.state)).toBe(false);
    expect(canVeto(s.state)).toBe(true);
  });

  it("shows 'executing' when expiry passed with quorum but the network has not run it yet (lazy execution)", () => {
    expect(proposalStatus(schedule({ signatures: signedBy(a, c) }), key, EXPIRES + 5).state).toBe("executing");
  });

  it("expires when the deadline passes without quorum", () => {
    expect(proposalStatus(schedule({ signatures: signedBy(a) }), key, EXPIRES + 1).state).toBe("expired");
  });

  it("is executed when the mirror reports an executed timestamp and the inner tx succeeded", () => {
    const s = proposalStatus(schedule({ signatures: signedBy(a, b), executed_timestamp: "1800000301.1" }), key, EXPIRES + 10, "SUCCESS");
    expect(s.state).toBe("executed");
    expect(canVeto(s.state)).toBe(false);
  });

  it("is failed when the schedule executed but the inner transaction did not succeed", () => {
    const s = proposalStatus(
      schedule({ signatures: signedBy(a, b), executed_timestamp: "1800000301.1" }),
      key,
      EXPIRES + 10,
      "INSUFFICIENT_ACCOUNT_BALANCE",
    );
    expect(s).toMatchObject({ state: "failed", innerResult: "INSUFFICIENT_ACCOUNT_BALANCE" });
  });

  it("is vetoed when deleted, even if it had quorum", () => {
    expect(proposalStatus(schedule({ signatures: signedBy(a, b), deleted: true }), key, EXPIRES - 10).state).toBe("vetoed");
  });

  it("without the timelock flag, quorum means it already ran (mirror may lag)", () => {
    expect(proposalStatus(schedule({ signatures: signedBy(a, b), wait_for_expiry: false }), key, EXPIRES - 100).state).toBe("executing");
  });

  it("evaluates signatures against the CURRENT treasury key (after a rotation old signers no longer count)", () => {
    const rotated = keyFromMirror(mirrorKeyOf(threshold(2, [EC_KEYS[0]!, EC_KEYS[2]!, c])));
    const s = proposalStatus(schedule({ signatures: signedBy(a, b) }), rotated, EXPIRES - 10);
    expect(s).toMatchObject({ state: "collecting-signatures", signed: 0 });
  });

  it("parses mirror timestamps with nanoseconds", () => {
    expect(timestampToSeconds("1800000300.500000000")).toBe(1_800_000_300.5);
  });
});
