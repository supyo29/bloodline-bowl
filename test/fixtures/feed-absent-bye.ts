/**
 * W1.R1 / P1-4 fixture. Drives the REAL `buildWeeklyTeamContext` (schedule bye override, RI season signal, canonical forecast) over a FULL roster in
 * which a VALUABLE starter ("A", team BUF) is on a schedule-verified bye and is ABSENT from the weekly projection feed — the shape the audit
 * showed erasing his asset value. Only the free-agent pool (uncertified in the real context, fail-closed) is grafted on from the fixture
 * builder. Uses only long-standing public APIs, so the SAME scenario runs on a clean 65a04f4 checkout.
 */
import { buildWeeklyTeamContext } from "../../lib/weekly/context";
import { PlayerCrosswalk, NoCrosswalk } from "../../lib/canonical/players";
import { setPersistence, memoryPersistence } from "../../lib/persistence";
import { ok, type CanonicalLeagueStateBundle, type FantasyProvider } from "../../lib/providers/types";
import type { CanonicalPlayer } from "../../lib/canonical/schema";
import type { ProjectionProvider } from "../../lib/weekly/projections/types";
import type { RiSeasonEntry, RiSeasonSignalProvider } from "../../lib/weekly/projections-ri";
import type { WeeklyProjection, WeeklyTeamContext } from "../../lib/weekly/schema";
import { player, proj, roster as fxRoster, weeklyContext } from "./weekly";

type Pos = CanonicalPlayer["position"];
interface P { id: string; pos: Pos; team: string; pts: number | null; ros: number | null; injury?: string | null; inFeed?: boolean }

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];
const STARTERS = ["qb1", "rb1", "rb2", "wr1", "A", "te1", "f1", "k1", "def1"];

export interface FeedAbsentByeOptions {
  /** the subject's team plays this week (NOT a bye) — used for the "missing but not bye" control */
  subjectOnBye?: boolean;
  /** RI season benchmark (full-season points) for the subject; null/undefined => no RI evidence at all */
  riSeasonPoints?: number | null;
  /** subject present in the feed (alt shapes: with weekly points + ROS, or ROS only). Default: ABSENT from the feed. */
  subjectInFeed?: boolean;
  subjectPts?: number | null;
  subjectRos?: number | null;
  bench?: "solid" | "weak";
  subjectInjury?: string | null;
  /** subject is a streaming K/DST */
  subjectPos?: Pos;
  /** weeks (current week for the context) */
  week?: number;
  /** W1.R2: the subject's provider identity. null = NO sleeper id (a Yahoo-only player): the RI benchmark can then only be found by canonical id. */
  subjectSleeperId?: string | null;
}

export function buildPlayers(o: FeedAbsentByeOptions): P[] {
  const on = o.subjectOnBye ?? true;
  const team = on ? "BUF" : "KC";
  const solid = (o.bench ?? "solid") === "solid";
  const benchPts = solid ? 9 : 6.5;
  const benchRos = solid ? 110 : 45;
  const subjectPos = o.subjectPos ?? "WR";
  return [
    { id: "qb1", pos: "QB", team: "KC", pts: 20, ros: 240 },
    { id: "rb1", pos: "RB", team: "KC", pts: 16, ros: 190 },
    { id: "rb2", pos: "RB", team: "KC", pts: 12, ros: 140 },
    { id: "wr1", pos: "WR", team: "KC", pts: 15, ros: 180 },
    { id: "A", pos: subjectPos, team, pts: o.subjectPts ?? null, ros: o.subjectRos ?? null, injury: o.subjectInjury ?? null, inFeed: !!o.subjectInFeed },
    { id: "te1", pos: "TE", team: "KC", pts: 10, ros: 120 },
    { id: "f1", pos: "WR", team: "KC", pts: 10, ros: 110 },
    { id: "k1", pos: "K", team: "KC", pts: 8, ros: 90 },
    { id: "def1", pos: "DEF", team: "KC", pts: 7, ros: 85 },
    { id: "B", pos: "WR", team: "KC", pts: benchPts, ros: benchRos },
    ...["f2", "f3", "f4", "f5", "f6"].map((id) => ({ id, pos: "WR" as Pos, team: "KC", pts: benchPts, ros: benchRos })),
  ];
}

