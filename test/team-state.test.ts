/**
 * Phase 2 — Team-State deterministic tests. No network.
 *
 * Every value Team-State produces is a projection-FREE structural fact; these
 * tests pin the counts, the structural flags, the depth-pressure levels, the
 * change events, one-read performance, and lineage propagation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setPersistence, memoryPersistence } from "../lib/persistence";
import { ok, type CanonicalLeagueStateBundle, type FantasyProvider } from "../lib/providers/types";
import type { CanonicalLeagueSnapshot, CanonicalPlayer } from "../lib/canonical/schema";
import { attachLeagueFingerprints } from "../lib/canonical/league-fingerprints";
import { deriveSnapshotLineage } from "../lib/canonical/snapshot-lineage";
import { CANONICAL_SCHEMA_VERSION } from "../lib/canonical/schema";
import { runInLeagueStateScope } from "../lib/canonical/request-scope";
import {
  buildLeagueManagementContext,
  buildTeamManagementState,
  diffCanonicalSnapshots,
  type ScheduleBundle,
} from "../lib/team-state";
import type { ScheduleProvider } from "../lib/weekly/schedule/registry";

setPersistence(memoryPersistence());

/* --------------------------------------------------------------- fixtures */

const SLUG = "bloodline-bowl";
const NO_SCHEDULE: ScheduleBundle = {
  status: "UNVERIFIED",
  source: null,
  byeTeamsByWeek: new Map(),
  opponentByTeam: {},
  currentWeek: 2,
};

let pid = 0;
function player(pos: string, opts: { team?: string; elig?: string[]; name?: string; injury?: string | null; gsis?: string } = {}): CanonicalPlayer {
  pid += 1;
  const id = opts.gsis ? `player:gsis:${opts.gsis}` : `player:sleeper:p${pid}`;
  return {
    canonical_player_id: id,
    full_name: opts.name ?? `${pos}${pid}`,
    first_name: null,
    last_name: null,
    position: pos as never,
    eligible_positions: (opts.elig ?? [pos]) as never,
    nfl_team: opts.team ?? "KC",
    is_team_defense: pos === "DEF",
    status: null,
    injury_status: opts.injury ?? null,
    identifiers: opts.gsis ? { sleeper_id: `p${pid}`, gsis_id: opts.gsis } : { sleeper_id: `p${pid}` },
    resolution: { method: "stable_id", confidence: "high", note: null },
  };
}

interface TeamSpec {
  roster_id: number;
  user?: string | null; // provider_owner_id; null/undefined = vacant
  display?: string | null;
  team_name?: string | null;
  in_users?: boolean; // whether the owner is in the users list (departed = false)
  starters: (CanonicalPlayer | null)[]; // null = empty slot
  bench?: CanonicalPlayer[];
  ir?: CanonicalPlayer[];
}

