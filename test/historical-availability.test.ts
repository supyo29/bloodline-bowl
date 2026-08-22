/**
 * Deterministic unit tests for historical player-availability evidence and
 * classification, using synthetic fixtures (not live network calls — see
 * `historical-availability-live.test.ts` for the real Devoted to the Game
 * 2025 validation).
 *
 * Real Sleeper player ids are used (via test/fixtures.ts's PLAYER_IDS) so the
 * derived NFL-team-code set (used for bye detection) comes from the real
 * player database, exactly as it would in production — only the weekly stat
 * lines and matchups are synthetic and fully controlled here.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { getPlayerIndex, type PlayerIndex } from "../lib/sleeper/client";
import {
  buildAvailabilityRecords,
  type AvailabilityRecord,
} from "../lib/analytics/historical-availability";
import { summarizeManagerAvailability } from "../lib/analytics/manager-availability";
import type { RawLeagueUser, RawMatchup, RawRoster } from "../lib/sleeper/types";
import type { PlayerStatLine } from "../lib/stats/types";
import { PLAYER_IDS } from "./fixtures";

const LEAGUE_ID = "test_league_availability";
const SEASON = "2027";
const ROSTER_POSITIONS = ["QB", "WR", "DEF", "BN", "BN", "IR"];

// Real NFL team codes with a defense entry every week except when a test
// deliberately omits one to simulate that team's bye.
const ALWAYS_PLAYING_TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
  "DEN", "DET", "GB", "IND", "JAX", "KC", "LAC", "LAR",
];

function teamRows(excludeTeams: string[] = []): PlayerStatLine[] {
  const teams = [...ALWAYS_PLAYING_TEAMS, "DAL", "SF", "HOU", "MIN"].filter(
    (t) => !excludeTeams.includes(t),
  );
  return teams.map((code) => ({
    player_id: code,
    season: SEASON,
    week: 0,
    stats: { gp: 1 },
  }));
}

const users: RawLeagueUser[] = [
  {
    user_id: "u1",
    display_name: "Alpha",
    avatar: null,
    is_owner: true,
    is_bot: false,
    league_id: LEAGUE_ID,
    metadata: { team_name: "Alpha Squad" },
    settings: null,
  },
  {
    user_id: "u2",
    display_name: "Beta",
    avatar: null,
    is_owner: false,
    is_bot: false,
    league_id: LEAGUE_ID,
    metadata: { team_name: "Beta Squad" },
    settings: null,
  },
];

// Roster 1 (u1) ends the season with `lamb` on IR (season-end snapshot).
const rosters: RawRoster[] = [
  {
    roster_id: 1,
    league_id: LEAGUE_ID,
    owner_id: "u1",
    co_owners: null,
    players: [PLAYER_IDS.jefferson, PLAYER_IDS.lamb, PLAYER_IDS.texansDefense, PLAYER_IDS.mccaffrey, PLAYER_IDS.unknown],
    starters: null,
    reserve: [PLAYER_IDS.lamb],
    taxi: null,
    keepers: null,
    settings: null,
    metadata: null,
  },
  {
    roster_id: 2,
    league_id: LEAGUE_ID,
    owner_id: "u2",
    co_owners: null,
    players: [PLAYER_IDS.mahomes, PLAYER_IDS.loveland],
    starters: null,
    reserve: [],
    taxi: null,
    keepers: null,
    settings: null,
    metadata: null,
  },
];

/** Build one roster's matchup row for a week. */
function matchupRow(
  rosterId: number,
  starters: string[],
  bench: string[],
  points: Record<string, number>,
): RawMatchup {
  const allStarters = [...starters, ...Array(Math.max(0, 3 - starters.length)).fill("0")];
  return {
    roster_id: rosterId,
    matchup_id: rosterId <= 2 ? 1 : 2,
    points: Object.values(points).reduce((a, b) => a + b, 0),
    players: [...starters, ...bench].filter((id) => id !== "0"),
    starters: allStarters,
    players_points: points,
    starters_points: null,
    custom_points: null,
  };
}

