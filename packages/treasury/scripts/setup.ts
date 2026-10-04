/**
 * Create (or resume creating) a Quorum Treasury on Hedera testnet with ONE funded operator account.
 *   yarn treasury:setup
 * Idempotent: every step checks deployments/testnet.json first, so re-running only does what is missing.
 */
import {
  AccountCreateTransaction,
  AccountId,
  Hbar,
  TokenAssociateTransaction,
  TokenId,
  TopicCreateTransaction,
} from "@hiero-ledger/sdk";
import { TESTNET } from "../src";
import { hashscan, log, mirror, operatorClient, readDeployment, writeDeployment } from "./lib/network";
import { anyOneKey, loadOrCreateSigners, quorumKey, scriptSigners } from "./lib/signers";

const TREASURY_HBAR = Number(process.env.TREASURY_INITIAL_HBAR ?? 40);
const OPS_HBAR = Number(process.env.OPS_INITIAL_HBAR ?? 5);

async function main() {
  const { client } = operatorClient();
  const signers = loadOrCreateSigners();
  let d = readDeployment();
  const signerKeys = signers.map(s => s.publicKey.toStringRaw());

  if (d.signerPublicKeys && d.signerPublicKeys.join() !== signerKeys.join()) {
    throw new Error("deployments/testnet.json belongs to different signers. Delete it to create a new treasury.");
  }

  if (!d.treasuryId) {
    const receipt = await (
      await new AccountCreateTransaction()
        .setKeyWithoutAlias(quorumKey(signers))
        .setInitialBalance(new Hbar(TREASURY_HBAR))
        // TokenAssociate cannot be scheduled, so let the treasury receive any token without one.
        .setMaxAutomaticTokenAssociations(-1)
        .setAccountMemo("quorum-treasury: 2-of-3")
        .execute(client)
    ).getReceipt(client);
    d = writeDeployment({ treasuryId: receipt.accountId!.toString(), signerPublicKeys: signerKeys });
    log("Treasury (2-of-3 threshold key)", hashscan("account", d.treasuryId!));
  }

  if (!d.opsAccountId) {
    const receipt = await (
      await new AccountCreateTransaction()
        .setKeyWithoutAlias(anyOneKey(signers))
        .setInitialBalance(new Hbar(OPS_HBAR))
        .setMaxAutomaticTokenAssociations(-1)
        .setAccountMemo("quorum-treasury: ops budget, 1-of-3")
        .execute(client)
    ).getReceipt(client);
    d = writeDeployment({ opsAccountId: receipt.accountId!.toString() });
    log("Ops account (any 1 signer, spends only its allowance)", hashscan("account", d.opsAccountId!));
  }

  if (!d.indexTopicId) {
    const receipt = await (
      await new TopicCreateTransaction()
        .setSubmitKey(anyOneKey(signers))
        .setTopicMemo(`quorum-treasury/v1 proposal index for ${d.treasuryId}`)
        .execute(client)
    ).getReceipt(client);
    d = writeDeployment({ indexTopicId: receipt.topicId!.toString() });
    log("Proposal index topic (submit key = any 1 signer)", hashscan("topic", d.indexTopicId!));
  }

  // Associate USDC explicitly (budget allowances need it; auto-association would also work on first receipt).
  const usdc = TokenId.fromString(TESTNET.usdc.tokenId);
  for (const [accountId, needed] of [
    [d.treasuryId!, 2],
    [d.opsAccountId!, 1],
  ] as const) {
    // A just-created account takes a few seconds to appear on the mirror node.
    const account = await mirror.waitFor(
      () => mirror.getAccount(accountId).catch(() => null),
      a => a !== null,
      { attempts: 20, intervalMs: 3000 },
    );
    if (account!.balance.tokens.some(t => t.token_id === TESTNET.usdc.tokenId)) continue;
    const keys = scriptSigners(signers).slice(0, needed);
    if (keys.length < needed) throw new Error(`Need ${needed} script signer key(s) to associate USDC with ${accountId}`);
    let tx = new TokenAssociateTransaction().setAccountId(AccountId.fromString(accountId)).setTokenIds([usdc]).freezeWith(client);
    for (const s of keys) tx = await tx.sign(s.privateKey);
    await (await tx.execute(client)).getReceipt(client);
    log(`USDC associated with ${accountId}`);
  }
  writeDeployment({ usdcTokenId: TESTNET.usdc.tokenId });

  console.log("\nTreasury ready. Next: yarn treasury:propose -- --type hbar --to 0.0.98 --amount 1");
  client.close();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
