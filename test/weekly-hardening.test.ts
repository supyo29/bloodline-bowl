/**
 * PR #3 pre-merge hardening — deterministic regressions for the six corrections.
 *
 *  1. Bye detection is schedule-proven, never feed-absence. An active NFL team's
 *     players that are simply missing from the projection feed stay UNKNOWN
 *     (null / "unavailable"), they never become bye-zero.
 *  4. Roster Intel season model is consumed as an ORDINAL + disagreement signal;
 *     it is never numerically ensembled, never mutated, and weekly analytics run
 *     unchanged when it is unavailable.
 *  6. A legitimate scored 0 (or negative) weekly projection is DATA, not
 *     "unavailable" — presence is decided by published stats, not the sign of
 *     the scored points.
 *
 * (Items 2, 3 and 5 are covered in test/weekly-waivers.test.ts and
 *  test/weekly-frontier-sensitivity.test.ts.)
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { buildWeeklyTeamContext } from "../lib/weekly/context";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import { setPersistence, memoryPersistence } from "../lib/persistence";
import { assembleRosSignals } from "../lib/weekly/ros";
import { SleeperWeeklyProjectionProvider } from "../lib/weekly/projections/sleeper-weekly";
import type { RiSeasonSignalResult } from "../lib/weekly/projections-ri";
import type {
  CanonicalLeagueStateBundle,
  FantasyProvider,
} from "../lib/providers/types";
import { ok } from "../lib/providers/types";
import type { ProjectionProvider } from "../lib/weekly/projections/types";
import type { CanonicalPlayer } from "../lib/canonical/schema";
import type { WeeklyProjection, WeeklyProjectionBatch } from "../lib/weekly/schema";

setPersistence(memoryPersistence());
const cw = () => new PlayerCrosswalk(NoCrosswalk);

/* ------------------------------------------------------------------ *
 * Item 1 — incomplete projection feed must not become bye-zero
 * ------------------------------------------------------------------ */

/** roster: 5 players on KC (projected), 4 on BUF (deliberately absent). */
const KC_IDS = ["p-kc-qb", "p-kc-rb1", "p-kc-wr1", "p-kc-te", "p-kc-k"];
const BUF_IDS = ["p-buf-rb2", "p-buf-wr2", "p-buf-rb3", "p-buf-def"];
const ALL_IDS = [...KC_IDS, ...BUF_IDS];
const POS_BY_ID: Record<string, CanonicalPlayer["position"]> = {
  "p-kc-qb": "QB", "p-kc-rb1": "RB", "p-kc-wr1": "WR", "p-kc-te": "TE", "p-kc-k": "K",
  "p-buf-rb2": "RB", "p-buf-wr2": "WR", "p-buf-rb3": "RB", "p-buf-def": "DEF",
};