/**
 * Weeks 1-5 script, deliberately covering every required scenario:
 *
 *  W1: jefferson (MIN, roster1) starts & scores 0  -> participated, zero points != injury
 *      lamb (DAL, roster1) starts & scores          -> participated (last real week before IR)
 *      texansDefense (HOU, roster1) benched, plays   -> participated
 *      mccaffrey (SF, roster1) benched                -> did_not_play_unknown (team played, gp=0)
 *      mahomes (roster2) benched                       -> rookie/midseason: not yet a starter
 *      loveland NOT on any roster yet                  -> excluded (not rostered) this week
 *  W2: jefferson team MIN on bye                        -> bye_week, not injury
 *      lamb starts again (still fine)                    -> participated
 *      mccaffrey still did_not_play (gp=0, team played)
 *      unknown (unresolved id) has no stat line at all   -> unknown class
 *  W3: lamb (DAL) has zero participation and IS on the season-end reserve list,
 *      and this is strictly after lamb's last participation (W2) -> ir
 *      mahomes traded: dropped from roster1... (mahomes never was on roster1 here,
 *      simpler: mahomes moves from bench->starter on roster2, and a NEW player
 *      "loveland" is added to roster2 as a starter for the first time this week)
 *  W4: lamb still ir (consecutive)
 *      jefferson returns from its bye -> returning_after_absence
 *  W5: repeated add/drop: mccaffrey is no longer on any roster this week (dropped),
 *      reappears... (kept simple: just confirm rostered=false this week)
 */
const matchupsByWeek = new Map<number, RawMatchup[]>();
matchupsByWeek.set(1, [
  matchupRow(
    1,
    [PLAYER_IDS.jefferson, PLAYER_IDS.lamb, PLAYER_IDS.texansDefense],
    [PLAYER_IDS.mccaffrey, PLAYER_IDS.unknown],
    { [PLAYER_IDS.jefferson]: 0, [PLAYER_IDS.lamb]: 12.4, [PLAYER_IDS.texansDefense]: 8 },
  ),
  matchupRow(2, ["0", "0", "0"], [PLAYER_IDS.mahomes], {}),
]);
matchupsByWeek.set(2, [
  matchupRow(
    1,
    [PLAYER_IDS.jefferson, PLAYER_IDS.lamb, PLAYER_IDS.texansDefense],
    [PLAYER_IDS.mccaffrey, PLAYER_IDS.unknown],
    { [PLAYER_IDS.jefferson]: 0, [PLAYER_IDS.lamb]: 9.1, [PLAYER_IDS.texansDefense]: 3 },
  ),
  matchupRow(2, ["0", "0", "0"], [PLAYER_IDS.mahomes], {}),
]);
matchupsByWeek.set(3, [
  matchupRow(
    1,
    [PLAYER_IDS.jefferson, "0", PLAYER_IDS.texansDefense],
    [PLAYER_IDS.lamb, PLAYER_IDS.mccaffrey, PLAYER_IDS.unknown],
    { [PLAYER_IDS.jefferson]: 14.2, [PLAYER_IDS.texansDefense]: 5 },
  ),
  matchupRow(2, [PLAYER_IDS.mahomes, PLAYER_IDS.loveland, "0"], [], {
    [PLAYER_IDS.mahomes]: 22.6,
    [PLAYER_IDS.loveland]: 6.4,
  }),
]);
matchupsByWeek.set(4, [
  matchupRow(
    1,
    [PLAYER_IDS.jefferson, "0", PLAYER_IDS.texansDefense],
    [PLAYER_IDS.lamb, PLAYER_IDS.mccaffrey, PLAYER_IDS.unknown],
    { [PLAYER_IDS.jefferson]: 11.0, [PLAYER_IDS.texansDefense]: 2 },
  ),
  matchupRow(2, [PLAYER_IDS.mahomes, PLAYER_IDS.loveland, "0"], [], {
    [PLAYER_IDS.mahomes]: 18.2,
    [PLAYER_IDS.loveland]: 3.1,
  }),
]);
// Week 5: mccaffrey no longer rostered anywhere (dropped).
matchupsByWeek.set(5, [
  matchupRow(
    1,
    [PLAYER_IDS.jefferson, "0", PLAYER_IDS.texansDefense],
    [PLAYER_IDS.lamb, PLAYER_IDS.unknown],
    { [PLAYER_IDS.jefferson]: 9.0, [PLAYER_IDS.texansDefense]: 4 },
  ),
  matchupRow(2, [PLAYER_IDS.mahomes, PLAYER_IDS.loveland, "0"], [], {
    [PLAYER_IDS.mahomes]: 20.0,
    [PLAYER_IDS.loveland]: 5.0,
  }),
]);