function bundle(opts: {
  startingSlots: string[];
  benchSlots?: number;
  irSlots?: number;
  rawScoring?: Record<string, number>;
  status?: string;
  week?: number;
  teams: TeamSpec[];
}): CanonicalLeagueStateBundle {
  const bench = opts.benchSlots ?? 5;
  const ir = opts.irSlots ?? 1;
  const startingSlots = opts.startingSlots;
  const slotReq: Record<string, number> = {};
  for (const s of startingSlots) slotReq[s] = (slotReq[s] ?? 0) + 1;

  const managers = opts.teams
    .filter((t) => t.user && (t.in_users ?? true))
    .map((t) => ({
      canonical_manager_id: `manager:${SLUG}:${t.user}`,
      manager_slug: (t.display ?? t.user!).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      provider_username: t.display ?? t.user!,
      display_name: t.display ?? t.user!,
      provider_user_id: t.user!,
      is_commissioner: false,
      is_co_manager: false,
      provenance: { provider: "sleeper" as const, provider_id: t.user!, provider_synced_at: null },
    }));

  const teams = opts.teams.map((t) => ({
    canonical_team_id: `team:${SLUG}:${t.roster_id}`,
    canonical_league_id: `league:${SLUG}`,
    provider_team_id: String(t.roster_id),
    team_name: t.team_name ?? null,
    canonical_manager_ids: t.user && (t.in_users ?? true) ? [`manager:${SLUG}:${t.user}`] : [],
    provider_owner_id: t.user ?? null,
    record: { wins: t.roster_id, losses: 0, ties: 0, points_for: 100 + t.roster_id, points_against: 90 },
    faab_remaining: 100,
    waiver_priority: t.roster_id,
    provenance: { provider: "sleeper" as const, provider_id: String(t.roster_id), provider_synced_at: null },
  }));

  const rosters = opts.teams.map((t) => {
    const starterIds = t.starters.map((p) => p?.canonical_player_id ?? null);
    const benchIds = (t.bench ?? []).map((p) => p.canonical_player_id);
    const irIds = (t.ir ?? []).map((p) => p.canonical_player_id);
    return {
      canonical_roster_id: `roster:${SLUG}:${t.roster_id}`,
      canonical_team_id: `team:${SLUG}:${t.roster_id}`,
      slots: [
        ...startingSlots.map((slot, i) => ({ slot, slot_index: i, canonical_player_id: starterIds[i] ?? null, is_empty: starterIds[i] == null })),
        ...benchIds.map((id, i) => ({ slot: "BN", slot_index: startingSlots.length + i, canonical_player_id: id, is_empty: false })),
        ...irIds.map((id, i) => ({ slot: "IR", slot_index: 100 + i, canonical_player_id: id, is_empty: false })),
      ],
      starters: starterIds.filter((x): x is string => Boolean(x)),
      bench: benchIds,
      ir: irIds,
      taxi: [] as string[],
      all_players: [...starterIds.filter((x): x is string => Boolean(x)), ...benchIds, ...irIds],
      provenance: { provider: "sleeper" as const, provider_id: String(t.roster_id), provider_synced_at: null },
    };
  });

  const allPlayers = new Map<string, CanonicalPlayer>();
  for (const t of opts.teams) {
    for (const p of [...t.starters, ...(t.bench ?? []), ...(t.ir ?? [])]) if (p) allPlayers.set(p.canonical_player_id, p);
  }

  return {
    league: attachLeagueFingerprints({
      canonical_league_id: `league:${SLUG}`,
      league_slug: SLUG,
      name: SLUG,
      season: 2026,
      status: opts.status ?? "in_season",
      sport: "nfl",
      team_count: opts.teams.length,
      current_week: opts.week ?? 2,
      scoring_rules: [],
      raw_scoring: opts.rawScoring ?? { rec: 1, pass_td: 4, rush_td: 6, rec_td: 6 },
      roster_settings: {
        starting_slots: startingSlots,
        bench_slots: bench,
        ir_slots: ir,
        taxi_slots: 0,
        slot_requirements: slotReq,
        roster_positions_raw: [...startingSlots, ...Array<string>(bench).fill("BN"), ...Array<string>(ir).fill("IR")],
      },
      playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: SLUG, provider_synced_at: null },
    }),
    managers,
    teams,
    rosters,
    standings: teams.map((t) => ({
      canonical_team_id: t.canonical_team_id,
      rank: null,
      wins: t.record.wins,
      losses: 0,
      ties: 0,
      win_percentage: null,
      points_for: t.record.points_for,
      points_against: 90,
      games_played: t.record.wins,
      playoff_seed: null,
    })),
    draft_picks: [],
    players: [...allPlayers.values()],
    unresolved_players: [],
  };
}

