/**
 * End-to-end tests for the analytics layer against the real Bloodline Bowl
 * league. Requires network access.
 *
 * The league is a single season with no games played yet, so these assert the
 * invariants that must hold in that state (honest nulls, no fabricated
 * champions, correct manager identity, no subjective fields anywhere) rather
 * than specific historical numbers.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { resolveLeagueId } from "../lib/sleeper/service";
import { getNflState } from "../lib/sleeper/client";
import { buildLeagueHistory } from "../lib/analytics/history";
import { buildManagerProfiles } from "../lib/analytics/managers";
import { computeStandings } from "../lib/analytics/standings";
import { loadSeasonData, allWeeks } from "../lib/analytics/season-data";
import { buildSnapshot } from "../lib/analytics/snapshot";
import { getValueProvider } from "../lib/values/provider";
import { getStatsProvider } from "../lib/stats/provider";

const LEAGUE_ID = resolveLeagueId();

/** Fields that must never appear anywhere in the analytics layer's output. */
const FORBIDDEN_FIELD_PATTERNS = [
  "manager_skill",
  "roster_grade",
  "trade_grade",
  "draft_winner",
  "power_rank",
  "championship_probability",
  "roster_strength_score",
  "contender",
  "rebuild",
];

function assertNoSubjectiveFields(payload: unknown, label: string): void {
  const serialized = JSON.stringify(payload).toLowerCase();
  for (const forbidden of FORBIDDEN_FIELD_PATTERNS) {
    assert.ok(
      !serialized.includes(forbidden),
      `${label} contains forbidden field: ${forbidden}`,
    );
  }
}

describe("live: league history", () => {
  it("discovers the current season with no fabricated lineage", async () => {
    const nflState = await getNflState();
    const { seasons, warnings } = await buildLeagueHistory(
      LEAGUE_ID,
      nflState.season,
    );
    assert.ok(seasons.length >= 1);
    assert.equal(seasons[0]?.league_id, LEAGUE_ID);
    // Team count is read live rather than hardcoded — the commissioner has
    // already resized this league once between test runs.
    assert.ok((seasons[0]?.team_count ?? 0) > 0);
    assertNoSubjectiveFields(seasons, "history");
    assert.ok(Array.isArray(warnings));
  });

  it("never reports a champion without an actual decided bracket final", async () => {
    const nflState = await getNflState();
    const { seasons } = await buildLeagueHistory(LEAGUE_ID, nflState.season);
    const current = seasons.find((s) => s.season === nflState.season);
    // The league has not been played yet, so this must be null, not guessed.
    assert.equal(current?.champion, null);
    assert.equal(current?.runner_up, null);
  });
});

describe("live: standings", () => {
  it("computes standings for every roster with honest nulls pre-season", async () => {
    const seasonData = await loadSeasonData(LEAGUE_ID, {
      revalidate: 60,
      weeks: allWeeks(),
    });
    const standings = computeStandings(
      seasonData.rosters,
      seasonData.users,
      seasonData.matchupsByWeek,
      seasonData.winnersBracket,
    );
    assert.equal(standings.length, seasonData.rosters.length);
    assert.ok(standings.length > 0);
    for (const entry of standings) {
      assert.ok(
        entry.win_percentage === null ||
          (entry.win_percentage >= 0 && entry.win_percentage <= 1),
      );
      // Missing weekly-score data must be null, never fabricated as 0.
      if (entry.games_played === 0) {
        assert.equal(entry.highest_weekly_score, null);
      }
    }
    assertNoSubjectiveFields(standings, "standings");
  });
});

