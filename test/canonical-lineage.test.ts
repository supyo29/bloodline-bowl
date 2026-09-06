/**
 * Phase 1B.1 — deterministic canonical lineage + consistency invariants.
 * No network: a synthetic in-memory provider feeds `buildCanonicalLeagueState`,
 * `buildWeeklyTeamContext` and `buildTradeAnalysisContext`.
 *
 * Proves:
 *  1. `league_snapshot_id` is content-derived, deterministic, and moves only on
 *     a MATERIAL state change (roster / lineup / scoring), never on request time.
 *  2. the canonical `scoring_fingerprint` is order- and zero-rule-insensitive.
 *  3. one canonical state ⇒ weekly + trade contexts agree on identity, roster
 *     mapping, ownership, starters/bench/IR, scoring fingerprint, week and
 *     `league_snapshot_id`.
 *  4. `runInLeagueStateScope` makes multiple manager analyses share ONE provider
 *     read and ONE `league_snapshot_id`.
 *  5. projection lineage names the model (`sleeper-weekly-rotowire` vs a season
 *     model) without inference from unrelated fields.
 *  6. trade validation uses canonical FLEX eligibility (no hard-coded RB/WR/TE).
 *  7. the identity crosswalk resolves canonical ⇄ sleeper ⇄ gsis.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCanonicalLeagueState } from "../lib/canonical/state";
import { runInLeagueStateScope } from "../lib/canonical/request-scope";
import { scoringFingerprint } from "../lib/canonical/scoring-fingerprint";
import { snapshotLineage } from "../lib/canonical/snapshot-lineage";
import { PlayerCrosswalk, type CrosswalkSource } from "../lib/canonical/players";
import { buildWeeklyTeamContext } from "../lib/weekly/context";
import { buildTradeAnalysisContext } from "../lib/trades/context";
import { slotEligiblePositions } from "../lib/weekly/slots";
import { setPersistence, memoryPersistence } from "../lib/persistence";
import { ok, type CanonicalLeagueStateBundle, type FantasyProvider } from "../lib/providers/types";
import type { ProjectionProvider } from "../lib/weekly/projections/types";
import type { ScheduleProvider } from "../lib/weekly/schedule/types";
import type { WeeklyProjectionBatch } from "../lib/weekly/schema";

setPersistence(memoryPersistence());

/* --------------------------------------------------------------- fixtures */

interface BuildOpts {
  slug?: string;
  raw_scoring?: Record<string, number>;
  starting_slots?: string[];
  slot_requirements?: Record<string, number>;
  /** swap team 1's first starter for its first bench player (a lineup-only change) */
  swapLineup?: boolean;
  /** add an extra player to team 1's bench (a roster change) */
  extraBenchPlayer?: boolean;
}

const DEFAULT_SCORING = { rec: 1, pass_td: 4, rush_td: 6, rec_td: 6, pass_yd: 0.04, rush_yd: 0.1, rec_yd: 0.1 };

