/**
 * Phase 3.5A Checkpoint B -- evidence-gate repair (TypeScript side).
 * The R side (analysis/football_intel_startsit/tests) proves the per-week predicates; this
 * proves (a) the single completion authority, (b) TS refuses to trust a bare count, and
 * (c) the committed manifest is honest about the live 2026 state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildNflSeasonCompletion,
  buildNflRealityFrontier,
  type RawNflScheduleGame,
} from "@/lib/canonical/nfl-reality-frontier";
import {
  loadReevaluationManifest,
  reevaluationEligible,
  weekEvidenceSupportsCount,
  EVIDENCE_PREDICATES,
  type ReevaluationManifest,
} from "@/lib/weekly/start-sit-fi";

const g = (week: number, i: number, status: string, date = "2026-09-13"): RawNflScheduleGame => ({
  week, home: `H${week}${i}`, away: `A${week}${i}`, status, date, game_id: `${week}-${i}`,
});
const weekOf = (week: number, n: number, complete: number, extra?: string): RawNflScheduleGame[] =>
  Array.from({ length: n }, (_, i) => g(week, i, i < complete ? "complete" : (extra ?? "pre_game")));

test("completion: 16/16 complete week is COMPLETE; 1/16 and 15/16 are PARTIAL (never COMPLETE)", () => {
  const c = buildNflSeasonCompletion([...weekOf(1, 16, 16), ...weekOf(2, 16, 1), ...weekOf(3, 16, 15), ...weekOf(4, 16, 0)], 2026, "t");
  const by = Object.fromEntries(c.weeks.map((w) => [w.week, w])) as Record<number, (typeof c.weeks)[number]>;
  assert.equal(by[1].state, "COMPLETE");
  assert.equal(by[2].state, "PARTIAL");
  assert.equal(by[3].state, "PARTIAL");
  assert.equal(by[4].state, "NOT_STARTED");
});

test("completion: a postponed / in-game / unknown-status game keeps the week PARTIAL", () => {
  for (const status of ["postponed", "in_game", "delayed", "weird_new_status"]) {
    const c = buildNflSeasonCompletion(weekOf(5, 16, 15, status), 2026, "t");
    assert.equal(c.weeks[0]!.state, "PARTIAL", status);
    assert.equal(c.weeks[0]!.by_status[status], 1);
  }
});

test("completion agrees with the frozen frontier on the same rows (one predicate, not two)", () => {
  const games = [...weekOf(1, 16, 16), ...weekOf(2, 16, 1)];
  const f = buildNflRealityFrontier(games, 2026, "t")!;
  const c = buildNflSeasonCompletion(games, 2026, "t");
  const w = c.weeks.find((x) => x.week === f.latest_week_with_any_completed_game)!;
  assert.equal(w.completed, f.completed_games_in_latest_week);
  assert.equal(w.scheduled, f.scheduled_games_in_latest_week);
  // the frontier says "week 2 has happened"; completion refuses to call it complete
  assert.equal(f.latest_week_with_any_completed_game, 2);
  assert.equal(w.state, "PARTIAL");
});

const evid = (week: number, over: Partial<Record<(typeof EVIDENCE_PREDICATES)[number], boolean>> = {}) => ({
  week, counts: true, reasons: [] as string[],
  predicates: { NFL_WEEK_COMPLETE: true, FI_ASOF_AVAILABLE: true, CURRENT_SEASON_FI_AVAILABLE: true, ACTUALS_AVAILABLE: true, PRODUCTION_BASELINE_AVAILABLE: true, ...over },
});
const man = (over: Partial<ReevaluationManifest>): ReevaluationManifest => ({
  current_model_version: "ri-startsit-2026.1", deployment: "SHADOW_ONLY", season: 2026,
  completed_fi_weeks: 4, completed_fi_week_list: [3, 4, 5, 6], minimum_weeks_required: 4, preferred_weeks: 6,
  per_week_requirements: [...EVIDENCE_PREDICATES], reevaluation_eligible: true, reevaluation_status: "ELIGIBLE",
  not_eligible_reason: null, last_evaluated_through_week: null, next_candidate_version: "ri-startsit-2026.2",
  cadence: { first_check_week: 4, second_check_week: 6, thereafter_every_weeks: 3 },
  live_captured_decisions: 0, historically_reconstructed_decisions: 0, generated_at: "x", refresh_command: "x",
  evidence_gate_version: "evidence-gate-2026.2", week_evidence: [3, 4, 5, 6].map((w) => evid(w)),
  ...over,
});

test("TS gate: a bare count with no per-week evidence can never open the gate (legacy manifest)", () => {
  assert.equal(reevaluationEligible(man({ evidence_gate_version: undefined, week_evidence: undefined })), false);
});

test("TS gate: every claimed week must have ALL five predicates true", () => {
  assert.equal(reevaluationEligible(man({})), true);
  for (const p of EVIDENCE_PREDICATES) {
    const bad = man({ week_evidence: [3, 4, 5, 6].map((w) => evid(w, w === 5 ? { [p]: false } : {})) });
    assert.equal(reevaluationEligible(bad), false, `week 5 failing ${p} must block`);
  }
});

test("TS gate: a claimed week with no evidence row, a duplicate, or a count mismatch is refused", () => {
  assert.equal(reevaluationEligible(man({ week_evidence: [3, 4, 5].map((w) => evid(w)) })), false);
  assert.equal(reevaluationEligible(man({ completed_fi_week_list: [3, 4, 5, 5] })), false);
  assert.equal(reevaluationEligible(man({ completed_fi_weeks: 5 })), false);
  assert.equal(weekEvidenceSupportsCount(man({ completed_fi_week_list: [], completed_fi_weeks: 0 })), true);
});

test("committed manifest: honest about live 2026 -- no partial week, every rejection explained", () => {
  const m = loadReevaluationManifest(true)!;
  assert.equal(m.reevaluation_status, "NOT_ELIGIBLE");
  assert.equal(m.deployment, "SHADOW_ONLY");
  assert.equal(m.completed_fi_weeks, m.completed_fi_week_list.length);
  const reality = m.nfl_reality as unknown as { weeks: Array<{ week: number; scheduled: number; completed: number }> };
  for (const w of m.completed_fi_week_list) {
    const r = reality.weeks.find((x) => x.week === w)!;
    assert.equal(r.completed, r.scheduled, `counted week ${w} must be fully complete`);
  }
  // Week 2 of 2026 was PARTIAL when this gate was authored; if it is still partial it must not count.
  const w2 = reality.weeks.find((x) => x.week === 2);
  if (w2 && w2.completed < w2.scheduled) assert.ok(!m.completed_fi_week_list.includes(2));
});
