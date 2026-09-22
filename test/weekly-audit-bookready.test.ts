/**
 * Phase 9 Steps 50-51 — Book-Ready `audit.weekly_model` + Analysis Book (no chapter renamed/promoted casually).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { weeklyAuditEvidence, WEEKLY_AUDIT_TOPIC } from "@/lib/book-ready/families/weekly-audit";
import { TOPICS, getEvidence } from "@/lib/book-ready/query";
import { TOPIC_META } from "@/lib/analysis-book/topics";
import { CHAPTER_LIBRARY } from "@/lib/analysis-book/library";
import type { WeeklyModelAudit } from "@/lib/weekly-audit/contract";

const fixtureAudit = (): WeeklyModelAudit => ({
  audit_id: "wa:2026:1:v1:0000000000000000", season: 2026, week: 1, audit_schema_version: 1, evidence_digest: "0000000000000000",
  status: "WEEK_COMPLETE", severity: "INFO", generated_at: "2026-09-22T00:00:00Z",
  week_closure: { status: "WEEK_COMPLETE", season: 2026, week: 1, scheduled: 16, completed: 16, by_status: { complete: 16 }, reason: "all 16 scheduled games are complete", source: "sleeper", as_of: "x" },
  source_readiness: { status: "READY", data: [] }, freshness_history_recorded: true,
  projection_calibration: { status: "READY", data: { by_position: { WR: { n: 10, mae: 3.2, rmse: 4.1, signed_bias: 0.2 } }, severe_misses: [], severe_miss_threshold_points: 8, rows_evaluated: 10, rows_excluded_missing_actual: 0, rows_excluded_kdst_unsupported: 2 } },
  start_sit: { status: "READY", data: { decisions: [], calibration: { evidence_class: "LIVE_CAPTURED", decisions_evaluated: 3, decisions_unevaluable: 0, reversals: 1, reversals_helped: 0, reversals_hurt: 1, mean_baseline_regret: 0.1, mean_fi_regret: 0.4, by_family: {}, diagnostic_post_lock_decisions: 5, diagnostic_reconstructed_decisions: 0 } } },
  fi_weekly_calibration: { status: "READY", data: { by_family_position: [] } },
  matchup2: { status: "READY", data: { captures_evaluated: 12, outcomes_attached: 12, by_family: [{ family: "def_success_allowed", claim_kind: "ADVANTAGE", n: 12, aligned: 7, misses: { EVIDENCE_ALIGNED_OUTCOME_STRONG: 4, EVIDENCE_ALIGNED_OUTCOME_WEAK: 3, DIRECTIONAL_MISS: 5, PLAYER_ROLE_CHANGED: 0, INJURY_CONTEXT_CHANGED: 0, GAME_SCRIPT_CHANGED: 0, SOURCE_STALE: 0, SOURCE_MISSING: 0, OUTCOME_NOT_MEASURABLE: 0, INSUFFICIENT_SAMPLE: 0 } }], gate: {} } },
  waiver2: { status: "READY", data: { recommendations_evaluated: 4, executed: 1, not_executed: 2, claimed_by_other_manager: 1, market_findings: [], performance_findings: [], gate: {} } },
  role_changes: { status: "NOT_APPLICABLE", detail: "no persisted prior snapshot", data: null },
  prior_current_disagreements: { status: "NOT_APPLICABLE", data: null }, defense_shifts: { status: "NOT_APPLICABLE", data: null }, offense_shifts: { status: "NOT_APPLICABLE", data: null }, injury_opportunity: { status: "NOT_APPLICABLE", data: null },
  data_quality: [{ code: "INVALID_OR_MISSING_SCORING_FINGERPRINT", severity: "WATCH", scope: "ssc:9", detail: "x", rows_excluded: 1 }],
  research_candidates: [], fi_recertification_progress: [{ family: "def_success_allowed", position: "WR", certification_state: "CERTIFICATION_FAILED", qualifying_weeks: 1, live_decisions: 3, required_weeks: 4, required_decisions: 150, retest_signal: "RETEST_NOT_READY" }],
  limitations: ["Waiver2 realized.* fields require multi-week tracking not yet implemented."],
  lineage: { fi_version: "fi:2026:w01:x", scoring_fingerprints: ["scoring:v1:x"], temporal_data_version: null, sources: ["startsit-captures"] },
});

describe("Book-Ready `audit.weekly_model`", () => {
  test("topic is registered once, on the one query layer, mirrored by the Analysis Book topic table", () => {
    assert.ok(TOPICS[WEEKLY_AUDIT_TOPIC]); assert.equal(TOPICS[WEEKLY_AUDIT_TOPIC]!.surface, "weekly-model-audit"); assert.equal(TOPIC_META[WEEKLY_AUDIT_TOPIC]!.surface, "weekly-model-audit");
  });
  test("missing audit -> UNAVAILABLE, never a fabricated placeholder", () => {
    const blocks = weeklyAuditEvidence(null);
    assert.equal(blocks.length, 1); assert.equal(blocks[0]!.availability.state, "UNAVAILABLE");
  });
  test("status block reports severity, week closure and data-quality count; every block is descriptive-only", () => {
    const blocks = weeklyAuditEvidence(fixtureAudit());
    const st = blocks.find((b) => b.metric === "audit.status")!;
    assert.equal(st.value, "WEEK_COMPLETE"); assert.equal(st.deployment.may_influence_production, false); assert.equal(st.predictive?.class, "DESCRIPTIVE_ONLY");
  });
  test("a NOT_APPLICABLE component (role changes) never fabricates data when queried", () => {
    const blocks = weeklyAuditEvidence(fixtureAudit(), { section: "matchup2" });
    const m2 = blocks.find((b) => b.metric === "audit.matchup2")!; assert.equal(m2.availability.state, "AVAILABLE"); assert.equal(m2.value, 12);
  });
  test("fi_recertification section exposes RETEST_NOT_READY without ever implying promotion", () => {
    const blocks = weeklyAuditEvidence(fixtureAudit(), { section: "fi_recertification" });
    const b = blocks.find((x) => x.metric === "audit.fi_recertification_progress")!;
    assert.equal(b.value, "RETEST_NOT_READY"); assert.ok(b.components!.some((c) => c.key === "certification_state" && c.value === "CERTIFICATION_FAILED"));
  });
  test("data_quality section exposes the excluded scope and severity, never silently drops it", () => {
    const blocks = weeklyAuditEvidence(fixtureAudit(), { section: "data_quality" });
    const dq = blocks.find((b) => b.metric === "audit.data_quality_finding")!;
    assert.equal(dq.value, "INVALID_OR_MISSING_SCORING_FINGERPRINT");
  });
  test("getEvidence('audit.weekly_model') validates and returns OK for a required-params request shape", async () => {
    const r = await getEvidence({ topic: WEEKLY_AUDIT_TOPIC, params: { season: "2026", week: "1" } });
    assert.equal(r.status, "OK"); assert.equal(r.validation.ok, true);
  });
});

describe("Analysis Book — no chapter renamed/promoted merely because Phase 9 infrastructure exists", () => {
  test("chapter count unchanged (99) and no chapter requires the new topic", () => {
    assert.equal(Object.keys(CHAPTER_LIBRARY).length, 99);
    const uses = Object.values(CHAPTER_LIBRARY).filter((c) => c.needs.some((n) => n.topic === WEEKLY_AUDIT_TOPIC));
    assert.equal(uses.length, 0);
  });
});
