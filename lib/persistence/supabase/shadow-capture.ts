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
/** max LIVE_CAPTURED rows whose decision/adjustment JSON the diagnostic will read. */
export const LIVE_DETAIL_CAP = 300;

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

  /** Read-only export of VALID pre-kickoff evidence + its outcomes, for the R candidate evaluation. */
  async exportLiveEvidence(): Promise<{ records: ShadowDecisionRecord[]; outcomes: ShadowOutcomeRecord[] }> {
    const rows = await this.rest.select<{ record: ShadowDecisionRecord }>(CAPTURES, {
      select: "record", filter: { capture_kind: "eq.LIVE_CAPTURED" }, order: "decision_timestamp.asc", limit: SUMMARY_ROW_CAP,
    });
    const outs = await this.rest.select<{ capture_id: string; source: string; scoring_fingerprint: string | null; actual_fantasy_points: Record<string, number>; recorded_at: string }>(
      OUTCOMES, { select: "*", limit: SUMMARY_ROW_CAP },
    );
    return { records: rows.map((r) => r.record), outcomes: outs };
  }

  /**
   * Bounded, lightweight diagnostics. Phase 3.5B: the previous version pulled the FULL ~14 KB `record` for up to
   * 5000 rows on an unauthenticated route (unbounded read amplification as evidence grows). Now:
   *   1. counts by class / week / model / FI / scoring come from a NARROW column select (no JSON payload);
   *   2. per-position decision counts (valid LIVE_CAPTURED evidence only) read just the decisions+adjustments
   *      JSON of at most LIVE_DETAIL_CAP recent live rows, and are flagged `per_position_truncated` if more exist.
   * Evidence fidelity is untouched: nothing is compacted, deleted or rewritten.
   */
  async summary(): Promise<CaptureSummary> {
    try {
      const light = await this.rest.select<{
        capture_id: string; capture_kind: string; season: number; week: number;
        start_sit_model_version: string; football_intelligence_version: string | null; scoring_fingerprint: string | null;
      }>(CAPTURES, {
        select: "capture_id,capture_kind,season,week,start_sit_model_version,football_intelligence_version,scoring_fingerprint",
        order: "decision_timestamp.desc",
        limit: SUMMARY_ROW_CAP,
      });
      const liveCount = light.filter((r) => r.capture_kind === "LIVE_CAPTURED").length;
      const heavy = liveCount === 0 ? [] : await this.rest.select<{ capture_id: string; decisions: ShadowDecisionRecord["decisions"]; adjustments: ShadowDecisionRecord["adjustments"] }>(CAPTURES, {
        select: "capture_id,decisions:record->decisions,adjustments:record->adjustments",
        filter: { capture_kind: "eq.LIVE_CAPTURED" },
        order: "decision_timestamp.desc",
        limit: LIVE_DETAIL_CAP,
      });
      const detail = new Map(heavy.map((h) => [h.capture_id, h]));
      const recs = light.map((r) => ({
        capture_kind: r.capture_kind, season: r.season, week: r.week,
        start_sit_model_version: r.start_sit_model_version, football_intelligence_version: r.football_intelligence_version,
        scoring_fingerprint: r.scoring_fingerprint,
        decisions: detail.get(r.capture_id)?.decisions ?? [], adjustments: detail.get(r.capture_id)?.adjustments ?? [],
      })) as unknown as ShadowDecisionRecord[];
      const outcomes = await this.rest.select<{ capture_id: string }>(OUTCOMES, { select: "capture_id", limit: SUMMARY_ROW_CAP });
      const s = summarize(recs, outcomes.length, this.kind, true);
      s.record_count = light.length;
      s.counts_truncated = light.length >= SUMMARY_ROW_CAP;
      s.per_position_truncated = liveCount > heavy.length;
      if (s.counts_truncated) s.error = `class counts truncated at ${SUMMARY_ROW_CAP} rows`;
      return s;
    } catch (e) {
      return emptySummary(this.kind, true, false, e instanceof Error ? e.message : String(e));
    }
  }
}
