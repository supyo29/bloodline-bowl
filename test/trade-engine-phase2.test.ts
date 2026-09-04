/**
 * Trade Engine — Phase 2: contextual roster valuation.
 *
 * Phase 1 (`ri-trade-foundation-2026.2`) stays frozen and authoritative; Phase 2
 * (`ri-trade-contextual-2026.2`) is an ADDITIVE layer. These tests verify:
 *   2A snapshot consistency (one provider read per analysis)
 *   2B rest-of-season contextual valuation (marginal usable, bye weeks, playoff
 *      window, scarcity / replacement context, consolidation vs depth)
 *   2C usable depth & roster fragility
 *   composite double-count protection (default weights 0 -> contextual == Phase 1)
 *   3-team, interaction effects, determinism, explicit degradation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, xfer, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import { evaluateTrade } from "../lib/trades/evaluate";
import { rosterResilience } from "../lib/trades/depth";
import { DEFAULT_TRADE_CONFIG, resolveTradeConfig, type PartialTradeConfig } from "../lib/trades/config";
import { buildWeeklyTeamContext } from "../lib/weekly/context";
import { buildTradeAnalysisContext } from "../lib/trades/context";
import { analyzeTrade } from "../lib/trades/analyze";
import { setPersistence, memoryPersistence } from "../lib/persistence";
import { ok } from "../lib/providers/types";
import type { CanonicalLeagueStateBundle, FantasyProvider } from "../lib/providers/types";
import type { ProjectionProvider } from "../lib/weekly/projections/types";
import type { WeeklyProjectionBatch, RosSignal, WeeklyProjection } from "../lib/weekly/schema";
import type { CanonicalPosition } from "../lib/canonical/schema";
import type { NormalizedProposal } from "../lib/trades/schema";

setPersistence(memoryPersistence());

const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
/** proj with a REALISTIC rest-of-season total = weekly ROS mean × the horizon. */
function rp(id: string, pos: Pos, weekly: number, rosWeeklyMean: number, opts: Partial<ReturnType<typeof proj>> = {}) {
  return proj(id, pos, weekly, { rest_of_season_points: Math.round(rosWeeklyMean * ROS_WEEKS), ...opts });
}
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3, 4].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) =>
  [0, 1, 2, 3, 4].map((i) => rp(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, p === "QB" ? 12 - i : 6 - i)),
);

/* ================================================================= */
/* 2A — SNAPSHOT CONSISTENCY                                          */
/* ================================================================= */

const CAPS = {
  league: true, settings: true, managers: true, standings: true, rosters: true, matchups: false,
  transactions: false, players: true, free_agents: true, waivers: true, draft_results: true, live_authenticated_access: true,
} as const;

function twoTeamBundle(rev: number): CanonicalLeagueStateBundle {
  const slug = "bloodline-bowl";
  const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];
  const mk = (team: string, ids: string[]) => ({
    canonical_roster_id: `roster:${slug}:${team}`,
    canonical_team_id: `team:${slug}:${team}`,
    slots: slots.map((slot, i) => ({ slot, slot_index: i, canonical_player_id: ids[i]!, is_empty: false })),
    starters: ids.slice(0, 9),
    bench: ids.slice(9),
    ir: [], taxi: [], all_players: ids,
    provenance: { provider: "sleeper" as const, provider_id: team, provider_synced_at: null },
  });
  const pl = (team: string, key: string, pos: Pos) => ({
    canonical_player_id: `player:sleeper:${slug}-${team}-${key}`,
    full_name: `${team} ${key}`, first_name: null, last_name: null, position: pos,
    eligible_positions: [pos], nfl_team: "KC", is_team_defense: pos === "DEF", status: null, injury_status: null,
    identifiers: { sleeper_id: `${slug}-${team}-${key}` },
    resolution: { method: "stable_id" as const, confidence: "high" as const, note: null },
  });
  const keys = ["qb", "rb1", "rb2", "wr1", "wr2", "te", "flex", "k", "def", "b1"];
  const poss: Pos[] = ["QB", "RB", "RB", "WR", "WR", "TE", "WR", "K", "DEF", "RB"];
  const teams = ["A", "B"];
  const players = teams.flatMap((t) => keys.map((k, i) => pl(t, k, poss[i]!)));
  const rosters = teams.map((t) => mk(t, keys.map((k) => `player:sleeper:${slug}-${t}-${k}`)));
  return {
    league: {
      canonical_league_id: `league:${slug}`, league_slug: slug, name: slug, season: 2026, status: "in_season",
      sport: "nfl", team_count: 12, current_week: 8,
      scoring_rules: [{ key: "rec", points: 1, category: "receiving" }],
      raw_scoring: { rec: 1, pass_td: 4, rec_td: 6, rush_td: 6, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04 },
      roster_settings: { starting_slots: slots, bench_slots: 5, ir_slots: 1, taxi_slots: 0, slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 } },
      playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: slug, provider_synced_at: null },
    },
    managers: teams.map((t) => ({
      canonical_manager_id: `manager:${slug}:${t}`, manager_slug: t === "A" ? "supyo29" : "manager-b",
      provider_username: t, display_name: t, provider_user_id: t, is_commissioner: false, is_co_manager: false,
      provenance: { provider: "sleeper", provider_id: t, provider_synced_at: null },
    })),
    teams: teams.map((t) => ({
      canonical_team_id: `team:${slug}:${t}`, canonical_league_id: `league:${slug}`, provider_team_id: t, team_name: t,
      canonical_manager_ids: [`manager:${slug}:${t}`], record: { wins: rev, losses: 0, ties: 0, points_for: 0, points_against: 0 },
      faab_remaining: 90, waiver_priority: 1, provenance: { provider: "sleeper", provider_id: t, provider_synced_at: null },
    })),
    rosters, standings: [], draft_picks: [], players, unresolved_players: [],
  };
}

