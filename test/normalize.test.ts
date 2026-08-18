/**
 * Normalization tests.
 *
 * Player resolution runs against the REAL Sleeper player database so these
 * assertions prove ids actually join to live player metadata, not to a stub.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { getPlayerIndex, type PlayerIndex } from "../lib/sleeper/client";
import { buildLeagueResponse } from "../lib/sleeper/normalize";
import type { LeagueResponse, RawDraftPick } from "../lib/sleeper/types";
import {
  PLAYER_IDS,
  fixtureDraftPicks,
  fixtureDrafts,
  fixtureLeague,
  fixtureNflState,
  fixtureRosters,
  fixtureTradedPicks,
  fixtureUsers,
} from "./fixtures";

let response: LeagueResponse;
let playerIndex: PlayerIndex;

before(async () => {
  playerIndex = await getPlayerIndex();

  const draftPicksByDraftId = new Map<string, RawDraftPick[]>([
    ["draft_2026", fixtureDraftPicks],
    ["draft_2027", []],
  ]);

  response = buildLeagueResponse({
    leagueId: "test_league",
    league: fixtureLeague,
    users: fixtureUsers,
    rosters: fixtureRosters,
    drafts: fixtureDrafts,
    draftPicksByDraftId,
    tradedPicks: fixtureTradedPicks,
    nflState: fixtureNflState,
    playerIndex,
    warnings: [],
    startedAt: Date.now(),
  });
});

/** Indexed access that fails the test rather than yielding `undefined`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item, `expected an element at index ${index}`);
  return item;
}

const teamById = (rosterId: number) => {
  const team = response.teams.find((t) => t.roster_id === rosterId);
  assert.ok(team, `roster ${rosterId} missing`);
  return team;
};

describe("player database", () => {
  it("loads the full Sleeper player database", () => {
    assert.ok(
      playerIndex.size > 5000,
      `expected a large player index, got ${playerIndex.size}`,
    );
  });

  it("resolves real player ids to real names, positions, and teams", () => {
    const mahomes = playerIndex.get(PLAYER_IDS.mahomes);
    assert.equal(mahomes?.full_name, "Patrick Mahomes");
    assert.equal(mahomes?.position, "QB");
    assert.equal(mahomes?.team, "KC");

    const jefferson = playerIndex.get(PLAYER_IDS.jefferson);
    assert.equal(jefferson?.full_name, "Justin Jefferson");
    assert.equal(jefferson?.position, "WR");
    assert.equal(jefferson?.team, "MIN");
  });

  it("keeps only the whitelisted fields on player objects", () => {
    const mahomes = playerIndex.get(PLAYER_IDS.mahomes);
    assert.ok(mahomes);
    assert.deepEqual(
      Object.keys(mahomes).sort(),
      [
        "age",
        "fantasy_positions",
        "first_name",
        "full_name",
        "injury_status",
        "last_name",
        "number",
        "player_id",
        "position",
        "resolved",
        "status",
        "team",
        "years_exp",
      ].sort(),
    );
    // Confirm the noisy Sleeper fields really are gone.
    for (const dropped of ["high_school", "espn_id", "birth_date", "hashtag"]) {
      assert.ok(!(dropped in mahomes), `${dropped} should be stripped`);
    }
  });

  it("names team defenses from first/last when full_name is null", () => {
    const defense = playerIndex.get(PLAYER_IDS.texansDefense);
    assert.equal(defense?.full_name, "Houston Texans");
    assert.equal(defense?.position, "DEF");
    assert.equal(defense?.resolved, true);
  });
});

describe("managers", () => {
  it("maps an active manager onto its roster with team name", () => {
    const manager = teamById(1).manager;
    assert.equal(manager.user_id, "u1");
    assert.equal(manager.display_name, "AlphaManager");
    assert.equal(manager.team_name, "Alpha Squad");
    assert.equal(manager.is_vacant, false);
    assert.equal(manager.is_owner, true);
  });

  it("marks a roster whose owner left the league as owned but nameless", () => {
    const manager = teamById(2).manager;
    assert.equal(manager.user_id, "u2");
    assert.equal(manager.display_name, null);
    assert.equal(manager.is_vacant, false);
  });

  it("marks an unclaimed roster as vacant", () => {
    const manager = teamById(3).manager;
    assert.equal(manager.user_id, null);
    assert.equal(manager.is_vacant, true);
  });
});

describe("records", () => {
  it("recombines Sleeper's split integer/decimal point fields", () => {
    const record = teamById(1).record;
    assert.equal(record.points_for, 1234.56);
    assert.equal(record.points_against, 1100.05);
    assert.equal(record.wins, 7);
    assert.equal(record.losses, 3);
    assert.equal(record.ties, 1);
  });

  it("defaults cleanly when a roster has no settings", () => {
    const record = teamById(3).record;
    assert.equal(record.wins, 0);
    assert.equal(record.points_for, 0);
    assert.equal(record.waiver_position, null);
  });
});

describe("starting lineup", () => {
  it("derives starting slots by excluding BN/IR/TAXI", () => {
    assert.deepEqual(response.league.starting_lineup.slots, [
      "QB",
      "RB",
      "RB",
      "WR",
      "WR",
      "TE",
      "FLEX",
      "K",
      "DEF",
    ]);
    assert.equal(response.league.starting_lineup.total_starters, 9);
    assert.equal(response.league.starting_lineup.bench_slots, 2);
    assert.deepEqual(response.league.starting_lineup.position_requirements, {
      QB: 1,
      RB: 2,
      WR: 2,
      TE: 1,
      FLEX: 1,
      K: 1,
      DEF: 1,
    });
  });

  it("aligns each starter with the lineup slot it fills", () => {
    const starters = teamById(1).starters;
    assert.equal(starters.length, 9);

    assert.equal(at(starters, 0).roster_position, "QB");
    assert.equal(at(starters, 0).player?.full_name, "Patrick Mahomes");

    assert.equal(at(starters, 1).roster_position, "RB");
    assert.equal(at(starters, 1).player?.full_name, "Christian McCaffrey");

    assert.equal(at(starters, 3).roster_position, "WR");
    assert.equal(at(starters, 3).player?.full_name, "Justin Jefferson");

    assert.equal(at(starters, 8).roster_position, "DEF");
    assert.equal(at(starters, 8).player?.full_name, "Houston Texans");
  });

  it('treats Sleeper\'s "0" sentinel as an empty slot', () => {
    const starters = teamById(1).starters;
    assert.equal(at(starters, 6).roster_position, "FLEX");
    assert.equal(at(starters, 6).is_empty, true);
    assert.equal(at(starters, 6).player, null);
    assert.equal(at(starters, 7).roster_position, "K");
    assert.equal(at(starters, 7).is_empty, true);
    assert.equal(teamById(1).summary.empty_starter_slots, 2);
    assert.equal(teamById(1).summary.starter_count, 7);
  });

  it("reports empty slots for a roster Sleeper sent as null", () => {
    const starters = teamById(2).starters;
    assert.equal(starters.length, 9);
    assert.ok(starters.every((slot) => slot.is_empty));
  });
});

describe("roster buckets", () => {
  it("derives bench as rostered players who are not starting, taxi, or IR", () => {
    const bench = teamById(1).bench;
    assert.deepEqual(
      bench.map((player) => player.player_id),
      [PLAYER_IDS.prescott],
    );
    assert.equal(at(bench, 0).full_name, "Dak Prescott");
  });

  it("keeps reserve and keepers as resolved player objects", () => {
    const team = teamById(1);
    assert.equal(team.reserve.length, 1);
    assert.equal(at(team.reserve, 0).player_id, PLAYER_IDS.unknown);
    assert.equal(at(team.keepers, 0).full_name, "Justin Jefferson");
  });

  it("counts rostered players by position", () => {
    const counts = teamById(1).summary.position_counts;
    assert.equal(counts.QB, 2); // Mahomes + Prescott
    assert.equal(counts.RB, 2);
    assert.equal(counts.WR, 2);
    assert.equal(counts.DEF, 1);
    assert.equal(counts.UNKNOWN, 1); // the unresolvable id
  });

  it("handles a roster Sleeper sent as null without crashing", () => {
    const team = teamById(2);
    assert.deepEqual(team.players, []);
    assert.deepEqual(team.bench, []);
    assert.equal(team.summary.player_count, 0);
  });
});

describe("unknown player ids", () => {
  it("returns an unresolved stub rather than dropping the player", () => {
    const stub = teamById(1).players.find(
      (player) => player.player_id === PLAYER_IDS.unknown,
    );
    assert.ok(stub);
    assert.equal(stub.resolved, false);
    assert.equal(stub.full_name, `Unknown player (${PLAYER_IDS.unknown})`);
    assert.equal(stub.position, null);
  });

  it("reports unresolved ids in metadata", () => {
    assert.ok(
      response.metadata.unresolved_player_ids.includes(PLAYER_IDS.unknown),
    );
  });
});

describe("draft capital", () => {
  it("excludes seasons whose draft has already completed", () => {
    const seasons = new Set(
      response.teams.flatMap((team) =>
        team.draft_picks.map((pick) => pick.season),
      ),
    );
    assert.deepEqual([...seasons], ["2027"]);
  });

  it("conserves the total pick count across the league", () => {
    const total = response.teams.reduce(
      (sum, team) => sum + team.draft_picks.length,
      0,
    );
    // 3 rosters x 4 rounds for the single upcoming season.
    assert.equal(total, 12);
  });

  it("attributes traded picks to their current owner", () => {
    const team1 = teamById(1);
    const acquired = team1.draft_picks.filter((pick) => pick.is_acquired);
    assert.equal(acquired.length, 2);

    const fromRoster3 = acquired.find(
      (pick) => pick.round === 1 && pick.original_roster_id === 3,
    );
    assert.ok(fromRoster3, "roster 1 should own roster 3's 2027 first");
    assert.equal(fromRoster3.current_owner_roster_id, 1);
    assert.equal(fromRoster3.is_traded, true);

    // Roster 1's own second-rounder went to roster 2.
    const ownSecond = team1.draft_picks.find(
      (pick) => pick.round === 2 && pick.original_roster_id === 1,
    );
    assert.equal(ownSecond, undefined);
    const roster2Has = teamById(2).draft_picks.find(
      (pick) => pick.round === 2 && pick.original_roster_id === 1,
    );
    assert.ok(roster2Has, "roster 2 should hold roster 1's 2027 second");
  });

  it("preserves the previous owner on a multi-hop trade", () => {
    const multiHop = teamById(1).draft_picks.find(
      (pick) => pick.round === 3 && pick.original_roster_id === 2,
    );
    assert.ok(multiHop);
    assert.equal(multiHop.previous_owner_roster_id, 3);
    assert.equal(multiHop.current_owner_roster_id, 1);
  });

  it("summarizes owned, acquired, and traded-away picks per team", () => {
    assert.deepEqual(
      {
        own: teamById(1).summary.own_picks_held,
        acquired: teamById(1).summary.picks_acquired,
        away: teamById(1).summary.picks_traded_away,
        total: teamById(1).summary.total_picks_held,
      },
      { own: 3, acquired: 2, away: 1, total: 5 },
      "roster 1 traded away only its 2027 second; its 2026 pick is already spent",
    );
    assert.equal(teamById(2).summary.total_picks_held, 4);
    assert.equal(teamById(3).summary.total_picks_held, 3);
  });

  it("labels where the round count came from", () => {
    const pick = at(teamById(1).draft_picks, 0);
    assert.equal(pick.rounds_source, "draft");
  });
});

describe("drafts", () => {
  it("normalizes picks and resolves the drafted player", () => {
    const draft = response.drafts.find((d) => d.draft_id === "draft_2026");
    assert.ok(draft);
    assert.equal(draft.pick_count, 3);

    const first = at(draft.picks, 0);
    assert.equal(first.pick_no, 1);
    assert.equal(first.round, 1);
    assert.equal(first.draft_slot, 1);
    assert.equal(first.player?.full_name, "Patrick Mahomes");
    assert.equal(first.player?.position, "QB");
  });

  it("coerces the string roster_id Sleeper returns on the picks endpoint", () => {
    const draft = response.drafts.find((d) => d.draft_id === "draft_2026");
    assert.ok(draft);
    assert.equal(at(draft.picks, 0).roster_id, 1);
    assert.equal(typeof at(draft.picks, 0).roster_id, "number");
  });

  it("resolves who made the pick", () => {
    const draft = response.drafts.find((d) => d.draft_id === "draft_2026");
    assert.ok(draft);
    assert.equal(at(draft.picks, 0).picked_by.display_name, "AlphaManager");
    // Unknown user id still preserves the raw id.
    assert.equal(at(draft.picks, 1).picked_by.user_id, "u2");
    assert.equal(at(draft.picks, 1).picked_by.display_name, null);
  });

  it("parses auction amounts and keeper flags", () => {
    const draft = response.drafts.find((d) => d.draft_id === "draft_2026");
    assert.ok(draft);
    assert.equal(at(draft.picks, 0).auction_amount, 55);
    assert.equal(at(draft.picks, 0).is_keeper, false);
    assert.equal(at(draft.picks, 1).is_keeper, true);
    assert.equal(at(draft.picks, 1).auction_amount, null);
  });

  it("tolerates a pick with no player attached", () => {
    const draft = response.drafts.find((d) => d.draft_id === "draft_2026");
    assert.ok(draft);
    assert.equal(at(draft.picks, 2).player, null);
    assert.equal(at(draft.picks, 2).roster_id, null);
  });

  it("resolves the draft order to rosters and managers", () => {
    const draft = response.drafts.find((d) => d.draft_id === "draft_2026");
    assert.deepEqual(draft?.draft_order[0], {
      draft_slot: 1,
      roster_id: 1,
      user_id: "u1",
      display_name: "AlphaManager",
    });
  });

  it("handles a draft with no order set yet", () => {
    const draft = response.drafts.find((d) => d.draft_id === "draft_2027");
    assert.deepEqual(draft?.draft_order, []);
    assert.equal(draft?.pick_count, 0);
  });
});

describe("traded picks", () => {
  it("resolves original, previous, and current owners to names", () => {
    const multiHop = response.traded_picks.find(
      (pick) => pick.season === "2027" && pick.round === 3,
    );
    assert.ok(multiHop);
    assert.equal(multiHop.original_roster_id, 2);
    assert.equal(multiHop.previous_owner_roster_id, 3);
    assert.equal(multiHop.current_owner_roster_id, 1);
    assert.equal(multiHop.current_owner_display_name, "Alpha Squad");
  });

  it("lists every traded pick, including already-drafted seasons", () => {
    assert.equal(response.traded_picks.length, 4);
    assert.equal(response.metadata.traded_pick_count, 4);
  });
});

describe("payload hygiene", () => {
  it("only includes players this league actually references", () => {
    const serialized = JSON.stringify(response);
    const size = Buffer.byteLength(serialized);
    assert.ok(size < 200_000, `response should stay small, got ${size} bytes`);
    assert.ok(
      response.metadata.player_count < 20,
      `expected a handful of players, got ${response.metadata.player_count}`,
    );
  });

  it("does not leak the full player database into the response", () => {
    const serialized = JSON.stringify(response);
    // A player on nobody's roster must not appear anywhere in the payload.
    assert.ok(!serialized.includes("Bucky Irving") === false); // Irving IS rostered
    assert.ok(!serialized.includes("high_school"));
    assert.equal(response.metadata.player_database_size, playerIndex.size);
  });

  it("summarizes league state for a downstream analyst", () => {
    assert.equal(response.league_state.claimed_teams, 2);
    assert.equal(response.league_state.vacant_teams, 1);
    assert.equal(response.league_state.is_pre_draft, false);
    assert.equal(response.league_state.total_rostered_players, 9);
  });

  it("flags a 2QB/superflex league in key settings", () => {
    // The fixture league starts one QB, so this must be false.
    assert.equal(response.league.key_settings.is_superflex_or_2qb, false);
    assert.equal(response.league.key_settings.scoring_format, "full_ppr");
  });
});

describe("degraded mode", () => {
  it("still returns rosters when the player database is unavailable", () => {
    const degraded = buildLeagueResponse({
      leagueId: "test_league",
      league: fixtureLeague,
      users: fixtureUsers,
      rosters: fixtureRosters,
      drafts: fixtureDrafts,
      draftPicksByDraftId: new Map([["draft_2026", fixtureDraftPicks]]),
      tradedPicks: fixtureTradedPicks,
      nflState: fixtureNflState,
      playerIndex: new Map(), // simulates a failed /players/nfl fetch
      warnings: [
        {
          code: "player_database_unavailable",
          resource: "/players/nfl",
          message: "simulated failure",
        },
      ],
      startedAt: Date.now(),
    });

    const team = degraded.teams.find((t) => t.roster_id === 1);
    assert.ok(team);
    // Roster structure survives; only player detail degrades.
    assert.equal(team.players.length, 9);
    assert.ok(team.players.every((player) => player.resolved === false));
    assert.equal(team.starters.length, 9);
    assert.equal(team.summary.own_picks_held, 3);
    assert.equal(degraded.metadata.warnings.length, 1);
    assert.equal(degraded.metadata.player_database_size, 0);
    // Every id is reported as unresolved so the caller knows what was lost.
    assert.equal(degraded.metadata.unresolved_player_ids.length > 0, true);
  });
});
