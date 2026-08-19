/**
 * Analytics-layer tests: standings statistics, transaction normalization,
 * manager aggregation, weekly-stat scoring/ranking, and roster analysis
 * (position counts, age, FLEX/SUPER_FLEX slot coverage, auction spend).
 *
 * Player resolution uses the REAL Sleeper player database so results are
 * checked against live data, matching this project's existing test style.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { getPlayerIndex, type PlayerIndex } from "../lib/sleeper/client";
import { buildWeekMatchupFacts } from "../lib/analytics/matchups";
import {
  computeStandings,
  assignRegularSeasonFinish,
} from "../lib/analytics/standings";
import { normalizeTransaction } from "../lib/analytics/transactions";
import {
  buildAgeFacts,
  buildAuctionSpendFacts,
  buildRosterComposition,
  buildSlotCoverage,
} from "../lib/analytics/roster";
import { buildWeeklyPlayerFacts } from "../lib/analytics/weekly-stats";
import {
  traverseLeagueLineage,
  MAX_LINEAGE_DEPTH,
} from "../lib/analytics/lineage";
import type {
  RawBracketMatch,
  RawLeagueUser,
  RawMatchup,
  RawRoster,
  RawTransaction,
} from "../lib/sleeper/types";
import { PLAYER_IDS } from "./fixtures";

let playerIndex: PlayerIndex;
before(async () => {
  playerIndex = await getPlayerIndex();
});

/* -------------------------------------------------------------------------- */
/* Standings                                                                   */
/* -------------------------------------------------------------------------- */

function roster(
  id: number,
  wins: number,
  losses: number,
  fpts: number,
): RawRoster {
  return {
    roster_id: id,
    league_id: "l",
    owner_id: `u${id}`,
    co_owners: null,
    players: [],
    starters: [],
    reserve: [],
    taxi: [],
    keepers: [],
    settings: {
      wins,
      losses,
      ties: 0,
      fpts,
      fpts_decimal: 0,
      fpts_against: 0,
      fpts_against_decimal: 0,
    },
    metadata: null,
  };
}

const users: RawLeagueUser[] = [1, 2, 3].map((id) => ({
  user_id: `u${id}`,
  display_name: `Manager${id}`,
  avatar: null,
  is_owner: false,
  is_bot: false,
  league_id: "l",
  metadata: null,
  settings: null,
}));

function matchupRow(
  rosterId: number,
  matchupId: number,
  points: number,
): RawMatchup {
  return {
    roster_id: rosterId,
    matchup_id: matchupId,
    points,
    players: null,
    starters: null,
    players_points: null,
    starters_points: null,
    custom_points: null,
  };
}

describe("standings: win percentage and points", () => {
  it("computes win percentage including ties as half credit", () => {
    const rosters = [roster(1, 7, 3, 0), roster(2, 5, 5, 0)];
    const standings = computeStandings(rosters, users, new Map(), []);
    assert.equal(standings[0]?.win_percentage, 0.7);
    assert.equal(standings[1]?.win_percentage, 0.5);
  });

  it("returns null win_percentage and averages with zero games played", () => {
    const standings = computeStandings(
      [roster(1, 0, 0, 0)],
      users,
      new Map(),
      [],
    );
    assert.equal(standings[0]?.win_percentage, null);
    assert.equal(standings[0]?.average_points_for, null);
  });

  it("recombines Sleeper's split integer/decimal points fields", () => {
    const r: RawRoster = {
      ...roster(1, 3, 1, 0),
      settings: { wins: 3, losses: 1, ties: 0, fpts: 456, fpts_decimal: 78 },
    };
    const standings = computeStandings([r], users, new Map(), []);
    assert.equal(standings[0]?.points_for, 456.78);
    assert.equal(standings[0]?.average_points_for, 114.2); // 456.78 / 4, rounded
  });
});

