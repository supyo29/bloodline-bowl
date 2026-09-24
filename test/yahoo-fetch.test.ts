/**
 * Yahoo fetch/flatten layer — deterministic, no network.
 *
 * Exercises `lib/providers/yahoo/fetch.ts` against constructed Yahoo
 * `fantasy_content` fixtures (`test/fixtures/yahoo-raw.ts`) covering the real
 * nested positional-array shapes: league metadata/settings, teams+standings,
 * per-team rosters, draft results, paginated transactions, and scoreboard
 * matchups. Also covers `lib/providers/yahoo/scoring.ts`'s name-based stat
 * mapping (known + unknown names) in isolation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { YahooApiError, type YahooFantasyClient } from "../lib/providers/yahoo/client";
import {
  fetchYahooDraftResults,
  fetchYahooLeagueBundle,
  fetchYahooLeagueIdentity,
  fetchYahooLeagueSettings,
  fetchYahooScoreboard,
  fetchYahooTeamRoster,
  fetchYahooTeamsAndStandings,
  fetchYahooTransactions,
} from "../lib/providers/yahoo/fetch";
import { mapYahooScoringSettings } from "../lib/providers/yahoo/scoring";
import {
  ROGERS_PARK_LEAGUE_KEY,
  rawDraftResults,
  rawLeagueMetadata,
  rawLeagueSettings,
  rawScoreboard,
  rawStandings,
  rawTeamRoster,
  rawTransactionsPage,
} from "./fixtures/yahoo-raw";

/** Minimal stand-in for YahooFantasyClient.get — same pattern as
 * test/yahoo-games-discovery.test.ts's `fakeClient`. */
function fakeClient(routes: (path: string) => unknown): YahooFantasyClient {
  return {
    tokenBackend: "memory",
    async get(path: string) {
      const data = routes(path);
      if (data instanceof Error) throw data;
      if (data === undefined) throw new YahooApiError("NOT_FOUND", `no fixture for ${path}`, 404, path);
      return { data, meta: { resource_path: path, http_status: 200, duration_ms: 1, refreshed: false, request_id: null } };
    },
  } as unknown as YahooFantasyClient;
}

describe("fetchYahooLeagueIdentity", () => {
  it("parses league_key/id/name/season and current_week from metadata", async () => {
    const client = fakeClient((p) => (p.includes("/metadata") ? rawLeagueMetadata : undefined));
    const r = await fetchYahooLeagueIdentity(client, ROGERS_PARK_LEAGUE_KEY);
    assert.equal(r.identity.league_key, ROGERS_PARK_LEAGUE_KEY);
    assert.equal(r.identity.league_id, "287140");
    assert.equal(r.identity.name, "Rogers Park");
    assert.equal(r.identity.season, 2026);
    assert.equal(r.current_week, 3);
    assert.equal(r.num_teams, 10);
    assert.equal(r.draft_status, "postdraft");
  });

  it("throws MALFORMED when required fields are missing", async () => {
    const client = fakeClient(() => ({ fantasy_content: { league: [{ name: "X" }] } }));
    await assert.rejects(() => fetchYahooLeagueIdentity(client, "k"), (e: unknown) => {
      assert.equal((e as YahooApiError).kind, "MALFORMED");
      return true;
    });
  });
});

describe("fetchYahooLeagueSettings", () => {
  it("parses roster_positions, stat_categories, and stat_modifiers", async () => {
    const client = fakeClient((p) => (p.includes("/settings") ? rawLeagueSettings : undefined));
    const r = await fetchYahooLeagueSettings(client, ROGERS_PARK_LEAGUE_KEY);
    assert.deepEqual(
      r.roster_positions,
      [
        { position: "QB", count: 1 },
        { position: "RB", count: 2 },
        { position: "WR", count: 3 },
        { position: "TE", count: 1 },
        { position: "K", count: 1 },
        { position: "DEF", count: 1 },
        { position: "BN", count: 6 },
        { position: "IR", count: 2 },
      ],
    );
    assert.equal(r.stat_categories.length, 9);
    assert.deepEqual(r.stat_categories.find((s) => s.stat_id === "5"), { stat_id: "5", name: "Passing Touchdowns", display_name: "Pass TD" });
    assert.equal(r.stat_modifiers.length, 9);
    assert.deepEqual(r.stat_modifiers.find((s) => s.stat_id === "5"), { stat_id: "5", value: 6 });
    assert.equal(r.playoff_start_week, 15);
    assert.equal(r.num_playoff_teams, 4);
    assert.equal(r.uses_faab, false);
    assert.equal(r.waiver_type, "FR");
  });
});

