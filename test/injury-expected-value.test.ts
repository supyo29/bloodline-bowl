/**
 * Decision Model Convergence W1.P2 — injury-aware expected value.
 * Model semantics, double-counting guard, ledger reconciliation, source-truth preservation, golden before/after classification.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  INJURY_PRIOR_COUNTS,
  buildCanonicalForecastBatch,
  buildCanonicalWeeklyPlayerForecast,
  evaluateInjuryModel,
  explainForecast,
  getLegacyExpectedAvailability,
  getSourceProjectedPoints,
  normalizeInjuryStatus,
  validateForecastInvariants,
  type CanonicalWeeklyPlayerForecast,
  type InjuryEvidence,
} from "../lib/weekly/forecast";
import type { CanonicalPlayer } from "../lib/canonical/schema";
import type { WeeklyProjection, WeeklyProjectionBatch } from "../lib/weekly/schema";
import { GOLDEN, GOLDEN_IDS, buildGoldenContext, productionNumbers } from "./fixtures/canonical-forecast-golden";

const ev = (over: Partial<InjuryEvidence> = {}): InjuryEvidence => ({
  source_status: "Questionable", position: "WR", source_points: 16, source_semantics: "CONDITIONAL_ON_ACTIVE", ...over,
});

const row = (over: Partial<WeeklyProjection> = {}): WeeklyProjection => ({
  canonical_player_id: "p1", week: 5, season: 2026, position: "WR", nfl_team: "KC", opponent: "LV", is_home: null,
  projected_points: 16, floor_points: 10, ceiling_points: 24, std_dev: 5, projection_status: "projected",
  expected_availability: 0.78, is_bye: false, injury_status: "Questionable", rest_of_season_points: null, ros: null,
  source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire", uncertainty_source: "position_volatility_heuristic", warnings: [], ...over,
});
const player = (over: Partial<CanonicalPlayer> = {}): CanonicalPlayer => ({
  canonical_player_id: "p1", full_name: "P One", first_name: null, last_name: null, position: "WR", eligible_positions: ["WR"],
  nfl_team: "KC", is_team_defense: false, status: null, injury_status: null, identifiers: { sleeper_id: "s1" },
  resolution: { method: "stable_id", confidence: "high", note: null }, ...over,
});
const batch = (over: Partial<WeeklyProjectionBatch> = {}): WeeklyProjectionBatch => ({
  league_slug: "l", season: 2026, week: 5, status: "READY", by_player: new Map(), resolved_players: new Map(),
  source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire", missing: [], teams_with_games: ["KC", "LV"], warnings: [], ...over,
});
const build = (projection: WeeklyProjection | null, extra: Partial<Parameters<typeof buildCanonicalWeeklyPlayerForecast>[0]> = {}): CanonicalWeeklyPlayerForecast =>
  buildCanonicalWeeklyPlayerForecast({ canonical_player_id: "p1", season: 2026, week: 5, projection, batch: batch(), player: player(), ...extra });
const clean = (f: CanonicalWeeklyPlayerForecast) => assert.deepEqual(validateForecastInvariants(f), [], JSON.stringify(validateForecastInvariants(f)));

describe("W1.P2 status handling: source truth survives normalization (F1)", () => {
  it("normalizes provider strings generically and never maps an unknown string to healthy", () => {
    assert.equal(normalizeInjuryStatus("Questionable"), "QUESTIONABLE");
    assert.equal(normalizeInjuryStatus("Out"), "OUT");
    assert.equal(normalizeInjuryStatus("IR"), "INJURED_RESERVE");
    assert.equal(normalizeInjuryStatus("PUP"), "UNAVAILABLE_LIST");
    assert.equal(normalizeInjuryStatus("Sus"), "UNAVAILABLE_LIST");
    assert.equal(normalizeInjuryStatus(null), "HEALTHY");
    assert.equal(normalizeInjuryStatus("Active"), "HEALTHY");
    assert.equal(normalizeInjuryStatus("COV"), "UNKNOWN_STATUS");
    assert.equal(normalizeInjuryStatus("zzz"), "UNKNOWN_STATUS");
  });

  it("the provider's exact status string is retained beside the normalized state", () => {
    const f = build(row({ injury_status: "Out" }));
    assert.equal(f.availability.injury_status, "Out");
    assert.equal(f.injury_model.source_status, "Out");
    assert.equal(f.injury_model.normalized_state, "OUT");
    assert.equal(f.availability.normalized_state, "OUT");
    clean(f);
    // exact casing / odd strings are not rewritten
    const odd = build(row({ injury_status: "Q" }));
    assert.equal(odd.availability.injury_status, "Q");
    assert.equal(odd.injury_model.normalized_state, "QUESTIONABLE");
  });

  it("a source 'out' row status now survives context assembly and reaches the forecast (was lost to 'unavailable')", async () => {
    const ctx = await buildGoldenContext();
    assert.equal(ctx.projections.by_player.get("g-rb-out-src")!.projection_status, "out");
    const f = ctx.forecasts!.by_player.get("g-rb-out-src")!;
    assert.equal(f.value_state, "PLAYER_OUT_IN_SOURCE");
    assert.equal(f.projection.expected_points, null, "source out + no designation: unknown, not zero");
    assert.ok(f.certification.warnings.includes("SOURCE_REPORTS_NOT_PLAYING_GP_0_NO_VALUE_ASSERTED"));
  });
});

describe("W1.P2 injury model: expected-value arithmetic", () => {
  it("healthy: identity", () => {
    const r = evaluateInjuryModel(ev({ source_status: null }));
    assert.equal(r.normalized_state, "HEALTHY");
    assert.equal(r.probability_active, 1);
    assert.equal(r.injury_adjusted_expected_points, 16);
    assert.equal(r.adjustment_points, 0);
  });

  it("questionable, source CONDITIONAL on active: expected = source × P(active)", () => {
    const r = evaluateInjuryModel(ev());
    assert.ok(r.probability_active! > 0.5 && r.probability_active! < 0.8);
    assert.equal(r.basis, "CONDITIONAL_ACTIVE_X_AVAILABILITY");
    assert.equal(r.conditional_active_points, 16);
    assert.equal(r.embedded_fraction_assumed, 0);
    assert.equal(r.injury_adjusted_expected_points, Math.round(16 * r.probability_active! * 100) / 100);
    assert.equal(r.workload_delta, 0, "no workload evidence -> no workload discount");
    assert.equal(r.calibration.availability, "PRODUCTION_PROVISIONAL_PRIOR");
  });

  it("DOUBLE-COUNTING GUARD: an UNCONDITIONAL source is NOT discounted again", () => {
    const r = evaluateInjuryModel(ev({ source_semantics: "UNCONDITIONAL" }));
    assert.equal(r.basis, "SOURCE_ALREADY_INJURY_ADJUSTED");
    assert.equal(r.injury_adjusted_expected_points, 16);
    assert.equal(r.availability_delta, 0);
    // the conditional-active value is recovered by dividing the embedded probability back out
    assert.equal(r.conditional_active_points, Math.round((16 / r.probability_active!) * 100) / 100);
  });

  it("PARTIALLY_ADJUSTED / UNKNOWN semantics: only the REMAINING risk is applied (between the two extremes)", () => {
    const cond = evaluateInjuryModel(ev({ source_semantics: "CONDITIONAL_ON_ACTIVE" })).injury_adjusted_expected_points!;
    const uncond = evaluateInjuryModel(ev({ source_semantics: "UNCONDITIONAL" })).injury_adjusted_expected_points!;
    const unknown = evaluateInjuryModel(ev({ source_semantics: "UNKNOWN" }));
    const partial = evaluateInjuryModel(ev({ source_semantics: "PARTIALLY_ADJUSTED", assumed_embedded_fraction: 0.5 }));
    assert.ok(cond < unknown.injury_adjusted_expected_points! && unknown.injury_adjusted_expected_points! < uncond);
    assert.equal(unknown.injury_adjusted_expected_points, partial.injury_adjusted_expected_points, "UNKNOWN uses the documented midpoint assumption");
    assert.equal(unknown.basis, "SOURCE_WITH_PARTIAL_INJURY_ADJUSTMENT");
    assert.ok(unknown.warnings.includes("SOURCE_INJURY_SEMANTICS_UNKNOWN_PARTIAL_DISCOUNT_ASSUMED"));
    assert.equal(unknown.calibration.source_semantics, "ASSUMED_UNVALIDATED");
    assert.ok(unknown.confidence! < evaluateInjuryModel(ev({ source_semantics: "CONDITIONAL_ON_ACTIVE" })).confidence!, "assumed semantics lowers confidence");
  });

  it("doubtful: strong reduction; far below questionable", () => {
    const d = evaluateInjuryModel(ev({ source_status: "Doubtful" }));
    const q = evaluateInjuryModel(ev());
    assert.equal(d.normalized_state, "DOUBTFUL");
    assert.ok(d.probability_active! < 0.1);
    assert.ok(d.injury_adjusted_expected_points! < q.injury_adjusted_expected_points! / 3);
  });

  it("OUT / IR / PUP / official inactive resolve to a KNOWN ZERO and keep the source value visible", () => {
    for (const status of ["Out", "IR", "PUP", "Sus", "NFI", "DNR"]) {
      const r = evaluateInjuryModel(ev({ source_status: status }));
      assert.equal(r.injury_adjusted_expected_points, 0, status);
      assert.equal(r.probability_active, 0, status);
      assert.equal(r.conditional_active_points, 16, `${status}: source/conditional stays visible`);
      assert.equal(r.basis, "OFFICIAL_UNAVAILABLE_KNOWN_ZERO", status);
      assert.equal(r.availability_state, "UNAVAILABLE", status);
    }
    const off = evaluateInjuryModel(ev({ source_status: "Questionable", official_inactive: true }));
    assert.equal(off.normalized_state, "OFFICIAL_INACTIVE");
    assert.equal(off.injury_adjusted_expected_points, 0);
    assert.equal(off.source_status, "Questionable", "the provider's stale designation is still on record");
  });

  it("official ACTIVE clears a designation: no stale penalty", () => {
    const r = evaluateInjuryModel(ev({ source_status: "Questionable", official_active: true }));
    assert.equal(r.normalized_state, "OFFICIAL_ACTIVE");
    assert.equal(r.probability_active, 1);
    assert.equal(r.injury_adjusted_expected_points, 16);
    assert.equal(r.source_status, "Questionable");
  });

  it("practice participation is player-specific evidence: Full > Limited > DNP", () => {
    const p = (practice: "FULL" | "LIMITED" | "DNP") => evaluateInjuryModel(ev({ practice })).probability_active!;
    assert.ok(p("FULL") > p("LIMITED") && p("LIMITED") > p("DNP"));
    assert.ok(p("FULL") < 1, "shrinkage keeps a thin Full cell from reaching certainty");
    assert.equal(evaluateInjuryModel(ev({ practice: "FULL" })).evidence.prior_cell, "QUESTIONABLE/RELEVANT/FULL");
  });

  it("role evidence: a fringe player is more likely to be inactive than a relevant starter", () => {
    const rel = evaluateInjuryModel(ev({ source_points: 16 }));
    const fr = evaluateInjuryModel(ev({ source_points: 4 }));
    assert.ok(fr.probability_active! < rel.probability_active!);
    assert.equal(rel.evidence.role_tier, "RELEVANT");
    assert.equal(rel.evidence.role_tier_basis, "SOURCE_POINTS_PROXY");
    assert.equal(evaluateInjuryModel(ev({ role_tier: "FRINGE", source_points: 30 })).evidence.role_tier_basis, "EXPLICIT");
  });

  it("workload is a SEPARATE variable from participation", () => {
    const base = evaluateInjuryModel(ev({ source_status: "Questionable" }));
    const lim = evaluateInjuryModel(ev({ source_status: "Questionable", expected_workload: { fraction: 0.8, lower: 0.6, upper: 0.95, reason: "snap restriction reported" } }));
    assert.equal(lim.probability_active, base.probability_active, "workload evidence does not move P(active)");
    assert.ok(lim.workload_delta < 0);
    assert.equal(lim.workload_if_active.expected_fraction, 0.8);
    assert.deepEqual([lim.workload_if_active.lower_bound, lim.workload_if_active.upper_bound], [0.6, 0.95]);
    assert.equal(lim.availability_delta, base.availability_delta);
    assert.equal(lim.injury_adjusted_expected_points, Math.round((base.injury_adjusted_expected_points! + lim.workload_delta) * 100) / 100);
    assert.equal(lim.calibration.workload, "ASSUMED_UNVALIDATED");
    assert.equal(base.calibration.workload, "INSUFFICIENT_DATA");
    // a player who is ~certain to play but limited: availability delta 0, workload delta only
    const playingThrough = evaluateInjuryModel(ev({ source_status: null, expected_workload: { fraction: 0.85 } }));
    assert.equal(playingThrough.availability_delta, 0);
    assert.ok(playingThrough.workload_delta < 0);
    assert.equal(playingThrough.basis, "SOURCE_WITH_LIMITED_WORKLOAD_ADJUSTMENT");
  });

  it("returning from injury with no workload evidence: flagged, not invented", () => {
    const r = evaluateInjuryModel(ev({ source_status: null, returning_from_injury: true }));
    assert.equal(r.injury_adjusted_expected_points, 16);
    assert.ok(r.warnings.includes("RETURNING_FROM_INJURY_WORKLOAD_UNMODELED"));
  });

  it("unknown / unsupported status: no invented probability, source value preserved, confidence degraded", () => {
    const r = evaluateInjuryModel(ev({ source_status: "COV" }));
    assert.equal(r.normalized_state, "UNKNOWN_STATUS");
    assert.equal(r.probability_active, null);
    assert.equal(r.injury_adjusted_expected_points, 16);
    assert.equal(r.basis, "UNKNOWN_SOURCE_SEMANTICS_NO_ADDITIONAL_DISCOUNT");
    assert.ok(r.confidence! <= 0.25);
    assert.ok(r.warnings.some((w) => w.startsWith("UNRECOGNISED_INJURY_STATUS")));
  });

  it("a provider with no injury field is UNKNOWN, not healthy", () => {
    const r = evaluateInjuryModel(ev({ source_status: null, source_provides_injury_data: false }));
    assert.equal(r.normalized_state, "UNKNOWN_STATUS");
    assert.equal(r.availability_state, "UNKNOWN");
    assert.equal(r.injury_adjusted_expected_points, 16);
    assert.ok(r.warnings.includes("SOURCE_PROVIDES_NO_INJURY_DATA"));
  });

  it("kicker: Out handled, Questionable gets NO extrapolated discount (no sample), Doubtful flagged as extrapolated", () => {
    assert.equal(evaluateInjuryModel(ev({ position: "K", source_status: "Out" })).injury_adjusted_expected_points, 0);
    const q = evaluateInjuryModel(ev({ position: "K", source_status: "Questionable" }));
    assert.equal(q.injury_adjusted_expected_points, 16);
    assert.ok(q.warnings.includes("QUESTIONABLE_KICKER_NO_CALIBRATION_SAMPLE_NO_DISCOUNT"));
    assert.equal(evaluateInjuryModel(ev({ position: "K", source_status: "Doubtful" })).calibration.availability, "ASSUMED_UNVALIDATED");
  });

  it("DST is a team entity: never run through an individual injury model", () => {
    for (const status of ["Out", "Questionable", "IR"]) {
      const r = evaluateInjuryModel(ev({ position: "DEF", is_team_defense: true, source_status: status }));
      assert.equal(r.normalized_state, "NOT_APPLICABLE");
      assert.equal(r.injury_adjusted_expected_points, 16);
      assert.equal(r.adjustment_points, 0);
    }
  });

  it("missing source projection + injury: only a KNOWN unavailable becomes zero; questionable/healthy stay unknown", () => {
    assert.equal(evaluateInjuryModel(ev({ source_points: null, source_status: "Out" })).injury_adjusted_expected_points, 0);
    assert.equal(evaluateInjuryModel(ev({ source_points: null, source_status: "Questionable" })).injury_adjusted_expected_points, null);
    assert.equal(evaluateInjuryModel(ev({ source_points: null, source_status: null })).injury_adjusted_expected_points, null);
  });

  it("deterministic and pure", () => {
    assert.deepEqual(evaluateInjuryModel(ev()), evaluateInjuryModel(ev()));
  });

  it("priors are counts with shrinkage: a thin cell cannot reach certainty and an empty table cannot produce 1", () => {
    assert.ok(INJURY_PRIOR_COUNTS.questionable.cell.RELEVANT.FULL[0] < 30);
    const empty = { ...INJURY_PRIOR_COUNTS, questionable: { pooled: [0, 0], tier: { RELEVANT: [0, 0], FRINGE: [0, 0] }, cell: { RELEVANT: { FULL: [0, 0], LIMITED: [0, 0], DNP: [0, 0] }, FRINGE: { FULL: [0, 0], LIMITED: [0, 0], DNP: [0, 0] } } } } as typeof INJURY_PRIOR_COUNTS;
    assert.equal(evaluateInjuryModel(ev(), empty).probability_active, 0.5);
  });
});

describe("W1.P2 canonical forecast: ledger, basis, certification", () => {
  it("questionable player: injury discount appears as a PRODUCTION ledger line and reconciles exactly", () => {
    const f = build(row());
    assert.equal(f.projection.source_points, 16);
    assert.ok(f.projection.expected_points! < 16);
    assert.equal(f.value_state, "PROJECTED");
    assert.equal(f.availability.applied_to_expected_points, true);
    const lines = f.contributions.filter((c) => c.mode === "PRODUCTION");
    assert.deepEqual(lines.map((c) => c.component), ["BASE_PROJECTION", "INJURY_AVAILABILITY"]);
    const sum = Math.round(lines.reduce((s, c) => s + c.points_delta, 0) * 100) / 100;
    assert.equal(sum, f.projection.expected_points);
    assert.match(lines[1]!.reason!, /QUESTIONABLE.*P\(active\)=.*semantics UNKNOWN.*λ=0\.5 assumed.*PRODUCTION_PROVISIONAL_PRIOR/);
    assert.equal(f.projection.expected_points_basis, "SOURCE_WITH_PARTIAL_INJURY_ADJUSTMENT");
    assert.equal(f.certification.state, "PARTIAL", "value rests on an assumed source-semantics fraction");
    assert.ok(f.certification.warnings.includes("SOURCE_INJURY_SEMANTICS_UNKNOWN_PARTIAL_DISCOUNT_ASSUMED"));
    clean(f);
  });

  it("availability and workload lines are separate, both reconcile", () => {
    const f = build(row(), { injury: { expected_workload: { fraction: 0.8, reason: "limited snaps reported" } } });
    const comps = f.contributions.filter((c) => c.mode === "PRODUCTION").map((c) => c.component);
    assert.deepEqual(comps, ["BASE_PROJECTION", "INJURY_AVAILABILITY", "INJURY_WORKLOAD"]);
    const sum = Math.round(f.contributions.filter((c) => c.mode === "PRODUCTION").reduce((s, c) => s + c.points_delta, 0) * 100) / 100;
    assert.equal(sum, f.projection.expected_points);
    clean(f);
  });

  it("official OUT: expected is a known zero, source still visible, ledger explains, value_state is KNOWN_UNAVAILABLE", () => {
    const f = build(row({ injury_status: "Out" }));
    assert.equal(f.projection.expected_points, 0);
    assert.equal(f.projection.source_points, 16);
    assert.equal(f.value_state, "KNOWN_UNAVAILABLE");
    assert.equal(f.projection.expected_points_basis, "OFFICIAL_UNAVAILABLE_KNOWN_ZERO");
    assert.equal(f.contributions.find((c) => c.component === "INJURY_AVAILABILITY")!.points_delta, -16);
    clean(f);
    const official = build(row({ injury_status: "Questionable" }), { injury: { official_inactive: true } });
    assert.equal(official.projection.expected_points, 0);
    assert.equal(official.projection.source_points, 16);
    assert.equal(official.availability.injury_status, "Questionable");
    clean(official);
  });

  it("OUT + missing source projection: known zero via the canonical player's status", () => {
    const f = build(null, { player: player({ injury_status: "Out" }) });
    assert.equal(f.projection.expected_points, 0);
    assert.equal(f.projection.source_points, null);
    assert.equal(f.value_state, "KNOWN_UNAVAILABLE");
    clean(f);
  });

  it("QUESTIONABLE / healthy + missing source projection: unknown, never zero", () => {
    const q = build(null, { player: player({ injury_status: "Questionable" }) });
    assert.equal(q.projection.expected_points, null);
    assert.equal(q.value_state, "SOURCE_MISSING_PLAYER");
    clean(q);
    const h = build(null);
    assert.equal(h.projection.expected_points, null);
    clean(h);
  });

  it("BYE + injury designation: the bye stays a bye and injury processing does not touch it", () => {
    const bye = row({ projected_points: 0, projection_status: "bye", is_bye: true, expected_availability: 0, warnings: ["bye_verified_by_schedule"], injury_status: "Questionable" });
    const f = build(bye, { bye_source_points: 12 });
    assert.equal(f.value_state, "BYE_VERIFIED");
    assert.equal(f.game_status.is_bye, true);
    assert.equal(f.projection.expected_points, 0);
    assert.equal(f.projection.expected_points_basis, "BYE_COMPAT_ZERO");
    assert.equal(f.injury_model.mode, "NOT_APPLIED");
    assert.equal(f.availability.applied_to_expected_points, false);
    assert.equal(f.availability.injury_status, "Questionable");
    assert.equal(f.availability.status, "BYE");
    assert.equal(f.contributions.some((c) => c.phenomenon === "INJURY_AVAILABILITY"), false);
    clean(f);
  });

  it("healthy player: expected_points is bit-for-bit the source value", () => {
    const f = build(row({ injury_status: null, projected_points: 17.3333333, expected_availability: 1 }));
    assert.equal(f.projection.expected_points, 17.3333333);
    assert.equal(f.projection.expected_points_basis, "SOURCE_PROJECTION");
    assert.equal(f.availability.applied_to_expected_points, false);
    clean(f);
  });

  it("SHADOW mode computes everything and applies nothing", () => {
    const f = build(row(), { injury_mode: "SHADOW" });
    assert.equal(f.projection.expected_points, 16);
    assert.equal(f.availability.applied_to_expected_points, false);
    assert.equal(f.injury_model.mode, "SHADOW");
    const l = f.contributions.find((c) => c.component === "INJURY_AVAILABILITY")!;
    assert.equal(l.mode, "SHADOW");
    assert.ok(l.points_delta < 0);
    assert.deepEqual(f.provenance.production_adjustments_applied, ["BASE_PROJECTION"]);
    assert.ok(f.provenance.shadow_adjustments_computed.includes("INJURY_AVAILABILITY"));
    clean(f);
  });

  it("variance includes participation risk (Bernoulli mixture)", () => {
    const q = build(row());
    const h = build(row({ injury_status: null, expected_availability: 1 }));
    assert.ok(q.uncertainty.variance! > h.uncertainty.variance!);
    assert.ok(q.uncertainty.reasons.includes("PARTICIPATION_RISK_INCLUDED_IN_VARIANCE"));
    assert.equal(build(row({ injury_status: "Out" })).uncertainty.variance, 0);
  });

  it("Yahoo-identified injured player: no Sleeper field needed anywhere", () => {
    const y = player({ identifiers: { yahoo_player_key: "nfl.p.40002", yahoo_id: "40002" } });
    const f = build(row(), { player: y });
    assert.equal(f.identifiers.sleeper_id, undefined);
    assert.ok(f.projection.expected_points! < 16);
    clean(f);
  });

  it("DST row with a stray injury string is untouched; kicker Out is zero; kicker Questionable undiscounted; K/DST warnings preserved", () => {
    const dst = build(row({ position: "DEF", injury_status: "Questionable", warnings: ["k_dst_uses_sleeper_standard_points (x)"] }), { player: player({ position: "DEF", is_team_defense: true }) });
    assert.equal(dst.projection.expected_points, 16);
    assert.equal(dst.injury_model.normalized_state, "NOT_APPLICABLE");
    assert.ok(dst.certification.warnings.includes("K_DST_SOURCE_USES_STANDARD_SCORING_FALLBACK"));
    const ko = build(row({ position: "K", injury_status: "Out" }), { player: player({ position: "K" }) });
    assert.equal(ko.projection.expected_points, 0);
    const kq = build(row({ position: "K", injury_status: "Questionable" }), { player: player({ position: "K" }) });
    assert.equal(kq.projection.expected_points, 16);
    assert.ok(kq.certification.warnings.includes("K_DST_SOURCE_USES_STANDARD_SCORING_FALLBACK"));
    for (const f of [dst, ko, kq]) clean(f);
  });

  it("source truth: legacy adapters still expose the provider's own number and heuristic", () => {
    const f = build(row());
    assert.equal(getSourceProjectedPoints(f), 16);
    assert.equal(getLegacyExpectedAvailability(f), 0.78);
    assert.ok(f.availability.probability_active !== 0.78, "the model's P(active) is a distinct number from the provider heuristic");
  });

  it("deterministic: identical inputs, identical forecast", () => {
    assert.equal(JSON.stringify(build(row())), JSON.stringify(build(row())));
  });

  it("diagnostics answer the injured-player questions as data", () => {
    const d = explainForecast(build(row(), { injury: { practice: "LIMITED" } }));
    assert.equal(d.source_points, 16);
    assert.equal(d.injury.source_status, "Questionable");
    assert.equal(d.injury.normalized_state, "QUESTIONABLE");
    assert.ok(d.injury.probability_active! > 0 && d.injury.probability_active! < 1);
    assert.equal(d.injury.workload_if_active.expected_fraction, 1);
    assert.equal(d.injury.source_projection_injury_semantics, "UNKNOWN");
    assert.equal(d.injury.embedded_fraction_assumed, 0.5);
    assert.ok(d.injury.adjustment_points < 0);
    assert.equal(d.expected_points, build(row(), { injury: { practice: "LIMITED" } }).projection.expected_points);
    assert.equal(d.expected_points_reason, "SOURCE_EMBEDS_PART_OF_INJURY_RISK_REMAINDER_APPLIED");
    assert.ok(d.injury.confidence! > 0 && d.injury.confidence! < 0.5);
    assert.equal(d.injury.evidence.practice, "LIMITED");
    assert.equal(d.injury.calibration.availability, "PRODUCTION_PROVISIONAL_PRIOR");
    assert.ok(d.ledger.length >= 2);
    assert.deepEqual(d.invariant_violations, []);
  });

  it("validator rejects a double-counted unconditional source, a faked zero, and an overwritten source status", () => {
    const f = build(row());
    const dbl = structuredClone(f);
    dbl.injury_model.source_projection_injury_semantics = "UNCONDITIONAL";
    assert.ok(validateForecastInvariants(dbl).includes("DOUBLE_COUNTED_AVAILABILITY_ON_UNCONDITIONAL_SOURCE"));
    const ow = structuredClone(f);
    ow.availability.injury_status = "UNAVAILABLE";
    assert.ok(validateForecastInvariants(ow).includes("SOURCE_STATUS_OVERWRITTEN"));
    const miss = build(null);
    const fake = structuredClone(miss);
    fake.projection.expected_points = 0;
    assert.ok(validateForecastInvariants(fake).some((x) => x === "UNKNOWN_STATE_CARRIES_NUMBER" || x === "EXPECTED_WITHOUT_SOURCE_AND_NOT_UNAVAILABLE"));
    const led = structuredClone(f);
    led.contributions = led.contributions.filter((c) => c.component !== "INJURY_AVAILABILITY");
    assert.ok(validateForecastInvariants(led).some((x) => x.startsWith("LEDGER_SUM_")));
  });
});

/**
 * Golden before/after. BEFORE = origin ab7dce3 (W1.P1 certified tip) captured with this same fixture from a clean worktree.
 * Every changed player is listed with its reason; every other player must be numerically identical.
 */