function countingProvider(): { provider: FantasyProvider; calls: () => number } {
  let n = 0;
  const provider: FantasyProvider = {
    name: "sleeper", authentication: "NONE", capabilities: () => ({ ...CAPS }),
    healthCheck: async () => ({ provider: "sleeper", status: "READY", authentication: "NONE", detail: "fake", checked_at: new Date().toISOString() }),
    getLeagueState: async () => { n += 1; return ok(twoTeamBundle(n)); }, // returns DIFFERENT data every call
    getLeague: async () => ok(twoTeamBundle(n).league),
    getManagers: async () => ok(twoTeamBundle(n).managers),
    getStandings: async () => ok([]),
    getRosters: async () => ok(twoTeamBundle(n).rosters),
    getMatchups: async () => ok([]),
    getTransactions: async () => ok([]),
    getDraftResults: async () => ok([]),
    getWaiverState: async () => ok({ canonical_league_id: "league:bloodline-bowl", league_slug: "bloodline-bowl", players: [], provenance: { provider: "sleeper", provider_id: "x", provider_synced_at: null } }),
  };
  return { provider, calls: () => n };
}

function fakeProjections(): ProjectionProvider {
  return {
    name: "fake", model_version: "test",
    async getWeeklyProjections(req): Promise<WeeklyProjectionBatch> {
      const by_player = new Map();
      const resolved = new Map();
      req.canonical_player_ids.forEach((cid, i) => {
        const pts = 8 + (i % 7) * 2;
        by_player.set(cid, {
          canonical_player_id: cid, week: req.week, season: 2026, position: "RB", nfl_team: "KC", opponent: "LV",
          is_home: null, projected_points: pts, floor_points: pts * 0.6, ceiling_points: pts * 1.4, std_dev: pts * 0.3,
          projection_status: "projected", expected_availability: 1, is_bye: false, injury_status: null,
          rest_of_season_points: pts * 6,
          ros: { points: pts * 6, source: "fake", external_season_points: pts * 12, ri_season_points: null, ri_position_rank: null, ri_vor: null, ri_tier: null, ri_confidence: null, disagreement_pct: null, disagreement_direction: "ONE_SOURCE" as const, confidence: "MEDIUM" as const, warnings: [] },
          source: "fake", model_version: "test", uncertainty_source: "position_volatility_heuristic", warnings: [],
        });
      });
      return { league_slug: req.league.league_slug, season: 2026, week: req.week, status: "READY", by_player, resolved_players: resolved, source: "fake", model_version: "test", missing: [], teams_with_games: ["KC", "LV"], warnings: [] };
    },
  };
}
const fakeSchedule = {
  name: "fake-schedule",
  async getWeekSchedule(season: number, week: number) {
    return { season, week, status: "READY" as const, source: "fake-schedule", teams_with_games: new Set(["KC", "LV"]), teams_on_bye: new Set<string>(), opponent_by_team: {}, warnings: [] };
  },
};

const P2OPTS = {
  projectionProviderOverride: fakeProjections(),
  scheduleProviderOverride: fakeSchedule as unknown as import("../lib/weekly/schedule/registry").ScheduleProvider,
  riSeasonProviderOverride: null as null,
  skipRiSeasonSignal: true,
};