function toSnapshot(
  b: CanonicalLeagueStateBundle,
  week = 2,
  pairs: [number, number][] = [],
): CanonicalLeagueSnapshot {
  const matchups = pairs.map(([a, x], i) => ({
    canonical_matchup_id: `matchup:${SLUG}:w${week}:${i + 1}`,
    canonical_league_id: `league:${SLUG}`,
    week,
    status: "pre" as const,
    sides: [a, x].map((rid) => ({
      canonical_team_id: `team:${SLUG}:${rid}`,
      canonical_manager_ids: [],
      starters: [], bench: [], actual_points: null, player_points: {}, projected_points: null,
    })),
    provenance: { provider: "sleeper" as const, provider_id: null, provider_synced_at: null },
  }));
  const snap: CanonicalLeagueSnapshot = {
    schema_version: CANONICAL_SCHEMA_VERSION,
    lineage: undefined,
    captured_at: "2026-09-20T00:00:00.000Z",
    provider_synced_at: null,
    league: b.league,
    season: 2026,
    week,
    managers: b.managers,
    teams: b.teams,
    rosters: b.rosters,
    standings: b.standings,
    matchups,
    recent_transactions: [],
    draft_picks: [],
    waiver_state: null,
    players: b.players,
    unresolved_players: [],
    live_provider_status: "READY",
    history_persistence_status: "READY",
    warnings: [],
  };
  snap.lineage = deriveSnapshotLineage(snap, { crosswalkVersion: null });
  return snap;
}

const STD = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];

function fullTeam(spec: Partial<TeamSpec> & { roster_id: number }): TeamSpec {
  return {
    roster_id: spec.roster_id,
    user: spec.user ?? `u${spec.roster_id}`,
    display: spec.display ?? `Manager ${spec.roster_id}`,
    team_name: spec.team_name ?? `Team ${spec.roster_id}`,
    starters: spec.starters ?? [
      player("QB"), player("RB"), player("RB"), player("WR"), player("WR"),
      player("TE"), player("RB"), player("K"), player("DEF"),
    ],
    bench: spec.bench ?? [player("RB"), player("WR"), player("WR"), player("QB"), player("TE")],
    ir: spec.ir ?? [],
  };
}

/* ------------------------------------------------------- 1. inventory + depth */

describe("Team-State: positional inventory + depth pressure (projection-free)", () => {
  it("standard roster: counts are pure, healthy positions have no flags", () => {
    const b = bundle({ startingSlots: STD, teams: [fullTeam({ roster_id: 1 })] });
    const ts = buildTeamManagementState(toSnapshot(b), `team:${SLUG}:1`, NO_SCHEDULE);

    assert.equal(ts.roster.can_field_legal_lineup, true);
    const rb = ts.position_inventory.by_key.find((e) => e.slot_key === "RB")!;
    assert.equal(rb.required_starters, 2);
    assert.equal(rb.rostered, 4); // 2 starters + 1 flex-RB starter + 1 bench RB
    assert.equal(rb.active, 4);
    assert.equal(rb.starter_slots_covered, 2);

    const qb = ts.depth_pressure.by_key.find((e) => e.slot_key === "QB")!;
    assert.equal(qb.level, "thin"); // 1 starter + exactly 1 bench QB = SINGLE_BACKUP
    assert.equal(qb.reason_code, "SINGLE_BACKUP");
    assert.equal(qb.backup_count, 1);

    // a genuinely deep position is structural_surplus
    const surplus = ts.depth_pressure.by_key.filter((e) => e.structural_surplus).map((e) => e.slot_key);
    assert.ok(surplus.includes("RB") || surplus.includes("WR"));
  });

  it("NO_ACTIVE_BACKUP fires when a base key exactly meets its requirement", () => {
    const b = bundle({
      startingSlots: STD,
      teams: [
        fullTeam({
          roster_id: 1,
          starters: [player("QB"), player("RB"), player("RB"), player("WR"), player("WR"), player("TE"), player("RB"), player("K"), player("DEF")],
          bench: [player("WR"), player("WR")], // no backup QB / TE / K / DEF
        }),
      ],
    });
    const ts = buildTeamManagementState(toSnapshot(b), `team:${SLUG}:1`, NO_SCHEDULE);
    const codes = ts.structural_flags.filter((f) => f.code === "NO_ACTIVE_BACKUP").flatMap((f) => f.positions);
    assert.ok(codes.includes("QB") && codes.includes("TE") && codes.includes("K") && codes.includes("DEF"));
    const qb = ts.depth_pressure.by_key.find((e) => e.slot_key === "QB")!;
    assert.equal(qb.level, "bare");
    assert.equal(qb.reason_code, "NO_BACKUP");
  });

  it("UNFILLED_STARTER_SLOT + ILLEGAL lineup when a starter slot is empty and unfillable", () => {
    const b = bundle({
      startingSlots: STD,
      teams: [
        fullTeam({
          roster_id: 1,
          starters: [player("QB"), player("RB"), player("RB"), player("WR"), player("WR"), player("TE"), player("RB"), null, null], // K + DEF empty
          bench: [player("WR")],
        }),
      ],
    });
    const ts = buildTeamManagementState(toSnapshot(b), `team:${SLUG}:1`, NO_SCHEDULE);
    assert.ok(ts.structural_flags.some((f) => f.code === "UNFILLED_STARTER_SLOT"));
    assert.ok(ts.structural_flags.some((f) => f.code === "ILLEGAL_CURRENT_LINEUP"));
    assert.equal(ts.roster.can_field_legal_lineup, false);
    assert.deepEqual([...ts.roster.unfilled_starter_slots].sort(), ["DEF", "K"]);
  });
});