describe("W1.P2 golden before/after vs W1.P1 (ab7dce3)", () => {
  const before = JSON.parse(readFileSync(join(process.cwd(), "test/fixtures/canonical-forecast-golden.w1p1-ab7dce3.json"), "utf8")) as Record<
    string,
    { legacy: { projected_points: number | null; projection_status: string; expected_availability: number | null; is_bye: boolean | null }; w1p1_expected_points: number | null; w1p1_basis: string; w1p1_value_state: string; source_points: number | null }
  >;

  /** player -> [expected W1.P2 expected_points, reason] — the COMPLETE set of intended numerical changes. */
  const CHANGED: Record<string, [number, string]> = {
    "g-wr-out": [0, "designation Out resolves to known zero; source 9.1 retained"],
    "g-rb-ir": [0, "IR resolves to known zero; stale source 10 retained"],
    "g-k-out": [0, "kicker designated Out resolves to known zero; source 7.9 retained"],
    "g-wr-out-missing": [0, "Out + no source row: known zero (was unknown/null)"],
    "g-wr-doubtful": [1.11, "Doubtful: P(active)≈0.04 (0 of 29 active in training); source 15"],
    "g-rb-q": [12.11, "Questionable relevant: P≈0.71, source semantics unknown (λ=0.5 assumed); source 14.6"],
    "g-qb-q-star": [18.25, "Questionable star: same model; still the highest-valued player on the board among injured"],
    "g-rb-q-fringe": [3.49, "Questionable fringe role: P≈0.54; source 5"],
    "g-te-yahoo-q": [7.47, "Questionable, Yahoo-identified: same model, no sleeper_id used; source 9"],
  };

  it("the fixture and the ab7dce3 capture cover the same players", () => {
    assert.deepEqual(Object.keys(before).sort(), [...GOLDEN_IDS].sort());
    assert.equal(GOLDEN.length, 24);
  });

  it("legacy ctx.projections (what waivers/replacement read) is unchanged for every player, except the documented F1 status fix", async () => {
    const ctx = await buildGoldenContext();
    const now = productionNumbers(ctx);
    const diffs: string[] = [];
    for (const id of GOLDEN_IDS) {
      const b = before[id]!.legacy;
      const a = now[id]!;
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${id}: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
    }
    assert.deepEqual(diffs, [`g-rb-out-src: {"projected_points":null,"projection_status":"unavailable","expected_availability":1,"is_bye":false} -> {"projected_points":null,"projection_status":"out","expected_availability":1,"is_bye":false}`]);
  });

  it("exactly the intended players changed expected_points, to the intended values; nobody else moved", async () => {
    const f = (await buildGoldenContext()).forecasts!.by_player;
    const moved: Record<string, number | null> = {};
    for (const id of GOLDEN_IDS) {
      const was = before[id]!.w1p1_expected_points;
      const is = f.get(id)!.projection.expected_points;
      if (was !== is) moved[id] = is;
    }
    assert.deepEqual(Object.keys(moved).sort(), Object.keys(CHANGED).sort());
    for (const [id, [want]] of Object.entries(CHANGED)) assert.equal(moved[id], want, id);
  });

  it("every changed player is fully explained: source, W1.P1 value, W1.P2 value, status, P(active), basis, ledger delta", async () => {
    const f = (await buildGoldenContext()).forecasts!.by_player;
    const table: Array<Record<string, unknown>> = [];
    for (const [id, [want, reason]] of Object.entries(CHANGED)) {
      const x = f.get(id)!;
      const was = before[id]!.w1p1_expected_points;
      const injuryLines = x.contributions.filter((c) => c.phenomenon === "INJURY_AVAILABILITY" || c.phenomenon === "INJURY_WORKLOAD");
      const delta = Math.round(injuryLines.reduce((s, c) => s + c.points_delta, 0) * 100) / 100;
      assert.ok(injuryLines.length > 0 && injuryLines.every((c) => c.mode === "PRODUCTION"), id);
      assert.equal(Math.round(((x.projection.source_points ?? 0) + delta) * 100) / 100, want, `${id} ledger`);
      assert.ok(x.injury_model.source_status, id);
      assert.equal(x.availability.applied_to_expected_points, true, id);
      table.push({ id, source: x.projection.source_points, w1p1: was, w1p2: want, status: x.availability.injury_status, normalized: x.availability.normalized_state, p_active: x.availability.probability_active, basis: x.projection.expected_points_basis, delta, reason });
      assert.deepEqual(validateForecastInvariants(x), [], id);
    }
    assert.equal(table.length, 9);
  });

  it("unchanged players include every healthy, bye, known-zero, missing and unsupported case; unknowns did not become zero", async () => {
    const f = (await buildGoldenContext()).forecasts!.by_player;
    for (const id of ["g-qb", "g-te-yahoo", "g-te-zero", "g-k", "g-def", "g-def-injstr", "g-k-q", "g-wr-cov", "g-rb-bye", "g-def-bye", "g-rb-bye-q"]) {
      assert.equal(f.get(id)!.projection.expected_points, before[id]!.w1p1_expected_points, id);
    }
    for (const id of ["g-wr-missing", "g-te-q-missing", "g-rb-totals", "g-rb-out-src"]) {
      assert.equal(f.get(id)!.projection.expected_points, null, `${id} must stay unknown`);
    }
    assert.equal(f.get("g-te-q-missing")!.value_state, "SOURCE_MISSING_PLAYER");
    assert.equal(f.get("g-rb-bye-q")!.value_state, "BYE_VERIFIED");
    assert.equal(f.get("g-rb-bye-q")!.availability.injury_status, "Questionable");
  });

  it("source projections are untouched for every player (source truth)", async () => {
    const f = (await buildGoldenContext()).forecasts!.by_player;
    for (const id of GOLDEN_IDS) assert.equal(f.get(id)!.projection.source_points, before[id]!.source_points, id);
  });

  it("every forecast in the golden context satisfies every invariant; batch is deterministic", async () => {
    const a = await buildGoldenContext();
    const b = await buildGoldenContext();
    for (const [id, x] of a.forecasts!.by_player) assert.deepEqual(validateForecastInvariants(x), [], id);
    assert.equal(JSON.stringify([...a.forecasts!.by_player]), JSON.stringify([...b.forecasts!.by_player]));
  });

  it("forecast batch in SHADOW mode reproduces W1.P1 expected points exactly (clean rollback path)", async () => {
    const ctx = await buildGoldenContext();
    const shadow = buildCanonicalForecastBatch({ batch: ctx.projections, requested_player_ids: ctx.roster.all_players, injury_mode: "SHADOW" });
    for (const id of GOLDEN_IDS) {
      const was = before[id]!.w1p1_expected_points;
      if (id === "g-wr-out-missing") continue; // W1.P1 had no concept of status-only known-unavailable; shadow keeps it unknown
      assert.equal(shadow.by_player.get(id)!.projection.expected_points, was, id);
    }
  });
});
