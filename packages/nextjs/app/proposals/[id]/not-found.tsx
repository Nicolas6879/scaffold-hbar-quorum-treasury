import Link from "next/link";

export default function ProposalNotFound() {
  return (
    <div className="alert alert-warning max-w-3xl mx-auto mt-8 flex-col items-start gap-2">
      <strong>Proposal not found</strong>
      <span>
        There is no schedule with this id on Hedera testnet. Check the id (it looks like 0.0.1234) or pick a proposal
        from the list.
      </span>
      <Link className="btn btn-sm" href="/proposals">
        All proposals
      </Link>
    </div>
  );
}