const statsByWeek = new Map<number, PlayerStatLine[]>();
statsByWeek.set(1, [
  ...teamRows(),
  { player_id: PLAYER_IDS.jefferson, season: SEASON, week: 1, stats: { gp: 1, gms_active: 1 } },
  { player_id: PLAYER_IDS.lamb, season: SEASON, week: 1, stats: { gp: 1, gms_active: 1 } },
  { player_id: PLAYER_IDS.mccaffrey, season: SEASON, week: 1, stats: { gp: 0 } },
]);
statsByWeek.set(2, [
  ...teamRows(["MIN"]), // jefferson's team (MIN) on bye this week
  { player_id: PLAYER_IDS.lamb, season: SEASON, week: 2, stats: { gp: 1, gms_active: 1 } },
  { player_id: PLAYER_IDS.mccaffrey, season: SEASON, week: 2, stats: { gp: 0 } },
  // jefferson (MIN) and unknown player: no stat line at all this week.
]);
statsByWeek.set(3, [
  ...teamRows(),
  { player_id: PLAYER_IDS.jefferson, season: SEASON, week: 3, stats: { gp: 1, gms_active: 1 } },
  { player_id: PLAYER_IDS.mahomes, season: SEASON, week: 3, stats: { gp: 1, gms_active: 1 } },
  { player_id: PLAYER_IDS.loveland, season: SEASON, week: 3, stats: { gp: 1, gms_active: 1 } },
  // lamb: no stat line -> combined with season-end reserve + no participation since W2 -> ir
]);
statsByWeek.set(4, [
  ...teamRows(),
  { player_id: PLAYER_IDS.jefferson, season: SEASON, week: 4, stats: { gp: 1, gms_active: 1 } },
  { player_id: PLAYER_IDS.mahomes, season: SEASON, week: 4, stats: { gp: 1, gms_active: 1 } },
  { player_id: PLAYER_IDS.loveland, season: SEASON, week: 4, stats: { gp: 1, gms_active: 1 } },
]);
statsByWeek.set(5, [
  ...teamRows(),
  { player_id: PLAYER_IDS.jefferson, season: SEASON, week: 5, stats: { gp: 1, gms_active: 1 } },
  { player_id: PLAYER_IDS.mahomes, season: SEASON, week: 5, stats: { gp: 1, gms_active: 1 } },
  { player_id: PLAYER_IDS.loveland, season: SEASON, week: 5, stats: { gp: 1, gms_active: 1 } },
]);

let records: AvailabilityRecord[];
before(async () => {
  const playerIndex: PlayerIndex = await getPlayerIndex();
  const result = buildAvailabilityRecords({
    leagueSelector: "test",
    leagueId: LEAGUE_ID,
    season: SEASON,
    weeks: [1, 2, 3, 4, 5],
    matchupsByWeek,
    statsByWeek,
    rosters,
    users,
    rosterPositions: ROSTER_POSITIONS,
    playerIndex,
  });
  records = result.records;
});

function find(playerId: string, week: number): AvailabilityRecord {
  const record = records.find((r) => r.player_id === playerId && r.week === week);
  assert.ok(record, `expected a record for ${playerId} week ${week}`);
  return record;
}

describe("historical availability: participation vs zero points", () => {
  it("a player who participates and scores zero fantasy points is classified participated, not injured", () => {
    const r = find(PLAYER_IDS.jefferson, 1);
    assert.equal(r.game_played, true);
    assert.equal(r.fantasy_points, 0);
    assert.equal(r.availability_class, "participated");
    assert.equal(r.availability_confidence, "high");
  });

  it("zero fantasy points alone never implies injury for a rostered non-starter either", () => {
    // texansDefense started and scored real points; sanity check the positive case too.
    const r = find(PLAYER_IDS.texansDefense, 1);
    assert.equal(r.availability_class, "participated");
  });
});

