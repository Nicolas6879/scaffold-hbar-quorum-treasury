import { canSign, canVeto, isEntityId } from "@sh/treasury";
import { ProposalActions } from "~~/components/treasury/ProposalActions";
import { StatusBadge } from "~~/components/treasury/StatusBadge";
import { loadSchedule } from "~~/utils/treasury/server";

export const dynamic = "force-dynamic";

const HASHSCAN = "https://hashscan.io/testnet";

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isEntityId(id)) return <Message text={`"${id}" is not a schedule id (expected 0.0.x).`} />;

  let data: Awaited<ReturnType<typeof loadSchedule>>;
  try {
    data = await loadSchedule(id);
  } catch (error) {
    return (
      <Message text={`Could not load schedule ${id}: ${error instanceof Error ? error.message : String(error)}`} />
    );
  }
  const { schedule, decoded, summary, status, isTreasuryProposal } = data;

  return (
    <div className="flex flex-col gap-6 px-4 py-8 max-w-4xl mx-auto w-full">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">{schedule.memo || `Proposal ${id}`}</h1>
        {status && <StatusBadge status={status} />}
        {!isTreasuryProposal && (
          <div className="alert alert-warning">This schedule is not paid by the configured treasury.</div>
        )}
      </div>

      <div className="card bg-base-100 shadow">
        <div className="card-body gap-2">
          <h2 className="card-title">What executes</h2>
          <p className="text-lg">{summary}</p>
          <pre className="text-xs bg-base-200 p-3 rounded overflow-x-auto">
            {JSON.stringify(decoded, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}
          </pre>
        </div>
      </div>

      <div className="card bg-base-100 shadow">
        <div className="card-body gap-2 text-sm">
          <h2 className="card-title">On the ledger</h2>
          <Row
            k="Schedule"
            v={
              <a className="link" href={`${HASHSCAN}/schedule/${id}`} target="_blank" rel="noreferrer">
                {id}
              </a>
            }
          />
          <Row k="Paid by" v={schedule.payer_account_id} />
          <Row k="Timelock (waitForExpiry)" v={String(schedule.wait_for_expiry)} />
          <Row
            k="Executes / expires at"
            v={
              schedule.expiration_time
                ? new Date(Number(schedule.expiration_time.split(".")[0]) * 1000).toISOString()
                : "—"
            }
          />
          <Row k="Signatures" v={schedule.signatures.length} />
          <Row k="Executed" v={schedule.executed_timestamp ?? "not yet"} />
          <Row k="Deleted (vetoed)" v={String(schedule.deleted)} />
        </div>
      </div>

      {status && (canSign(status.state) || canVeto(status.state)) && (
        <ProposalActions
          scheduleId={id}
          canSign={canSign(status.state)}
          canVeto={canVeto(status.state)}
          summary={summary}
        />
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-base-200 py-1">
      <span className="opacity-70">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}

function Message({ text }: { text: string }) {
  return <div className="alert alert-warning max-w-3xl mx-auto mt-8">{text}</div>;
}
