/** File-backed loaders for the committed Role Calibration inputs (Vercel-safe, no network, no R). */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseCsv, num, str } from "./csv";
import { ROLE_METRICS, type RoleMetricName } from "./types";

const DATA_DIR = join(process.cwd(), "lib", "role-calibration", "data");
const read = (f: string): string | null => { const p = join(DATA_DIR, f); return existsSync(p) ? readFileSync(p, "utf8") : null; };

export interface ObservedRow {
  season: number; week: number; game_id: string | null; gsis_id: string; sleeper_id: string | null; full_name: string | null; position: string; team: string; opponent: string | null;
  offensive_snaps: number | null; team_offensive_plays: number | null; snap_share: number | null; route_participation: number | null;
  targets: number | null; team_pass_att: number | null; target_share: number | null; receptions: number | null; air_yards_share: number | null;
  carries: number | null; team_rush_att: number | null; rush_share: number | null; position_group_rush_share: number | null; position_group_target_share: number | null;
  dropbacks: number | null; qb_scrambles: number | null; designed_rushes: number | null;
  red_zone_targets: number | null; red_zone_carries: number | null; inside_10_carries: number | null; goal_line_carries: number | null; end_zone_targets: number | null;
  team_rz_pass_att: number | null; team_rz_rush_att: number | null; rz_target_share: number | null; rz_carry_share: number | null;
  third_down_targets: number | null; third_down_carries: number | null; two_minute_targets: number | null; two_minute_carries: number | null;
  inside_10_carry_share: number | null; goal_line_carry_share: number | null;
}
const clip01 = (v: number | null): number | null => (v == null ? null : Math.min(1, Math.max(0, v)));

let observedCache: ObservedRow[] | null = null;
export function loadObservedRoleGames(): ObservedRow[] {
  if (observedCache) return observedCache;
  const t = read("observed_role_game.csv");
  observedCache = t ? parseCsv(t).map((r) => ({
    season: Number(r.season), week: Number(r.week), game_id: str(r.game_id), gsis_id: r.gsis_id!, sleeper_id: str(r.sleeper_id), full_name: str(r.full_name), position: r.position!, team: r.team!, opponent: str(r.opponent),
    offensive_snaps: num(r.offensive_snaps), team_offensive_plays: num(r.team_offensive_plays),
    // snap share = offensive snaps / team offensive plays; provider definitions can differ slightly, so clip to [0,1] (raw ratio is recomputable from the two counts)
    snap_share: clip01(num(r.snap_share_derived)), route_participation: num(r.route_participation),
    targets: num(r.targets), team_pass_att: num(r.team_pass_att), target_share: num(r.target_share), receptions: num(r.receptions), air_yards_share: num(r.air_yards_share),
    carries: num(r.carries), team_rush_att: num(r.team_rush_att), rush_share: num(r.rush_share), position_group_rush_share: num(r.position_group_rush_share), position_group_target_share: num(r.position_group_target_share),
    dropbacks: num(r.dropbacks), qb_scrambles: num(r.qb_scrambles), designed_rushes: num(r.designed_rushes),
    red_zone_targets: num(r.red_zone_targets), red_zone_carries: num(r.red_zone_carries), inside_10_carries: num(r.inside_10_carries), goal_line_carries: num(r.goal_line_carries), end_zone_targets: num(r.end_zone_targets),
    team_rz_pass_att: num(r.team_rz_pass_att), team_rz_rush_att: num(r.team_rz_rush_att), rz_target_share: num(r.rz_target_share), rz_carry_share: num(r.rz_carry_share),
    third_down_targets: num(r.third_down_targets), third_down_carries: num(r.third_down_carries), two_minute_targets: num(r.two_minute_targets), two_minute_carries: num(r.two_minute_carries),
    inside_10_carry_share: num(r.inside_10_carry_share), goal_line_carry_share: num(r.goal_line_carry_share),
  })) : [];
  return observedCache;
}

