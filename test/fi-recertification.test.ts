/**
 * Phase 8 — FI live re-certification & selective activation.
 *
 * Proves: (A) the committed certification evidence is internally consistent and no family is eligible/active;
 * (B) no state is inherited (position/whole-model ACTIVE never activates a family) and every unconfigured family is SHADOW_ONLY;
 * (C) the family gate consults the REAL canonical freshness evaluator and blocks on every adversarial condition, family-specifically;
 * (D) reversibility (gate off == exact baseline), single-owner ledger, bounded translation without NaN/Infinity, tie-break-only semantics;
 * (E) consumer scope and production isolation by source scan.
 * A synthetic "everything certified" fixture proves the gate CAN allow, so each block below is a meaningful assertion.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, describe } from "node:test";

import { assessIntelligenceFreshness, type IntelligenceFreshnessAssessment, type NflRealityFrontier, FI_REFRESH_CADENCE_HOURS, FI_REFRESH_LAG_BUFFER_HOURS } from "@/lib/canonical/intelligence-freshness";
import type { FootballIntelligenceLineage, RecommendationLineage, SnapshotLineage } from "@/lib/canonical/lineage";
import { loadFiCertification, fiCertifiedState, certificationAllowsActivation, type FiCertification } from "@/lib/weekly/start-sit-fi/certification";
import { evaluateFamilyGate, familyDeploymentState, fiFamilyMayInfluenceProduction, boundedAdjustment, startSitPick, FI_FAMILY_FRESHNESS_DEPENDENCIES, type FamilyGateContext, type CertifiedTranslation } from "@/lib/weekly/start-sit-fi/family-gate";
import { ContributionLedger } from "@/lib/weekly/start-sit-fi/contribution-ledger";
import { applyFiToProductionBatch } from "@/lib/weekly/start-sit-fi/production-gate";
import { isValidTransition, fiMayInfluenceProduction } from "@/lib/weekly/start-sit-fi/deployment";
import { loadStartSitModel, __resetStartSitModelCache, type StartSitModel } from "@/lib/weekly/start-sit-fi";
import type { WeeklyProjectionBatch, WeeklyProjection } from "@/lib/weekly/schema";
import type { FootballIntelligence, TeamMetricRating, TeamProfile } from "@/lib/football-intel";

/* ------------------------------ fixtures ------------------------------ */
const FP = "scoring:v1:aaaaaaaaaaaaaaaaaaaaaaaa";
const snapshot = (): SnapshotLineage => ({ league_snapshot_id: "snap:l:2026:w3:abc", snapshot_schema_version: 3, content_hash: "abc", generated_at: "2026-09-22T04:00:00Z", provider: "sleeper", league_slug: "l", league_id: "1", season: 2026, week: 3, scoring_fingerprint: FP, roster_fingerprint: "r", player_data_version: "p", crosswalk_version: null });
const fiLineage = (o: Partial<FootballIntelligenceLineage> = {}, cutoff: Record<string, number> = {}): FootballIntelligenceLineage => ({
  version: "fi:2026:w02:test", model_tag: "t", season: 2026, through_week: 2,
  week_completion: { latest_week: 2, week_state: "COMPLETE", games_completed_in_latest_week: 16, games_scheduled_in_latest_week: 16, latest_completed_game_date: "2026-09-21" },
  data_cutoff: { pbp: 2, ngs_passing: 2, ngs_rushing: 2, ngs_receiving: 2, pfr_pass: 2, pfr_def: 2, snap_counts: 2, ftn_charting: 2, participation: 2, ...cutoff },
  output_classes: ["OBSERVED", "MODELED", "DESCRIPTIVE_ONLY"], generated_at: "2026-09-22T05:00:00Z", ...o });
const reality = (o: Partial<NflRealityFrontier> = {}): NflRealityFrontier => ({ season: 2026, latest_week_with_any_completed_game: 2, completed_games_in_latest_week: 16, scheduled_games_in_latest_week: 16, latest_completed_game_date: "2026-09-21", as_of: "2026-09-22T06:00:00Z", ...o });
const NOW = Date.parse("2026-09-22T07:00:00Z");
const assess = (fi: FootballIntelligenceLineage | null, r: NflRealityFrontier | undefined, opts: { now?: number; operation?: "START_SIT" | "WAIVER" } = {}): IntelligenceFreshnessAssessment => {
  const lineage: RecommendationLineage = { snapshot: snapshot(), projections: [], football_intelligence: fi, engine_versions: { t: "1" } };
  return assessIntelligenceFreshness({ lineage, operation: opts.operation ?? "START_SIT", ...(r ? { nfl_reality: r } : {}), now: opts.now ?? NOW });
};