describe("fetchYahooTeamsAndStandings", () => {
  it("parses both teams with managers, records, and points", async () => {
    const client = fakeClient((p) => (p.includes("/standings") ? rawStandings : undefined));
    const teams = await fetchYahooTeamsAndStandings(client, ROGERS_PARK_LEAGUE_KEY);
    assert.equal(teams.length, 2);
    const [t1, t2] = teams;
    assert.ok(t1 && t2);
    assert.equal(t1.team_id, "1");
    assert.equal(t1.name, "Lakefront Trail");
    assert.equal(t1.wins, 3);
    assert.equal(t1.losses, 0);
    assert.equal(t1.points_for, 401.2);
    assert.equal(t1.points_against, 300.4);
    assert.equal(t1.rank, 1);
    assert.equal(t1.waiver_priority, 2);
    assert.equal(t1.managers.length, 1);
    assert.equal(t1.managers[0]?.guid, "YAHOOGUID0000000000000101");
    assert.equal(t1.managers[0]?.nickname, "rpcommish");
    assert.equal(t1.managers[0]?.is_commissioner, true);
    assert.equal(t2.managers[0]?.is_commissioner, false);
    assert.equal(t2.wins, 0);
    assert.equal(t2.losses, 3);
  });
});

describe("fetchYahooTeamRoster", () => {
  it("parses roster slots and embedded player metadata together", async () => {
    const teamKey = `${ROGERS_PARK_LEAGUE_KEY}.t.1`;
    const fixture = rawTeamRoster(teamKey, [
      { key: "471.p.33040", id: "33040", name: "Josh Allen", team: "BUF", pos: "QB", slot: "QB" },
      { key: "471.p.100022", id: "100022", name: "Baltimore", team: "BAL", pos: "DEF", slot: "BN" },
    ]);
    const client = fakeClient((p) => (p.includes(`/team/${teamKey}/roster`) ? fixture : undefined));
    const r = await fetchYahooTeamRoster(client, teamKey);
    assert.equal(r.slots.length, 2);
    assert.deepEqual(r.slots[0], { player_key: "471.p.33040", selected_position: "QB" });
    assert.deepEqual(r.slots[1], { player_key: "471.p.100022", selected_position: "BN" });
    assert.equal(r.players.length, 2);
    const allen = r.players.find((p) => p.player_key === "471.p.33040")!;
    assert.equal(allen.full_name, "Josh Allen");
    assert.equal(allen.first_name, "Josh");
    assert.equal(allen.last_name, "Allen");
    assert.equal(allen.editorial_team_abbr, "BUF");
    assert.equal(allen.display_position, "QB");
    assert.deepEqual(allen.eligible_positions, ["QB"]);
  });
});

describe("fetchYahooDraftResults", () => {
  it("parses every pick with round/team/player", async () => {
    const client = fakeClient((p) => (p.includes("/draftresults") ? rawDraftResults : undefined));
    const picks = await fetchYahooDraftResults(client, ROGERS_PARK_LEAGUE_KEY);
    assert.equal(picks.length, 2);
    assert.deepEqual(picks[0], { pick: 1, round: 1, team_key: `${ROGERS_PARK_LEAGUE_KEY}.t.1`, player_key: "471.p.33040", cost: null });
    assert.deepEqual(picks[1], { pick: 2, round: 1, team_key: `${ROGERS_PARK_LEAGUE_KEY}.t.2`, player_key: "471.p.28392", cost: null });
  });
});