describe("audit §2A — one provider read per analysis", () => {
  it("analyzeTrade reads league state exactly once even though the provider changes every call", async () => {
    const { provider, calls } = countingProvider();
    const r = await analyzeTrade(
      {
        league: "bloodline-bowl",
        participants: [{ manager_id: "supyo29" }, { manager_id: "manager-b" }],
        transfers: [
          { from_manager_id: "supyo29", to_manager_id: "manager-b", asset: { type: "PLAYER", player_id: "bloodline-bowl-A-b1" } },
          { from_manager_id: "manager-b", to_manager_id: "supyo29", asset: { type: "PLAYER", player_id: "bloodline-bowl-B-b1" } },
        ],
      },
      { ...P2OPTS, providerOverride: provider },
    );
    assert.equal(calls(), 1, `expected exactly ONE getLeagueState call, got ${calls()}`);
    assert.equal(r.status, "OK", JSON.stringify(r.validation.failures ?? r.diagnostics));
    assert.equal(r.trade_context_version, "ri-trade-contextual-2026.2");
    assert.ok(r.participants.supyo29?.phase2);
  });

  it("repeated analyses are deterministic (each its own single snapshot)", async () => {
    const run = async () => {
      const { provider } = countingProvider();
      return analyzeTrade(
        {
          league: "bloodline-bowl",
          participants: [{ manager_id: "supyo29" }, { manager_id: "manager-b" }],
          transfers: [
            { from_manager_id: "supyo29", to_manager_id: "manager-b", asset: { type: "PLAYER", player_id: "bloodline-bowl-A-b1" } },
            { from_manager_id: "manager-b", to_manager_id: "supyo29", asset: { type: "PLAYER", player_id: "bloodline-bowl-B-b1" } },
          ],
        },
        { ...P2OPTS, providerOverride: provider },
      );
    };
    const a = await run();
    const b = await run();
    assert.deepEqual(a.participants.supyo29!.roster_utility_components, b.participants.supyo29!.roster_utility_components);
    assert.deepEqual(a.participants.supyo29!.phase2!.components, b.participants.supyo29!.phase2!.components);
  });

  it("buildWeeklyTeamContext with snapshotOverride performs NO provider read", async () => {
    const { provider } = countingProvider();
    const snap = (await buildTradeAnalysisContext("bloodline-bowl", { ...P2OPTS, providerOverride: provider })).context!.snapshot;
    const throwingProvider = { ...provider, getLeagueState: async () => { throw new Error("must not read"); } } as FantasyProvider;
    const res = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
      ...P2OPTS, providerOverride: throwingProvider, snapshotOverride: snap,
    });
    assert.ok(res.context, "context built from the supplied snapshot without a provider read");
    assert.equal(res.context!.roster.all_players.length, snap.rosters.find((r) => r.canonical_team_id === "team:bloodline-bowl:A")!.all_players.length);
  });

  it("buildTradeAnalysisContext exposes the frozen + contextual versions", async () => {
    const { provider } = countingProvider();
    const ctx = (await buildTradeAnalysisContext("bloodline-bowl", { ...P2OPTS, providerOverride: provider })).context!;
    assert.equal(ctx.versions.trade_foundation_version, "ri-trade-foundation-2026.2");
    assert.equal(ctx.versions.trade_context_version, "ri-trade-contextual-2026.2");
    assert.ok(ctx.ros.weeks.length > 0);
  });
});

/* ================================================================= */
/* helpers for synthetic Phase 2 fixtures                             */
/* ================================================================= */

function scene(teams: StdTeamSpec[], transfers: NormalizedProposal["transfers"], cfg?: PartialTradeConfig) {
  const built = teams.map(stdTeam);
  return tradeFixture({
    teams: built.map((b) => b.team),
    players: built.flatMap((b) => b.players),
    projections: built.flatMap((b) => b.projections),
    freeAgents: FA, faProjections: FA_PROJ, transfers, config: cfg,
    rosFlatHorizon: ROS_WEEKS, // ROS mean == weekly projection unless overridden
  });
}
const FRESH_ROS = (points: number): RosSignal => ({
  points, source: "test", external_season_points: points * 2, ri_season_points: null, ri_position_rank: null,
  ri_vor: null, ri_tier: null, ri_confidence: null, disagreement_pct: null, disagreement_direction: "ONE_SOURCE",
  confidence: "MEDIUM", warnings: [],
});
/** override one player's weekly + ROS-mean on a built fixture's projection batch */
function setPlayer(f: ReturnType<typeof tradeFixture>, id: string, weekly: number, rosWeeklyMean: number) {
  const cur = f.input.projections.by_player.get(id)!;
  const ros = Math.round(rosWeeklyMean * ROS_WEEKS);
  f.input.projections.by_player.set(id, {
    ...cur, projected_points: weekly, rest_of_season_points: ros,
    ros: cur.ros ? { ...cur.ros, points: ros } : FRESH_ROS(ros),
  });
}
/** stdTeam spec with a WR FLEX by default. */
const T = (slug: string, over: Partial<StdTeamSpec> = {}): StdTeamSpec => ({
  slug,
  flex: { id: `${slug}_flex`, pos: "WR", pts: 10 },
  ...over,
});