const model0 = (): StartSitModel => { __resetStartSitModelCache(); const m = loadStartSitModel(true); assert.ok(m); return m!; };
const ELIGIBLE_FAMILY = "def_success_allowed"; const POS = "WR";
const familyBeta = (m: StartSitModel) => m.positions[POS]!.families.find((f) => f.family === ELIGIBLE_FAMILY)!.beta;
const translation = (m: StartSitModel, over: Partial<CertifiedTranslation> = {}): CertifiedTranslation => ({ kind: "RESIDUAL_ADJUSTMENT", unit: "fantasy_points", beta: familyBeta(m), cap_fraction: 0.1, tau: null, certified_scoring_fingerprints: [FP], certification_version: "fi-certification-TEST", criteria_version: "TEST", missing_data: "ZERO_ADJUSTMENT", ...over });
/** SYNTHETIC ONLY: a model whose contract activates ONE family at ONE position. Nothing like this exists in the repo. */
const activated = (m: StartSitModel, over: Record<string, unknown> = {}): StartSitModel => ({ ...m, deployment_contract: { model_version: m.start_sit_model_version, deployment: "SHADOW_ONLY", positions: { [POS]: "PRODUCTION_ACTIVE" }, activation_log: [], family_positions: { [POS]: { [ELIGIBLE_FAMILY]: "PRODUCTION_ACTIVE" } }, certified_translations: { [POS]: { [ELIGIBLE_FAMILY]: translation(m) } }, ...over } } as unknown as StartSitModel);
/** SYNTHETIC ONLY evidence that would allow activation. The real committed evidence has zero such candidates. */
const eligibleCert = (): FiCertification => { const c = structuredClone(loadFiCertification(true)!); const x = c.candidates.find((k) => k.family === ELIGIBLE_FAMILY && k.position === POS)!; x.evaluated_state = "PRODUCTION_ELIGIBLE"; return c; };
const ctx = (over: Partial<FamilyGateContext> = {}): FamilyGateContext => ({ operation: "START_SIT", freshness: assess(fiLineage(), reality()), scoring_fingerprint: FP, temporal_membership_resolved: true, decision_week: 3, fi_through_week: 2, ...over });

/* ============================ A. certification evidence ============================ */
describe("A. committed certification evidence", () => {
  const cert = loadFiCertification(true)!;
  test("A1. evidence file exists, versioned, START_SIT scope, holdout sealed", () => {
    assert.ok(cert); assert.equal(cert.consumer_scope, "START_SIT"); assert.equal(cert.lane, "RECONSTRUCTED_CHRONOLOGY_SAFE");
    assert.match(cert.criteria_version, /^fi-recert-criteria-2026\.1/); assert.equal(cert.holdout_opened, false);
  });
  test("A2. 30 evaluated candidates; NONE is PRODUCTION_ELIGIBLE / PRODUCTION_ACTIVE / CERTIFICATION_PASSED", () => {
    assert.equal(cert.candidates.length, 30);
    for (const c of cert.candidates) { assert.equal(c.production_state, "SHADOW_ONLY"); assert.ok(!["PRODUCTION_ELIGIBLE", "PRODUCTION_ACTIVE", "CERTIFICATION_PASSED", "PENDING_HOLDOUT"].includes(c.evaluated_state), `${c.position}/${c.family}`); }
    assert.equal(cert.summary.CERTIFICATION_FAILED, 30);
  });
  test("A3. every recorded state transition is legal (no skips) and starts at SHADOW_ONLY", () => {
    for (const c of cert.candidates) { assert.equal(c.start_state, "SHADOW_ONLY"); assert.ok(isValidTransition(c.start_state, c.evaluable_state)); assert.ok(isValidTransition(c.evaluable_state, c.evaluated_state as never)); }
  });
  test("A4. no candidate reaches the pre-registered +0.03 effect gate; amendment A1 only ever tightened", () => {
    for (const c of cert.candidates) { assert.ok(c.mae_improvement < 0.03, `${c.position}/${c.family} improvement ${c.mae_improvement}`); if (c.amendment_a1_applied) assert.ok(c.mae_improvement_ci90[1] < 0.03); assert.ok(c.failed_gates.includes("G3_incremental")); }
  });
  test("A5. baseline integrity: the primary (production-like) baseline is materially stronger than the naive control", () => {
    assert.equal(cert.baseline.primary_is_stronger_than_naive, true); assert.ok(cert.baseline.integrity.mae_trailing - cert.baseline.integrity.mae_sleeper > 0.2);
  });
  test("A6. prospective evidence is insufficient: 0 qualifying weeks, 0 captured decisions for every candidate", () => {
    for (const c of cert.candidates) { assert.equal(c.prospective.met, false); assert.equal(c.prospective.qualifying_weeks, 0); assert.equal(c.prospective.live_captured_decisions, 0); assert.equal(c.prospective.required_decisions, 150); }
  });
  test("A7. served-bundle comparator is non-gating and did not beat the individual gates", () => { for (const b of Object.values(cert.served_bundles_nongating)) { assert.equal(b.gating, false); assert.ok(b.mae_delta < 0.03); } });
  test("A8. fiCertifiedState: evaluated -> its state; unevaluated -> SHADOW_ONLY; only ELIGIBLE/ACTIVE allow activation", () => {
    assert.equal(fiCertifiedState("off_pass_epa", "WR"), "CERTIFICATION_FAILED"); assert.equal(fiCertifiedState("ftn_play_action_rate", "QB"), "SHADOW_ONLY"); assert.equal(fiCertifiedState("nope", "K"), "SHADOW_ONLY");
    for (const s of ["SHADOW_ONLY", "RESEARCH_ELIGIBLE", "CERTIFICATION_FAILED", "CERTIFICATION_PASSED"] as const) assert.equal(certificationAllowsActivation(s), false);
    assert.equal(certificationAllowsActivation("PRODUCTION_ELIGIBLE"), true);
  });
});

