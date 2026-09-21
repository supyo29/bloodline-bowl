/** Phase 4 — synthetic fixtures for Waiver Intelligence 2.0 (no network). Built on the shared weekly fixture. */
import { player, proj, roster, weeklyContext, STD_CONSTRAINTS } from "./weekly";
import type { CanonicalPlayer, CanonicalPosition } from "../../lib/canonical/schema";
import type { AvailablePlayer, WeeklyProjection } from "../../lib/weekly/schema";
import type { DimensionProfile, PlayerRoleProfile } from "../../lib/player-role-intelligence/schema";
import type { OpportunityPropagationScenarioResult } from "../../lib/opportunity-propagation-intelligence/schema";
import type { OppEvaluator, PoolCertification, RoleEvidence, TeamView, WaiverInput, FiEvidence, ScheduleEvidence } from "../../lib/waiver2/types";

export type PSpec = { id: string; pos: CanonicalPosition; pts: number | null; team?: string; ros?: number | null; injury?: string | null; avail?: number; name?: string; gsis?: string };
export const mkPlayer = (s: PSpec): CanonicalPlayer => { const p = player(s.id, s.pos, { team: s.team ?? "KC", name: s.name ?? s.id, injury: s.injury ?? null }); p.identifiers = { sleeper_id: `sl-${s.id}`, gsis_id: s.gsis ?? `00-${s.id}` }; return p; };
export const mkProj = (s: PSpec): WeeklyProjection => proj(s.id, s.pos, s.pts, { rest_of_season_points: s.ros === undefined ? undefined : s.ros, injury_status: s.injury ?? null, expected_availability: s.avail ?? 1, ...(s.ros === undefined ? {} : { ros: s.ros == null ? null : { points: s.ros, source: "test", external_season_points: s.ros, ri_season_points: null, ri_position_rank: null, ri_vor: null, ri_tier: null, ri_confidence: null, disagreement_pct: null, disagreement_direction: "ONE_SOURCE" as const, confidence: "MEDIUM" as const, warnings: [] } }) });

export const dim = (recent: number | null, season: number | null, o: { conf?: DimensionProfile["confidence"]; trend?: DimensionProfile["trend_recent_vs_prior"]; n?: number; disc?: DimensionProfile["discontinuity"]; ev?: DimensionProfile["evidence_state"] } = {}): DimensionProfile => ({ latest: recent, recent, season, prior: season, prior_role_confidence: "MEDIUM", discontinuity: o.disc ?? "NONE", n_games_season: o.n ?? 8, opportunity_total: 50, delta_latest_vs_recent: null, trend_latest_vs_recent: o.trend ?? "STABLE", trend_latest_vs_season: o.trend ?? "STABLE", trend_recent_vs_prior: o.trend ?? "STABLE", evidence_state: o.ev ?? "OBSERVED", confidence: o.conf ?? "HIGH" });

export interface RoleSpec { tRecent?: number; tSeason?: number; rRecent?: number; rSeason?: number; conf?: DimensionProfile["confidence"]; trend?: DimensionProfile["trend_recent_vs_prior"]; n?: number; disc?: DimensionProfile["discontinuity"]; ret?: number; snap?: number; level?: PlayerRoleProfile["role_state"]["role_level"] }
export function roleProfile(p: CanonicalPlayer, s: RoleSpec): PlayerRoleProfile {
  const o = { conf: s.conf, trend: s.trend, n: s.n, disc: s.disc };
  return { identity: { gsis_id: p.identifiers.gsis_id!, sleeper_id: p.identifiers.sleeper_id ?? null, full_name: p.full_name, position: p.position, team: p.nfl_team ?? "KC", opponent: "LV" }, as_of: { season: 2026, through_week: 1 },
    participation: dim(s.snap ?? 0.6, 0.6, o),
    receiving: s.tRecent != null ? { target_share: dim(s.tRecent, s.tSeason ?? s.tRecent, o), position_group_target_share: null, air_yards_share: dim(0.2, 0.2, o), route_participation: dim(0.7, 0.7, o), corroboration_count: 1 } : null,
    rushing: s.rRecent != null ? { rush_share: dim(s.rRecent, s.rSeason ?? s.rRecent, o), position_group_rush_share: null, corroboration_count: 1 } : null,
    high_value: null, returns: { kick_return_role: dim(s.ret ?? 0, 0, o), punt_return_role: dim(0, 0, o) },
    role_state: { role_level: s.level ?? "REGULAR", role_trend: s.trend ?? "STABLE", evidence_state: o.disc === "ROOKIE_OR_NO_PRIOR_SEASON" ? "TENTATIVE" : "OBSERVED" }, source_availability: { route_evidence: "ROUTE_CORROBORATION_AVAILABLE" }, schema_version: "test" } as unknown as PlayerRoleProfile;
}