function fakeBloodlineProvider(): FantasyProvider {
  const mkPlayer = (id: string): CanonicalPlayer => ({
    canonical_player_id: id,
    full_name: id,
    first_name: null,
    last_name: null,
    position: POS_BY_ID[id]!,
    eligible_positions: [POS_BY_ID[id]!],
    nfl_team: id.startsWith("p-kc") ? "KC" : "BUF",
    is_team_defense: POS_BY_ID[id] === "DEF",
    status: null,
    injury_status: null,
    identifiers: { sleeper_id: id },
    resolution: { method: "stable_id", confidence: "high", note: null },
  });
  const players = ALL_IDS.map(mkPlayer);
  const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];
  const starterIds = ["p-kc-qb", "p-kc-rb1", "p-buf-rb2", "p-kc-wr1", "p-buf-wr2", "p-kc-te", "p-buf-rb3", "p-kc-k", "p-buf-def"];
  const roster1 = {
    canonical_roster_id: "roster:bloodline-bowl:1",
    canonical_team_id: "team:bloodline-bowl:1",
    slots: slots.map((slot, i) => ({ slot, slot_index: i, canonical_player_id: starterIds[i]!, is_empty: false })),
    starters: starterIds,
    bench: [],
    ir: [],
    taxi: [],
    all_players: starterIds,
    provenance: { provider: "sleeper" as const, provider_id: "1", provider_synced_at: null },
  };
  const roster2 = { ...roster1, canonical_roster_id: "roster:bloodline-bowl:2", canonical_team_id: "team:bloodline-bowl:2", slots: [], starters: [], all_players: [], provenance: { provider: "sleeper" as const, provider_id: "2", provider_synced_at: null } };
  const mgr = (user: string, mslug: string) => ({
    canonical_manager_id: `manager:bloodline-bowl:${user}`,
    manager_slug: mslug,
    provider_username: mslug,
    display_name: mslug,
    provider_user_id: user,
    is_commissioner: false,
    is_co_manager: false,
    provenance: { provider: "sleeper" as const, provider_id: user, provider_synced_at: null },
  });
  const team = (n: number, user: string) => ({
    canonical_team_id: `team:bloodline-bowl:${n}`,
    canonical_league_id: "league:bloodline-bowl",
    provider_team_id: String(n),
    team_name: `team ${n}`,
    canonical_manager_ids: [`manager:bloodline-bowl:${user}`],
    record: { wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0 },
    faab_remaining: 90,
    waiver_priority: n,
    provenance: { provider: "sleeper" as const, provider_id: String(n), provider_synced_at: null },
  });
  const bundle: CanonicalLeagueStateBundle = {
    league: {
      canonical_league_id: "league:bloodline-bowl",
      league_slug: "bloodline-bowl",
      name: "bloodline-bowl",
      season: 2026,
      status: "in_season",
      sport: "nfl",
      team_count: 2,
      current_week: 1,
      scoring_rules: [{ key: "rec", points: 0.5, category: "receiving" }],
      raw_scoring: { rec: 0.5, pass_td: 4, rec_td: 6, rush_td: 6, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04 },
      roster_settings: {
        starting_slots: slots,
        bench_slots: 5,
        ir_slots: 1,
        taxi_slots: 0,
        slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 },
      },
      playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: "bloodline-bowl", provider_synced_at: null },
    },
    managers: [mgr("u-supyo", "supyo29"), mgr("u-biji", "BijiMac")],
    teams: [team(1, "u-supyo"), team(2, "u-biji")],
    rosters: [roster1, roster2],
    standings: [],
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
    getMatchups: async () => ok([]),
    getTransactions: async () => ok([]),
    getDraftResults: async () => ok([]),
    getWaiverState: async () => ok({ canonical_league_id: "league:bloodline-bowl", league_slug: "bloodline-bowl", players: [], provenance: { provider: "sleeper", provider_id: "bloodline-bowl", provider_synced_at: null } }),
  } satisfies FantasyProvider;
}

/** projects ONLY the KC players; BUF players are simply absent from the feed. */
function partialFeedProvider(): ProjectionProvider {
  return {
    name: "partial-feed",
    model_version: "test",
    async getWeeklyProjections(req): Promise<WeeklyProjectionBatch> {
      const by_player = new Map<string, WeeklyProjection>();
      const resolved_players = new Map<string, CanonicalPlayer>();
      for (const cid of req.canonical_player_ids) {
        if (!cid.startsWith("p-kc")) continue;
        by_player.set(cid, {
          canonical_player_id: cid,
          week: req.week,
          season: 2026,
          position: POS_BY_ID[cid] ?? "RB",
          nfl_team: "KC",
          opponent: "LV",
          is_home: null,
          projected_points: 11,
          floor_points: 7,
          ceiling_points: 15,
          std_dev: 4,
          projection_status: "projected",
          expected_availability: 1,
          is_bye: false,
          injury_status: null,
          rest_of_season_points: 130,
          ros: null,
          source: "partial-feed",
          model_version: "test",
          uncertainty_source: "position_volatility_heuristic",
          warnings: [],
        });
      }
      return {
        league_slug: req.league.league_slug,
        season: 2026,
        week: req.week,
        status: "PROJECTIONS_PARTIAL",
        by_player,
        resolved_players,
        source: "partial-feed",
        model_version: "test",
        missing: req.canonical_player_ids.filter((c) => !by_player.has(c)),
        teams_with_games: ["KC", "LV"],
        warnings: [],
      };
    },
  };
}

