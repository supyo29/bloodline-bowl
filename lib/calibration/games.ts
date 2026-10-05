/**
 * NFL game identity + authoritative kickoff. Identity/status come from the Sleeper schedule (the repo's canonical
 * completion source, `lib/canonical/nfl-reality-frontier.ts`); the kickoff INSTANT comes from ESPN's public
 * scoreboard, because the Sleeper schedule carries only a calendar date. A game with no resolvable kickoff instant is
 * returned with `kickoff_at: null` and can never anchor certified evidence (fail closed).
 */
import { fetchSleeper, SLEEPER_ROOT_URL } from "@/lib/sleeper/client";
import { normalizeTeamCode } from "@/lib/canonical/team-codes";
import type { RawNflScheduleGame } from "@/lib/canonical/nfl-reality-frontier";
import type { NflGame } from "./types";

export interface EspnEventLite { id: string; date: string; home: string | null; away: string | null; neutral?: boolean; venue?: string | null }

/** Pure: joins schedule rows to ESPN kickoff instants by (week, home, away) after canonical team normalisation. */
export function buildNflGames(season: number, week: number, schedule: readonly RawNflScheduleGame[], espn: readonly EspnEventLite[]): { games: NflGame[]; missing_kickoff: string[] } {
  const byMatch = new Map<string, EspnEventLite>();
  for (const e of espn) {
    const h = normalizeTeamCode(e.home), a = normalizeTeamCode(e.away);
    if (h && a && Number.isFinite(Date.parse(e.date))) byMatch.set(`${h}|${a}`, e);
  }
  const games: NflGame[] = []; const missing: string[] = [];
  for (const g of schedule) {
    if (g.week !== week) continue;
    const home = normalizeTeamCode(g.home), away = normalizeTeamCode(g.away);
    if (!home || !away || !g.game_id) continue;
    const ev = byMatch.get(`${home}|${away}`);
    if (!ev) { missing.push(g.game_id); continue; }
    games.push({
      nfl_game_id: g.game_id, season, week, home_team: home, away_team: away,
      kickoff_at: new Date(ev.date).toISOString(), kickoff_source: "espn_scoreboard",
      status: (g.status ?? "").trim().toLowerCase(),
      provenance: { schedule_source: "sleeper_schedule", schedule_date: g.date ?? null, espn_event_id: ev.id, espn_date_raw: ev.date, ...(ev.neutral != null ? { espn_neutral_site: ev.neutral } : {}), ...(ev.venue ? { espn_venue: ev.venue } : {}) },
    });
  }
  games.sort((a, b) => (a.kickoff_at < b.kickoff_at ? -1 : a.kickoff_at > b.kickoff_at ? 1 : a.nfl_game_id < b.nfl_game_id ? -1 : 1));
  return { games, missing_kickoff: missing };
}

/** The team's game this week (a team plays at most once per regular-season week; a bye returns null). */
export function gameForTeam(games: readonly NflGame[], team: string | null): NflGame | null {
  const t = normalizeTeamCode(team);
  return t ? games.find((g) => g.home_team === t || g.away_team === t) ?? null : null;
}
export const opponentOf = (g: NflGame, team: string): string => (g.home_team === normalizeTeamCode(team) ? g.away_team : g.home_team);

export async function loadNflGames(season: number, week: number): Promise<{ games: NflGame[]; missing_kickoff: string[] }> {
  const [schedule, espnRaw] = await Promise.all([
    fetchSleeper<RawNflScheduleGame[]>(`/schedule/nfl/regular/${season}`, { baseUrl: SLEEPER_ROOT_URL, revalidate: 300 }),
    fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${season}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const events: EspnEventLite[] = ((espnRaw as { events?: Array<{ id: string; date: string; competitions?: Array<{ neutralSite?: boolean; venue?: { fullName?: string }; competitors?: Array<{ homeAway: string; team?: { abbreviation?: string } }> }> }> } | null)?.events ?? []).map((e) => {
    const comps = e.competitions?.[0]?.competitors ?? [];
    const c0 = e.competitions?.[0]; return { id: e.id, date: e.date, home: comps.find((c) => c.homeAway === "home")?.team?.abbreviation ?? null, away: comps.find((c) => c.homeAway === "away")?.team?.abbreviation ?? null, neutral: c0?.neutralSite, venue: c0?.venue?.fullName ?? null };
  });
  return buildNflGames(season, week, Array.isArray(schedule) ? schedule : [], events);
}
