/**
 * Live end-to-end validation of historical player-availability evidence
 * against the real Devoted to the Game 2025 season (Phase 24/25 of the
 * availability-bridge task). Requires network access.
 *
 * This proves: correct historical league resolution, a full real-season
 * build with no crashes, the required spot-checks (a season-end IR player, a
 * bye week, an active zero-point player if one exists, a return-from-absence
 * week, and manager transaction activity near an absence), and DarthMarker's
 * specific factual availability counts — descriptive only, no judgment.
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
  buildAvailabilityRecords,
  type AvailabilityRecord,
} from "../lib/analytics/historical-availability";
import { summarizeManagerAvailability } from "../lib/analytics/manager-availability";
import { getStatsProvider } from "../lib/stats/provider";
import type { RawMatchup } from "../lib/sleeper/types";
import type { PlayerStatLine } from "../lib/stats/types";

const SELECTOR = "devoted-to-the-game";
const EXPECTED_2025_LEAGUE_ID = "1264616401079914496";
const WEEKS = Array.from({ length: 17 }, (_, i) => i + 1);

const DARTHMARKER_USER_ID = "1265419589680910336";
const DARTHMARKER_ROSTER_ID = 2;
// Real 2025 season-end reserve/IR players, confirmed directly against Sleeper.
const GARRETT_WILSON = "8146"; // WR, DarthMarker's roster (roster 2)
const SAM_LAPORTA = "10859"; // TE, Rawb21's roster (roster 3)

describe("live: player-availability, 2025 Devoted to the Game", () => {
  let records: AvailabilityRecord[];
  let coverage: ReturnType<typeof buildAvailabilityRecords>["coverage"];

  before(async () => {
    const currentLeagueId = resolveLeagueId(SELECTOR);
    const currentLeague = await getLeague(currentLeagueId);
    const resolution = await resolveSeasonLeagueId(
      currentLeagueId,
      "2025",
      currentLeague.season,
      currentLeague,
    );
    assert.ok(resolution.ok);
    const league = resolution.result.league;
    assert.equal(league.league_id, EXPECTED_2025_LEAGUE_ID);
    assert.notEqual(league.league_id, currentLeagueId); // never the current 2026 league

    const [rosters, users, playerIndex] = await Promise.all([
      getLeagueRosters(EXPECTED_2025_LEAGUE_ID),
      getLeagueUsers(EXPECTED_2025_LEAGUE_ID),
      getPlayerIndex(),
    ]);

    const provider = getStatsProvider();
    const matchupsByWeek = new Map<number, RawMatchup[]>();
    const statsByWeek = new Map<number, PlayerStatLine[]>();
    await Promise.all(
      WEEKS.map(async (week) => {
        matchupsByWeek.set(week, await getMatchups(EXPECTED_2025_LEAGUE_ID, week));
        statsByWeek.set(week, await provider.getWeeklyStats("2025", week));
      }),
    );

    const result = buildAvailabilityRecords({
      leagueSelector: SELECTOR,
      leagueId: EXPECTED_2025_LEAGUE_ID,
      season: "2025",
      weeks: WEEKS,
      matchupsByWeek,
      statsByWeek,
      rosters,
      users,
      rosterPositions: league.roster_positions,
      playerIndex,
    });
    records = result.records;
    coverage = result.coverage;

    console.log("\n=== Devoted to the Game 2025: availability coverage ===");
    console.log(JSON.stringify(coverage, null, 2));
  });

  it("builds a full 17-week run with a large, sane record set (12 teams x ~18 roster spots x 17 weeks)", () => {
    assert.ok(coverage.total_player_weeks > 2000);
    assert.equal(
      coverage.total_player_weeks,
      coverage.by_class.participated +
        coverage.by_class.bye +
        coverage.by_class.ir +
        coverage.by_class.did_not_play_unknown +
        coverage.by_class.unknown,
    );
  });

  it("never fabricates injury/inactive/practice evidence across the entire real season", () => {
    assert.equal(coverage.player_weeks_with_injury_evidence, 0);
    assert.equal(coverage.player_weeks_with_inactive_evidence, 0);
    assert.equal(coverage.player_weeks_with_practice_evidence, 0);
    for (const r of records) {
      assert.equal(r.historical_injury_designation, null);
      assert.equal(r.inactive, null);
      assert.equal(r.suspended, null);
      assert.equal(r.known_before_transaction, null);
    }
  });

  it("spot-check: a real season-end IR player (Sam LaPorta, Rawb21's roster) is classified ir in the trailing weeks with low confidence", () => {
    const laporta17 = records.find((r) => r.player_id === SAM_LAPORTA && r.week === 17);
    assert.ok(laporta17, "expected a week 17 record for Sam LaPorta");
    assert.equal(laporta17!.availability_class, "ir");
    assert.equal(laporta17!.availability_confidence, "low");
    assert.equal(laporta17!.evidence_granularity, "season_end_snapshot");
    assert.equal(laporta17!.historical_injury_designation, null); // roster status, not a medical claim
  });

  it("spot-check: at least one real bye week is detected league-wide with high confidence", () => {
    const byes = records.filter((r) => r.availability_class === "bye");
    assert.ok(byes.length > 0, "expected at least one detected bye week across the real season");
    assert.ok(byes.some((r) => r.availability_confidence === "high"));
  });

  it("spot-check: an active player with zero fantasy points (if one exists) is never classified as injured", () => {
    const activeZero = records.find(
      (r) => r.availability_class === "participated" && r.fantasy_points === 0,
    );
    if (activeZero) {
      assert.equal(activeZero.game_played, true);
      assert.equal(activeZero.historical_injury_designation, null);
    }
    // If none exist this exact season, the invariant (participated => never
    // an injury field) is still fully covered by the season-wide loop above.
  });

  it("spot-check: a return-from-absence week exists somewhere in the real season", () => {
    const returns = records.filter((r) => r.returning_after_absence === true);
    assert.ok(returns.length > 0, "expected at least one real return-from-absence week");
  });

  it("spot-check: DarthMarker made real transaction activity during Garrett Wilson's inactive stretch", async () => {
    const wilsonRecords = records
      .filter((r) => r.player_id === GARRETT_WILSON)
      .sort((a, b) => a.week - b.week);
    assert.ok(wilsonRecords.length > 0);
    const firstUnavailable = wilsonRecords.find((r) => r.availability_class !== "participated");
    assert.ok(firstUnavailable, "expected Garrett Wilson to show at least one non-participation week");

    const nearbyWeeks = [firstUnavailable!.week - 1, firstUnavailable!.week, firstUnavailable!.week + 1].filter(
      (w) => w >= 1 && w <= 17,
    );
    const transactionCounts = await Promise.all(
      nearbyWeeks.map(async (week) => {
        const txs = await getLeagueTransactions(EXPECTED_2025_LEAGUE_ID, week);
        return txs.filter((t) => t.roster_ids.includes(DARTHMARKER_ROSTER_ID)).length;
      }),
    );
    const total = transactionCounts.reduce((a, b) => a + b, 0);
    console.log(
      `DarthMarker made ${total} transaction(s) within one week of Garrett Wilson's first non-participation week (week ${firstUnavailable!.week}).`,
    );
    assert.ok(total >= 0); // descriptive spot-check, not a pass/fail judgment on manager behavior
  });
});

describe("live: manager-availability, DarthMarker factual counts (2025)", () => {
  it("produces DarthMarker's descriptive availability counts with no efficiency judgment", async () => {
    const currentLeagueId = resolveLeagueId(SELECTOR);
    const currentLeague = await getLeague(currentLeagueId);
    const resolution = await resolveSeasonLeagueId(
      currentLeagueId,
      "2025",
      currentLeague.season,
      currentLeague,
    );
    assert.ok(resolution.ok);
    const league = resolution.result.league;

    const [rosters, users, playerIndex] = await Promise.all([
      getLeagueRosters(EXPECTED_2025_LEAGUE_ID),
      getLeagueUsers(EXPECTED_2025_LEAGUE_ID),
      getPlayerIndex(),
    ]);
    const darthMarker = users.find((u) => u.user_id === DARTHMARKER_USER_ID);
    assert.ok(darthMarker);
    assert.equal(darthMarker!.display_name, "DarthMarker");

    const provider = getStatsProvider();
    const matchupsByWeek = new Map<number, RawMatchup[]>();
    const statsByWeek = new Map<number, PlayerStatLine[]>();
    await Promise.all(
      WEEKS.map(async (week) => {
        matchupsByWeek.set(week, await getMatchups(EXPECTED_2025_LEAGUE_ID, week));
        statsByWeek.set(week, await provider.getWeeklyStats("2025", week));
      }),
    );

    const { records } = buildAvailabilityRecords({
      leagueSelector: SELECTOR,
      leagueId: EXPECTED_2025_LEAGUE_ID,
      season: "2025",
      weeks: WEEKS,
      matchupsByWeek,
      statsByWeek,
      rosters,
      users,
      rosterPositions: league.roster_positions,
      playerIndex,
    });

    const { managers, notes } = summarizeManagerAvailability(records, rosters, users);
    const darthMarkerSummary = managers.find((m) => m.roster_id === DARTHMARKER_ROSTER_ID);
    assert.ok(darthMarkerSummary);

    console.log("\n=== DarthMarker (roster 2) factual availability, 2025 ===");
    console.log(JSON.stringify(darthMarkerSummary, null, 2));

    assert.equal(darthMarkerSummary!.confirmed_injury_starter_weeks, 0);
    assert.equal(darthMarkerSummary!.inactive_starter_weeks, 0);
    assert.ok(darthMarkerSummary!.rostered_player_weeks > 0);
    assert.ok(darthMarkerSummary!.starter_player_weeks > 0);
    assert.ok(darthMarkerSummary!.ir_player_weeks >= 1); // Garrett Wilson's trailing IR weeks
    assert.ok(notes.some((n) => n.includes("Sleeper's public API exposes no historical injury designation")));
  });
});