describe("fetchYahooTransactions", () => {
  it("parses add/drop players, faab, and type", async () => {
    const page = rawTransactionsPage([
      {
        key: `${ROGERS_PARK_LEAGUE_KEY}.tr.5`,
        id: "5",
        type: "add/drop",
        ts: 1_760_050_000,
        adds: [{ key: "471.p.28392", dest: `${ROGERS_PARK_LEAGUE_KEY}.t.2` }],
        drops: [{ key: "471.p.55555", src: `${ROGERS_PARK_LEAGUE_KEY}.t.2` }],
      },
    ]);
    const client = fakeClient((p) => (p.includes("/transactions") ? page : undefined));
    const { transactions, truncated } = await fetchYahooTransactions(client, ROGERS_PARK_LEAGUE_KEY);
    assert.equal(truncated, false);
    assert.equal(transactions.length, 1);
    const tx = transactions[0]!;
    assert.equal(tx.transaction_id, "5");
    assert.equal(tx.type, "add/drop");
    assert.equal(tx.players.length, 2);
    assert.ok(tx.players.some((p) => p.player_key === "471.p.28392" && p.type === "add"));
    assert.ok(tx.players.some((p) => p.player_key === "471.p.55555" && p.type === "drop"));
  });

  it("pages until a short page and never silently truncates a full page run", async () => {
    let calls = 0;
    const fullPage = () =>
      rawTransactionsPage(
        Array.from({ length: 100 }, (_, i) => ({
          key: `${ROGERS_PARK_LEAGUE_KEY}.tr.${i}`,
          id: String(i),
          type: "add",
          ts: 1_000 + i,
          adds: [{ key: `471.p.${i}`, dest: `${ROGERS_PARK_LEAGUE_KEY}.t.1` }],
        })),
      );
    const shortPage = () =>
      rawTransactionsPage([
        { key: `${ROGERS_PARK_LEAGUE_KEY}.tr.last`, id: "last", type: "add", ts: 2_000, adds: [{ key: "471.p.999", dest: `${ROGERS_PARK_LEAGUE_KEY}.t.1` }] },
      ]);
    const client = fakeClient((p) => {
      if (!p.includes("/transactions")) return undefined;
      calls += 1;
      return calls <= 2 ? fullPage() : shortPage();
    });
    const { transactions, truncated } = await fetchYahooTransactions(client, ROGERS_PARK_LEAGUE_KEY);
    assert.equal(truncated, false);
    assert.equal(transactions.length, 201); // 2 full pages of 100 + 1 short page of 1
    assert.equal(calls, 3);
  });
});

describe("fetchYahooScoreboard", () => {
  it("parses each side's team_key and points", async () => {
    const week3 = rawScoreboard(3, [
      { team_key: `${ROGERS_PARK_LEAGUE_KEY}.t.1`, points: 112.4 },
      { team_key: `${ROGERS_PARK_LEAGUE_KEY}.t.2`, points: 98.6 },
    ]);
    const client = fakeClient((p) => (p.includes("/scoreboard;week=3") ? week3 : undefined));
    const matchups = await fetchYahooScoreboard(client, ROGERS_PARK_LEAGUE_KEY, 3);
    assert.equal(matchups.length, 1);
    assert.equal(matchups[0]?.week, 3);
    assert.equal(matchups[0]?.status, "midevent");
    assert.equal(matchups[0]?.sides.length, 2);
    assert.equal(matchups[0]?.sides[0]?.points, 112.4);
    assert.equal(matchups[0]?.sides[1]?.points, 98.6);
  });
});

