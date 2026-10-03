import {
  Client,
  PrivateKey,
  ScheduleCreateTransaction,
  ScheduleDeleteTransaction,
  ScheduleId,
  ScheduleSignTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import { encodeIndexMessage, IndexMessage, withRetry } from "../../src";

export interface Proposed {
  scheduleId: string;
  createTxId: string;
}

/**
 * Submit a ScheduleCreate. The operator pays the creation fee; the proposer's signature on the
 * ScheduleCreate also counts toward the scheduled transaction, so the proposal starts at "1 of 2".
 */
export async function submitProposal(client: Client, schedule: ScheduleCreateTransaction, proposer: PrivateKey): Promise<Proposed> {
  const frozen = await schedule.freezeWith(client).sign(proposer);
  const response = await withRetry(() => frozen.execute(client));
  const receipt = await response.getReceipt(client);
  return { scheduleId: receipt.scheduleId!.toString(), createTxId: response.transactionId.toString() };
}

/** Announce the proposal on the HCS index (topic submit key = any one signer). */
export async function announce(
  client: Client,
  topicId: string,
  entry: Omit<IndexMessage, "v">,
  signer: PrivateKey,
): Promise<string> {
  const tx = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(encodeIndexMessage(entry))
    .freezeWith(client)
    .sign(signer);
  const response = await withRetry(() => tx.execute(client));
  await response.getReceipt(client);
  return response.transactionId.toString();
}

/** One signer approves. Each signer submits their own ScheduleSign (never aggregate signatures offline). */
export async function signProposal(client: Client, scheduleId: string, signer: PrivateKey): Promise<string> {
  const tx = await new ScheduleSignTransaction().setScheduleId(ScheduleId.fromString(scheduleId)).freezeWith(client).sign(signer);
  const response = await withRetry(() => tx.execute(client));
  await response.getReceipt(client);
  return response.transactionId.toString();
}

/** Minority veto: any one signer deletes the schedule during the timelock (schedule admin key = 1-of-3). */
export async function vetoProposal(client: Client, scheduleId: string, signer: PrivateKey): Promise<string> {
  const tx = await new ScheduleDeleteTransaction().setScheduleId(ScheduleId.fromString(scheduleId)).freezeWith(client).sign(signer);
  const response = await withRetry(() => tx.execute(client));
  await response.getReceipt(client);
  return response.transactionId.toString();
}
