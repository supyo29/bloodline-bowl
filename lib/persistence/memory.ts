/**
 * In-memory persistence — for unit tests, local development, and as the
 * reference implementation of the immutability / idempotency contracts. No
 * database connection required.
 */

import {
  snapshotContentHash,
  transactionContentHash,
} from "./serialize";
import type {
  CanonicalLeagueSnapshot,
  CanonicalTransaction,
} from "@/lib/canonical/schema";
import type {
  CaptureRunInput,
  CaptureRunStore,
  CaptureType,
  LedgerAppendResult,
  LedgerStore,
  PersistenceBundle,
  PersistenceStatus,
  PutSnapshotResult,
  SnapshotKey,
  SnapshotStore,
  StoredSnapshot,
  StoredSnapshotMeta,
  StoredTransaction,
  TransactionFilter,
} from "./types";

function uid(): string {
  return `mem_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

export class MemorySnapshotStore implements SnapshotStore {
  readonly backend = "memory";
  #rows: Array<StoredSnapshot & { __seq: number }> = [];
  #seq = 0;

  async status(): Promise<PersistenceStatus> {
    return "READY";
  }

  async put(
    snapshot: CanonicalLeagueSnapshot,
    opts: { capture_type: CaptureType; capture_run_id?: string | null },
  ): Promise<PutSnapshotResult> {
    const league_slug = snapshot.league.league_slug;
    const hash = snapshotContentHash(snapshot);
    const existing = this.#rows.find(
      (r) =>
        r.league_slug === league_slug &&
        r.season === snapshot.season &&
        r.week === snapshot.week &&
        r.capture_type === opts.capture_type &&
        r.content_hash === hash,
    );
    if (existing) {
      return { status: "READY", outcome: "duplicate", meta: strip(existing) };
    }
    const row = {
      __seq: this.#seq++,
      id: uid(),
      league_slug,
      provider: snapshot.league.provenance.provider,
      season: snapshot.season,
      week: snapshot.week,
      capture_type: opts.capture_type,
      schema_version: snapshot.schema_version,
      captured_at: snapshot.captured_at,
      provider_synced_at: snapshot.provider_synced_at,
      content_hash: hash,
      payload: snapshot,
    };
    this.#rows.push(row);
    return { status: "READY", outcome: "created", meta: strip(row) };
  }

  /** Newest first: captured_at desc, then insertion order desc as a stable tiebreak. */
  #newestFirst(rows: Array<StoredSnapshot & { __seq: number }>): Array<StoredSnapshot & { __seq: number }> {
    return rows.sort((a, b) => b.captured_at.localeCompare(a.captured_at) || b.__seq - a.__seq);
  }

  async getLatest(key: SnapshotKey): Promise<StoredSnapshot | null> {
    return this.#newestFirst(this.#match(key))[0] ?? null;
  }

  async listVersions(key: SnapshotKey): Promise<StoredSnapshotMeta[]> {
    return this.#newestFirst(this.#match(key)).map(strip);
  }

  async listWeeks(league_slug: string, season: number): Promise<StoredSnapshotMeta[]> {
    return this.#newestFirst(
      this.#rows.filter((r) => r.league_slug === league_slug && r.season === season),
    ).map(strip);
  }

  #match(key: SnapshotKey): Array<StoredSnapshot & { __seq: number }> {
    return this.#rows.filter(
      (r) =>
        r.league_slug === key.league_slug &&
        r.season === key.season &&
        r.week === key.week &&
        (key.capture_type ? r.capture_type === key.capture_type : true),
    );
  }
}

function strip(row: StoredSnapshot & { __seq?: number }): StoredSnapshotMeta {
  const { payload: _payload, __seq: _seq, ...meta } = row;
  return meta;
}

export class MemoryLedgerStore implements LedgerStore {
  readonly backend = "memory";
  #rows: StoredTransaction[] = [];

  async status(): Promise<PersistenceStatus> {
    return "READY";
  }

  async append(transactions: CanonicalTransaction[]): Promise<LedgerAppendResult> {
    let inserted = 0;
    let duplicates = 0;
    for (const txn of transactions) {
      const providerTxnId = txn.provenance.provider_id ?? txn.canonical_transaction_id;
      const dupe = this.#rows.find(
        (r) =>
          r.league_slug === txn.league_slug &&
          r.season === txn.season &&
          r.provider === txn.provenance.provider &&
          r.provider_transaction_id === providerTxnId,
      );
      if (dupe) {
        dupe.last_seen_at = new Date().toISOString();
        duplicates += 1;
        continue;
      }
      this.#rows.push({
        id: uid(),
        league_slug: txn.league_slug,
        provider: txn.provenance.provider,
        season: txn.season,
        fantasy_week: txn.fantasy_week,
        provider_transaction_id: providerTxnId,
        canonical_transaction_id: txn.canonical_transaction_id,
        transaction_type: txn.type,
        status: txn.status,
        provider_timestamp: txn.provider_timestamp,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        payload: txn,
      });
      inserted += 1;
    }
    return {
      status: "READY",
      seen: transactions.length,
      inserted,
      duplicates,
    };
  }

  async query(filter: TransactionFilter): Promise<StoredTransaction[]> {
    let rows = this.#rows.filter(
      (r) => r.league_slug === filter.league_slug && r.season === filter.season,
    );
    if (filter.week != null) rows = rows.filter((r) => r.fantasy_week === filter.week);
    if (filter.type) rows = rows.filter((r) => r.transaction_type === filter.type);
    if (filter.team_id) {
      rows = rows.filter((r) => r.payload.canonical_team_ids.includes(filter.team_id as string));
    }
    rows = rows.sort((a, b) => (b.provider_timestamp ?? "").localeCompare(a.provider_timestamp ?? ""));
    return filter.limit ? rows.slice(0, filter.limit) : rows;
  }

  async count(league_slug: string, season: number): Promise<number> {
    return this.#rows.filter((r) => r.league_slug === league_slug && r.season === season).length;
  }

  /** Test helper: expose the content hash used for dedupe reasoning. */
  static contentHash(txn: CanonicalTransaction): string {
    return transactionContentHash(txn);
  }
}

export class MemoryCaptureRunStore implements CaptureRunStore {
  readonly backend = "memory";
  runs: Array<CaptureRunInput & { id: string; status: string }> = [];

  async status(): Promise<PersistenceStatus> {
    return "READY";
  }
  async start(input: CaptureRunInput): Promise<string | null> {
    const id = uid();
    this.runs.push({ ...input, id, status: "RUNNING" });
    return id;
  }
  async finish(id: string | null, result: { status: string }): Promise<void> {
    const run = this.runs.find((r) => r.id === id);
    if (run) run.status = result.status;
  }
}

export function memoryPersistence(): PersistenceBundle {
  const snapshots = new MemorySnapshotStore();
  const ledger = new MemoryLedgerStore();
  const runs = new MemoryCaptureRunStore();
  return {
    snapshots,
    ledger,
    runs,
    status: async () => "READY",
  };
}
