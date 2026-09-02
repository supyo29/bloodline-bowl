/**
 * Deterministic Yahoo fixtures in the `YahooFlat*` shape (i.e. AFTER the future
 * Yahoo `fantasy_content` flattener). Player names/positions/teams are real so
 * the crosswalk can align them with the Sleeper fixture.
 *
 * TWO independent leagues are defined here — `Maclin on Chick's XVI` (82713)
 * and `Rogers Park` (287140) — to prove the Yahoo adapter supports multiple
 * leagues, not one hard-coded test league. They share zero team keys, player
 * keys, or manager guids.
 */

import type { YahooFlatBundle } from "@/lib/providers/yahoo/canonical";

/** `Maclin on Chick's XVI` — Yahoo league 82713. */
export const yahooFixture: YahooFlatBundle = {
  league: {
    league_key: "449.l.82713",
    league_id: "82713",
    name: "Maclin on Chick's XVI",
    season: 2026,
    current_week: 3,
    num_teams: 2,
    scoring_type: "head",
    stat_modifiers: { pass_yd: 0.04, pass_td: 4, rush_yd: 0.1, rush_td: 6, rec: 0.5, rec_yd: 0.1, rec_td: 6 },
    roster_positions: [
      { position: "QB", count: 1 },
      { position: "RB", count: 2 },
      { position: "WR", count: 2 },
      { position: "TE", count: 1 },
      { position: "W/R/T", count: 1 },
      { position: "K", count: 1 },
      { position: "DEF", count: 1 },
      { position: "BN", count: 5 },
      { position: "IR", count: 1 },
    ],
    playoff_start_week: 15,
    num_playoff_teams: 2,
    waiver_type: "faab",
    uses_faab: true,
  },
  teams: [
    {
      team_key: "449.l.82713.t.1",
      team_id: "1",
      name: "Chick Magnets",
      managers: [{ guid: "YAHOOGUID0000000000000001", nickname: "chickfan", is_commissioner: true }],
      wins: 2,
      losses: 1,
      ties: 0,
      points_for: 312.5,
      points_against: 288.1,
      faab_balance: 84,
      waiver_priority: 2,
      rank: 1,
      roster: [
        { player_key: "449.p.30977", selected_position: "QB" },
        { player_key: "449.p.100014", selected_position: "DEF" },
        { player_key: "449.p.40000", selected_position: "BN" },
      ],
    },
    {
      team_key: "449.l.82713.t.2",
      team_id: "2",
      name: "Route Runners",
      managers: [{ guid: "YAHOOGUID0000000000000002", nickname: "maclinowner" }],
      wins: 1,
      losses: 2,
      ties: 0,
      points_for: 288.1,
      points_against: 312.5,
      faab_balance: 100,
      waiver_priority: 1,
      rank: 2,
      roster: [{ player_key: "449.p.31883", selected_position: "RB" }],
    },
  ],
  players: [
    {
      player_key: "449.p.30977",
      player_id: "30977",
      full_name: "Patrick Mahomes",
      first_name: "Patrick",
      last_name: "Mahomes",
      editorial_team_abbr: "KC",
      display_position: "QB",
      eligible_positions: ["QB"],
    },
    {
      player_key: "449.p.31883",
      player_id: "31883",
      full_name: "Christian McCaffrey",
      first_name: "Christian",
      last_name: "McCaffrey",
      editorial_team_abbr: "SF",
      display_position: "RB",
      eligible_positions: ["RB", "W/R/T"],
    },
    {
      player_key: "449.p.100014",
      player_id: "100014",
      full_name: "Houston",
      editorial_team_abbr: "HOU",
      display_position: "DEF",
      eligible_positions: ["DEF"],
    },
    {
      player_key: "449.p.40000",
      player_id: "40000",
      full_name: "Some Unmatched Rookie",
      editorial_team_abbr: null,
      display_position: "WR",
    },
  ],
  transactions: [
    {
      transaction_key: "449.l.82713.tr.11",
      transaction_id: "11",
      type: "add/drop",
      status: "successful",
      timestamp: 1_760_100_000,
      week: 2,
      players: [
        { player_key: "449.p.40000", type: "add", destination_team_key: "449.l.82713.t.1" },
        { player_key: "449.p.99999", type: "drop", source_team_key: "449.l.82713.t.1" },
      ],
      faab_bid: 16,
    },
    {
      transaction_key: "449.l.82713.tr.12",
      transaction_id: "12",
      type: "trade",
      status: "successful",
      timestamp: 1_760_200_000,
      week: 3,
      players: [
        { player_key: "449.p.31883", type: "add", destination_team_key: "449.l.82713.t.2", source_team_key: "449.l.82713.t.1" },
      ],
    },
  ],
};

