import { withRetry } from "./errors";
import type { MirrorKey } from "./keys";
import type { MirrorSchedule } from "./status";

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class MirrorHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`Mirror node returned HTTP ${status} for ${url}`);
    this.name = "MirrorHttpError";
  }
}

export interface MirrorAccount {
  account: string;
  evm_address: string | null;
  key: MirrorKey | null;
  balance: { balance: number; tokens: { token_id: string; balance: number }[] };
  max_automatic_token_associations: number;
}

export interface MirrorTokenAllowance {
  owner: string;
  spender: string;
  token_id: string;
  amount: number;
  amount_granted: number;
}

export interface MirrorTopicMessage {
  consensus_timestamp: string;
  message: string;
  payer_account_id: string;
  sequence_number: number;
}

export interface MirrorTransaction {
  consensus_timestamp: string;
  transaction_id: string;
  name: string;
  result: string;
  scheduled: boolean;
}

type Paged<K extends string, T> = { links: { next: string | null } } & Record<K, T[]>;

/**
 * Thin read-only client for the Hedera mirror node REST API.
 * `fetch` is injected so tests replay recorded responses and the UI can add caching.
 */
export class MirrorClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly retry = { retries: 4, baseDelayMs: 400 },
  ) {}

  private async get<T>(path: string): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    // 429 and 5xx are retried with backoff; 4xx such as 404 are answers and surface immediately.
    return withRetry(async () => {
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new MirrorHttpError(res.status, url);
      return (await res.json()) as T;
    }, this.retry);
  }

  private async *paginate<K extends string, T>(path: string, key: K, maxPages = 20): AsyncGenerator<T> {
    let next: string | null = path;
    for (let page = 0; next && page < maxPages; page++) {
      const body: Paged<K, T> = await this.get<Paged<K, T>>(next);
      for (const item of body[key] ?? []) yield item;
      next = body.links?.next ?? null;
    }
  }

  getAccount(id: string) {
    return this.get<MirrorAccount>(`/api/v1/accounts/${id}?transactions=false`);
  }

  getSchedule(id: string) {
    return this.get<MirrorSchedule>(`/api/v1/schedules/${id}`);
  }

  /** The mirror node can only filter schedules by creator; callers filter by payer themselves. */
  async listSchedulesByCreator(accountId: string, limit = 100): Promise<MirrorSchedule[]> {
    const out: MirrorSchedule[] = [];
    for await (const s of this.paginate<"schedules", MirrorSchedule>(
      `/api/v1/schedules?account.id=${accountId}&order=desc&limit=${Math.min(limit, 100)}`,
      "schedules",
    )) {
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  async getTokenAllowance(owner: string, spender: string, tokenId: string): Promise<MirrorTokenAllowance | null> {
    const body = await this.get<{ allowances: MirrorTokenAllowance[] }>(
      `/api/v1/accounts/${owner}/allowances/tokens?spender.id=${spender}&token.id=${tokenId}`,
    );
    return body.allowances[0] ?? null;
  }

  async listTopicMessages(topicId: string, limit = 500): Promise<MirrorTopicMessage[]> {
    const out: MirrorTopicMessage[] = [];
    for await (const m of this.paginate<"messages", MirrorTopicMessage>(
      `/api/v1/topics/${topicId}/messages?order=asc&limit=100`,
      "messages",
    )) {
      out.push(m);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The child transaction a schedule executed, with its own result (SUCCESS or the failure code). */
  async getScheduledTransaction(executedTimestamp: string): Promise<MirrorTransaction | null> {
    const body = await this.get<{ transactions: MirrorTransaction[] }>(
      `/api/v1/transactions?timestamp=${executedTimestamp}`,
    );
    return body.transactions.find(t => t.scheduled) ?? body.transactions[0] ?? null;
  }

  /**
   * The mirror node lags consensus by a few seconds. Poll until `predicate` holds
   * (e.g. a just-signed schedule shows the new signature) or give up.
   */
  async waitFor<T>(
    load: () => Promise<T>,
    predicate: (value: T) => boolean,
    { attempts = 10, intervalMs = 1500, sleep = (ms: number) => new Promise(r => setTimeout(r, ms)) } = {},
  ): Promise<T> {
    let last = await load();
    for (let i = 1; i < attempts && !predicate(last); i++) {
      await sleep(intervalMs);
      last = await load();
    }
    if (!predicate(last)) throw new Error("Mirror node did not reflect the change in time");
    return last;
  }
}