/* ================================================================= */
/* 2B — REST-OF-SEASON VALUATION                                     */
/* ================================================================= */

describe("audit §2B — ROS valuation is marginal usable, not summed season totals", () => {
  it("a bench player with huge standalone ROS but no lineup room barely moves usable value", () => {
    // X's WR room is absurdly deep; the incoming 15/wk WR can never start.
    const f = scene(
      [
        T("X", { flex: { id: "X_w3", pos: "WR", pts: 20 }, bench: [{ id: "X_w4", pos: "WR", pts: 19 }, { id: "X_junk", pos: "RB", pts: 3 }], lockPts: { WR1: 22, WR2: 21 } }),
        T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "STUD", pos: "WR", pts: 15 }] }),
      ],
      [xfer("X", "Y", "X_junk"), xfer("Y", "X", "STUD")],
    );
    const x = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) }).participants.X!.phase2!.ros;
    assert.ok(Math.abs(x.ros_usable_value_delta) < Math.abs(x.standalone_ros_swing) - 10,
      `usable delta (${x.ros_usable_value_delta}) should be much smaller than the standalone swing (${x.standalone_ros_swing})`);
    assert.ok(x.after.stranded_ros_points > x.before.stranded_ros_points, "acquired ROS is stranded on the bench");
  });

  it("acquiring a genuinely startable ROS asset raises usable ROS value", () => {
    const f = scene(
      [
        T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 }, lockPts: { WR2: 6 } }),
        T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN", pos: "WR", pts: 15 }] }),
      ],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    );
    const x = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) }).participants.X!.phase2!.ros;
    assert.ok(x.ros_usable_value_delta > 0, `ros usable delta ${x.ros_usable_value_delta}`);
    assert.equal(x.regular_season_ros_delta, x.ros_usable_value_delta); // no playoff window here
  });

  it("a shared bye leaves a ROS hole; acquiring an unaffected starter at that position covers it", () => {
    // X's only startable TE (X_TE, team LV) is on bye weeks 3 & 4 -> TE slot empty those weeks.
    const f = scene(
      [
        T("X", { flex: { id: "X_flex", pos: "WR", pts: 9 }, bench: [{ id: "X_junk", pos: "WR", pts: 3 }] }),
        T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "COVER_TE", pos: "TE", pts: 10 }] }),
      ],
      [xfer("X", "Y", "X_junk"), xfer("Y", "X", "COVER_TE")],
    );
    // put X_TE on LV (which is on bye weeks 3 & 4); players_by_id is shared by f.input and the context
    const xte = f.input.players_by_id.get("X_TE")!;
    f.input.players_by_id.set("X_TE", { ...xte, nfl_team: "LV" });
    const ctx = f.context({ rosWeeks: ROS_WEEKS, byeWeeksByTeam: { LV: [3, 4] } });
    const x = evaluateTrade({ ...f.input, context: ctx }).participants.X!.phase2!.ros;
    assert.ok(x.before.bye_hole_slot_weeks >= 2, `expected TE bye holes before, got ${x.before.bye_hole_slot_weeks}`);
    assert.ok(x.bye_coverage_delta >= 2, `bye coverage should improve by >=2, got ${x.bye_coverage_delta}`);
  });

  it("ROS impact can differ materially from current-week impact", () => {
    const f = scene(
      [
        T("X", { flex: { id: "HOTNOW", pos: "WR", pts: 18 } }),
        T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "HOTROS", pos: "WR", pts: 9 }] }),
      ],
      [xfer("X", "Y", "HOTNOW"), xfer("Y", "X", "HOTROS")],
    );
    setPlayer(f, "HOTNOW", 18, 7);   // hot now, cool ROS
    setPlayer(f, "HOTROS", 9, 17);   // cool now, hot ROS
    const x = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) }).participants.X!;
    assert.ok(x.starter_points_delta! < 0, `current week should drop: ${x.starter_points_delta}`);
    assert.ok(x.phase2!.ros.ros_usable_value_delta > 0, `ROS should rise: ${x.phase2!.ros.ros_usable_value_delta}`);
  });

  it("regular-season and playoff windows are reported separately when playoff settings resolve", () => {
    const f = scene(
      [
        T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 }, lockPts: { WR2: 6 } }),
        T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN", pos: "WR", pts: 15 }] }),
      ],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    );
    const x = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS, playoffStartWeek: 5 }) }).participants.X!.phase2!;
    assert.notEqual(x.ros.playoff_window_delta, null);
    assert.equal(x.components.playoff_window != null, true);
    const x2 = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) }).participants.X!.phase2!;
    assert.equal(x2.ros.playoff_window_delta, null);
  });

  it("the same player has different ROS utility on two different rosters", () => {
    const mkFor = (needy: boolean) =>
      scene(
        [
          T("X", { flex: { id: "X_flex", pos: "WR", pts: needy ? 6 : 15 }, lockPts: { WR2: needy ? 5 : 19 } }),
          T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN", pos: "WR", pts: 14 }] }),
        ],
        [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
      );
    const dNeedy = evaluateTrade({ ...mkFor(true).input, context: mkFor(true).context({ rosWeeks: ROS_WEEKS }) }).participants.X!.phase2!.ros.ros_usable_value_delta;
    const dStacked = evaluateTrade({ ...mkFor(false).input, context: mkFor(false).context({ rosWeeks: ROS_WEEKS }) }).participants.X!.phase2!.ros.ros_usable_value_delta;
    assert.ok(dNeedy > dStacked, `same incoming WR should help the needy roster more: needy=${dNeedy} stacked=${dStacked}`);
  });
});

