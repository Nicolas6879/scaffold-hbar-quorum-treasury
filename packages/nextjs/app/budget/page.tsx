import { loadTreasury } from "~~/utils/treasury/server";

export const dynamic = "force-dynamic";

export default async function BudgetPage() {
  const t = await loadTreasury();
  const a = t.opsAllowance;
  const spent = a ? a.granted - a.remaining : 0;
  const pct = a && a.granted > 0 ? Math.round((spent / a.granted) * 100) : 0;

  return (
    <div className="flex flex-col gap-6 px-4 py-8 max-w-3xl mx-auto w-full">
      <h1 className="text-3xl font-bold">Ops budget</h1>
      <p className="opacity-80">
        The quorum approves a USDC allowance (HIP-336) from the treasury to the ops account. Any single signer can spend
        it, but the <strong>network</strong> rejects anything beyond the remaining amount (
        <code>AMOUNT_EXCEEDS_ALLOWANCE</code>). The allowance does not reset by itself: topping it up is another quorum
        proposal.
      </p>
      {t.error && <div className="alert alert-warning">{t.error}</div>}
      {!a && !t.error && (
        <p className="opacity-70">
          No budget approved yet. Propose one: <code>yarn treasury:propose -- --type budget --amount 10</code>
        </p>
      )}
      {a && (
        <div className="card bg-base-100 shadow">
          <div className="card-body gap-3">
            <div className="flex justify-between">
              <span>Remaining</span>
              <strong>{(a.remaining / 1e6).toFixed(2)} USDC</strong>
            </div>
            <progress className="progress progress-primary" value={pct} max={100} />
            <div className="flex justify-between text-sm opacity-70">
              <span>Spent {(spent / 1e6).toFixed(2)} USDC</span>
              <span>Approved {(a.granted / 1e6).toFixed(2)} USDC</span>
            </div>
            <span className="text-xs opacity-60">
              Ops account {t.deployment.opsAccountId} · treasury {t.deployment.treasuryId}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
