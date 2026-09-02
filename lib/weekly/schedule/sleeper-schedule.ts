/**
 * SleeperScheduleProvider — the authoritative NFL week schedule.
 *
 * Source: `GET https://api.sleeper.app/schedule/nfl/regular/{season}` — an
 * undocumented but public, same-domain Sleeper feed (like `/projections` and
 * `/stats`). Returns every regular-season game: `{ week, home, away, game_id,
 * date, status }`.
 *
 * `teams_on_bye` for a week is derived by set-difference against the 32 NFL
 * clubs — but ONLY when the returned week looks complete (a plausible number of
 * games and every playing team is a recognised club). If the feed is short or
 * malformed for that week, `status` is `UNAVAILABLE` and NO byes are asserted.
 */

import { SLEEPER_ROOT_URL, fetchSleeper } from "@/lib/sleeper/client";
import { NFL_TEAMS, type ScheduleProvider, type WeekSchedule } from "./types";

interface RawGame {
  week?: number;
  home?: string | null;
  away?: string | null;
  game_id?: string | null;
  status?: string | null;
}

const NFL_SET = new Set(NFL_TEAMS);
/** A regular-season week has 13–16 games; below this the feed is treated as incomplete. */
const MIN_GAMES_FOR_COMPLETE_WEEK = 12;

export class SleeperScheduleProvider implements ScheduleProvider {
  readonly name = "sleeper_schedule";
  #cache = new Map<number, RawGame[] | null>();

  async getWeekSchedule(season: number, week: number): Promise<WeekSchedule> {
    let all = this.#cache.get(season);
    if (all === undefined) {
      all = await fetchSleeper<RawGame[]>(`/schedule/nfl/regular/${season}`, {
        baseUrl: SLEEPER_ROOT_URL,
        revalidate: 12 * 60 * 60,
      }).catch(() => null);
      this.#cache.set(season, all);
    }

    const base: WeekSchedule = {
      season,
      week,
      status: "UNAVAILABLE",
      source: this.name,
      teams_with_games: new Set(),
      teams_on_bye: new Set(),
      opponent_by_team: {},
      warnings: [],
    };

    if (!Array.isArray(all) || all.length === 0) {
      base.warnings.push({
        code: "SCHEDULE_UNAVAILABLE",
        message: `Authoritative NFL schedule for ${season} could not be loaded — bye weeks cannot be verified this run.`,
        severity: "warning",
      });
      return base;
    }

    const weekGames = all.filter((g) => g.week === week && g.home && g.away);
    const playing = new Set<string>();
    const opponent: Record<string, string> = {};
    for (const g of weekGames) {
      const home = String(g.home).toUpperCase();
      const away = String(g.away).toUpperCase();
      playing.add(home);
      playing.add(away);
      opponent[home] = away;
      opponent[away] = home;
    }

    base.teams_with_games = playing;
    base.opponent_by_team = opponent;

    const allRecognised = [...playing].every((t) => NFL_SET.has(t));
    const complete = weekGames.length >= MIN_GAMES_FOR_COMPLETE_WEEK && allRecognised && playing.size >= 24;

    if (complete) {
      base.status = "READY";
      base.teams_on_bye = new Set(NFL_TEAMS.filter((t) => !playing.has(t)));
    } else {
      base.warnings.push({
        code: "SCHEDULE_INCOMPLETE",
        message: `NFL schedule for ${season} week ${week} looks incomplete (${weekGames.length} games, ${playing.size} teams). Bye weeks not asserted this run.`,
        severity: "warning",
      });
    }
    return base;
  }
}
