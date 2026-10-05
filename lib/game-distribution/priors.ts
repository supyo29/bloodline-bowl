/**
 * Prior-season (2025) calibration priors. FITTED ONLY on the prior season's pre-game-forecast residuals, never on the season being evaluated:
 *   - team_game_pairs : per completed game, the pair of (actual / as-of-forecast) team volume ratios — resampled as a PAIR so a shootout (both teams
 *                       up) or a blowout (one up, one down) keeps its empirical correlation; this is the game-script distribution, learned not hand-labeled
 *   - role_pools      : per (position, availability class, sample tier, magnitude) pool of player role residuals incl. DNP — learned width by confidence tier
 *   - shocks          : team- and player-level efficiency dispersion beyond play-level sampling, fitted by pinball loss on held-out 2025 weeks
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RolePosition } from "@/lib/role-calibration/types";

export const GAME_DISTRIBUTION_MODEL_VERSION = "game-dist-2026.2";
export type AvailabilityClass = "OUT" | "DOUBTFUL" | "QUESTIONABLE" | "HEALTHY";
export type Tier = "T0" | "T1" | "T2";
/** ACT = a regular: played within the last two weeks AND in at least half of the weeks elapsed this season. LAP = long absence, injured reserve or sporadic attendance (IR players never appear on weekly injury reports, so without this they masquerade as HEALTHY starters who then do not play). */
export type Recency = "ACT" | "LAP";
export function recencyOf(f: { season: number; week: number; position?: string; provenance: Record<string, unknown>; metrics?: Partial<Record<string, { n_games_season?: number } | undefined>> }): Recency {
  const last = (f.provenance as { last_game?: { season: number; week: number } | null }).last_game;
  // games played this season: read from the primary metric every forecast carries (older persisted forecasts have no provenance field for it)
  const primary = f.position === "QB" ? "snap_share" : f.position === "RB" ? "rush_share" : "target_share";
  const n = f.metrics?.[primary]?.n_games_season ?? (f.provenance as { games_before_target_season?: number }).games_before_target_season ?? 0;
  return last && last.season === f.season && f.week - last.week <= 2 && n >= 0.5 * (f.week - 1) ? "ACT" : "LAP";
}
export const tierOf = (gamesBefore: number): Tier => (gamesBefore <= 2 ? "T0" : gamesBefore <= 6 ? "T1" : "T2");

/** volume ratio vector: [pass_att, rush_att, rz_pass_att, rz_rush_att] */
export type VolumeRatios = [number, number, number, number];
export interface RoleRow {
  played: 0 | 1;
  /** residuals actual - forecast (shares); null where the forecast metric does not exist */
  d_snap: number | null; d_target: number | null; d_rush: number | null; d_rz_target: number | null; d_rz_carry: number | null;
  /** QB / counts */
  ratio_dropbacks: number | null; d_designed: number | null; d_scrambles: number | null;
}
export interface RolePool { n: number; rows: RoleRow[] }
export interface CalibrationPriors {
  version: string; model_version: string; prior_season: number; fitted_on: string; generated_at: string;
  mag_cutpoints: Record<RolePosition, [number, number]>;
  team_game_pairs: Array<{ week: number; a: VolumeRatios; b: VolumeRatios; qb_change_a: boolean; qb_change_b: boolean }>;
  role_pools: Record<string, RolePool>;
  shocks: { sigma_team: number; sigma_player: number; fit_grid: Array<{ sigma_team: number; sigma_player: number; pinball: number }>; fit_weeks: number[]; holdout_weeks: number[] };
  /** PIT recalibration fitted on disjoint prior-season weeks: nominal level p -> the simulated level at which the actual falls below with probability p */
  recalibration: { fit_weeks: number[]; n: Record<string, number>; knots: number[]; mapped: Record<string, number[]> };
  regime: { qb_change_dispersion_ratio: number | null; n_qb_change_games: number; n_other_games: number; applied: boolean };
  notes: string[];
}
const DATA = join(process.cwd(), "lib", "game-distribution", "data");
const cache = new Map<number, CalibrationPriors | null>();
export function loadPriors(priorSeason: number): CalibrationPriors | null {
  if (cache.has(priorSeason)) return cache.get(priorSeason)!;
  const p = join(DATA, `calibration_priors_${priorSeason}.json`);
  const v = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CalibrationPriors) : null;
  cache.set(priorSeason, v);
  return v;
}

export const availabilityClass = (designation: string): AvailabilityClass => (designation === "OUT" ? "OUT" : designation === "DOUBTFUL" ? "DOUBTFUL" : designation === "QUESTIONABLE" ? "QUESTIONABLE" : "HEALTHY");
export const magBin = (v: number | null, cut: [number, number]): 0 | 1 | 2 => (v == null || v < cut[0] ? 0 : v < cut[1] ? 1 : 2);
/** Pool keys from most to least specific; the sampler uses the first with at least MIN_POOL rows. */
export const MIN_POOL = 40;
export function poolKeys(pos: RolePosition, avail: AvailabilityClass, rec: Recency, tier: Tier, mag: 0 | 1 | 2): string[] {
  // most specific first; when a cell is thin the SAMPLE TIER is dropped before the starter-vs-backup MAGNITUDE (magnitude decides whether a player plays)
  return [`${pos}|${avail}|${rec}|${tier}|${mag}`, `${pos}|${avail}|${rec}|m${mag}`, `${pos}|${avail}|${rec}|${tier}`, `${pos}|${avail}|${rec}`, `${pos}|${avail}`, `${pos}|HEALTHY`];
}
export function selectPool(priors: Pick<CalibrationPriors, "role_pools">, keys: readonly string[]): { key: string; pool: RolePool } {
  for (const k of keys) { const p = priors.role_pools[k]; if (p && p.n >= MIN_POOL) return { key: k, pool: p }; }
  const last = keys[keys.length - 1]!; const p = priors.role_pools[last];
  if (!p || !p.n) throw new Error(`no role pool for ${keys.join(" > ")}`);
  return { key: last, pool: p };
}
