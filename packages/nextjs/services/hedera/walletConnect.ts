"use client";

// Deep imports on purpose: the package root also re-exports its Reown/EVM adapters, which need
// `ethers` and `@reown/*`. The dapp + shared modules need neither.
import type { DAppConnector, DAppSigner } from "@hashgraph/hedera-wallet-connect/dist/lib/dapp";

/**
 * HashPack (and other Hedera-native wallets) over WalletConnect. Loaded lazily so the read-only
 * dashboard never pays for it, and optional: without a project id the UI explains how to sign by script.
 */
export const WALLET_CONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ?? "";

let connectorPromise: Promise<DAppConnector> | null = null;

export async function getConnector(): Promise<DAppConnector> {
  if (!WALLET_CONNECT_PROJECT_ID) {
    throw new Error(
      "Set NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID (free at https://dashboard.walletconnect.com) to sign with HashPack.",
    );
  }
  connectorPromise ??= (async () => {
    const [{ DAppConnector }, { HederaJsonRpcMethod, HederaSessionEvent, HederaChainId }, { LedgerId }] =
      await Promise.all([
        import("@hashgraph/hedera-wallet-connect/dist/lib/dapp"),
        import("@hashgraph/hedera-wallet-connect/dist/lib/shared"),
        import("@hiero-ledger/sdk"),
      ]);
    const connector = new DAppConnector(
      {
        name: "Quorum Treasury",
        description: "Native Hedera team treasury",
        url: window.location.origin,
        icons: [`${window.location.origin}/favicon.png`],
      },
      LedgerId.TESTNET,
      WALLET_CONNECT_PROJECT_ID,
      Object.values(HederaJsonRpcMethod),
      [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
      [HederaChainId.Testnet],
    );
    await connector.init({ logger: "error" } as never);
    return connector;
  })();
  return connectorPromise;
}

export async function connectWallet(): Promise<DAppSigner> {
  const connector = await getConnector();
  if (connector.signers.length === 0) await connector.openModal();
  const signer = connector.signers[0];
  if (!signer) throw new Error("The wallet did not share an account.");
  return signer;
}

export async function currentSigner(): Promise<DAppSigner | null> {
  if (!WALLET_CONNECT_PROJECT_ID) return null;
  const connector = await getConnector();
  return connector.signers[0] ?? null;
}

export async function disconnectWallet(): Promise<void> {
  if (!connectorPromise) return;
  const connector = await connectorPromise;
  await connector.disconnectAll().catch(() => undefined);
}
