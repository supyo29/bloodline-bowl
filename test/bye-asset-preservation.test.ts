/**
 * Decision Model Convergence W1.P3 — bye-aware asset preservation.
 *
 * A bye proves the player cannot score THIS week. It is not evidence about his quality. These tests pin:
 *   - the original defect (reproduced from a clean W1.P2 checkout, 68fc482) and its fix
 *   - that the guardrail is NOT absolute (a genuinely weak bye player can still be dropped)
 *   - current-week vs asset semantics in the canonical forecast, with explicit invariants
 *   - lineup/matchup unchanged, injury isolation, trade/roster-health safety, K/DST, provider neutrality
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildWaiverRecommendations, type ByeDropDiagnostic, type WaiverCandidateEval } from "../lib/weekly/waivers";
import { buildLineup } from "../lib/weekly/intelligence";
import { buildMatchup, drawSpec } from "../lib/weekly/matchup";
import { isVerifiedBye, verifiedByeRow } from "../lib/weekly/forecast/bye";
import { holdWeeklyValue } from "../lib/weekly/forecast/asset";
import {
  buildCanonicalForecastBatch,
  buildCanonicalWeeklyPlayerForecast,
  explainForecast,
  validateForecastInvariants,
  type CanonicalWeeklyPlayerForecast,
} from "../lib/weekly/forecast";
import { buildPrivateValues } from "../lib/trades/competitive/private-value";
import { evaluateHorizon } from "../lib/roster-health";
import type { CanonicalPlayer } from "../lib/canonical/schema";
import type { WeeklyProjection, WeeklyProjectionBatch } from "../lib/weekly/schema";
import { SCENARIOS, outcome, scenarioCtx, type Outcome } from "./fixtures/bye-scenarios";
import { STD_CONSTRAINTS, batch, player, proj, roster } from "./fixtures/weekly";
import type { WeeklyReplacement } from "../lib/weekly/schema";

const BASELINE = JSON.parse(readFileSync(join(process.cwd(), "test/fixtures/bye-scenarios.w1p2-baseline.json"), "utf8")) as Record<string, Outcome>;
const now = (name: string): Outcome => outcome(SCENARIOS[name]!());
const recs = (name: string): WaiverCandidateEval[] => (buildWaiverRecommendations(SCENARIOS[name]!()) as unknown as { recommendations: WaiverCandidateEval[] }).recommendations;

const S_A = "A valuable player on bye";
const S_CF = "A-cf same player, bye removed, underlying value kept";

describe("W1.P3 original defect: reproduced on W1.P2 (68fc482), fixed on W1.P3", () => {
  it("W1.P2 baseline (captured from a clean checkout) recommends dropping the VALUABLE bye player", () => {
    assert.equal(BASELINE[S_A]!.drop, "A", "the bug: a starter-quality player with ROS 230 is the preferred drop only because of his bye");
    assert.ok(BASELINE[S_A]!.drop_cost! < 0, "legacy treated dropping him as free (negative keep)");
  });

  it("…and the bye ALONE caused it: the identical player with the bye removed (underlying value kept) was NOT the drop on W1.P2", () => {
    assert.equal(BASELINE[S_CF]!.drop, "B");
    assert.notEqual(BASELINE[S_A]!.drop, BASELINE[S_CF]!.drop);
  });

  it("W1.P3 drops the fringe bench player and keeps the valuable bye player", () => {
    assert.equal(now(S_A).drop, "B");
    assert.equal(now(S_A).add, BASELINE[S_A]!.add, "same add target; only the drop partner changed");
  });

  it("the in-process legacy rule still reproduces the old preference (so the diagnostics are honest, not constructed)", () => {
    const d = recs(S_A)[0]!.bye_diagnostics![0]!;
    assert.equal(d.player_id, "A");
    assert.equal(d.preferred_drop_with_bye_zero, "A");
    assert.equal(d.preferred_drop_bye_neutral, "B");
    assert.equal(d.drop_rank_with_bye_zero, 1);
    assert.ok(d.drop_rank_bye_neutral! > 1);
  });
});

describe("W1.P3 permanent invariant: remove the bye, compare drop rankings", () => {
  it("a valuable player may not be the preferred drop ONLY in the bye version", () => {
    const withBye = now(S_A);
    const noBye = now(S_CF);
    const onlyBecauseOfBye = withBye.drop === "A" && noBye.drop !== "A";
    assert.equal(onlyBecauseOfBye, false, "the bye must not create drop preference on its own");
    assert.equal(withBye.drop, noBye.drop);
  });

  it("holds across the hold-value range: protected whenever hold value is high, droppable once it is genuinely low", () => {
    const dropFor = (ros: number, bye: boolean) =>
      outcome(scenarioCtx({ subject: { id: "A", pos: "WR", pts: bye ? 0 : Math.round((ros / 17) * 100) / 100, ros, bye } })).drop;
    for (const ros of [230, 200, 160, 120]) assert.equal(dropFor(ros, true), dropFor(ros, false), `ros ${ros}`);
    assert.equal(dropFor(25, true), "A");
    assert.equal(dropFor(25, false), "A");
  });
});

describe("W1.P3 scenarios B–L", () => {
  it("B marginal bye player: still the correct drop (guardrail is not absolute)", () => {
    assert.equal(now("B marginal bye player (poor forward value)").drop, "A");
    const d = recs("B marginal bye player (poor forward value)")[0]!.bye_diagnostics![0]!;
    assert.equal(d.is_recommended_drop, true);
    assert.equal(d.bye_guardrail_applied, false);
    assert.equal(d.drop_rank_bye_neutral, 1, "even with the bye removed he is the weakest asset");
    assert.match(d.reason, /still the preferred drop.*even with the bye removed/);
  });

  it("C two bye players: protects the valuable one; the fringe bye player remains the drop", () => {
    const r = recs("C two bye players (elite + fringe)")[0]!;
    assert.equal(r.drop_player_id, "B");
    const byId = new Map(r.bye_diagnostics!.map((d) => [d.player_id, d]));
    assert.equal(byId.get("B")!.is_recommended_drop, true);
    assert.equal(byId.get("A")!.is_recommended_drop, false);
    assert.ok(byId.get("A")!.hold_value_weekly! > byId.get("B")!.hold_value_weekly! * 2);
  });

  it("D entire bench plays (all weak, nonzero projections): valuable bye starter is not the drop merely because they are 'playing'", () => {
    assert.equal(BASELINE["D entire bench plays, all weak"]!.drop, "A", "bug on W1.P2");
    assert.equal(now("D entire bench plays, all weak").drop, "B");
  });

  it("E open roster spot: no drop is manufactured", () => {
    const r = recs("E open roster spot")[0]!;
    assert.equal(r.drop_player_id, null);
    assert.equal(r.bye_diagnostics, undefined, "no drop choice => no bye drop diagnostics");
    assert.deepEqual(now("E open roster spot"), BASELINE["E open roster spot"]);
  });

  it("F no useful waiver add: PASS stays possible and unchanged", () => {
    assert.equal(now("F no useful waiver add").n, 0);
    assert.deepEqual(now("F no useful waiver add"), BASELINE["F no useful waiver add"]);
  });

  it("G injured valuable player: W1.P2 injury-adjusted current-week value does not create a false drop", () => {
    const ctx = SCENARIOS["G injured valuable player (Out, source 24)"]!();
    const forecasts = buildCanonicalForecastBatch({ batch: ctx.projections, requested_player_ids: ctx.roster.all_players });
    assert.equal(forecasts.by_player.get("A")!.projection.expected_points, 0, "this week the injured star is worth 0");
    const withF = outcome({ ...ctx, forecasts });
    assert.equal(withF.drop, "B");
    assert.deepEqual(withF, BASELINE["G injured valuable player (Out, source 24)"], "identical to W1.P2");
  });

  it("H bye + injury designation: bye and injury stay separate states, no double penalty, still protected", () => {
    assert.equal(BASELINE["H bye + injury designation"]!.drop, "A", "bug on W1.P2");
    assert.equal(now("H bye + injury designation").drop, "B");
    const ctx = SCENARIOS["H bye + injury designation"]!();
    const f = buildCanonicalForecastBatch({ batch: ctx.projections, requested_player_ids: ctx.roster.all_players }).by_player.get("A")!;
    assert.equal(f.value_state, "BYE_VERIFIED");
    assert.equal(f.weekly_value.current_week_state, "BYE");
    assert.equal(f.availability.injury_status, "Questionable");
    assert.equal(f.injury_model.mode, "NOT_APPLIED");
    assert.equal(f.contributions.filter((c) => c.phenomenon === "INJURY_AVAILABILITY").length, 0, "no injury penalty stacked on the bye");
    assert.deepEqual(validateForecastInvariants(f), []);
  });

  it("I known zero (not a bye): inherits NO bye protection — behavior unchanged", () => {
    assert.deepEqual(now("I known zero projection, not a bye"), BASELINE["I known zero projection, not a bye"]);
    assert.equal(now("I known zero projection, not a bye").drop, "A");
    assert.equal(recs("I known zero projection, not a bye")[0]!.bye_diagnostics, undefined);
  });

  it("J missing projection: unknown is neither zero nor a bye", () => {
    assert.deepEqual(now("J missing projection (unknown, not bye)"), BASELINE["J missing projection (unknown, not bye)"]);
    const ctx = SCENARIOS["J missing projection (unknown, not bye)"]!();
    const row = ctx.projections.by_player.get("A")!;
    assert.equal(isVerifiedBye(row), false);
    assert.equal(holdWeeklyValue({ row, week: 1 }).points, null, "never coerced to 0");
  });

  it("K streaming kicker on bye: low-value streamer is NOT artificially protected and can still be the drop", () => {
    assert.equal(now("K streaming kicker on bye").drop, "k1");
    const d = recs("K streaming kicker on bye")[0]!.bye_diagnostics![0]!;
    assert.equal(d.is_recommended_drop, true);
    assert.equal(d.bye_guardrail_applied, false);
  });

  it("L valuable DST on bye: DST is a team asset with the same current-week/asset split (never dropped for the bye)", () => {
    assert.notEqual(now("L valuable DST on bye").drop, "def1");
  });

  it("non-bye scenarios are numerically identical to W1.P2 (add side and drop side untouched)", () => {
    for (const n of ["E open roster spot", "F no useful waiver add", "G injured valuable player (Out, source 24)", "I known zero projection, not a bye", "J missing projection (unknown, not bye)", S_CF, "L valuable DST on bye"]) {
      assert.deepEqual(now(n), BASELINE[n], n);
    }
  });
});

describe("W1.P3 guardrail is not absolute (invariant 6)", () => {
  it("not every bye player is undroppable: marginal bye players and streamers are still dropped", () => {
    const dropped = ["B marginal bye player (poor forward value)", "C two bye players (elite + fringe)", "K streaming kicker on bye"].map((n) => now(n).drop);
    assert.deepEqual(dropped, ["A", "B", "k1"]);
    const diags = [...recs("B marginal bye player (poor forward value)"), ...recs("C two bye players (elite + fringe)"), ...recs("K streaming kicker on bye")].flatMap((r) => r.bye_diagnostics ?? []);
    assert.ok(diags.some((d) => d.is_recommended_drop), "at least one bye player is recommended for dropping");
    assert.ok(diags.some((d) => d.bye_guardrail_applied === false));
  });

  it("the guardrail intervenes only when the bye zero alone drove the preference", () => {
    for (const n of Object.keys(SCENARIOS)) for (const r of recs(n)) for (const d of r.bye_diagnostics ?? []) {
      if (d.bye_guardrail_applied) {
        assert.equal(d.preferred_drop_with_bye_zero, d.player_id);
        assert.notEqual(d.preferred_drop_bye_neutral, d.player_id);
        assert.equal(d.is_recommended_drop, false);
      }
      if (d.is_recommended_drop) assert.equal(d.bye_guardrail_applied, false);
    }
  });
});

describe("W1.P3 explainability: machine-readable, with prose derived from it", () => {
  it("scenario A: full diagnostic schema, reason names the cause and the hold value", () => {
    const r = recs(S_A)[0]!;
    const d = r.bye_diagnostics![0] as ByeDropDiagnostic;
    assert.deepEqual(Object.keys(d).sort(), ["bye_guardrail_applied", "current_week_points", "drop_rank_bye_neutral", "drop_rank_with_bye_zero", "hold_basis", "hold_value_weekly", "is_bye", "is_recommended_drop", "name", "player_id", "preferred_drop_bye_neutral", "preferred_drop_with_bye_zero", "rank_changed_by_bye", "reason"]);
    assert.equal(d.is_bye, true);
    assert.equal(d.current_week_points, 0);
    assert.equal(d.hold_basis, "ROS_PER_WEEK_PROXY");
    assert.ok(d.hold_value_weekly! > 10);
    assert.equal(d.rank_changed_by_bye, true);
    assert.equal(d.bye_guardrail_applied, true);
    assert.match(d.reason, /projects 0 this week because he is on a verified bye, but his hold value is intact/);
    assert.ok(r.reasons.includes(d.reason), "the user-facing reasons carry the explanation");
  });

  it("no bye diagnostics appear when no bye player is on the roster (output shape unchanged for non-bye transactions)", () => {
    const r = recs("I known zero projection, not a bye")[0]!;
    assert.equal("bye_diagnostics" in r, false);
  });
});

describe("W1.P3 canonical forecast: current-week utility vs underlying/asset value", () => {
  const row = (over: Partial<WeeklyProjection> = {}): WeeklyProjection => ({
    canonical_player_id: "p1", week: 8, season: 2026, position: "WR", nfl_team: "KC", opponent: "LV", is_home: null, projected_points: 14, floor_points: 9, ceiling_points: 20,
    std_dev: 4, projection_status: "projected", expected_availability: 1, is_bye: false, injury_status: null, rest_of_season_points: 170, ros: null, source: "sleeper_weekly",
    model_version: "sleeper-weekly-rotowire", uncertainty_source: "position_volatility_heuristic", warnings: [], ...over,
  });
  const pl = (over: Partial<CanonicalPlayer> = {}): CanonicalPlayer => ({
    canonical_player_id: "p1", full_name: "P", first_name: null, last_name: null, position: "WR", eligible_positions: ["WR"], nfl_team: "KC", is_team_defense: false,
    status: null, injury_status: null, identifiers: { sleeper_id: "s1" }, resolution: { method: "stable_id", confidence: "high", note: null }, ...over,
  });
  const b = (over: Partial<WeeklyProjectionBatch> = {}): WeeklyProjectionBatch => ({
    league_slug: "l", season: 2026, week: 8, status: "READY", by_player: new Map(), resolved_players: new Map(), source: "sleeper_weekly", model_version: "x", missing: [], teams_with_games: ["KC"], warnings: [], ...over,
  });
  const f = (projection: WeeklyProjection | null, extra: Partial<Parameters<typeof buildCanonicalWeeklyPlayerForecast>[0]> = {}): CanonicalWeeklyPlayerForecast =>
    buildCanonicalWeeklyPlayerForecast({ canonical_player_id: "p1", season: 2026, week: 8, projection, batch: b(), player: pl(), ...extra });
  const byeRow = (over: Partial<Parameters<typeof verifiedByeRow>[0]> = {}) =>
    verifiedByeRow({ canonical_player_id: "p1", week: 8, season: 2026, position: "WR", nfl_team: "KC", injury_status: null, rest_of_season_points: 170, ros: null, source: "sleeper_weekly", model_version: "x", warnings: ["bye_verified_by_schedule"], band: "ZERO", ...over });
  const clean = (x: CanonicalWeeklyPlayerForecast) => assert.deepEqual(validateForecastInvariants(x), [], JSON.stringify(validateForecastInvariants(x)));

  it("invariants 1–2: verified bye -> current week known 0, underlying value NOT zero (ROS-per-week proxy when the source has no pre-bye row)", () => {
    const x = f(byeRow());
    assert.equal(x.weekly_value.current_week_points, 0);
    assert.equal(x.weekly_value.current_week_state, "BYE");
    assert.equal(x.projection.expected_points, 0);
    assert.ok(x.weekly_value.underlying_points_if_game_played! > 10);
    assert.equal(x.weekly_value.underlying_basis, "ROS_PER_WEEK_PROXY");
    assert.equal(x.weekly_value.underlying_points_if_game_played, Math.round((170 / 10) * 100) / 100, "ROS ÷ remaining weeks (18 − week)");
    assert.deepEqual(x.asset_context, { temporary_unavailability_reason: "BYE", bye_suppressed_current_week: true, forward_value_available: true });
    clean(x);
  });

  it("a pre-bye source projection is the preferred underlying value", () => {
    const x = f(byeRow(), { bye_source_points: 13.2 });
    assert.equal(x.weekly_value.underlying_points_if_game_played, 13.2);
    assert.equal(x.weekly_value.underlying_basis, "SOURCE_PROJECTION_PRE_BYE");
    clean(x);
  });

  it("bye with no source row and no ROS: underlying is UNKNOWN (null), never a fabricated zero", () => {
    const x = f(byeRow({ rest_of_season_points: null }));
    assert.equal(x.weekly_value.underlying_points_if_game_played, null);
    assert.equal(x.weekly_value.underlying_basis, "UNAVAILABLE");
    assert.equal(x.asset_context.forward_value_available, false);
    clean(x);
  });

  it("invariant 3: is_bye is explicit — a zero projection is not a bye, and the bye needs no zero to be recognised", () => {
    assert.equal(isVerifiedBye(row({ projected_points: 0 })), false);
    assert.equal(isVerifiedBye({ is_bye: true, projection_status: "projected" }), true);
    assert.equal(isVerifiedBye({ is_bye: false, projection_status: "bye" }), true);
    assert.equal(isVerifiedBye(null), false);
  });

  it("invariants 4–5: missing projection is not a bye; known zero is not a bye", () => {
    const missing = f(null);
    assert.equal(missing.weekly_value.current_week_state, "UNKNOWN");
    assert.equal(missing.weekly_value.current_week_points, null);
    assert.equal(missing.asset_context.bye_suppressed_current_week, false);
    const zero = f(row({ projected_points: 0 }));
    assert.equal(zero.weekly_value.current_week_state, "KNOWN_ZERO");
    assert.equal(zero.weekly_value.current_week_points, 0);
    assert.equal(zero.asset_context.bye_suppressed_current_week, false);
    assert.equal(zero.asset_context.temporary_unavailability_reason, null);
    clean(missing);
    clean(zero);
  });

  it("injury (Out) is its own state: OUT / INJURY, source value retained as underlying, not a bye", () => {
    const x = f(row({ injury_status: "Out", expected_availability: 0.03 }));
    assert.equal(x.weekly_value.current_week_state, "OUT");
    assert.equal(x.weekly_value.current_week_points, 0);
    assert.equal(x.weekly_value.underlying_points_if_game_played, 14);
    assert.equal(x.asset_context.temporary_unavailability_reason, "INJURY");
    assert.equal(x.asset_context.bye_suppressed_current_week, false);
    clean(x);
  });

  it("bye + injury: BYE wins the current-week state; the injury designation stays recorded, nothing is double-counted", () => {
    const x = f(byeRow({ injury_status: "Questionable" }), { player: pl({ injury_status: "Questionable" }) });
    assert.equal(x.weekly_value.current_week_state, "BYE");
    assert.equal(x.asset_context.temporary_unavailability_reason, "BYE");
    assert.equal(x.availability.injury_status, "Questionable");
    assert.equal(x.injury_model.normalized_state, "QUESTIONABLE");
    assert.equal(x.injury_model.mode, "NOT_APPLIED");
    assert.equal(x.projection.expected_points, 0);
    clean(x);
  });

  it("healthy player: weekly_value mirrors the existing forecast (no change)", () => {
    const x = f(row());
    assert.equal(x.weekly_value.current_week_state, "PLAYABLE");
    assert.equal(x.weekly_value.current_week_points, 14);
    assert.equal(x.weekly_value.underlying_points_if_game_played, 14);
    assert.equal(x.weekly_value.underlying_basis, "SOURCE_PROJECTION");
    clean(x);
  });

  it("K and DST: same semantics (0 this week, underlying retained), K/DST fallback warning preserved", () => {
    for (const position of ["K", "DEF"] as const) {
      const x = f(byeRow({ position }), { player: pl({ position, is_team_defense: position === "DEF" }) });
      assert.equal(x.weekly_value.current_week_state, "BYE");
      assert.ok(x.weekly_value.underlying_points_if_game_played! > 0);
      assert.ok(x.certification.warnings.includes("BYE_EXPECTED_POINTS_IS_COMPAT_ZERO_NOT_UNDERLYING_VALUE"));
      clean(x);
    }
  });

  it("Yahoo-identified bye player: identical semantics with no Sleeper field", () => {
    const y = f(byeRow(), { player: pl({ identifiers: { yahoo_player_key: "nfl.p.1", yahoo_id: "1" } }) });
    assert.equal(y.identifiers.sleeper_id, undefined);
    assert.equal(y.weekly_value.current_week_state, "BYE");
    assert.ok(y.weekly_value.underlying_points_if_game_played! > 0);
    clean(y);
  });

  it("validator rejects: a bye with a non-zero current week, a fabricated underlying zero, a bye state on a non-bye player, a wrong ledger", () => {
    const base = f(byeRow(), { bye_source_points: 13.2 });
    const a = structuredClone(base);
    a.weekly_value.current_week_points = 5;
    assert.ok(validateForecastInvariants(a).includes("WEEKLY_VALUE_NEQ_EXPECTED_POINTS"));
    const z = structuredClone(f(byeRow()));
    z.weekly_value.underlying_points_if_game_played = 0;
    assert.ok(validateForecastInvariants(z).includes("BYE_UNDERLYING_FABRICATED_ZERO"));
    const n = structuredClone(f(row()));
    n.asset_context.bye_suppressed_current_week = true;
    assert.ok(validateForecastInvariants(n).includes("BYE_STATE_ON_NON_BYE_PLAYER"));
    const l = structuredClone(base);
    const bz = l.contributions.find((c) => c.component === "BYE_COMPAT_ZERO")!;
    bz.points_delta *= 2; // the bye penalty applied twice
    assert.ok(validateForecastInvariants(l).some((v) => v.startsWith("LEDGER_SUM_")));
  });

  it("diagnostics expose current-week vs underlying value", () => {
    const d = explainForecast(f(byeRow(), { bye_source_points: 13.2 }));
    assert.equal(d.is_bye, true);
    assert.equal(d.expected_points, 0);
    assert.deepEqual(d.invariant_violations, []);
  });

  it("holdWeeklyValue: non-bye uses the legacy current-week value (so non-bye drop decisions cannot move)", () => {
    assert.deepEqual(holdWeeklyValue({ row: row(), week: 8 }), { points: 14, basis: "CURRENT_WEEK_NOT_BYE" });
    assert.deepEqual(holdWeeklyValue({ row: row({ projected_points: null }), week: 8 }), { points: null, basis: "CURRENT_WEEK_NOT_BYE" });
    assert.deepEqual(holdWeeklyValue({ row: null, week: 8 }), { points: null, basis: "UNAVAILABLE" });
  });
});

describe("W1.P3 lineup and matchup semantics are unchanged: a bye is still a current-week zero", () => {
  it("bye players are never started over playable players and contribute exactly 0", () => {
    const ctx = SCENARIOS[S_A]!();
    const lu = buildLineup(ctx);
    const a = lu.slots.find((s) => s.recommended_player_id === "A");
    if (a) assert.equal(a.recommended_projected, 0);
    // a playable alternative always beats the bye player for a slot
    const ctx2 = scenarioCtx({ subject: { id: "A", pos: "WR", pts: 0, ros: 230, bye: true }, bench: [{ id: "B", pos: "WR", pts: 6.5, ros: 45 }] });
    const lu2 = buildLineup(ctx2);
    assert.ok(!lu2.slots.some((s) => s.recommended_player_id === "A" && s.slot === "WR" && lu2.slots.some((t) => t.recommended_player_id === "B")), "B (playing) must displace the bye player");
    assert.ok(lu2.bye_problems.some((p) => p.canonical_player_id === "A") || lu2.illegal_situations.some((s) => /bye/.test(s)), "the current bye starter is still flagged");
  });

  it("matchup: a verified bye is a real 0 draw and unknown stays excluded (never confused)", () => {
    const rows = new Map([["bye", proj("bye", "WR", 0, { projection_status: "bye", is_bye: true })], ["zero", proj("zero", "WR", 0)], ["unk", proj("unk", "WR", null)]]);
    const lineup = { slots: ["bye", "zero", "unk"].map((id) => ({ slot: "WR", recommended_player_id: id })) } as unknown as Parameters<typeof drawSpec>[0];
    const d = drawSpec(lineup, rows);
    assert.equal(d.draws.length, 2);
    assert.deepEqual(d.unknown, ["unk"]);
  });

  it("matchup totals count the bye player as 0 (asset preservation does not leak into this week's simulation)", () => {
    const mine = scenarioCtx({ subject: { id: "A", pos: "WR", pts: 0, ros: 230, bye: true } });
    const m = buildMatchup({ ...mine, opponent: null });
    assert.equal(m.has_opponent, false);
    const lu = m.team_lineup;
    assert.ok(lu.optimal_total != null);
    const aSlot = lu.slots.find((s) => s.recommended_player_id === "A");
    if (aSlot) assert.equal(aSlot.recommended_projected, 0);
  });
});

describe("W1.P3 injury isolation holds for the drop side", () => {
  it("W1.P2 injury-adjusted forecasts attached to the context never reach the waiver drop logic", () => {
    for (const n of ["G injured valuable player (Out, source 24)", S_A, "H bye + injury designation"]) {
      const ctx = SCENARIOS[n]!();
      const forecasts = buildCanonicalForecastBatch({ batch: ctx.projections, requested_player_ids: ctx.roster.all_players });
      assert.equal(JSON.stringify(buildWaiverRecommendations({ ...ctx, forecasts })), JSON.stringify(buildWaiverRecommendations({ ...ctx, forecasts: undefined })), n);
    }
  });

  it("a genuinely weak injured player can still be dropped (injury is not blanket protection either)", () => {
    const o = outcome(scenarioCtx({ subject: { id: "A", pos: "WR", pts: 3, ros: 25, injury: "Out", avail: 0.03 } }));
    assert.equal(o.drop, "A");
  });
});

describe("W1.P3 trade path: a bye does not devalue the player as a trade asset", () => {
  const players = [player("P", "WR")];
  const mkBatch = (p: WeeklyProjection) => batch([p], players);
  const rep: WeeklyReplacement = {
    league_slug: "t", week: 1, flex_positions: ["RB", "WR", "TE"], flex_slots: 1, bench_slots: 5, warnings: [],
    by_position: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DEF", "FLEX"].map((k) => [k, { position: k, replacement_points: 6, basis: "available_pool_marginal" as const, derived_from_rank: null, sample_size: 1 }])),
  };
  const call = (p: WeeklyProjection) => buildPrivateValues({ projections: mkBatch(p), replacement: rep, players_by_id: new Map(players.map((x) => [x.canonical_player_id, x])), universe: ["P"], as_of_iso: "2026-10-01T00:00:00.000Z" }).get("P")!;

  it("verified bye, no RI signal: value comes from the bye-neutral ROS rate, not the zero (and is labelled low confidence)", () => {
    const v = call(proj("P", "WR", 0, { projection_status: "bye", is_bye: true, expected_availability: 0, rest_of_season_points: 200, ros: null }));
    assert.equal(v.basis, "ros_weekly_vor");
    assert.ok(v.raw != null && v.raw > 0, "a strong player on bye keeps positive private value");
    assert.equal(v.confidence, "LOW");
  });

  it("non-bye behavior is unchanged: a zero (known) projection still prices from weekly VOR", () => {
    const v = call(proj("P", "WR", 0, { rest_of_season_points: 200, ros: null }));
    assert.equal(v.basis, "weekly_vor");
    assert.ok(v.raw != null && v.raw <= 0);
  });

  it("bye with no ROS at all: unavailable, not a zero-derived value", () => {
    const v = call(proj("P", "WR", 0, { projection_status: "bye", is_bye: true, expected_availability: 0, rest_of_season_points: null, ros: null }));
    assert.equal(v.basis, "unavailable");
    assert.equal(v.raw, null);
  });
});

describe("W1.P3 roster health: short-term availability is not an asset verdict", () => {
  const PL = [player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("rb3", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("wr3", "WR"), player("te1", "TE"), player("k1", "K"), player("dst1", "DEF")];
  const PTS: Record<string, number> = { qb1: 20, rb1: 16, rb2: 12, rb3: 8, wr1: 15, wr2: 13, wr3: 9, te1: 11, k1: 8, dst1: 7 };
  function inputs(byeId: string | null) {
    const projs = PL.map((p) => (p.canonical_player_id === byeId ? proj(p.canonical_player_id, p.position, 0, { projection_status: "bye", is_bye: true, expected_availability: 0 }) : proj(p.canonical_player_id, p.position, PTS[p.canonical_player_id]!)));
    const repl = { QB: 10, RB: 6, WR: 6, TE: 5, K: 6, DEF: 5, FLEX: 6 } as Record<string, number>;
    const mk = (k: string) => ({ position: k, replacement_points: repl[k]!, basis: "test", derived_from_rank: null, sample_size: 1 });
    return {
      league_slug: "t", season: 2026, week: 1, provider: "sleeper", snapshot: {}, constraints: STD_CONSTRAINTS, playerById: new Map(PL.map((p) => [p.canonical_player_id, p])), rosters: [],
      weekly: batch(projs, PL),
      weeklyReplacement: { league_slug: "t", week: 1, by_position: Object.fromEntries(Object.keys(repl).map((k) => [k, mk(k)])) },
      rosPointsByCid: new Map(PL.map((p) => [p.canonical_player_id, PTS[p.canonical_player_id]! * 17])),
      rosReplacement: Object.fromEntries(Object.entries(repl).map(([k, v]) => [k, v * 17])),
      ri_model_version: null, ros_source: "test", weeks_left_frac: 1, schedule_ready: true, teams_on_bye: new Set<string>(), warnings: [],
    } as unknown as Parameters<typeof evaluateHorizon>[0];
  }
  const R = roster("team:t", ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "dst1"], ["wr3"], { startingSlots: STD_CONSTRAINTS.starting_slots });
  const ts = { identity: { manager_slug: "m", is_vacant: false, roster_id: 1 }, depth_pressure: { by_key: ["QB", "RB", "WR", "TE", "K", "DEF", "FLEX"].map((k) => ({ slot_key: k, structural_surplus: false })) }, structural_flags: [] } as unknown as Parameters<typeof evaluateHorizon>[2];

  it("the ROS (asset-oriented) horizon is identical with and without a starter on bye; only the weekly horizon registers the shortage", () => {
    const ros0 = evaluateHorizon(inputs(null), R, ts, "rest_of_season");
    const ros1 = evaluateHorizon(inputs("rb1"), R, ts, "rest_of_season");
    assert.deepEqual(ros1, ros0, "a bye never changes the ROS-horizon view of the roster's assets");
    const wk0 = evaluateHorizon(inputs(null), R, ts, "weekly");
    const wk1 = evaluateHorizon(inputs("rb1"), R, ts, "weekly");
    assert.notDeepEqual(wk1, wk0, "the weekly horizon legitimately reflects the lineup shortage");
    const reasons = JSON.stringify(wk1);
    assert.equal(/MISSING_WEEKLY_PROJECTION/.test(reasons), false, "a bye is not reported as a missing projection");
  });
});

describe("W1.P3 provider neutrality and architecture", () => {
  it("bye semantics modules reference no provider-specific identifiers", () => {
    for (const f of ["bye.ts", "build.ts", "validate.ts"]) {
      const src = readFileSync(join(process.cwd(), "lib/weekly/forecast", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.equal(/sleeper_id|yahoo_id|yahoo_player_key/.test(src.replace(/\["sleeper_id".*?\]/g, "")), false, f);
    }
  });

  it("a Yahoo-identified valuable bye player is protected exactly like a Sleeper-identified one", () => {
    const ctx = SCENARIOS[S_A]!();
    for (const p of ctx.all_rostered) p.identifiers = { yahoo_player_key: `nfl.p.${p.canonical_player_id}`, yahoo_id: p.canonical_player_id };
    assert.equal(outcome(ctx).drop, "B");
  });

  it("the waiver engine's drop side takes hold value from the canonical bye helper (invariant 7: never solely the bye-suppressed value)", () => {
    const src = readFileSync(join(process.cwd(), "lib/weekly/waivers.ts"), "utf8");
    assert.match(src, /holdWeeklyValue\(/);
    assert.match(src, /keepFor\(hold\.points\)/);
    assert.equal(/projection_status\s*[!=]==?\s*"bye"/.test(src), false, "waivers must not carry its own bye predicate");
  });
});
