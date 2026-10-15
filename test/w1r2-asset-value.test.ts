/**
 * W1.R2 — the canonical asset (hold) value: ONE substrate for "what is he worth to keep?", separate from "what does he score this week?".
 * Closes P1-B (injured star false drop), P1-C (bye source-zero false drop) and P1-D (trade horizon applies this week's availability to all of ROS).
 * Scenarios run through the REAL production functions: canonicalAssetValue, buildCanonicalForecastBatch, buildWeeklyTeamContext +
 * buildWaiverRecommendations, evaluateTradeHorizons, buildPrivateValues.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { canonicalAssetValue, forwardWeeksOut, holdWeeklyValue, LONG_TERM_MIN_GAMES_OUT } from "../lib/weekly/forecast/asset";
import { verifiedByeRow } from "../lib/weekly/forecast/bye";
import { buildCanonicalForecastBatch } from "../lib/weekly/forecast";
import { buildWaiverRecommendations } from "../lib/weekly/waivers";
import { listLeagueTargets } from "../lib/leagues/registry";
import type { WeeklyProjection, WeeklyProjectionBatch } from "../lib/weekly/schema";
import { feedAbsentByeContext, type FeedAbsentByeOptions } from "./fixtures/feed-absent-bye";
import { scenarioCtx } from "./fixtures/bye-scenarios";
import { proj } from "./fixtures/weekly";
import { giveStar } from "../scripts/w1r2-repros/p1-d-trade-horizon";

const WEEK = 5; // horizon = 18 - 5 = 13 weeks
const row = (o: Partial<WeeklyProjection> = {}): WeeklyProjection => proj("S", "WR", 18, { rest_of_season_points: 230, ...o });
const asset = (r: WeeklyProjection | null, pre?: number | null) => canonicalAssetValue({ row: r, week: WEEK, pre_bye_source_points: pre ?? null });
const bye = (o: { ros?: number | null; warnings?: string[]; injury?: string | null; position?: string } = {}) =>
  verifiedByeRow({ canonical_player_id: "S", week: WEEK, season: 2026, position: o.position ?? "WR", nfl_team: "BUF", injury_status: o.injury ?? null, rest_of_season_points: o.ros === undefined ? 230 : o.ros, ros: null, source: "s", model_version: "m", warnings: o.warnings ?? ["bye_verified_by_schedule"], band: "ZERO" });

describe("W1.R2 canonical asset value: three views, never the same number by accident", () => {
  it("healthy player: asset value is never below his current source projection (18 > ROS rate 17.69)", () => {
    const v = asset(row());
    assert.equal(v.asset_value.hold_points_per_week, 18);
    assert.equal(v.asset_value.basis, "CURRENT_WEEK_NOT_BYE");
    assert.equal(v.current_week.condition, "NONE");
    assert.equal(v.forward_value.weekly_rate, 17.69);
  });

  it("injured star (Out, source 0): current week 0, asset value rests on forward evidence — temporary state is NOT a penalty", () => {
    const v = canonicalAssetValue({ row: row({ projected_points: 0, injury_status: "Out" }), week: WEEK, current_week_expected_points: 0 });
    assert.equal(v.current_week.expected_points, 0);
    assert.equal(v.current_week.playable, false);
    assert.equal(v.current_week.condition, "INJURY_SHORT_TERM");
    assert.equal(v.asset_value.hold_points_per_week, 17.69);
    assert.equal(v.asset_value.basis, "ROS_PER_WEEK_PROXY");
    assert.equal(v.asset_value.temporary_current_week_penalty_applied, false);
    assert.equal(v.forward_value.forward_weeks_out, 0, "a one-week Out is a current-week state");
    assert.match(v.asset_value.explanation, /temporary current-week availability state/);
  });

  it("Doubtful star: the suppressed source number is not evidence of underlying value", () => {
    const v = asset(row({ projected_points: 1.2, injury_status: "Doubtful" }));
    assert.equal(v.asset_value.hold_points_per_week, 17.69);
  });

  it("Questionable: his own current projection — a Questionable tag never moves the hold value (same evidence as healthy)", () => {
    for (const pts of [21, 9, 4]) {
      const q = asset(row({ projected_points: pts, injury_status: "Questionable" })).asset_value;
      assert.equal(q.hold_points_per_week, pts);
      assert.equal(q.basis, "QUESTIONABLE_SOURCE");
      assert.equal(q.hold_points_per_week, asset(row({ projected_points: pts })).asset_value.hold_points_per_week);
    }
  });

  it("LONG-TERM (IR) vs SHORT-TERM (Out): different asset outcomes from the same ROS evidence", () => {
    const out = asset(row({ projected_points: 0, injury_status: "Out" }));
    const ir = asset(row({ projected_points: 0, injury_status: "IR" }));
    assert.equal(ir.current_week.condition, "INJURY_LONG_TERM");
    assert.equal(ir.forward_value.forward_weeks_out, LONG_TERM_MIN_GAMES_OUT);
    assert.equal(ir.asset_value.forward_impairment_applied, true);
    assert.equal(ir.asset_value.hold_points_per_week, Math.round(17.69 * (9 / 13) * 100) / 100);
    assert.ok(ir.asset_value.hold_points_per_week! < out.asset_value.hold_points_per_week!, "a multi-week absence lowers the asset value; a one-week one does not");
    for (const s of ["PUP", "NFI", "Sus"]) assert.equal(asset(row({ projected_points: 0, injury_status: s })).current_week.condition, "INJURY_LONG_TERM", s);
  });

  it("season-ending: the forward evidence itself collapses, so the asset value does too (no blanket injury protection)", () => {
    const v = asset(row({ projected_points: 0, injury_status: "IR", rest_of_season_points: 0 }));
    assert.equal(v.asset_value.hold_points_per_week, 0);
  });

  it("no evidence: UNKNOWN (null), never a low constant", () => {
    assert.equal(asset(row({ projected_points: 0, injury_status: "Out", rest_of_season_points: null })).asset_value.hold_points_per_week, null);
    assert.equal(asset(row({ projected_points: 0, injury_status: "Out", rest_of_season_points: null })).asset_value.basis, "UNAVAILABLE");
    assert.equal(asset(null).asset_value.hold_points_per_week, null);
  });
});

describe("W1.R2 re-audit B-1: one rule, consistent across states (no condition can raise a player above the same evidence)", () => {
  for (const [src, ros] of [[8, 120], [18, 230], [3, 60], [0, 200], [14, null], [null, 150]] as const) {
    it(`source ${src}, ROS ${ros}: Questionable == healthy; Doubtful == Out (forward basis); IR <= Out; bye+IR <= bye`, () => {
      const h = (injury: string | null, pts: number | null = src) => asset(row({ projected_points: pts, injury_status: injury, rest_of_season_points: ros })).asset_value.hold_points_per_week;
      assert.equal(h("Questionable"), h(null), "a Questionable tag never changes the hold value");
      assert.equal(h("Doubtful", 2), h("Out", 0));
      const out = h("Out", 0), ir = h("IR", 0);
      if (out != null) assert.ok(ir != null && ir <= out, "a long-term condition never raises the value");
      const b = (injury: string | null) => canonicalAssetValue({ row: bye({ ros, injury }), week: WEEK, pre_bye_source_points: src }).asset_value.hold_points_per_week;
      if (b(null) != null) assert.ok((b("IR") ?? -1) <= b(null)!, "bye + IR <= bye");
      if (b("Out") != null && b(null) != null) assert.ok(b("Out")! <= Math.max(b(null)!, b("Out")!), "bye + Out never uses the suppressed pre-bye number");
    });
  }
  it("a static ROS benchmark never overrides a HEALTHY player's fresh projection (re-audit: breakout adds were suppressed by uniform max)", () => {
    assert.equal(asset(row({ projected_points: 4, rest_of_season_points: 250 })).asset_value.hold_points_per_week, 4);
  });
});

describe("W1.R2 / P1-C: a literal 0 on a verified bye is never the player's underlying value", () => {
  it("bye WR, source 0, strong ROS: ROS basis (the zero does not override it)", () => {
    const v = asset(bye(), 0);
    assert.equal(v.current_week.condition, "BYE");
    assert.equal(v.asset_value.hold_points_per_week, 17.69);
    assert.equal(v.asset_value.basis, "ROS_PER_WEEK_PROXY");
  });

  it("bye RB with a genuine (positive) pre-bye projection: protected by that prior evidence", () => {
    const v = canonicalAssetValue({ row: bye({ position: "RB", ros: null }), week: WEEK, pre_bye_source_points: 15.5 });
    assert.equal(v.asset_value.hold_points_per_week, 15.5);
    assert.equal(v.asset_value.basis, "SOURCE_PROJECTION_PRE_BYE");
    assert.equal(canonicalAssetValue({ row: bye({ position: "RB", ros: 130 }), week: WEEK, pre_bye_source_points: 15.5 }).asset_value.hold_points_per_week, 15.5, "15.5 > ROS rate 10");
  });

  it("bye + IR: the long-term impairment applies to the pre-bye number too (never above the same player off IR)", () => {
    const v = canonicalAssetValue({ row: bye({ position: "RB", ros: null, injury: "IR" }), week: WEEK, pre_bye_source_points: 15.5 });
    assert.equal(v.asset_value.hold_points_per_week, Math.round(15.5 * (9 / 13) * 100) / 100);
    assert.equal(v.asset_value.basis, "SOURCE_PROJECTION_PRE_BYE");
  });

  it("bye K streamer / bye DST, source 0, LOW ROS: low hold value — still droppable", () => {
    assert.equal(asset(bye({ position: "K", ros: 26 }), 0).asset_value.hold_points_per_week, 2);
    assert.equal(asset(bye({ position: "DEF", ros: 13 }), 0).asset_value.hold_points_per_week, 1);
  });

  it("non-bye player genuinely projected 0: no bye-specific protection — his asset value is his own evidence (0 if that is all there is)", () => {
    const v = asset(row({ projected_points: 0, rest_of_season_points: null }));
    assert.equal(v.asset_value.hold_points_per_week, 0);
    assert.equal(v.asset_value.basis, "CURRENT_WEEK_NOT_BYE");
    assert.equal(v.current_week.condition, "NONE");
  });

  it("bye, source 0, no forward evidence: UNKNOWN, not low", () => {
    assert.equal(asset(bye({ ros: null }), 0).asset_value.hold_points_per_week, null);
  });

  it("the RI benchmark is labelled as such", () => {
    assert.equal(asset(bye({ warnings: ["bye_verified_by_schedule", "bye_hold_ros_from_ri_season_benchmark"] }), 0).asset_value.basis, "RI_ROS_BENCHMARK");
  });

  it("the canonical forecast: a zero source row on a bye no longer becomes SOURCE_PROJECTION_PRE_BYE; the forecast carries the asset view", () => {
    const r = bye();
    const batch = { league_slug: "l", season: 2026, week: WEEK, status: "READY", by_player: new Map([["S", r]]), resolved_players: new Map(), source: "s", model_version: "m", missing: [], teams_with_games: [], warnings: [] } as unknown as WeeklyProjectionBatch;
    const f = buildCanonicalForecastBatch({ batch, requested_player_ids: ["S"], bye_source_points: new Map([["S", 0]]) }).by_player.get("S")!;
    assert.notEqual(f.weekly_value.underlying_basis, "SOURCE_PROJECTION_PRE_BYE");
    assert.equal(f.weekly_value.underlying_points_if_game_played, 17.69);
    assert.equal(f.weekly_value.current_week_points, 0);
    assert.equal(f.asset_value.asset_value.hold_points_per_week, 17.69);
    assert.equal(f.asset_value.current_week.expected_points, 0, "current week and asset value are different numbers");
  });
});

/* -------------------------------------------------------------------------------- waiver integration (real context + engine) */

