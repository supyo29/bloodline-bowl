/**
 * Synthetic league fixtures used to exercise normalization paths that the real
 * Bloodline Bowl league cannot yet reach (it is pre-draft and empty).
 *
 * Player ids are REAL Sleeper ids, so tests resolve them against the live
 * player database rather than a hand-written stub.
 */

import type {
  RawDraft,
  RawDraftPick,
  RawLeague,
  RawLeagueUser,
  RawNflState,
  RawRoster,
  RawTradedPick,
} from "../lib/sleeper/types";

export const PLAYER_IDS = {
  mahomes: "4046", // QB, KC
  mccaffrey: "4034", // RB, SF
  irving: "11584", // RB, TB
  jefferson: "6794", // WR, MIN
  lamb: "6786", // WR, DAL
  loveland: "12517", // TE, CHI
  prescott: "3294", // QB, DAL
  texansDefense: "HOU", // DEF — no first/last name in Sleeper
  unknown: "99999999", // deliberately absent from Sleeper's database
} as const;

export const fixtureLeague: RawLeague = {
  league_id: "test_league",
  name: "Fixture League",
  status: "in_season",
  season: "2027",
  season_type: "regular",
  sport: "nfl",
  total_rosters: 3,
  roster_positions: [
    "QB",
    "RB",
    "RB",
    "WR",
    "WR",
    "TE",
    "FLEX",
    "K",
    "DEF",
    "BN",
    "BN",
    "IR",
  ],
  scoring_settings: { rec: 1, pass_td: 6 },
  settings: { draft_rounds: 4, num_teams: 3, waiver_type: 2, pick_trading: 1 },
  metadata: null,
  avatar: "abc123",
  draft_id: "draft_2027",
  previous_league_id: null,
  bracket_id: null,
  loser_bracket_id: null,
  company_id: null,
};

export const fixtureUsers: RawLeagueUser[] = [
  {
    user_id: "u1",
    display_name: "AlphaManager",
    avatar: "av1",
    is_owner: true,
    is_bot: false,
    league_id: "test_league",
    metadata: { team_name: "Alpha Squad" },
    settings: null,
  },
  // Note: "u2" is intentionally absent — roster 2 references a departed manager.
  {
    user_id: "u3",
    display_name: "GammaManager",
    avatar: null,
    is_owner: false,
    is_bot: false,
    league_id: "test_league",
    metadata: null,
    settings: null,
  },
];

export const fixtureRosters: RawRoster[] = [
  {
    roster_id: 1,
    league_id: "test_league",
    owner_id: "u1",
    co_owners: null,
    players: [
      PLAYER_IDS.mahomes,
      PLAYER_IDS.mccaffrey,
      PLAYER_IDS.irving,
      PLAYER_IDS.jefferson,
      PLAYER_IDS.lamb,
      PLAYER_IDS.loveland,
      PLAYER_IDS.texansDefense,
      PLAYER_IDS.prescott, // bench
      PLAYER_IDS.unknown, // on IR, and unknown to Sleeper
    ],
    // 9 starting slots; FLEX and K are unfilled.
    starters: [
      PLAYER_IDS.mahomes,
      PLAYER_IDS.mccaffrey,
      PLAYER_IDS.irving,
      PLAYER_IDS.jefferson,
      PLAYER_IDS.lamb,
      PLAYER_IDS.loveland,
      "0",
      "0",
      PLAYER_IDS.texansDefense,
    ],
    reserve: [PLAYER_IDS.unknown],
    taxi: [],
    keepers: [PLAYER_IDS.jefferson],
    settings: {
      wins: 7,
      losses: 3,
      ties: 1,
      fpts: 1234,
      fpts_decimal: 56,
      fpts_against: 1100,
      fpts_against_decimal: 5,
      waiver_position: 2,
      waiver_budget_used: 40,
      total_moves: 12,
      division: 1,
    },
    metadata: null,
  },
  {
    // Owner id present but missing from /users: manager left the league.
    roster_id: 2,
    league_id: "test_league",
    owner_id: "u2",
    co_owners: null,
    players: null, // Sleeper sends null, not []
    starters: null,
    reserve: null,
    taxi: null,
    keepers: null,
    settings: { wins: 0, losses: 11, ties: 0, fpts: 900 },
    metadata: null,
  },
  {
    // Unclaimed team.
    roster_id: 3,
    league_id: "test_league",
    owner_id: null,
    co_owners: null,
    players: [],
    starters: [],
    reserve: [],
    taxi: [],
    keepers: [],
    settings: null,
    metadata: null,
  },
];

