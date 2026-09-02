/**
 * Supabase-backed SnapshotStore / LedgerStore / CaptureRunStore — the
 * production persistence implementation.
 *
 * Tables (see migration supabase/migrations/20260902172602_bridge_post_draft_foundation.sql):
 *   bridge_league_snapshots     immutable, versioned; DB trigger blocks UPDATE/DELETE
 *   bridge_transaction_ledger   append-only; UNIQUE(league_slug,season,provider,provider_transaction_id)
 *   bridge_capture_runs         run metadata
 *
 * Idempotency is enforced by Postgres UNIQUE constraints + a conflict-safe
 * `ON CONFLICT (<composite unique>) DO NOTHING` insert (see
 * `SupabaseRest.insertIgnoreDuplicates`), not by "fetch since last run"
 * bookkeeping. Two overlapping capture jobs that both try to persist the same
 * provider transaction are safe: exactly one row remains, the loser's insert is
 * a no-op, and both report success.
 */

import { snapshotContentHash } from "../serialize";
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
  PersistenceStatus,
  PutSnapshotResult,
  SnapshotKey,
  SnapshotStore,
  StoredSnapshot,
  StoredSnapshotMeta,
  StoredTransaction,
  TransactionFilter,
} from "../types";
import { SupabaseRest } from "./rest";

const SNAP_TABLE = "bridge_league_snapshots";
const LEDGER_TABLE = "bridge_transaction_ledger";
const RUNS_TABLE = "bridge_capture_runs";

/** Composite UNIQUE indexes — the conflict targets for idempotent inserts. */
const SNAP_CONFLICT = ["league_slug", "season", "week", "capture_type", "content_hash"];
const LEDGER_CONFLICT = ["league_slug", "season", "provider", "provider_transaction_id"];

function errStatus(): PersistenceStatus {
  return "PERSISTENCE_ERROR";
}

interface SnapshotRow {
  id: string;
  league_slug: string;
  provider: string;
  season: number;
  week: number;
  capture_type: CaptureType;
  schema_version: number;
  captured_at: string;
  provider_synced_at: string | null;
  content_hash: string;
  payload: CanonicalLeagueSnapshot;
}

export class SupabaseSnapshotStore implements SnapshotStore {
  readonly backend = "supabase";
  constructor(private readonly rest: SupabaseRest) {}

  async status(): Promise<PersistenceStatus> {
    try {
      await this.rest.select(SNAP_TABLE, { limit: 1, select: "id" });
      return "READY";
    } catch {
      return errStatus();
    }
  }

