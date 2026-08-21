/**
 * Deterministic unit tests for historical weekly player scoring and lineup
 * construction, using synthetic fixtures (not live network calls — see
 * `historical-data-live.test.ts` for the real Devoted to the Game 2025
 * validation, including the required trade-ownership check).
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { getPlayerIndex, type PlayerIndex } from "../lib/sleeper/client";
import {
  buildPlayerWeeklyRows,
  hashScoringSettings,
} from "../lib/analytics/historical-scoring";
import { buildLineupRows } from "../lib/analytics/historical-lineups";
import {
  reconcileWeek,
  summarizeReconciliation,
} from "../lib/analytics/reconciliation";
import type {
  RawLeagueUser,
  RawMatchup,
  RawRoster,
} from "../lib/sleeper/types";
import { PLAYER_IDS } from "./fixtures";

let playerIndex: PlayerIndex;
before(async () => {
  playerIndex = await getPlayerIndex();
});

/** Devoted to the Game's real 2025 lineup shape: 1QB/2RB/2WR/1TE/3FLEX/1K/1DEF/5BN. */
const ROSTER_POSITIONS = [
  "QB",
  "RB",
  "RB",
  "WR",
  "WR",
  "TE",
  "FLEX",
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

const FULL_PPR_SETTINGS: Record<string, number> = {
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -2,
  rush_yd: 0.1,
  rush_td: 6,
  rec: 1, // full PPR
  rec_yd: 0.1,
  rec_td: 6,
  fum_lost: -2,
  fgm_0_19: 3,
  fgm_20_29: 3,
  fgm_30_39: 3,
  fgm_40_49: 4,
  fgm_50_59: 5,
  fgmiss: -1,
  xpm: 1,
  xpmiss: -1,
  sack: 1,
  int: 2,
  fum_rec: 2,
  ff: 1,
  def_td: 6,
  safe: 2,
  pts_allow_0: 10,
  pts_allow_1_6: 7,
  pts_allow_7_13: 4,
  pts_allow_14_20: 1,
  pts_allow_21_27: 0,
  pts_allow_28_34: -1,
  pts_allow_35p: -4,
};

function matchupRow(overrides: Partial<RawMatchup>): RawMatchup {
  return {
    roster_id: 1,
    matchup_id: 1,
    points: 0,
    players: [],
    starters: [],
    players_points: {},
    starters_points: null,
    custom_points: null,
    ...overrides,
  };
}

describe("historical scoring: player-weekly rows", () => {
  it("uses Sleeper's authoritative matchup points for rostered players", () => {
    const matchups = [
      matchupRow({
        roster_id: 1,
        players: [PLAYER_IDS.mahomes],
        starters: [PLAYER_IDS.mahomes],
        players_points: { [PLAYER_IDS.mahomes]: 24.5 },
      }),
    ];
    const { rows } = buildPlayerWeeklyRows({
      leagueSelector: "devoted-to-the-game",
      leagueId: "1264616401079914496",
      season: "2025",
      week: 1,
      matchups,
      statLines: null,
      scoringSettings: FULL_PPR_SETTINGS,
      playerIndex,
      generatedAt: "2026-01-01T00:00:00.000Z",
      rosterPositions: ROSTER_POSITIONS,
    });

    const row = rows.find((r) => r.player_id === PLAYER_IDS.mahomes);
    assert.ok(row);
    assert.equal(row.fantasy_points, 24.5);
    assert.equal(row.scoring_source, "sleeper_matchup_points");
    assert.equal(row.scoring_method, "sleeper_authoritative");
    assert.equal(row.full_name, "Patrick Mahomes");
    assert.equal(row.game_played, true);
  });

  it("does not fabricate scoring for a bye-week rostered player — reports 0, game_played false", () => {
    const matchups = [
      matchupRow({
        roster_id: 1,
        players: [PLAYER_IDS.mahomes],
        starters: [],
        players_points: {}, // no entry: bye/inactive that week
      }),
    ];
    const { rows } = buildPlayerWeeklyRows({
      leagueSelector: "devoted-to-the-game",
      leagueId: "1264616401079914496",
      season: "2025",
      week: 5,
      matchups,
      statLines: null,
      scoringSettings: FULL_PPR_SETTINGS,
      playerIndex,
      generatedAt: "2026-01-01T00:00:00.000Z",
      rosterPositions: ROSTER_POSITIONS,
    });
    const row = rows.find((r) => r.player_id === PLAYER_IDS.mahomes);
    assert.equal(row?.fantasy_points, 0);
    assert.equal(row?.game_played, false);
  });

  it("scores an unrostered (free agent) player locally from raw stats using full-PPR", () => {
    const matchups = [matchupRow({ roster_id: 1, players: [], starters: [] })];
    const { rows } = buildPlayerWeeklyRows({
      leagueSelector: "devoted-to-the-game",
      leagueId: "1264616401079914496",
      season: "2025",
      week: 1,
      matchups,
      statLines: [
        {
          player_id: PLAYER_IDS.jefferson,
          season: "2025",
          week: 1,
          stats: { rec: 8, rec_yd: 100 },
        },
      ],
      scoringSettings: FULL_PPR_SETTINGS,
      playerIndex,
      generatedAt: "2026-01-01T00:00:00.000Z",
      rosterPositions: ROSTER_POSITIONS,
    });
    const row = rows.find((r) => r.player_id === PLAYER_IDS.jefferson);
    // 8 receptions * 1 (full PPR) + 100 yd * 0.1 = 18
    assert.equal(row?.fantasy_points, 18);
    assert.equal(row?.scoring_source, "bridge_calculated_from_raw_stats");
    assert.equal(row?.scoring_method, "local_scoring_engine");
  });

  it("applies custom field-goal-distance scoring for kickers", () => {
    const matchups = [matchupRow({ roster_id: 1, players: [], starters: [] })];
    const { rows } = buildPlayerWeeklyRows({
      leagueSelector: "devoted-to-the-game",
      leagueId: "1264616401079914496",
      season: "2025",
      week: 1,
      matchups,
      statLines: [
        {
          // A real, resolvable Sleeper kicker id — an unresolved identity has
          // no known position, so it is correctly excluded from the
          // free-agent pool by the draftable-position filter (see the
          // "marks an unrecognized player id as unresolved" test below for
          // that exclusion behavior itself).
          player_id: "12185",
          season: "2025",
          week: 1,
          // One 45-49yd make (4pts), one 55yd make (5pts), one miss (-1), 2 XP (2pts).
          stats: { fgm_40_49: 1, fgm_50_59: 1, fgmiss: 1, xpm: 2 },
        },
      ],
      scoringSettings: FULL_PPR_SETTINGS,
      playerIndex,
      generatedAt: "2026-01-01T00:00:00.000Z",
      rosterPositions: ROSTER_POSITIONS,
    });
    const row = rows.find((r) => r.player_id === "12185");
    // 4 + 5 - 1 + 2*1 = 10
    assert.equal(row?.fantasy_points, 10);
  });

  it("applies points-allowed band scoring for team defenses", () => {
    const matchups = [matchupRow({ roster_id: 1, players: [], starters: [] })];
    const { rows } = buildPlayerWeeklyRows({
      leagueSelector: "devoted-to-the-game",
      leagueId: "1264616401079914496",
      season: "2025",
      week: 1,
      matchups,
      statLines: [
        {
          player_id: "SF",
          season: "2025",
          week: 1,
          stats: { pts_allow_1_6: 1, sack: 3, int: 1, ff: 1 },
        },
      ],
      scoringSettings: FULL_PPR_SETTINGS,
      playerIndex,
      generatedAt: "2026-01-01T00:00:00.000Z",
      rosterPositions: ROSTER_POSITIONS,
    });
    const row = rows.find((r) => r.player_id === "SF");
    // 7 (points allowed 1-6) + 3*1 (sacks) + 1*2 (int) + 1*1 (ff) = 13
    assert.equal(row?.fantasy_points, 13);
    assert.equal(row?.position, "DEF");
  });

  it("handles fractional yardage without floating-point drift", () => {
    const matchups = [matchupRow({ roster_id: 1, players: [], starters: [] })];
    const { rows } = buildPlayerWeeklyRows({
      leagueSelector: "devoted-to-the-game",
      leagueId: "1264616401079914496",
      season: "2025",
      week: 1,
      matchups,
      statLines: [
        // A real, resolvable RB id (Derrick Henry) — see the kicker test above.
        { player_id: "3198", season: "2025", week: 1, stats: { rush_yd: 33 } },
      ],
      scoringSettings: FULL_PPR_SETTINGS,
      playerIndex,
      generatedAt: "2026-01-01T00:00:00.000Z",
      rosterPositions: ROSTER_POSITIONS,
    });
    const row = rows.find((r) => r.player_id === "3198");
    assert.equal(row?.fantasy_points, 3.3); // not 3.3000000000000003
  });

  it("marks an unrecognized player id as unresolved rather than dropping it", () => {
    const matchups = [
      matchupRow({
        roster_id: 1,
        players: ["totally_fake_id_999"],
        starters: [],
        players_points: { totally_fake_id_999: 5 },
      }),
    ];
    const { rows, unresolvedPlayerIds } = buildPlayerWeeklyRows({
      leagueSelector: "devoted-to-the-game",
      leagueId: "1264616401079914496",
      season: "2025",
      week: 1,
      matchups,
      statLines: null,
      scoringSettings: FULL_PPR_SETTINGS,
      playerIndex,
      generatedAt: "2026-01-01T00:00:00.000Z",
      rosterPositions: ROSTER_POSITIONS,
    });
    const row = rows.find((r) => r.player_id === "totally_fake_id_999");
    assert.equal(row?.resolved, false);
    assert.ok(unresolvedPlayerIds.includes("totally_fake_id_999"));
  });

  it("produces deterministic output for identical input", () => {
    const matchups = [
      matchupRow({
        roster_id: 1,
        players: [PLAYER_IDS.mahomes, PLAYER_IDS.mccaffrey],
        starters: [PLAYER_IDS.mahomes],
        players_points: {
          [PLAYER_IDS.mahomes]: 20,
          [PLAYER_IDS.mccaffrey]: 15,
        },
      }),
    ];
    const build = () =>
      buildPlayerWeeklyRows({
        leagueSelector: "devoted-to-the-game",
        leagueId: "1264616401079914496",
        season: "2025",
        week: 1,
        matchups,
        statLines: null,
        scoringSettings: FULL_PPR_SETTINGS,
        playerIndex,
        generatedAt: "2026-01-01T00:00:00.000Z",
        rosterPositions: ROSTER_POSITIONS,
      });
    assert.deepEqual(build().rows, build().rows);
  });
});

describe("hashScoringSettings", () => {
  it("is stable for the same settings regardless of key order", () => {
    const a = hashScoringSettings({ rec: 1, pass_td: 4 });
    const b = hashScoringSettings({ pass_td: 4, rec: 1 });
    assert.equal(a, b);
  });

  it("differs when a setting value differs", () => {
    const halfPpr = hashScoringSettings({ rec: 0.5 });
    const fullPpr = hashScoringSettings({ rec: 1 });
    assert.notEqual(halfPpr, fullPpr);
  });
});

describe("historical lineups: buildLineupRows", () => {
  const users: RawLeagueUser[] = [
    {
      user_id: "u1",
      display_name: "AlphaManager",
      avatar: null,
      is_owner: true,
      is_bot: false,
      league_id: "l",
      metadata: { team_name: "Alpha Squad" },
      settings: null,
    },
  ];
  const rosters: RawRoster[] = [
    {
      roster_id: 1,
      league_id: "l",
      owner_id: "u1",
      co_owners: null,
      players: null,
      starters: null,
      reserve: null,
      taxi: null,
      keepers: null,
      settings: null,
      metadata: null,
    },
  ];

  it("labels a starter with its true positional slot, not a fabricated FLEX1/FLEX2", () => {
    const matchups = [
      matchupRow({
        roster_id: 1,
        matchup_id: 9,
        // 11 starters for the 11 non-bench slots: QB RB RB WR WR TE FLEX FLEX FLEX K DEF.
        players: [
          PLAYER_IDS.mahomes,
          PLAYER_IDS.mccaffrey,
          PLAYER_IDS.irving,
          PLAYER_IDS.jefferson,
          PLAYER_IDS.lamb,
          PLAYER_IDS.loveland,
          PLAYER_IDS.prescott,
          "flex2filler",
          "flex3filler",
          "k1",
          "DEN",
        ],
        starters: [
          PLAYER_IDS.mahomes,
          PLAYER_IDS.mccaffrey,
          PLAYER_IDS.irving,
          PLAYER_IDS.jefferson,
          PLAYER_IDS.lamb,
          PLAYER_IDS.loveland,
          PLAYER_IDS.prescott,
          "flex2filler",
          "flex3filler",
          "k1",
          "DEN",
        ],
      }),
    ];
    const { rows } = buildLineupRows({
      leagueSelector: "devoted-to-the-game",
      leagueId: "1264616401079914496",
      season: "2025",
      week: 1,
      matchups,
      rosters,
      users,
      rosterPositions: ROSTER_POSITIONS,
      playerIndex,
    });
    // Slot order: QB RB RB WR WR TE FLEX FLEX FLEX K DEF
    assert.equal(
      rows.find((r) => r.player_id === PLAYER_IDS.mahomes)?.roster_slot,
      "QB",
    );
    assert.equal(
      rows.find((r) => r.player_id === PLAYER_IDS.lamb)?.roster_slot,
      "WR",
    );
    // 7th starter (index 6) is the first FLEX slot.
    assert.equal(
      rows.find((r) => r.player_id === PLAYER_IDS.prescott)?.roster_slot,
      "FLEX",
    );
    assert.equal(rows.find((r) => r.player_id === "k1")?.roster_slot, "K");
    assert.equal(rows.find((r) => r.player_id === "DEN")?.roster_slot, "DEF");
  });

  it('falls back to "STARTER_UNKNOWN" rather than fabricating a slot beyond the known lineup', () => {
    // 12 starters supplied, but the roster only defines 11 non-bench slots.
    const matchups = [
      matchupRow({
        roster_id: 1,
        players: Array.from({ length: 12 }, (_, i) => `p${i}`),
        starters: Array.from({ length: 12 }, (_, i) => `p${i}`),
      }),
    ];
    const { rows } = buildLineupRows({
      leagueSelector: "devoted-to-the-game",
      leagueId: "1264616401079914496",
      season: "2025",
      week: 1,
      matchups,
      rosters,
      users,
      rosterPositions: ROSTER_POSITIONS,
      playerIndex,
    });
    assert.equal(
      rows.find((r) => r.player_id === "p11")?.roster_slot,
      "STARTER_UNKNOWN",
    );
  });

  it("distinguishes starter from bench", () => {
    const matchups = [
      matchupRow({
        roster_id: 1,
        players: [PLAYER_IDS.mahomes, PLAYER_IDS.prescott],
        starters: [PLAYER_IDS.mahomes],
      }),
    ];
    const { rows } = buildLineupRows({
      leagueSelector: "devoted-to-the-game",
      leagueId: "1264616401079914496",
      season: "2025",
      week: 1,
      matchups,
      rosters,
      users,
      rosterPositions: ROSTER_POSITIONS,
      playerIndex,
    });
    assert.equal(
      rows.find((r) => r.player_id === PLAYER_IDS.mahomes)?.ownership_status,
      "starter",
    );
    assert.equal(
      rows.find((r) => r.player_id === PLAYER_IDS.prescott)?.ownership_status,
      "bench",
    );
    assert.equal(
      rows.find((r) => r.player_id === PLAYER_IDS.prescott)?.bench,
      true,
    );
  });

  it("does not report IR status — Sleeper's historical matchup snapshot doesn't expose it", () => {
    const matchups = [
      matchupRow({ roster_id: 1, players: [PLAYER_IDS.mahomes], starters: [] }),
    ];
    const { rows } = buildLineupRows({
      leagueSelector: "devoted-to-the-game",
      leagueId: "1264616401079914496",
      season: "2025",
      week: 1,
      matchups,
      rosters,
      users,
      rosterPositions: ROSTER_POSITIONS,
      playerIndex,
    });
    assert.equal(rows[0]?.ir, null);
  });

  it("handles a malformed player id without throwing, marking it unresolved", () => {
    const matchups = [
      matchupRow({
        roster_id: 1,
        players: ["<bad&id>"],
        starters: ["<bad&id>"],
      }),
    ];
    assert.doesNotThrow(() => {
      const { rows, unresolvedPlayerIds } = buildLineupRows({
        leagueSelector: "devoted-to-the-game",
        leagueId: "1264616401079914496",
        season: "2025",
        week: 1,
        matchups,
        rosters,
        users,
        rosterPositions: ROSTER_POSITIONS,
        playerIndex,
      });
      assert.equal(rows[0]?.resolved, false);
      assert.ok(unresolvedPlayerIds.includes("<bad&id>"));
    });
  });

  it("resolves manager identity from the roster's owner_id", () => {
    const matchups = [
      matchupRow({ roster_id: 1, players: [PLAYER_IDS.mahomes], starters: [] }),
    ];
    const { rows } = buildLineupRows({
      leagueSelector: "devoted-to-the-game",
      leagueId: "1264616401079914496",
      season: "2025",
      week: 1,
      matchups,
      rosters,
      users,
      rosterPositions: ROSTER_POSITIONS,
      playerIndex,
    });
    assert.equal(rows[0]?.user_id, "u1");
    assert.equal(rows[0]?.manager_display_name, "AlphaManager");
    assert.equal(rows[0]?.team_name, "Alpha Squad");
  });

  it("produces deterministic output for identical input", () => {
    const matchups = [
      matchupRow({
        roster_id: 1,
        players: [PLAYER_IDS.mahomes, PLAYER_IDS.prescott],
        starters: [PLAYER_IDS.mahomes],
      }),
    ];
    const build = () =>
      buildLineupRows({
        leagueSelector: "devoted-to-the-game",
        leagueId: "1264616401079914496",
        season: "2025",
        week: 1,
        matchups,
        rosters,
        users,
        rosterPositions: ROSTER_POSITIONS,
        playerIndex,
      });
    assert.deepEqual(build().rows, build().rows);
  });
});

describe("reconciliation", () => {
  it("reconciles when summed starter points equal the matchup total", () => {
    const matchups = [
      matchupRow({
        roster_id: 1,
        points: 30,
        starters: [PLAYER_IDS.mahomes, PLAYER_IDS.mccaffrey],
      }),
    ];
    const rows = [
      { player_id: PLAYER_IDS.mahomes, fantasy_points: 20 },
      { player_id: PLAYER_IDS.mccaffrey, fantasy_points: 10 },
    ] as never[];
    const results = reconcileWeek(1, matchups, rows as never);
    assert.equal(results[0]?.within_tolerance, true);
    assert.equal(results[0]?.difference, 0);
    assert.equal(summarizeReconciliation(results).status, "reconciled");
  });

  it("flags a discrepancy beyond tolerance", () => {
    const matchups = [
      matchupRow({ roster_id: 1, points: 30, starters: [PLAYER_IDS.mahomes] }),
    ];
    const rows = [
      { player_id: PLAYER_IDS.mahomes, fantasy_points: 20 },
    ] as never[];
    const results = reconcileWeek(1, matchups, rows as never);
    assert.equal(results[0]?.within_tolerance, false);
    assert.equal(
      summarizeReconciliation(results).status,
      "discrepancies_found",
    );
  });

  it("reports no_data when there is nothing to reconcile", () => {
    assert.equal(summarizeReconciliation([]).status, "no_data");
  });
});
