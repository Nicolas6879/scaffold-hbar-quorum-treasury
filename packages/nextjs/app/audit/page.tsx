import { loadTreasury } from "~~/utils/treasury/server";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const t = await loadTreasury();
  const topic = t.deployment.indexTopicId;
  return (
    <div className="flex flex-col gap-6 px-4 py-8 max-w-5xl mx-auto w-full">
      <h1 className="text-3xl font-bold">Proposal index (HCS)</h1>
      <p className="opacity-80 max-w-3xl">
        The mirror node can only list schedules by creator, so every proposal made with this template is announced on an
        HCS topic whose submit key is any one signer. Each entry carries the intent (title, invoice hash) and the
        Chainlink round used to value it. Below, the index is reconciled with the ledger; mismatches are flagged, not
        hidden. Proposals created outside the template do not appear here — that is a limitation, not a guarantee.
      </p>
      {topic && (
        <a
          className="link link-primary"
          href={`https://hashscan.io/testnet/topic/${topic}`}
          target="_blank"
          rel="noreferrer"
        >
          Topic {topic} on HashScan
        </a>
      )}
      {t.error && <div className="alert alert-warning">{t.error}</div>}
      {t.indexErrors > 0 && (
        <div className="alert">Ignored {t.indexErrors} message(s) that are not valid index entries.</div>
      )}
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Announced</th>
              <th>Schedule</th>
              <th>Title</th>
              <th>USD at proposal</th>
              <th>Ledger check</th>
            </tr>
          </thead>
          <tbody>
            {t.proposals.map(p => (
              <tr key={`${p.scheduleId}-${p.announcedAt}`}>
                <td className="text-xs">
                  {new Date(Number(p.announcedAt.split(".")[0]) * 1000).toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td className="font-mono text-xs">{p.scheduleId}</td>
                <td>{p.title}</td>
                <td>{p.usdValue6 ? `$${(Number(p.usdValue6) / 1e6).toFixed(2)}` : "—"}</td>
                <td className={p.flag === "ok" ? "text-success" : "text-warning"}>{p.flag}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
