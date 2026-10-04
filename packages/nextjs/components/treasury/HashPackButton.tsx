"use client";

import { useEffect } from "react";
import {
  WALLET_CONNECT_PROJECT_ID,
  connectWallet,
  disconnectWallet,
  restoreWallet,
  useWallet,
} from "~~/services/hedera/walletConnect";

/** Header button: connect HashPack over WalletConnect and show the connected account. */
export function HashPackButton() {
  const { accountId, connecting } = useWallet();

  useEffect(() => {
    if (WALLET_CONNECT_PROJECT_ID) void restoreWallet();
  }, []);

  if (!WALLET_CONNECT_PROJECT_ID) {
    return (
      <button
        className="btn btn-primary btn-sm"
        disabled
        title="Set NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID (free at https://dashboard.walletconnect.com) to connect HashPack."
      >
        Connect HashPack
      </button>
    );
  }

  if (accountId) {
    return (
      <div className="flex items-center gap-2">
        <span className="badge badge-success badge-outline font-mono" title="Connected with HashPack">
          {accountId}
        </span>
        <button className="btn btn-ghost btn-sm" onClick={() => void disconnectWallet()}>
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      className="btn btn-primary btn-sm"
      disabled={connecting}
      onClick={() => void connectWallet().catch(() => undefined)}
    >
      {connecting ? <span className="loading loading-spinner loading-xs" /> : null} Connect HashPack
    </button>
  );
}