const dropFor = async (o: FeedAbsentByeOptions) => {
  const ctx = await feedAbsentByeContext(o);
  const out = buildWaiverRecommendations(ctx) as unknown as { recommendations: Array<{ add_player_id: string; drop_player_id: string | null }> };
  const rec = out.recommendations.find((x) => x.add_player_id === "faWR") ?? null;
  return { ctx, drop: rec?.drop_player_id ?? null, rec };
};
const inj = (injury: string, pts: number, ros: number | null): FeedAbsentByeOptions => ({ subjectOnBye: false, subjectInFeed: true, subjectPts: pts, subjectRos: ros, subjectInjury: injury });

describe("W1.R2 / P1-B: waiver drop cost is the canonical ASSET value (real buildWeeklyTeamContext + buildWaiverRecommendations)", () => {
  for (const [label, o] of [
    ["OUT star (source 0, ROS 230)", inj("Out", 0, 230)],
    ["Doubtful star (source 1.2, ROS 230)", inj("Doubtful", 1.2, 230)],
    ["Questionable star (source 15, ROS 230)", inj("Questionable", 15, 230)],
    ["IR star on an active slot (source 0, ROS 230)", inj("IR", 0, 230)],
  ] as const) {
    it(`${label}: NOT the preferred drop over a fringe bench WR`, async () => {
      const r = await dropFor(o);
      assert.ok(r.rec, "the scenario must produce a recommendation for the free agent (otherwise this is vacuous)");
      assert.notEqual(r.drop, "A");
    });
  }

  it("control: healthy star — unchanged", async () => {
    const r = await dropFor({ subjectOnBye: false, subjectInFeed: true, subjectPts: 18, subjectRos: 230 });
    assert.ok(r.rec);
    assert.notEqual(r.drop, "A");
  });

  it("truly low-value injured player (Out, ROS 20 — season-ending shape) CAN still be the drop: no blanket injury protection", async () => {
    const r = await dropFor(inj("Out", 0, 20));
    assert.equal(r.drop, "A");
  });

  it("injured, NO forward evidence: unknown asset value is not offered as the cheap drop — and the hold-back is REPORTED, not silent", async () => {
    for (const status of ["Out", "IR"]) {
      const r = await dropFor(inj(status, 0, null));
      assert.ok(r.rec);
      assert.notEqual(r.drop, "A");
      const held = (r.rec as unknown as { asset_review_notes?: Array<{ player_id: string; kind: string; reason: string }> }).asset_review_notes ?? [];
      const a = held.find((h) => h.player_id === "A");
      assert.ok(a, `${status}: the unknown-value hold is reported`);
      assert.equal(a.kind, "UNKNOWN_ASSET_VALUE");
      assert.match(a.reason, /unknown \(not low\)/);
    }
  });

  it("an Out player valued from ROS who IS the recommended drop carries a review note (ROS tracks a season average, not a breakout)", async () => {
    const r = await dropFor({ subjectOnBye: false, subjectInFeed: true, subjectPts: 0, subjectRos: 60, subjectInjury: "Out", bench: "solid" });
    assert.equal(r.drop, "A", "precondition: his ROS-based hold (4.6/wk) is below the bench");
    const note = ((r.rec as unknown as { asset_review_notes?: Array<{ player_id: string; kind: string }> }).asset_review_notes ?? []).find((n) => n.kind === "INJURED_DROP_VALUED_FROM_ROS");
    assert.equal(note?.player_id, "A");
  });

  it("B-2 limitation is VISIBLE: an IR player on an active slot valued from (possibly static) ROS gets a review note; a healthy roster gets none", async () => {
    const ir = await dropFor({ subjectOnBye: false, subjectInFeed: true, subjectPts: 0, subjectRos: null, subjectInjury: "IR", riSeasonPoints: 260 });
    const note = ((ir.rec as unknown as { asset_review_notes?: Array<{ player_id: string; kind: string }> }).asset_review_notes ?? []).find((n) => n.player_id === "A");
    assert.equal(note?.kind, "LONG_TERM_FORWARD_EVIDENCE_UNVERIFIED");
    const healthy = await dropFor({ subjectOnBye: false, subjectInFeed: true, subjectPts: 18, subjectRos: 230 });
    assert.equal((healthy.rec as unknown as { asset_review_notes?: unknown[] }).asset_review_notes, undefined, "no noise on a healthy roster");
  });

  it("a BENCH player whose CURRENT week is unknown is not an assessable drop even when his asset value is known (the lineup gain cannot be computed)", () => {
    // B: no weekly projection, low ROS (20) — he WOULD be the cheapest drop if he were assessable; the fillers project 8.5 (ROS 100)
    const ctx = scenarioCtx({ subject: { id: "A", pos: "WR", pts: 14, ros: 200 }, bench: [{ id: "B", pos: "WR", pts: null, ros: 20 }, ...["f2", "f3", "f4", "f5", "f6"].map((id) => ({ id, pos: "WR" as const, pts: 8.5, ros: 100 }))] });
    const out = buildWaiverRecommendations(ctx) as unknown as { recommendations: Array<{ add_player_id: string; drop_player_id: string | null }> };
    // the upstream gate: a rostered player with an unknown current week leaves the baseline lineup unresolved, so NO add/drop is recommended at
    // all — he is never offered as the drop. (`weeklyKnown`'s current-week clause is defense-in-depth behind this gate: mutant M26 is equivalent.)
    assert.equal(out.recommendations.length, 0);
    // control: give B a known (low) projection and the engine recommends again — so the gate, not an empty scenario, explains the silence
    const known = scenarioCtx({ subject: { id: "A", pos: "WR", pts: 14, ros: 200 }, bench: [{ id: "B", pos: "WR", pts: 3, ros: 20 }, ...["f2", "f3", "f4", "f5", "f6"].map((id) => ({ id, pos: "WR" as const, pts: 8.5, ros: 100 }))] });
    assert.ok((buildWaiverRecommendations(known) as unknown as { recommendations: unknown[] }).recommendations.length > 0);
  });

  it("consistent through the REAL engine: a healthy player and his Questionable twin get the same decision; Doubtful and Out twins get the same decision", async () => {
    const d = async (injury: string | null, pts: number) => (await dropFor({ subjectOnBye: false, subjectInFeed: true, subjectPts: pts, subjectRos: 120, subjectInjury: injury })).drop;
    assert.equal(await d("Questionable", 8), await d(null, 8));
    assert.equal(await d("Doubtful", 2), await d("Out", 0));
  });

  it("P1-C: verified-bye star with a literal source 0 row and strong ROS is protected; with only RI evidence too", async () => {
    const a = await dropFor({ subjectOnBye: true, subjectInFeed: true, subjectPts: 0, subjectRos: 230 });
    const b = await dropFor({ subjectOnBye: true, subjectInFeed: true, subjectPts: 0, subjectRos: null, riSeasonPoints: 300 });
    assert.ok(a.rec && b.rec);
    assert.notEqual(a.drop, "A");
    assert.notEqual(b.drop, "A");
  });

  it("current-week value still drives the lineup: the injured star is not started (asset value never leaks into current-week decisions)", async () => {
    const { ctx } = await dropFor(inj("Out", 0, 230));
    const f = ctx.forecasts!.by_player.get("A")!;
    assert.equal(f.projection.expected_points, 0);
    assert.ok(f.asset_value.asset_value.hold_points_per_week! > 15);
  });
});