describe("standings: weekly score statistics", () => {
  const matchupsByWeek = new Map<number, RawMatchup[]>([
    [1, [matchupRow(1, 1, 100), matchupRow(2, 1, 80)]],
    [2, [matchupRow(1, 2, 60), matchupRow(2, 2, 120)]],
    [3, [matchupRow(1, 3, 140), matchupRow(2, 3, 90)]],
  ]);

  it("computes highest, lowest, and median weekly scores", () => {
    const standings = computeStandings(
      [roster(1, 2, 1, 0), roster(2, 1, 2, 0)],
      users,
      matchupsByWeek,
      [],
    );
    const team1 = standings.find((s) => s.roster_id === 1);
    assert.equal(team1?.highest_weekly_score, 140);
    assert.equal(team1?.lowest_weekly_score, 60);
    assert.equal(team1?.median_weekly_score, 100); // [60, 100, 140] -> middle
  });

  it("computes population standard deviation of weekly scores", () => {
    // Scores [100, 60, 140]: mean 100, variance ((0)^2+(-40)^2+(40)^2)/3 = 1066.67, sqrt ≈ 32.66
    const standings = computeStandings(
      [roster(1, 2, 1, 0)],
      users,
      matchupsByWeek,
      [],
    );
    assert.equal(standings[0]?.standard_deviation_weekly_score, 32.66);
  });

  it("counts weekly high and low scores across the league", () => {
    const standings = computeStandings(
      [roster(1, 2, 1, 0), roster(2, 1, 2, 0)],
      users,
      matchupsByWeek,
      [],
    );
    const team1 = standings.find((s) => s.roster_id === 1);
    const team2 = standings.find((s) => s.roster_id === 2);
    // Week 1: team1 high; week 2: team2 high; week 3: team1 high.
    assert.equal(team1?.weekly_high_score_count, 2);
    assert.equal(team1?.weekly_low_score_count, 1);
    assert.equal(team2?.weekly_high_score_count, 1);
    assert.equal(team2?.weekly_low_score_count, 2);
  });

  it("returns null statistics when no weekly scores exist", () => {
    const standings = computeStandings(
      [roster(1, 0, 0, 0)],
      users,
      new Map(),
      [],
    );
    assert.equal(standings[0]?.highest_weekly_score, null);
    assert.equal(standings[0]?.standard_deviation_weekly_score, null);
  });
});

describe("standings: playoff results", () => {
  it("only identifies a champion when the bracket final has a winner", () => {
    const bracket: RawBracketMatch[] = [
      { m: 1, r: 1, w: null, l: null, t1: 1, t2: 2 },
      { m: 2, r: 2, w: null, l: null, t1: 1, t2: 2, p: 1 },
    ];
    const standings = computeStandings(
      [roster(1, 5, 5, 0), roster(2, 5, 5, 0)],
      users,
      new Map(),
      bracket,
    );
    assert.ok(!standings.some((s) => s.championship));
  });

  it("identifies champion and runner-up once the final is decided", () => {
    const bracket: RawBracketMatch[] = [
      { m: 1, r: 2, w: 2, l: 1, t1: 1, t2: 2, p: 1 },
    ];
    const standings = computeStandings(
      [roster(1, 5, 5, 0), roster(2, 5, 5, 0)],
      users,
      new Map(),
      bracket,
    );
    assert.equal(standings.find((s) => s.roster_id === 2)?.championship, true);
    assert.equal(standings.find((s) => s.roster_id === 1)?.runner_up, true);
    assert.equal(standings.find((s) => s.roster_id === 1)?.championship, false);
  });

  it("never infers a champion from regular-season record alone", () => {
    const standings = computeStandings(
      [roster(1, 10, 0, 0), roster(2, 0, 10, 0)],
      users,
      new Map(),
      [],
    );
    assert.ok(!standings.some((s) => s.championship || s.runner_up));
  });
});

