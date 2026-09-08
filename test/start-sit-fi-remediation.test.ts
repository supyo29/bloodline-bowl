/**
 * Phase 4 remediation (A + C) — deployment-state contract, production guard,
 * dormant re-evaluation pipeline, candidate versioning, live-capture labelling,
 * and the no-auto-promotion rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadStartSitModel,
  __resetStartSitModelCache,
  deploymentContract,
  fiMayInfluenceProduction,
  anyFiProductionInfluence,
  isValidTransition,
  applyFiToProductionBatch,
  loadReevaluationManifest,
  reevaluationStatus,
  reevaluationEligible,
  nextCandidateVersion,
  __resetReevaluationCache,
  NullCaptureStore,
  FileCaptureStore,
  captureShadowDecision,
  type ReevaluationManifest,
  type StartSitModel,
} from "@/lib/weekly/start-sit-fi";
import type { WeeklyProjectionBatch, WeeklyProjection } from "@/lib/weekly/schema";
import type { StartSitShadowComparison } from "@/lib/weekly/start-sit-fi";

const model = (): StartSitModel => {
  __resetStartSitModelCache();
  const m = loadStartSitModel(true);
  assert.ok(m);
  return m!;
};

/* -------------------- Part A: deployment contract + guard -------------------- */

test("A: served model carries an explicit deployment_contract, SHADOW_ONLY", () => {
  const c = deploymentContract(model());
  assert.equal(c.deployment, "SHADOW_ONLY");
  assert.deepEqual(c.positions, {});
  assert.deepEqual(c.activation_log, []);
});

test("A: fiMayInfluenceProduction is false for every position under the current contract", () => {
  const m = model();
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    assert.equal(fiMayInfluenceProduction(m, pos), false);
  }
  assert.equal(anyFiProductionInfluence(m), false);
});

function batch(proj: Partial<WeeklyProjection>[]): WeeklyProjectionBatch {
  const by = new Map<string, WeeklyProjection>();
  proj.forEach((p, i) => {
    by.set(`p${i}`, {
      canonical_player_id: `p${i}`, week: 5, season: 2026, position: p.position ?? "RB",
      nfl_team: "KC", opponent: "DEN", is_home: true, projected_points: p.projected_points ?? 12,
      floor_points: 6, ceiling_points: 20, std_dev: 4, projection_status: "projected",
      expected_availability: 1, is_bye: false, injury_status: null, rest_of_season_points: null,
      ros: null, source: "s", model_version: "sleeper-weekly-rotowire",
      uncertainty_source: "position_volatility_heuristic", warnings: [],
    });
  });
  return { league_slug: "l", season: 2026, week: 5, status: "READY", by_player: by,
    resolved_players: new Map(), source: "s", model_version: "sleeper-weekly-rotowire",
    missing: [], teams_with_games: [], warnings: [] } as unknown as WeeklyProjectionBatch;
}

test("A: applyFiToProductionBatch is a strict no-op under the current (SHADOW_ONLY) contract", () => {
  const b = batch([{ position: "RB" }, { position: "WR" }]);
  const r = applyFiToProductionBatch(b, {
    positionOf: (id) => b.by_player.get(id)?.position ?? null,
    request_season: 2026,
    model: model(),
  });
  assert.equal(r.fi_applied, false);
  assert.equal(r.deployment, "SHADOW_ONLY");
  for (const [id, p] of b.by_player) {
    assert.equal(r.batch.by_player.get(id)!.projected_points, p.projected_points);
  }
});

test("A: applyFiToProductionBatch ONLY applies when a position is explicitly PRODUCTION_ACTIVE", () => {
  const m = model();
  // synthetic activation for RB only
  const activated: StartSitModel = {
    ...m,
    // @ts-expect-error injecting the contract the finalize step would write
    deployment_contract: {
      model_version: m.start_sit_model_version, deployment: "SHADOW_ONLY",
      positions: { RB: "PRODUCTION_ACTIVE" }, activation_log: [{ position: "RB", state: "PRODUCTION_ACTIVE", at: "x", by: "test", note: "synthetic" }],
    },
  };
  assert.equal(fiMayInfluenceProduction(activated, "RB"), true);
  assert.equal(fiMayInfluenceProduction(activated, "WR"), false);
  const b = batch([{ position: "RB", projected_points: 12 }, { position: "WR", projected_points: 12 }]);
  const r = applyFiToProductionBatch(b, {
    positionOf: (id) => b.by_player.get(id)?.position ?? null,
    request_season: 2026, model: activated, fi: null,
  });
  // fi is null -> still no change (needs a snapshot too); but WR is untouched regardless
  assert.equal(r.batch.by_player.get("p1")!.projected_points, 12);
});

