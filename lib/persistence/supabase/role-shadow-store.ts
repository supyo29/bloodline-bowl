/**
 * W2.P2 — Supabase-backed durable store for Role Shadow captures (table `bridge_role_shadow_captures`, migration 20261013180000).
 *
 * TELEMETRY ONLY: never on a ranking or decision path, never fails a caller. Idempotency is the DATABASE primary key (`capture_id`, content-addressed):
 * `insertIgnoreDuplicates` returns the rows actually inserted, so `[]` means "already captured" — safe under concurrent writers and across instances.
 * The database independently refuses late evidence (trigger on its own clock) and any UPDATE/DELETE; this class never issues either.
 */

import { validateRecord, type RoleShadowRecord } from "@/lib/role-shadow/record";
import { lateReason, type CaptureFilter, type RoleShadowStore, type WriteResult } from "@/lib/role-shadow/store";
import { SupabaseRest, SupabaseRestError } from "./rest";

export const ROLE_SHADOW_TABLE = "bridge_role_shadow_captures";
const LIST_PAGE = 1000;
const LIST_MAX_ROWS = 50_000;

export function captureRow(r: RoleShadowRecord): Record<string, unknown> {
  return {
    capture_id: r.capture_id,
    capture_class: r.capture_class,
    season: r.season,
    week: r.week,
    league_slug: r.league_slug,
    provider: r.provider,
    canonical_player_id: r.player.canonical_player_id,
    gsis_id: r.player.gsis_id,
    position: r.player.position,
    challenger_model_id: r.models.challenger.id,
    challenger_config_hash: r.models.challenger.config_hash,
    control_config_hash: r.models.control.config_hash,
    scoring_fingerprint: r.scoring.fingerprint,
    scoring_compatibility: r.scoring.compatibility,
    kickoff_at: r.game.kickoff_at,
    captured_at: r.timing.captured_at,
    source_observed_at: r.timing.source_observed_at,
    eligible: r.population.eligible,
    content_hash: r.content_hash,
    record_schema_version: r.schema_version,
    record: r,
  };
}

export class SupabaseRoleShadowStore implements RoleShadowStore {
  readonly kind = "supabase";
  readonly durable = true;
  constructor(private readonly rest: SupabaseRest, private readonly now: () => number = Date.now) {}

  async record(r: RoleShadowRecord): Promise<WriteResult> {
    const base = { store_kind: this.kind, durable: true };
    const errs = validateRecord(r);
    if (errs.length) return { ...base, status: "REFUSED_INVALID", reason: errs.join("; ") };
    const late = lateReason(r, this.now());
    if (late) return { ...base, status: "REFUSED_LATE", reason: late };
    try {
      const inserted = await this.rest.insertIgnoreDuplicates<{ capture_id: string }>(ROLE_SHADOW_TABLE, [captureRow(r)], ["capture_id"]);
      return { ...base, status: inserted.length > 0 ? "INSERTED" : "DUPLICATE_IDENTICAL" };
    } catch (e) {
      // the wrapper never echoes response bodies: classify by structured code (P0001 = the database's own late-evidence refusal, 23514 = CHECK)
      if (e instanceof SupabaseRestError && e.code === "P0001") return { ...base, status: "REFUSED_LATE", reason: "database clock is at/after kickoff" };
      if (e instanceof SupabaseRestError && e.code === "23514") return { ...base, status: "REFUSED_INVALID", reason: "database CHECK constraint refused the record" };
      return { ...base, status: "ERROR", reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async list(f: CaptureFilter = {}): Promise<RoleShadowRecord[]> {
    const filter: Record<string, string> = {};
    if (f.season != null) filter.season = `eq.${f.season}`;
    if (f.week != null) filter.week = `eq.${f.week}`;
    if (f.league_slug) filter.league_slug = `eq.${f.league_slug}`;
    if (f.capture_class) filter.capture_class = `eq.${f.capture_class}`;
    if (f.challenger_config_hash) filter.challenger_config_hash = `eq.${f.challenger_config_hash}`;
    const out: RoleShadowRecord[] = [];
    for (let offset = 0; offset < LIST_MAX_ROWS; offset += LIST_PAGE) {
      const page = await this.rest.select<{ record: RoleShadowRecord }>(ROLE_SHADOW_TABLE, { select: "record", filter, order: "captured_at.asc,capture_id.asc", limit: LIST_PAGE, offset });
      out.push(...page.map((p) => p.record));
      if (page.length < LIST_PAGE) break;
    }
    return out;
  }
}
