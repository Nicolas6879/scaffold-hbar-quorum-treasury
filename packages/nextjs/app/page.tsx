import Link from "next/link";
import { StatusBadge } from "~~/components/treasury/StatusBadge";
import { formatHbar, loadProofs, loadTreasury } from "~~/utils/treasury/server";

export const dynamic = "force-dynamic";

const HASHSCAN = "https://hashscan.io/testnet";

export default async function Home() {
  const [t, proofs] = await Promise.all([loadTreasury(), Promise.resolve(loadProofs())]);
  const { deployment: d } = t;
  const pending = t.proposals.filter(p =>
    ["collecting-signatures", "timelocked", "executing"].includes(p.status.state),
  );

  return (
    <div className="flex flex-col gap-8 px-4 py-8 max-w-5xl mx-auto w-full">
      <section className="flex flex-col gap-3">
        <h1 className="text-4xl font-bold">Quorum Treasury</h1>
        <p className="text-lg opacity-80 max-w-3xl">
          Your startup got a grant. Large payments need <strong>2 of 3 founders</strong> and then wait out a{" "}
          <strong>veto window</strong> before they run; day-to-day spending comes from a{" "}
          <strong>USDC budget the network enforces</strong>; and treasury swaps the template proposes go through a guard
          that demands the <strong>Chainlink price</strong>. No multisig contract: these are Hedera threshold keys and
          scheduled transactions.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link className="btn btn-primary btn-sm" href="/proposals">
            Proposals
          </Link>
          <Link className="btn btn-sm" href="/new">
            New proposal
          </Link>
          <Link className="btn btn-sm" href="/budget">
            Ops budget
          </Link>
          <Link className="btn btn-sm" href="/audit">
            Proposal index (HCS)
          </Link>
        </div>
      </section>

      {t.error && <div className="alert alert-warning">{t.error}</div>}

      {d.treasuryId && (
        <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Stat
            label="Treasury"
            value={d.treasuryId}
            href={`${HASHSCAN}/account/${d.treasuryId}`}
            note="2-of-3 threshold key"
          />
          <Stat
            label="HBAR"
            value={formatHbar(t.hbarTinybar)}
            note={t.hbarUsd ? `≈ $${((t.hbarTinybar / 1e8) * t.hbarUsd).toFixed(2)} at Chainlink` : undefined}
          />
          <Stat label="USDC" value={(t.usdcUnits / 1e6).toFixed(2)} note="testnet USDC 0.0.5449" />
          <Stat
            label="Chainlink HBAR/USD"
            value={t.hbarUsd ? `$${t.hbarUsd.toFixed(5)}` : "unavailable"}
            note={
              t.priceUpdatedAt
                ? `updated ${new Date(t.priceUpdatedAt * 1000).toISOString().slice(11, 16)} UTC`
                : undefined
            }
          />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-2xl font-semibold">Waiting for action ({pending.length})</h2>
        {pending.length === 0 && <p className="opacity-70">Nothing pending.</p>}
        {pending.map(p => (
          <Link
            key={p.scheduleId}
            href={`/proposals/${p.scheduleId}`}
            className="card bg-base-100 shadow hover:shadow-md"
          >
            <div className="card-body py-4">
              <div className="flex justify-between gap-4 flex-wrap">
                <strong>{p.title}</strong>
                <StatusBadge status={p.status} />
              </div>
              <span className="text-sm opacity-70">{p.summary}</span>
            </div>
          </Link>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-2xl font-semibold">Proof on Hedera testnet</h2>
        <p className="text-sm opacity-70">
          Every claim links to HashScan and is re-checked against the public mirror node by{" "}
          <code>yarn verify:proofs</code>.
        </p>
        {proofs.length === 0 && (
          <p className="opacity-70">
            No proofs recorded yet: run <code>yarn treasury:demo -- --step all</code>.
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <tbody>
              {proofs.map(p => (
                <tr key={p.id}>
                  <td className="whitespace-normal">{p.claim}</td>
                  <td className="text-xs opacity-70">{p.signedBy}</td>
                  <td>
                    <a className="link link-primary" href={p.hashscan} target="_blank" rel="noreferrer">
                      HashScan
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, note, href }: { label: string; value: string; note?: string; href?: string }) {
  return (
    <div className="stat bg-base-100 rounded-box shadow">
      <div className="stat-title">{label}</div>
      <div className="stat-value text-xl">
        {href ? (
          <a className="link" href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : (
          value
        )}
      </div>
      {note && <div className="stat-desc">{note}</div>}
    </div>
  );
}
