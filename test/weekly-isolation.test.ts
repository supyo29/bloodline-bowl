/**
 * Weekly engine — multi-league isolation + honest degradation (PART XVI).
 *
 *  - Bloodline data cannot leak into Devoted (and vice-versa)
 *  - manager routing stays correct
 *  - scoring settings stay league-specific
 *  - persistence independence: analytics run from canonical current-state even
 *    when historical persistence is degraded
 *  - a missing projection source degrades explicitly and never becomes 0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWeeklyTeamContext } from "../lib/weekly/context";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import { setPersistence, memoryPersistence } from "../lib/persistence";
import type {
  CanonicalLeagueStateBundle,
  FantasyProvider,
} from "../lib/providers/types";
import { ok } from "../lib/providers/types";
import type { ProjectionProvider } from "../lib/weekly/projections/types";
import type { WeeklyProjectionBatch } from "../lib/weekly/schema";

setPersistence(memoryPersistence());

function fakeProvider(slug: string): FantasyProvider {
  const rec = slug === "devoted-to-the-game" ? 1 : 0.5;
  const team = (n: number, mgr: string, user: string) => ({
    canonical_team_id: `team:${slug}:${n}`,
    canonical_league_id: `league:${slug}`,
    provider_team_id: String(n),
    team_name: `${slug} team ${n}`,
    canonical_manager_ids: [`manager:${slug}:${user}`],
    record: { wins: n, losses: 0, ties: 0, points_for: 100 + n, points_against: 90 },
    faab_remaining: 90,
    waiver_priority: n,
    provenance: { provider: "sleeper" as const, provider_id: String(n), provider_synced_at: null },
  });
  const mgr = (user: string, mslug: string) => ({
    canonical_manager_id: `manager:${slug}:${user}`,
    manager_slug: mslug,
    provider_username: mslug,
    display_name: mslug,
    provider_user_id: user,
    is_commissioner: false,
    is_co_manager: false,
    provenance: { provider: "sleeper" as const, provider_id: user, provider_synced_at: null },
  });
  const p = (id: string, pos: "QB" | "RB" | "WR" | "TE" | "K" | "DEF") => ({
    canonical_player_id: `player:sleeper:${slug}-${id}`,
    full_name: `${slug} ${id}`,
    first_name: null,
    last_name: null,
    position: pos,
    eligible_positions: [pos],
    nfl_team: "KC",
    is_team_defense: pos === "DEF",
    status: null,
    injury_status: null,
    identifiers: { sleeper_id: `${slug}-${id}` },
    resolution: { method: "stable_id" as const, confidence: "high" as const, note: null },
  });
  const roster = (n: number) => {
    const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];
    const ids = ["qb", "rb1", "rb2", "wr1", "wr2", "te", "rb3", "k", "def"].map((x) => `player:sleeper:${slug}-t${n}-${x}`);
    return {
      canonical_roster_id: `roster:${slug}:${n}`,
      canonical_team_id: `team:${slug}:${n}`,
      slots: slots.map((slot, i) => ({ slot, slot_index: i, canonical_player_id: ids[i]!, is_empty: false })),
      starters: ids,
      bench: [],
      ir: [],
      taxi: [],
      all_players: ids,
      provenance: { provider: "sleeper" as const, provider_id: String(n), provider_synced_at: null },
    };
  };
  const managers = slug === "bloodline-bowl"
    ? [mgr("u-supyo", "supyo29"), mgr("u-biji", "bijimac")]
    : [mgr("u-darth", "darthmarker"), mgr("u-other", "other")];
  const players = [1, 2].flatMap((n) =>
    ["qb", "rb1", "rb2", "wr1", "wr2", "te", "rb3", "k", "def"].map((x, i) =>
      p(`t${n}-${x}`, (["QB", "RB", "RB", "WR", "WR", "TE", "RB", "K", "DEF"] as const)[i]!),
    ),
  );
  const bundle: CanonicalLeagueStateBundle = {
    league: {
      canonical_league_id: `league:${slug}`,
      league_slug: slug,
      name: slug,
      season: 2026,
      status: "in_season",
      sport: "nfl",
      team_count: 2,
      current_week: 3,
      scoring_rules: [{ key: "rec", points: rec, category: "receiving" }],
      raw_scoring: { rec, pass_td: 4, rec_td: 6, rush_td: 6, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04 },
      roster_settings: {
        starting_slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"],
        bench_slots: 5,
        ir_slots: 1,
        taxi_slots: 0,
        slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 },
      },
      playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 },
      waiver_settings: { type: slug === "devoted-to-the-game" ? "reverse_standings" : "faab", faab_budget: slug === "devoted-to-the-game" ? null : 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: slug, provider_synced_at: null },
    },
    managers,
    teams: [team(1, managers[0]!.manager_slug, managers[0]!.provider_user_id!), team(2, managers[1]!.manager_slug, managers[1]!.provider_user_id!)],
    rosters: [roster(1), roster(2)],
    standings: [
      { canonical_team_id: `team:${slug}:1`, rank: 1, wins: 2, losses: 1, ties: 0, win_percentage: 0.66, points_for: 300, points_against: 280, games_played: 3, playoff_seed: 1 },
      { canonical_team_id: `team:${slug}:2`, rank: 2, wins: 1, losses: 2, ties: 0, win_percentage: 0.33, points_for: 280, points_against: 300, games_played: 3, playoff_seed: 2 },
    ],
    draft_picks: [],
    players,
    unresolved_players: [],
  };
  return {
    name: "sleeper",
    authentication: "NONE",
    capabilities: () => ({ league: true, settings: true, managers: true, standings: true, rosters: true, matchups: true, transactions: true, players: true, free_agents: true, waivers: true, draft_results: true, live_authenticated_access: true }),
    healthCheck: async () => ({ provider: "sleeper", status: "READY", authentication: "NONE", detail: "fake", checked_at: new Date().toISOString() }),
    getLeagueState: async () => ok(bundle),
    getLeague: async () => ok(bundle.league),
    getManagers: async () => ok(bundle.managers),
    getStandings: async () => ok(bundle.standings),
    getRosters: async () => ok(bundle.rosters),
    getMatchups: async () =>
      ok([
        {
          canonical_matchup_id: `matchup:${slug}:w3:1`,
          canonical_league_id: `league:${slug}`,
          week: 3,
          status: "pre" as const,
          sides: [
            { canonical_team_id: `team:${slug}:1`, canonical_manager_ids: [], starters: [], bench: [], actual_points: null, player_points: {}, projected_points: null },
            { canonical_team_id: `team:${slug}:2`, canonical_manager_ids: [], starters: [], bench: [], actual_points: null, player_points: {}, projected_points: null },
          ],
          provenance: { provider: "sleeper" as const, provider_id: null, provider_synced_at: null },
        },
      ]),
    getTransactions: async () => ok([]),
    getDraftResults: async () => ok([]),
    getWaiverState: async () => ok({ canonical_league_id: `league:${slug}`, league_slug: slug, players: [], provenance: { provider: "sleeper", provider_id: slug, provider_synced_at: null } }),
  } satisfies FantasyProvider;
}

/** A projection provider that ONLY knows about `slug`'s players. */
function fakeProjections(slug: string, status: WeeklyProjectionBatch["status"] = "READY"): ProjectionProvider {
  return {
    name: `fake-${slug}`,
    model_version: "test",
    async getWeeklyProjections(req) {
      const by_player = new Map<string, ReturnType<() => never>>() as WeeklyProjectionBatch["by_player"];
      const resolved_players: WeeklyProjectionBatch["resolved_players"] = new Map();
      if (status !== "PROJECTIONS_UNAVAILABLE") {
        for (const cid of req.canonical_player_ids) {
          if (!cid.includes(slug)) continue; // never project another league's player
          by_player.set(cid, {
            canonical_player_id: cid,
            week: req.week,
            season: 2026,
            position: "RB",
            nfl_team: "KC",
            opponent: "LV",
            is_home: null,
            projected_points: 10,
            floor_points: 6,
            ceiling_points: 14,
            std_dev: 4,
            projection_status: "projected",
            expected_availability: 1,
            is_bye: false,
            injury_status: null,
            rest_of_season_points: 120,
            source: this.name,
            model_version: this.model_version,
            uncertainty_source: "position_volatility_heuristic",
            warnings: [],
          });
        }
      }
      return {
        league_slug: req.league.league_slug,
        season: 2026,
        week: req.week,
        status: status === "PROJECTIONS_UNAVAILABLE" ? "PROJECTIONS_UNAVAILABLE" : by_player.size === 0 ? "PROJECTIONS_UNAVAILABLE" : "READY",
        by_player,
        resolved_players,
        source: this.name,
        model_version: this.model_version,
        missing: status === "PROJECTIONS_UNAVAILABLE" ? [...req.canonical_player_ids] : [],
        teams_with_games: ["KC", "LV"],
        warnings: [],
      };
    },
  };
}

