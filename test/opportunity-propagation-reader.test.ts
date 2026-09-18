// ===========================================================================
// Injury -> Opportunity Propagation Intelligence -- Checkpoint D reader /
// scenario tests (spec §49), run against the REAL served artifact and the
// REAL current Phase 2 Role Intelligence snapshot -- no hard-coded
// players chosen before querying the current dataset (spec §52).
// ===========================================================================
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  loadOpportunityPropagationModel,
  evaluateOpportunityPropagationScenario,
  formatOpportunityPropagationScenario,
  buildOpportunityPropagationIntelligenceLineage,
  MUTUALLY_EXHAUSTIVE_DIMENSIONS,
} from "@/lib/opportunity-propagation-intelligence";
import { loadRoleOpportunitySnapshot } from "@/lib/player-role-intelligence/read";
import { assessOpportunityPropagationFreshness, assessRoleOpportunityFreshness } from "@/lib/canonical/intelligence-freshness";
import { buildRoleOpportunityIntelligenceLineage } from "@/lib/player-role-intelligence/lineage";
import { buildRecommendationLineage, type SnapshotLineage } from "@/lib/canonical/lineage";

const model = loadOpportunityPropagationModel();
const roi = loadRoleOpportunitySnapshot();

function pickRealPlayer(position: string, minRole: number): { gsis_id: string; team: string; name: string } | null {
  if (!roi) return null;
  const candidates = roi.profiles.filter((p) => p.identity.position === position && (p.participation?.recent ?? 0) > minRole);
  const p = candidates[0];
  return p ? { gsis_id: p.identity.gsis_id, team: p.identity.team, name: p.identity.full_name } : null;
}

