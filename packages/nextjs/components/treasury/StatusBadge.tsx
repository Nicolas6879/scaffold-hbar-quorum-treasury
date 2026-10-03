import type { ProposalStatus } from "@sh/treasury";

const LABELS: Record<ProposalStatus["state"], { text: string; className: string }> = {
  "collecting-signatures": { text: "Collecting signatures", className: "badge-warning" },
  timelocked: { text: "Approved · veto window open", className: "badge-info" },
  executing: { text: "Executing", className: "badge-info" },
  executed: { text: "Executed", className: "badge-success" },
  failed: { text: "Executed · inner tx failed", className: "badge-error" },
  vetoed: { text: "Vetoed", className: "badge-neutral" },
  expired: { text: "Expired", className: "badge-ghost" },
};

export function StatusBadge({ status }: { status: ProposalStatus }) {
  const label = LABELS[status.state];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`badge ${label.className}`}>{label.text}</span>
      {status.required > 0 && (
        <span className="text-sm opacity-70">
          {status.signed} of {status.required} signatures
        </span>
      )}
      {status.secondsLeft !== null && status.secondsLeft > 0 && (
        <span className="text-sm opacity-70">· {formatDuration(status.secondsLeft)} left</span>
      )}
      {status.innerResult && status.innerResult !== "SUCCESS" && (
        <code className="text-xs text-error">{status.innerResult}</code>
      )}
    </div>
  );
}

export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} days`;
}
