/**
 * PR #3 final pass — issues 1 & 2.
 *
 * 1. A provider FAILURE (PROVIDER_ERROR / empty degraded shell) must propagate as
 *    the provider failure it is — never be resolved against an empty manager list
 *    and mis-reported as `404 manager_not_in_league`. Honest AUTH_REQUIRED /
 *    NOT_CONFIGURED behavior is preserved.
 *
 * 2. Weekly intelligence is only defined for the CURRENT canonical league week.
 *    A non-current week is rejected `NON_CURRENT_WEEK_UNSUPPORTED` — never
 *    silently served with today's roster against a historical/future matchup.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWeeklyTeamContext } from "../lib/weekly/context";
import { runWithWeeklyContext } from "../lib/weekly/intelligence";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import { setPersistence, memoryPersistence } from "../lib/persistence";
import { ok, degraded } from "../lib/providers/types";
import type { CanonicalLeagueStateBundle, FantasyProvider } from "../lib/providers/types";
import type { ProjectionProvider } from "../lib/weekly/projections/types";
import type { WeeklyProjectionBatch } from "../lib/weekly/schema";

setPersistence(memoryPersistence());
const cw = () => new PlayerCrosswalk(NoCrosswalk);

const CAPS = {
  league: true, settings: true, managers: true, standings: true, rosters: true, matchups: true,
  transactions: true, players: true, free_agents: true, waivers: true, draft_results: true, live_authenticated_access: true,
} as const;

/** A provider whose getLeagueState fails outright. */
function failingProvider(status: "PROVIDER_ERROR" | "AUTH_REQUIRED" | "NOT_CONFIGURED"): FantasyProvider {
  return {
    name: "sleeper",
    authentication: "NONE",
    capabilities: () => ({ ...CAPS }),
    healthCheck: async () => ({ provider: "sleeper", status, authentication: "NONE", detail: "fake", checked_at: new Date().toISOString() }),
    getLeagueState: async () => degraded(status, `${status.toLowerCase()}`, `provider is ${status}`),
    getLeague: async () => degraded(status, "x", "x"),
    getManagers: async () => degraded(status, "x", "x"),
    getStandings: async () => degraded(status, "x", "x"),
    getRosters: async () => degraded(status, "x", "x"),
    getMatchups: async () => degraded(status, "x", "x"),
    getTransactions: async () => degraded(status, "x", "x"),
    getDraftResults: async () => degraded(status, "x", "x"),
    getWaiverState: async () => degraded(status, "x", "x"),
  } satisfies FantasyProvider;
}

/** A healthy provider whose league current_week is `currentWeek`. */
function healthyProvider(currentWeek: number): FantasyProvider {
  const slug = "bloodline-bowl";
  const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];
  const ids = ["qb", "rb1", "rb2", "wr1", "wr2", "te", "rb3", "k", "def"].map((x) => `player:sleeper:${slug}-${x}`);
  const p = (id: string, pos: "QB" | "RB" | "WR" | "TE" | "K" | "DEF") => ({
    canonical_player_id: `player:sleeper:${slug}-${id}`, full_name: `${slug} ${id}`, first_name: null, last_name: null,
    position: pos, eligible_positions: [pos], nfl_team: "KC", is_team_defense: pos === "DEF", status: null,
    injury_status: null, identifiers: { sleeper_id: `${slug}-${id}` },
    resolution: { method: "stable_id" as const, confidence: "high" as const, note: null },
  });
  const players = ["qb", "rb1", "rb2", "wr1", "wr2", "te", "rb3", "k", "def"].map((x, i) =>
    p(x, (["QB", "RB", "RB", "WR", "WR", "TE", "RB", "K", "DEF"] as const)[i]!));
  const roster = {
    canonical_roster_id: `roster:${slug}:1`, canonical_team_id: `team:${slug}:1`,
    slots: slots.map((slot, i) => ({ slot, slot_index: i, canonical_player_id: ids[i]!, is_empty: false })),
    starters: ids, bench: [], ir: [], taxi: [], all_players: ids,
    provenance: { provider: "sleeper" as const, provider_id: "1", provider_synced_at: null },
  };
  const bundle: CanonicalLeagueStateBundle = {
    league: {
      canonical_league_id: `league:${slug}`, league_slug: slug, name: slug, season: 2026, status: "in_season",
      sport: "nfl", team_count: 2, current_week: currentWeek,
      scoring_rules: [{ key: "rec", points: 0.5, category: "receiving" }],
      raw_scoring: { rec: 0.5, pass_td: 4, rec_td: 6, rush_td: 6, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04 },
      roster_settings: { starting_slots: slots, bench_slots: 5, ir_slots: 1, taxi_slots: 0, slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 } },
      playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: slug, provider_synced_at: null },
    },
    managers: [{
      canonical_manager_id: `manager:${slug}:u-supyo`, manager_slug: "supyo29", provider_username: "supyo29",
      display_name: "supyo29", provider_user_id: "u-supyo", is_commissioner: false, is_co_manager: false,
      provenance: { provider: "sleeper", provider_id: "u-supyo", provider_synced_at: null },
    }],
    teams: [{
      canonical_team_id: `team:${slug}:1`, canonical_league_id: `league:${slug}`, provider_team_id: "1",
      team_name: "t1", canonical_manager_ids: [`manager:${slug}:u-supyo`],
      record: { wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0 },
      faab_remaining: 90, waiver_priority: 1,
      provenance: { provider: "sleeper", provider_id: "1", provider_synced_at: null },
    }],
    rosters: [roster], standings: [], draft_picks: [], players, unresolved_players: [],
  };
  return {
    name: "sleeper", authentication: "NONE", capabilities: () => ({ ...CAPS }),
    healthCheck: async () => ({ provider: "sleeper", status: "READY", authentication: "NONE", detail: "fake", checked_at: new Date().toISOString() }),
    getLeagueState: async () => ok(bundle),
    getLeague: async () => ok(bundle.league),
    getManagers: async () => ok(bundle.managers),
    getStandings: async () => ok(bundle.standings),
    getRosters: async () => ok(bundle.rosters),
    getMatchups: async () => ok([]),
    getTransactions: async () => ok([]),
    getDraftResults: async () => ok([]),
    getWaiverState: async () => ok({ canonical_league_id: `league:${slug}`, league_slug: slug, players: [], provenance: { provider: "sleeper", provider_id: slug, provider_synced_at: null } }),
  } satisfies FantasyProvider;
}

