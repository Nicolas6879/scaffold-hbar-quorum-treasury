import { KeyList } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { decodeScheduleBody, describeProposal } from "../src/decode";
import { explainWalletError, isRetryable } from "../src/errors";
import { parseIndexMessage } from "../src/hcs-index";
import { FetchLike, MirrorClient } from "../src/mirror";
import {
  budgetProposal,
  hbarPaymentProposal,
  ProposalValidationError,
  tokenPaymentProposal,
  truncateUtf8,
} from "../src/proposals";
import { parsePositiveUnits } from "../src/units";
import { ED_KEYS } from "./helpers";

const NOW = 1_800_000_000;
const common = {
  treasuryId: "0.0.500",
  vetoKey: new KeyList(ED_KEYS.map(k => k.publicKey), 1),
  executeAt: NOW + 300,
  memo: "invoice 42",
  nowSec: NOW,
};

describe("mirror client resilience", () => {
  it("aborts a request that hangs and retries it, then gives up with the timeout error", async () => {
    let attempts = 0;
    const hanging: FetchLike = (_url, init) => {
      attempts++;
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason)));
    };
    const client = new MirrorClient("https://mirror.test", hanging, { retries: 2, baseDelayMs: 0 }, 20);
    await expect(client.getAccount("0.0.1")).rejects.toHaveProperty("name", "TimeoutError");
    expect(attempts).toBe(3);
  });

  it("retries a dropped connection but not a programming error", () => {
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryable(new TypeError("x is not a function"))).toBe(false);
  });

  it("can read the newest topic messages first, in pages of at most 100", async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async url => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ messages: [], links: { next: null } }) };
    };
    await new MirrorClient("https://mirror.test", fetch).listTopicMessages("0.0.9", 200, "desc");
    expect(urls).toEqual(["https://mirror.test/api/v1/topics/0.0.9/messages?order=desc&limit=100"]);
  });

  it("treats an allowance response without a list as no allowance", async () => {
    const fetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await expect(new MirrorClient("https://mirror.test", fetch).getTokenAllowance("0.0.1", "0.0.2", "0.0.3")).resolves.toBeNull();
  });
});

describe("undecodable schedule bodies", () => {
  it.each(["not base64 !!", "", Buffer.from([0xff, 0xff, 0xff]).toString("base64")])("are shown as unknown, not thrown: %j", body => {
    const decoded = decodeScheduleBody(body);
    expect(decoded.kind).toBe("unknown");
    expect(describeProposal(decoded)).toMatch(/do not sign/);
  });
});

describe("index messages with wrong field types", () => {
  const raw = (data: unknown) => ({
    consensus_timestamp: "1800000000.1",
    message: Buffer.from(JSON.stringify(data)).toString("base64"),
    payer_account_id: "0.0.10",
    sequence_number: 1,
  });
  const base = { v: "quorum-treasury/v1", scheduleId: "0.0.900", type: "budget", title: "Budget" };

  it.each([
    [{ ...base, scheduleId: 900 }, /scheduleId/],
    [{ ...base, usdValue6: 5 }, /integer/],
    [{ ...base, signedVia: "carrier-pigeon" }, /signedVia/],
    [{ ...base, invoiceHash: 7 }, /sha256/],
  ])("are reported, not trusted %#", (data, reason) => {
    expect(parseIndexMessage(raw(data))).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  it("reports a message that is not base64", () => {
    expect(parseIndexMessage({ ...raw(base), message: "%%%" })).toMatchObject({ ok: false });
  });
});

describe("proposal input limits", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, NOW + 300.5])("rejects a non-integer execution time (%s)", executeAt => {
    expect(() => hbarPaymentProposal({ ...common, executeAt, to: "0.0.7", tinybar: 1n })).toThrow(ProposalValidationError);
  });

  it("refuses token amounts a JS number cannot hold exactly", () => {
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => tokenPaymentProposal({ ...common, to: "0.0.7", tokenId: "0.0.5449", amount: tooBig })).toThrow(/too large/);
    expect(() => budgetProposal({ ...common, opsAccountId: "0.0.501", tokenId: "0.0.5449", amount: tooBig })).toThrow(/too large/);
  });

  it("cuts memos by bytes without splitting a character", () => {
    expect(truncateUtf8("abcdef", 4)).toBe("abcd");
    expect(truncateUtf8("ééé", 5)).toBe("éé");
    expect(new TextEncoder().encode(truncateUtf8("🙂".repeat(40), 60)).length).toBeLessThanOrEqual(60);
  });

  it("parsePositiveUnits rejects zero but keeps exact decimals", () => {
    expect(parsePositiveUnits("0.5", 6)).toBe(500_000n);
    expect(() => parsePositiveUnits("0", 6)).toThrow(/greater than zero/);
    expect(() => parsePositiveUnits("0.000000001", 8)).toThrow(/decimal places/);
  });
});

describe("wallet error messages", () => {
  it.each([
    [{ code: 5000, message: "User rejected." }, /rejected the request/],
    [new Error("User closed modal"), /rejected the request/],
    [new Error("No matching key. session topic doesn't exist: abc"), /session expired/],
    [new Error("Session expired"), /session expired/],
    [new Error("Unsupported chain hedera:mainnet"), /different network/],
    [new Error("receipt contained error status NO_NEW_VALID_SIGNATURES"), /already signed/],
    [new Error("boom"), /^boom$/],
  ])("explains %#", (error, expected) => {
    expect(explainWalletError(error)).toMatch(expected);
  });
});
