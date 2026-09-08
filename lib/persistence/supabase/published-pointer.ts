/**
 * Supabase-backed PublishedPointerStore — the DURABLE authoritative record of
 * which certified snapshot is the current league reality.
 *
 * Table: public.bridge_published_snapshot (see migration
 * 20260907xxxxxx_bridge_published_snapshot_pointer.sql). ONE row per
 * (league_slug, season) — enforced by the primary key.
 *
 * ATOMICITY: `advance()` is a single filtered PATCH
 * (`... WHERE league_slug = $1 AND season = $2 AND published_seq = $expected`),
 * which Postgres executes as one atomic `UPDATE`. Two instances that both try to
 * advance the pointer from seq N: exactly one PATCH matches a row and returns it
 * (`advanced`); the other matches zero rows and returns `[]` (`raced`). No
 * overwrite, no lost update, no torn state. First publication uses a
 * conflict-safe insert on the `(league_slug, season)` primary key.
 *
 * This store is NOT on any hot read path — routes read the pointer through a
 * short-lived per-instance cache (see `lib/canonical/published.ts`); this class
 * is the write path + the cache-miss/forced-refresh read path.
 */

import type {
  AdvancePointerInput,
  AdvancePointerResult,
  PersistenceStatus,
  PublishedPointer,
  PublishedPointerStore,
} from "../types";
import { SupabaseRest } from "./rest";

const TABLE = "bridge_published_snapshot";
const PK = ["league_slug", "season"];

interface PointerRow {
  league_slug: string;
  season: number;
  snapshot_id: string;
  league_snapshot_id: string;
  content_hash: string;
  week: number;
  published_seq: number;
  certified: boolean;
  source_provider_synced_at: string | null;
  published_at: string;
  updated_at: string;
  schema_version: number;
}

function toPointer(row: PointerRow): PublishedPointer {
  return {
    league_slug: row.league_slug,
    season: row.season,
    snapshot_id: row.snapshot_id,
    league_snapshot_id: row.league_snapshot_id,
    content_hash: row.content_hash,
    week: row.week,
    published_seq: row.published_seq,
    certified: row.certified,
    source_provider_synced_at: row.source_provider_synced_at,
    published_at: row.published_at,
    updated_at: row.updated_at,
    schema_version: row.schema_version,
  };
}

export class SupabasePublishedPointerStore implements PublishedPointerStore {
  readonly backend = "supabase";
  constructor(private readonly rest: SupabaseRest) {}

  async status(): Promise<PersistenceStatus> {
    try {
      await this.rest.select(TABLE, { limit: 1, select: "league_slug" });
      return "READY";
    } catch {
      return "PERSISTENCE_ERROR";
    }
  }

  async get(league_slug: string, season: number): Promise<PublishedPointer | null> {
    const rows = await this.rest.select<PointerRow>(TABLE, {
      filter: { league_slug: `eq.${league_slug}`, season: `eq.${season}` },
      limit: 1,
    });
    return rows[0] ? toPointer(rows[0]) : null;
  }

  async advance(
    input: AdvancePointerInput,
    expected_seq: number,
  ): Promise<AdvancePointerResult> {
    try {
      const current = await this.get(input.league_slug, input.season);

      // Idempotency: the pointer already names this exact content.
      if (current && current.content_hash === input.content_hash) {
        return { status: "READY", outcome: "unchanged", pointer: current };
      }

      const now = new Date().toISOString();

      if (!current) {
        if (expected_seq !== 0) {
          return { status: "READY", outcome: "raced", pointer: null };
        }
        const inserted = await this.rest.insertIgnoreDuplicates<PointerRow>(
          TABLE,
          [
            {
              league_slug: input.league_slug,
              season: input.season,
              snapshot_id: input.snapshot_id,
              league_snapshot_id: input.league_snapshot_id,
              content_hash: input.content_hash,
              week: input.week,
              published_seq: 1,
              certified: true,
              source_provider_synced_at: input.source_provider_synced_at,
              published_at: now,
              updated_at: now,
              schema_version: input.schema_version,
            },
          ],
          PK,
        );
        if (inserted.length > 0) {
          return { status: "READY", outcome: "advanced", pointer: toPointer(inserted[0]!) };
        }
        // Another writer created the row first.
        const winner = await this.get(input.league_slug, input.season);
        return {
          status: "READY",
          outcome: winner?.content_hash === input.content_hash ? "unchanged" : "raced",
          pointer: winner,
        };
      }

      if (current.published_seq !== expected_seq) {
        return { status: "READY", outcome: "raced", pointer: current };
      }

      // One atomic UPDATE guarded by the observed sequence number.
      const changed = await this.rest.updateReturning<PointerRow>(
        TABLE,
        {
          league_slug: `eq.${input.league_slug}`,
          season: `eq.${input.season}`,
          published_seq: `eq.${expected_seq}`,
        },
        {
          snapshot_id: input.snapshot_id,
          league_snapshot_id: input.league_snapshot_id,
          content_hash: input.content_hash,
          week: input.week,
          published_seq: expected_seq + 1,
          certified: true,
          source_provider_synced_at: input.source_provider_synced_at,
          published_at: now,
          updated_at: now,
          schema_version: input.schema_version,
        },
      );

      if (changed.length > 0) {
        return { status: "READY", outcome: "advanced", pointer: toPointer(changed[0]!) };
      }

      const winner = await this.get(input.league_slug, input.season);
      return {
        status: "READY",
        outcome: winner?.content_hash === input.content_hash ? "unchanged" : "raced",
        pointer: winner,
      };
    } catch (error) {
      return {
        status: "PERSISTENCE_ERROR",
        outcome: "error",
        pointer: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
