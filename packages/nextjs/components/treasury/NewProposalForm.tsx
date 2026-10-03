"use client";

import { useState } from "react";
import { explain } from "@sh/treasury/errors";
import { WALLET_CONNECT_PROJECT_ID, connectWallet } from "~~/services/hedera/walletConnect";

type Kind = "hbar" | "usdc" | "budget";

interface Props {
  treasuryId: string;
  opsAccountId: string | null;
  indexTopicId: string;
  members: { type: "ed25519" | "ecdsa"; publicKey: string }[];
  hbarUsd: number | null;
  memberCount: number;
}

const USDC = { tokenId: "0.0.5449", decimals: 6 };

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
      const sdk = await import("@hiero-ledger/sdk");
      const { hbarPaymentProposal, tokenPaymentProposal, budgetProposal } = await import("@sh/treasury/proposals");
      const { encodeIndexMessage } = await import("@sh/treasury/hcs-index");
      const { parseUnits } = await import("@sh/treasury/units");

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
        memo: `${(title || kind).slice(0, 60)} #${Date.now() % 1e6}`,
      };
      let schedule;
      let usdValue6: bigint | undefined;
      if (kind === "hbar") {
        const tinybar = parseUnits(amount, 8);
        schedule = hbarPaymentProposal({ ...common, to, tinybar });
        if (hbarUsd) usdValue6 = BigInt(Math.round((Number(tinybar) / 1e8) * hbarUsd * 1e6));
      } else if (kind === "usdc") {
        usdValue6 = parseUnits(amount, USDC.decimals);
        schedule = tokenPaymentProposal({ ...common, to, tokenId: USDC.tokenId, amount: usdValue6 });
      } else {
        if (!opsAccountId) throw new Error("This treasury has no ops account");
        usdValue6 = parseUnits(amount, USDC.decimals);
        schedule = budgetProposal({ ...common, opsAccountId, tokenId: USDC.tokenId, amount: usdValue6 });
      }

      await schedule.freezeWithSigner(signer as never);
      const response = await schedule.executeWithSigner(signer as never);
      const receipt = await response.getReceiptWithSigner(signer as never);
      const scheduleId = receipt.scheduleId!.toString();

      const announce = new sdk.TopicMessageSubmitTransaction()
        .setTopicId(sdk.TopicId.fromString(indexTopicId))
        .setMessage(
          encodeIndexMessage({
            scheduleId,
            type: kind === "hbar" ? "hbar-payment" : kind === "usdc" ? "token-payment" : "budget",
            title: title || common.memo,
            usdValue6: usdValue6?.toString(),
            signedVia: "hashpack",
          }),
        );
      await announce.freezeWithSigner(signer as never);
      await announce.executeWithSigner(signer as never);
      setResult({ ok: true, text: `Proposal ${scheduleId} created and announced (1 signature).`, scheduleId });
    } catch (error) {
      setResult({ ok: false, text: explain(error) });
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
              pattern="\d+\.\d+\.\d+"
            />
          </label>
        )}
        <label className="form-control">
          <span className="label-text">Amount ({kind === "hbar" ? "HBAR" : "USDC"})</span>
          <input className="input input-bordered" value={amount} onChange={e => setAmount(e.target.value)} required />
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
            max={89280}
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