const scheduleWeek1NoByes = {
  name: "fake-schedule",
  async getWeekSchedule(season: number, week: number) {
    return {
      season, week, status: "READY" as const, source: "fake-schedule",
      teams_with_games: new Set(["KC", "LV", "BUF", "MIA", "SF", "DAL", "PHI", "NYG", "GB", "DET", "BAL", "CIN"]),
      teams_on_bye: new Set<string>(),
      opponent_by_team: {},
      warnings: [],
    };
  },
};
const scheduleBufOnBye = {
  name: "fake-schedule",
  async getWeekSchedule(season: number, week: number) {
    return {
      season, week, status: "READY" as const, source: "fake-schedule",
      teams_with_games: new Set(["KC", "LV", "MIA", "SF", "DAL", "PHI", "NYG", "GB", "DET", "BAL", "CIN", "TEN"]),
      teams_on_bye: new Set<string>(["BUF"]),
      opponent_by_team: {},
      warnings: [],
    };
  },
};
const scheduleUnavailable = {
  name: "fake-schedule",
  async getWeekSchedule(season: number, week: number) {
    return {
      season, week, status: "UNAVAILABLE" as const, source: "fake-schedule",
      teams_with_games: new Set<string>(),
      teams_on_bye: new Set<string>(),
      opponent_by_team: {},
      warnings: [{ code: "SCHEDULE_UNAVAILABLE", message: "no schedule", severity: "warning" as const }],
    };
  },
};

describe("item 1 — incomplete projection feed is UNKNOWN, never bye-zero", () => {
  it("BUF players absent from the feed + schedule says BUF plays -> unavailable, not 0, not bye", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
      week: 1,
      providerOverride: fakeBloodlineProvider(),
      projectionProviderOverride: partialFeedProvider(),
      scheduleProviderOverride: scheduleWeek1NoByes,
      riSeasonProviderOverride: null,
      crosswalkOverride: cw(),
    });
    assert.ok(r.context, r.detail);
    const c = r.context;
    for (const id of BUF_IDS) {
      const wp = c.projections.by_player.get(id);
      assert.ok(wp == null || wp.projected_points == null, `${id} must stay null, got ${wp?.projected_points}`);
      assert.notEqual(wp?.projection_status, "bye", `${id} must NOT be marked bye`);
      if (wp) assert.equal(wp.projection_status, "unavailable");
    }
    for (const id of KC_IDS) {
      assert.equal(c.projections.by_player.get(id)?.projected_points, 11);
    }
    assert.equal(c.byes.bye_status, "VERIFIED");
    assert.deepEqual(c.byes.starters_on_bye_this_week, []);
  });

  it("same feed, but schedule PROVES BUF is on bye -> BUF players become a real 0 / 'bye'", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
      week: 1,
      providerOverride: fakeBloodlineProvider(),
      projectionProviderOverride: partialFeedProvider(),
      scheduleProviderOverride: scheduleBufOnBye,
      riSeasonProviderOverride: null,
      crosswalkOverride: cw(),
    });
    assert.ok(r.context, r.detail);
    const c = r.context;
    for (const id of BUF_IDS) {
      const wp = c.projections.by_player.get(id);
      assert.ok(wp, `${id} should have a bye projection row`);
      assert.equal(wp!.projected_points, 0);
      assert.equal(wp!.projection_status, "bye");
      assert.equal(wp!.is_bye, true);
    }
    assert.equal(c.byes.teams_on_bye.includes("BUF"), true);
    assert.ok(c.byes.starters_on_bye_this_week.length >= 3);
  });

  it("no authoritative schedule -> byes UNVERIFIED, absent players still 'unavailable' not 0", async () => {
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
      week: 1,
      providerOverride: fakeBloodlineProvider(),
      projectionProviderOverride: partialFeedProvider(),
      scheduleProviderOverride: scheduleUnavailable,
      riSeasonProviderOverride: null,
      crosswalkOverride: cw(),
    });
    assert.ok(r.context, r.detail);
    const c = r.context;
    assert.equal(c.byes.bye_status, "UNVERIFIED");
    assert.ok(c.warnings.some((w) => w.code === "BYE_STATUS_UNVERIFIED"));
    for (const id of BUF_IDS) {
      const wp = c.projections.by_player.get(id);
      assert.ok(wp == null || wp.projected_points == null);
      assert.notEqual(wp?.projection_status, "bye");
    }
  });
});