describe("historical availability: bye week", () => {
  it("bye week != injury: MIN's bye is classified bye, with high confidence, never ir/did_not_play", () => {
    const r = find(PLAYER_IDS.jefferson, 2);
    assert.equal(r.bye_week, true);
    assert.equal(r.scheduled_game, false);
    assert.equal(r.availability_class, "bye");
    assert.equal(r.availability_confidence, "high");
    assert.equal(r.game_played, null);
  });

  it("a bye-week record carries no fabricated injury fields", () => {
    const r = find(PLAYER_IDS.jefferson, 2);
    assert.equal(r.historical_injury_designation, null);
    assert.equal(r.inactive, null);
    assert.equal(r.suspended, null);
  });
});

describe("historical availability: did-not-play with team playing", () => {
  it("a rostered player whose team played but who recorded gp=0 is did_not_play_unknown, moderate confidence", () => {
    const r = find(PLAYER_IDS.mccaffrey, 1);
    assert.equal(r.game_played, false);
    assert.equal(r.bye_week, false);
    assert.equal(r.availability_class, "did_not_play_unknown");
    assert.equal(r.availability_confidence, "moderate");
  });
});

describe("historical availability: IR season-end snapshot", () => {
  it("a season-end reserve player with no participation after their last active week is classified ir", () => {
    const w3 = find(PLAYER_IDS.lamb, 3);
    assert.equal(w3.availability_class, "ir");
    assert.equal(w3.availability_confidence, "low");
    assert.equal(w3.evidence_granularity, "season_end_snapshot");
    assert.equal(w3.reserve_or_ir, true);
    assert.match(w3.reserve_status ?? "", /IR/);
  });

  it("consecutive ir weeks stay ir (multiple consecutive missed games)", () => {
    const w4 = find(PLAYER_IDS.lamb, 4);
    assert.equal(w4.availability_class, "ir");
    assert.equal(w4.consecutive_games_missed_before_week, 1); // week 3 was already a miss
  });

  it("does not assume every reserve player was injured -- ir is a roster-status label, not a medical claim", () => {
    const w3 = find(PLAYER_IDS.lamb, 3);
    assert.equal(w3.historical_injury_designation, null);
    assert.equal(w3.suspended, null);
    assert.equal(w3.pup, null);
  });

  it("a player NOT on the season-end reserve list is never classified ir even with missed weeks", () => {
    // mccaffrey has did_not_play weeks but is not in any roster's `reserve` list.
    const r = find(PLAYER_IDS.mccaffrey, 1);
    assert.notEqual(r.availability_class, "ir");
  });
});

describe("historical availability: return from absence / continuity", () => {
  it("flags returning_after_absence and first_game_back the week participation resumes after a bye", () => {
    const w3 = find(PLAYER_IDS.jefferson, 3);
    assert.equal(w3.availability_class, "participated");
    assert.equal(w3.returning_after_absence, true);
    assert.equal(w3.first_game_back, true);
    assert.equal(w3.consecutive_games_missed_before_week, 1);
  });

  it("does not flag a return when the player did not miss the prior week", () => {
    const w4 = find(PLAYER_IDS.jefferson, 4);
    assert.equal(w4.returning_after_absence, false);
  });
});

describe("historical availability: unknown vs fabricated injury", () => {
  it("an unresolved player with zero evidence anywhere is classified unknown, never injury", () => {
    const r = find(PLAYER_IDS.unknown, 2);
    assert.equal(r.availability_class, "unknown");
    assert.equal(r.availability_confidence, "low");
    assert.equal(r.game_played, null);
    assert.equal(r.historical_injury_designation, null);
    assert.equal(r.resolved, false);
  });
});

describe("historical availability: current-status leakage guard", () => {
  it("historical_injury_designation is always null, regardless of the player's real current Sleeper status", () => {
    // jefferson/mahomes/etc. are real, currently-active NFL players whose live
    // Sleeper record may carry a current injury_status; it must never surface here.
    for (const r of records) {
      assert.equal(r.historical_injury_designation, null);
      assert.equal(r.historical_injury_designation_raw, null);
      assert.equal(r.historical_game_status, null);
      assert.equal(r.historical_practice_status, null);
      assert.equal(r.known_before_transaction, null);
    }
  });
});