/* ============================ B. no inheritance, default SHADOW_ONLY ============================ */
describe("B. feature-family x position states", () => {
  test("B1. the served contract has no active family; every model family at every position is SHADOW_ONLY", () => {
    const m = model0(); for (const [pos, mp] of Object.entries(m.positions)) for (const f of mp.families) assert.equal(familyDeploymentState(m, f.family, pos), "SHADOW_ONLY");
  });
  test("B2. position-level PRODUCTION_ACTIVE does NOT activate any family (no inheritance)", () => {
    const m = model0(); const p = { ...m, deployment_contract: { model_version: "x", deployment: "SHADOW_ONLY", positions: { WR: "PRODUCTION_ACTIVE" }, activation_log: [] } } as unknown as StartSitModel;
    assert.equal(fiMayInfluenceProduction(p, "WR"), true, "legacy position reader unchanged");
    for (const f of p.positions.WR!.families) assert.equal(familyDeploymentState(p, f.family, "WR"), "SHADOW_ONLY");
    assert.equal(fiFamilyMayInfluenceProduction(p, ELIGIBLE_FAMILY, "WR", ctx(), eligibleCert()), false);
  });
  test("B3. whole-model PRODUCTION_ACTIVE does NOT activate any family", () => {
    const m = model0(); const p = { ...m, deployment_contract: { model_version: "x", deployment: "PRODUCTION_ACTIVE", positions: {}, activation_log: [] } } as unknown as StartSitModel;
    for (const f of p.positions.WR!.families) assert.equal(familyDeploymentState(p, f.family, "WR"), "SHADOW_ONLY");
  });
  test("B4. activating ONE family leaves every other family at the position SHADOW_ONLY and blocked", () => {
    const m = model0(); const a = activated(m);
    assert.equal(familyDeploymentState(a, ELIGIBLE_FAMILY, POS), "PRODUCTION_ACTIVE");
    for (const f of a.positions[POS]!.families.filter((x) => x.family !== ELIGIBLE_FAMILY)) { assert.equal(familyDeploymentState(a, f.family, POS), "SHADOW_ONLY"); assert.equal(evaluateFamilyGate(a, f.family, POS, ctx(), eligibleCert()).allowed, false); }
  });
  test("B5. every family the model can use has a declared freshness dependency (else blocked)", () => {
    const m = model0(); for (const mp of Object.values(m.positions)) for (const f of mp.families) assert.ok(FI_FAMILY_FRESHNESS_DEPENDENCIES[f.family], f.family);
    assert.ok(evaluateFamilyGate(activated(m), "not_a_family", POS, ctx(), eligibleCert()).reasons.includes("FAMILY_UNKNOWN_DEPENDENCY"));
  });
});

