import { proto } from "@hiero-ledger/proto";
import { decodeFunctionData } from "viem";
import { bytesToHex, decodeKeyProto, KeyNode } from "./keys";
import { swapGuardAbi } from "./swap-guard-abi";

/**
 * Turn a schedule's `transaction_body` (base64 `SchedulableTransactionBody` from the mirror node)
 * into something a human can check before signing. HashPack shows a ScheduleSign without the
 * inner transaction, so this is the signer's only defence against approving the wrong thing.
 */

export type DecodedProposal =
  | { kind: "transfer"; hbar: Transfer[]; tokens: TokenTransfer[]; memo: string }
  | {
      kind: "contract-call";
      contractId: string;
      gas: bigint;
      payableTinybar: bigint;
      call: GuardCall | { function: "unknown"; selector: string };
      memo: string;
    }
  | { kind: "allowance"; hbar: HbarAllowance[]; tokens: TokenAllowance[]; memo: string }
  | { kind: "key-rotation"; accountId: string; newKey: KeyNode | null; memo: string }
  | { kind: "topic-message"; topicId: string; message: string; memo: string }
  | { kind: "unknown"; field: string; memo: string };

export interface Transfer {
  accountId: string;
  /** Tinybar (HBAR) or token units; negative = debit. */
  amount: bigint;
  isApproval: boolean;
}
export interface TokenTransfer {
  tokenId: string;
  transfers: Transfer[];
}
export interface HbarAllowance {
  owner: string;
  spender: string;
  tinybar: bigint;
}
export interface TokenAllowance {
  tokenId: string;
  owner: string;
  spender: string;
  amount: bigint;
}
export interface GuardCall {
  function: "swapHbarForStable";
  slippageBps: number;
  deadline: bigint;
}

type LongLike = { toString(): string } | number | string | null | undefined;
type EntityLike = { shardNum?: LongLike; realmNum?: LongLike; accountNum?: LongLike; tokenNum?: LongLike; contractNum?: LongLike; topicNum?: LongLike } | null | undefined;

const big = (v: LongLike): bigint => (v === null || v === undefined ? 0n : BigInt(v.toString()));
const entity = (e: EntityLike, num: LongLike): string => `${big(e?.shardNum)}.${big(e?.realmNum)}.${big(num)}`;
const accountId = (e: EntityLike) => entity(e, e?.accountNum);

/** Never throws: a body that is not valid base64/protobuf is reported as unknown, not summarised. */
export function decodeScheduleBody(base64Body: string): DecodedProposal {
  try {
    const bytes = Uint8Array.from(atob(base64Body), c => c.charCodeAt(0));
    return decodeSchedulableBody(proto.SchedulableTransactionBody.decode(bytes));
  } catch {
    return { kind: "unknown", field: "undecodable", memo: "" };
  }
}

export function decodeSchedulableBody(body: proto.ISchedulableTransactionBody): DecodedProposal {
  const memo = body.memo ?? "";
  if (body.cryptoTransfer) {
    const ct = body.cryptoTransfer;
    return {
      kind: "transfer",
      memo,
      hbar: (ct.transfers?.accountAmounts ?? []).map(t => ({
        accountId: accountId(t.accountID),
        amount: big(t.amount),
        isApproval: Boolean(t.isApproval),
      })),
      tokens: (ct.tokenTransfers ?? []).map(tt => ({
        tokenId: entity(tt.token, tt.token?.tokenNum),
        transfers: (tt.transfers ?? []).map(t => ({
          accountId: accountId(t.accountID),
          amount: big(t.amount),
          isApproval: Boolean(t.isApproval),
        })),
      })),
    };
  }
  if (body.contractCall) {
    const cc = body.contractCall;
    const data = cc.functionParameters ?? new Uint8Array();
    return {
      kind: "contract-call",
      memo,
      contractId: entity(cc.contractID, cc.contractID?.contractNum),
      gas: big(cc.gas),
      payableTinybar: big(cc.amount),
      call: decodeGuardCall(data),
    };
  }
  if (body.cryptoApproveAllowance) {
    const a = body.cryptoApproveAllowance;
    return {
      kind: "allowance",
      memo,
      hbar: (a.cryptoAllowances ?? []).map(x => ({ owner: accountId(x.owner), spender: accountId(x.spender), tinybar: big(x.amount) })),
      tokens: (a.tokenAllowances ?? []).map(x => ({
        tokenId: entity(x.tokenId, x.tokenId?.tokenNum),
        owner: accountId(x.owner),
        spender: accountId(x.spender),
        amount: big(x.amount),
      })),
    };
  }
  if (body.cryptoUpdateAccount) {
    const u = body.cryptoUpdateAccount;
    return {
      kind: "key-rotation",
      memo,
      accountId: accountId(u.accountIDToUpdate),
      newKey: u.key ? decodeKeyProto(proto.Key.encode(u.key).finish()) : null,
    };
  }
  if (body.consensusSubmitMessage) {
    const m = body.consensusSubmitMessage;
    return {
      kind: "topic-message",
      memo,
      topicId: entity(m.topicID, m.topicID?.topicNum),
      message: new TextDecoder().decode(m.message ?? new Uint8Array()),
    };
  }
  const field = Object.keys(body).find(k => k !== "memo" && k !== "transactionFee") ?? "empty";
  return { kind: "unknown", field, memo };
}

function decodeGuardCall(data: Uint8Array): GuardCall | { function: "unknown"; selector: string } {
  const hex = `0x${bytesToHex(data)}` as const;
  try {
    const decoded = decodeFunctionData({ abi: swapGuardAbi, data: hex });
    if (decoded.functionName === "swapHbarForStable") {
      const [slippageBps, deadline] = decoded.args;
      return { function: "swapHbarForStable", slippageBps: Number(slippageBps), deadline };
    }
  } catch {
    // fall through: not a SwapGuard call
  }
  return { function: "unknown", selector: hex.slice(0, 10) };
}

/** One-line human summary used in the proposal list and the HCS index. */
export function describeProposal(p: DecodedProposal, fmt: { hbar: (tinybar: bigint) => string } = { hbar: t => `${Number(t) / 1e8} HBAR` }): string {
  switch (p.kind) {
    case "transfer": {
      const credits = p.hbar.filter(t => t.amount > 0n).map(t => `${fmt.hbar(t.amount)} → ${t.accountId}`);
      const tokens = p.tokens.flatMap(tt => tt.transfers.filter(t => t.amount > 0n).map(t => `${t.amount} of ${tt.tokenId} → ${t.accountId}`));
      return `Pay ${[...credits, ...tokens].join(", ") || "(no credits)"}`;
    }
    case "contract-call":
      return p.call.function === "swapHbarForStable"
        ? `Swap ${fmt.hbar(p.payableTinybar)} for USDC through SwapGuard ${p.contractId} (max slippage ${p.call.slippageBps / 100}%)`
        : `Call contract ${p.contractId} (${p.call.selector}) with ${fmt.hbar(p.payableTinybar)}`;
    case "allowance":
      return `Set budget: ${[
        ...p.tokens.map(a => `${a.amount} of ${a.tokenId} for ${a.spender}`),
        ...p.hbar.map(a => `${fmt.hbar(a.tinybar)} for ${a.spender}`),
      ].join(", ")}`;
    case "key-rotation":
      return `Rotate the signers of ${p.accountId}`;
    case "topic-message":
      return `Post a message to topic ${p.topicId}`;
    default:
      return `Unrecognised proposal (${p.field}) — do not sign unless you know what it is`;
  }
}
