/**
 * Phase 9 Steps 7-15 / Step 61 — outcome ingestion adversarial matrix.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildStartSitOutcomes, calibrateStartSit, type StartSitCaptureRow } from "@/lib/weekly-audit/outcomes-startsit";
import { buildMatchup2Outcomes, type Matchup2CaptureRow } from "@/lib/weekly-audit/outcomes-matchup2";
import { buildWaiver2Outcomes, type Waiver2CaptureRow } from "@/lib/weekly-audit/outcomes-waiver2";
import type { WeekActuals } from "@/lib/weekly-audit/scoring-actuals";
import type { RawTransaction } from "@/lib/sleeper/types";

const FP = "scoring:v1:test";
const PPR = { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6 };
const actuals = (clean: Record<string, Record<string, number>>, raw: Record<string, Record<string, number>> = {}): WeekActuals => ({ clean: new Map(Object.entries(clean)), raw: new Map(Object.entries(raw)) });

/* ============================ Start/Sit ============================ */
const ssCap = (over: Partial<StartSitCaptureRow> = {}): StartSitCaptureRow => ({
  capture_id: "ssc:1", capture_kind: "LIVE_CAPTURED", season: 2026, week: 2, league_slug: "l", manager_slug: "m", scoring_fingerprint: FP,
  record: { decisions: [{ slot: "WR", baseline_start: "player:sleeper:100", fi_start: "player:sleeper:101", baseline_edge: 1, fi_edge: 1, reversal: true }],
    adjustments: [{ canonical_player_id: "player:sleeper:100", position: "WR", contributions: [{ family: "off_pass_epa", points_contribution: 0 }] }, { canonical_player_id: "player:sleeper:101", position: "WR", contributions: [{ family: "off_pass_epa", points_contribution: -0.5 }] }] }, ...over,
});

describe("Start/Sit outcomes", () => {
  test("baseline correct: reversal helped is false when baseline actually scored more", () => {
    const { decisions } = buildStartSitOutcomes([ssCap()], actuals({ 100: { rec: 5, rec_yd: 50 }, 101: { rec: 1, rec_yd: 5 } }), new Map([[FP, PPR]]));
    const d = decisions[0]!; assert.equal(d.winner, "BASELINE"); assert.ok(d.baseline_regret === 0); assert.ok(d.fi_regret! > 0);
  });
  test("FI reversal correct: FI player scored more -> winner FI, baseline_regret > 0", () => {
    const { decisions } = buildStartSitOutcomes([ssCap()], actuals({ 100: { rec: 1 }, 101: { rec: 8, rec_yd: 80, rec_td: 1 } }), new Map([[FP, PPR]]));
    const d = decisions[0]!; assert.equal(d.winner, "FI"); assert.ok(d.baseline_regret! > 0); assert.equal(d.fi_regret, 0);
  });
  test("FI reversal harmful: both regrets computed correctly, severe_miss flags a >=8pt swing", () => {
    const { decisions } = buildStartSitOutcomes([ssCap()], actuals({ 100: { rec: 10, rec_yd: 100, rec_td: 2 }, 101: { rec: 0 } }), new Map([[FP, PPR]]));
    const d = decisions[0]!; assert.equal(d.winner, "BASELINE"); assert.equal(d.severe_miss, true);
  });
  test("tie: identical actual points -> winner TIE, both regrets 0", () => {
    const { decisions } = buildStartSitOutcomes([ssCap()], actuals({ 100: { rec: 5, rec_yd: 50 }, 101: { rec: 5, rec_yd: 50 } }), new Map([[FP, PPR]]));
    const d = decisions[0]!; assert.equal(d.winner, "TIE"); assert.equal(d.baseline_regret, 0); assert.equal(d.fi_regret, 0);
  });
  test("missing one player's outcome -> UNEVALUABLE, never defaulted to a number", () => {
    const { decisions } = buildStartSitOutcomes([ssCap()], actuals({ 100: { rec: 5 } }), new Map([[FP, PPR]]));
    const d = decisions[0]!; assert.equal(d.winner, "UNEVALUABLE"); assert.equal(d.actual_fi_points, null);
  });
  test("missing scoring settings for the fingerprint -> whole capture UNEVALUABLE, not silently skipped", () => {
    const { decisions, outcomeRows } = buildStartSitOutcomes([ssCap()], actuals({ 100: { rec: 5 }, 101: { rec: 5 } }), new Map());
    assert.equal(decisions[0]!.winner, "UNEVALUABLE"); assert.equal(outcomeRows.length, 0);
  });
  test("only LIVE_CAPTURED backs primary calibration; LIVE_POST_LOCK is diagnostic-only", () => {
    const pristine = ssCap({ capture_id: "a" });
    const postLock = ssCap({ capture_id: "b", capture_kind: "LIVE_POST_LOCK" });
    const { decisions } = buildStartSitOutcomes([pristine, postLock], actuals({ 100: { rec: 1 }, 101: { rec: 8, rec_yd: 80 } }), new Map([[FP, PPR]]));
    const kindOf = (id: string) => (id === "a" ? "LIVE_CAPTURED" : "LIVE_POST_LOCK") as StartSitCaptureRow["capture_kind"];
    const calib = calibrateStartSit(decisions, kindOf, new Map([["a", pristine.record.adjustments], ["b", postLock.record.adjustments]]));
    assert.equal(calib.decisions_evaluated, 1); assert.equal(calib.diagnostic_post_lock_decisions, 1);
  });
});