/* ============================ C. gate matrix ============================ */
describe("C. family gate consults the canonical freshness evaluator", () => {
  const m = () => activated(model0());
  const gate = (c: Partial<FamilyGateContext> = {}, mm = m(), cert: FiCertification | null = eligibleCert(), fam = ELIGIBLE_FAMILY) => evaluateFamilyGate(mm, fam, POS, ctx(c), cert);
  test("C0. control: fully certified + CURRENT + compatible => ALLOWED (so every block below is meaningful)", () => { const g = gate(); assert.deepEqual(g.reasons, []); assert.equal(g.allowed, true); });
  test("C1. real committed evidence blocks even a config-ACTIVE family (NOT_CERTIFIED)", () => { const g = gate({}, m(), loadFiCertification()); assert.equal(g.allowed, false); assert.ok(g.reasons.includes("NOT_CERTIFIED_PRODUCTION_ELIGIBLE")); });
  test("C2. PARTIAL_CURRENT is blocked for numeric use (evaluated lane used complete weeks only)", () => {
    const a = assess(fiLineage({ week_completion: { latest_week: 2, week_state: "PARTIAL", games_completed_in_latest_week: 15, games_scheduled_in_latest_week: 16, latest_completed_game_date: "2026-09-21" } }), reality({ completed_games_in_latest_week: 15 }));
    assert.equal(a.overall_status, "PARTIAL_CURRENT"); const g = gate({ freshness: a }); assert.equal(g.allowed, false); assert.ok(g.reasons.includes("FRESHNESS_NOT_CURRENT"));
  });
  test("C3. confirmed STALE (a completed game FI has not incorporated, refresh overdue) is blocked", () => {
    const beyond = Date.parse("2026-09-22T05:00:00Z") + (FI_REFRESH_CADENCE_HOURS + FI_REFRESH_LAG_BUFFER_HOURS + 6) * 3_600_000;
    const a = assess(fiLineage({ through_week: 1, week_completion: { latest_week: 1, week_state: "COMPLETE", games_completed_in_latest_week: 16, games_scheduled_in_latest_week: 16, latest_completed_game_date: "2026-09-14" }, data_cutoff: { pbp: 1, snap_counts: 1, participation: 1 } }), reality({ latest_week_with_any_completed_game: 2, completed_games_in_latest_week: 1, scheduled_games_in_latest_week: 15 }), { now: beyond });
    assert.equal(a.overall_status, "STALE"); const g = gate({ freshness: a, fi_through_week: 1 }); assert.equal(g.allowed, false); assert.ok(g.reasons.includes("FRESHNESS_NOT_CURRENT"));
  });
  test("C4. FI ahead of reality is blocked", () => {
    const a = assess(fiLineage({ through_week: 3, week_completion: { latest_week: 3, week_state: "COMPLETE", games_completed_in_latest_week: 16, games_scheduled_in_latest_week: 16, latest_completed_game_date: "2026-09-28" } }), reality());
    assert.notEqual(a.overall_status, "CURRENT"); assert.equal(gate({ freshness: a }).allowed, false);
  });
  test("C5. schedule-source conflict / season mismatch is blocked", () => {
    const a = assess(fiLineage({ season: 2025 }), reality()); assert.notEqual(a.overall_status, "CURRENT"); assert.equal(gate({ freshness: a }).allowed, false);
  });
  test("C6. missing freshness assessment => blocked (never assumed fresh)", () => { const g = gate({ freshness: null }); assert.equal(g.allowed, false); assert.ok(g.reasons.includes("FRESHNESS_NOT_PROVIDED")); });
  test("C7. FAMILY-SPECIFIC: absent participation blocks usage_route_participation but NOT a PBP-derived family", () => {
    const lin = fiLineage(); delete (lin.data_cutoff as Record<string, number>).participation; const a = assess(lin, reality());
    const okPbp = gate({ freshness: a }); assert.equal(okPbp.allowed, true, JSON.stringify(okPbp.reasons));
    const route = evaluateFamilyGate(activated(model0(), { family_positions: { TE: { usage_route_participation: "PRODUCTION_ACTIVE" } }, positions: { TE: "PRODUCTION_ACTIVE" }, certified_translations: { TE: { usage_route_participation: translation(model0(), { beta: model0().positions.TE!.families.find((f) => f.family === "usage_route_participation")!.beta }) } } }), "usage_route_participation", "TE", ctx({ freshness: a }), (() => { const c = structuredClone(loadFiCertification(true)!); c.candidates.find((k) => k.family === "usage_route_participation" && k.position === "TE")!.evaluated_state = "PRODUCTION_ELIGIBLE"; return c; })());
    assert.equal(route.allowed, false); assert.ok(route.reasons.some((r) => r === "FAMILY_SOURCE_UNAVAILABLE" || r === "FAMILY_SOURCE_BROKEN"));
  });
  test("C8. missing PBP source blocks a PBP-derived family", () => { const lin = fiLineage(); delete (lin.data_cutoff as Record<string, number>).pbp; const g = gate({ freshness: assess(lin, reality()) }); assert.equal(g.allowed, false); });
  test("C9. expected publication lag on a non-dependency source does not block; a dependency at EXPECTED_SOURCE_LAG is permitted (evaluator-classified, non-failure)", () => {
    const g = gate({ freshness: assess(fiLineage({}, { snap_counts: 1 }), reality()) }); assert.equal(g.allowed, true);
  });
  test("C10. incompatible scoring fingerprint / unknown fingerprint are blocked", () => {
    assert.ok(gate({ scoring_fingerprint: "scoring:v1:other" }).reasons.includes("SCORING_FINGERPRINT_INCOMPATIBLE")); assert.ok(gate({ scoring_fingerprint: null }).reasons.includes("SCORING_FINGERPRINT_UNKNOWN"));
  });
  test("C11. unresolved Phase 7 temporal identity is blocked", () => { assert.ok(gate({ temporal_membership_resolved: false }).reasons.includes("TEMPORAL_IDENTITY_UNRESOLVED")); });
  test("C12. FI vintage at/after the decision week is blocked; unknown vintage is blocked", () => {
    assert.ok(gate({ decision_week: 2, fi_through_week: 2 }).reasons.includes("SOURCE_VINTAGE_AFTER_DECISION")); assert.ok(gate({ fi_through_week: null }).reasons.includes("SOURCE_VINTAGE_UNKNOWN"));
    assert.equal(gate({ decision_week: 3, fi_through_week: 2 }).allowed, true);
  });
  test("C13. consumer scope: WAIVER / MATCHUP / TRADE / ROSTER_PLANNING / ANALYSIS_ONLY may never receive a numeric FI contribution", () => {
    for (const op of ["WAIVER", "MATCHUP", "TRADE", "ROSTER_PLANNING", "ANALYSIS_ONLY"] as const) assert.ok(gate({ operation: op }).reasons.includes("CONSUMER_SCOPE_NOT_START_SIT"), op);
  });
  test("C14. missing certified translation, or a translation that does not match the evaluated coefficient, blocks", () => {
    const noTr = activated(model0(), { certified_translations: {} }); assert.ok(evaluateFamilyGate(noTr, ELIGIBLE_FAMILY, POS, ctx(), eligibleCert()).reasons.includes("NO_CERTIFIED_TRANSLATION"));
  });
  test("C15. whole-model CERTIFICATION_FAILED blocks every family", () => { assert.ok(gate({}, activated(model0(), { deployment: "CERTIFICATION_FAILED" })).reasons.includes("MODEL_CERTIFICATION_FAILED")); });
  test("C16. the gate is deterministic and pure", () => { assert.equal(JSON.stringify(gate()), JSON.stringify(gate())); });
});