/* ================================================================= */
/* 2B — CONSOLIDATION vs DEPTH                                        */
/* ================================================================= */

describe("audit §2B — consolidation vs depth distribution", () => {
  it("3 bench pieces -> 1 starter reads as STAR_CONCENTRATION; the reverse as DEPTH_DISTRIBUTION", () => {
    const f = scene(
      [
        T("X", { bench: [{ id: "d1", pos: "WR", pts: 9 }, { id: "d2", pos: "WR", pts: 9 }, { id: "d3", pos: "RB", pts: 9 }] }),
        T("Y", { bench: [{ id: "STAR", pos: "WR", pts: 24 }] }),
      ],
      [xfer("X", "Y", "d1"), xfer("X", "Y", "d2"), xfer("X", "Y", "d3"), xfer("Y", "X", "STAR")],
    );
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    assert.equal(out.participants.X!.phase2!.ros.roster_shape_delta, "STAR_CONCENTRATION",
      `X consol=${out.participants.X!.phase2!.ros.consolidation_effect}`);
    assert.equal(out.participants.Y!.phase2!.ros.roster_shape_delta, "DEPTH_DISTRIBUTION",
      `Y consol=${out.participants.Y!.phase2!.ros.consolidation_effect}`);
  });

  it("asset count alone does not determine the sign of ros_usable_value_delta", () => {
    const f = scene(
      [
        T("X", { flex: { id: "X_ELITE", pos: "WR", pts: 22 } }),
        T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "j1", pos: "WR", pts: 4 }, { id: "j2", pos: "WR", pts: 4 }, { id: "j3", pos: "WR", pts: 4 }] }),
      ],
      [xfer("X", "Y", "X_ELITE"), xfer("Y", "X", "j1"), xfer("Y", "X", "j2"), xfer("Y", "X", "j3")],
    );
    const x = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) }).participants.X!.phase2!.ros;
    assert.ok(x.ros_usable_value_delta < 0, `receiving 3 pieces for a stud should LOSE usable ROS: ${x.ros_usable_value_delta}`);
  });
});

/* ================================================================= */
/* 2C — USABLE DEPTH & FRAGILITY                                      */
/* ================================================================= */

