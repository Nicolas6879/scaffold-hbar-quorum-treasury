import { describe, expect, it, vi } from "vitest";
import { explain, isRetryable, statusOf, withRetry } from "../src/errors";
import { FetchLike, MirrorClient, MirrorHttpError } from "../src/mirror";

describe("status codes", () => {
  it.each([
    ["NO_NEW_VALID_SIGNATURES", false],
    ["SCHEDULE_ALREADY_EXECUTED", false],
    ["IDENTICAL_SCHEDULE_ALREADY_CREATED", false],
    ["INVALID_SCHEDULE_ID", false],
    ["SCHEDULE_EXPIRATION_TIME_TOO_FAR_IN_FUTURE", false],
    ["INSUFFICIENT_PAYER_BALANCE", false],
    ["SPENDER_DOES_NOT_HAVE_ALLOWANCE", false],
    ["AMOUNT_EXCEEDS_ALLOWANCE", false],
    ["SCHEDULE_EXPIRY_IS_BUSY", true],
    ["BUSY", true],
  ])("maps %s (retryable=%s)", (code, retryable) => {
    const error = new Error(`receipt for transaction 0.0.5@1.2 contained error status ${code}`);
    expect(statusOf(error)).toBe(code);
    expect(isRetryable(error)).toBe(retryable);
    expect(explain(error)).toContain(code);
  });

  it("does not confuse BUSY with SCHEDULE_EXPIRY_IS_BUSY", () => {
    expect(statusOf("SCHEDULE_EXPIRY_IS_BUSY")).toBe("SCHEDULE_EXPIRY_IS_BUSY");
  });

  it("passes unknown errors through", () => {
    expect(statusOf(new Error("boom"))).toBeNull();
    expect(explain(new Error("boom"))).toBe("boom");
  });

  it("retries transient failures with backoff and stops on permanent ones", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const result = await withRetry(
      async () => {
        if (++calls < 3) throw new Error("BUSY");
        return "ok";
      },
      { sleep, random: () => 0.5 },
    );
    expect(result).toBe("ok");
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);

    await expect(withRetry(async () => Promise.reject(new Error("AMOUNT_EXCEEDS_ALLOWANCE")), { sleep })).rejects.toThrow(
      "AMOUNT_EXCEEDS_ALLOWANCE",
    );
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget", async () => {
    const sleep = vi.fn(async () => {});
    await expect(withRetry(async () => Promise.reject(new Error("BUSY")), { retries: 2, sleep })).rejects.toThrow("BUSY");
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

function fakeFetch(routes: Record<string, unknown | ((n: number) => { status: number; body?: unknown })>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const counts: Record<string, number> = {};
  const fn = (async (url: string) => {
    calls.push(url);
    const path = url.replace("https://mirror.test", "");
    const route = routes[path];
    counts[path] = (counts[path] ?? 0) + 1;
    if (route === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof route === "function") {
      const r = (route as (n: number) => { status: number; body?: unknown })(counts[path]!);
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    }
    return { ok: true, status: 200, json: async () => route };
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const fast = { retries: 3, baseDelayMs: 0 };

describe("mirror client", () => {
  it("follows pagination links", async () => {
    const fetch = fakeFetch({
      "/api/v1/schedules?account.id=0.0.10&order=desc&limit=100": { schedules: [{ schedule_id: "0.0.1" }], links: { next: "/api/v1/schedules?page=2" } },
      "/api/v1/schedules?page=2": { schedules: [{ schedule_id: "0.0.2" }], links: { next: null } },
    });
    const ids = (await new MirrorClient("https://mirror.test", fetch, fast).listSchedulesByCreator("0.0.10")).map(s => s.schedule_id);
    expect(ids).toEqual(["0.0.1", "0.0.2"]);
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    const fetch = fakeFetch({
      "/api/v1/schedules/0.0.7": (n: number) => (n < 3 ? { status: n === 1 ? 429 : 503 } : { status: 200, body: { schedule_id: "0.0.7" } }),
    });
    await expect(new MirrorClient("https://mirror.test", fetch, fast).getSchedule("0.0.7")).resolves.toMatchObject({ schedule_id: "0.0.7" });
    expect(fetch.calls).toHaveLength(3);
  });

  it("does not retry a 404", async () => {
    const fetch = fakeFetch({});
    await expect(new MirrorClient("https://mirror.test", fetch, fast).getSchedule("0.0.404")).rejects.toBeInstanceOf(MirrorHttpError);
    expect(fetch.calls).toHaveLength(1);
  });

  it("reads the remaining token allowance of the ops account", async () => {
    const fetch = fakeFetch({
      "/api/v1/accounts/0.0.500/allowances/tokens?spender.id=0.0.501&token.id=0.0.5449": {
        allowances: [{ owner: "0.0.500", spender: "0.0.501", token_id: "0.0.5449", amount: 250, amount_granted: 1000 }],
      },
    });
    const allowance = await new MirrorClient("https://mirror.test", fetch, fast).getTokenAllowance("0.0.500", "0.0.501", "0.0.5449");
    expect(allowance).toMatchObject({ amount: 250, amount_granted: 1000 });
  });

  it("returns null when no allowance exists", async () => {
    const fetch = fakeFetch({ "/api/v1/accounts/0.0.500/allowances/tokens?spender.id=0.0.501&token.id=0.0.5449": { allowances: [] } });
    await expect(new MirrorClient("https://mirror.test", fetch, fast).getTokenAllowance("0.0.500", "0.0.501", "0.0.5449")).resolves.toBeNull();
  });

  it("finds the scheduled child transaction and its result", async () => {
    const fetch = fakeFetch({
      "/api/v1/transactions?timestamp=1800000301.1": {
        transactions: [
          { transaction_id: "a", scheduled: false, result: "SUCCESS", name: "SCHEDULESIGN", consensus_timestamp: "1" },
          { transaction_id: "b", scheduled: true, result: "CONTRACT_REVERT_EXECUTED", name: "CONTRACTCALL", consensus_timestamp: "1" },
        ],
      },
    });
    const tx = await new MirrorClient("https://mirror.test", fetch, fast).getScheduledTransaction("1800000301.1");
    expect(tx?.result).toBe("CONTRACT_REVERT_EXECUTED");
  });

  it("waits for the mirror to catch up, or fails clearly", async () => {
    const client = new MirrorClient("https://mirror.test", fakeFetch({}), fast);
    let n = 0;
    const value = await client.waitFor(async () => ++n, v => v >= 3, { sleep: async () => {} });
    expect(value).toBe(3);
    await expect(client.waitFor(async () => 0, v => v > 0, { attempts: 2, sleep: async () => {} })).rejects.toThrow(/did not reflect/);
  });
});
