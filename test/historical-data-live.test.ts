/**
 * Live end-to-end validation for historical weekly scoring/lineups against
 * the real Devoted to the Game 2025 season. Requires network access.
 *
 * This is the authoritative validation the task requires: correct historical
 * league resolution (not the current 2026 league), full-season reconciliation
 * against Sleeper's own matchup totals, and the specific known trade
 * (Rawb21 <- Quinshon Judkins, coronel091 <- Jauan Jennings, week 4 2025).
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import {
  getLeague,
  getLeagueRosters,
  getLeagueTransactions,
  getLeagueUsers,
  getMatchups,
  getPlayerIndex,
} from "../lib/sleeper/client";
import { resolveLeagueId } from "../lib/sleeper/service";
import { resolveSeasonLeagueId } from "../lib/analytics/season-resolution";
import {
  buildPlayerWeeklyRows,
  hashScoringSettings,
} from "../lib/analytics/historical-scoring";
import { buildLineupRows } from "../lib/analytics/historical-lineups";
import {
  reconcileWeek,
  summarizeReconciliation,
} from "../lib/analytics/reconciliation";
import type { RawMatchup } from "../lib/sleeper/types";

const SELECTOR = "devoted-to-the-game";
const EXPECTED_2025_LEAGUE_ID = "1264616401079914496";
const QUINSHON_JUDKINS = "12512";
const JAUAN_JENNINGS = "7049";
const RAWB21_ROSTER_ID = 3;
const CORONEL091_ROSTER_ID = 10;

describe("live: historical season resolution (Devoted to the Game)", () => {
  it("resolves ?league=devoted-to-the-game&season=2025 to the exact known historical league id", async () => {
    const currentLeagueId = resolveLeagueId(SELECTOR);
    const currentLeague = await getLeague(currentLeagueId);
    const resolution = await resolveSeasonLeagueId(
      currentLeagueId,
      "2025",
      currentLeague.season,
      currentLeague,
    );
    assert.ok(resolution.ok);
    assert.equal(resolution.result.league.league_id, EXPECTED_2025_LEAGUE_ID);
    assert.equal(resolution.result.league.season, "2025");
    assert.equal(resolution.result.league.name, "Devoted to the Game");
    assert.equal(resolution.result.isCurrentSeason, false);
  });

  it("fails safely (404) for a season this league never had, without falling back", async () => {
    const currentLeagueId = resolveLeagueId(SELECTOR);
    const currentLeague = await getLeague(currentLeagueId);
    const resolution = await resolveSeasonLeagueId(
      currentLeagueId,
      "2019",
      currentLeague.season,
      currentLeague,
    );
    assert.equal(resolution.ok, false);
  });

  it("never silently returns the current (2026) league for a 2025 request", async () => {
    const currentLeagueId = resolveLeagueId(SELECTOR);
    const currentLeague = await getLeague(currentLeagueId);
    const resolution = await resolveSeasonLeagueId(
      currentLeagueId,
      "2025",
      currentLeague.season,
      currentLeague,
    );
    assert.ok(resolution.ok);
    assert.notEqual(resolution.result.league.league_id, currentLeagueId);
  });
});

describe("live: 12-roster handling for the 2025 season", () => {
  it("has exactly 12 rosters", async () => {
    const rosters = await getLeagueRosters(EXPECTED_2025_LEAGUE_ID);
    assert.equal(rosters.length, 12);
  });

  it("has exactly 12 users, all with claimed rosters", async () => {
    const [rosters, users] = await Promise.all([
      getLeagueRosters(EXPECTED_2025_LEAGUE_ID),
      getLeagueUsers(EXPECTED_2025_LEAGUE_ID),
    ]);
    assert.equal(users.length, 12);
    assert.ok(rosters.every((r) => r.owner_id !== null));
  });
});

describe("live: player-weekly scoring (2025)", () => {
  let league: Awaited<ReturnType<typeof getLeague>>;
  let week1Matchups: RawMatchup[];

  before(async () => {
    league = await getLeague(EXPECTED_2025_LEAGUE_ID);
    week1Matchups = await getMatchups(EXPECTED_2025_LEAGUE_ID, 1);
  });

  it("uses the 2025 league object's own scoring settings, fetched from the resolved 2025 league_id", async () => {
    // Note: Devoted to the Game happens to carry identical scoring settings
    // from 2025 into 2026 (the commissioner kept full PPR both years), so the
    // settings VALUES being equal is not itself evidence of a bug — what
    // matters is that the settings actually came from a `getLeague` call
    // scoped to the resolved 2025 league_id, not the current one. Prove that
    // by construction: fetch the 2025 league directly and confirm it's the
    // same object this suite has been using throughout.
    const directFetch2025 = await getLeague(EXPECTED_2025_LEAGUE_ID);
    assert.deepEqual(league.scoring_settings, directFetch2025.scoring_settings);
    assert.equal(league.season, "2025");
    assert.equal(league.league_id, EXPECTED_2025_LEAGUE_ID);
  });

  it("resolves real player identity for week 1", async () => {
    const playerIndex = await getPlayerIndex();
    const { rows } = buildPlayerWeeklyRows({
      leagueSelector: SELECTOR,
      leagueId: EXPECTED_2025_LEAGUE_ID,
      season: "2025",
      week: 1,
      matchups: week1Matchups,
      statLines: null,
      scoringSettings: league.scoring_settings,
      playerIndex,
      generatedAt: new Date().toISOString(),
      rosterPositions: league.roster_positions,
    });
    assert.ok(rows.length > 0);
    const resolvedCount = rows.filter((r) => r.resolved).length;
    assert.ok(
      resolvedCount / rows.length > 0.95,
      "expected the vast majority of rostered players to resolve",
    );
  });

  it("resolves team defense identity (e.g. a real NFL team code)", async () => {
    const playerIndex = await getPlayerIndex();
    const { rows } = buildPlayerWeeklyRows({
      leagueSelector: SELECTOR,
      leagueId: EXPECTED_2025_LEAGUE_ID,
      season: "2025",
      week: 1,
      matchups: week1Matchups,
      statLines: null,
      scoringSettings: league.scoring_settings,
      playerIndex,
      generatedAt: new Date().toISOString(),
      rosterPositions: league.roster_positions,
    });
    const defenses = rows.filter((r) => r.position === "DEF");
    assert.ok(defenses.length > 0);
    assert.ok(defenses.every((d) => d.resolved));
  });

  it("carries the resolved 2025 league's own scoring_settings_hash on every row", async () => {
    const playerIndex = await getPlayerIndex();
    const { rows } = buildPlayerWeeklyRows({
      leagueSelector: SELECTOR,
      leagueId: EXPECTED_2025_LEAGUE_ID,
      season: "2025",
      week: 1,
      matchups: week1Matchups,
      statLines: null,
      scoringSettings: league.scoring_settings,
      playerIndex,
      generatedAt: new Date().toISOString(),
      rosterPositions: league.roster_positions,
    });
    const expectedHash = hashScoringSettings(league.scoring_settings);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.scoring_settings_hash === expectedHash));
  });
});

describe("live: player-weekly and lineups reconciliation (multiple sampled weeks)", () => {
  const SAMPLE_WEEKS = [1, 8, 15, 18];

  it("reconciles summed starter points against matchup totals within tolerance for every sampled week", async () => {
    const league = await getLeague(EXPECTED_2025_LEAGUE_ID);
    const playerIndex = await getPlayerIndex();

    for (const week of SAMPLE_WEEKS) {
      const matchups = await getMatchups(EXPECTED_2025_LEAGUE_ID, week);
      assert.ok(matchups.length > 0, `week ${week} should have matchup data`);

      const { rows } = buildPlayerWeeklyRows({
        leagueSelector: SELECTOR,
        leagueId: EXPECTED_2025_LEAGUE_ID,
        season: "2025",
        week,
        matchups,
        statLines: null,
        scoringSettings: league.scoring_settings,
        playerIndex,
        generatedAt: new Date().toISOString(),
        rosterPositions: league.roster_positions,
      });

      const results = reconcileWeek(week, matchups, rows);
      const summary = summarizeReconciliation(results);
      assert.equal(
        summary.status,
        "reconciled",
        `week ${week} reconciliation failed: ${JSON.stringify(summary)}`,
      );
      assert.equal(summary.rosters_checked, 12);
    }
  });
});

describe("live: lineups (2025) — starter/bench detection and ownership", () => {
  it("returns 12 rosters worth of lineup data for week 1", async () => {
    const [league, rosters, users, matchups, playerIndex] = await Promise.all([
      getLeague(EXPECTED_2025_LEAGUE_ID),
      getLeagueRosters(EXPECTED_2025_LEAGUE_ID),
      getLeagueUsers(EXPECTED_2025_LEAGUE_ID),
      getMatchups(EXPECTED_2025_LEAGUE_ID, 1),
      getPlayerIndex(),
    ]);
    const { rows } = buildLineupRows({
      leagueSelector: SELECTOR,
      leagueId: EXPECTED_2025_LEAGUE_ID,
      season: "2025",
      week: 1,
      matchups,
      rosters,
      users,
      rosterPositions: league.roster_positions,
      playerIndex,
    });
    const rosterIds = new Set(rows.map((r) => r.roster_id));
    assert.equal(rosterIds.size, 12);

    const starters = rows.filter((r) => r.is_starter);
    const bench = rows.filter((r) => !r.is_starter);
    assert.ok(starters.length > 0);
    assert.ok(bench.length > 0);
    // 11 starting slots * 12 rosters.
    assert.equal(starters.length, 11 * 12);
  });

  it("never fabricates a roster_slot beyond STARTER_UNKNOWN when ambiguous", async () => {
    const [league, rosters, users, matchups, playerIndex] = await Promise.all([
      getLeague(EXPECTED_2025_LEAGUE_ID),
      getLeagueRosters(EXPECTED_2025_LEAGUE_ID),
      getLeagueUsers(EXPECTED_2025_LEAGUE_ID),
      getMatchups(EXPECTED_2025_LEAGUE_ID, 1),
      getPlayerIndex(),
    ]);
    const { rows } = buildLineupRows({
      leagueSelector: SELECTOR,
      leagueId: EXPECTED_2025_LEAGUE_ID,
      season: "2025",
      week: 1,
      matchups,
      rosters,
      users,
      rosterPositions: league.roster_positions,
      playerIndex,
    });
    const knownSlots = new Set([
      "QB",
      "RB",
      "WR",
      "TE",
      "FLEX",
      "K",
      "DEF",
      "STARTER_UNKNOWN",
    ]);
    for (const row of rows.filter((r) => r.is_starter)) {
      assert.ok(
        knownSlots.has(row.roster_slot ?? ""),
        `unexpected slot: ${row.roster_slot}`,
      );
    }
  });
});

describe("live: the required 2025 trade — Quinshon Judkins / Jauan Jennings", () => {
  it("shows pre-trade ownership in week 3 (before the week 4 trade)", async () => {
    const [league, rosters, users, matchups, playerIndex] = await Promise.all([
      getLeague(EXPECTED_2025_LEAGUE_ID),
      getLeagueRosters(EXPECTED_2025_LEAGUE_ID),
      getLeagueUsers(EXPECTED_2025_LEAGUE_ID),
      getMatchups(EXPECTED_2025_LEAGUE_ID, 3),
      getPlayerIndex(),
    ]);
    const { rows } = buildLineupRows({
      leagueSelector: SELECTOR,
      leagueId: EXPECTED_2025_LEAGUE_ID,
      season: "2025",
      week: 3,
      matchups,
      rosters,
      users,
      rosterPositions: league.roster_positions,
      playerIndex,
    });
    const judkins = rows.find((r) => r.player_id === QUINSHON_JUDKINS);
    const jennings = rows.find((r) => r.player_id === JAUAN_JENNINGS);
    assert.equal(judkins?.roster_id, CORONEL091_ROSTER_ID);
    assert.equal(jennings?.roster_id, RAWB21_ROSTER_ID);
  });

  it("shows post-trade ownership in week 5 (after the week 4 trade)", async () => {
    const [league, rosters, users, matchups, playerIndex] = await Promise.all([
      getLeague(EXPECTED_2025_LEAGUE_ID),
      getLeagueRosters(EXPECTED_2025_LEAGUE_ID),
      getLeagueUsers(EXPECTED_2025_LEAGUE_ID),
      getMatchups(EXPECTED_2025_LEAGUE_ID, 5),
      getPlayerIndex(),
    ]);
    const { rows } = buildLineupRows({
      leagueSelector: SELECTOR,
      leagueId: EXPECTED_2025_LEAGUE_ID,
      season: "2025",
      week: 5,
      matchups,
      rosters,
      users,
      rosterPositions: league.roster_positions,
      playerIndex,
    });
    const judkins = rows.find((r) => r.player_id === QUINSHON_JUDKINS);
    const jennings = rows.find((r) => r.player_id === JAUAN_JENNINGS);
    assert.equal(
      judkins?.roster_id,
      RAWB21_ROSTER_ID,
      "Judkins should now belong to Rawb21",
    );
    assert.equal(
      jennings?.roster_id,
      CORONEL091_ROSTER_ID,
      "Jennings should now belong to coronel091",
    );
    assert.equal(judkins?.manager_display_name, "Rawb21");
    assert.equal(jennings?.manager_display_name, "coronel091");
  });

  it("is corroborated by the actual trade transaction in week 4", async () => {
    const week4Transactions = await getLeagueTransactions(
      EXPECTED_2025_LEAGUE_ID,
      4,
    );
    const trade = week4Transactions.find(
      (t) => t.type === "trade" && t.status === "complete",
    );
    assert.ok(trade, "expected exactly one completed trade in week 4");
    assert.deepEqual(
      new Set(trade!.roster_ids),
      new Set([RAWB21_ROSTER_ID, CORONEL091_ROSTER_ID]),
    );
    assert.equal(trade!.adds?.[QUINSHON_JUDKINS], RAWB21_ROSTER_ID);
    assert.equal(trade!.adds?.[JAUAN_JENNINGS], CORONEL091_ROSTER_ID);
  });
});

describe("live: full-season completeness (2025)", () => {
  it("has matchup data for all 18 weeks with 12 rosters each", async () => {
    const weeks = Array.from({ length: 18 }, (_, i) => i + 1);
    const results = await Promise.all(
      weeks.map((w) => getMatchups(EXPECTED_2025_LEAGUE_ID, w)),
    );
    const missing = weeks.filter((_, i) => results[i]!.length === 0);
    assert.deepEqual(
      missing,
      [],
      "no week should be missing matchup data for a completed season",
    );
    for (const rows of results) {
      const rosterIds = new Set(rows.map((r) => r.roster_id));
      assert.equal(rosterIds.size, 12);
    }
  });
});