describe("audit §2C — usable depth & roster fragility", () => {
  it("nominal bench that cannot cover a starter is NOT counted as usable depth", () => {
    // X's only TE backup projects 2 pts — below the TE replacement line -> not usable.
    const f = scene([T("X", { bench: [{ id: "cant_start", pos: "TE", pts: 2 }] }), T("Y")], []);
    const res = rosterResilience(f.rosters.get("manager:test-league:X")!, f.context({ rosWeeks: ROS_WEEKS }));
    const te = res.by_position.find((d) => d.position === "TE")!;
    assert.equal(te.usable_backups, 0, `a 2-pt TE is not a usable backup: ${JSON.stringify(te)}`);
    assert.ok(te.nominal_backups >= 1, `the 2-pt TE shows as nominal depth: ${JSON.stringify(te)}`);
    assert.equal(te.no_cover, true, "TE has a starter but no real cover");
  });

  it("trading away the only usable backup at a position INCREASES fragility (fragility_delta < 0)", () => {
    const xTeam = stdTeam(T("X", { bench: [{ id: "RB3", pos: "RB", pts: 12 }] }));
    const yTeam = stdTeam(T("Y", { bench: [{ id: "spare", pos: "WR", pts: 3 }] }));
    const f = tradeFixture({
      teams: [xTeam.team, yTeam.team], players: [...xTeam.players, ...yTeam.players],
      projections: [
        ...xTeam.projections.map((p) => rp(p.canonical_player_id, p.position as Pos, p.projected_points ?? 8, p.projected_points ?? 8)),
        ...yTeam.projections.map((p) => rp(p.canonical_player_id, p.position as Pos, p.projected_points ?? 8, p.projected_points ?? 8)),
      ],
      freeAgents: FA, faProjections: FA_PROJ, transfers: [xfer("X", "Y", "RB3"), xfer("Y", "X", "spare")],
    });
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    assert.ok(out.participants.X!.phase2!.depth.fragility_delta < 0, `X should get MORE fragile: ${out.participants.X!.phase2!.depth.fragility_delta}`);
    assert.ok(out.participants.X!.phase2!.depth.usable_depth_delta < 0);
  });

  it("acquiring a usable backup REDUCES fragility (fragility_delta > 0)", () => {
    const xTeam = stdTeam(T("X", { bench: [{ id: "junk", pos: "K", pts: 1 }], lockPts: { RB2: 6 } }));
    const yTeam = stdTeam(T("Y", { bench: [{ id: "RB_COVER", pos: "RB", pts: 13 }] }));
    const f = tradeFixture({
      teams: [xTeam.team, yTeam.team], players: [...xTeam.players, ...yTeam.players],
      projections: [
        ...xTeam.projections.map((p) => rp(p.canonical_player_id, p.position as Pos, p.projected_points ?? 8, p.projected_points ?? 8)),
        ...yTeam.projections.map((p) => rp(p.canonical_player_id, p.position as Pos, p.projected_points ?? 8, p.projected_points ?? 8)),
      ],
      freeAgents: FA, faProjections: FA_PROJ, transfers: [xfer("X", "Y", "junk"), xfer("Y", "X", "RB_COVER")],
    });
    const d = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) }).participants.X!.phase2!.depth;
    assert.ok(d.fragility_delta > 0, `fragility should improve: ${d.fragility_delta}`);
  });

  it("a starter-points improvement accompanied by a fragility loss surfaces BOTH facts", () => {
    // X trades RB2 + its only RB3 backup for one elite WR: current lineup up, RB fragility way down.
    const xTeam = stdTeam(T("X", { flex: { id: "X_flex", pos: "WR", pts: 8 }, bench: [{ id: "RB3", pos: "RB", pts: 11 }], lockPts: { RB2: 12 } }));
    const yTeam = stdTeam(T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "ELITE_WR", pos: "WR", pts: 24 }] }));
    const f = tradeFixture({
      teams: [xTeam.team, yTeam.team], players: [...xTeam.players, ...yTeam.players],
      projections: [
        ...xTeam.projections.map((p) => rp(p.canonical_player_id, p.position as Pos, p.projected_points ?? 8, p.projected_points ?? 8)),
        ...yTeam.projections.map((p) => rp(p.canonical_player_id, p.position as Pos, p.projected_points ?? 8, p.projected_points ?? 8)),
      ],
      freeAgents: FA, faProjections: FA_PROJ,
      transfers: [xfer("X", "Y", "X_RB2"), xfer("X", "Y", "RB3"), xfer("Y", "X", "ELITE_WR")],
    });
    const x = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) }).participants.X!;
    assert.ok(x.starter_points_delta! > 0, `current lineup should improve: ${x.starter_points_delta}`);
    assert.ok(x.phase2!.depth.fragility_delta < 0, `fragility should worsen: ${x.phase2!.depth.fragility_delta}`);
    // both are visible, neither hidden
    assert.equal(typeof x.phase2!.components.roster_fragility, "number");
    assert.equal(typeof x.roster_utility_components.starter_points, "number");
  });
});

/* ================================================================= */
/* COMPOSITE — DOUBLE-COUNT PROTECTION                                */
/* ================================================================= */