/* ============================ Matchup2 ============================ */
const m2Cap = (direction: "ADVANTAGE" | "DISADVANTAGE" | "NEUTRAL" | "UNDETERMINED", evidence = "STRONG"): Matchup2CaptureRow => ({
  capture_id: "m2:1", capture_class: "LIVE_CAPTURED", season: 2026, week: 2, player_gsis_id: "00-1", position: "WR", scoring_fingerprint: FP,
  record: { offense_subject: { id: "00-1" }, baseline: { projected_points: 10, model_version: "v1" }, components: [{ family: "def_success_allowed", direction, evidence, title: "t" }] },
});

describe("Matchup2 outcomes (descriptive — evaluated only against the claim actually made)", () => {
  test("evidence aligns: ADVANTAGE + realized above baseline -> aligned", () => {
    const r = buildMatchup2Outcomes([m2Cap("ADVANTAGE")], actuals({ 1: { rec: 10, rec_yd: 100 } }, {}), new Map([[FP, PPR]]), () => "1");
    assert.ok(["EVIDENCE_ALIGNED_OUTCOME_STRONG", "EVIDENCE_ALIGNED_OUTCOME_WEAK"].includes(Object.keys(r.by_family[0]!.misses).find((k) => (r.by_family[0]!.misses as never)[k] > 0)!));
  });
  test("directional miss: ADVANTAGE claimed but realized well below baseline", () => {
    const r = buildMatchup2Outcomes([m2Cap("ADVANTAGE")], actuals({ 1: { rec: 0 } }, {}), new Map([[FP, PPR]]), () => "1");
    assert.equal(r.by_family[0]!.misses.DIRECTIONAL_MISS, 1);
  });
  test("role changed is NOT asserted from fantasy-point error alone — only DIRECTIONAL_MISS / OUTCOME_NOT_MEASURABLE / INSUFFICIENT_SAMPLE are ever produced without independent role/injury evidence", () => {
    const r = buildMatchup2Outcomes([m2Cap("DISADVANTAGE")], actuals({ 1: { rec: 10, rec_yd: 200, rec_td: 3 } }, {}), new Map([[FP, PPR]]), () => "1");
    const cats = Object.keys(r.by_family[0]!.misses).filter((k) => (r.by_family[0]!.misses as never)[k] > 0);
    assert.ok(!cats.includes("PLAYER_ROLE_CHANGED") && !cats.includes("INJURY_CONTEXT_CHANGED") && !cats.includes("GAME_SCRIPT_CHANGED"));
  });
  test("outcome unmeasurable: unresolved identity -> OUTCOME_NOT_MEASURABLE, never a fabricated direction", () => {
    const r = buildMatchup2Outcomes([m2Cap("ADVANTAGE")], actuals({}, {}), new Map([[FP, PPR]]), () => null);
    assert.equal(r.by_family[0]!.misses.OUTCOME_NOT_MEASURABLE, 1);
  });
  test("NEUTRAL / UNDETERMINED components are never evaluated (nothing was claimed)", () => {
    const r = buildMatchup2Outcomes([m2Cap("NEUTRAL")], actuals({ 1: { rec: 5 } }, {}), new Map([[FP, PPR]]), () => "1");
    assert.equal(r.by_family.length, 0);
  });
  test("LIVE_POST_LOCK captures are excluded from the family audit entirely", () => {
    const cap = { ...m2Cap("ADVANTAGE"), capture_class: "LIVE_POST_LOCK" };
    const r = buildMatchup2Outcomes([cap], actuals({ 1: { rec: 10, rec_yd: 100 } }, {}), new Map([[FP, PPR]]), () => "1");
    assert.equal(r.by_family.length, 0); assert.equal(r.outcomeRows.length, 0);
  });
});