export interface TeamSpec { id: string; players: PSpec[]; faab?: number | null; priority?: number | null }
export interface WaiverFixture {
  week?: number; mine: { starters: PSpec[]; bench: PSpec[]; faab?: number | null; priority?: number | null; ir?: PSpec[] }; others?: TeamSpec[]; freeAgents: PSpec[];
  roles?: Record<string, RoleSpec>; roleThrough?: number; cert?: PoolCertification; raw_scoring?: Record<string, number>; waiver_type?: "faab" | "rolling" | "free_agency";
  opp?: OppEvaluator | null; bye?: Record<string, number>; recentPoints?: Record<string, number[]>; wins?: number[]; fiWeekState?: string | null; constraints?: typeof STD_CONSTRAINTS;
  transactions?: WaiverInput["transactions"];
}

export function mkWaiverInput(f: WaiverFixture): WaiverInput {
  const week = f.week ?? 2;
  const mine = [...f.mine.starters, ...f.mine.bench, ...(f.mine.ir ?? [])]; const others = (f.others ?? []).flatMap((t) => t.players);
  const myRoster = roster("team:test-league:1", f.mine.starters.map((s) => s.id), f.mine.bench.map((s) => s.id), { ir: (f.mine.ir ?? []).map((s) => s.id) });
  const oppRoster = others.length ? roster("team:test-league:2", [], others.map((s) => s.id)) : null;
  const weekly = weeklyContext({ week, myRoster, oppRoster, players: [...mine, ...others].map(mkPlayer), projections: [...mine, ...others].map(mkProj), freeAgents: f.freeAgents.map(mkPlayer), faProjections: f.freeAgents.map(mkProj), constraints: f.constraints, raw_scoring: f.raw_scoring, freeAgentPool: f.cert === "UNCERTIFIED_UNROSTERED" ? "UNAVAILABLE" : "HEALTHY", waiver_settings: f.waiver_type === "rolling" ? { type: "rolling", faab_budget: null, waiver_day: null } : f.waiver_type === "free_agency" ? { type: "unknown", faab_budget: null, waiver_day: null } : { type: "faab", faab_budget: 100, waiver_day: null } });
  // the shared fixture stamps week 1 on projections; align to the requested week
  for (const p of weekly.projections.by_player.values()) p.week = week;
  const pool: AvailablePlayer[] = weekly.availability.free_agents.filter((a) => f.freeAgents.some((s) => s.id === a.canonical_player_id));
  const teams: TeamView[] = [{ team_id: "team:test-league:1", name: "me", manager_ids: ["me"], active_player_ids: myRoster.all_players.filter((id) => !(f.mine.ir ?? []).some((s) => s.id === id)), faab_remaining: f.mine.faab === undefined ? 100 : f.mine.faab, waiver_priority: f.mine.priority ?? null }, ...(f.others ?? []).map((t): TeamView => ({ team_id: `team:test-league:${t.id}`, name: t.id, manager_ids: [t.id], active_player_ids: t.players.map((s) => s.id), faab_remaining: t.faab === undefined ? 100 : t.faab, waiver_priority: t.priority ?? null }))];
  const all = new Map<string, CanonicalPlayer>([...weekly.all_rostered, ...pool.map((a) => a.player), ...others.map(mkPlayer)].map((p) => [p.canonical_player_id, p]));
  const role: RoleEvidence | null = f.roles ? { version: "roi:test", season: 2026, through_week: f.roleThrough ?? week - 1, profile: (p) => (f.roles![p.canonical_player_id] ? roleProfile(all.get(p.canonical_player_id) ?? p, f.roles![p.canonical_player_id]!) : null) } : null;
  const schedule: ScheduleEvidence | null = f.bye ? { opponent: (t, w) => (f.bye![t] === w ? null : "LV"), bye_week: (t) => f.bye![t] ?? null, last_week: 18 } : null;
  const fi: FiEvidence = { version: "fi:test", through_week: week, week_state: f.fiWeekState === undefined ? "PARTIAL" : f.fiWeekState, defense: (t) => [{ team: t, metric: "def_pass_epa_allowed", league_percentile: 0.7, predictive_status: "PREDICTIVE", modeled: 0.05 }] };
  return { weekly, teams, my_team_id: "team:test-league:1", transactions: f.transactions ?? [], pool: { certification: f.cert ?? "CERTIFIED", candidates: pool, market: (f.cert ?? "CERTIFIED") === "CERTIFIED" ? { market_state_version: "market-state-2026.1", market_content_id: `mkt:2026:w${String(week).padStart(2, "0")}:fixture`, pool_id: "pool:fixture", acquisition_context_id: "acq:fixture", history_class: "TRUE_AS_OF", readiness_status: "READY", blocks: [], limitations: [], coverage: { pool_size: pool.length, evaluated: pool.length, unmatched: 0 } } : null }, role, fi, opp: f.opp ?? null, schedule, recent_points: f.recentPoints };
}