/* --------------------------------------------- 2. FLEX / SUPER_FLEX / W-R-T */

describe("Team-State: flex eligibility uses the frozen slot machinery", () => {
  it("SUPER_FLEX: a QB backs the SUPER_FLEX slot and QB depth reflects it", () => {
    const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "SUPER_FLEX", "K", "DEF"];
    const b = bundle({
      startingSlots: slots,
      teams: [
        {
          roster_id: 1,
          user: "u1",
          display: "M1",
          team_name: "T1",
          starters: [player("QB"), player("RB"), player("RB"), player("WR"), player("WR"), player("TE"), player("QB"), player("K"), player("DEF")],
          bench: [player("QB"), player("RB"), player("WR")],
        },
      ],
    });
    const ts = buildTeamManagementState(toSnapshot(b), `team:${SLUG}:1`, NO_SCHEDULE);
    const sf = ts.league.flex_slots.find((f) => f.label === "SUPER_FLEX")!;
    assert.ok(sf.eligible_positions.includes("QB"));
    const sfEntry = ts.position_inventory.by_key.find((e) => e.slot_key === "SUPER_FLEX")!;
    assert.equal(sfEntry.starter_slots_covered, 1);
    assert.ok(sfEntry.rostered >= 5); // 3 QB + 2 RB + 3 WR + TE all eligible
  });

  it("Yahoo W/R/T resolves WR/RB/TE", () => {
    const slots = ["QB", "RB", "WR", "TE", "W/R/T", "K", "DEF"];
    const b = bundle({
      startingSlots: slots,
      teams: [
        {
          roster_id: 1, user: "u1", display: "M1", team_name: "T1",
          starters: [player("QB"), player("RB"), player("WR"), player("TE"), player("RB"), player("K"), player("DEF")],
          bench: [player("WR"), player("TE")],
        },
      ],
    });
    const ts = buildTeamManagementState(toSnapshot(b), `team:${SLUG}:1`, NO_SCHEDULE);
    const wrt = ts.league.flex_slots.find((f) => f.label === "W/R/T")!;
    assert.deepEqual([...wrt.eligible_positions].sort(), ["RB", "TE", "WR"]);
  });
});

/* ----------------------------------------------------- 3. IR / open slots */

describe("Team-State: IR + roster-slot facts", () => {
  it("IR_DEPTH_REDUCTION when an IR player is depth a bare position lacks", () => {
    const b = bundle({
      startingSlots: STD,
      teams: [
        fullTeam({
          roster_id: 1,
          starters: [player("QB"), player("RB"), player("RB"), player("WR"), player("WR"), player("TE"), player("RB"), player("K"), player("DEF")],
          bench: [player("WR")],
          ir: [player("TE", { name: "IR TE" })],
        }),
      ],
    });
    const ts = buildTeamManagementState(toSnapshot(b), `team:${SLUG}:1`, NO_SCHEDULE);
    const flag = ts.structural_flags.find((f) => f.code === "IR_DEPTH_REDUCTION");
    assert.ok(flag);
    assert.ok(flag!.positions.includes("TE"));
  });

  it("OPEN_ROSTER_SLOT reflects unused active capacity", () => {
    const b = bundle({
      startingSlots: STD,
      benchSlots: 6,
      teams: [fullTeam({ roster_id: 1, bench: [player("RB"), player("WR")] })], // 9 starters + 2 bench, capacity 15
    });
    const ts = buildTeamManagementState(toSnapshot(b), `team:${SLUG}:1`, NO_SCHEDULE);
    assert.equal(ts.roster.open_active_slots, 4);
    assert.ok(ts.structural_flags.some((f) => f.code === "OPEN_ROSTER_SLOT" && f.facts.open === 4));
  });
});