const fakeSchedule = {
  name: "fake-schedule",
  async getWeekSchedule(season: number, week: number) {
    return { season, week, status: "READY" as const, source: "fake-schedule", teams_with_games: new Set(["KC", "LV"]), teams_on_bye: new Set<string>(), opponent_by_team: {}, warnings: [] };
  },
};
function fakeProjections(): ProjectionProvider {
  return {
    name: "fake", model_version: "test",
    async getWeeklyProjections(req): Promise<WeeklyProjectionBatch> {
      const by_player = new Map();
      for (const cid of req.canonical_player_ids) {
        by_player.set(cid, {
          canonical_player_id: cid, week: req.week, season: 2026, position: "RB", nfl_team: "KC", opponent: "LV",
          is_home: null, projected_points: 10, floor_points: 6, ceiling_points: 14, std_dev: 4,
          projection_status: "projected", expected_availability: 1, is_bye: false, injury_status: null,
          rest_of_season_points: 120, ros: null, source: "fake", model_version: "test",
          uncertainty_source: "position_volatility_heuristic", warnings: [],
        });
      }
      return { league_slug: req.league.league_slug, season: 2026, week: req.week, status: "READY", by_player, resolved_players: new Map(), source: "fake", model_version: "test", missing: [], teams_with_games: ["KC", "LV"], warnings: [] };
    },
  };
}

describe("issue 1 — provider errors do not become manager_not_in_league", () => {
  it("PROVIDER_ERROR propagates as a provider failure (502), NOT a 404 manager error", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
      providerOverride: failingProvider("PROVIDER_ERROR"),
      projectionProviderOverride: fakeProjections(),
      scheduleProviderOverride: fakeSchedule,
      riSeasonProviderOverride: null,
      crosswalkOverride: cw(),
    });
    assert.equal(r.ok, false);
    assert.equal(r.context, null);
    assert.equal(r.code, "PROVIDER_ERROR");
    assert.notEqual(r.code, "manager_not_in_league");
    assert.equal(r.status, 502);
  });

  it("the weekly route surfaces the provider failure, not a 404", async () => {
    const view = await runWithWeeklyContext(
      "bloodline-bowl",
      "supyo29",
      {
        providerOverride: failingProvider("PROVIDER_ERROR"),
        projectionProviderOverride: fakeProjections(),
        scheduleProviderOverride: fakeSchedule,
        riSeasonProviderOverride: null,
        crosswalkOverride: cw(),
      },
      (ctx) => ctx.league.slug,
    );
    assert.equal(view.data, null);
    assert.equal(view.code, "PROVIDER_ERROR");
    assert.equal(view.status, 502);
    assert.notEqual(view.code, "manager_not_in_league");
  });

  it("AUTH_REQUIRED stays an honest 200 'configure me' (unchanged)", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
      providerOverride: failingProvider("AUTH_REQUIRED"),
      projectionProviderOverride: fakeProjections(),
      scheduleProviderOverride: fakeSchedule,
      riSeasonProviderOverride: null,
      crosswalkOverride: cw(),
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.code, "AUTH_REQUIRED");
    assert.equal(r.context, null);
  });

  it("NOT_CONFIGURED stays an honest 200 'configure me' (unchanged)", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
      providerOverride: failingProvider("NOT_CONFIGURED"),
      projectionProviderOverride: fakeProjections(),
      scheduleProviderOverride: fakeSchedule,
      riSeasonProviderOverride: null,
      crosswalkOverride: cw(),
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.code, "NOT_CONFIGURED");
  });
});

describe("issue 2 — weekly intelligence is current-week only", () => {
  const opts = (week?: number) => ({
    ...(week != null ? { week } : {}),
    providerOverride: healthyProvider(3),
    projectionProviderOverride: fakeProjections(),
    scheduleProviderOverride: fakeSchedule,
    riSeasonProviderOverride: null as null,
    crosswalkOverride: cw(),
  });

  it("current week (3) succeeds", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", opts(3));
    assert.ok(r.context, r.detail);
    assert.equal(r.context.league.week, 3);
  });

  it("no explicit week defaults to the current week and succeeds", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", opts());
    assert.ok(r.context, r.detail);
    assert.equal(r.context.league.week, 3);
  });

  it("a PAST week is explicitly unsupported (never silently served)", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", opts(2));
    assert.equal(r.ok, false);
    assert.equal(r.context, null);
    assert.equal(r.code, "NON_CURRENT_WEEK_UNSUPPORTED");
    assert.equal(r.status, 400);
  });

  it("a FUTURE week is explicitly unsupported (never silently served)", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", opts(8));
    assert.equal(r.ok, false);
    assert.equal(r.context, null);
    assert.equal(r.code, "NON_CURRENT_WEEK_UNSUPPORTED");
    assert.equal(r.status, 400);
  });
});

setPersistence(null);