test("A: deployment lifecycle forbids skipping states", () => {
  assert.equal(isValidTransition("SHADOW_ONLY", "RESEARCH_ELIGIBLE"), true);
  assert.equal(isValidTransition("SHADOW_ONLY", "PRODUCTION_ACTIVE"), false);
  assert.equal(isValidTransition("RESEARCH_ELIGIBLE", "CERTIFICATION_PASSED"), true);
  assert.equal(isValidTransition("CERTIFICATION_PASSED", "PRODUCTION_ELIGIBLE"), true);
  assert.equal(isValidTransition("PRODUCTION_ELIGIBLE", "PRODUCTION_ACTIVE"), true);
  assert.equal(isValidTransition("RESEARCH_ELIGIBLE", "PRODUCTION_ELIGIBLE"), false);
  assert.equal(isValidTransition("RESEARCH_ELIGIBLE", "CERTIFICATION_FAILED"), true);
  assert.equal(isValidTransition("CERTIFICATION_FAILED", "PRODUCTION_ACTIVE"), false);
  assert.equal(isValidTransition("PRODUCTION_ACTIVE", "SHADOW_ONLY"), true); // rollback allowed
});

/* -------------------- Part C: re-evaluation mechanism -------------------- */

test("C: re-evaluation manifest exists, is NOT_ELIGIBLE, 0 genuine 2026 FI weeks", () => {
  __resetReevaluationCache();
  const m = loadReevaluationManifest(true);
  assert.ok(m, "start_sit_reevaluation_manifest.json present");
  assert.equal(m!.season, 2026);
  assert.equal(m!.completed_fi_weeks, 0);
  assert.equal(m!.reevaluation_eligible, false);
  assert.equal(reevaluationStatus(m), "NOT_ELIGIBLE");
  assert.equal(m!.next_candidate_version, "ri-startsit-2026.2");
  assert.equal(m!.minimum_weeks_required, 4);
});

test("C: the prior-only FI snapshot does not count as a current-season week", () => {
  const m = loadReevaluationManifest(true)!;
  assert.equal(m.fi_snapshot_is_current_season, false);
  assert.match(m.not_eligible_reason ?? "", /does not count/);
});

test("C: candidate versioning — 2026.1 is immutable, next is 2026.2", () => {
  assert.equal(nextCandidateVersion("ri-startsit-2026.1"), "ri-startsit-2026.2");
  assert.equal(nextCandidateVersion("ri-startsit-2026.2"), "ri-startsit-2026.3");
  // the served model is still 2026.1 and SHADOW_ONLY
  assert.equal(model().start_sit_model_version, "ri-startsit-2026.1");
});

const synthManifest = (over: Partial<ReevaluationManifest>): ReevaluationManifest => ({
  current_model_version: "ri-startsit-2026.1", deployment: "SHADOW_ONLY", season: 2026,
  completed_fi_weeks: 0, completed_fi_week_list: [], minimum_weeks_required: 4, preferred_weeks: 6,
  per_week_requirements: [], reevaluation_eligible: false, reevaluation_status: "NOT_ELIGIBLE",
  not_eligible_reason: null, last_evaluated_through_week: null, next_candidate_version: "ri-startsit-2026.2",
  cadence: { first_check_week: 4, second_check_week: 6, thereafter_every_weeks: 3 },
  live_captured_decisions: 0, historically_reconstructed_decisions: 0,
  generated_at: "x", refresh_command: "x",
  ...over,
});

