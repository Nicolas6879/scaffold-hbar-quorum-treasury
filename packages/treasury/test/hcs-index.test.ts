import { describe, expect, it } from "vitest";
import { encodeIndexMessage, INDEX_VERSION, parseIndexMessage, reconcile } from "../src/hcs-index";
import type { MirrorTopicMessage } from "../src/mirror";
import { schedule } from "./helpers";

const raw = (json: string, sequence = 1): MirrorTopicMessage => ({
  consensus_timestamp: `1800000000.${sequence}`,
  message: Buffer.from(json).toString("base64"),
  payer_account_id: "0.0.10",
  sequence_number: sequence,
});

const entry = { scheduleId: "0.0.900", type: "hbar-payment" as const, title: "Pay the auditor", usdValue6: "1500000000" };

describe("HCS proposal index", () => {
  it("encodes a versioned message and parses it back", () => {
    const parsed = parseIndexMessage(raw(encodeIndexMessage(entry)));
    expect(parsed).toMatchObject({ ok: true, entry: { v: INDEX_VERSION, ...entry } });
  });

  it.each([
    [{ ...entry, scheduleId: "900" }, /scheduleId/],
    [{ ...entry, type: "steal" }, /unknown type/],
    [{ ...entry, title: " " }, /title/],
    [{ ...entry, invoiceHash: "abc" }, /sha256/],
    [{ ...entry, usdValue6: "1.5" }, /integer/],
  ])("refuses to publish an invalid entry %#", (bad, error) => {
    expect(() => encodeIndexMessage(bad as never)).toThrow(error);
  });

  it("refuses entries larger than one HCS chunk", () => {
    expect(() => encodeIndexMessage({ ...entry, description: "x".repeat(1100) })).toThrow(/too large/);
  });

  it("reports (does not throw on) foreign, corrupt or future-version messages", () => {
    expect(parseIndexMessage(raw("not json"))).toMatchObject({ ok: false, reason: "not JSON" });
    expect(parseIndexMessage(raw("42"))).toMatchObject({ ok: false, reason: "not an object" });
    expect(parseIndexMessage(raw(JSON.stringify({ ...entry, v: "quorum-treasury/v9" })))).toMatchObject({ ok: false, reason: /unknown version/ });
  });

  it("reconciles the index with the ledger and flags every mismatch", () => {
    const messages = [
      parseIndexMessage(raw(encodeIndexMessage(entry), 1)),
      parseIndexMessage(raw(encodeIndexMessage({ ...entry, scheduleId: "0.0.901" }), 2)),
      parseIndexMessage(raw(encodeIndexMessage({ ...entry, scheduleId: "0.0.902" }), 3)),
      parseIndexMessage(raw(encodeIndexMessage(entry), 4)),
      parseIndexMessage(raw("garbage", 5)),
    ];
    const ledger = new Map([
      ["0.0.900", schedule({ schedule_id: "0.0.900", payer_account_id: "0.0.500" })],
      ["0.0.902", schedule({ schedule_id: "0.0.902", payer_account_id: "0.0.666" })],
    ]);
    const flags = reconcile(messages, ledger, "0.0.500").map(r => [r.entry.scheduleId, r.flag]);
    expect(flags).toEqual([
      ["0.0.900", "ok"],
      ["0.0.901", "missing-on-ledger"],
      ["0.0.902", "wrong-payer"],
      ["0.0.900", "duplicate-announcement"],
    ]);
  });
});
