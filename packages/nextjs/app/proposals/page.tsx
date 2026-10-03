import Link from "next/link";
import { StatusBadge } from "~~/components/treasury/StatusBadge";
import { loadTreasury } from "~~/utils/treasury/server";

export const dynamic = "force-dynamic";

const FLAG_TEXT = {
  ok: null,
  "missing-on-ledger": "Announced on the index but not found on the ledger",
  "wrong-payer": "Not paid by this treasury — ignore",
  "duplicate-announcement": "Duplicate announcement",
} as const;

export default async function ProposalsPage() {
  const t = await loadTreasury();
  return (
    <div className="flex flex-col gap-4 px-4 py-8 max-w-5xl mx-auto w-full">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h1 className="text-3xl font-bold">Proposals</h1>
        <Link className="btn btn-primary btn-sm" href="/new">
          New proposal
        </Link>
      </div>
      {t.error && <div className="alert alert-warning">{t.error}</div>}
      {t.proposals.length === 0 && !t.error && <p className="opacity-70">No proposals announced on the index yet.</p>}
      {t.proposals.map(p => (
        <Link
          key={`${p.scheduleId}-${p.announcedAt}`}
          href={`/proposals/${p.scheduleId}`}
          className="card bg-base-100 shadow hover:shadow-md"
        >
          <div className="card-body py-4 gap-1">
            <div className="flex justify-between gap-4 flex-wrap">
              <strong>{p.title}</strong>
              <StatusBadge status={p.status} />
            </div>
            <span className="text-sm opacity-80">{p.summary}</span>
            <span className="text-xs opacity-60">
              {p.scheduleId}
              {p.usdValue6 ? ` · $${(Number(p.usdValue6) / 1e6).toFixed(2)} at proposal time` : ""}
              {p.signedVia ? ` · proposed via ${p.signedVia}` : ""}
            </span>
            {FLAG_TEXT[p.flag] && <span className="text-xs text-warning">{FLAG_TEXT[p.flag]}</span>}
          </div>
        </Link>
      ))}
    </div>
  );
}