/* ------------------------------------------------------------------ *
 * Item 4 — Roster Intel season signal: ordinal + disagreement only
 * ------------------------------------------------------------------ */

function batchOf(players: Array<{ id: string; sleeper_id: string; pos: string; ros: number }>): WeeklyProjectionBatch {
  const by_player = new Map<string, WeeklyProjection>();
  const resolved_players = new Map<string, CanonicalPlayer>();
  for (const p of players) {
    by_player.set(p.id, {
      canonical_player_id: p.id, week: 1, season: 2026, position: p.pos, nfl_team: "KC", opponent: "LV",
      is_home: null, projected_points: 12, floor_points: 8, ceiling_points: 16, std_dev: 4,
      projection_status: "projected", expected_availability: 1, is_bye: false, injury_status: null,
      rest_of_season_points: p.ros, ros: null, source: "test", model_version: "test",
      uncertainty_source: "position_volatility_heuristic", warnings: [],
    });
    resolved_players.set(p.id, {
      canonical_player_id: p.id, full_name: p.id, first_name: null, last_name: null,
      position: p.pos as CanonicalPlayer["position"], eligible_positions: [p.pos as CanonicalPlayer["position"]],
      nfl_team: "KC", is_team_defense: false, status: null, injury_status: null,
      identifiers: { sleeper_id: p.sleeper_id }, resolution: { method: "stable_id", confidence: "high", note: null },
    });
  }
  return {
    league_slug: "test", season: 2026, week: 1, status: "READY", by_player, resolved_players,
    source: "test", model_version: "test", missing: [], teams_with_games: ["KC", "LV"], warnings: [],
  };
}

describe("item 4 — RI season model as ordinal + disagreement signal", () => {
  it("surfaces RI-vs-external disagreement when both exist; agreement raises confidence", () => {
    const batch = batchOf([
      { id: "A", sleeper_id: "sa", pos: "RB", ros: 180 },
      { id: "B", sleeper_id: "sb", pos: "WR", ros: 100 },
    ]);
    const ri: RiSeasonSignalResult = {
      status: "READY",
      model_version: "ri-structural-2026.3",
      by_sleeper_id: new Map([
        ["sa", { sleeper_player_id: "sa", ri_season_points: 300, ri_vor: 60, ri_vor_rank: 5, ri_position_rank: 3, ri_tier: 1, ri_confidence: "HIGH", external_season_points: 150, disagreement_pct: 1.0, primary_driver: "usage" }],
        ["sb", { sleeper_player_id: "sb", ri_season_points: 105, ri_vor: 10, ri_vor_rank: 40, ri_position_rank: 24, ri_tier: 4, ri_confidence: "MEDIUM", external_season_points: 100, disagreement_pct: 0.05, primary_driver: null }],
      ]),
      warning: null,
    };
    const res = assembleRosSignals(batch, ri, 1);
    assert.equal(res.ri_status, "READY");
    assert.equal(res.players_with_ri, 2);
    assert.equal(res.players_with_disagreement, 1);

    const a = batch.by_player.get("A")!.ros!;
    assert.equal(a.disagreement_direction, "RI_ABOVE");
    assert.equal(a.confidence, "LOW"); // |100%| > material 30%
    assert.equal(a.ri_position_rank, 3);

    const b = batch.by_player.get("B")!.ros!;
    assert.equal(b.disagreement_direction, "AGREE");
    assert.equal(b.confidence, "HIGH");
  });

  it("NO numerical ensemble + NO mutation of the RI model", () => {
    const batch = batchOf([{ id: "A", sleeper_id: "sa", pos: "RB", ros: 999 }]);
    const riEntry = { sleeper_player_id: "sa", ri_season_points: 300, ri_vor: 60, ri_vor_rank: 5, ri_position_rank: 3, ri_tier: 1, ri_confidence: "HIGH" as const, external_season_points: 170, disagreement_pct: 0.76, primary_driver: "usage" };
    const ri: RiSeasonSignalResult = { status: "READY", model_version: "v", by_sleeper_id: new Map([["sa", riEntry]]), warning: null };
    assembleRosSignals(batch, ri, 1);
    // external absolute only — prorated 170, NEVER 170 + 300.
    const a = batch.by_player.get("A")!.ros!;
    assert.equal(a.external_season_points, 170);
    assert.ok(a.points != null && a.points <= 170, `ros.points must be external-only, got ${a.points}`);
    assert.equal(a.ri_season_points, 300); // exposed for inspection
    // RI entry object is untouched.
    assert.equal(riEntry.ri_season_points, 300);
    assert.equal(riEntry.external_season_points, 170);
  });

  it("weekly analytics run unchanged when RI is UNAVAILABLE (ros still assembled from external)", () => {
    const batch = batchOf([{ id: "A", sleeper_id: "sa", pos: "RB", ros: 120 }]);
    const ri: RiSeasonSignalResult = { status: "UNAVAILABLE", model_version: null, by_sleeper_id: new Map(), warning: null };
    const res = assembleRosSignals(batch, ri, 1);
    assert.equal(res.ri_status, "UNAVAILABLE");
    assert.equal(res.players_with_ri, 0);
    const a = batch.by_player.get("A")!.ros!;
    assert.ok(a != null, "ros signal still present");
    assert.equal(a.ri_season_points, null);
    assert.ok(a.points != null, "external prorated ROS still available");
  });
});