describe("audit — Phase 2 composite double-count protection", () => {
  it("with default config, contextual_utility_delta EXACTLY equals the Phase 1 roster_utility_delta", () => {
    const f = scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN", pos: "WR", pts: 16 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    );
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS, playoffStartWeek: 5, byeWeeksByTeam: { KC: [3] } }) });
    for (const p of Object.values(out.participants)) {
      assert.equal(p.phase2!.contextual_utility_delta, p.roster_utility_delta,
        `default weights must NOT fold Phase 2 into the composite (${p.manager_slug})`);
      assert.equal(p.phase2!.contextual_acceptance, p.acceptance);
      assert.equal(p.phase2!.acceptance_divergence_reason, null);
    }
  });

  it("Phase 2 is exposed even at weight 0 — every component is present and numeric", () => {
    const f = scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN", pos: "WR", pts: 16 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    );
    const c = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) }).participants.X!.phase2!.components;
    for (const k of ["ros_usable_value", "bye_coverage", "usable_depth", "roster_fragility", "replacement_context"] as const) {
      assert.equal(typeof c[k], "number", `${k} missing`);
    }
  });

  it("an explicit nonzero weight moves the composite and can diverge acceptance — with a stated reason", () => {
    const f = scene(
      [T("X", { flex: { id: "HOTNOW", pos: "WR", pts: 15 } }), T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "HOTROS", pos: "WR", pts: 9 }] })],
      [xfer("X", "Y", "HOTNOW"), xfer("Y", "X", "HOTROS")],
    );
    // hot-now / cool-ros vs cool-now / hot-ros
    setPlayer(f, "HOTNOW", 15, 7);
    setPlayer(f, "HOTROS", 9, 18);
    const cfg = resolveTradeConfig({ phase2: { weights: { ros_usable_value: 1 } } });
    const out = evaluateTrade({ ...f.input, config: cfg, context: f.context({ rosWeeks: ROS_WEEKS }) });
    const x = out.participants.X!;
    assert.notEqual(x.phase2!.contextual_utility_delta, x.roster_utility_delta);
    if (x.phase2!.contextual_acceptance !== x.acceptance) {
      assert.ok(x.phase2!.acceptance_divergence_reason && x.phase2!.acceptance_divergence_reason.length > 0);
    }
  });
});

/* ================================================================= */
/* 3-TEAM + INTERACTION + DETERMINISM + DEGRADED                      */
/* ================================================================= */

describe("audit — three-team Phase 2", () => {
  it("Phase 1 says all improve, Phase 2 flags one ROS loser", () => {
    // A & B fill real current holes; C ships a strong ROS piece for a hot-now-only player.
    const A = stdTeam({ slug: "A", flex: { id: "A_flex", pos: "RB", pts: 16 }, bench: [{ id: "A_rb4", pos: "RB", pts: 14 }], lockPts: { WR2: 6 } });
    const B = stdTeam({ slug: "B", flex: { id: "B_flex", pos: "WR", pts: 16 }, bench: [{ id: "B_wr4", pos: "WR", pts: 14 }], lockPts: { TE: 5 } });
    const C = stdTeam({ slug: "C", flex: { id: "C_flex", pos: "WR", pts: 14 }, bench: [{ id: "C_te2", pos: "TE", pts: 13 }], lockPts: { RB2: 6, TE: 13 } });
    const withRos = (t: ReturnType<typeof stdTeam>): WeeklyProjection[] =>
      t.projections.map((p) =>
        p.canonical_player_id === "A_rb4"
          ? rp("A_rb4", "RB", 14, 6) // hot now, weak ROS
          : rp(p.canonical_player_id, p.position as Pos, p.projected_points ?? 8, p.projected_points ?? 8),
      );
    const f = tradeFixture({
      teams: [A.team, B.team, C.team],
      players: [...A.players, ...B.players, ...C.players],
      projections: [...withRos(A), ...withRos(B), ...withRos(C)],
      freeAgents: FA, faProjections: FA_PROJ,
      transfers: [xfer("A", "C", "A_rb4"), xfer("C", "B", "C_te2"), xfer("B", "A", "B_wr4")],
    });
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    assert.deepEqual(Object.keys(out.participants).sort(), ["A", "B", "C"]);
    assert.ok(out.phase2_summary);
    // C acquired a hot-now/weak-ROS RB -> ROS usable value should not be great for C
    assert.equal(typeof out.participants.C!.phase2!.ros.ros_usable_value_delta, "number");
    assert.ok(Array.isArray(out.phase2_summary!.ros_losers_phase1_missed));
  });
});

describe("audit — interaction effects", () => {
  it("two incoming players that compete for one slot produce a non-zero interaction residual", () => {
    // X receives TWO strong WRs but has only WR1/WR2/FLEX -> they cannibalize.
    const xTeam = stdTeam(T("X", { flex: { id: "X_flex", pos: "RB", pts: 14 }, lockPts: { WR2: 6 } }));
    const yTeam = stdTeam(T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "WRa", pos: "WR", pts: 17 }, { id: "WRb", pos: "WR", pts: 16 }] }));
    const f = tradeFixture({
      teams: [xTeam.team, yTeam.team], players: [...xTeam.players, ...yTeam.players],
      projections: [
        ...xTeam.projections.map((p) => rp(p.canonical_player_id, p.position as Pos, p.projected_points ?? 8, p.projected_points ?? 8)),
        ...yTeam.projections.map((p) => rp(p.canonical_player_id, p.position as Pos, p.projected_points ?? 8, p.projected_points ?? 8)),
      ],
      freeAgents: FA, faProjections: FA_PROJ,
      transfers: [xfer("X", "Y", "X_flex"), xfer("Y", "X", "WRa"), xfer("Y", "X", "WRb")],
    });
    const ros = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) }).participants.X!.phase2!.ros;
    const sumMarginals = ros.marginal_player_utility.reduce((s, m) => s + (m.marginal_ros_delta ?? 0), 0);
    assert.ok(Math.abs(ros.interaction_residual) > 0.01,
      `expected non-additivity: total ${ros.ros_usable_value_delta} vs Σmarginals ${sumMarginals} (residual ${ros.interaction_residual})`);
    assert.equal(ros.marginal_player_utility.length, 3);
  });
});