describe("live: managers", () => {
  it("resolves manager identity by stable Sleeper user_id", async () => {
    const nflState = await getNflState();
    const { seasons } = await buildLeagueHistory(LEAGUE_ID, nflState.season);
    const { profiles } = await buildManagerProfiles(seasons, nflState.season);

    assert.ok(profiles.length > 0);
    for (const profile of profiles) {
      assert.ok(/^\d+$/.test(profile.user_id));
      assert.ok(profile.seasons.length >= 1);
      // A manager present in only the current season has exactly one season entry.
      assert.equal(profile.seasons.length, profile.career.seasons_played);
    }
    assertNoSubjectiveFields(profiles, "managers");
  });

  it("does not fabricate FAAB spend when no waiver activity exists", async () => {
    const nflState = await getNflState();
    const { seasons } = await buildLeagueHistory(LEAGUE_ID, nflState.season);
    const { profiles } = await buildManagerProfiles(seasons, nflState.season);
    for (const profile of profiles) {
      if (
        profile.transactions.trades === 0 &&
        profile.transactions.waiver_claims === 0
      ) {
        assert.equal(profile.transactions.faab_spent, null);
      }
    }
  });
});

describe("live: value provider", () => {
  it("honestly reports unavailability rather than fabricating values", () => {
    const provider = getValueProvider();
    assert.equal(provider.isAvailable(), false);
    assert.ok(provider.unavailableReason()?.length ?? 0 > 0);
  });
});

describe("live: stats provider", () => {
  it("is available and backed by Sleeper's own stats endpoint", () => {
    const provider = getStatsProvider();
    assert.equal(provider.isAvailable(), true);
    assert.equal(provider.name, "Sleeper");
  });

  it("excludes synthetic team-aggregate rows from weekly stats", async () => {
    const provider = getStatsProvider();
    const lines = await provider.getWeeklyStats("2025", 1);
    assert.ok(lines.length > 1000, "expected a large per-player pool");
    assert.ok(
      !lines.some((line) => line.player_id.startsWith("TEAM_")),
      "synthetic TEAM_* rows must be filtered out",
    );
  });

  it("never exposes the provider's own precomputed point totals as raw stats", async () => {
    const provider = getStatsProvider();
    const lines = await provider.getWeeklyStats("2025", 1);
    for (const line of lines) {
      assert.ok(!("pts_ppr" in line.stats));
      assert.ok(!("pts_half_ppr" in line.stats));
      assert.ok(!("pts_std" in line.stats));
    }
  });
});

describe("live: snapshot", () => {
  let snapshot: Awaited<ReturnType<typeof buildSnapshot>>["snapshot"];

  before(async () => {
    const result = await buildSnapshot();
    snapshot = result.snapshot;
  });

  it("represents one team per roster with a budget and pick count", () => {
    assert.equal(snapshot.teams.length, snapshot.league.team_count);
    assert.ok(snapshot.teams.length > 0);
    for (const team of snapshot.teams) {
      assert.ok(
        team.budget === null || typeof team.budget.remaining === "number",
      );
      assert.ok(team.draft_pick_count >= 0);
    }
  });

  it("reflects the live pre-draft state honestly", () => {
    assert.equal(snapshot.league.status, "pre_draft");
    assert.equal(snapshot.draft.status, "pre_draft");
    assert.equal(snapshot.draft.completed_picks, 0);
  });

  it("stays compact — not a concatenation of every route", () => {
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    assert.ok(
      bytes < 200_000,
      `snapshot should stay compact, got ${bytes} bytes`,
    );
  });

  it("contains no subjective grades, labels, or rankings", () => {
    assertNoSubjectiveFields(snapshot, "snapshot");
  });
});

describe("live: no subjective fields anywhere in the analytics layer", () => {
  it("scans a full snapshot plus standings for forbidden fields", async () => {
    const { snapshot } = await buildSnapshot();
    const seasonData = await loadSeasonData(LEAGUE_ID, {
      revalidate: 300,
      weeks: [],
    });
    const standings = computeStandings(
      seasonData.rosters,
      seasonData.users,
      new Map(),
      seasonData.winnersBracket,
    );
    assertNoSubjectiveFields(
      { snapshot, standings },
      "combined analytics payload",
    );
  });
});