/* ----------------------------------------------- 4. manager / identity edges */

describe("Team-State: manager + identity edge cases", () => {
  it("departed manager keeps provider_owner_id; vacant roster is flagged vacant", () => {
    const b = bundle({
      startingSlots: STD,
      teams: [
        { roster_id: 1, user: "left-the-league", in_users: false, starters: [player("QB")], bench: [] },
        { roster_id: 2, user: null, starters: [], bench: [] },
      ],
    });
    const snap = toSnapshot(b);
    const t1 = buildTeamManagementState(snap, `team:${SLUG}:1`, NO_SCHEDULE);
    const t2 = buildTeamManagementState(snap, `team:${SLUG}:2`, NO_SCHEDULE);
    assert.equal(t1.identity.provider_owner_id, "left-the-league");
    assert.equal(t1.identity.manager_display_name, null);
    assert.equal(t1.identity.is_vacant, false);
    assert.equal(t2.identity.is_vacant, true);
    assert.equal(t2.identity.provider_owner_id, null);
  });

  it("K and D/ST carry join keys and are identified", () => {
    const b = bundle({
      startingSlots: STD,
      teams: [fullTeam({ roster_id: 1 })],
    });
    const ts = buildTeamManagementState(toSnapshot(b), `team:${SLUG}:1`, NO_SCHEDULE);
    const k = ts.roster.players.find((p) => p.position === "K")!;
    const def = ts.roster.players.find((p) => p.position === "DEF")!;
    assert.ok(k.ids.sleeper_id);
    assert.equal(def.is_team_defense, true);
    assert.equal(def.eligible_positions.includes("DEF"), true);
  });

  it("a GSIS-resolved player exposes both sleeper_id and gsis_id join keys", () => {
    const gsisRb = player("RB", { gsis: "00-0033280", name: "CMC" });
    const b = bundle({
      startingSlots: STD,
      teams: [fullTeam({ roster_id: 1, starters: [player("QB"), gsisRb, player("RB"), player("WR"), player("WR"), player("TE"), player("RB"), player("K"), player("DEF")] })],
    });
    const ts = buildTeamManagementState(toSnapshot(b), `team:${SLUG}:1`, NO_SCHEDULE);
    const cmc = ts.roster.players.find((p) => p.full_name === "CMC")!;
    assert.equal(cmc.canonical_player_id, "player:gsis:00-0033280");
    assert.equal(cmc.ids.gsis_id, "00-0033280");
    assert.ok(cmc.ids.sleeper_id && /^p\d+$/.test(cmc.ids.sleeper_id));
  });
});

/* ------------------------------------------------------ 5. schedule / bye */