/** a stub OPP evaluator: if `absent` is unavailable on `team`, `beneficiary` gains `delta` target share */
export function oppStub(spec: { team: string; absent: string; beneficiary: string; dim?: "target_share" | "rush_share"; delta: number }): OppEvaluator {
  return (team, un) => (team === spec.team && un.includes(spec.absent) ? ({ scenario: { team, season: 2026, week: 2, unavailable_player_ids: un, scenario_type: "FULL_GAME_NONPARTICIPATION", support_level: "CALIBRATED", support_note: "test", availability_scenario_source: "CONSUMER_SUPPLIED" }, vacated_role: [], beneficiaries: [{ absent_player_id: spec.absent, domain: spec.dim === "rush_share" ? "RUSHING" : "RECEIVING", dimension: spec.dim ?? "target_share", beneficiary_gsis_id: spec.beneficiary, beneficiary_position: "WR", observed_pre_scenario_role: 0.1, expected_scenario_role: 0.1 + spec.delta, expected_delta: spec.delta, confidence: "LOW" }], residual: [{ absent_player_id: spec.absent, domain: "RECEIVING", dimension: "target_share", structural_residual: 0.05 }], opportunity_propagation_version: "opi:test", role_opportunity_version: "roi:test" } as unknown as OpportunityPropagationScenarioResult) : null);
}

/** a standard roster: QB/2RB/2WR/TE/K/DEF starters + 5 bench = 14 active (a full roster, so every add needs a drop) */
export const stdMine = (over: { wr?: number[]; rb?: number[]; faab?: number | null; priority?: number | null } = {}): WaiverFixture["mine"] => {
  const wr = over.wr ?? [15, 12, 6, 4.5, 3.5]; const rb = over.rb ?? [14, 10, 5, 3];
  return { faab: over.faab, priority: over.priority, starters: [{ id: "q1", pos: "QB", pts: 20 }, { id: "r1", pos: "RB", pts: rb[0]!, team: "DAL" }, { id: "r2", pos: "RB", pts: rb[1]!, team: "SF" }, { id: "w1", pos: "WR", pts: wr[0]!, team: "MIN" }, { id: "w2", pos: "WR", pts: wr[1]!, team: "BUF" }, { id: "t1", pos: "TE", pts: 8, team: "BAL" }, { id: "w3", pos: "WR", pts: wr[2]!, team: "DAL" }, { id: "k1", pos: "K", pts: 7 }, { id: "d1", pos: "DEF", pts: 8 }],
    bench: [{ id: "r3", pos: "RB", pts: rb[2]!, team: "PHI" }, { id: "w4", pos: "WR", pts: wr[3]!, team: "SF" }, { id: "t2", pos: "TE", pts: 4, team: "MIN" }, { id: "r4", pos: "RB", pts: rb[3]!, team: "BUF" }, { id: "w5", pos: "WR", pts: wr[4]!, team: "NE" }] };
};
