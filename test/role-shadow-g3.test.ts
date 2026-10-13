/**
 * W2.P2 — G3 evaluator: real-source champion vs frozen control vs frozen challenger on PROSPECTIVE evidence.
 * Proves: thresholds trace to frozen documents; statistics match the frozen harness; insufficient data is reported as such (never a pass/fail);
 * only valid LIVE_CAPTURED eligible records count; versions never pool; the report is deterministic and order-independent.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { contentHash } from "../lib/bridge/hash";
import { G3_PREREG_CONTENT_HASH, evaluateG3, preregHashOk, type G3Bundle, type OutcomeRow } from "../lib/role-shadow/g3";
import { withIds, type RoleShadowRecord } from "../lib/role-shadow/record";
import { binomUpper, decisions, errStats, lcg, paired } from "../lib/role-shadow/stats";
import { PINNED } from "../lib/role-shadow/spec";
import { decisions as harnessDecisions, paired as harnessPaired, type Row } from "../scripts/lib/role-qualification";
import { liveRecord } from "./fixtures/role-shadow";
import { synth } from "./fixtures/role-shadow-synth";

const WEEKS = [1, 2, 3, 4, 5, 6];
const read = (rel: string) => JSON.parse(readFileSync(join(process.cwd(), rel), "utf8"));
const strip = (r: RoleShadowRecord) => { const { capture_id: _a, content_hash: _b, ...rest } = r; void _a; void _b; return rest; };
const G = (b: G3Bundle, o = {}) => evaluateG3(b, o);

describe("g3-prereg.json: every VERIFIED threshold equals the frozen W2.P1 pre-registration; the file is content-pinned", () => {
  const T = read("scripts/w2p2/g3-prereg.json");
  const P = read("scripts/w2p1/prereg.json").promotion_thresholds_G2;
  const nums = (s: string): number[] => [...s.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

  it("content hash is pinned (a silent threshold edit makes the evaluator and capture refuse)", () => {
    assert.equal(contentHash(T).slice(0, 32), G3_PREREG_CONTENT_HASH);
    assert.equal(preregHashOk(), true);
  });

  it("T1 coverage and N, T2 MAE, T2b increment, T3 RMSE, T4 bias slack, T6 pairs/p, T7 tiers, T8 injury/cap, T9 permutation: numbers match prereg.json", () => {
    assert.ok(nums(P.T1_coverage_and_n).includes(T.sufficiency.S2_min_coverage_fraction.value * 100) && nums(P.T1_coverage_and_n).includes(300) && nums(P.T1_coverage_and_n).includes(120));
    assert.deepEqual(T.sufficiency.S2_min_covered_decisions_with_outcomes.value, { QB: 120, RB: 300, WR: 300, TE: 300 });
    assert.ok(nums(P.T2_mae).includes(T.gates.Q1_champion_vs_challenger.min_dMAE));
    assert.ok(nums(P.T2b_role_specific_increment).includes(T.gates.Q2_control_vs_challenger.min_dMAE));
    assert.ok(nums(P.T3_rmse).includes(T.gates.Q3_rmse.max_rmse_excess));
    assert.ok(nums(P.T4_bias).includes(T.gates.Q4_relative_bias.max_abs_bias_excess_over_champion));
    assert.ok(nums(P.T6_decisions).includes(T.gates.Q6_decisions.min_decided_pairs) && nums(P.T6_decisions).includes(T.gates.Q6_decisions.max_p_one_sided));
    assert.ok(nums(P.T7_tiers).includes(T.gates.Q7_tiers.min_tier_n) && nums(P.T7_tiers).includes(T.gates.Q7_tiers.min_tier_dMAE));
    assert.ok(nums(P.T8_injury_and_cap).includes(T.gates.Q8_injury_and_cap.min_questionable_doubtful_dMAE) && nums(P.T8_injury_and_cap).includes(T.gates.Q8_injury_and_cap.max_cap_hit_rate * 100));
    assert.ok(nums(P.T9_leakage).includes(T.gates.Q9_leakage.permutation.max_dMAE));
  });

  it("the >= 6 completed weeks requirement is quoted from W2.P1 section 20", () => {
    const doc = readFileSync(join(process.cwd(), "docs/DECISION_MODEL_CONVERGENCE_W2_P1_ROLE_OPPORTUNITY.md"), "utf8");
    assert.match(doc, /(≥|>=) 6 real completed weeks/);
    assert.equal(T.sufficiency.S1_min_completed_weeks_with_outcomes.value, 6);
  });

  it("every item carries a provenance label from the declared taxonomy; nothing reconstructed is presented as frozen", () => {
    const labels = new Set<string>();
    (function walk(x: unknown) { if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { if (k === "provenance" && typeof v === "string") labels.add(v.split(" ")[0]!); else walk(v); } })(T);
    for (const l of labels) assert.ok(["VERIFIED", "INFERRED", "PROPOSED"].includes(l), l);
    assert.match(T.status, /RECONSTRUCTED/);
    assert.equal(T.verdicts.auto_promotion, false);
  });
});

describe("statistics: identical to the frozen W2.P1 harness (same definitions, same seed)", () => {
  it("paired MAE/RMSE/bias, the cluster-bootstrap 95% CI, per-week deltas and the start/sit decision test agree to the last digit", () => {
    const rnd = lcg(11);
    const rows = Array.from({ length: 400 }, (_, i) => ({ team: `T${i % 17}`, week: 1 + (i % 4), position: i % 3 === 0 ? "RB" : "WR", actual: Math.round(rnd() * 25 * 100) / 100, a: rnd() * 20, b: rnd() * 20 }));
    const mine = paired(rows, (r) => r.a, (r) => r.b, 500);
    const h = harnessPaired(rows.map((r) => ({ ...r, actual: { HALF: r.actual, STD: r.actual, PPR: r.actual } })) as unknown as Row[], (r) => (r as unknown as { a: number }).a, (r) => (r as unknown as { b: number }).b, "HALF", 500);
    assert.equal(mine.dMAE, h.dMAE);
    assert.equal(mine.dRMSE, h.dRMSE);
    assert.deepEqual(mine.dMAE_ci, h.dMAE_ci);
    assert.deepEqual(mine.weeks, h.weeks);
    assert.deepEqual(mine.first, h.champion);
    assert.deepEqual(mine.second, h.challenger);
    const d1 = decisions(rows, (r) => r.a, (r) => r.b);
    const d2 = harnessDecisions(rows.map((r) => ({ ...r, actual: { HALF: r.actual, STD: r.actual, PPR: r.actual } })) as unknown as Row[], (r) => (r as unknown as { a: number }).a, (r) => (r as unknown as { b: number }).b, "HALF");
    assert.deepEqual([d1.pairs, d1.disagreements, d1.decided, d1.second_wins, d1.first_wins, d1.ambiguous, d1.p_one_sided], [d2.pairs, d2.disagreements, d2.decided, d2.challenger_wins, d2.champion_wins, d2.ambiguous, d2.p_one_sided]);
  });

  it("small exact checks: errStats, binomial tail", () => {
    assert.deepEqual(errStats([1, -3]), { n: 2, mae: 2, rmse: Math.sqrt(5), bias: -1 });
    assert.ok(Math.abs(binomUpper(8, 10) - 56 / 1024) < 1e-12);
    assert.equal(binomUpper(0, 0), 1);
  });
});

describe("insufficient prospective evidence is a VALID outcome: no gate is evaluated, nothing is manufactured", () => {
  it("empty store: G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE; every position insufficient; look is INTERIM_DESCRIPTIVE; no gates", () => {
    const r = G({ records: [], outcomes: [] });
    assert.equal(r.verdict, "G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE");
    assert.equal(r.look, "INTERIM_DESCRIPTIVE");
    assert.deepEqual(r.positions_insufficient, ["QB", "RB", "WR", "TE"]);
    for (const p of Object.values(r.positions)) { assert.equal(p.sufficiency.met, false); assert.deepEqual(p.gates, {}); assert.equal(p.metrics, null); }
    assert.equal(r.auto_promotion, false);
    assert.match(r.notes.join(" "), /INTERIM/);
  });

  it("captures exist but no game has finished: counted as awaiting_outcome, still insufficient", () => {
    const s = synth({ weeks: [6], perPosition: 20, effect: 1, noise: 3 });
    const r = G({ records: s.records, outcomes: [] });
    assert.equal(r.input.awaiting_outcome, 80);
    assert.equal(r.input.outcomes_joined, 0);
    assert.equal(r.verdict, "G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE");
  });

  it("a promising-looking sample that is too small or too short is STILL insufficient and evaluates no gate (3 weeks of an excellent effect)", () => {
    const s = synth({ weeks: [1, 2, 3], perPosition: 60, effect: 3, noise: 1.5, featureScale: 0.3, teams: 2 });
    const r = G(s);
    assert.equal(r.verdict, "G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE");
    for (const p of Object.values(r.positions)) { assert.match(p.sufficiency.unmet.join(";"), /completed weeks with outcomes: 3\/6/); assert.deepEqual(p.gates, {}); }
    // descriptive estimates are still reported, but are explicitly not qualification evidence
    assert.ok(r.positions.RB.metrics && (r.positions.RB.metrics as { n_headline: number }).n_headline === 180);
  });

  it("enough weeks but too few covered decisions per position: insufficient with the exact shortfall stated", () => {
    const r = G(synth({ weeks: WEEKS, perPosition: 10, effect: 1, noise: 3 }));
    assert.match(r.positions.RB.sufficiency.unmet.join(";"), /covered decisions with outcomes: 60\/300/);
    assert.match(r.positions.QB.sufficiency.unmet.join(";"), /covered decisions with outcomes: 60\/120/);
    assert.equal(r.verdict, "G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE");
  });
});

describe("sufficient evidence: gates are evaluated and can both pass and fail", () => {
  const strong = () => synth({ weeks: WEEKS, perPosition: 80, effect: 2.5, noise: 2, featureScale: 0.3, teams: 2 });

  it("a REAL planted Role effect with ample data qualifies for HUMAN REVIEW (never promotion); Q10 is honestly NOT_EVALUABLE", () => {
    const r = G(strong());
    assert.equal(r.look, "DECISION");
    assert.equal(r.verdict, "G3_QUALIFIED_FOR_HUMAN_REVIEW");
    assert.deepEqual(r.positions_qualified, ["QB", "RB", "WR", "TE"]);
    assert.equal(r.auto_promotion, false);
    for (const p of Object.values(r.positions)) {
      assert.equal(p.gates.Q1_champion_vs_challenger!.status, "PASS");
      assert.equal(p.gates.Q10_robustness_std_ppr!.status, "NOT_EVALUABLE");
      assert.ok(Object.values(p.gates).filter((g) => g.status === "FAIL").length === 0);
    }
  });

  it("NULL control: the same volume of data with NO real Role signal does NOT qualify (Q1 fails everywhere)", () => {
    const r = G(synth({ weeks: WEEKS, perPosition: 80, effect: 0, noise: 2, featureScale: 0.3, teams: 2 }));
    assert.notEqual(r.verdict, "G3_QUALIFIED_FOR_HUMAN_REVIEW");
    for (const p of Object.values(r.positions)) assert.equal(p.gates.Q1_champion_vs_challenger!.status, "FAIL");
    assert.equal(r.verdict, "G3_FAIL");
  });

  it("a NEGATIVE effect (the challenger moves points the wrong way) fails and the report shows the harm", () => {
    const r = G(synth({ weeks: WEEKS, perPosition: 80, effect: -2.5, noise: 2, featureScale: 0.3, teams: 2 }));
    assert.equal(r.verdict, "G3_FAIL");
    for (const p of Object.values(r.positions)) assert.ok((p.metrics as { champion_to_challenger: { dMAE: number } }).champion_to_challenger.dMAE < 0);
  });

  it("Q6: fewer than 100 decided pairs is INSUFFICIENT_EVIDENCE — not a fail and not a pass — and the position verdict reflects it", () => {
    const r = G(synth({ weeks: WEEKS, perPosition: 60, effect: 2.5, noise: 2, featureScale: 0.3, teams: 3 }));
    const wr = r.positions.WR;
    assert.equal(wr.gates.Q6_decisions!.status, "INSUFFICIENT_EVIDENCE");
    assert.equal(wr.verdict, "G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE");
    assert.ok(!r.positions_failed.includes("WR"));
  });

  it("Q2 is flagged UNINFORMATIVE when the frozen control is itself worse than the champion (so 'beating the control' can never be mistaken for Role evidence)", () => {
    const r = G(synth({ weeks: WEEKS, perPosition: 80, effect: 0, noise: 2, featureScale: 0.3, teams: 2 }));
    const flagged = Object.values(r.positions).filter((p) => (p.gates.Q2_control_vs_challenger?.detail as { informative?: boolean } | undefined)?.informative === false);
    assert.ok(flagged.length > 0, "at least one position shows the control worse than the champion in the null world");
    for (const p of flagged) assert.equal(p.gates.Q1_champion_vs_challenger!.status, "FAIL", "and Q1 still binds");
  });

  it("the diagnostic offline-T2b contrast (full C2 vs C0) is reported but is never a gate", () => {
    const r = G(strong());
    for (const p of Object.values(r.positions)) {
      assert.ok("diagnostic_c0_to_c2_full_offline_t2b_contrast" in (p.metrics as object));
      assert.ok(!Object.keys(p.gates).some((k) => /c2_full|T2b/i.test(k)));
    }
  });

  it("every requested metric is reported: MAE/RMSE/bias for three arms, CIs, by week, by tier, decisions, Q/D rows, cap-hit, calibration stability, permutation control", () => {
    const m = G(strong()).positions.RB.metrics as Record<string, unknown>;
    for (const k of ["champion", "challenger", "control", "champion_to_challenger", "control_to_challenger", "champion_to_control_drift", "decisions", "by_tier", "questionable_doubtful", "out_rows", "cap_hit_rate", "calibration_stability", "permutation_control", "n_headline", "n_covered"]) assert.ok(k in m, k);
    assert.deepEqual(Object.keys((m.champion_to_challenger as { by_week: object }).by_week), WEEKS.map(String));
    assert.ok(((m.calibration_stability as { delta_slope_on_champion_residual: number }).delta_slope_on_champion_residual) > 0.5, "with a real effect the delta explains the residual");
  });
});

describe("evidence discipline", () => {
  const base = () => synth({ weeks: WEEKS, perPosition: 40, effect: 1, noise: 3 });

  it("DETERMINISTIC and ORDER-INDEPENDENT: the same evidence in any order gives a byte-identical report and digest", () => {
    const s = base();
    const a = G(s);
    const b = G(s);
    const shuffled = { records: [...s.records].reverse(), outcomes: [...s.outcomes].sort(() => 0).reverse() };
    const c = G(shuffled);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(a.report_digest, c.report_digest);
  });

  it("only LIVE_CAPTURED, population-eligible records count: reconstructed and ineligible (non-template scoring) records are excluded", () => {
    const s = base();
    const reconstructed = liveRecord({ id: "rc", sleeper_id: "src", gsis_id: "00-rc" }, { gsis: "00-rc", sleeper: "src", kind: "AS_OF_RECONSTRUCTION", id: "rf:rc0000000000000000000000" });
    const ppr = liveRecord({ id: "pp", sleeper_id: "spp", gsis_id: "00-pp" }, { gsis: "00-pp", sleeper: "spp", id: "rf:pp0000000000000000000000" }, { raw_scoring: { rec: 1, pass_int: -1, pass_yd: 0.04, pass_td: 4, rush_yd: 0.1, rush_td: 6, rec_yd: 0.1, rec_td: 6, fum_lost: -2, pass_2pt: 2, rush_2pt: 2, rec_2pt: 2 } });
    const r = G({ records: [...s.records, reconstructed, ppr], outcomes: s.outcomes });
    assert.equal(r.input.live_eligible, s.records.length);
    assert.equal((r.input.by_class as Record<string, number>).HISTORICALLY_RECONSTRUCTED, 1);
    assert.equal(r.input.decisions_after_dedupe, s.records.length);
  });

  it("MODEL VERSIONS ARE NEVER POOLED: a record of another config hash is not evaluated, is listed, and is noted", () => {
    const s = base();
    const alien = withIds({ ...strip(s.records[0]!), models: { ...s.records[0]!.models, challenger: { ...s.records[0]!.models.challenger, config_hash: "e".repeat(32) } } });
    const r = G({ records: [...s.records, alien], outcomes: s.outcomes });
    assert.equal(r.input.records_of_version, s.records.length);
    assert.deepEqual(Object.keys(r.input.versions_present as object).sort(), ["e".repeat(32), PINNED.challenger_config_hash].sort());
    assert.match(r.notes.join(" "), /versions are never pooled/);
    // evaluating the OTHER version sees only its own (invalid, since not the frozen configuration) record
    const other = G({ records: [...s.records, alien], outcomes: s.outcomes }, { challenger_config_hash: "e".repeat(32) });
    assert.equal(other.input.records_of_version, 1);
    assert.equal(other.input.invalid_excluded, 1);
  });

  it("invalid / tampered / late records are excluded and COUNTED with reasons — never silently scored", () => {
    const s = base();
    const tampered = structuredClone(s.records[0]!);
    tampered.champion.expected_points = 99;
    const late = withIds({ ...strip(s.records[1]!), timing: { ...s.records[1]!.timing, captured_at: s.records[1]!.game.kickoff_at! } });
    const r = G({ records: [tampered, late, ...s.records.slice(2)], outcomes: s.outcomes });
    assert.equal(r.input.invalid_excluded, 2);
    assert.equal(r.input.decisions_after_dedupe, s.records.length - 2);
    assert.equal((r.input.invalid_examples as unknown[]).length, 2);
  });

  it("ONE DECISION per player-week-scoring: repeated captures never inflate N, and the LATEST valid pre-kickoff capture is the decision", () => {
    const early = liveRecord({ points: 12.0, observed_ms: Date.parse("2026-10-15T10:00:00Z"), composed_ms: Date.parse("2026-10-15T10:05:00Z") }, { as_of_ms: Date.parse("2026-10-15T10:10:00Z") }, {}, Date.parse("2026-10-15T10:10:00Z"));
    const late = liveRecord({ points: 13.5, observed_ms: Date.parse("2026-10-17T10:00:00Z"), composed_ms: Date.parse("2026-10-17T10:05:00Z") }, { as_of_ms: Date.parse("2026-10-17T10:10:00Z") }, {}, Date.parse("2026-10-17T10:10:00Z"));
    assert.notEqual(early.capture_id, late.capture_id);
    const out: OutcomeRow = { league_slug: late.league_slug, season: 2026, week: 6, canonical_player_id: late.player.canonical_player_id, actual_fantasy_points: 14, participation_state: "PLAYED_NORMAL", evidence_status: "CERTIFIED", scoring_exactness: "LEAGUE_EXACT", case_ref: "cc:x" };
    const r = G({ records: [early, late], outcomes: [out] });
    assert.equal(r.input.live_eligible, 2);
    assert.equal(r.input.decisions_after_dedupe, 1);
    assert.equal(r.input.outcomes_joined, 1);
    const wr = r.positions.WR.metrics as { champion: { mae: number } };
    assert.ok(Math.abs(wr.champion.mae - Math.abs(14 - 13.5)) < 1e-9, "scored against the LATEST capture's champion (13.5), not the earlier one");
  });

  it("outcome joining: only CERTIFIED league-exact outcomes score; a DNP with a null actual scores 0 (flagged); other states are excluded; another league's outcome is never joined", () => {
    const r1 = liveRecord();
    const mk = (over: Partial<OutcomeRow>): OutcomeRow => ({ league_slug: r1.league_slug, season: 2026, week: 6, canonical_player_id: r1.player.canonical_player_id, actual_fantasy_points: 9, participation_state: "PLAYED_NORMAL", evidence_status: "CERTIFIED", scoring_exactness: "LEAGUE_EXACT", case_ref: "cc:a", ...over });
    const run = (o: OutcomeRow[]) => G({ records: [r1], outcomes: o }).input;
    assert.equal(run([mk({})]).outcomes_joined, 1);
    assert.equal(run([mk({ evidence_status: "CERTIFIED_APPROXIMATE_SCORING" })]).outcome_not_evaluable, 1);
    assert.equal(run([mk({ evidence_status: "GAME_NOT_PLAYED", actual_fantasy_points: null })]).outcome_not_evaluable, 1);
    assert.equal(run([mk({ participation_state: "UNKNOWN", actual_fantasy_points: null })]).outcome_not_evaluable, 1);
    const dnp = run([mk({ participation_state: "DID_NOT_PLAY", actual_fantasy_points: null })]);
    assert.equal(dnp.outcomes_joined, 1);
    assert.equal(dnp.dnp_zero_imputed, 1);
    assert.equal(run([mk({ league_slug: "other-league" })]).awaiting_outcome, 1);
    assert.equal(run([]).awaiting_outcome, 1);
  });

  it("missing-evidence patterns are reported across ALL validated records (arm state, role confidence, scoring compatibility, join method, ineligibility reasons)", () => {
    const s = base();
    const ppr = liveRecord({ id: "pp", sleeper_id: "spp", gsis_id: "00-pp" }, { gsis: "00-pp", sleeper: "spp", id: "rf:pp0000000000000000000000", confidence: "INSUFFICIENT_SAMPLE" }, { raw_scoring: { rec: 1 } });
    const me = G({ records: [...s.records, ppr], outcomes: s.outcomes }).missing_evidence as Record<string, Record<string, number>>;
    assert.ok(me.by_arm_state!.APPLIED! > 0);
    assert.equal(me.by_scoring_compatibility!.NO_FROZEN_FIT, 1);
    assert.ok(me.by_role_confidence!.MEDIUM! > 0 && me.by_role_confidence!.LOW! > 0);
    assert.equal(me.by_join_method!.GSIS, s.records.length + 1);
    assert.ok(Object.keys(me.ineligibility_reasons!).some((k) => /SCORING_NO_FROZEN_FIT/.test(k)));
  });

  it("known-unavailable (OUT) players are checked for an exactly-zero contribution but are NOT in the headline sample", () => {
    const s = base();
    const out = liveRecord({ id: "ou", sleeper_id: "sou", gsis_id: "00-ou", injury_status: "Out", points: 11 }, { gsis: "00-ou", sleeper: "sou", id: "rf:ou0000000000000000000000" });
    const outcome: OutcomeRow = { league_slug: out.league_slug, season: 2026, week: 6, canonical_player_id: out.player.canonical_player_id, actual_fantasy_points: 0, participation_state: "INACTIVE", evidence_status: "CERTIFIED", scoring_exactness: "LEAGUE_EXACT", case_ref: "cc:out" };
    const r = G({ records: [...s.records, out], outcomes: [...s.outcomes, outcome] });
    const wr = r.positions.WR.metrics as { n_headline: number; out_rows: { n: number; nonzero_arm_deltas: number } };
    assert.equal(wr.out_rows.n, 1);
    assert.equal(wr.out_rows.nonzero_arm_deltas, 0);
    assert.equal(wr.n_headline, 40 * WEEKS.length);
  });
});
