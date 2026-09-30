/**
 * Point-in-time team/QB volume forecasts. EWMA with the SAME half-life (2 games) the canonical Role Intelligence profile uses
 * (analysis/player_role: ROLE$RECENT_HALFLIFE_GAMES), over completed games STRICTLY BEFORE the target week (prior season included
 * by recency, exactly like the role profile). Game script / opponent / pace effects are Phase 3 and deliberately absent.
 */
import type { ObservedRow } from "./data";
import type { TeamVolumeForecast } from "./types";

export const RECENT_HALFLIFE_GAMES = 2;
/** Same explicit-weight EWMA as analysis/player_role/lib_role_profile.R::ewma_through (oldest -> newest). */
export function ewma(xs: ReadonlyArray<number | null | undefined>, halflife = RECENT_HALFLIFE_GAMES): number | null {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (!v.length) return null;
  const n = v.length; let num = 0, den = 0;
  v.forEach((x, i) => { const w = Math.pow(0.5, (n - 1 - i) / halflife); num += w * x; den += w; });
  return num / den;
}
const before = (r: { season: number; week: number }, season: number, week: number): boolean => r.season < season || (r.season === season && r.week < week);
const order = (a: { season: number; week: number }, b: { season: number; week: number }): number => a.season - b.season || a.week - b.week;

/** One team-game total per (season, week, team): the substrate repeats team totals on every player row. */
export function teamGames(rows: readonly ObservedRow[], team: string, season: number, week: number): Array<{ season: number; week: number; team_pass_att: number | null; team_rush_att: number | null; team_rz_pass_att: number | null; team_rz_rush_att: number | null }> {
  const seen = new Map<string, ObservedRow>();
  for (const r of rows) if (r.team === team && before(r, season, week)) { const k = `${r.season}|${r.week}`; if (!seen.has(k)) seen.set(k, r); }
  return [...seen.values()].sort(order).map((r) => ({ season: r.season, week: r.week, team_pass_att: r.team_pass_att, team_rush_att: r.team_rush_att, team_rz_pass_att: r.team_rz_pass_att, team_rz_rush_att: r.team_rz_rush_att }));
}
export function forecastTeamVolume(rows: readonly ObservedRow[], team: string, season: number, week: number): TeamVolumeForecast {
  const g = teamGames(rows, team, season, week);
  return { team_pass_att: ewma(g.map((x) => x.team_pass_att)), team_rush_att: ewma(g.map((x) => x.team_rush_att)), team_rz_pass_att: ewma(g.map((x) => x.team_rz_pass_att)), team_rz_rush_att: ewma(g.map((x) => x.team_rz_rush_att)), games_used: g.length };
}

/** QB own-volume forecast (only games the QB actually played; missed games are absence, not zero). */
export function forecastQbVolume(rows: readonly ObservedRow[], gsis: string, season: number, week: number): { dropbacks: number | null; designed_rushes: number | null; scrambles: number | null } {
  const g = rows.filter((r) => r.gsis_id === gsis && before(r, season, week) && (r.offensive_snaps ?? 0) > 0).sort(order);
  return { dropbacks: ewma(g.map((r) => r.dropbacks)), designed_rushes: ewma(g.map((r) => r.designed_rushes)), scrambles: ewma(g.map((r) => r.qb_scrambles)) };
}

/** Latest completed game (season, week) strictly before the target week among the rows a forecast used. */
export function latestUsedGame(rows: readonly ObservedRow[], season: number, week: number, team: string, gsis: string | null): { season: number; week: number } | null {
  const used = rows.filter((r) => before(r, season, week) && (r.team === team || (gsis != null && r.gsis_id === gsis))).sort(order);
  const last = used[used.length - 1];
  return last ? { season: last.season, week: last.week } : null;
}