describe("Team-State: schedule / bye facts (only when schedule verified)", () => {
  const schedule: ScheduleBundle = {
    status: "READY",
    source: "test-schedule",
    byeTeamsByWeek: new Map([[2, new Set(["KC"])], [3, new Set(["SF"])]]),
    opponentByTeam: { KC: "BUF", SF: "SEA" },
    currentWeek: 2,
  };

  it("CURRENT_WEEK_BYE_GAP when a bye starter has no eligible active replacement", () => {
    const b = bundle({
      startingSlots: STD,
      teams: [
        fullTeam({
          roster_id: 1,
          // sole TE is on KC (bye week 2), no bench TE
          starters: [player("QB", { team: "BUF" }), player("RB", { team: "BUF" }), player("RB", { team: "BUF" }), player("WR", { team: "BUF" }), player("WR", { team: "BUF" }), player("TE", { team: "KC" }), player("RB", { team: "BUF" }), player("K", { team: "BUF" }), player("DEF", { team: "BUF" })],
          bench: [player("WR", { team: "BUF" })],
        }),
      ],
    });
    const ts = buildTeamManagementState(toSnapshot(b), `team:${SLUG}:1`, schedule);
    assert.equal(ts.schedule_facts.status, "READY");
    assert.deepEqual(ts.schedule_facts.teams_on_bye_this_week, ["KC"]);
    assert.ok(ts.structural_flags.some((f) => f.code === "CURRENT_WEEK_BYE_GAP" && f.positions.includes("TE")));
    assert.ok(ts.schedule_facts.starters_on_bye.length === 1);
    const teP = ts.roster.players.find((p) => p.position === "TE")!;
    assert.equal(teP.on_bye_this_week, true);
    assert.equal(teP.nfl_opponent, null);
  });

  it("no schedule -> UNVERIFIED, no bye flags, opponents null", () => {
    const b = bundle({ startingSlots: STD, teams: [fullTeam({ roster_id: 1 })] });
    const ts = buildTeamManagementState(toSnapshot(b), `team:${SLUG}:1`, NO_SCHEDULE);
    assert.equal(ts.schedule_facts.status, "UNVERIFIED");
    assert.deepEqual(ts.schedule_facts.teams_on_bye_this_week, []);
    assert.ok(!ts.structural_flags.some((f) => f.code === "CURRENT_WEEK_BYE_GAP"));
  });
});

/* -------------------------------------------------- 6. matchup + league ctx */

describe("Team-State: league-level context", () => {
  it("all manager states + matchup pairs + ownership from ONE snapshot", () => {
    const b = bundle({
      startingSlots: STD,
      teams: [fullTeam({ roster_id: 1 }), fullTeam({ roster_id: 2 }), fullTeam({ roster_id: 3 }), fullTeam({ roster_id: 4 })],
    });
    const snap = toSnapshot(b, 2, [[1, 2], [3, 4]]);

    return runInLeagueStateScope(async () => {
      const res = await buildLeagueManagementContext(SLUG, { snapshotOverride: snap });
      assert.ok(res.context);
      const ctx = res.context!;
      assert.equal(ctx.teams.length, 4);
      assert.deepEqual(ctx.matchup_pairs.sort(), [[1, 2], [3, 4]]);
      assert.equal(ctx.teams[0]!.matchup!.opponent_roster_id, 2);
      assert.equal(Object.keys(ctx.ownership.owned_by_team).length > 0, true);
      assert.equal(ctx.ownership.free_agent_pool, "NOT_MATERIALIZED");
      // every team's lineage points at the SAME snapshot
      const ids = new Set(ctx.teams.map((t) => t.lineage.snapshot.league_snapshot_id));
      assert.equal(ids.size, 1);
      assert.equal([...ids][0], ctx.lineage.snapshot.league_snapshot_id);
      // league position summary is factual
      const k = ctx.league_position_summary.find((s) => s.slot_key === "K")!;
      assert.equal(k.total_active >= 4, true);
    });
  });

  it("one provider read for the whole league context", async () => {
    let calls = 0;
    const b = bundle({ startingSlots: STD, teams: [fullTeam({ roster_id: 1 }), fullTeam({ roster_id: 2 }), fullTeam({ roster_id: 3 }), fullTeam({ roster_id: 4 }), fullTeam({ roster_id: 5 }), fullTeam({ roster_id: 6 })] });
    const provider: FantasyProvider = {
      name: "sleeper", authentication: "NONE",
      capabilities: () => ({ league: true, settings: true, managers: true, standings: true, rosters: true, matchups: true, transactions: true, players: true, free_agents: true, waivers: true, draft_results: true, live_authenticated_access: true }),
      healthCheck: async () => ({ provider: "sleeper", status: "READY", authentication: "NONE", detail: "", checked_at: new Date().toISOString() }),
      getLeagueState: async () => { calls += 1; return ok(b); },
      getLeague: async () => ok(b.league),
      getManagers: async () => ok(b.managers),
      getStandings: async () => ok(b.standings),
      getRosters: async () => ok(b.rosters),
      getMatchups: async () => ok([]),
      getTransactions: async () => ok([]),
      getDraftResults: async () => ok([]),
      getWaiverState: async () => ok({ canonical_league_id: `league:${SLUG}`, league_slug: SLUG, players: [], provenance: { provider: "sleeper", provider_id: null, provider_synced_at: null } }),
    };
    const sched: ScheduleProvider = { name: "f", async getWeekSchedule(s, w) { return { season: s, week: w, status: "UNAVAILABLE", source: "f", teams_with_games: new Set(), teams_on_bye: new Set(), opponent_by_team: {}, warnings: [] }; } };
    const res = await buildLeagueManagementContext(SLUG, { providerOverride: provider, scheduleOverride: sched });
    assert.ok(res.context);
    assert.equal(res.context!.teams.length, 6);
    assert.equal(calls, 1, "exactly one getLeagueState for all 6 manager states");
  });
});