export interface ProfileMetricRow { recent: number | null; season: number | null; prior: number | null; prior_conf: string | null; discontinuity: string | null; n_games: number; opp_total: number | null; conf: string | null }
export interface ProfileRow {
  target_week: number; gsis_id: string; sleeper_id: string | null; full_name: string | null; position: string; team: string;
  last_game_season: number; last_game_week: number; last_game_team: string | null; games_before_target_season: number; roster_team_source: string;
  metrics: Partial<Record<RoleMetricName, ProfileMetricRow>>;
}
let profileCache: ProfileRow[] | null = null;
export function loadRoleProfilesAsOf(): ProfileRow[] {
  if (profileCache) return profileCache;
  const t = read("role_profile_asof.csv");
  profileCache = t ? parseCsv(t).map((r) => {
    const metrics: ProfileRow["metrics"] = {};
    for (const m of ROLE_METRICS) {
      if (!(`${m}_n_games` in r)) continue;
      metrics[m] = { recent: num(r[`${m}_recent`]), season: num(r[`${m}_season`]), prior: num(r[`${m}_prior`]), prior_conf: str(r[`${m}_prior_conf`]), discontinuity: str(r[`${m}_discontinuity`]), n_games: num(r[`${m}_n_games`]) ?? 0, opp_total: num(r[`${m}_opp_total`]), conf: str(r[`${m}_conf`]) };
    }
    return { target_week: Number(r.target_week), gsis_id: r.gsis_id!, sleeper_id: str(r.sleeper_id), full_name: str(r.full_name), position: r.position!, team: r.team!, last_game_season: Number(r.last_game_season), last_game_week: Number(r.last_game_week), last_game_team: str(r.last_game_team), games_before_target_season: Number(r.games_before_target_season), roster_team_source: r.roster_team_source ?? "", metrics };
  }) : [];
  return profileCache;
}

export interface InjuryRow { season: number; week: number; gsis_id: string; team: string; position: string; report_status: string | null; practice_status: string | null; report_primary_injury: string | null }
let injuryCache: InjuryRow[] | null = null;
export function loadInjuryReports(): InjuryRow[] {
  if (injuryCache) return injuryCache;
  const t = read("injury_reports.csv");
  injuryCache = t ? parseCsv(t).map((r) => ({ season: Number(r.season), week: Number(r.week), gsis_id: r.gsis_id!, team: r.team!, position: r.position!, report_status: str(r.report_status), practice_status: str(r.practice_status), report_primary_injury: str(r.report_primary_injury) })) : [];
  return injuryCache;
}

export interface DepthRow { dt: string; team: string; gsis_id: string; pos_abb: string; pos_slot: string | null; pos_rank: number | null }
let depthCache: DepthRow[] | null = null;
export function loadDepthSnapshots(): DepthRow[] {
  if (depthCache) return depthCache;
  const t = read("depth_chart_snapshots.csv");
  depthCache = t ? parseCsv(t).map((r) => ({ dt: r.dt!, team: r.team!, gsis_id: r.gsis_id!, pos_abb: r.pos_abb!, pos_slot: str(r.pos_slot), pos_rank: num(r.pos_rank) })) : [];
  return depthCache;
}

export interface YieldTable {
  source: string; prior_season: number;
  rush: Array<{ position: string; kind: string; zone: string; n: number; ypc: number; td: number; fum_lost: number }>;
  receiving: Array<{ position: string; zone: string; n: number; catch_rate: number; yards_per_target: number; td_per_target: number; fum_lost: number }>;
  qb_dropback: Array<{ zone: string; n: number; pass_att_rate: number; sack_rate: number; scramble_rate: number }>;
  qb_pass_attempt: Array<{ zone: string; n: number; cmp_rate: number; yards_per_att: number; td_per_att: number; int_per_att: number }>;
}
const yieldCache = new Map<number, YieldTable | null>();
export function loadPositionYields(priorSeason: number): YieldTable | null {
  if (yieldCache.has(priorSeason)) return yieldCache.get(priorSeason)!;
  const t = read(`position_yields_${priorSeason}.json`);
  const v = t ? (JSON.parse(t) as YieldTable) : null;
  yieldCache.set(priorSeason, v);
  return v;
}
export function __resetRoleCalibrationCaches(): void { observedCache = profileCache = injuryCache = depthCache = null; yieldCache.clear(); }