export const fixtureDrafts: RawDraft[] = [
  {
    // Completed draft: its picks are spent, so it must not count as capital.
    draft_id: "draft_2026",
    league_id: "test_league",
    season: "2026",
    season_type: "regular",
    sport: "nfl",
    status: "complete",
    type: "auction",
    start_time: 1_700_000_000_000,
    created: 1_699_000_000_000,
    last_picked: null,
    settings: { rounds: 4, teams: 3 },
    metadata: { name: "2026 Auction" },
    draft_order: { u1: 1, u3: 3 },
    slot_to_roster_id: { "1": 1, "2": 2, "3": 3 },
    creators: null,
  },
  {
    draft_id: "draft_2027",
    league_id: "test_league",
    season: "2027",
    season_type: "regular",
    sport: "nfl",
    status: "pre_draft",
    type: "snake",
    start_time: null,
    created: 1_760_000_000_000,
    last_picked: null,
    settings: { rounds: 4, teams: 3 },
    metadata: {},
    draft_order: null,
    slot_to_roster_id: null,
    creators: null,
  },
];

export const fixtureDraftPicks: RawDraftPick[] = [
  {
    draft_id: "draft_2026",
    player_id: PLAYER_IDS.mahomes,
    picked_by: "u1",
    roster_id: "1", // Sleeper returns this as a string here
    round: 1,
    draft_slot: 1,
    pick_no: 1,
    is_keeper: null,
    metadata: { amount: "55", position: "QB", team: "KC" },
  },
  {
    draft_id: "draft_2026",
    player_id: PLAYER_IDS.unknown,
    picked_by: "u2", // user not in /users
    roster_id: "2",
    round: 1,
    draft_slot: 2,
    pick_no: 2,
    is_keeper: true,
    metadata: null,
  },
  {
    draft_id: "draft_2026",
    player_id: null, // pick with no player attached
    picked_by: null,
    roster_id: null,
    round: 1,
    draft_slot: 3,
    pick_no: 3,
    is_keeper: null,
    metadata: null,
  },
];

/**
 * Pick trades exercised here:
 *  - 2027 R1: roster 3 -> roster 1        (roster 1 acquires)
 *  - 2027 R2: roster 1 -> roster 2        (roster 1 loses its own)
 *  - 2027 R3: roster 2 -> roster 3 -> 1   (multi-hop; previous owner is 3)
 *  - 2026 R1: already-drafted season, must be ignored for capital
 */
export const fixtureTradedPicks: RawTradedPick[] = [
  { season: "2027", round: 1, roster_id: 3, previous_owner_id: 3, owner_id: 1 },
  { season: "2027", round: 2, roster_id: 1, previous_owner_id: 1, owner_id: 2 },
  { season: "2027", round: 3, roster_id: 2, previous_owner_id: 3, owner_id: 1 },
  { season: "2026", round: 1, roster_id: 1, previous_owner_id: 1, owner_id: 2 },
];

export const fixtureNflState: RawNflState = {
  week: 10,
  leg: 10,
  season: "2027",
  season_type: "regular",
  league_season: "2027",
  previous_season: "2026",
  season_start_date: "2027-09-09",
  display_week: 10,
  league_create_season: "2027",
  season_has_scores: true,
};