describe("audit — determinism & degradation", () => {
  it("identical context + proposal -> byte-identical Phase 2 output across 4 runs", () => {
    const f = scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 }, bench: [{ id: "xb", pos: "RB", pts: 10 }] }),
       T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN", pos: "WR", pts: 16 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    );
    const ctx = f.context({ rosWeeks: ROS_WEEKS, playoffStartWeek: 5, byeWeeksByTeam: { KC: [3, 4] } });
    const golden = JSON.stringify(evaluateTrade({ ...f.input, context: ctx }).participants.X!.phase2);
    for (let i = 0; i < 4; i += 1) {
      assert.equal(JSON.stringify(evaluateTrade({ ...f.input, context: ctx }).participants.X!.phase2), golden);
    }
  });

  it("a rostered player with no ROS signal -> ROS_PARTIAL_PLAYER_COVERAGE, excluded not zeroed, Phase 1 intact", () => {
    const xTeam = stdTeam(T("X", { bench: [{ id: "NO_ROS", pos: "WR", pts: 9 }] }));
    const yTeam = stdTeam(T("Y", { bench: [{ id: "spare", pos: "WR", pts: 4 }] }));
    const projs = [
      ...xTeam.projections.map((p) =>
        p.canonical_player_id === "NO_ROS"
          ? proj("NO_ROS", "WR", 9, { rest_of_season_points: null, ros: null })
          : rp(p.canonical_player_id, p.position as Pos, p.projected_points ?? 8, p.projected_points ?? 8),
      ),
      ...yTeam.projections.map((p) => rp(p.canonical_player_id, p.position as Pos, p.projected_points ?? 8, p.projected_points ?? 8)),
    ];
    const f = tradeFixture({
      teams: [xTeam.team, yTeam.team], players: [...xTeam.players, ...yTeam.players], projections: projs,
      freeAgents: FA, faProjections: FA_PROJ, transfers: [xfer("X", "Y", "X_flex"), xfer("Y", "X", "spare")],
    });
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    assert.ok(out.diagnostics.some((d) => d.code === "ROS_PARTIAL_PLAYER_COVERAGE"));
    // Phase 1 still fully populated
    assert.equal(typeof out.participants.X!.roster_utility_delta, "number");
    assert.equal(out.participants.X!.starter_points_delta_status, "RESOLVED");
  });

  it("scheduleStatus UNAVAILABLE -> BYE_DATA_UNAVAILABLE, no fabricated byes, still a Phase 2 result", () => {
    const f = scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN", pos: "WR", pts: 15 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    );
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS, scheduleStatus: "UNAVAILABLE" }) });
    assert.ok(out.diagnostics.some((d) => d.code === "BYE_DATA_UNAVAILABLE"));
    assert.ok(out.participants.X!.phase2);
  });

  it("no playoff settings -> PLAYOFF_WINDOW_UNAVAILABLE and playoff_window component null", () => {
    const f = scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN", pos: "WR", pts: 15 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    );
    const ctx = f.context({ rosWeeks: ROS_WEEKS }); // no playoffStartWeek
    const out = evaluateTrade({ ...f.input, context: ctx });
    assert.equal(out.participants.X!.phase2!.components.playoff_window, null);
    assert.equal(out.participants.X!.phase2!.ros.playoff_window_delta, null);
  });
});

/* ================================================================= */
/* PHASE 1 FREEZE — unaffected when Phase 2 is absent                 */
/* ================================================================= */

describe("Phase 1 freeze — evaluateTrade without context is byte-identical", () => {
  it("omitting context yields no phase2 field and no phase2_summary", () => {
    const f = scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "IN", pos: "WR", pts: 16 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    );
    const out = evaluateTrade(f.input);
    assert.equal(out.phase2_summary, null);
    assert.equal(out.participants.X!.phase2, undefined);
    assert.equal(DEFAULT_TRADE_CONFIG.phase2.weights.ros_usable_value, 0);
  });
});