let subjectSleeperId: string | null = "A";
const mk = (p: P): CanonicalPlayer => {
  const sid = p.id === "A" ? subjectSleeperId : p.id;
  return { ...player(p.id, p.pos, { team: p.team, name: p.id, injury: p.injury ?? null }), identifiers: sid ? { sleeper_id: sid } : { yahoo_player_key: `nfl.p.${p.id}` } };
};

export async function feedAbsentByeContext(o: FeedAbsentByeOptions = {}): Promise<WeeklyTeamContext> {
  setPersistence(memoryPersistence());
  subjectSleeperId = o.subjectSleeperId === undefined ? "A" : o.subjectSleeperId;
  const week = o.week ?? 5;
  const ps = buildPlayers(o);
  const fa: P = { id: "faWR", pos: "WR", team: "KC", pts: 11, ros: 130 };
  const roster1 = {
    canonical_roster_id: "roster:bloodline-bowl:1", canonical_team_id: "team:bloodline-bowl:1",
    slots: SLOTS.map((slot, i) => ({ slot, slot_index: i, canonical_player_id: STARTERS[i]!, is_empty: false })),
    starters: STARTERS, bench: ps.map((p) => p.id).filter((id) => !STARTERS.includes(id)), ir: [], taxi: [],
    all_players: ps.map((p) => p.id), provenance: { provider: "sleeper" as const, provider_id: "1", provider_synced_at: null },
  };
  const roster2 = { ...roster1, canonical_roster_id: "roster:bloodline-bowl:2", canonical_team_id: "team:bloodline-bowl:2", slots: [], starters: [], bench: [], all_players: [], provenance: { provider: "sleeper" as const, provider_id: "2", provider_synced_at: null } };
  const mgr = (user: string, slug: string) => ({ canonical_manager_id: `manager:bloodline-bowl:${user}`, manager_slug: slug, provider_username: slug, display_name: slug, provider_user_id: user, is_commissioner: false, is_co_manager: false, provenance: { provider: "sleeper" as const, provider_id: user, provider_synced_at: null } });
  const team = (n: number, user: string) => ({ canonical_team_id: `team:bloodline-bowl:${n}`, canonical_league_id: "league:bloodline-bowl", provider_team_id: String(n), team_name: `team ${n}`, canonical_manager_ids: [`manager:bloodline-bowl:${user}`], record: { wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0 }, faab_remaining: 90, waiver_priority: n, provenance: { provider: "sleeper" as const, provider_id: String(n), provider_synced_at: null } });
  const bundle: CanonicalLeagueStateBundle = {
    league: {
      canonical_league_id: "league:bloodline-bowl", league_slug: "bloodline-bowl", name: "bloodline-bowl", season: 2026, status: "in_season", sport: "nfl", team_count: 2, current_week: week,
      scoring_rules: [{ key: "rec", points: 0.5, category: "receiving" }],
      raw_scoring: { rec: 0.5, pass_td: 4, rec_td: 6, rush_td: 6, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04 },
      roster_settings: { starting_slots: SLOTS, bench_slots: 6, ir_slots: 0, taxi_slots: 0, slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 } },
      playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: "bloodline-bowl", provider_synced_at: null },
    },
    managers: [mgr("u-supyo", "supyo29"), mgr("u-biji", "BijiMac")], teams: [team(1, "u-supyo"), team(2, "u-biji")], rosters: [roster1, roster2],
    standings: [], draft_picks: [], players: [...ps, fa].map(mk), unresolved_players: [],
  };
  const provider: FantasyProvider = {
    name: "sleeper", authentication: "NONE",
    capabilities: () => ({ league: true, settings: true, managers: true, standings: true, rosters: true, matchups: true, transactions: true, players: true, free_agents: true, waivers: true, draft_results: true, live_authenticated_access: true }),
    healthCheck: async () => ({ provider: "sleeper", status: "READY", authentication: "NONE", detail: "fake", checked_at: "2026-01-01T00:00:00.000Z" }),
    getLeagueState: async () => ok(bundle), getLeague: async () => ok(bundle.league), getManagers: async () => ok(bundle.managers), getStandings: async () => ok(bundle.standings),
    getRosters: async () => ok(bundle.rosters), getMatchups: async () => ok([]), getTransactions: async () => ok([]), getDraftResults: async () => ok([]),
    getWaiverState: async () => ok({ canonical_league_id: "league:bloodline-bowl", league_slug: "bloodline-bowl", players: [], provenance: { provider: "sleeper", provider_id: "bloodline-bowl", provider_synced_at: null } }),
  } as never;

  const row = (p: P): WeeklyProjection => ({
    canonical_player_id: p.id, week, season: 2026, position: p.pos, nfl_team: p.team, opponent: "OPP", is_home: null,
    projected_points: p.pts, floor_points: p.pts == null ? null : Math.max(0, p.pts - 5), ceiling_points: p.pts == null ? null : p.pts + 8, std_dev: p.pts == null ? null : 4,
    projection_status: p.pts == null ? "unavailable" : "projected", expected_availability: 1, is_bye: false, injury_status: p.injury ?? null,
    rest_of_season_points: p.ros, ros: null, source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire", uncertainty_source: "position_volatility_heuristic", warnings: [],
  });
  const inFeed = (p: P) => (p.id === "A" ? !!p.inFeed : true);
  const projectionProvider: ProjectionProvider = {
    name: "sleeper_weekly", model_version: "sleeper-weekly-rotowire",
    async getWeeklyProjections(req) {
      const by_player = new Map<string, WeeklyProjection>();
      const resolved_players = new Map<string, CanonicalPlayer>();
      for (const p of [...ps, fa]) {
        if (!inFeed(p)) continue; // the feed OMITS the bye player (and carries the free agent: the real feed is league-wide)
        resolved_players.set(p.id, mk(p));
        by_player.set(p.id, row(p));
      }
      return {
        league_slug: req.league.league_slug, season: 2026, week: req.week, status: "PROJECTIONS_PARTIAL", by_player, resolved_players, source: "sleeper_weekly",
        model_version: "sleeper-weekly-rotowire", missing: req.canonical_player_ids.filter((c) => !by_player.has(c)), teams_with_games: ["KC", "OPP"], warnings: [],
      };
    },
  };
  const ri: RiSeasonSignalProvider | null = o.riSeasonPoints == null ? null : {
    name: "fixture_ri",
    async getSeasonSignal() {
      const e: RiSeasonEntry = { sleeper_player_id: "A", canonical_player_id: "A", ri_season_points: o.riSeasonPoints!, ri_vor: null, ri_vor_rank: null, ri_position_rank: null, ri_tier: null, ri_confidence: null, external_season_points: o.riSeasonPoints!, disagreement_pct: null, primary_driver: null };
      return { status: "READY", model_version: "fixture", by_sleeper_id: subjectSleeperId ? new Map([[subjectSleeperId, e]]) : new Map(), by_canonical_id: new Map([["A", e]]), warning: null };
    },
  };
  const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
    week, providerOverride: provider, projectionProviderOverride: projectionProvider,
    scheduleProviderOverride: { name: "fx", async getWeekSchedule(season: number, w: number) { return { season, week: w, status: "READY" as const, source: "fx", teams_with_games: new Set(["KC", "OPP"]), teams_on_bye: new Set<string>(["BUF"]), opponent_by_team: {}, warnings: [] }; } },
    riSeasonProviderOverride: ri, crosswalkOverride: new PlayerCrosswalk(NoCrosswalk), skipReturnGameEnrichment: true,
  } as never);
  if (!r.context) throw new Error(`feed-absent-bye context failed: ${r.code} ${r.detail}`);
  // graft ONLY the free-agent pool (uncertified in the real context): shape taken from the standard fixture builder
  const tpl = weeklyContext({
    myRoster: fxRoster("team:test-league:1", ["a"], []), players: [player("a", "WR")], freeAgents: [player("faWR", "WR", { team: "KC", name: "Free Agent" })],
    projections: [proj("a", "WR", 1)], faProjections: [proj("faWR", "WR", fa.pts, { rest_of_season_points: fa.ros })],
  });
  const ctx = r.context;
  ctx.projections.by_player.set("faWR", row(fa));
  return { ...ctx, availability: { ...ctx.availability, free_agents: tpl.availability.free_agents }, free_agent_pool_readiness: tpl.free_agent_pool_readiness };
}
