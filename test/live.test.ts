/**
 * End-to-end tests against the real Sleeper API and the real Bloodline Bowl
 * league. These require network access.
 *
 * The league is currently pre-draft and empty, so these assert the invariants
 * that must hold regardless of league state, plus the shape contract that a
 * downstream AI depends on.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { SleeperError, fetchSleeper } from "../lib/sleeper/client";
import {
  BLOODLINE_BOWL_LEAGUE_ID,
  buildLeagueBundle,
} from "../lib/sleeper/service";
import type { LeagueResponse } from "../lib/sleeper/types";

let bundle: { response: LeagueResponse; complete: boolean };

before(async () => {
  bundle = await buildLeagueBundle(BLOODLINE_BOWL_LEAGUE_ID);
});

describe("live Bloodline Bowl snapshot", () => {
  it("loads every resource without warnings", () => {
    assert.deepEqual(bundle.response.metadata.warnings, []);
    assert.equal(bundle.complete, true);
  });

  it("returns the real league metadata", () => {
    const { league } = bundle.response;
    assert.equal(league.league_id, BLOODLINE_BOWL_LEAGUE_ID);
    assert.equal(league.name, "Bloodline Bowl");
    assert.equal(league.sport, "nfl");
    assert.ok(/^\d{4}$/.test(league.season));
  });

  it("returns one team per roster, with contiguous roster ids", () => {
    const { teams, league } = bundle.response;
    assert.equal(teams.length, league.total_rosters);
    assert.deepEqual(
      teams.map((team) => team.roster_id),
      Array.from({ length: teams.length }, (_, index) => index + 1),
    );
  });

  it("gives every team a starting lineup matching the league's slots", () => {
    const { teams, league } = bundle.response;
    const expected = league.starting_lineup.slots;
    for (const team of teams) {
      assert.equal(
        team.starters.length,
        expected.length,
        `roster ${team.roster_id} starter count`,
      );
      assert.deepEqual(
        team.starters.map((slot) => slot.roster_position),
        expected,
      );
    }
  });

  it("resolves every claimed roster to a real manager", () => {
    const claimed = bundle.response.teams.filter(
      (team) => !team.manager.is_vacant,
    );
    assert.ok(claimed.length > 0, "expected at least one claimed team");
    for (const team of claimed) {
      assert.ok(team.manager.user_id, `roster ${team.roster_id} user_id`);
      assert.ok(
        team.manager.display_name,
        `roster ${team.roster_id} display_name`,
      );
    }
  });

  it("resolves every rostered player id against Sleeper's database", () => {
    assert.deepEqual(bundle.response.metadata.unresolved_player_ids, []);
    for (const team of bundle.response.teams) {
      for (const player of team.players) {
        assert.equal(player.resolved, true, `player ${player.player_id}`);
        assert.ok(player.full_name.length > 0);
      }
    }
  });

  it("loads the full player database but ships only referenced players", () => {
    const { metadata } = bundle.response;
    assert.ok(
      metadata.player_database_size > 5000,
      "player database should be fully loaded internally",
    );
    assert.ok(
      metadata.player_count <= metadata.player_database_size,
      "response should never contain more players than the database",
    );

    const bytes = Buffer.byteLength(JSON.stringify(bundle.response));
    assert.ok(
      bytes < 2_000_000,
      `payload should stay far below the raw player dump, got ${bytes} bytes`,
    );
  });

  it("gives every roster the same amount of draft capital when nothing is traded", () => {
    const { teams, traded_picks: tradedPicks } = bundle.response;
    if (tradedPicks.length > 0) return; // Only meaningful before any pick trades.

    const totals = new Set(teams.map((team) => team.summary.total_picks_held));
    assert.equal(
      totals.size,
      1,
      "untraded leagues should give every roster identical pick counts",
    );
  });

  it("attributes every pick to a roster that exists", () => {
    const rosterIds = new Set(
      bundle.response.teams.map((team) => team.roster_id),
    );
    for (const team of bundle.response.teams) {
      for (const pick of team.draft_picks) {
        assert.ok(rosterIds.has(pick.original_roster_id));
        assert.ok(rosterIds.has(pick.current_owner_roster_id));
        assert.equal(
          pick.current_owner_roster_id,
          team.roster_id,
          "picks must be filed under their current owner",
        );
      }
    }
  });

  it("returns the league's drafts with resolved picks", () => {
    for (const draft of bundle.response.drafts) {
      assert.ok(draft.draft_id.length > 0);
      assert.equal(draft.pick_count, draft.picks.length);
      for (const pick of draft.picks) {
        assert.ok(pick.pick_no > 0);
        assert.ok(pick.round > 0);
        if (pick.player) assert.equal(pick.player.resolved, true);
      }
    }
  });

  it("is serializable and self-describing", () => {
    const parsed = JSON.parse(
      JSON.stringify(bundle.response),
    ) as LeagueResponse;
    assert.equal(parsed.source, "Sleeper");
    assert.ok(!Number.isNaN(Date.parse(parsed.generated_at)));
    assert.ok(Array.isArray(parsed.league_state.notes));
  });
});

describe("error handling", () => {
  it("raises a 404 SleeperError for a league that does not exist", async () => {
    await assert.rejects(
      () => buildLeagueBundle("1"),
      (error: unknown) => {
        assert.ok(error instanceof SleeperError);
        assert.equal(error.status, 404);
        return true;
      },
    );
  });

  it("raises a timeout SleeperError when the deadline is too short", async () => {
    await assert.rejects(
      () => fetchSleeper("/players/nfl", { timeoutMs: 1, noStore: true }),
      (error: unknown) => {
        assert.ok(error instanceof SleeperError);
        assert.equal(error.status, 504);
        return true;
      },
    );
  });
});
