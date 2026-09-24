/**
 * Constructed Yahoo `fantasy_content` fixtures in the raw, nested positional-
 * array shape `lib/providers/yahoo/fetch.ts` parses. These follow the same
 * conventions already proven out in `test/yahoo-games-discovery.test.ts`
 * (`probeLeague`'s `metaBody`) — a `leagues`/`league` collection wrapping an
 * array of flat metadata objects, with named sub-resources (`settings`,
 * `standings`, `roster`, `scoreboard`) nested one level deeper as a
 * single-element array, matching Yahoo's documented Fantasy Sports API
 * response format.
 *
 * These are CONSTRUCTED fixtures, not captured live Production payloads (this
 * repo has no live Yahoo OAuth session available for capture) — they exercise
 * the flattener against the shape it is designed for and guard it against
 * regressions, but do not by themselves certify that Yahoo's real response
 * matches exactly. Live acceptance testing against a real Rogers Park read is
 * still required before certifying the parser end-to-end (see docs).
 */

const LEAGUE_KEY = "471.l.287140";

export const rawLeagueMetadata = {
  fantasy_content: {
    leagues: {
      "0": {
        league: [
          {
            league_key: LEAGUE_KEY,
            league_id: "287140",
            name: "Rogers Park",
            url: "https://football.fantasysports.yahoo.com/f1/287140",
            draft_status: "postdraft",
            num_teams: 10,
            scoring_type: "head",
            league_type: "private",
            current_week: 3,
            start_week: "1",
            end_week: "17",
            season: "2026",
            game_code: "nfl",
          },
        ],
      },
      count: 1,
    },
  },
};

export const rawLeagueSettings = {
  fantasy_content: {
    league: [
      { league_key: LEAGUE_KEY, league_id: "287140", name: "Rogers Park" },
      {
        settings: [
          {
            draft_type: "live",
            is_auction_draft: "0",
            scoring_type: "head",
            uses_playoff: "1",
            playoff_start_week: "15",
            num_playoff_teams: "4",
            waiver_type: "FR",
            waiver_rule: "gametime",
            uses_faab: "0",
            roster_positions: [
              { roster_position: { position: "QB", position_type: "O", count: "1" } },
              { roster_position: { position: "RB", position_type: "O", count: "2" } },
              { roster_position: { position: "WR", position_type: "O", count: "3" } },
              { roster_position: { position: "TE", position_type: "O", count: "1" } },
              { roster_position: { position: "K", position_type: "O", count: "1" } },
              { roster_position: { position: "DEF", position_type: "O", count: "1" } },
              { roster_position: { position: "BN", position_type: "O", count: "6" } },
              { roster_position: { position: "IR", position_type: "O", count: "2" } },
            ],
            stat_categories: {
              stats: [
                { stat: { stat_id: "4", name: "Passing Yards", display_name: "Pass Yds" } },
                { stat: { stat_id: "5", name: "Passing Touchdowns", display_name: "Pass TD" } },
                { stat: { stat_id: "6", name: "Interceptions", display_name: "Int" } },
                { stat: { stat_id: "9", name: "Rushing Yards", display_name: "Rush Yds" } },
                { stat: { stat_id: "10", name: "Rushing Touchdowns", display_name: "Rush TD" } },
                { stat: { stat_id: "11", name: "Receptions", display_name: "Rec" } },
                { stat: { stat_id: "12", name: "Receiving Yards", display_name: "Rec Yds" } },
                { stat: { stat_id: "13", name: "Receiving Touchdowns", display_name: "Rec TD" } },
                // Deliberately an obscure/unfamiliar stat name to prove the
                // "unmapped, preserved, warned" path (never guessed).
                { stat: { stat_id: "78", name: "Tackle for Loss Bonus", display_name: "TFL Bonus" } },
              ],
            },
            stat_modifiers: {
              stats: [
                { stat: { stat_id: "4", value: "0.04" } },
                { stat: { stat_id: "5", value: "6" } },
                { stat: { stat_id: "6", value: "-2" } },
                { stat: { stat_id: "9", value: "0.1" } },
                { stat: { stat_id: "10", value: "6" } },
                { stat: { stat_id: "11", value: "1" } },
                { stat: { stat_id: "12", value: "0.1" } },
                { stat: { stat_id: "13", value: "6" } },
                { stat: { stat_id: "78", value: "3" } },
              ],
            },
          },
        ],
      },
    ],
  },
};