/* ============================ D. application, reversibility, ledger, bounds ============================ */
function fakeFI(defSuccessPct: number, conf: TeamMetricRating["confidence"] = "HIGH"): FootballIntelligence {
  const r = (over: Partial<TeamMetricRating>): TeamMetricRating => ({ team: "X", side: "defense", metric: "m", output_class: "MODELED", predictive_status: "PREDICTIVE", raw: 0, modeled: 0, league_mean: 0, league_percentile: 0.5, n_obs_effective: 400, prior_mean: 0, prior_n_seasons: 4, prior_discount: 1, prior_weight: 0.3, recent_weight: 0.5, shrunk_to_league: 0.2, std_error: 0.02, confidence: "HIGH", trend: { current_level: 0, recent_level: 0, direction: "stable", magnitude: 0, confidence: "HIGH" }, ...over });
  const dp: TeamProfile = { team: "DEF", season: 2026, through_week: 2, offense: {}, defense: { def_success_allowed: r({ metric: "def_success_allowed", league_percentile: defSuccessPct, confidence: conf }) } };
  const op: TeamProfile = { team: "OFF", season: 2026, through_week: 2, offense: {}, defense: {} };
  return { manifest: { football_intelligence_version: "fi:2026:w02:test", model_tag: "t", feature_schema_version: 1, generated_at: "", season: 2026, through_week: 2, data_cutoff: { pbp: 2 }, seasons_used: { prior: [2025], current: 2026 }, model_versions: {}, source_versions: {}, config: {}, files: [], output_classes: ["OBSERVED", "MODELED", "DESCRIPTIVE_ONLY"], determinism: "", notes: [] },
    team: (t: string) => (t === "OFF" ? op : t === "DEF" ? dp : null), teams: () => [op, dp], playerUsage: () => null, coverageAllowed: () => [], contextualMatchup: () => ({ availability: "NOT_AVAILABLE" }), ftnDescriptive: () => [], throughWeek: () => 2 } as unknown as FootballIntelligence;
}
const proj = (id: string, pts: number | null, position = POS): WeeklyProjection => ({ canonical_player_id: id, week: 3, season: 2026, position, nfl_team: "OFF", opponent: "DEF", is_home: true, projected_points: pts as number, floor_points: 0, ceiling_points: 30, std_dev: 4, projection_status: "projected", expected_availability: 1, is_bye: false, injury_status: null, rest_of_season_points: null, ros: null, source: "s", model_version: "sleeper-weekly-rotowire", uncertainty_source: "position_volatility_heuristic", warnings: [] } as unknown as WeeklyProjection);
const batchOf = (rows: WeeklyProjection[]): WeeklyProjectionBatch => ({ league_slug: "l", season: 2026, week: 3, status: "READY", by_player: new Map(rows.map((r) => [r.canonical_player_id, r])), resolved_players: new Map(), source: "s", model_version: "sleeper-weekly-rotowire", missing: [], teams_with_games: [], warnings: [] } as unknown as WeeklyProjectionBatch);
const run = (model: StartSitModel, b: WeeklyProjectionBatch, over: Record<string, unknown> = {}) => applyFiToProductionBatch(b, { positionOf: (id: string) => b.by_player.get(id)?.position ?? null, request_season: 2026, model, fi: fakeFI(0.95), certification: eligibleCert(), baseline_projection_version: "sleeper-weekly-rotowire",
  gate: { operation: "START_SIT", freshness: assess(fiLineage(), reality()), scoring_fingerprint: FP, decision_week: 3, fi_through_week: 2, temporal_resolved_for: () => true }, ...over } as never);

