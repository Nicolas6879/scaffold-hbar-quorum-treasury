import { memberKeys } from "@sh/treasury";
import { NewProposalForm } from "~~/components/treasury/NewProposalForm";
import { loadTreasury } from "~~/utils/treasury/server";

export const dynamic = "force-dynamic";

export default async function NewProposalPage() {
  const t = await loadTreasury();
  const members =
    t.treasuryKey?.type === "threshold"
      ? t.treasuryKey.keys.flatMap(k =>
          k.type === "ed25519" || k.type === "ecdsa" ? [{ type: k.type, publicKey: k.publicKey }] : [],
        )
      : [];
  return (
    <div className="flex flex-col gap-6 px-4 py-8 max-w-3xl mx-auto w-full">
      <h1 className="text-3xl font-bold">New proposal</h1>
      <p className="opacity-80">
        You propose with your HashPack account, which must be one of the treasury signers. Your signature on the
        proposal counts as the first approval; a second signer approves on the proposal page; then the veto window runs
        before execution.
      </p>
      {t.error && <div className="alert alert-warning">{t.error}</div>}
      {t.deployment.treasuryId && t.deployment.indexTopicId && members.length > 0 ? (
        <NewProposalForm
          treasuryId={t.deployment.treasuryId}
          opsAccountId={t.deployment.opsAccountId ?? null}
          indexTopicId={t.deployment.indexTopicId}
          members={members}
          hbarUsd={t.hbarUsd}
          memberCount={memberKeys(t.treasuryKey!).length}
        />
      ) : (
        !t.error && <p className="opacity-70">Configure a treasury first (yarn treasury:setup).</p>
      )}
    </div>
  );
}