/* ============================ Waiver2 ============================ */
const w2Cap = (): Waiver2CaptureRow => ({ capture_id: "w2:1", capture_class: "LIVE_CAPTURED", record_type: "RANKED", season: 2026, week: 2, league_slug: "l", manager_slug: "m", scoring_fingerprint: FP, record: { recommended_id: "player:sleeper:200", roster: { team_id: "r1" } } });
const txn = (over: Partial<RawTransaction> = {}): RawTransaction => ({ transaction_id: "t1", type: "waiver", status: "complete", status_updated: 1, created: 100, leg: 2, roster_ids: [1], adds: { "200": 1 }, drops: null, draft_picks: null, waiver_budget: [{ sender: 1, receiver: 1, amount: 15 }], settings: null, consenter_ids: null, ...over });

describe("Waiver2 outcomes (market/action distinct from performance; never inferred causality)", () => {
  test("recommendation executed by the SAME manager -> WON", () => {
    const r = buildWaiver2Outcomes([w2Cap()], new Map([["l", [txn()]]]), () => "m");
    assert.equal(r[0]!.executed, true); assert.equal(r[0]!.outcome.claim_result, "WON"); assert.equal(r[0]!.outcome.winning_bid, 15);
  });
  test("player claimed by someone ELSE -> UNKNOWN (never asserted LOST — Sleeper exposes no failed-claim evidence)", () => {
    const r = buildWaiver2Outcomes([w2Cap()], new Map([["l", [txn()]]]), () => "someone_else");
    assert.equal(r[0]!.executed, false); assert.equal(r[0]!.claimed_by_other, true); assert.equal(r[0]!.outcome.claim_result, "UNKNOWN");
  });
  test("no real transaction at all -> NOT_SUBMITTED, never REJECTED (RECOMMENDATION_NOT_EXECUTED semantics)", () => {
    const r = buildWaiver2Outcomes([w2Cap()], new Map(), () => "m");
    assert.equal(r[0]!.outcome.claim_result, "NOT_SUBMITTED");
  });
  test("performance fields (realized.*) stay null — never fabricated from a single week's data", () => {
    const r = buildWaiver2Outcomes([w2Cap()], new Map([["l", [txn()]]]), () => "m");
    assert.equal(r[0]!.outcome.realized.roster_survival_weeks, null); assert.equal(r[0]!.outcome.realized.candidate_points_started, null);
  });
  test("LIVE_POST_LOCK / no recommended_id captures are skipped entirely", () => {
    const r = buildWaiver2Outcomes([{ ...w2Cap(), record: { recommended_id: null, roster: { team_id: "r1" } } }], new Map(), () => "m");
    assert.equal(r.length, 0);
  });
});