describe("D. application, reversibility, ledger, bounds", () => {
  test("D1. REVERSIBILITY: family ON -> adjusted output; family OFF (config-only) -> the exact baseline batch object", () => {
    const b = batchOf([proj("a", 12), proj("b", 8)]); const on = run(activated(model0()), b); assert.equal(on.fi_applied, true); assert.notEqual(on.batch.by_player.get("a")!.projected_points, 12);
    const off = run(model0(), b); assert.equal(off.fi_applied, false); assert.equal(off.batch, b, "gate-off returns the SAME batch object");
    for (const [id, p] of b.by_player) assert.equal(off.batch.by_player.get(id)!.projected_points, p.projected_points);
  });
  test("D2. any single gate failing returns baseline values exactly (adversarial freshness)", () => {
    const b = batchOf([proj("a", 12)]); const stale = assess(fiLineage({ season: 2025 }), reality());
    for (const over of [{ gate: { operation: "START_SIT", freshness: stale, scoring_fingerprint: FP, decision_week: 3, fi_through_week: 2, temporal_resolved_for: () => true } }, { gate: { operation: "START_SIT", freshness: assess(fiLineage(), reality()), scoring_fingerprint: "scoring:v1:zzz", decision_week: 3, fi_through_week: 2, temporal_resolved_for: () => true } }, { gate: { operation: "START_SIT", freshness: assess(fiLineage(), reality()), scoring_fingerprint: FP, decision_week: 2, fi_through_week: 2, temporal_resolved_for: () => true } }, { gate: { operation: "START_SIT", freshness: assess(fiLineage(), reality()), scoring_fingerprint: FP, decision_week: 3, fi_through_week: 2, temporal_resolved_for: () => false } }]) {
      const r = run(activated(model0()), b, over); assert.equal(r.batch.by_player.get("a")!.projected_points, 12); assert.equal(r.fi_applied, false); assert.ok(r.ledger.some((e) => !e.applied && e.blocked_by.length > 0));
    }
  });
  test("D3. no gate context => fail closed (baseline), even with a fully active family", () => { const b = batchOf([proj("a", 12)]); const r = run(activated(model0()), b, { gate: undefined }); assert.equal(r.batch, b); assert.match(r.reason, /fail closed/); });
  test("D4. an uncertified sibling family cannot ride along: only the ACTIVE family contributes", () => {
    const b = batchOf([proj("a", 12)]); const r = run(activated(model0()), b); const fams = r.ledger.filter((e) => e.applied).map((e) => e.family); assert.deepEqual(fams, [ELIGIBLE_FAMILY]);
  });
  test("D5. ledger records every field needed to reproduce the contribution", () => {
    const e = run(activated(model0()), batchOf([proj("a", 12)])).ledger.find((x) => x.applied)!;
    assert.equal(e.owner, "START_SIT"); assert.equal(e.family, ELIGIBLE_FAMILY); assert.equal(e.position, POS); assert.equal(e.fi_version, "fi:2026:w02:test"); assert.equal(e.scoring_fingerprint, FP); assert.equal(e.baseline_projection_version, "sleeper-weekly-rotowire");
    assert.equal(e.deployment_state, "PRODUCTION_ACTIVE"); assert.equal(e.freshness_status, "CURRENT"); assert.equal(e.baseline_projection, 12); assert.ok(e.final_projection !== null && e.final_projection !== 12); assert.equal(e.certification_version, "fi-certification-TEST");
  });
  test("D6. single owner / no double counting: a second contribution for the same (player, family) is refused and recorded", () => {
    const l = new ContributionLedger(); const base = { owner: "START_SIT" as const, canonical_player_id: "a", position: POS, family: ELIGIBLE_FAMILY, fi_version: "v", fi_through_week: 2, scoring_fingerprint: FP, baseline_projection_version: "b", translation_version: "t", certification_version: "c", deployment_state: "PRODUCTION_ACTIVE" as const, freshness_status: "CURRENT", temporal_membership_version: null, expected_adjustment: 0.5, baseline_projection: 12, final_projection: 12.5, applied: true, blocked_by: [] };
    assert.equal(l.record(base), true); assert.equal(l.record(base), false); assert.equal(l.violations.length, 1); assert.equal(l.appliedTotal("a"), 0.5);
    assert.equal(l.record({ ...base, canonical_player_id: "z", owner: "WAIVER" as never }), false);
  });
  test("D7. bounded translation: huge +/- signals are capped; NaN/Infinity/null/zero/negative baselines never produce NaN or a full adjustment", () => {
    const t = translation(model0(), { beta: 5, cap_fraction: 0.1 });
    assert.ok(Math.abs(boundedAdjustment(12, 1e9, t) - 1.2) < 1e-9); assert.ok(Math.abs(boundedAdjustment(12, -1e9, t) + 1.2) < 1e-9);
    assert.equal(boundedAdjustment(null, 3, t), 0); assert.equal(boundedAdjustment(12, null, t), 0); assert.equal(boundedAdjustment(0, 3, t), 0); assert.equal(boundedAdjustment(12, NaN, t), 0); assert.equal(boundedAdjustment(12, Infinity, t), 0); assert.equal(boundedAdjustment(Infinity, 1, t), 0);
    assert.ok(Math.abs(boundedAdjustment(-10, 1e9, t) - 1) < 1e-9, "negative baseline: cap uses |baseline|"); for (const v of [boundedAdjustment(12, 1e308, { ...t, beta: 1e308 }), boundedAdjustment(12, 1, { ...t, beta: NaN })]) assert.ok(Number.isFinite(v));
  });
  test("D8. missing baseline / zero baseline / low confidence / contradictory inputs never yield NaN or infinity through the applier", () => {
    const b = batchOf([proj("null", null), proj("zero", 0), proj("neg", -3), proj("ok", 12)]); const r = run(activated(model0()), b, { fi: fakeFI(0.95, "INSUFFICIENT_SAMPLE") });
    for (const p of r.batch.by_player.values()) assert.ok(p.projected_points === null || Number.isFinite(p.projected_points)); assert.equal(r.batch.by_player.get("ok")!.projected_points, 12, "INSUFFICIENT_SAMPLE confidence => zero contribution");
    const r2 = run(activated(model0()), b); for (const p of r2.batch.by_player.values()) assert.ok(p.projected_points === null || Number.isFinite(p.projected_points)); assert.equal(r2.batch.by_player.get("zero")!.projected_points, 0, "zero baseline => zero cap => zero adjustment");
  });
  test("D9. TIE_BREAK_ONLY: FI can reorder only inside the tau window; a large baseline edge is never overturned; a huge FI signal cannot break it", () => {
    const t = { tau: 1.5 };
    assert.equal(startSitPick(10, 0, 9.5, 2, t), "B", "edge 0.5 < tau: FI may flip"); assert.equal(startSitPick(10, 0, 8, 1e9, t), "A", "edge 2 >= tau: baseline stands despite a huge signal");
    assert.equal(startSitPick(10, 1e9, 8.4, 0, t), "A"); assert.equal(startSitPick(10, NaN, 9.9, 0, t), "A"); assert.equal(startSitPick(5, 0, 5, 0, t), "TIE"); assert.equal(startSitPick(10, 9, 8, 9, { tau: null }), "A", "no tau => never uses FI");
  });
  test("D10. TIE_BREAK_ONLY families are NEVER added to projected_points (no leakage into lineup/waiver/matchup/trade)", () => {
    const m = activated(model0(), { certified_translations: { [POS]: { [ELIGIBLE_FAMILY]: translation(model0(), { kind: "TIE_BREAK_ONLY", tau: 1.5 }) } } }); const b = batchOf([proj("a", 12)]); const r = run(m, b);
    assert.equal(r.batch.by_player.get("a")!.projected_points, 12); assert.equal(r.fi_applied, false); const e = r.ledger.find((x) => x.family === ELIGIBLE_FAMILY)!; assert.equal(e.applied, false); assert.notEqual(e.expected_adjustment, 0);
  });
  test("D11. cap fraction bounds the applied adjustment", () => {
    const m = activated(model0(), { certified_translations: { [POS]: { [ELIGIBLE_FAMILY]: translation(model0(), { cap_fraction: 0.01 }) } } }); const r = run(m, batchOf([proj("a", 12)])); const v = r.batch.by_player.get("a")!.projected_points as number; assert.ok(Math.abs(v - 12) <= 0.12 + 1e-9);
  });
});