/**
 * `Rogers Park` — Yahoo league 287140. A SECOND, fully independent Yahoo league:
 * different league key/id, teams, managers, players, and transactions. Nothing
 * here overlaps `yahooFixture`.
 */
export const rogersParkFixture: YahooFlatBundle = {
  league: {
    league_key: "449.l.287140",
    league_id: "287140",
    name: "Rogers Park",
    season: 2026,
    current_week: 3,
    num_teams: 2,
    scoring_type: "head",
    stat_modifiers: { pass_yd: 0.04, pass_td: 6, rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6 },
    roster_positions: [
      { position: "QB", count: 1 },
      { position: "RB", count: 2 },
      { position: "WR", count: 3 },
      { position: "TE", count: 1 },
      { position: "K", count: 1 },
      { position: "DEF", count: 1 },
      { position: "BN", count: 6 },
      { position: "IR", count: 2 },
    ],
    playoff_start_week: 15,
    num_playoff_teams: 2,
    waiver_type: "continual",
    uses_faab: false,
  },
  teams: [
    {
      team_key: "449.l.287140.t.1",
      team_id: "1",
      name: "Lakefront Trail",
      managers: [{ guid: "YAHOOGUID0000000000000101", nickname: "rpcommish", is_commissioner: true }],
      wins: 3,
      losses: 0,
      ties: 0,
      points_for: 401.2,
      points_against: 300.4,
      faab_balance: null,
      waiver_priority: 2,
      rank: 1,
      roster: [
        { player_key: "449.p.33040", selected_position: "QB" },
        { player_key: "449.p.100022", selected_position: "DEF" },
      ],
    },
    {
      team_key: "449.l.287140.t.2",
      team_id: "2",
      name: "Glenwood Dead Ball",
      managers: [{ guid: "YAHOOGUID0000000000000102", nickname: "glenwood" }],
      wins: 0,
      losses: 3,
      ties: 0,
      points_for: 300.4,
      points_against: 401.2,
      faab_balance: null,
      waiver_priority: 1,
      rank: 2,
      roster: [{ player_key: "449.p.28392", selected_position: "RB" }],
    },
  ],
  players: [
    {
      player_key: "449.p.33040",
      player_id: "33040",
      full_name: "Josh Allen",
      first_name: "Josh",
      last_name: "Allen",
      editorial_team_abbr: "BUF",
      display_position: "QB",
      eligible_positions: ["QB"],
    },
    {
      player_key: "449.p.28392",
      player_id: "28392",
      full_name: "Derrick Henry",
      first_name: "Derrick",
      last_name: "Henry",
      editorial_team_abbr: "BAL",
      display_position: "RB",
      eligible_positions: ["RB"],
    },
    {
      player_key: "449.p.100022",
      player_id: "100022",
      full_name: "Baltimore",
      editorial_team_abbr: "BAL",
      display_position: "DEF",
      eligible_positions: ["DEF"],
    },
  ],
  transactions: [
    {
      transaction_key: "449.l.287140.tr.5",
      transaction_id: "5",
      type: "add/drop",
      status: "successful",
      timestamp: 1_760_050_000,
      week: 1,
      players: [
        { player_key: "449.p.28392", type: "add", destination_team_key: "449.l.287140.t.2" },
        { player_key: "449.p.55555", type: "drop", source_team_key: "449.l.287140.t.2" },
      ],
    },
  ],
};

/** Independent Yahoo league fixtures, keyed by canonical slug. */
export const YAHOO_LEAGUE_FIXTURES = {
  "maclin-on-chicks-xvi": yahooFixture,
  "rogers-park": rogersParkFixture,
} as const;

/**
 * The same three NFL players as the Sleeper fixture, by Sleeper id — used to
 * prove cross-provider identity alignment when a crosswalk maps them.
 */
export const CROSSWALK_ROWS = [
  {
    gsis_id: "00-0033873",
    sleeper_id: "4046",
    yahoo_id: "30977",
    full_name: "Patrick Mahomes",
    position: "QB",
    nfl_team: "KC",
  },
  {
    gsis_id: "00-0033280",
    sleeper_id: "4034",
    yahoo_id: "31883",
    full_name: "Christian McCaffrey",
    position: "RB",
    nfl_team: "SF",
  },
  {
    gsis_id: null,
    sleeper_id: "HOU",
    yahoo_id: "100014",
    full_name: "Houston",
    position: "DEF",
    nfl_team: "HOU",
  },
];
