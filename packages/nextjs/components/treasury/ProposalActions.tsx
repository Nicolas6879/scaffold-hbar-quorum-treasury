"use client";

import { useEffect, useState } from "react";
import { KeyNode, TESTNET, base64ToHex, hasSignedWith, memberKeys, shortKey, signerNumber } from "@sh/treasury";
import { explain, explainWalletError } from "@sh/treasury/errors";
import { WALLET_CONNECT_PROJECT_ID, connectWallet, useWallet } from "~~/services/hedera/walletConnect";

/** Raw public key of an account as the mirror node reports it (null for threshold/unknown keys). */
async function fetchAccountKey(accountId: string): Promise<string | null> {
  const res = await fetch(`${TESTNET.mirrorUrl}/api/v1/accounts/${accountId}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Mirror node returned ${res.status} for ${accountId}`);
  const key = ((await res.json()) as { key?: { _type: string; key: string } | null }).key;
  return key && (key._type === "ED25519" || key._type === "ECDSA_SECP256K1") ? key.key.toLowerCase() : null;
}

/** Did this key's signature land on the schedule? The mirror lags a few seconds, so poll briefly. */
async function signatureLanded(scheduleId: string, publicKey: string): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(r => setTimeout(r, attempt === 0 ? 3000 : 2500));
    try {
      const res = await fetch(`${TESTNET.mirrorUrl}/api/v1/schedules/${scheduleId}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const { signatures } = (await res.json()) as { signatures: { public_key_prefix: string }[] };
      if (
        hasSignedWith(
          publicKey,
          signatures.map(s => base64ToHex(s.public_key_prefix)),
        )
      )
        return true;
    } catch {
      // mirror slow or unreachable: keep polling, the transaction itself already succeeded
    }
  }
  return false;
}

/**
 * Sign or veto with HashPack. Each signer submits their OWN ScheduleSign/ScheduleDelete; we never
 * collect signature bytes to combine them (hedera-wallet-connect #694 makes that unreliable).
 */
export function ProposalActions({
  scheduleId,
  canSign,
  canVeto,
  summary,
  treasuryKey,
}: {
  scheduleId: string;
  canSign: boolean;
  canVeto: boolean;
  summary: string;
  treasuryKey: KeyNode | null;
}) {
  const { accountId } = useWallet();
  const [walletKey, setWalletKey] = useState<{ accountId: string; key: string | null; error?: string } | null>(null);
  const [busy, setBusy] = useState<"sign" | "veto" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Once connected, look up the account's key: only a treasury member's signature counts.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    fetchAccountKey(accountId)
      .then(key => !cancelled && setWalletKey({ accountId, key }))
      .catch(e => !cancelled && setWalletKey({ accountId, key: null, error: explain(e) }));
    return () => {
      cancelled = true;
    };
  }, [accountId]);

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

  const lookup = accountId && walletKey?.accountId === accountId ? walletKey : null;
  const number = lookup?.key && treasuryKey ? signerNumber(treasuryKey, lookup.key) : null;
  // Block only when we positively know the account is not a member (unknown key = not a member).
  const notMember = !!lookup && !lookup.error && !!treasuryKey && number === null;
  const memberPrefixes = treasuryKey ? memberKeys(treasuryKey).map(shortKey).join(", ") : "";

  async function run(kind: "sign" | "veto") {
    setBusy(kind);
    setResult(null);
    try {
      const { AccountId, ScheduleDeleteTransaction, ScheduleId, ScheduleSignTransaction } =
        await import("@hiero-ledger/sdk");
      const signer = await connectWallet();
      const tx =
        kind === "sign"
          ? new ScheduleSignTransaction().setScheduleId(ScheduleId.fromString(scheduleId))
          : new ScheduleDeleteTransaction().setScheduleId(ScheduleId.fromString(scheduleId));
      // DAppSigner.populateTransaction only sets the transaction id; freezing also needs a node.
      tx.setNodeAccountIds([AccountId.fromString(`0.0.${3 + Math.floor(Math.random() * 5)}`)]);
      await tx.freezeWithSigner(signer as never);
      const response = await tx.executeWithSigner(signer as never);
      const sent = `${kind === "sign" ? "Signed" : "Vetoed"} · ${response.transactionId.toString()}`;
      setResult({ ok: true, text: sent });
      if (kind === "sign" && lookup?.key) {
        const landed = await signatureLanded(scheduleId, lookup.key);
        setResult({
          ok: landed,
          text: landed
            ? `${sent} · signature for key ${shortKey(lookup.key)} is on the schedule.`
            : `${sent} · not yet visible on the mirror node for key ${shortKey(lookup.key)}. Reload in a few seconds; if it never appears, this key is not a signer.`,
        });
      }
    } catch (error) {
      setResult({ ok: false, text: explainWalletError(error) });
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
      {!accountId && <div className="alert alert-info text-sm">Connect HashPack (top right) to sign.</div>}
      {lookup?.error && (
        <div className="alert alert-warning text-sm">Could not check your signer key: {lookup.error}</div>
      )}
      {notMember && lookup && (
        <div className="alert alert-error text-sm">
          Connected account {accountId} (key {lookup.key ? shortKey(lookup.key) : "unknown"}) is not a signer of this
          treasury. Its signature will not count. Switch HashPack to one of: {memberPrefixes}
        </div>
      )}
      {number !== null && lookup?.key && (
        <div className="alert alert-success text-sm">
          Signing as signer {number} (key {shortKey(lookup.key)})
        </div>
      )}
      <div className="flex gap-3">
        <button
          className="btn btn-primary"
          disabled={!canSign || busy !== null || notMember}
          onClick={() => run("sign")}
        >
          {busy === "sign" ? <span className="loading loading-spinner" /> : null} Sign with HashPack
        </button>
        <button
          className="btn btn-outline btn-error"
          disabled={!canVeto || busy !== null || notMember}
          onClick={() => run("veto")}
        >
          {busy === "veto" ? <span className="loading loading-spinner" /> : null} Veto
        </button>
      </div>
      {result && <div className={`alert ${result.ok ? "alert-success" : "alert-error"} text-sm`}>{result.text}</div>}
    </div>
  );
}
