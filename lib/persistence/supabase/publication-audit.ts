/**
 * Supabase-backed PublicationAuditStore — the Stage E operational audit trail.
 *
 * Table: public.bridge_publication_audit (append-only in practice; no UPDATE
 * path). One row per publication ATTEMPT. Not read on any hot path — deep
 * health and operators read `latest` / `recent`.
 */

import type {
  PersistenceStatus,
  PublicationAudit,
  PublicationAuditStore,
} from "../types";
import { SupabaseRest } from "./rest";

const TABLE = "bridge_publication_audit";

type Row = PublicationAudit & { id: string };

function toRow(a: PublicationAudit): Record<string, unknown> {
  return {
    league_slug: a.league_slug,
    season: a.season,
    trigger: a.trigger,
    attempted_at: a.attempted_at,
    finished_at: a.finished_at,
    duration_ms: a.duration_ms,
    outcome: a.outcome,
    ok: a.ok,
    candidate_snapshot_id: a.candidate_snapshot_id,
    candidate_content_hash: a.candidate_content_hash,
    prior_pointer_seq: a.prior_pointer_seq,
    resulting_pointer_seq: a.resulting_pointer_seq,
    pointer_advanced: a.pointer_advanced,
    snapshot_persisted: a.snapshot_persisted,
    integrity: a.integrity,
    validation_detail: a.validation_detail,
    source_status: a.source_status,
    error_category: a.error_category,
    error: a.error,
  };
}

function fromRow(r: Row): PublicationAudit {
  return { ...r };
}

export class SupabasePublicationAuditStore implements PublicationAuditStore {
  readonly backend = "supabase";
  constructor(private readonly rest: SupabaseRest) {}

  async status(): Promise<PersistenceStatus> {
    try {
      await this.rest.select(TABLE, { limit: 1, select: "id" });
      return "READY";
    } catch {
      return "PERSISTENCE_ERROR";
    }
  }

  async record(audit: PublicationAudit) {
    try {
      const [row] = await this.rest.insert<{ id: string }>(TABLE, toRow(audit));
      return { status: "READY" as PersistenceStatus, id: row?.id ?? null };
    } catch (error) {
      return {
        status: "PERSISTENCE_ERROR" as PersistenceStatus,
        id: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async latest(league_slug: string, season: number): Promise<PublicationAudit | null> {
    const rows = await this.rest.select<Row>(TABLE, {
      filter: { league_slug: `eq.${league_slug}`, season: `eq.${season}` },
      order: "attempted_at.desc",
      limit: 1,
    });
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async recent(league_slug: string, season: number, limit = 20): Promise<PublicationAudit[]> {
    const rows = await this.rest.select<Row>(TABLE, {
      filter: { league_slug: `eq.${league_slug}`, season: `eq.${season}` },
      order: "attempted_at.desc",
      limit,
    });
    return rows.map(fromRow);
  }
}
