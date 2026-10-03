import { KeyList } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { decodeScheduleBody, describeProposal } from "../src/decode";
import {
  budgetProposal,
  hbarPaymentProposal,
  ProposalValidationError,
  rotateSignersProposal,
  swapProposal,
  tokenPaymentProposal,
} from "../src/proposals";
import { EC_KEYS, ED_KEYS, rawPublicKey, scheduledBodyBase64 } from "./helpers";

const NOW = 1_800_000_000;
const veto = new KeyList(ED_KEYS.map(k => k.publicKey), 1);
const common = { treasuryId: "0.0.500", vetoKey: veto, executeAt: NOW + 300, memo: "invoice 42", nowSec: NOW };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const innerOf = (scheduleTx: unknown) => (scheduleTx as any)._scheduledTransaction;
const decodeBuilt = (scheduleTx: unknown) => decodeScheduleBody(scheduledBodyBase64(innerOf(scheduleTx)));

describe("proposal builders → mirror body → decoder (round trip)", () => {
  it("HBAR payment", () => {
    const tx = hbarPaymentProposal({ ...common, to: "0.0.777", tinybar: 25_00000000n });
    const p = decodeBuilt(tx);
    expect(p).toMatchObject({ kind: "transfer" });
    expect(p.kind === "transfer" && p.hbar).toEqual([
      { accountId: "0.0.500", amount: -2_500_000_000n, isApproval: false },
      { accountId: "0.0.777", amount: 2_500_000_000n, isApproval: false },
    ]);
    expect(describeProposal(p)).toBe("Pay 25 HBAR → 0.0.777");
  });

  it("USDC payment", () => {
    const p = decodeBuilt(tokenPaymentProposal({ ...common, to: "0.0.777", tokenId: "0.0.5449", amount: 1_000_000n }));
    expect(p.kind === "transfer" && p.tokens[0]).toMatchObject({ tokenId: "0.0.5449" });
    expect(describeProposal(p)).toContain("1000000 of 0.0.5449 → 0.0.777");
  });

  it("guarded swap: decodes the SwapGuard call so signers see slippage and deadline", () => {
    const tx = swapProposal({ ...common, swapGuardId: "0.0.6000", tinybar: 100_00000000n, slippageBps: 50, deadline: NOW + 3600 });
    const p = decodeBuilt(tx);
    expect(p).toMatchObject({
      kind: "contract-call",
      contractId: "0.0.6000",
      payableTinybar: 10_000_000_000n,
      gas: 1_500_000n,
      call: { function: "swapHbarForStable", slippageBps: 50, deadline: BigInt(NOW + 3600) },
    });
    expect(describeProposal(p)).toContain("max slippage 0.5%");
  });

  it("USDC budget for the ops account", () => {
    const p = decodeBuilt(budgetProposal({ ...common, opsAccountId: "0.0.501", tokenId: "0.0.5449", amount: 500_000_000n }));
    expect(p.kind === "allowance" && p.tokens).toEqual([{ tokenId: "0.0.5449", owner: "0.0.500", spender: "0.0.501", amount: 500_000_000n }]);
  });

  it("signer rotation decodes the new threshold key", () => {
    const newKey = new KeyList([ED_KEYS[0]!.publicKey, EC_KEYS[0]!.publicKey, EC_KEYS[1]!.publicKey], 2);
    const p = decodeBuilt(rotateSignersProposal({ ...common, newKey }));
    expect(p).toMatchObject({ kind: "key-rotation", accountId: "0.0.500", newKey: { type: "threshold", threshold: 2 } });
    expect(p.kind === "key-rotation" && p.newKey?.type === "threshold" && p.newKey.keys[1]).toEqual({
      type: "ecdsa",
      publicKey: rawPublicKey(EC_KEYS[0]!),
    });
  });

  it("flags anything it does not recognise instead of describing it as safe", () => {
    expect(describeProposal({ kind: "unknown", field: "tokenWipe", memo: "" })).toMatch(/do not sign/);
  });
});

describe("every proposal is timelocked, vetoable and paid by the treasury", () => {
  it.each([
    ["payment", () => hbarPaymentProposal({ ...common, to: "0.0.777", tinybar: 1n })],
    ["budget", () => budgetProposal({ ...common, opsAccountId: "0.0.501", tokenId: "0.0.5449", amount: 1n })],
  ])("%s", (_, build) => {
    const tx = build();
    expect(tx.waitForExpiry).toBe(true);
    expect(tx.payerAccountId?.toString()).toBe("0.0.500");
    expect(tx.adminKey).toBeDefined();
    expect(tx.expirationTime?.seconds.toNumber()).toBe(NOW + 300);
  });
});

describe("proposal validation", () => {
  it.each([
    ["memo over 100 bytes", { memo: "€".repeat(34) }, /Memo/],
    ["execution in the past", { executeAt: NOW }, /future/],
    ["execution beyond 62 days", { executeAt: NOW + 5_356_801 }, /62 days/],
  ])("rejects %s", (_, override, error) => {
    expect(() => hbarPaymentProposal({ ...common, ...override, to: "0.0.777", tinybar: 1n })).toThrow(error);
  });

  it("accepts the 62-day maximum exactly", () => {
    expect(() => hbarPaymentProposal({ ...common, executeAt: NOW + 5_356_800, to: "0.0.777", tinybar: 1n })).not.toThrow();
  });

  it("rejects zero amounts and paying the treasury itself", () => {
    expect(() => hbarPaymentProposal({ ...common, to: "0.0.777", tinybar: 0n })).toThrow(ProposalValidationError);
    expect(() => tokenPaymentProposal({ ...common, to: "0.0.500", tokenId: "0.0.5449", amount: 1n })).toThrow(/itself/);
  });

  it("rejects a swap whose deadline would expire before the timelock ends", () => {
    expect(() =>
      swapProposal({ ...common, swapGuardId: "0.0.6000", tinybar: 1n, slippageBps: 50, deadline: common.executeAt }),
    ).toThrow(/deadline/);
  });

  it("rejects slippage below the pool fee or above the guard cap", () => {
    for (const slippageBps of [29, 1001]) {
      expect(() => swapProposal({ ...common, swapGuardId: "0.0.6000", tinybar: 1n, slippageBps, deadline: NOW + 9999 })).toThrow(/Slippage/);
    }
  });

  it("rejects a budget for the treasury itself or a negative budget (0 revokes)", () => {
    expect(() => budgetProposal({ ...common, opsAccountId: "0.0.500", tokenId: "0.0.5449", amount: 1n })).toThrow(/differ/);
    expect(() => budgetProposal({ ...common, opsAccountId: "0.0.501", tokenId: "0.0.5449", amount: -1n })).toThrow(/negative/);
    expect(() => budgetProposal({ ...common, opsAccountId: "0.0.501", tokenId: "0.0.5449", amount: 0n })).not.toThrow();
  });
});