function fakeProvider(opts: BuildOpts = {}): { provider: FantasyProvider; calls: () => number } {
  const slug = opts.slug ?? "bloodline-bowl";
  const startingSlots = opts.starting_slots ?? ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];
  const slotReq = opts.slot_requirements ?? { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 };
  let calls = 0;

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
  const player = (id: string, pos: string, gsis?: string) => ({
    canonical_player_id: gsis ? `player:gsis:${gsis}` : `player:sleeper:${slug}-${id}`,
    full_name: `${id} player`,
    first_name: null,
    last_name: null,
    position: pos as never,
    eligible_positions: [pos] as never,
    nfl_team: "KC",
    is_team_defense: pos === "DEF",
    status: null,
    injury_status: null,
    identifiers: gsis ? { sleeper_id: `${slug}-${id}`, gsis_id: gsis } : { sleeper_id: `${slug}-${id}` },
    resolution: { method: "stable_id" as const, confidence: gsis ? ("exact" as const) : ("high" as const), note: null },
  });

  const teamPlayers = (n: number) => {
    const base = [
      player(`t${n}-qb`, "QB"),
      player(`t${n}-rb1`, "RB", n === 1 ? "00-0011111" : undefined),
      player(`t${n}-rb2`, "RB"),
      player(`t${n}-wr1`, "WR"),
      player(`t${n}-wr2`, "WR"),
      player(`t${n}-te`, "TE"),
      player(`t${n}-flex`, "RB"),
      player(`t${n}-k`, "K"),
      player(`t${n}-def`, "DEF"),
      player(`t${n}-bench1`, "WR"),
    ];
    if (n === 1 && opts.extraBenchPlayer) base.push(player(`t1-bench2`, "RB"));
    return base;
  };

  const roster = (n: number) => {
    const ps = teamPlayers(n);
    const starterIds = ps.slice(0, 9).map((p) => p.canonical_player_id);
    const benchIds = ps.slice(9).map((p) => p.canonical_player_id);
    if (n === 1 && opts.swapLineup) {
      [starterIds[3], benchIds[0]] = [benchIds[0]!, starterIds[3]!];
    }
    return {
      canonical_roster_id: `roster:${slug}:${n}`,
      canonical_team_id: `team:${slug}:${n}`,
      slots: [
        ...startingSlots.map((slot, i) => ({ slot, slot_index: i, canonical_player_id: starterIds[i] ?? null, is_empty: starterIds[i] == null })),
        ...benchIds.map((id, i) => ({ slot: "BN", slot_index: startingSlots.length + i, canonical_player_id: id, is_empty: false })),
      ],
      starters: starterIds,
      bench: benchIds,
      ir: [],
      taxi: [],
      all_players: [...starterIds, ...benchIds],
      provenance: { provider: "sleeper" as const, provider_id: String(n), provider_synced_at: null },
    };
  };

  const team = (n: number, user: string) => ({
    canonical_team_id: `team:${slug}:${n}`,
    canonical_league_id: `league:${slug}`,
    provider_team_id: String(n),
    team_name: `team ${n}`,
    canonical_manager_ids: [`manager:${slug}:${user}`],
    record: { wins: n, losses: 0, ties: 0, points_for: 100, points_against: 90 },
    faab_remaining: 90,
    waiver_priority: n,
    provenance: { provider: "sleeper" as const, provider_id: String(n), provider_synced_at: null },
  });

  const managers = [mgr("u-a", "manager-a"), mgr("u-b", "manager-b")];
  const players = [1, 2].flatMap((n) => teamPlayers(n));

  const bundle: CanonicalLeagueStateBundle = {
    league: {
      canonical_league_id: `league:${slug}`,
      league_slug: slug,
      name: slug,
      season: 2026,
      status: "in_season",
      sport: "nfl",
      team_count: 12,
      current_week: 3,
      scoring_rules: [],
      raw_scoring: opts.raw_scoring ?? DEFAULT_SCORING,
      roster_settings: { starting_slots: startingSlots, bench_slots: 5, ir_slots: 1, taxi_slots: 0, slot_requirements: slotReq },
      playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: slug, provider_synced_at: null },
    },
    managers,
    teams: [team(1, "u-a"), team(2, "u-b")],
    rosters: [roster(1), roster(2)],
    standings: [
      { canonical_team_id: `team:${slug}:1`, rank: 1, wins: 2, losses: 1, ties: 0, win_percentage: 0.66, points_for: 300, points_against: 280, games_played: 3, playoff_seed: 1 },
      { canonical_team_id: `team:${slug}:2`, rank: 2, wins: 1, losses: 2, ties: 0, win_percentage: 0.33, points_for: 280, points_against: 300, games_played: 3, playoff_seed: 2 },
    ],
    draft_picks: [],
    players,
    unresolved_players: [],
  };

  const provider: FantasyProvider = {
    name: "sleeper",
    authentication: "NONE",
    capabilities: () => ({ league: true, settings: true, managers: true, standings: true, rosters: true, matchups: true, transactions: true, players: true, free_agents: true, waivers: true, draft_results: true, live_authenticated_access: true }),
    healthCheck: async () => ({ provider: "sleeper", status: "READY", authentication: "NONE", detail: "fake", checked_at: new Date().toISOString() }),
    getLeagueState: async () => { calls += 1; return ok(bundle); },
    getLeague: async () => ok(bundle.league),
    getManagers: async () => ok(bundle.managers),
    getStandings: async () => ok(bundle.standings),
    getRosters: async () => ok(bundle.rosters),
    getMatchups: async () => ok([
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
  };
  return { provider, calls: () => calls };
}

const fakeProjections: ProjectionProvider = {
  name: "fake-weekly",
  model_version: "sleeper-weekly-rotowire",
  async getWeeklyProjections(req): Promise<WeeklyProjectionBatch> {
    const by_player: WeeklyProjectionBatch["by_player"] = new Map();
    for (const cid of req.canonical_player_ids) {
      by_player.set(cid, {
        canonical_player_id: cid, week: req.week, season: 2026, position: "RB", nfl_team: "KC",
        opponent: "LV", is_home: null, projected_points: 10, floor_points: 6, ceiling_points: 14, std_dev: 4,
        projection_status: "projected", expected_availability: 1, is_bye: false, injury_status: null,
        rest_of_season_points: 100, ros: null, source: "fake-weekly", model_version: "sleeper-weekly-rotowire",
        uncertainty_source: "position_volatility_heuristic", warnings: [],
      });
    }
    return {
      league_slug: req.league.league_slug, season: 2026, week: req.week, status: "READY",
      by_player, resolved_players: new Map(), source: "fake-weekly", model_version: "sleeper-weekly-rotowire",
      missing: [], teams_with_games: ["KC", "LV"], warnings: [],
    };
  },
};

const fakeSchedule: ScheduleProvider = {
  name: "fake-schedule",
  async getWeekSchedule(season, week) {
    return { season, week, status: "UNAVAILABLE", source: "fake-schedule", teams_with_games: new Set(), teams_on_bye: new Set(), opponent_by_team: {}, warnings: [] };
  },
};

const weeklyOpts = (provider: FantasyProvider) => ({
  providerOverride: provider,
  projectionProviderOverride: fakeProjections,
  scheduleProviderOverride: fakeSchedule,
  riSeasonProviderOverride: null as null,
  skipRiSeasonSignal: true,
});

async function idFor(opts: BuildOpts): Promise<string> {
  const { provider } = fakeProvider(opts);
  const res = await buildCanonicalLeagueState(opts.slug ?? "bloodline-bowl", { providerOverride: provider, reportPersistence: false });
  assert.ok(res.snapshot);
  return snapshotLineage(res.snapshot!).league_snapshot_id;
}

/* ----------------------------------------------------------------- 1. id */

describe("league_snapshot_id — content-derived + deterministic", () => {
  it("identical canonical content ⇒ identical id (request time excluded)", async () => {
    const a = await idFor({});
    await new Promise((r) => setTimeout(r, 5));
    const b = await idFor({});
    assert.equal(a, b);
    assert.match(a, /^snap:bloodline-bowl:2026:w3:[0-9a-f]{16}$/);
  });

  it("a roster change ⇒ a different id", async () => {
    assert.notEqual(await idFor({}), await idFor({ extraBenchPlayer: true }));
  });

  it("a lineup-only change (starter ⇄ bench) ⇒ a different id", async () => {
    assert.notEqual(await idFor({}), await idFor({ swapLineup: true }));
  });

  it("a scoring change ⇒ a different scoring_fingerprint AND a different id", async () => {
    const { provider: p1 } = fakeProvider({});
    const { provider: p2 } = fakeProvider({ raw_scoring: { ...DEFAULT_SCORING, rec: 0.5 } });
    const s1 = (await buildCanonicalLeagueState("bloodline-bowl", { providerOverride: p1, reportPersistence: false })).snapshot!;
    const s2 = (await buildCanonicalLeagueState("bloodline-bowl", { providerOverride: p2, reportPersistence: false })).snapshot!;
    assert.notEqual(s1.league.scoring_fingerprint, s2.league.scoring_fingerprint);
    assert.notEqual(snapshotLineage(s1).league_snapshot_id, snapshotLineage(s2).league_snapshot_id);
  });

  it("lineage is present, well-formed, and echoes the league fingerprints", async () => {
    const snap = (await buildCanonicalLeagueState("bloodline-bowl", { providerOverride: fakeProvider({}).provider, reportPersistence: false })).snapshot!;
    const lin = snapshotLineage(snap);
    assert.equal(lin.snapshot_schema_version, snap.schema_version);
    assert.equal(lin.scoring_fingerprint, snap.league.scoring_fingerprint);
    assert.equal(lin.roster_fingerprint, snap.league.roster_fingerprint);
    assert.equal(lin.week, 3);
    assert.equal(lin.season, 2026);
    assert.ok(lin.player_data_version.startsWith("players:"));
    assert.equal(lin.content_hash.length, 64);
  });
});

/* --------------------------------------------------- 2. scoring fingerprint */

describe("scoring_fingerprint — semantic, not serialization", () => {
  it("key order does not matter", () => {
    const a = scoringFingerprint({ rec: 1, pass_td: 4, rush_yd: 0.1 });
    const b = scoringFingerprint({ rush_yd: 0.1, rec: 1, pass_td: 4 });
    assert.equal(a, b);
  });
  it("a zero-valued rule is equivalent to an absent rule", () => {
    assert.equal(scoringFingerprint({ rec: 1, fum_lost: 0 }), scoringFingerprint({ rec: 1 }));
  });
  it("1 and 1.0 and -0/0 collapse", () => {
    assert.equal(scoringFingerprint({ rec: 1 }), scoringFingerprint({ rec: 1.0 }));
    assert.equal(scoringFingerprint({ rec: 1, x: -0 }), scoringFingerprint({ rec: 1 }));
  });
  it("a real value change moves the fingerprint", () => {
    assert.notEqual(scoringFingerprint({ rec: 1 }), scoringFingerprint({ rec: 0.5 }));
  });
});

/* --------------------------------------------- 3. cross-engine consistency */

describe("one canonical state ⇒ weekly + trade agree", () => {
  it("agree on identity, roster mapping, ownership, starters/bench/IR, scoring, week, snapshot id", async () => {
    const { provider } = fakeProvider({});
    const weekly = await buildWeeklyTeamContext("bloodline-bowl", "manager-a", weeklyOpts(provider));
    const trade = await buildTradeAnalysisContext("bloodline-bowl", { ...weeklyOpts(provider), wantRestOfSeason: false });
    assert.ok(weekly.context && trade.context);
    const w = weekly.context!;
    const t = trade.context!;

    assert.equal(w.league.slug, t.league_slug);
    assert.equal(w.league.week, t.week);
    assert.equal(
      w.lineage.snapshot.league_snapshot_id,
      t.lineage.snapshot.league_snapshot_id,
    );
    assert.equal(w.lineage.snapshot.scoring_fingerprint, t.snapshot.league.scoring_fingerprint);

    // roster mapping + ownership: team 1's roster is manager-a's in both views
    const wRoster = w.roster;
    const tRoster = t.rosters_by_manager.get("manager:bloodline-bowl:u-a")!;
    assert.deepEqual([...wRoster.starters].sort(), [...tRoster.starters].sort());
    assert.deepEqual([...wRoster.bench].sort(), [...tRoster.bench].sort());
    assert.deepEqual([...wRoster.ir].sort(), [...tRoster.ir].sort());
    assert.deepEqual([...wRoster.all_players].sort(), [...tRoster.all_players].sort());

    // roster eligibility (FLEX) identical
    assert.deepEqual(w.league.roster_constraints.flex_positions, t.constraints.flex_positions);
  });
});

/* ---------------------------------------------------- 4. shared execution */

describe("runInLeagueStateScope — one read, one id across managers", () => {
  it("two manager analyses in one scope share ONE provider read and ONE league_snapshot_id", async () => {
    const { provider, calls } = fakeProvider({});
    const opts = weeklyOpts(provider);
    const [a, b] = await runInLeagueStateScope(async () => {
      const ca = await buildWeeklyTeamContext("bloodline-bowl", "manager-a", opts);
      const cb = await buildWeeklyTeamContext("bloodline-bowl", "manager-b", opts);
      return [ca, cb];
    });
    assert.ok(a.context && b.context);
    assert.equal(calls(), 1, "provider.getLeagueState read exactly once for the whole scope");
    assert.equal(
      a.context!.lineage.snapshot.league_snapshot_id,
      b.context!.lineage.snapshot.league_snapshot_id,
    );
  });

  it("a later, independent operation reads fresh (no cross-scope retention)", async () => {
    const { provider, calls } = fakeProvider({});
    const opts = weeklyOpts(provider);
    await runInLeagueStateScope(() => buildWeeklyTeamContext("bloodline-bowl", "manager-a", opts));
    await runInLeagueStateScope(() => buildWeeklyTeamContext("bloodline-bowl", "manager-a", opts));
    assert.equal(calls(), 2, "each independent scope performs its own read");
  });

  it("no scope ⇒ every call reads fresh (unchanged default behaviour)", async () => {
    const { provider, calls } = fakeProvider({});
    const opts = weeklyOpts(provider);
    await buildWeeklyTeamContext("bloodline-bowl", "manager-a", opts);
    await buildWeeklyTeamContext("bloodline-bowl", "manager-b", opts);
    assert.equal(calls(), 2);
  });
});

/* ----------------------------------------------------- 5. projection lineage */

describe("projection lineage names the model", () => {
  it("weekly context carries a `weekly_absolute` entry for sleeper-weekly-rotowire", async () => {
    const { provider } = fakeProvider({});
    const weekly = await buildWeeklyTeamContext("bloodline-bowl", "manager-a", weeklyOpts(provider));
    const entries = weekly.context!.lineage.projections;
    const weeklyEntry = entries.find((e) => e.role === "weekly_absolute");
    assert.ok(weeklyEntry, "has a weekly_absolute lineage entry");
    assert.equal(weeklyEntry!.model_version, "sleeper-weekly-rotowire");
    assert.notEqual(weeklyEntry!.model_version, "ri-structural-2026.3");
    assert.equal(weeklyEntry!.scoring_fingerprint, weekly.context!.lineage.snapshot.scoring_fingerprint);
  });
});

/* -------------------------------------------------------------- 6. FLEX */

describe("trade validation uses canonical FLEX eligibility", () => {
  it("a plain FLEX league resolves RB/WR/TE (not hard-coded, but matches)", async () => {
    const { provider } = fakeProvider({});
    const trade = await buildTradeAnalysisContext("bloodline-bowl", { ...weeklyOpts(provider), wantRestOfSeason: false });
    assert.deepEqual(
      [...trade.context!.constraints.flex_positions].sort(),
      ["RB", "TE", "WR"],
    );
  });

  it("a SUPER_FLEX league resolves QB into flex_positions (the hard-coded list never would)", async () => {
    const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "SUPER_FLEX", "K", "DEF"];
    const { provider } = fakeProvider({ starting_slots: slots, slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, SUPER_FLEX: 1, K: 1, DEF: 1 } });
    const trade = await buildTradeAnalysisContext("bloodline-bowl", { ...weeklyOpts(provider), wantRestOfSeason: false });
    assert.ok(trade.context!.constraints.flex_positions.includes("QB"));
    assert.deepEqual(
      [...trade.context!.constraints.flex_positions].sort(),
      [...slotEligiblePositions("SUPER_FLEX")].sort(),
    );
  });
});

