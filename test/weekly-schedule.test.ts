/**
 * SleeperScheduleProvider — a week is only READY (byes asserted) when the feed
 * is STRUCTURALLY intact: all 32 clubs accounted for, one game per playing team,
 * 13–16 games, and an even bye set of <= 6. A truncated 12-game response is
 * never treated as a real week (it would zero 8+ teams that are actually
 * playing).
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { SleeperScheduleProvider } from "../lib/weekly/schedule/sleeper-schedule";
import { NFL_TEAMS } from "../lib/weekly/schedule/types";

/** Build a games array for `week` where `byeTeams` sit out. */
function week(games: Array<[string, string]>, w = 1) {
  return games.map(([home, away], i) => ({ week: w, home, away, game_id: `g${i}`, status: "pre" }));
}
function fullWeek(byeTeams: string[], w = 1) {
  const playing = NFL_TEAMS.filter((t) => !byeTeams.includes(t));
  const games: Array<[string, string]> = [];
  for (let i = 0; i < playing.length; i += 2) games.push([playing[i]!, playing[i + 1]!]);
  return week(games, w);
}
function mockFetch(t: { mock: typeof mock }, payload: unknown) {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response);
}

describe("SleeperScheduleProvider", () => {
  it("a complete 16-game week (0 byes) -> READY, no byes", async (t) => {
    mockFetch(t, fullWeek([]));
    const s = await new SleeperScheduleProvider().getWeekSchedule(2026, 1);
    assert.equal(s.status, "READY");
    assert.equal(s.teams_on_bye.size, 0);
    assert.equal(s.teams_with_games.size, 32);
    mock.restoreAll();
  });

  it("a complete 14-game week (4 byes) -> READY, exactly those 4 byes", async (t) => {
    const byes = ["KC", "BUF", "SF", "DAL"];
    mockFetch(t, fullWeek(byes, 6));
    const s = await new SleeperScheduleProvider().getWeekSchedule(2026, 6);
    assert.equal(s.status, "READY");
    assert.deepEqual([...s.teams_on_bye].sort(), [...byes].sort());
    mock.restoreAll();
  });

  it("a TRUNCATED 12-game response (8 'missing') -> UNAVAILABLE, NO byes asserted", async (t) => {
    // Take a real 16-game week and drop 2 games -> 12 games, 24 teams, 8 missing.
    const truncated = fullWeek([]).slice(0, 12);
    mockFetch(t, truncated);
    const s = await new SleeperScheduleProvider().getWeekSchedule(2026, 1);
    assert.equal(s.status, "UNAVAILABLE");
    assert.equal(s.teams_on_bye.size, 0);
    assert.ok(s.warnings.some((w) => w.code === "SCHEDULE_INCOMPLETE"));
    mock.restoreAll();
  });

  it("an odd number of missing teams (7) -> UNAVAILABLE (not a valid NFL bye set)", async (t) => {
    // 15 games would be 30 playing / 2 missing; instead craft 29 playing.
    const full = fullWeek([]);
    // remove one team entirely by dropping a game and re-pairing is messy; simpler:
    // drop 1 game (2 teams) then add back 1 lopsided — instead: 30 playing, but
    // one game references an unrecognised team so playing has 29 recognised + 1 not.
    const games = full.slice(0, 15).map((g) => ({ ...g }));
    games[0] = { ...games[0]!, away: "XXX" }; // unrecognised club
    mockFetch(t, games);
    const s = await new SleeperScheduleProvider().getWeekSchedule(2026, 1);
    assert.equal(s.status, "UNAVAILABLE");
    assert.equal(s.teams_on_bye.size, 0);
    mock.restoreAll();
  });

  it("feed entirely missing -> UNAVAILABLE, explicit warning", async (t) => {
    mockFetch(t, []);
    const s = await new SleeperScheduleProvider().getWeekSchedule(2026, 1);
    assert.equal(s.status, "UNAVAILABLE");
    assert.ok(s.warnings.some((w) => w.code === "SCHEDULE_UNAVAILABLE"));
    mock.restoreAll();
  });
});