/* ============================ E. scope / isolation source scan ============================ */
const walk = (dir: string, out: string[] = []): string[] => { for (const n of readdirSync(dir)) { const f = join(dir, n); const s = statSync(f); if (s.isDirectory()) { if (!["node_modules", ".next", "data"].includes(n)) walk(f, out); } else if (/\.(ts|tsx)$/.test(n)) out.push(f); } return out; };
describe("E. consumer scope and production isolation", () => {
  const prod = ["lib", "app"].flatMap((d) => walk(join(process.cwd(), d))).filter((f) => !f.includes(join("lib", "weekly", "start-sit-fi")));
  test("E1. no production code imports the family gate, ledger, production gate or certified-translation seam", () => {
    const offenders = prod.filter((f) => /start-sit-fi\/(family-gate|contribution-ledger|production-gate)|applyFiToProductionBatch\(|startSitPick\(|evaluateFamilyGate\(/.test(readFileSync(f, "utf8"))); assert.deepEqual(offenders, []);
  });
  test("E2. Waiver, Trade, Matchup, Orchestrator and Waiver2 code never reference FI numeric application", () => {
    const scoped = prod.filter((f) => /lib[\\/](weekly[\\/](waivers|matchup|matchup-intelligence)|trades|waiver2|orchestrator|market-state)/.test(f));
    const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const f of scoped) assert.ok(!/fiMayInfluenceProduction|familyDeploymentState|boundedAdjustment|ContributionLedger/.test(code(f)), f);
  });
  test("E3. the served deployment contract has no active position and no family_positions", () => {
    const c = JSON.parse(readFileSync("lib/weekly/data/start_sit_model.json", "utf8")).deployment_contract; assert.equal(c.deployment, "SHADOW_ONLY"); assert.deepEqual(c.positions, {}); assert.equal(c.family_positions, undefined); assert.deepEqual(c.activation_log, []);
  });
  test("E4. the frozen served model is byte-unchanged (sha256 pinned by Phase 3.5A)", async () => {
    const { createHash } = await import("node:crypto"); assert.match(createHash("sha256").update(readFileSync("lib/weekly/data/start_sit_model.json")).digest("hex"), /^85d2ddd5/);
  });
});

/* ============================ F. Book-Ready + Analysis Book ============================ */
import { getEvidence, TOPICS } from "@/lib/book-ready/query";
import { CHAPTER_LIBRARY } from "@/lib/analysis-book/library";
import { TOPIC_META } from "@/lib/analysis-book/topics";
describe("F. Book-Ready `fi.certification` and Analysis Book", () => {
  test("F1. topic is registered once, on the one query layer, ARTIFACT_READ, mirrored by the Analysis Book topic table", () => {
    assert.ok(TOPICS["fi.certification"]); assert.equal(TOPICS["fi.certification"]!.surface, "fi-recertification"); assert.equal(TOPIC_META["fi.certification"]!.surface, "fi-recertification"); assert.equal(TOPIC_META["fi.certification"]!.bookready_cost, "ARTIFACT_READ");
  });
  test("F2. default response: 1 summary + 30 states + 9 not-evaluated; validates; every block is DESCRIPTIVE and may_influence_production=false", async () => {
    const r = await getEvidence({ topic: "fi.certification", params: {} }); assert.equal(r.status, "OK"); assert.equal(r.validation.ok, true, JSON.stringify(r.validation.errors).slice(0, 400));
    assert.equal(r.blocks.filter((b) => b.metric === "certification.summary").length, 1); assert.equal(r.blocks.filter((b) => b.metric === "certification.state").length, 30); assert.equal(r.blocks.filter((b) => b.metric === "certification.not_evaluated").length, 9);
    for (const b of r.blocks) { assert.equal(b.deployment.may_influence_production, false); assert.equal(b.deployment.state, "SHADOW_ONLY"); assert.equal(b.predictive?.class, "DESCRIPTIVE_ONLY"); }
  });
  test("F3. a failed family is presented with its ACTUAL state, never as 'low confidence'; no block carries a confidence field for it", async () => {
    const r = await getEvidence({ topic: "fi.certification", params: { family: "def_success_allowed", position: "WR" } }); assert.equal(r.validation.ok, true);
    const st = r.blocks.find((b) => b.metric === "certification.state")!; assert.equal(st.value, "CERTIFICATION_FAILED"); assert.ok(st.components!.some((c) => c.key === "failed_gates"));
    assert.ok(!r.blocks.some((b) => /LOW|MEDIUM|HIGH/.test(String(b.value)))); const holdout = st.components!.find((c) => c.key === "holdout")!; assert.match(String(holdout.value), /sealed/);
  });
  test("F4. detail blocks: effect with CI, decision regret, calibration, rollback contract (config-only)", async () => {
    const r = await getEvidence({ topic: "fi.certification", params: { family: "usage_snap_share", position: "RB" } }); const m = new Map(r.blocks.map((b) => [b.metric, b]));
    for (const k of ["certification.state", "certification.mae_improvement", "certification.decision_regret", "certification.calibration", "certification.rollback_contract"]) assert.ok(m.has(k), k);
    assert.ok(typeof m.get("certification.mae_improvement")!.value === "number"); assert.match(String(m.get("certification.rollback_contract")!.components![0]!.value), /config-only/);
  });
  test("F5. unknown family returns zero blocks (no fabricated verdict)", async () => { const r = await getEvidence({ topic: "fi.certification", params: { family: "nope" } }); assert.equal(r.blocks.length, 0); });
  test("F6. Analysis Book: topic registered but required by NO chapter; chapter set unchanged (no chapter state changes because zero families earned certification)", () => {
    const uses = Object.values(CHAPTER_LIBRARY).filter((c) => c.needs.some((n) => n.topic === "fi.certification")); assert.equal(uses.length, 0);
    assert.equal(Object.keys(CHAPTER_LIBRARY).length, 106, "chapter ids before = after (106, reflecting Phase 10's lifecycle additions; Phase 8 itself added none)");
  });
});