/* -------------------------------------------------------------------------------- trade horizon (real evaluateTradeHorizons) */

describe("W1.R2 / P1-D: trade horizon applies this week's availability to THIS week only", () => {
  it("bye star: no season-long discount at all (ros.ts already prorates the bye week)", () => {
    assert.equal(giveStar("bye").availability_delta, 0);
  });
  it("Questionable star: one week of the 12-week horizon, not a 22% ROS haircut", () => {
    assert.equal(giveStar("questionable").availability_delta, 0.33); // 18/wk x 0.22 missing x 1 week / 12
  });
  it("OUT one week: exactly one week of value", () => {
    assert.equal(giveStar("out").availability_delta, 1.5); // 18 x 1 / 12
  });
  it("multi-week IR: the NFL minimum stint is removed from the forward horizon", () => {
    assert.equal(giveStar("ir").availability_delta, 6); // 18 x 4 / 12
  });
  it("season-ending: the ROS evidence is already 0 — no additional drag, and the asset is valued at that 0 by ROS math", () => {
    assert.equal(giveStar("ir_season_ending").availability_delta, 0);
  });
  it("IR player whose team is on bye this week: the forward stint still costs (re-audit B-3) — 3 weeks beyond this prorated bye week", () => {
    const rows = { S: { ...{ canonical_player_id: "S", week: 6, position: "WR", projected_points: 0, expected_availability: 0, is_bye: true, projection_status: "bye", injury_status: "IR", rest_of_season_points: 216, ros: { points: 216 }, warnings: [] } } };
    assert.equal(giveStar("healthy", { rows }).availability_delta, 4.5); // 18 x 3 / 12
  });
  it("healthy comparable player: unchanged (0)", () => {
    assert.equal(giveStar("healthy").availability_delta, 0);
  });
  it("two-for-one: a temporary injury on one outgoing asset moves the package by that one week only", () => {
    const rows = { S2: { canonical_player_id: "S2", week: 6, position: "WR", projected_points: 10, expected_availability: 1, is_bye: false, projection_status: "projected", injury_status: null, rest_of_season_points: 120, ros: { points: 120 }, warnings: [] } };
    const healthy = giveStar("healthy", { outgoing: ["S", "S2"], rows });
    const q = giveStar("out", { outgoing: ["S", "S2"], rows });
    assert.equal(healthy.availability_delta, 0);
    assert.equal(q.availability_delta, 1.5);
  });
  it("forward availability is the shared canonical rule (provider-neutral: a status string, no provider id)", () => {
    assert.equal(forwardWeeksOut({ is_bye: false, projection_status: "projected", injury_status: "Questionable" }, 12), 0);
    assert.equal(forwardWeeksOut({ is_bye: true, projection_status: "bye", injury_status: null }, 12), 0);
    assert.equal(forwardWeeksOut({ is_bye: false, projection_status: "projected", injury_status: "IR" }, 12), 4);
    assert.equal(forwardWeeksOut({ is_bye: false, projection_status: "projected", injury_status: "IR" }, 2), 2);
  });
});