  async put(
    snapshot: CanonicalLeagueSnapshot,
    opts: { capture_type: CaptureType; capture_run_id?: string | null },
  ): Promise<PutSnapshotResult> {
    const hash = snapshotContentHash(snapshot);
    const row = {
      league_slug: snapshot.league.league_slug,
      provider: snapshot.league.provenance.provider,
      season: snapshot.season,
      week: snapshot.week,
      capture_type: opts.capture_type,
      schema_version: snapshot.schema_version,
      captured_at: snapshot.captured_at,
      provider_synced_at: snapshot.provider_synced_at,
      content_hash: hash,
      payload: snapshot,
      capture_run_id: opts.capture_run_id ?? null,
    };
    try {
      const inserted = await this.rest.insertIgnoreDuplicates<SnapshotRow>(
        SNAP_TABLE,
        [row],
        SNAP_CONFLICT,
      );
      if (inserted.length > 0) {
        return { status: "READY", outcome: "created", meta: toMeta(inserted[0]!) };
      }
      // Identical content already stored for this (league, season, week,
      // capture_type) — a concurrent/repeated capture. This is a no-op, not an
      // error, and snapshot VERSIONING is unchanged: genuinely different content
      // produces a different content_hash and lands as a new row.
      const existing = await this.rest.select<SnapshotRow>(SNAP_TABLE, {
        filter: {
          league_slug: `eq.${row.league_slug}`,
          season: `eq.${row.season}`,
          week: `eq.${row.week}`,
          capture_type: `eq.${row.capture_type}`,
          content_hash: `eq.${hash}`,
        },
        limit: 1,
        select: "id,league_slug,provider,season,week,capture_type,schema_version,captured_at,provider_synced_at,content_hash",
      });
      return {
        status: "READY",
        outcome: "duplicate",
        meta: existing[0] ? toMeta(existing[0]) : null,
      };
    } catch (error) {
      return {
        status: errStatus(),
        outcome: "error",
        meta: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getLatest(key: SnapshotKey): Promise<StoredSnapshot | null> {
    const filter: Record<string, string> = {
      league_slug: `eq.${key.league_slug}`,
      season: `eq.${key.season}`,
      week: `eq.${key.week}`,
    };
    if (key.capture_type) filter.capture_type = `eq.${key.capture_type}`;
    const rows = await this.rest.select<SnapshotRow>(SNAP_TABLE, {
      filter,
      order: "captured_at.desc",
      limit: 1,
    });
    return rows[0] ? { ...toMeta(rows[0]), payload: rows[0].payload } : null;
  }

  async listVersions(key: SnapshotKey): Promise<StoredSnapshotMeta[]> {
    const filter: Record<string, string> = {
      league_slug: `eq.${key.league_slug}`,
      season: `eq.${key.season}`,
      week: `eq.${key.week}`,
    };
    if (key.capture_type) filter.capture_type = `eq.${key.capture_type}`;
    const rows = await this.rest.select<SnapshotRow>(SNAP_TABLE, {
      filter,
      order: "captured_at.desc",
      select: "id,league_slug,provider,season,week,capture_type,schema_version,captured_at,provider_synced_at,content_hash",
    });
    return rows.map(toMeta);
  }

  async listWeeks(league_slug: string, season: number): Promise<StoredSnapshotMeta[]> {
    const rows = await this.rest.select<SnapshotRow>(SNAP_TABLE, {
      filter: { league_slug: `eq.${league_slug}`, season: `eq.${season}` },
      order: "captured_at.desc",
      select: "id,league_slug,provider,season,week,capture_type,schema_version,captured_at,provider_synced_at,content_hash",
    });
    return rows.map(toMeta);
  }
}

function toMeta(row: SnapshotRow): StoredSnapshotMeta {
  return {
    id: row.id,
    league_slug: row.league_slug,
    provider: row.provider as StoredSnapshotMeta["provider"],
    season: row.season,
    week: row.week,
    capture_type: row.capture_type,
    schema_version: row.schema_version,
    captured_at: row.captured_at,
    provider_synced_at: row.provider_synced_at,
    content_hash: row.content_hash,
  };
}

interface LedgerRow {
  id: string;
  league_slug: string;
  provider: string;
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

export class SupabaseLedgerStore implements LedgerStore {
  readonly backend = "supabase";
  constructor(private readonly rest: SupabaseRest) {}

  async status(): Promise<PersistenceStatus> {
    try {
      await this.rest.select(LEDGER_TABLE, { limit: 1, select: "id" });
      return "READY";
    } catch {
      return errStatus();
    }
  }

  async append(transactions: CanonicalTransaction[]): Promise<LedgerAppendResult> {
    if (transactions.length === 0) {
      return { status: "READY", seen: 0, inserted: 0, duplicates: 0 };
    }
    const rows = transactions.map((txn) => {
      const providerTxnId = txn.provenance.provider_id ?? txn.canonical_transaction_id;
      return {
        league_slug: txn.league_slug,
        provider: txn.provenance.provider,
        season: txn.season,
        fantasy_week: txn.fantasy_week,
        provider_transaction_id: providerTxnId,
        canonical_transaction_id: txn.canonical_transaction_id,
        transaction_type: txn.type,
        status: txn.status,
        provider_timestamp: txn.provider_timestamp,
        managers: txn.canonical_team_ids,
        players_added: txn.players_added,
        players_dropped: txn.players_dropped,
        players_traded: txn.trade_legs,
        faab: txn.faab_spent == null ? null : { spent: txn.faab_spent },
        payload: txn,
        source_metadata: txn.source_metadata ?? {},
      };
    });
    try {
      // ON CONFLICT (league_slug, season, provider, provider_transaction_id)
      // DO NOTHING — a transaction another job (or an earlier run) already
      // inserted is silently skipped. `inserted` is exactly the rows PostgREST
      // returned; everything else in the batch already existed.
      const inserted = await this.rest.insertIgnoreDuplicates<LedgerRow>(
        LEDGER_TABLE,
        rows,
        LEDGER_CONFLICT,
      );
      return {
        status: "READY",
        seen: transactions.length,
        inserted: inserted.length,
        duplicates: transactions.length - inserted.length,
      };
    } catch (error) {
      // A UNIQUE conflict is impossible here (DO NOTHING handles it), so any
      // error is a genuine DB failure and must surface.
      return {
        status: errStatus(),
        seen: transactions.length,
        inserted: 0,
        duplicates: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async query(filter: TransactionFilter): Promise<StoredTransaction[]> {
    const f: Record<string, string> = {
      league_slug: `eq.${filter.league_slug}`,
      season: `eq.${filter.season}`,
    };
    if (filter.week != null) f.fantasy_week = `eq.${filter.week}`;
    if (filter.type) f.transaction_type = `eq.${filter.type}`;
    const rows = await this.rest.select<LedgerRow>(LEDGER_TABLE, {
      filter: f,
      order: "provider_timestamp.desc",
      limit: filter.limit,
    });
    const mapped = rows.map(
      (r): StoredTransaction => ({
        id: r.id,
        league_slug: r.league_slug,
        provider: r.provider as StoredTransaction["provider"],
        season: r.season,
        fantasy_week: r.fantasy_week,
        provider_transaction_id: r.provider_transaction_id,
        canonical_transaction_id: r.canonical_transaction_id,
        transaction_type: r.transaction_type,
        status: r.status,
        provider_timestamp: r.provider_timestamp,
        first_seen_at: r.first_seen_at,
        last_seen_at: r.last_seen_at,
        payload: r.payload,
      }),
    );
    return filter.team_id
      ? mapped.filter((r) => r.payload.canonical_team_ids.includes(filter.team_id as string))
      : mapped;
  }

  async count(league_slug: string, season: number): Promise<number> {
    const rows = await this.rest.select<{ id: string }>(LEDGER_TABLE, {
      filter: { league_slug: `eq.${league_slug}`, season: `eq.${season}` },
      select: "id",
    });
    return rows.length;
  }
}

export class SupabaseCaptureRunStore implements CaptureRunStore {
  readonly backend = "supabase";
  constructor(private readonly rest: SupabaseRest) {}

  async status(): Promise<PersistenceStatus> {
    try {
      await this.rest.select(RUNS_TABLE, { limit: 1, select: "id" });
      return "READY";
    } catch {
      return errStatus();
    }
  }

  async start(input: CaptureRunInput): Promise<string | null> {
    try {
      const [row] = await this.rest.insert<{ id: string }>(RUNS_TABLE, {
        league_slug: input.league_slug,
        run_type: input.run_type,
        trigger: input.trigger,
        status: "RUNNING",
      });
      return row?.id ?? null;
    } catch {
      return null;
    }
  }

  async finish(
    id: string | null,
    result: {
      status: "OK" | "ERROR" | "PARTIAL";
      snapshots_written?: number;
      transactions_seen?: number;
      transactions_new?: number;
      warnings?: string[];
      error?: string | null;
    },
  ): Promise<void> {
    if (!id) return;
    try {
      await this.rest.update(
        RUNS_TABLE,
        { id: `eq.${id}` },
        {
          status: result.status,
          finished_at: new Date().toISOString(),
          snapshots_written: result.snapshots_written ?? 0,
          transactions_seen: result.transactions_seen ?? 0,
          transactions_new: result.transactions_new ?? 0,
          warnings: result.warnings ?? [],
          error: result.error ?? null,
        },
      );
    } catch {
      /* run metadata is best-effort */
    }
  }
}
