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
  /** One stored snapshot by its store row id (used by the published pointer). */
  getById(id: string): Promise<StoredSnapshot | null>;
  /** Every retained capture for a week, newest first. */
  listVersions(key: SnapshotKey): Promise<StoredSnapshotMeta[]>;
  /** Metadata for all snapshots of a league+season, newest first. */
  listWeeks(league_slug: string, season: number): Promise<StoredSnapshotMeta[]>;
}

/* ------------------------------------------------------------------ ledger */

export interface LedgerAppendResult {
  status: PersistenceStatus;
  /** Provider transactions handed to `append`. */
  seen: number;
  /** Rows this call actually wrote. */
  inserted: number;
  /**
   * Rows already present (inserted by an earlier run or a concurrent job) — a
   * safe no-op, NEVER an error. `inserted + duplicates === seen`.
   */
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

/* ------------------------------------------------ published-snapshot pointer */

/**
 * The authoritative "which already-certified snapshot IS the current league
 * reality" pointer. ONE row per (league_slug, season).
 *
 * This is NOT a copy of the snapshot — the immutable {@link SnapshotStore} row
 * `snapshot_id` points to remains the source of truth for the payload. This
 * pointer only records *which* stored snapshot has been certified and published
 * as current, and carries just enough denormalized metadata to answer freshness
 * questions without a second read.
 *
 * Publication is atomic and monotonic: `advance()` moves the pointer only when
 * the caller's `expected_seq` still matches the stored `published_seq` (or the
 * row is absent and `expected_seq === 0`). A failed candidate never advances the
 * pointer; a lost race is reported as `raced`, never as a silent overwrite.
 */
export interface PublishedPointer {
  league_slug: string;
  season: number;
  /** `SnapshotStore` row id (immutable snapshot) this pointer certifies. */
  snapshot_id: string;
  /** Deterministic `snap:<slug>:<season>:wNN:<hash16>` id of that snapshot. */
  league_snapshot_id: string;
  /** Content hash of the published snapshot (change detection). */
  content_hash: string;
  week: number;
  /** Monotonic counter — bumped on every successful advance. Concurrency guard. */
  published_seq: number;
  /** Always true here: the pointer is only ever advanced past certification. */
  certified: boolean;
  source_provider_synced_at: string | null;
  published_at: string;
  updated_at: string;
  schema_version: number;
}

export interface AdvancePointerInput {
  league_slug: string;
  season: number;
  snapshot_id: string;
  league_snapshot_id: string;
  content_hash: string;
  week: number;
  source_provider_synced_at: string | null;
  schema_version: number;
}

export interface AdvancePointerResult {
  status: PersistenceStatus;
  /**
   * `advanced`  — the pointer now names this snapshot.
   * `unchanged` — the current pointer already names this exact content hash (no-op).
   * `raced`     — another writer advanced the pointer first; `pointer` is the winner.
   * `error`     — the store failed; the previous pointer (if any) is unchanged.
   */
  outcome: "advanced" | "unchanged" | "raced" | "error";
  pointer: PublishedPointer | null;
  error?: string;
}

export interface PublishedPointerStore {
  readonly backend: string;
  status(): Promise<PersistenceStatus>;
  get(league_slug: string, season: number): Promise<PublishedPointer | null>;
  /**
   * Atomically advance the pointer. `expected_seq` is the `published_seq` the
   * caller last observed (0 when it observed no row). Concurrency-safe: a
   * mismatched `expected_seq` yields `raced`, never an overwrite.
   */
  advance(
    input: AdvancePointerInput,
    expected_seq: number,
  ): Promise<AdvancePointerResult>;
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

/* ------------------------------------------------------ publication audit */

/**
 * One row per publication ATTEMPT (Stage E). Not on any read path — it is the
 * operational audit trail: what was tried, what was certified, whether the
 * pointer moved, and why not when it didn't.
 */
export interface PublicationAudit {
  id?: string | null;
  league_slug: string;
  season: number;
  trigger: "API" | "CRON" | "CLI" | "TEST";
  attempted_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  /** The `PublishOutcome` from `getPublishedLeagueSnapshot`. */
  outcome: string;
  ok: boolean;
  candidate_snapshot_id: string | null;
  candidate_content_hash: string | null;
  prior_pointer_seq: number | null;
  resulting_pointer_seq: number | null;
  pointer_advanced: boolean;
  snapshot_persisted: "created" | "duplicate" | "error" | "skipped" | "not_attempted";
  integrity: "CERTIFIED" | "REJECTED" | null;
  validation_detail: string | null;
  source_status: string | null;
  error_category: string | null;
  error: string | null;
}

export interface PublicationAuditStore {
  readonly backend: string;
  status(): Promise<PersistenceStatus>;
  /** Append one audit row. Best-effort: a failure here never fails a publish. */
  record(audit: PublicationAudit): Promise<{ status: PersistenceStatus; id: string | null; error?: string }>;
  /** Most recent attempt for a league+season. */
  latest(league_slug: string, season: number): Promise<PublicationAudit | null>;
  /** Recent attempts, newest first. */
  recent(league_slug: string, season: number, limit?: number): Promise<PublicationAudit[]>;
}

export interface PersistenceBundle {
  snapshots: SnapshotStore;
  ledger: LedgerStore;
  runs: CaptureRunStore;
  /** Authoritative pointer to the currently published certified snapshot. */
  published: PublishedPointerStore;
  /** Publication-attempt audit trail (Stage E). */
  publication_audit: PublicationAuditStore;
  /** Aggregate status: READY only if every store is READY. */
  status(): Promise<PersistenceStatus>;
}
