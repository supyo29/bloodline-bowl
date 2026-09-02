/**
 * Persistence contracts.
 *
 * The analytical domain talks to these interfaces, never to Supabase. Supabase
 * is one implementation (`./supabase/*`); in-memory and filesystem
 * implementations exist for tests, local development, and export/recovery.
 *
 * Two hard rules encoded here:
 *   1. SNAPSHOTS ARE IMMUTABLE. `put` never overwrites — identical content for a
 *      (league, season, week, capture_type) is a no-op; changed content is a new
 *      version. There is no `update` or `delete`.
 *   2. THE LEDGER IS APPEND-ONLY + IDEMPOTENT. `append` keys on
 *      (league_slug, season, provider, provider_transaction_id); re-appending a
 *      seen transaction bumps `last_seen_at` and nothing else.
 *
 * Every row is scoped to a canonical `league_slug` + `season`. Cross-league
 * reads/writes are impossible through this interface.
 */

import type {
  CanonicalLeagueSnapshot,
  CanonicalTransaction,
  ProviderName,
} from "@/lib/canonical/schema";

export type CaptureType = "PRE_WEEK" | "MID_WEEK" | "FINAL" | "AD_HOC";

export type PersistenceStatus =
  | "READY"
  | "PERSISTENCE_NOT_CONFIGURED"
  | "PERSISTENCE_ERROR";

/* --------------------------------------------------------------- snapshots */

export interface SnapshotKey {
  league_slug: string;
  season: number;
  week: number;
  capture_type?: CaptureType;
}

export interface StoredSnapshotMeta {
  id: string;
  league_slug: string;
  provider: ProviderName;
  season: number;
  week: number;
  capture_type: CaptureType;
  schema_version: number;
  captured_at: string;
  provider_synced_at: string | null;
  content_hash: string;
}

export interface StoredSnapshot extends StoredSnapshotMeta {
  payload: CanonicalLeagueSnapshot;
}

export interface PutSnapshotResult {
  status: PersistenceStatus;
  /** `created` = new version written; `duplicate` = identical content already stored. */
  outcome: "created" | "duplicate" | "error";
  meta: StoredSnapshotMeta | null;
  error?: string;
}

export interface SnapshotStore {
  readonly backend: string;
  status(): Promise<PersistenceStatus>;
  /** Write a snapshot version. Immutable: never overwrites an earlier capture. */
  put(
    snapshot: CanonicalLeagueSnapshot,
    opts: { capture_type: CaptureType; capture_run_id?: string | null },
  ): Promise<PutSnapshotResult>;
  /** Latest capture for a week (optionally of a specific capture_type). */
  getLatest(key: SnapshotKey): Promise<StoredSnapshot | null>;
  /** Every retained capture for a week, newest first. */
  listVersions(key: SnapshotKey): Promise<StoredSnapshotMeta[]>;
  /** Metadata for all snapshots of a league+season, newest first. */
  listWeeks(league_slug: string, season: number): Promise<StoredSnapshotMeta[]>;
}

/* ------------------------------------------------------------------ ledger */

export interface LedgerAppendResult {
  status: PersistenceStatus;
  seen: number;
  inserted: number;
  duplicates: number;
  error?: string;
}

export interface TransactionFilter {
  league_slug: string;
  season: number;
  week?: number | null;
  type?: string | null;
  /** Canonical team id or manager id to filter to. */
  team_id?: string | null;
  limit?: number;
}

export interface StoredTransaction {
  id: string;
  league_slug: string;
  provider: ProviderName;
  season: number;
  fantasy_week: number | null;
  provider_transaction_id: string;
  canonical_transaction_id: string;
  transaction_type: string;
  status: string | null;
  provider_timestamp: string | null;
  first_seen_at: string;
  last_seen_at: string;
  payload: CanonicalTransaction;
}

export interface LedgerStore {
  readonly backend: string;
  status(): Promise<PersistenceStatus>;
  /** Append transactions idempotently. Overlapping sync windows are safe. */
  append(transactions: CanonicalTransaction[]): Promise<LedgerAppendResult>;
  query(filter: TransactionFilter): Promise<StoredTransaction[]>;
  count(league_slug: string, season: number): Promise<number>;
}

/* -------------------------------------------------------------- capture runs */

export interface CaptureRunInput {
  league_slug: string | null;
  run_type: "SNAPSHOT" | "TRANSACTION_SYNC";
  trigger: "CLI" | "CRON" | "API" | "TEST";
}

export interface CaptureRunStore {
  readonly backend: string;
  status(): Promise<PersistenceStatus>;
  start(input: CaptureRunInput): Promise<string | null>;
  finish(
    id: string | null,
    result: {
      status: "OK" | "ERROR" | "PARTIAL";
      snapshots_written?: number;
      transactions_seen?: number;
      transactions_new?: number;
      warnings?: string[];
      error?: string | null;
    },
  ): Promise<void>;
}

export interface PersistenceBundle {
  snapshots: SnapshotStore;
  ledger: LedgerStore;
  runs: CaptureRunStore;
  /** Aggregate status: READY only if every store is READY. */
  status(): Promise<PersistenceStatus>;
}