const cw = () => new PlayerCrosswalk(NoCrosswalk);

describe("weekly context: league isolation", () => {
  it("Bloodline context contains ONLY Bloodline players/teams/scoring", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
      week: 3,
      providerOverride: fakeProvider("bloodline-bowl"),
      projectionProviderOverride: fakeProjections("bloodline-bowl"),
      crosswalkOverride: cw(),
    });
    assert.ok(r.context, r.detail);
    const c = r.context;
    assert.equal(c.league.slug, "bloodline-bowl");
    assert.equal(c.fantasy_team.canonical_team_id, "team:bloodline-bowl:1");
    assert.ok(c.all_rostered.every((p) => p.canonical_player_id.includes("bloodline-bowl")));
    assert.ok(![...c.projections.by_player.keys()].some((k) => k.includes("devoted")));
    assert.equal(c.league.raw_scoring.rec, 0.5);
    assert.equal(c.league.waiver_settings.type, "faab");
  });

  it("Devoted context is fully independent — different scoring, different players, different waiver model", async () => {
    const r = await buildWeeklyTeamContext("devoted-to-the-game", "DarthMarker", {
      week: 3,
      providerOverride: fakeProvider("devoted-to-the-game"),
      projectionProviderOverride: fakeProjections("devoted-to-the-game"),
      crosswalkOverride: cw(),
    });
    assert.ok(r.context, r.detail);
    const c = r.context;
    assert.equal(c.manager.manager_slug, "darthmarker");
    assert.equal(c.league.raw_scoring.rec, 1);
    assert.equal(c.league.waiver_settings.type, "reverse_standings");
    assert.ok(![...c.projections.by_player.keys()].some((k) => k.includes("bloodline")));
  });

  it("manager routing: a non-member is rejected, never swapped", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "darthmarker", {
      week: 3,
      providerOverride: fakeProvider("bloodline-bowl"),
      projectionProviderOverride: fakeProjections("bloodline-bowl"),
      crosswalkOverride: cw(),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "manager_not_in_league");
  });
});

