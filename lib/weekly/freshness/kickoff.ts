/**
 * W1.P4 — NFL kickoff/game association for freshness. Kickoff is an ABSOLUTE instant (ISO-8601, UTC) per NFL game; it never depends on
 * the fantasy league, the server timezone, or an assumed Eastern Time. Every league converges on the same game state for a player.
 *
 * A game with no resolvable kickoff instant has `kickoff_at: null` and is treated conservatively (KICKOFF_UNKNOWN tier) — never as "far away".
 */

import { loadNflGames } from "@/lib/nfl-schedule/games";
import { normalizeTeamCode } from "@/lib/canonical/team-codes";

export interface KickoffGame {
  game_id: string;
  home_team: string;
  away_team: string;
  kickoff_at: string | null;
  status: string;
}

export interface KickoffSource {
  readonly name: string;
  /** null = the schedule could not be resolved (distinct from "no games") */
  getWeekGames(season: number, week: number): Promise<KickoffGame[] | null>;
}

export function gameForTeam(games: readonly KickoffGame[], team: string | null | undefined): KickoffGame | null {
  const t = normalizeTeamCode(team ?? null);
  return t ? games.find((g) => g.home_team === t || g.away_team === t) ?? null : null;
}

/** The earliest kickoff strictly after `nowMs` among games that have not started; plus whether every known game has started. */
export function nextKickoff(games: readonly KickoffGame[], nowMs: number): { next_kickoff_at: string | null; all_started: boolean; any_unknown_kickoff: boolean } {
  let next: number | null = null;
  let anyUnknown = false;
  let upcoming = 0;
  for (const g of games) {
    const k = g.kickoff_at ? Date.parse(g.kickoff_at) : NaN;
    if (!Number.isFinite(k)) {
      anyUnknown = true;
      continue;
    }
    if (k > nowMs) {
      upcoming += 1;
      if (next == null || k < next) next = k;
    }
  }
  return { next_kickoff_at: next == null ? null : new Date(next).toISOString(), all_started: games.length > 0 && upcoming === 0 && !anyUnknown, any_unknown_kickoff: anyUnknown };
}

const KICKOFF_MEMO_TTL_MS = 10 * 60 * 1000;

/** Production kickoff source: the repo's existing schedule+kickoff loader (Sleeper schedule identity, ESPN kickoff instants), memoised. Failure -> null. */
export class LiveKickoffSource implements KickoffSource {
  readonly name = "sleeper_schedule+espn_scoreboard";
  #memo = new Map<string, { at: number; games: KickoffGame[] | null }>();
  constructor(private readonly now: () => number = Date.now, private readonly load = loadNflGames) {}
  async getWeekGames(season: number, week: number): Promise<KickoffGame[] | null> {
    const key = `${season}|${week}`;
    const hit = this.#memo.get(key);
    const nowMs = this.now();
    if (hit && nowMs - hit.at < KICKOFF_MEMO_TTL_MS) return hit.games;
    let games: KickoffGame[] | null = null;
    try {
      const r = await this.load(season, week);
      // a week with ZERO resolved games is a failure to resolve, not an empty week
      games = r.games.length > 0 ? r.games.map((g) => ({ game_id: g.nfl_game_id, home_team: g.home_team, away_team: g.away_team, kickoff_at: g.kickoff_at, status: g.status })) : null;
    } catch {
      games = null;
    }
    this.#memo.set(key, { at: nowMs, games });
    return games;
  }
}