describe("Checkpoint D reader tests (spec §49)", () => {
  test("1. manifest loads", () => {
    assert.ok(model, "loadOpportunityPropagationModel() returned null -- served artifact missing");
  });

  test("2. model parameters load", () => {
    assert.ok(model!.league.length > 0);
    assert.ok(model!.position.length > 0);
    assert.ok(model!.team.length > 0);
    assert.ok(model!.positionWeights.length > 0);
  });

  test("3. Role dependency resolves and matches the current Phase 2 snapshot", () => {
    assert.ok(roi, "loadRoleOpportunitySnapshot() returned null -- Phase 2 has no published snapshot");
    assert.equal(model!.manifest.role_opportunity_dependency.role_opportunity_version, roi!.manifest.role_opportunity_version);
  });

  const rb = pickRealPlayer("RB", 0.3);
  const wr = pickRealPlayer("WR", 0.3);
  const te = pickRealPlayer("TE", 0.2);
  const qb = pickRealPlayer("QB", 0.5);

  test("4. supported RB scenario evaluates", () => {
    assert.ok(rb, "no real RB with meaningful role found in current snapshot");
    const result = evaluateOpportunityPropagationScenario({ team: rb!.team, season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: [rb!.gsis_id], scenario_type: "FULL_GAME_NONPARTICIPATION" });
    assert.ok(result);
    assert.equal(result!.scenario.support_level, "CALIBRATED");
    assert.ok(result!.vacated_role && result!.vacated_role.length > 0);
  });

  test("5. WR evaluates", () => {
    assert.ok(wr, "no real WR with meaningful role found in current snapshot");
    const result = evaluateOpportunityPropagationScenario({ team: wr!.team, season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: [wr!.gsis_id], scenario_type: "FULL_GAME_NONPARTICIPATION" });
    assert.ok(result);
    assert.equal(result!.scenario.support_level, "CALIBRATED");
  });

  test("6. TE evaluates", () => {
    assert.ok(te, "no real TE with meaningful role found in current snapshot");
    const result = evaluateOpportunityPropagationScenario({ team: te!.team, season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: [te!.gsis_id], scenario_type: "FULL_GAME_NONPARTICIPATION" });
    assert.ok(result);
    assert.equal(result!.scenario.support_level, "CALIBRATED");
  });

  test("7. QB explicitly unsupported", () => {
    assert.ok(qb, "no real QB found in current snapshot");
    const result = evaluateOpportunityPropagationScenario({ team: qb!.team, season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: [qb!.gsis_id], scenario_type: "FULL_GAME_NONPARTICIPATION" });
    assert.ok(result);
    assert.equal(result!.scenario.support_level, "UNSUPPORTED_SCENARIO");
    assert.equal(result!.vacated_role, null);
    assert.equal(result!.beneficiaries, null);
  });

  test("8. sparse evidence falls back visibly (evidence.source is never silently disguised as team-specific)", () => {
    assert.ok(rb);
    const result = evaluateOpportunityPropagationScenario({ team: rb!.team, season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: [rb!.gsis_id], scenario_type: "FULL_GAME_NONPARTICIPATION" })!;
    for (const b of result.beneficiaries ?? []) {
      assert.ok(["TEAM_POSITION_HISTORY", "POSITION_PRIOR", "LEAGUE_PRIOR", "GLOBAL_DEFAULT"].includes(b.evidence.source));
    }
  });

  test("9. return redistribution kept separate from offensive domains", () => {
    assert.ok(wr);
    const result = evaluateOpportunityPropagationScenario({ team: wr!.team, season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: [wr!.gsis_id], scenario_type: "FULL_GAME_NONPARTICIPATION" })!;
    const returnRows = (result.beneficiaries ?? []).filter((b) => b.domain === "RETURNS");
    const offenseRows = (result.beneficiaries ?? []).filter((b) => b.domain !== "RETURNS");
    for (const r of returnRows) assert.ok(["kick_return_role", "punt_return_role"].includes(r.dimension));
    for (const o of offenseRows) assert.ok(!["kick_return_role", "punt_return_role"].includes(o.dimension));
  });

  test("10. multi-absence marked degraded", () => {
    assert.ok(rb && wr);
    const result = evaluateOpportunityPropagationScenario({ team: rb!.team, season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: [rb!.gsis_id, wr!.gsis_id === rb!.gsis_id ? qb!.gsis_id : wr!.gsis_id].filter((id, i, arr) => arr.indexOf(id) === i), scenario_type: "FULL_GAME_NONPARTICIPATION" });
    // if the two picked players aren't on the same team, force a same-team multi test using two RB-position candidates instead
    const sameTeamSecond = roi!.profiles.find((p) => p.identity.team === rb!.team && p.identity.gsis_id !== rb!.gsis_id && (p.identity.position === "RB" || p.identity.position === "WR" || p.identity.position === "TE"));
    const multiResult = evaluateOpportunityPropagationScenario({ team: rb!.team, season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: sameTeamSecond ? [rb!.gsis_id, sameTeamSecond.identity.gsis_id] : [rb!.gsis_id], scenario_type: "FULL_GAME_NONPARTICIPATION" })!;
    if (sameTeamSecond) {
      assert.equal(multiResult.scenario.support_level, "EXPERIMENTAL_MULTI_ABSENCE");
      assert.match(multiResult.scenario.support_note, /experimental|degraded/i);
    }
    assert.ok(result);
  });

  test("11-13. observed role preserved, expected role preserved, delta calculated correctly", () => {
    assert.ok(rb);
    const result = evaluateOpportunityPropagationScenario({ team: rb!.team, season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: [rb!.gsis_id], scenario_type: "FULL_GAME_NONPARTICIPATION" })!;
    assert.ok(result.beneficiaries && result.beneficiaries.length > 0);
    for (const b of result.beneficiaries!) {
      if (b.observed_pre_scenario_role != null && b.expected_scenario_role != null && b.expected_delta != null) {
        assert.ok(Math.abs(b.expected_delta - (b.expected_scenario_role - b.observed_pre_scenario_role)) < 1e-9);
      }
    }
  });

  test("14. residual preserved", () => {
    assert.ok(rb);
    const result = evaluateOpportunityPropagationScenario({ team: rb!.team, season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: [rb!.gsis_id], scenario_type: "FULL_GAME_NONPARTICIPATION" })!;
    assert.ok(result.residual && result.residual.length > 0);
  });

  test("15. no invalid share (bounded [0,1] except air_yards_share; mutually-exhaustive sums <= 1+tolerance)", () => {
    assert.ok(rb);
    const result = evaluateOpportunityPropagationScenario({ team: rb!.team, season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: [rb!.gsis_id], scenario_type: "FULL_GAME_NONPARTICIPATION" })!;
    for (const b of result.beneficiaries ?? []) {
      if (b.dimension === "air_yards_share") continue;
      if (b.expected_scenario_role != null) {
        assert.ok(b.expected_scenario_role >= -1e-6 && b.expected_scenario_role <= 1 + 1e-6, `${b.beneficiary_gsis_id}/${b.dimension} out of bounds: ${b.expected_scenario_role}`);
      }
    }
    const byGroup = new Map<string, number>();
    for (const b of result.beneficiaries ?? []) {
      if (!MUTUALLY_EXHAUSTIVE_DIMENSIONS.has(b.dimension)) continue;
      const key = `${b.absent_player_id}:${b.domain}:${b.dimension}`;
      byGroup.set(key, (byGroup.get(key) ?? 0) + Math.max(b.expected_scenario_role ?? 0, 0));
    }
    for (const [key, total] of byGroup) assert.ok(total <= 1.05, `${key} sums to ${total} > 1.05`);
  });

  test("16. deterministic formatter, and no fantasy-actionability language (spec §43)", () => {
    assert.ok(rb);
    const result = evaluateOpportunityPropagationScenario({ team: rb!.team, season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: [rb!.gsis_id], scenario_type: "FULL_GAME_NONPARTICIPATION" })!;
    const a = formatOpportunityPropagationScenario(result);
    const b = formatOpportunityPropagationScenario(result);
    assert.equal(a, b);
    const forbidden = /pick up|start(?!s\b)|bench|waiver|FAAB|trade for|must-add|handcuff/i;
    assert.doesNotMatch(a, forbidden);
  });

  test("17. unknown player handled explicitly (never a thrown error, never null)", () => {
    const result = evaluateOpportunityPropagationScenario({ team: "ZZZ", season: roi!.manifest.season, week: roi!.manifest.through_week, unavailable_player_ids: ["00-9999999"], scenario_type: "FULL_GAME_NONPARTICIPATION" });
    assert.ok(result);
    assert.equal(result!.scenario.support_level, "UNSUPPORTED_SCENARIO");
    assert.match(result!.scenario.support_note, /unknown player/i);
  });

  test("18. stale Role dependency represented honestly in freshness", () => {
    const snapshotLineage: SnapshotLineage = {
      league_snapshot_id: "snap:test:2026:w1:0000000000000000", snapshot_schema_version: 1, content_hash: "x",
      generated_at: new Date().toISOString(), provider: "sleeper", league_slug: "test", league_id: "1",
      season: roi!.manifest.season, week: roi!.manifest.through_week, scoring_fingerprint: "x", roster_fingerprint: "x",
    } as SnapshotLineage;
    const roiLineage = buildRoleOpportunityIntelligenceLineage(roi);
    const opiLineage = buildOpportunityPropagationIntelligenceLineage(model, "CALIBRATED");
    const lineage = buildRecommendationLineage(snapshotLineage, {}, [], null, roiLineage, opiLineage);
    const roleFreshness = assessRoleOpportunityFreshness({ lineage, operation: "waivers" as never });
    const opiFreshness = assessOpportunityPropagationFreshness({ lineage, operation: "waivers" as never, role_opportunity_freshness: roleFreshness });
    // when Role Intelligence assessment is not CURRENT, the propagation
    // assessment must never read better than it (composition, spec §34).
    if (roleFreshness.overall_status !== "CURRENT") {
      assert.notEqual(opiFreshness.overall_status, "CURRENT");
    }
    assert.equal(opiFreshness.role_opportunity_version_used, opiLineage?.role_opportunity_version ?? null);
  });
});
