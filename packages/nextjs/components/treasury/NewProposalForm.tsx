"use client";

import { useState } from "react";
import { explainWalletError } from "@sh/treasury/errors";
import { isEntityId } from "@sh/treasury/ids";
import { parsePositiveUnits, parseUnits } from "@sh/treasury/units";
import { WALLET_CONNECT_PROJECT_ID, connectWallet } from "~~/services/hedera/walletConnect";

type Kind = "hbar" | "usdc" | "budget";

interface Props {
  treasuryId: string;
  opsAccountId: string | null;
  indexTopicId: string;
  members: { type: "ed25519" | "ecdsa"; publicKey: string }[];
  hbarUsd: number | null;
}

const USDC = { tokenId: "0.0.5449", decimals: 6 };
/** HIP-423: a schedule may expire at most 62 days ahead. */
const MAX_VETO_MINUTES = 62 * 24 * 60;

/** Check the form before the wallet is involved. Throws a message meant for the user. */
function readInput(kind: Kind, to: string, amount: string, minutes: number): { recipient: string; units: bigint } {
  const recipient = to.trim();
  if (kind !== "budget" && !isEntityId(recipient)) throw new Error(`"${to}" is not an account id (expected 0.0.x).`);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_VETO_MINUTES) {
    throw new Error(`The veto window must be a whole number of minutes between 1 and ${MAX_VETO_MINUTES}.`);
  }
  // Zero is only meaningful for a budget: it revokes the ops allowance.
  const units =
    kind === "hbar"
      ? parsePositiveUnits(amount, 8)
      : kind === "usdc"
        ? parsePositiveUnits(amount, USDC.decimals)
        : parseUnits(amount, USDC.decimals);
  return { recipient, units };
}

export function NewProposalForm({ treasuryId, opsAccountId, indexTopicId, members, hbarUsd }: Props) {
  const [kind, setKind] = useState<Kind>("hbar");
  const [to, setTo] = useState("0.0.98");
  const [amount, setAmount] = useState("1");
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState(5);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; scheduleId?: string } | null>(null);

  if (!WALLET_CONNECT_PROJECT_ID) {
    return (
      <div className="alert">
        <span>
          Add <code>NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID</code> to propose from the browser, or use{" "}
          <code>yarn treasury:propose -- --type hbar --to 0.0.98 --amount 1</code>.
        </span>
      </div>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const { recipient, units } = readInput(kind, to, amount, minutes);
      if (kind === "budget" && !opsAccountId) throw new Error("This treasury has no ops account");
      const label = title.trim();

      const sdk = await import("@hiero-ledger/sdk");
      const { hbarPaymentProposal, tokenPaymentProposal, budgetProposal, truncateUtf8 } =
        await import("@sh/treasury/proposals");
      const { encodeIndexMessage } = await import("@sh/treasury/hcs-index");

      const signer = await connectWallet();
      const vetoKey = new sdk.KeyList(
        members.map(m =>
          m.type === "ed25519"
            ? sdk.PublicKey.fromStringED25519(m.publicKey)
            : sdk.PublicKey.fromStringECDSA(m.publicKey),
        ),
        1,
      );
      const common = {
        treasuryId,
        vetoKey,
        executeAt: Math.floor(Date.now() / 1000) + minutes * 60,
        // The network limits the memo in bytes, so cut by bytes (a title in another script is wider than 60 bytes).
        memo: `${truncateUtf8(label || kind, 60)} #${Date.now() % 1e6}`,
      };
      let schedule;
      let usdValue6: bigint | undefined;
      if (kind === "hbar") {
        schedule = hbarPaymentProposal({ ...common, to: recipient, tinybar: units });
        if (hbarUsd) usdValue6 = BigInt(Math.round((Number(units) / 1e8) * hbarUsd * 1e6));
      } else if (kind === "usdc") {
        usdValue6 = units;
        schedule = tokenPaymentProposal({ ...common, to: recipient, tokenId: USDC.tokenId, amount: units });
      } else {
        usdValue6 = units;
        schedule = budgetProposal({ ...common, opsAccountId: opsAccountId!, tokenId: USDC.tokenId, amount: units });
      }

      await schedule.freezeWithSigner(signer as never);
      const response = await schedule.executeWithSigner(signer as never);
      const receipt = await response.getReceiptWithSigner(signer as never);
      const scheduleId = receipt.scheduleId!.toString();

      try {
        const announce = new sdk.TopicMessageSubmitTransaction()
          .setTopicId(sdk.TopicId.fromString(indexTopicId))
          .setMessage(
            encodeIndexMessage({
              scheduleId,
              type: kind === "hbar" ? "hbar-payment" : kind === "usdc" ? "token-payment" : "budget",
              title: label || common.memo,
              usdValue6: usdValue6?.toString(),
              signedVia: "hashpack",
            }),
          );
        await announce.freezeWithSigner(signer as never);
        await announce.executeWithSigner(signer as never);
        setResult({ ok: true, text: `Proposal ${scheduleId} created and announced (1 signature).`, scheduleId });
      } catch (error) {
        // The proposal exists on the ledger; only the index entry is missing. Say so instead of implying nothing happened.
        setResult({
          ok: false,
          text: `Proposal ${scheduleId} was created but not announced on the index (${explainWalletError(error)}). It is valid but will not be listed: share the link.`,
          scheduleId,
        });
      }
    } catch (error) {
      setResult({ ok: false, text: explainWalletError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card bg-base-100 shadow" onSubmit={submit}>
      <div className="card-body gap-3">
        <label className="form-control">
          <span className="label-text">Type</span>
          <select className="select select-bordered" value={kind} onChange={e => setKind(e.target.value as Kind)}>
            <option value="hbar">Pay HBAR</option>
            <option value="usdc">Pay USDC</option>
            <option value="budget">Set the ops USDC budget</option>
          </select>
        </label>
        {kind !== "budget" && (
          <label className="form-control">
            <span className="label-text">Recipient account (0.0.x)</span>
            <input
              className="input input-bordered"
              value={to}
              onChange={e => setTo(e.target.value)}
              required
              pattern="\s*\d+\.\d+\.\d+\s*"
            />
          </label>
        )}
        <label className="form-control">
          <span className="label-text">Amount ({kind === "hbar" ? "HBAR" : "USDC"})</span>
          <input
            className="input input-bordered"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            inputMode="decimal"
            required
          />
        </label>
        <label className="form-control">
          <span className="label-text">Title (published on the HCS index)</span>
          <input
            className="input input-bordered"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={120}
          />
        </label>
        <label className="form-control">
          <span className="label-text">Veto window (minutes)</span>
          <input
            className="input input-bordered"
            type="number"
            min={1}
            max={MAX_VETO_MINUTES}
            value={minutes}
            onChange={e => setMinutes(Number(e.target.value))}
          />
        </label>
        <button className="btn btn-primary" disabled={busy}>
          {busy && <span className="loading loading-spinner" />} Propose with HashPack
        </button>
        {result && (
          <div className={`alert ${result.ok ? "alert-success" : "alert-error"} text-sm`}>
            {result.text}
            {result.scheduleId && (
              <a className="link" href={`/proposals/${result.scheduleId}`}>
                Open
              </a>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
