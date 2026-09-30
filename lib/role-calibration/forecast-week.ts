/**
 * Week-level forecast assembly. LIVE_CAPTURED forecasts are frozen only for players whose kickoff is still in the future at capture
 * time (per-player rule); AS_OF_RECONSTRUCTION rebuilds a past week's forecast from strictly-earlier games + that team-week's
 * official injury designation, stamped AS_OF a fixed lead before kickoff, and is always labeled as reconstruction.
 */
import { loadOpportunityPropagationModel } from "@/lib/opportunity-propagation-intelligence/read";
import { gameForTeam, loadNflGames } from "@/lib/calibration/games";
import type { NflGame } from "@/lib/calibration/types";
import { loadDepthSnapshots, loadInjuryReports, loadObservedRoleGames, loadRoleProfilesAsOf, type ObservedRow, type ProfileRow, type InjuryRow, type DepthRow } from "./data";
import { buildRoleForecast } from "./forecast";
import type { CaptureKind, RoleForecast, RolePosition } from "./types";

/** Reconstructions are stamped this long before the player's kickoff. */
export const RECONSTRUCTION_LEAD_MS = 60 * 60_000;

export interface WeekForecastArgs {
  season: number; week: number; captureKind: CaptureKind; nowMs?: number;
  games?: readonly NflGame[]; priorKickoffs?: ReadonlyMap<string, string>;
  profiles?: readonly ProfileRow[]; observed?: readonly ObservedRow[]; injuries?: readonly InjuryRow[]; depth?: readonly DepthRow[];
}
export interface WeekForecastResult { forecasts: RoleForecast[]; skipped: { no_game: number; kickoff_passed: number; not_skill: number }; games_used: number }

export async function loadPriorKickoffs(season: number, weeks: readonly number[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const w of weeks) { const { games } = await loadNflGames(season, w).catch(() => ({ games: [] as NflGame[] })); for (const g of games) { m.set(`${season}|${w}|${g.home_team}`, g.kickoff_at); m.set(`${season}|${w}|${g.away_team}`, g.kickoff_at); } }
  return m;
}

export async function buildWeekForecasts(a: WeekForecastArgs): Promise<WeekForecastResult> {
  const games = a.games ?? (await loadNflGames(a.season, a.week)).games;
  const priorKick = a.priorKickoffs ?? (await loadPriorKickoffs(a.season, Array.from({ length: Math.max(0, a.week - 1) }, (_, i) => i + 1)));
  const profiles = (a.profiles ?? loadRoleProfilesAsOf()).filter((p) => p.target_week === a.week);
  const observed = a.observed ?? loadObservedRoleGames(), injuries = a.injuries ?? loadInjuryReports(), depth = a.depth ?? loadDepthSnapshots();
  const propagation = loadOpportunityPropagationModel();
  const now = a.nowMs ?? Date.now();
  const byTeam = new Map<string, ProfileRow[]>();
  for (const p of profiles) (byTeam.get(p.team) ?? byTeam.set(p.team, []).get(p.team)!).push(p);
  const out: RoleForecast[] = []; const skipped = { no_game: 0, kickoff_passed: 0, not_skill: 0 };
  for (const p of profiles) {
    if (!["QB", "RB", "WR", "TE"].includes(p.position)) { skipped.not_skill++; continue; }
    const g = gameForTeam(games, p.team);
    if (!g) { skipped.no_game++; continue; }
    const ko = Date.parse(g.kickoff_at);
    let asOfMs: number;
    if (a.captureKind === "LIVE_CAPTURED") { if (!(now < ko)) { skipped.kickoff_passed++; continue; } asOfMs = now; }
    else asOfMs = ko - RECONSTRUCTION_LEAD_MS;
    out.push(buildRoleForecast({
      season: a.season, week: a.week, profile: p, teammates: byTeam.get(p.team) ?? [], observed, injuries, depth, propagation,
      nflGameId: g.nfl_game_id, kickoffAt: g.kickoff_at, asOfAt: new Date(asOfMs).toISOString(), captureKind: a.captureKind,
      priorGameKickoff: (s, w, t) => priorKick.get(`${s}|${w}|${t}`) ?? null,
    }));
  }
  return { forecasts: out, skipped, games_used: games.length };
}
export type { RolePosition };