describe("fetchYahooLeagueBundle — full assembly", () => {
  it("combines identity + settings + teams + rosters + draft into one YahooFlatBundle", async () => {
    const t1 = `${ROGERS_PARK_LEAGUE_KEY}.t.1`;
    const t2 = `${ROGERS_PARK_LEAGUE_KEY}.t.2`;
    const roster1 = rawTeamRoster(t1, [{ key: "471.p.33040", id: "33040", name: "Josh Allen", team: "BUF", pos: "QB", slot: "QB" }]);
    const roster2 = rawTeamRoster(t2, [{ key: "471.p.28392", id: "28392", name: "Derrick Henry", team: "BAL", pos: "RB", slot: "RB" }]);
    const client = fakeClient((p) => {
      if (p.includes("/metadata")) return rawLeagueMetadata;
      if (p.includes("/settings")) return rawLeagueSettings;
      if (p.includes("/standings")) return rawStandings;
      if (p.includes(`/team/${t1}/roster`)) return roster1;
      if (p.includes(`/team/${t2}/roster`)) return roster2;
      if (p.includes("/draftresults")) return rawDraftResults;
      return undefined;
    });

    const { bundle, draftResults, scoringWarnings } = await fetchYahooLeagueBundle(client, ROGERS_PARK_LEAGUE_KEY);

    assert.equal(bundle.league.league_id, "287140");
    assert.equal(bundle.league.name, "Rogers Park");
    assert.equal(bundle.league.season, 2026);
    assert.equal(bundle.league.num_teams, 10);
    assert.equal(bundle.teams.length, 2);
    assert.equal(bundle.teams[0]?.roster.length, 1);
    assert.equal(bundle.teams[1]?.roster.length, 1);
    // Players come from both team rosters, deduped by player_key.
    assert.equal(bundle.players.length, 2);
    assert.ok(bundle.players.some((p) => p.full_name === "Josh Allen"));
    assert.ok(bundle.players.some((p) => p.full_name === "Derrick Henry"));
    // Scoring: 8 named stats map to canonical keys; the 9th ("Tackle for Loss
    // Bonus") has no entry in the table and must surface as a warning, never
    // be guessed at or silently dropped.
    assert.equal(bundle.league.stat_modifiers.pass_td, 6);
    assert.equal(bundle.league.stat_modifiers.rec, 1);
    assert.equal(bundle.league.stat_modifiers.yahoo_stat_78, 3);
    assert.equal(scoringWarnings.length, 1);
    assert.equal(scoringWarnings[0]?.stat_id, "78");
    assert.equal(scoringWarnings[0]?.name, "Tackle for Loss Bonus");
    // Draft results are fetched alongside the bundle, not folded into it —
    // the canonical conversion (yahooBundleToCanonical) does that.
    assert.equal(draftResults.length, 2);
  });
});

describe("mapYahooScoringSettings", () => {
  it("maps every known stat name to its canonical key", () => {
    const { raw_scoring, unmapped } = mapYahooScoringSettings(
      [
        { stat_id: "4", name: "Passing Yards", display_name: null },
        { stat_id: "5", name: "Passing Touchdowns", display_name: null },
        { stat_id: "11", name: "Receptions", display_name: null },
      ],
      [
        { stat_id: "4", value: 0.04 },
        { stat_id: "5", value: 4 },
        { stat_id: "11", value: 0.5 },
      ],
    );
    assert.deepEqual(raw_scoring, { pass_yd: 0.04, pass_td: 4, rec: 0.5 });
    assert.deepEqual(unmapped, []);
  });

  it("preserves an unrecognized stat name under a namespaced key and reports it — never guesses", () => {
    const { raw_scoring, unmapped } = mapYahooScoringSettings(
      [{ stat_id: "999", name: "Some Brand-New Yahoo Stat", display_name: "Brand New" }],
      [{ stat_id: "999", value: 2.5 }],
    );
    assert.deepEqual(raw_scoring, { yahoo_stat_999: 2.5 });
    assert.equal(unmapped.length, 1);
    assert.equal(unmapped[0]?.stat_id, "999");
    assert.equal(unmapped[0]?.name, "Some Brand-New Yahoo Stat");
  });

  it("drops zero-valued modifiers (semantically equivalent to absent, matches scoringFingerprint's rule)", () => {
    const { raw_scoring } = mapYahooScoringSettings(
      [{ stat_id: "1", name: "Passing Yards", display_name: null }],
      [{ stat_id: "1", value: 0 }],
    );
    assert.deepEqual(raw_scoring, {});
  });

  it("name matching is case/whitespace insensitive but never fuzzy across different stats", () => {
    const { raw_scoring, unmapped } = mapYahooScoringSettings(
      [
        { stat_id: "1", name: "  passing   yards ", display_name: null },
        { stat_id: "2", name: "Passing Yards Bonus", display_name: null }, // similar but NOT the same stat
      ],
      [
        { stat_id: "1", value: 0.04 },
        { stat_id: "2", value: 1 },
      ],
    );
    assert.equal(raw_scoring.pass_yd, 0.04);
    assert.equal(raw_scoring.yahoo_stat_2, 1);
    assert.equal(unmapped.length, 1);
    assert.equal(unmapped[0]?.stat_id, "2");
  });
});