describe("standings: regular-season finish", () => {
  it("ranks by wins then points_for", () => {
    const standings = assignRegularSeasonFinish(
      computeStandings(
        [roster(1, 5, 5, 900), roster(2, 7, 3, 800), roster(3, 7, 3, 850)],
        users,
        new Map(),
        [],
      ),
    );
    assert.equal(
      standings.find((s) => s.roster_id === 3)?.regular_season_finish,
      1,
    );
    assert.equal(
      standings.find((s) => s.roster_id === 2)?.regular_season_finish,
      2,
    );
    assert.equal(
      standings.find((s) => s.roster_id === 1)?.regular_season_finish,
      3,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Matchups                                                                    */
/* -------------------------------------------------------------------------- */

describe("matchups: pairing and results", () => {
  const rosters = [
    roster(1, 0, 0, 0),
    roster(2, 0, 0, 0),
    roster(3, 0, 0, 0),
    roster(4, 0, 0, 0),
  ];
  const usersById = new Map(users.map((u) => [u.user_id, u]));

  it("pairs two rows sharing a matchup_id into a win/loss", () => {
    const rows = [matchupRow(1, 1, 120), matchupRow(2, 1, 100)];
    const facts = buildWeekMatchupFacts("2026", 1, rows, rosters, usersById);
    const team1 = facts.find((f) => f.team.roster_id === 1);
    const team2 = facts.find((f) => f.team.roster_id === 2);
    assert.equal(team1?.result, "win");
    assert.equal(team1?.margin, 20);
    assert.equal(team2?.result, "loss");
    assert.equal(team2?.margin, -20);
    assert.equal(team1?.opponent?.roster_id, 2);
  });

  it("reports a tie when points are equal", () => {
    const rows = [matchupRow(1, 1, 100), matchupRow(2, 1, 100)];
    const facts = buildWeekMatchupFacts("2026", 1, rows, rosters, usersById);
    assert.equal(facts[0]?.result, "tie");
    assert.equal(facts[0]?.margin, 0);
  });

  it("computes weekly score rank with tie-sharing", () => {
    const rows = [
      matchupRow(1, 1, 150),
      matchupRow(2, 1, 100),
      matchupRow(3, 2, 100),
      matchupRow(4, 2, 90),
    ];
    const facts = buildWeekMatchupFacts("2026", 1, rows, rosters, usersById);
    assert.equal(
      facts.find((f) => f.team.roster_id === 1)?.weekly_score_rank,
      "1 of 4",
    );
    // Both scored 100, so they share rank 2.
    assert.equal(
      facts.find((f) => f.team.roster_id === 2)?.weekly_score_rank,
      "2 of 4",
    );
    assert.equal(
      facts.find((f) => f.team.roster_id === 3)?.weekly_score_rank,
      "2 of 4",
    );
    assert.equal(
      facts.find((f) => f.team.roster_id === 4)?.weekly_score_rank,
      "4 of 4",
    );
  });

  it("handles an unpaired row (odd group) without an opponent", () => {
    const rows = [matchupRow(1, 1, 100)];
    const facts = buildWeekMatchupFacts("2026", 1, rows, rosters, usersById);
    assert.equal(facts[0]?.opponent, null);
    assert.equal(facts[0]?.result, null);
  });
});

/* -------------------------------------------------------------------------- */
/* Transactions                                                                */
/* -------------------------------------------------------------------------- */

describe("transaction normalization", () => {
  const rostersById = new Map<number, RawRoster>([
    [1, roster(1, 0, 0, 0)],
    [6, roster(6, 0, 0, 0)],
  ]);
  const usersById = new Map(users.map((u) => [u.user_id, u]));

  it("normalizes a waiver claim with adds/drops and FAAB bid", () => {
    const tx: RawTransaction = {
      transaction_id: "t1",
      type: "waiver",
      status: "complete",
      status_updated: null,
      created: 1_700_000_000_000,
      leg: 4,
      roster_ids: [1],
      adds: { [PLAYER_IDS.jefferson]: 1 },
      drops: { [PLAYER_IDS.prescott]: 1 },
      draft_picks: null,
      waiver_budget: null,
      settings: { waiver_bid: 17 },
      consenter_ids: null,
    };
    const fact = normalizeTransaction(
      tx,
      "2026",
      playerIndex,
      rostersById,
      usersById,
    );
    assert.equal(fact.type, "waiver");
    assert.equal(fact.adds[0]?.player.full_name, "Justin Jefferson");
    assert.equal(fact.drops[0]?.player.full_name, "Dak Prescott");
    assert.equal(fact.faab.spent, 17);
    assert.equal(fact.sides, null);
  });

  it("normalizes a free-agent pickup with no FAAB", () => {
    const tx: RawTransaction = {
      transaction_id: "t2",
      type: "free_agent",
      status: "complete",
      status_updated: null,
      created: null,
      leg: 2,
      roster_ids: [1],
      adds: { [PLAYER_IDS.irving]: 1 },
      drops: null,
      draft_picks: null,
      waiver_budget: null,
      settings: null,
      consenter_ids: null,
    };
    const fact = normalizeTransaction(
      tx,
      "2026",
      playerIndex,
      rostersById,
      usersById,
    );
    assert.equal(fact.faab.spent, null); // no waiver_bid present, not fabricated as 0
    assert.deepEqual(fact.drops, []);
  });

  it("reports a drop with no corresponding add", () => {
    const tx: RawTransaction = {
      transaction_id: "t3",
      type: "waiver",
      status: "complete",
      status_updated: null,
      created: null,
      leg: 2,
      roster_ids: [1],
      adds: null,
      drops: { [PLAYER_IDS.loveland]: 1 },
      draft_picks: null,
      waiver_budget: null,
      settings: null,
      consenter_ids: null,
    };
    const fact = normalizeTransaction(
      tx,
      "2026",
      playerIndex,
      rostersById,
      usersById,
    );
    assert.deepEqual(fact.adds, []);
    assert.equal(fact.drops[0]?.player.full_name, "Colston Loveland");
  });

  it("normalizes a trade with each side's players, picks, and FAAB", () => {
    const tx: RawTransaction = {
      transaction_id: "t4",
      type: "trade",
      status: "complete",
      status_updated: null,
      created: null,
      leg: 6,
      roster_ids: [1, 6],
      adds: { [PLAYER_IDS.mahomes]: 6, [PLAYER_IDS.mccaffrey]: 1 },
      drops: null,
      draft_picks: [
        {
          season: "2027",
          round: 1,
          roster_id: 1,
          previous_owner_id: 1,
          owner_id: 6,
        },
      ],
      waiver_budget: [{ sender: 1, receiver: 6, amount: 15 }],
      settings: null,
      consenter_ids: [1, 6],
    };
    const fact = normalizeTransaction(
      tx,
      "2026",
      playerIndex,
      rostersById,
      usersById,
    );
    assert.ok(fact.sides);
    const side1 = fact.sides?.find((s) => s.roster_id === 1);
    const side6 = fact.sides?.find((s) => s.roster_id === 6);
    assert.equal(side1?.received_players[0]?.full_name, "Christian McCaffrey");
    assert.equal(side6?.received_players[0]?.full_name, "Patrick Mahomes");
    assert.equal(side6?.received_picks[0]?.original_roster_id, 1);
    assert.equal(side6?.received_faab, 15);
    assert.equal(side1?.received_faab, 0);
  });

  it("does not evaluate the trade — no value or fairness field is produced", () => {
    const tx: RawTransaction = {
      transaction_id: "t5",
      type: "trade",
      status: "complete",
      status_updated: null,
      created: null,
      leg: 1,
      roster_ids: [1, 6],
      adds: { [PLAYER_IDS.mahomes]: 6 },
      drops: null,
      draft_picks: null,
      waiver_budget: null,
      settings: null,
      consenter_ids: [1, 6],
    };
    const fact = normalizeTransaction(
      tx,
      "2026",
      playerIndex,
      rostersById,
      usersById,
    );
    const serialized = JSON.stringify(fact);
    for (const forbidden of [
      "grade",
      "winner",
      "fair",
      "value_differential",
      "skill",
    ]) {
      assert.ok(
        !serialized.toLowerCase().includes(forbidden),
        `found forbidden field: ${forbidden}`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Roster analysis                                                             */
/* -------------------------------------------------------------------------- */

const ROSTER_POSITIONS = [
  "QB",
  "QB",
  "RB",
  "RB",
  "WR",
  "WR",
  "TE",
  "FLEX",
  "FLEX",
  "K",
  "DEF",
  "BN",
  "BN",
  "BN",
  "BN",
  "BN",
];

describe("roster analysis: composition and age", () => {
  // playerIndex is only populated once the top-level before() hook runs, which
  // happens after describe() bodies are evaluated — so this must be a function,
  // not a describe-scope const, or every test here sees undefined players.
  const roster1 = () => [
    playerIndex.get(PLAYER_IDS.mahomes)!,
    playerIndex.get(PLAYER_IDS.mccaffrey)!,
    playerIndex.get(PLAYER_IDS.jefferson)!,
  ];

  it("counts players by position and by team", () => {
    const players = roster1();
    const composition = buildRosterComposition(
      players,
      players,
      [],
      [],
      [],
      16,
    );
    assert.equal(composition.player_count, 3);
    assert.equal(composition.players_by_position.QB, 1);
    assert.equal(composition.players_by_position.RB, 1);
    assert.equal(composition.open_roster_slots, 13);
  });

  it("computes average and median age", () => {
    const players = roster1();
    const ages = players
      .map((p) => p.age)
      .filter((a): a is number => typeof a === "number");
    const facts = buildAgeFacts(players);
    const expectedAvg =
      Math.round((ages.reduce((s, a) => s + a, 0) / ages.length) * 100) / 100;
    assert.equal(facts.average_age, expectedAvg);
    assert.ok(facts.median_age !== null);
  });

  it("returns null age facts for an empty roster rather than zero", () => {
    const facts = buildAgeFacts([]);
    assert.equal(facts.average_age, null);
    assert.equal(facts.median_age, null);
  });
});

describe("roster analysis: slot coverage (FLEX/SUPER_FLEX)", () => {
  it("does not report WR as needed merely because FLEX is open", () => {
    const roster = [
      playerIndex.get(PLAYER_IDS.mahomes)!,
      playerIndex.get(PLAYER_IDS.prescott)!,
      playerIndex.get(PLAYER_IDS.mccaffrey)!,
      playerIndex.get(PLAYER_IDS.irving)!,
      playerIndex.get(PLAYER_IDS.jefferson)!,
      playerIndex.get(PLAYER_IDS.lamb)!,
      playerIndex.get(PLAYER_IDS.loveland)!,
    ];
    const coverage = buildSlotCoverage(roster, ROSTER_POSITIONS);
    const positions = coverage.strict_slots_filled.map((s) => s.position);
    assert.ok(!positions.includes("WR"));
    assert.ok(!positions.includes("RB"));
    assert.ok(!positions.includes("QB"));
    assert.deepEqual(positions.sort(), ["DEF", "K"]);
    assert.equal(coverage.flexible_slots_remaining, 2);
  });

  it("treats SUPER_FLEX as accepting any offensive skill position", () => {
    const superflexPositions = ["QB", "RB", "WR", "SUPER_FLEX", "BN"];
    const roster = [
      playerIndex.get(PLAYER_IDS.mahomes)!,
      playerIndex.get(PLAYER_IDS.prescott)!,
    ];
    const coverage = buildSlotCoverage(roster, superflexPositions);
    assert.equal(coverage.flexible_slots_remaining, 0); // second QB covers SUPER_FLEX
  });

  it("reports required_slots from the league's actual roster_positions", () => {
    const coverage = buildSlotCoverage([], ROSTER_POSITIONS);
    assert.deepEqual(coverage.required_slots, {
      QB: 2,
      RB: 2,
      WR: 2,
      TE: 1,
      K: 1,
      DEF: 1,
    });
    assert.equal(coverage.flex_slot_count, 2);
  });
});

describe("roster analysis: auction spend", () => {
  it("sums acquisition prices and computes average cost", () => {
    const acquisitions = [
      { player: playerIndex.get(PLAYER_IDS.mahomes)!, price: 42 },
      { player: playerIndex.get(PLAYER_IDS.mccaffrey)!, price: 58 },
    ];
    const facts = buildAuctionSpendFacts(acquisitions, 200);
    assert.equal(facts.total_spend, 100);
    assert.equal(facts.average_acquisition_cost, 50);
    assert.equal(facts.remaining_budget, 100);
    assert.equal(facts.spend_by_position.QB, 42);
    assert.equal(facts.spend_by_position.RB, 58);
  });

  it("returns null spend facts (not zero) when no prices are known", () => {
    const facts = buildAuctionSpendFacts(
      [{ player: playerIndex.get(PLAYER_IDS.mahomes)!, price: null }],
      200,
    );
    assert.equal(facts.total_spend, null);
    assert.equal(facts.average_acquisition_cost, null);
    assert.equal(facts.remaining_budget, 200);
  });
});

/* -------------------------------------------------------------------------- */
/* Weekly stats                                                                */
/* -------------------------------------------------------------------------- */

describe("weekly stats: scoring and ranking", () => {
  const scoringSettings = {
    pass_yd: 0.04,
    pass_td: 4,
    rush_yd: 0.1,
    rush_td: 6,
    rec: 0.5,
    rec_yd: 0.1,
  };

  it("scores a raw stat line through the Bloodline Bowl scoring engine", () => {
    const { facts } = buildWeeklyPlayerFacts(
      [
        {
          player_id: PLAYER_IDS.mahomes,
          season: "2026",
          week: 1,
          stats: { pass_yd: 300, pass_td: 3 },
        },
      ],
      scoringSettings,
      playerIndex,
    );
    // 300*0.04 + 3*4 = 12 + 12 = 24
    assert.equal(facts[0]?.bloodline_points.total, 24);
    assert.equal(facts[0]?.player.full_name, "Patrick Mahomes");
  });

  it("ranks players overall and within position, with tie-sharing", () => {
    const { facts, methodology } = buildWeeklyPlayerFacts(
      [
        {
          player_id: PLAYER_IDS.mahomes,
          season: "2026",
          week: 1,
          stats: { pass_yd: 300, pass_td: 3 },
        }, // 24
        {
          player_id: PLAYER_IDS.prescott,
          season: "2026",
          week: 1,
          stats: { pass_yd: 300, pass_td: 3 },
        }, // 24, tied
        {
          player_id: PLAYER_IDS.mccaffrey,
          season: "2026",
          week: 1,
          stats: { rush_yd: 100, rush_td: 1 },
        }, // 16
      ],
      scoringSettings,
      playerIndex,
    );
    assert.equal(methodology.pool_size, 3);
    const mahomes = facts.find(
      (f) => f.player.player_id === PLAYER_IDS.mahomes,
    );
    const prescott = facts.find(
      (f) => f.player.player_id === PLAYER_IDS.prescott,
    );
    const mccaffrey = facts.find(
      (f) => f.player.player_id === PLAYER_IDS.mccaffrey,
    );
    assert.equal(mahomes?.overall_weekly_rank, "1 of 3");
    assert.equal(prescott?.overall_weekly_rank, "1 of 3"); // tied for 1st
    assert.equal(mccaffrey?.overall_weekly_rank, "3 of 3");
    assert.equal(mahomes?.position_weekly_rank, "1 of 2"); // 2 QBs in the pool
    assert.equal(mccaffrey?.position_weekly_rank, "1 of 1");
  });

  it("does not accept a provider's precomputed points as the source of truth", () => {
    // Feeding an unsupported key like a provider's own pts_ppr must not crash
    // or silently contribute — only recognized scoring-settings keys count.
    const { facts } = buildWeeklyPlayerFacts(
      [
        {
          player_id: PLAYER_IDS.jefferson,
          season: "2026",
          week: 1,
          stats: { rec: 8, rec_yd: 100, pts_ppr: 999 },
        },
      ],
      scoringSettings,
      playerIndex,
    );
    // 8*0.5 + 100*0.1 = 4 + 10 = 14, NOT 999
    assert.equal(facts[0]?.bloodline_points.total, 14);
  });
});

/* -------------------------------------------------------------------------- */
/* League lineage                                                              */
/* -------------------------------------------------------------------------- */

describe("league lineage traversal", () => {
  it("has a bounded maximum depth", () => {
    assert.ok(MAX_LINEAGE_DEPTH > 0 && MAX_LINEAGE_DEPTH < 100);
  });

  it("stops on a nonexistent league without throwing", async () => {
    const result = await traverseLeagueLineage("1");
    assert.equal(result.seasons.length, 0);
    assert.ok(result.warnings.length > 0);
  });
});
