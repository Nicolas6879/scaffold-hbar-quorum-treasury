"use client";

import { useState } from "react";
import { explain } from "@sh/treasury/errors";
import { WALLET_CONNECT_PROJECT_ID, connectWallet } from "~~/services/hedera/walletConnect";

/**
 * Sign or veto with HashPack. Each signer submits their OWN ScheduleSign/ScheduleDelete; we never
 * collect signature bytes to combine them (hedera-wallet-connect #694 makes that unreliable).
 */
export function ProposalActions({
  scheduleId,
  canSign,
  canVeto,
  summary,
}: {
  scheduleId: string;
  canSign: boolean;
  canVeto: boolean;
  summary: string;
}) {
  const [busy, setBusy] = useState<"sign" | "veto" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (!WALLET_CONNECT_PROJECT_ID) {
    return (
      <div className="alert">
        <span>
          Signing in the browser needs <code>NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID</code>. From a terminal:{" "}
          <code>yarn treasury:sign -- --schedule {scheduleId} --as 3</code>
        </span>
      </div>
    );
  }

  async function run(kind: "sign" | "veto") {
    setBusy(kind);
    setResult(null);
    try {
      const { ScheduleDeleteTransaction, ScheduleId, ScheduleSignTransaction } = await import("@hiero-ledger/sdk");
      const signer = await connectWallet();
      const tx =
        kind === "sign"
          ? new ScheduleSignTransaction().setScheduleId(ScheduleId.fromString(scheduleId))
          : new ScheduleDeleteTransaction().setScheduleId(ScheduleId.fromString(scheduleId));
      await tx.freezeWithSigner(signer as never);
      const response = await tx.executeWithSigner(signer as never);
      setResult({ ok: true, text: `${kind === "sign" ? "Signed" : "Vetoed"} · ${response.transactionId.toString()}` });
    } catch (error) {
      setResult({ ok: false, text: explain(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm opacity-80">
        You are approving: <strong>{summary}</strong>. HashPack shows only “ScheduleSign”, so check this line before you
        sign.
      </p>
      <div className="flex gap-3">
        <button className="btn btn-primary" disabled={!canSign || busy !== null} onClick={() => run("sign")}>
          {busy === "sign" ? <span className="loading loading-spinner" /> : null} Sign with HashPack
        </button>
        <button className="btn btn-outline btn-error" disabled={!canVeto || busy !== null} onClick={() => run("veto")}>
          {busy === "veto" ? <span className="loading loading-spinner" /> : null} Veto
        </button>
      </div>
      {result && <div className={`alert ${result.ok ? "alert-success" : "alert-error"} text-sm`}>{result.text}</div>}
    </div>
  );
}
