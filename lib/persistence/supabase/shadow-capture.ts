/**
 * Supabase-backed durable store for Start/Sit shadow-decision evidence (Phase 3.5A).
 *
 * Tables: public.bridge_startsit_shadow_captures / _outcomes (INSERT-only, enforced by trigger).
 * Idempotency is the DATABASE primary key (`capture_id`): `insertIgnoreDuplicates` returns the rows
 * actually inserted, so `[]` means "already captured" -- safe under concurrency and across instances.
 */
import {
  emptySummary,
  summarize,
  type CaptureSummary,
  type CaptureWriteResult,
  type ShadowCaptureStore,
  type ShadowDecisionRecord,
  type ShadowOutcomeRecord,
} from "@/lib/weekly/start-sit-fi/capture";
import { SupabaseRest } from "./rest";

const CAPTURES = "bridge_startsit_shadow_captures";
const OUTCOMES = "bridge_startsit_shadow_outcomes";
const SUMMARY_ROW_CAP = 5000;

export function captureRow(rec: ShadowDecisionRecord): Record<string, unknown> {
  return {
    capture_id: rec.capture_id,
    capture_kind: rec.capture_kind,
    season: rec.season,
    week: rec.week,
    league_slug: rec.league_slug,
    manager_slug: rec.manager_slug,
    scoring_fingerprint: rec.scoring_fingerprint,
    start_sit_model_version: rec.start_sit_model_version,
    football_intelligence_version: rec.football_intelligence_version,
    baseline_projection_version: rec.baseline_projection_version,
    decision_timestamp: rec.decision_timestamp,
    content_hash: rec.content_hash,
    record_schema_version: rec.record_schema_version,
    lock_verdict: rec.lock_evidence?.verdict ?? null,
    record: rec,
  };
}

export class SupabaseShadowCaptureStore implements ShadowCaptureStore {
  readonly kind = "supabase";
  readonly durable = true;
  constructor(private readonly rest: SupabaseRest) {}

  async record(rec: ShadowDecisionRecord): Promise<CaptureWriteResult> {
    const base = { durable: true, store_kind: this.kind, capture_id: rec.capture_id ?? null };
    if (!rec.capture_id || !rec.content_hash || rec.record_schema_version == null) {
      return { ...base, status: "ERROR", error: "record is missing capture_id/content_hash (legacy record cannot be persisted)" };
    }
    try {
      const inserted = await this.rest.insertIgnoreDuplicates<{ capture_id: string }>(CAPTURES, [captureRow(rec)], ["capture_id"]);
      return { ...base, status: inserted.length > 0 ? "CREATED" : "DUPLICATE" };
    } catch (e) {
      return { ...base, status: "ERROR", error: e instanceof Error ? e.message : String(e) };
    }
  }

  async recordOutcome(o: ShadowOutcomeRecord): Promise<CaptureWriteResult> {
    const base = { durable: true, store_kind: this.kind, capture_id: o.capture_id };
    try {
      const inserted = await this.rest.insertIgnoreDuplicates<{ capture_id: string }>(
        OUTCOMES,
        [{ capture_id: o.capture_id, source: o.source, scoring_fingerprint: o.scoring_fingerprint, actual_fantasy_points: o.actual_fantasy_points, recorded_at: o.recorded_at }],
        ["capture_id", "source"],
      );
      return { ...base, status: inserted.length > 0 ? "CREATED" : "DUPLICATE" };
    } catch (e) {
      return { ...base, status: "ERROR", error: e instanceof Error ? e.message : String(e) };
    }
  }

  async summary(): Promise<CaptureSummary> {
    try {
      const rows = await this.rest.select<{ record: ShadowDecisionRecord }>(CAPTURES, { select: "record", order: "decision_timestamp.desc", limit: SUMMARY_ROW_CAP });
      const outcomes = await this.rest.select<{ capture_id: string }>(OUTCOMES, { select: "capture_id", limit: SUMMARY_ROW_CAP });
      const s = summarize(rows.map((r) => r.record), outcomes.length, this.kind, true);
      if (rows.length >= SUMMARY_ROW_CAP) s.error = `summary truncated at ${SUMMARY_ROW_CAP} rows`;
      return s;
    } catch (e) {
      return emptySummary(this.kind, true, false, e instanceof Error ? e.message : String(e));
    }
  }
}