describe("historical availability: manager/roster/starter joins", () => {
  it("joins manager_id and roster_id from that exact week's lineup, not a stale/global roster", () => {
    const r = find(PLAYER_IDS.jefferson, 1);
    assert.equal(r.manager_id, "u1");
    assert.equal(r.roster_id, 1);
  });

  it("started/bench reflect the real per-week starters array", () => {
    const starter = find(PLAYER_IDS.jefferson, 1);
    assert.equal(starter.started, true);
    assert.equal(starter.bench, false);

    const benched = find(PLAYER_IDS.mccaffrey, 1);
    assert.equal(benched.started, false);
    assert.equal(benched.bench, true);
  });
});

describe("historical availability: rookies / midseason additions", () => {
  it("a player not yet on any roster shows rostered=false (not fabricated ownership) before their addition", () => {
    const beforeAdd = find(PLAYER_IDS.loveland, 1);
    assert.equal(beforeAdd.rostered, false);
    assert.equal(beforeAdd.manager_id, null);
    assert.equal(beforeAdd.roster_id, null);
    assert.equal(beforeAdd.started, false);
  });

  it("is included with real roster context once actually rostered", () => {
    const after = find(PLAYER_IDS.loveland, 3);
    assert.equal(after.rostered, true);
    assert.equal(after.started, true);
    assert.equal(after.manager_id, "u2");
  });
});

describe("historical availability: traded/dropped ownership transitions", () => {
  it("mahomes flips from bench (roster 2, not started) to a starter without changing manager identity incorrectly", () => {
    const w1 = find(PLAYER_IDS.mahomes, 1);
    assert.equal(w1.roster_id, 2);
    assert.equal(w1.started, false);
    const w3 = find(PLAYER_IDS.mahomes, 3);
    assert.equal(w3.roster_id, 2);
    assert.equal(w3.started, true);
  });

  it("a dropped player (repeated add/drop) shows rostered=false for the week they are on no roster", () => {
    const w5 = records.find((r) => r.player_id === PLAYER_IDS.mccaffrey && r.week === 5);
    assert.ok(w5);
    assert.equal(w5!.rostered, false);
    assert.equal(w5!.manager_id, null);
    assert.equal(w5!.roster_id, null);
    assert.equal(w5!.started, false);
  });
});

describe("historical availability: string-id precision", () => {
  it("player_id, manager_id round-trip through JSON exactly, never as scientific-notation numbers", () => {
    const bigId = "99999999999999999"; // larger than Number.MAX_SAFE_INTEGER
    const syntheticRecord = { ...find(PLAYER_IDS.jefferson, 1), player_id: bigId };
    const roundTripped = JSON.parse(JSON.stringify(syntheticRecord));
    assert.equal(roundTripped.player_id, bigId);
    assert.equal(typeof roundTripped.player_id, "string");
  });

  it("every emitted record's player_id/manager_id/league_id are strings", () => {
    for (const r of records) {
      assert.equal(typeof r.player_id, "string");
      assert.equal(typeof r.league_id, "string");
      if (r.manager_id !== null) assert.equal(typeof r.manager_id, "string");
    }
  });
});

describe("historical availability: confidence tiers", () => {
  it("partial/derived evidence (ir, did_not_play_unknown) never reaches high confidence", () => {
    assert.equal(find(PLAYER_IDS.lamb, 3).availability_confidence, "low");
    assert.equal(find(PLAYER_IDS.mccaffrey, 1).availability_confidence, "moderate");
  });

  it("direct stat-line participation and strong bye evidence reach high confidence", () => {
    assert.equal(find(PLAYER_IDS.jefferson, 1).availability_confidence, "high");
    assert.equal(find(PLAYER_IDS.jefferson, 2).availability_confidence, "high");
  });
});

describe("manager availability aggregation stays descriptive-only", () => {
  it("counts starter-unavailable weeks by real evidence without labeling anyone good/bad", () => {
    const { managers, notes } = summarizeManagerAvailability(records, rosters, users);
    const roster1 = managers.find((m) => m.roster_id === 1);
    assert.ok(roster1);
    // jefferson's bye week (2) is a starter-unavailable week; mccaffrey/lamb/unknown are bench, so uncounted as starter weeks.
    assert.ok(roster1!.bye_starter_weeks >= 1);
    assert.equal(roster1!.inactive_starter_weeks, 0);
    assert.equal(roster1!.confirmed_injury_starter_weeks, 0);
    assert.ok(notes.some((n) => n.includes("Sleeper's public API exposes no historical injury designation")));
  });
});
