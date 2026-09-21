/** Phase 5 Checkpoint G — evaluation evidence, chronology safety, descriptive/predictive separation. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { anyPredictiveIncremental, evaluationFor, evaluationLine, evaluationRows } from "@/lib/matchup2/evaluation";
import { buildMatchupContext } from "@/lib/matchup2/context";
import { evaluatePlayer } from "@/lib/matchup2/engine";
import { FEATURE_FAMILIES } from "@/lib/matchup2/registry";
import type { MatchupEvaluation } from "@/lib/matchup2/contract";
import { mkSource, mkPlayer, TEAMS } from "./fixtures/matchup2";

test("evaluation evidence: 7 Phase 9 + 6 Phase 5 families, one production-like baseline, walk-forward, zero PREDICTIVE_INCREMENTAL", () => {
  const rows = evaluationRows(); assert.equal(rows.filter((r) => r.study === "PHASE9_TIER_D").length, 7); assert.equal(rows.filter((r) => r.study === "PHASE5_WALKFORWARD").length, 6);
  assert.equal(anyPredictiveIncremental(), false); assert.ok(rows.every((r) => r.n_test != null && r.n_test > 1000));
  const j = JSON.parse(readFileSync("lib/matchup2/data/walkforward_results.json", "utf8")); assert.deepEqual(j.test_seasons, [2022, 2023, 2024, 2025]); assert.match(j.baseline, /production-like/); assert.equal(j.chronology.future_mutation_invariance, true); assert.equal(j.chronology.profiles_for_season_S_use, "seasons <= S-1 only"); assert.match(j.target, /residual vs baseline/);
  for (const r of j.rows) { assert.ok(["PREDICTIVE_INCREMENTAL", "EXPLANATORY_ONLY", "UNSTABLE", "REJECTED", "INSUFFICIENT_DATA"].includes(r.class)); assert.ok(Math.abs(r.delta_mae_vs_b1) < 0.05, `${r.family}: incremental value beyond the baseline is negligible in fantasy points`); }
  assert.match(evaluationLine(rows.find((r) => r.family === "wr_man_zone")!), /no incremental predictive value/);
});
test("derived predictive class: a candidate family with no incremental value is EVALUATED_NO_INCREMENTAL_VALUE and its component says so; numeric adjustment stays null", () => {
  const s = mkSource({ players: [{ gsis: "wr", pos: "WR", epaMan: 0, epaZone: 0.3 }, { gsis: "rb", pos: "RB" }, { gsis: "qb", pos: "QB" }] });
  for (const id of ["wr", "rb", "qb"]) { const e = evaluatePlayer(s, buildMatchupContext(s, { offense_team: "T00", defense_team: "T20", week: 3 }), id) as MatchupEvaluation;
    for (const c of e.components.filter((x) => evaluationFor(x.family, x.position))) { assert.equal(c.predictive_class, "EVALUATED_NO_INCREMENTAL_VALUE", c.id); assert.ok(c.limitations.some((l) => /no incremental predictive value beyond the baseline/.test(l)), c.id); }
    assert.equal(e.numeric_adjustment, null); }
  const cand = FEATURE_FAMILIES.filter((f) => f.predictive_class === "PREDICTIVE_CANDIDATE_UNVALIDATED"); assert.ok(cand.length >= 6);
});
test("chronology: only the prior-season aggregate windows are admissible — rows labelled with any other (current/future) window are ignored, never used as evidence", () => {
  const good = mkPlayer({ gsis: "wr", pos: "WR", epaMan: 0, epaZone: 0.3 }); const poisoned = { ...good, receiver_coverage: good.receiver_coverage.map((r) => ({ ...r, window: "2026_wk3_future" })), receiver_cells: good.receiver_cells.map((c) => ({ ...c, window: "2026_wk3_future" })) };
  const src = mkSource(); const s2 = { ...src, resolvePlayer: (id: string) => (id === "wr" ? poisoned : null) };
  const e = evaluatePlayer(s2, buildMatchupContext(s2, { offense_team: "T00", defense_team: "T31", week: 3 }), "wr") as MatchupEvaluation;
  for (const c of e.components.filter((x) => x.id === "wr.coverage.man_zone" || x.id === "wr.area.pass")) { assert.equal(c.direction, "UNDETERMINED", c.id); assert.equal(c.value, null, c.id); }
});
test("chronology: evidence is a pure function of the supplied artifacts — mutating data NOT in the served vintage cannot change an evaluation", () => {
  const spec = { players: [{ gsis: "wr", pos: "WR" as const, epaMan: 0, epaZone: 0.3 }] }; const a = mkSource(spec); const b = mkSource(spec);
  const ea = evaluatePlayer(a, buildMatchupContext(a, { offense_team: "T00", defense_team: "T09", week: 4 }), "wr"); (b as unknown as { __future: number }).__future = 999;
  assert.deepEqual(ea, evaluatePlayer(b, buildMatchupContext(b, { offense_team: "T00", defense_team: "T09", week: 4 }), "wr")); assert.equal(TEAMS.length, 32);
});
test("registry chronology classes: every family that cannot be rebuilt as-of is excluded from fitted claims (fit_eligible false)", () => {
  for (const f of FEATURE_FAMILIES) if (f.history_class === "RETROSPECTIVE_ONLY" || f.history_class === "UNSAFE_FOR_BACKTEST") assert.equal(f.fit_eligible, false, f.id);
  assert.ok(FEATURE_FAMILIES.some((f) => f.history_class === "TRUE_AS_OF") && FEATURE_FAMILIES.some((f) => f.history_class === "RECONSTRUCTABLE_AS_OF") && FEATURE_FAMILIES.some((f) => f.history_class === "UNSAFE_FOR_BACKTEST"));
});