test("C: synthetic eligibility transitions (Week 3 / Week 4 insufficient / Week 4 valid)", () => {
  // week 3 -> NOT_ELIGIBLE
  assert.equal(reevaluationEligible(synthManifest({ completed_fi_weeks: 3, completed_fi_week_list: [1, 2, 3] })), false);
  // week 4 but the R gate did not certify per-week coverage -> NOT_ELIGIBLE
  assert.equal(
    reevaluationEligible(synthManifest({ completed_fi_weeks: 4, completed_fi_week_list: [1, 2, 3, 4], reevaluation_eligible: false })),
    false,
  );
  // week 4 with valid coverage -> ELIGIBLE
  const ok = synthManifest({ completed_fi_weeks: 4, completed_fi_week_list: [1, 2, 3, 4], reevaluation_eligible: true, reevaluation_status: "ELIGIBLE" });
  assert.equal(reevaluationEligible(ok), true);
  assert.equal(reevaluationStatus(ok), "ELIGIBLE");
});

test("C: no auto-promotion — a PASSED research verdict does not change production routing", () => {
  const passed = synthManifest({
    completed_fi_weeks: 6, completed_fi_week_list: [1, 2, 3, 4, 5, 6],
    reevaluation_eligible: true, reevaluation_status: "PASSED",
    last_evaluated_through_week: 6,
    per_position_verdict: [{ position: "RB", verdict: "PRODUCTION_ELIGIBLE" }],
  });
  assert.equal(reevaluationStatus(passed), "PASSED");
  // the served model's deployment contract is UNCHANGED by any manifest state
  const c = deploymentContract(model());
  assert.equal(c.deployment, "SHADOW_ONLY");
  assert.deepEqual(c.positions, {});
  assert.equal(fiMayInfluenceProduction(model(), "RB"), false);
});

/* -------------------- Part C: live-capture labelling -------------------- */

const fakeCmp = (): StartSitShadowComparison => ({
  lineage: {
    start_sit_model_version: "ri-startsit-2026.1", football_intelligence_version: "fi:2025:w18:x",
    football_intel_data_cutoff: { pbp: 18 }, baseline_projection_version: "sleeper-weekly-rotowire",
    decision_generated_at: new Date().toISOString(), deployment: "SHADOW_ONLY",
    contract_version: "start-sit-fi-2026.1",
  },
  adjustments: [{
    canonical_player_id: "p1", position: "RB", nfl_team: "KC", opponent: "DEN",
    baseline_projection: 12, raw_expected_adjustment: 0.1, expected_adjustment: 0.1,
    floor_adjustment: 0, ceiling_adjustment: 0, adjusted_projection: 12.1,
    decision_confidence: "MEDIUM", contributions: [], reason_codes: ["FI_SHADOW_ONLY"],
    warnings: [], fi_prior_season_only: true, fi_available: true,
  }],
  baseline_lineup_total: 100, fi_lineup_total: 100, lineup_differs: false, lineup_deltas: [],
  start_sit_deltas: [], notes: [],
});

test("C: capture labels LIVE_CAPTURED vs HISTORICALLY_RECONSTRUCTED and never mixes silently", () => {
  const live = captureShadowDecision(fakeCmp(), { season: 2026, week: 1, league_slug: "l", manager_slug: "m", scoring_fingerprint: "scoring:v1:abc" });
  assert.equal(live.capture_kind, "LIVE_CAPTURED");
  const recon = captureShadowDecision(fakeCmp(), { season: 2025, week: 5, league_slug: "l", manager_slug: "m", scoring_fingerprint: null, kind: "HISTORICALLY_RECONSTRUCTED" });
  assert.equal(recon.capture_kind, "HISTORICALLY_RECONSTRUCTED");
  assert.equal(recon.actual_fantasy_points, null); // filled in later, once known
});

test("C: NullCaptureStore is a no-op; FileCaptureStore writes labelled JSONL", () => {
  new NullCaptureStore().record(); // must not throw
  const dir = mkdtempSync(join(tmpdir(), "sscap-"));
  const store = new FileCaptureStore(dir);
  const rec = fakeCmp();
  store.record({ ...captureShadowDecision(rec, { season: 2026, week: 2, league_slug: "l", manager_slug: "m", scoring_fingerprint: null }), capture_kind: "LIVE_CAPTURED" });
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  assert.ok(files.length >= 1);
  const line = JSON.parse(readFileSync(join(dir, files[0]!), "utf8").trim().split("\n")[0]!);
  assert.ok(["LIVE_CAPTURED", "HISTORICALLY_RECONSTRUCTED"].includes(line.capture_kind));
  assert.equal(line.season, 2026);
});