/* -------------------------------------------------------------------------------- provider neutrality + every registered league */

describe("W1.R2 asset value: provider-neutral and league-specific across every registered league", () => {
  const targets = listLeagueTargets();
  it("dynamic registry (3 Sleeper + 2 Yahoo)", () => {
    assert.equal(targets.filter((t) => t.provider === "sleeper").length, 3);
    assert.equal(targets.filter((t) => t.provider === "yahoo").length, 2);
  });

  it("same NFL offensive player + DST, different league scoring: current-week differs, asset view league-specific, no provider id required", () => {
    const seen = new Map<string, { cw: number | null; hold: number | null; dstHold: number | null }>();
    for (const [i, t] of targets.entries()) {
      const scale = 1 + i * 0.1; // each league's scoring scales the same source stat line differently
      const wr = proj("player:gsis:00-0031", "WR", 0, { injury_status: "Out", rest_of_season_points: Math.round(230 * scale) });
      const dst = verifiedByeRow({ canonical_player_id: "defense:nfl:bal", week: WEEK, season: 2026, position: "DEF", nfl_team: "BAL", injury_status: null, rest_of_season_points: Math.round(90 * scale), ros: null, source: "s", model_version: "m", warnings: [], band: "ZERO" });
      const batch = { league_slug: t.key, season: 2026, week: WEEK, status: "READY", by_player: new Map([[wr.canonical_player_id, wr], [dst.canonical_player_id, dst]]), resolved_players: new Map(), source: "s", model_version: "m", missing: [], teams_with_games: [], warnings: [] } as unknown as WeeklyProjectionBatch;
      const fs = buildCanonicalForecastBatch({ batch, requested_player_ids: [wr.canonical_player_id, dst.canonical_player_id] });
      const f = fs.by_player.get(wr.canonical_player_id)!;
      const d = fs.by_player.get("defense:nfl:bal")!;
      assert.deepEqual(f.identifiers, {}, `${t.key}: no provider identifier is needed`);
      seen.set(t.key, { cw: f.asset_value.current_week.expected_points, hold: f.asset_value.asset_value.hold_points_per_week, dstHold: d.asset_value.asset_value.hold_points_per_week });
    }
    const holds = [...seen.values()].map((v) => v.hold);
    assert.equal(new Set(holds).size, targets.length, "each league's asset value is its own (league-scored ROS)");
    for (const v of seen.values()) {
      assert.equal(v.cw, 0, "current week is 0 (Out) in every league");
      assert.ok(v.hold! > 15);
      assert.ok(v.dstHold! > 6, "the canonical DST on bye keeps its forward value");
    }
  });

  it("Yahoo-only player (no sleeper id): the RI benchmark is found by CANONICAL identity (B2)", async () => {
    const ctx = await feedAbsentByeContext({ subjectOnBye: true, subjectInFeed: false, riSeasonPoints: 300, subjectSleeperId: null });
    const f = ctx.forecasts!.by_player.get("A")!;
    assert.equal(f.identifiers.sleeper_id, undefined);
    assert.equal(f.weekly_value.underlying_points_if_game_played, 17.65, "RI season 300 -> ROS via canonical id");
    assert.equal(f.asset_value.asset_value.basis, "RI_ROS_BENCHMARK");
  });

  it("holdWeeklyValue is a view over the same substrate (one implementation)", () => {
    const r = row({ projected_points: 0, injury_status: "Out" });
    assert.deepEqual(holdWeeklyValue({ row: r, week: WEEK }), { points: asset(r).asset_value.hold_points_per_week, basis: asset(r).asset_value.basis });
  });
});

/* -------------------------------------------------------------------------------- §38 architecture guard (behaviour above is the real proof) */

describe("W1.R2 guard: user-facing asset decisions read the canonical asset substrate", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  it("waiver drop cost = keepFor(hold.points), hold from the shared asset module; no bye-only gate around it", () => {
    const src = read("lib/weekly/waivers.ts");
    assert.match(src, /from "\.\/forecast\/asset"/);
    assert.match(src, /const keep = keepFor\(hold\.points\)/);
    assert.doesNotMatch(src, /const keep = bye \?/);
    assert.doesNotMatch(src, /keepFor\([^)]*expected_points/);
  });
  it("trade horizon: availability drag goes through the shared forward-availability rule, never `(avail - 1) * rate` over all of ROS", () => {
    const src = read("lib/trades/competitive/horizon.ts");
    assert.match(src, /forwardWeeksOut\(/);
    assert.doesNotMatch(src, /\(Math\.min\(1, Math\.max\(0, avail\)\) - 1\) \* rate/);
  });
  it("trade private value: the hold basis comes from the shared asset module", () => {
    assert.match(read("lib/trades/competitive/private-value.ts"), /from "@\/lib\/weekly\/forecast\/asset"/);
  });
});