/* ------------------------------------------------------------------ *
 * Item 6 — legitimate scored 0 / negative projection is DATA
 * ------------------------------------------------------------------ */

describe("item 6 — a scored 0 / negative weekly projection is present, not 'unavailable'", () => {
  it("real published stats scoring 0 or negative stay 'projected'; adp-only rows are 'unavailable'", async (t) => {
    const raw = [
      // scores exactly 0 (rushing yards 0), but the feed DID publish a stat line
      { player_id: "z1", team: "KC", opponent: "LV", week: 1, stats: { rush_att: 3, rush_yd: 0, rec: 0 }, player: { first_name: "Zero", last_name: "Back", position: "RB", injury_status: null, team: "KC" } },
      // scores negative (lost fumbles), still a real projection
      { player_id: "z2", team: "KC", opponent: "LV", week: 1, stats: { rec: 0, fum_lost: 2 }, player: { first_name: "Neg", last_name: "Hands", position: "WR", injury_status: null, team: "KC" } },
      // ONLY non-scoring keys -> genuinely no projection
      { player_id: "z3", team: "KC", opponent: "LV", week: 1, stats: { adp_ppr: 42, pos_adp_rb: 12, rank_ppr: 88 }, player: { first_name: "Adp", last_name: "Only", position: "RB", injury_status: null, team: "KC" } },
    ];
    t.mock.method(globalThis, "fetch", async () =>
      ({ ok: true, status: 200, json: async () => raw }) as unknown as Response,
    );

    const provider = new SleeperWeeklyProjectionProvider();
    const crosswalk = cw();
    const batch = await provider.getWeeklyProjections({
      league: { league_slug: "bloodline-bowl", season: 2026, raw_scoring: { rec: 0.5, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, pass_td: 4, rush_td: 6, rec_td: 6, fum_lost: -2 }, scoring_rules: [] },
      week: 1,
      crosswalk,
      canonical_player_ids: [],
      want_rest_of_season: false,
    });

    const byName = (n: string) => [...batch.by_player.values()].find((p) => batch.resolved_players.get(p.canonical_player_id)?.full_name === n)!;

    const zero = byName("Zero Back");
    assert.equal(zero.projected_points, 0, "a scored 0 is DATA");
    assert.equal(zero.projection_status, "projected");

    const neg = byName("Neg Hands");
    assert.equal(neg.projected_points, -4, "a scored negative is DATA");
    assert.equal(neg.projection_status, "projected");

    const adp = byName("Adp Only");
    assert.equal(adp.projected_points, null, "adp-only row has no projection");
    assert.equal(adp.projection_status, "unavailable");

    mock.restoreAll();
  });
});

setPersistence(null);