/* ------------------------------------------------------- 7. change detection */

describe("Team-State: change detection is factual", () => {
  // FIXED player objects so `from` and `to` share stable canonical ids.
  const R1_START = [player("QB"), player("RB", { name: "Player A" }), player("RB"), player("WR"), player("WR"), player("TE"), player("RB"), player("K"), player("DEF")];
  const R1_BENCH = [player("RB", { name: "Player B" }), player("WR", { name: "Moving WR" })];
  const R2_START = [player("QB"), player("RB"), player("RB"), player("WR"), player("WR"), player("TE"), player("RB"), player("K"), player("DEF")];
  const R2_BENCH = [player("WR")];
  const rbA = R1_START[1]!;
  const rbB = R1_BENCH[0]!;

  const baseBundle = bundle({
    startingSlots: STD,
    teams: [
      { roster_id: 1, user: "u1", display: "M1", team_name: "T1", starters: [...R1_START], bench: [...R1_BENCH] },
      { roster_id: 2, user: "u2", display: "M2", team_name: "T2", starters: [...R2_START], bench: [...R2_BENCH] },
    ],
  });
  // Independent deep copy each call — stable canonical ids, no shared references.
  const base = (): CanonicalLeagueStateBundle => structuredClone(baseBundle);

  it("PLAYER_MOVED_TO_BENCH / _TO_STARTER on a starter swap", () => {
    const from = toSnapshot(base());
    const b2 = base();
    // swap rbA (starter) <-> rbB (bench) on roster 1
    const r1 = b2.rosters[0]!;
    r1.starters = r1.starters.map((id) => (id === rbA.canonical_player_id ? rbB.canonical_player_id : id === rbB.canonical_player_id ? rbA.canonical_player_id : id));
    r1.bench = r1.bench.map((id) => (id === rbB.canonical_player_id ? rbA.canonical_player_id : id));
    r1.slots = r1.slots.map((s) =>
      s.canonical_player_id === rbA.canonical_player_id ? { ...s, canonical_player_id: rbB.canonical_player_id }
        : s.canonical_player_id === rbB.canonical_player_id ? { ...s, canonical_player_id: rbA.canonical_player_id } : s,
    );
    const diff = diffCanonicalSnapshots(from, toSnapshot(b2));
    const types = diff.changes.map((c) => c.type);
    assert.ok(types.includes("PLAYER_MOVED_TO_BENCH"));
    assert.ok(types.includes("PLAYER_MOVED_TO_STARTER"));
  });

  it("PLAYER_ADDED / _DROPPED / _OWNERSHIP_CHANGED", () => {
    const from = toSnapshot(base());
    const b2 = base();
    // roster 1 drops rbB; roster 2 adds a brand new player; a WR moves 1->2
    const movingWr = b2.players.find((p) => p.full_name === "Moving WR")!;
    b2.rosters[0]!.bench = b2.rosters[0]!.bench.filter((id) => id !== rbB.canonical_player_id && id !== movingWr.canonical_player_id);
    b2.rosters[0]!.all_players = b2.rosters[0]!.all_players.filter((id) => id !== rbB.canonical_player_id && id !== movingWr.canonical_player_id);
    const newP = player("TE", { name: "New Guy" });
    b2.players.push(newP);
    b2.rosters[1]!.bench.push(newP.canonical_player_id, movingWr.canonical_player_id);
    b2.rosters[1]!.all_players.push(newP.canonical_player_id, movingWr.canonical_player_id);
    const diff = diffCanonicalSnapshots(from, toSnapshot(b2));
    const byType = (t: string) => diff.changes.filter((c) => c.type === t);
    assert.equal(byType("PLAYER_DROPPED").length, 1);
    assert.equal(byType("PLAYER_ADDED").length, 1);
    assert.equal(byType("PLAYER_OWNERSHIP_CHANGED").length, 1);
    assert.equal(byType("PLAYER_DROPPED")[0]!.player_name, "Player B");
  });

  it("SCORING_CHANGED / WEEK_ADVANCED / TEAM_NAME_CHANGED / ROSTER_CONFIG_CHANGED", () => {
    const from = toSnapshot(base(), 2);
    const b2 = bundle({
      startingSlots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"], // +1 flex slot
      rawScoring: { rec: 0.5, pass_td: 4, rush_td: 6, rec_td: 6 }, // half PPR
      teams: [
        { roster_id: 1, user: "u1", display: "M1", team_name: "Renamed Team", starters: [player("QB"), player("RB"), player("RB"), player("WR"), player("WR"), player("TE"), player("RB"), player("WR"), player("K"), player("DEF")], bench: [] },
        { roster_id: 2, user: "u2", display: "M2", team_name: "T2", starters: [player("QB"), player("RB"), player("RB"), player("WR"), player("WR"), player("TE"), player("RB"), player("WR"), player("K"), player("DEF")], bench: [] },
      ],
    });
    const diff = diffCanonicalSnapshots(from, toSnapshot(b2, 3));
    const types = new Set(diff.changes.map((c) => c.type));
    assert.ok(diff.scoring_changed && types.has("SCORING_CHANGED"));
    assert.ok(diff.week_changed && types.has("WEEK_ADVANCED"));
    assert.ok(diff.roster_config_changed && types.has("ROSTER_CONFIG_CHANGED"));
    assert.ok(types.has("TEAM_NAME_CHANGED"));
  });

  it("PLAYER_INJURY_STATUS_CHANGED", () => {
    const from = toSnapshot(base());
    const b2 = base();
    const p = b2.players.find((x) => x.position === "QB")!;
    p.injury_status = "Questionable";
    const diff = diffCanonicalSnapshots(from, toSnapshot(b2));
    const inj = diff.changes.find((c) => c.type === "PLAYER_INJURY_STATUS_CHANGED");
    assert.ok(inj);
    assert.equal(inj!.after, "Questionable");
  });

  it("MATCHUP_CHANGED when the current-week opponent differs", () => {
    const b3 = bundle({
      startingSlots: STD,
      teams: [fullTeam({ roster_id: 1 }), fullTeam({ roster_id: 2 }), fullTeam({ roster_id: 3 }), fullTeam({ roster_id: 4 })],
    });
    const from = toSnapshot(structuredClone(b3), 2, [[1, 2], [3, 4]]);
    const to = toSnapshot(structuredClone(b3), 2, [[1, 3], [2, 4]]);
    const diff = diffCanonicalSnapshots(from, to);
    assert.ok(diff.changes.some((c) => c.type === "MATCHUP_CHANGED"));
  });

  it("identical snapshots -> no changes", () => {
    const s = toSnapshot(base(), 2, [[1, 2]]);
    assert.deepEqual(diffCanonicalSnapshots(s, s).changes, []);
  });
});

/* --------------------------------------------------------- 8. lineage */

describe("Team-State: lineage propagation", () => {
  it("every state carries the snapshot lineage + a team_state engine version", () => {
    const b = bundle({ startingSlots: STD, teams: [fullTeam({ roster_id: 1 })] });
    const snap = toSnapshot(b);
    const ts = buildTeamManagementState(snap, `team:${SLUG}:1`, NO_SCHEDULE);
    assert.equal(ts.lineage.snapshot.league_snapshot_id, snap.lineage!.league_snapshot_id);
    assert.equal(ts.lineage.engine_versions.team_state, "team-state-2026.1");
    assert.equal(ts.lineage.snapshot.scoring_fingerprint, snap.league.scoring_fingerprint);
    assert.equal(ts.football_context, null); // extension point, not stubbed
  });
});