export const rawStandings = {
  fantasy_content: {
    league: [
      { league_key: LEAGUE_KEY },
      {
        standings: [
          {
            teams: {
              "0": {
                team: [
                  [
                    { team_key: `${LEAGUE_KEY}.t.1` },
                    { team_id: "1" },
                    { name: "Lakefront Trail" },
                    { url: "https://x/1" },
                    { waiver_priority: "2" },
                    {
                      managers: [
                        { manager: { guid: "YAHOOGUID0000000000000101", nickname: "rpcommish", is_commissioner: "1" } },
                      ],
                    },
                  ],
                  {
                    team_standings: {
                      rank: "1",
                      outcome_totals: { wins: "3", losses: "0", ties: "0", percentage: "1.000" },
                      points_for: "401.20",
                      points_against: "300.40",
                    },
                  },
                ],
              },
              "1": {
                team: [
                  [
                    { team_key: `${LEAGUE_KEY}.t.2` },
                    { team_id: "2" },
                    { name: "Glenwood Dead Ball" },
                    { waiver_priority: "1" },
                    {
                      managers: [{ manager: { guid: "YAHOOGUID0000000000000102", nickname: "glenwood" } }],
                    },
                  ],
                  {
                    team_standings: {
                      rank: "2",
                      outcome_totals: { wins: "0", losses: "3", ties: "0", percentage: "0.000" },
                      points_for: "300.40",
                      points_against: "401.20",
                    },
                  },
                ],
              },
              count: 2,
            },
          },
        ],
      },
    ],
  },
};

export function rawTeamRoster(teamKey: string, players: Array<{ key: string; id: string; name: string; team: string; pos: string; slot: string }>) {
  return {
    fantasy_content: {
      team: [
        [{ team_key: teamKey }],
        {
          roster: [
            { coverage_type: "week", week: "3" },
            {
              players: {
                ...Object.fromEntries(
                  players.map((p, i) => [
                    String(i),
                    {
                      player: [
                        [
                          { player_key: p.key },
                          { player_id: p.id },
                          { name: { full: p.name, first: p.name.split(" ")[0], last: p.name.split(" ").slice(1).join(" ") } },
                          { editorial_team_abbr: p.team },
                          { display_position: p.pos },
                          { eligible_positions: [{ position: p.pos }] },
                          { status: null },
                        ],
                        { selected_position: [{ coverage_type: "week" }, { week: "3" }, { position: p.slot }] },
                      ],
                    },
                  ]),
                ),
                count: players.length,
              },
            },
          ],
        },
      ],
    },
  };
}

export const rawDraftResults = {
  fantasy_content: {
    league: [
      { league_key: LEAGUE_KEY },
      {
        draft_results: {
          "0": { draft_result: [{ pick: "1", round: "1", team_key: `${LEAGUE_KEY}.t.1`, player_key: "471.p.33040" }] },
          "1": { draft_result: [{ pick: "2", round: "1", team_key: `${LEAGUE_KEY}.t.2`, player_key: "471.p.28392" }] },
          count: 2,
        },
      },
    ],
  },
};

export function rawTransactionsPage(rows: Array<{ key: string; id: string; type: string; ts: number; adds?: Array<{ key: string; dest: string }>; drops?: Array<{ key: string; src: string }> }>) {
  return {
    fantasy_content: {
      league: [
        { league_key: LEAGUE_KEY },
        {
          transactions: {
            ...Object.fromEntries(
              rows.map((r, i) => {
                const playerEntries = [
                  ...(r.adds ?? []).map((a) => ({
                    player: [
                      [{ player_key: a.key }],
                      { transaction_data: [{ type: "add", destination_team_key: a.dest }] },
                    ],
                  })),
                  ...(r.drops ?? []).map((d) => ({
                    player: [
                      [{ player_key: d.key }],
                      { transaction_data: [{ type: "drop", source_team_key: d.src }] },
                    ],
                  })),
                ];
                return [
                  String(i),
                  {
                    transaction: [
                      {
                        transaction_key: r.key,
                        transaction_id: r.id,
                        type: r.type,
                        status: "successful",
                        timestamp: String(r.ts),
                      },
                      {
                        players: {
                          ...Object.fromEntries(playerEntries.map((p, j) => [String(j), p])),
                          count: playerEntries.length,
                        },
                      },
                    ],
                  },
                ];
              }),
            ),
            count: rows.length,
          },
        },
      ],
    },
  };
}

export function rawScoreboard(week: number, sides: Array<{ team_key: string; points: number }>) {
  return {
    fantasy_content: {
      league: [
        { league_key: LEAGUE_KEY },
        {
          scoreboard: [
            { week: String(week) },
            {
              matchups: {
                "0": {
                  matchup: [
                    {
                      week: String(week),
                      status: "midevent",
                      teams: {
                        ...Object.fromEntries(
                          sides.map((s, i) => [
                            String(i),
                            {
                              team: [
                                [{ team_key: s.team_key }],
                                { team_points: { total: String(s.points) } },
                              ],
                            },
                          ]),
                        ),
                        count: sides.length,
                      },
                    },
                  ],
                },
                count: 1,
              },
            },
          ],
        },
      ],
    },
  };
}

export const ROGERS_PARK_LEAGUE_KEY = LEAGUE_KEY;