/* --------------------------------------------------------- 7. GSIS alias */

describe("identity crosswalk — canonical ⇄ sleeper ⇄ gsis", () => {
  const source: CrosswalkSource = {
    name: "test",
    load: async () => [
      { gsis_id: "00-0033280", sleeper_id: "4046", yahoo_id: "30123", full_name: "Christian McCaffrey", position: "RB", nfl_team: "SF" },
    ],
  };

  it("resolves a bare GSIS id to the same canonical player as the Sleeper id", async () => {
    const cw = await PlayerCrosswalk.create(source);
    const bySleeper = cw.resolve({ provider: "sleeper", provider_player_id: "4046", full_name: "Christian McCaffrey", position: "RB", nfl_team: "SF" });
    const byGsis = cw.resolve({ provider: "sleeper", provider_player_id: "x", full_name: "Christian McCaffrey", position: "RB", nfl_team: "SF", known_identifiers: { gsis_id: "00-0033280" } });
    assert.equal(bySleeper.player.canonical_player_id, "player:gsis:00-0033280");
    assert.equal(byGsis.player.canonical_player_id, "player:gsis:00-0033280");
    assert.equal(byGsis.player.identifiers.sleeper_id, "4046");
  });

  it("exposes crosswalk_version once loaded", async () => {
    const cw = await PlayerCrosswalk.create(source);
    assert.equal(cw.version, "test:1");
  });
});