describe("weekly context: honest degradation", () => {
  it("no projection source -> status PROJECTIONS_UNAVAILABLE, projections null (not 0)", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
      week: 3,
      providerOverride: fakeProvider("bloodline-bowl"),
      projectionProviderOverride: fakeProjections("bloodline-bowl", "PROJECTIONS_UNAVAILABLE"),
      crosswalkOverride: cw(),
    });
    assert.ok(r.context);
    assert.equal(r.context.status, "PROJECTIONS_UNAVAILABLE");
    for (const p of r.context.all_rostered) {
      const wp = r.context.projections.by_player.get(p.canonical_player_id);
      assert.ok(wp == null || wp.projected_points == null, "a missing projection must be null, never 0");
    }
    assert.ok(r.context.warnings.some((w) => w.code === "roster_projection_gap" || w.severity === "error"));
  });

  it("persistence independence: analytics still build when history persistence is down", async () => {
    setPersistence(null); // getPersistence() re-evaluates -> NOT_CONFIGURED
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
      week: 3,
      providerOverride: fakeProvider("bloodline-bowl"),
      projectionProviderOverride: fakeProjections("bloodline-bowl"),
      crosswalkOverride: cw(),
    });
    setPersistence(memoryPersistence());
    assert.ok(r.context, r.detail);
    // Context is usable; persistence status is reported, not fatal.
    assert.ok(["PERSISTENCE_NOT_CONFIGURED", "PERSISTENCE_ERROR", "READY"].includes(r.context.persistence_status));
    assert.ok(r.context.projections.by_player.size > 0);
  });
});

setPersistence(null);
