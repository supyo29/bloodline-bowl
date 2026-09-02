/**
 * Canonical schema + player identity crosswalk + provider normalization —
 * deterministic (no network).
 *
 * Proves:
 *  - canonical ids are stable/reproducible
 *  - name normalization handles suffixes / punctuation / accents / DST
 *  - Sleeper fixture -> canonical schema
 *  - Yahoo fixture   -> the SAME canonical schema shape
 *  - the same NFL player from both providers -> the same canonical_player_id
 *    when a crosswalk is present
 *  - unresolved identities are surfaced, never silently guessed
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  leagueId,
  managerId,
  normalizeName,
  playerId,
  playerNameKey,
  transactionId,
} from "../lib/canonical/ids";
import { CANONICAL_SCHEMA_VERSION } from "../lib/canonical/schema";
import {
  PlayerCrosswalk,
  NoCrosswalk,
  canonicalPosition,
  type CrosswalkSource,
} from "../lib/canonical/players";
import {
  toCanonicalLeague,
  toCanonicalManagers,
  toCanonicalRosters,
  toCanonicalStandings,
  toCanonicalTransactions,
} from "../lib/providers/sleeper/canonical";
import { yahooBundleToCanonical } from "../lib/providers/yahoo/canonical";
import { slimPlayer } from "../lib/sleeper/client";
import {
  fixtureLeague,
  fixtureRosters,
  fixtureUsers,
  PLAYER_IDS,
} from "./fixtures";
import { yahooFixture, CROSSWALK_ROWS } from "./fixtures/yahoo";
import type { RawTransaction } from "../lib/sleeper/types";

/* ----------------------------------------------------------------- ids */

describe("canonical ids: deterministic + reproducible", () => {
  it("league / manager / transaction ids are pure functions of their inputs", () => {
    assert.equal(leagueId("bloodline-bowl"), leagueId("bloodline-bowl"));
    assert.equal(leagueId("bloodline-bowl"), "league:bloodline-bowl");
    assert.equal(
      managerId("bloodline-bowl", "1308955807408230400", "supyo29"),
      "manager:bloodline-bowl:1308955807408230400",
    );
    assert.equal(
      transactionId("sleeper", "bloodline-bowl", 2026, "abc123"),
      "txn:sleeper:bloodline-bowl:2026:abc123",
    );
  });

  it("player id prefers gsis > sleeper > yahoo > name", () => {
    assert.equal(playerId({ gsisId: "00-0033873", sleeperId: "4046" }), "player:gsis:00-0033873");
    assert.equal(playerId({ sleeperId: "4046" }), "player:sleeper:4046");
    assert.equal(playerId({ yahooId: "30977" }), "player:yahoo:30977");
    assert.equal(playerId({ nameKey: "patrick-mahomes-qb-kc" }), "player:name:patrick-mahomes-qb-kc");
  });
});

describe("name normalization", () => {
  it("strips suffixes, punctuation, accents; collapses whitespace", () => {
    assert.equal(normalizeName("Michael Pittman Jr."), "michael pittman");
    assert.equal(normalizeName("A.J. Brown"), "aj brown");
    assert.equal(normalizeName("D'Andre Swift"), "dandre swift");
    assert.equal(normalizeName("Amon-Ra St. Brown"), "amon ra st brown");
    assert.equal(normalizeName("  Kenneth   Walker  III "), "kenneth walker");
  });

  it("name keys join name/pos/team", () => {
    assert.equal(playerNameKey("Patrick Mahomes", "QB", "KC"), "patrick-mahomes-qb-kc");
  });
});

describe("position mapping", () => {
  it("maps provider position vocab to the canonical enum", () => {
    assert.equal(canonicalPosition("QB"), "QB");
    assert.equal(canonicalPosition("D/ST"), "DEF");
    assert.equal(canonicalPosition("DST"), "DEF");
    assert.equal(canonicalPosition("PK"), "K");
    assert.equal(canonicalPosition("CB"), "DB");
    assert.equal(canonicalPosition("bogus"), "UNKNOWN");
  });
});

/* --------------------------------------------------- crosswalk resolution */

const crosswalkSource = (rows: unknown[]): CrosswalkSource => ({
  name: "test",
  load: async () => rows as never,
});

describe("player crosswalk", () => {
  it("resolves via a stable provider id + enriches with gsis when a crosswalk row exists", async () => {
    const cw = await PlayerCrosswalk.create(crosswalkSource(CROSSWALK_ROWS));
    const { player, unresolved } = cw.resolve({
      provider: "sleeper",
      provider_player_id: "4046",
      full_name: "Patrick Mahomes",
      position: "QB",
      nfl_team: "KC",
    });
    assert.equal(unresolved, null);
    assert.equal(player.canonical_player_id, "player:gsis:00-0033873");
    assert.equal(player.identifiers.sleeper_id, "4046");
    assert.equal(player.identifiers.yahoo_id, "30977");
    assert.equal(player.resolution.method, "stable_id");
    assert.equal(player.resolution.confidence, "exact");
  });

  it("the SAME NFL player from Sleeper and Yahoo resolves to the SAME canonical id", async () => {
    const cw = await PlayerCrosswalk.create(crosswalkSource(CROSSWALK_ROWS));
    const fromSleeper = cw.resolve({
      provider: "sleeper",
      provider_player_id: "4034",
      full_name: "Christian McCaffrey",
      position: "RB",
      nfl_team: "SF",
    }).player;
    const fromYahoo = cw.resolve({
      provider: "yahoo",
      provider_player_id: "449.p.31883",
      full_name: "Christian McCaffrey",
      position: "RB",
      nfl_team: "SF",
      known_identifiers: { yahoo_id: "31883" },
    }).player;
    assert.equal(fromSleeper.canonical_player_id, fromYahoo.canonical_player_id);
    assert.equal(fromSleeper.canonical_player_id, "player:gsis:00-0033280");
  });

  it("falls back to the provider's own id when no crosswalk row matches (still resolved, marked high not exact)", async () => {
    const cw = await PlayerCrosswalk.create(NoCrosswalk);
    const { player, unresolved } = cw.resolve({
      provider: "sleeper",
      provider_player_id: "9999",
      full_name: "Depth Chart Guy",
      position: "WR",
      nfl_team: "NYJ",
    });
    assert.equal(unresolved, null);
    assert.equal(player.canonical_player_id, "player:sleeper:9999");
    assert.equal(player.resolution.method, "stable_id");
    assert.equal(player.resolution.confidence, "high");
  });

  it("records an unresolved identity instead of guessing when there is no id and no name", async () => {
    const cw = await PlayerCrosswalk.create(NoCrosswalk);
    const { unresolved } = cw.resolve({
      provider: "yahoo",
      provider_player_id: null,
      full_name: null,
      position: null,
      nfl_team: null,
    });
    assert.ok(unresolved);
    assert.equal(unresolved.provider, "yahoo");
    assert.match(unresolved.reason, /no usable name or stable id/);
  });
});

/* --------------------------------------------- Sleeper fixture -> canonical */

describe("Sleeper fixture -> canonical schema", () => {
  it("league, managers, standings normalize with provenance preserved", () => {
    const league = toCanonicalLeague("fixture-league", fixtureLeague, 10, "2026-01-01T00:00:00Z");
    assert.equal(league.league_slug, "fixture-league");
    assert.equal(league.season, 2027);
    assert.equal(league.provenance.provider, "sleeper");
    assert.equal(league.provenance.provider_id, "test_league");
    assert.deepEqual(league.roster_settings.starting_slots, [
      "QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF",
    ]);

    const managers = toCanonicalManagers("fixture-league", fixtureUsers, fixtureRosters, null);
    assert.equal(managers.length, 2);
    assert.ok(managers.every((m) => m.provenance.provider === "sleeper"));

    const standings = toCanonicalStandings("fixture-league", fixtureRosters);
    assert.equal(standings.length, 3);
    assert.equal(standings[0]!.rank, 1);
  });

  it("rosters resolve players and preserve provider ids", async () => {
    const cw = await PlayerCrosswalk.create(NoCrosswalk);
    const idx = new Map([
      [PLAYER_IDS.mahomes, slimPlayer(PLAYER_IDS.mahomes, { first_name: "Patrick", last_name: "Mahomes", position: "QB", team: "KC", fantasy_positions: ["QB"] })],
      [PLAYER_IDS.jefferson, slimPlayer(PLAYER_IDS.jefferson, { first_name: "Justin", last_name: "Jefferson", position: "WR", team: "MIN", fantasy_positions: ["WR"] })],
    ]);
    const res = toCanonicalRosters(
      "fixture-league",
      fixtureRosters,
      ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"],
      idx,
      cw,
      null,
    );
    const r1 = res.rosters.find((r) => r.canonical_team_id === "team:fixture-league:1")!;
    assert.ok(r1.starters.includes("player:sleeper:4046"));
    assert.ok(res.players.some((p) => p.identifiers.sleeper_id === "4046"));
    // The deliberately-unknown id in the fixture surfaces, not silently dropped.
    assert.ok(res.players.some((p) => p.identifiers.sleeper_id === PLAYER_IDS.unknown));
  });

  it("transactions normalize add / drop / waiver / trade", () => {
    const raw: RawTransaction[] = [
      {
        transaction_id: "t_add", type: "free_agent", status: "complete", status_updated: null,
        created: 1_700_000_000_000, leg: 3, roster_ids: [1],
        adds: { "111": 1 }, drops: null, draft_picks: null, waiver_budget: null, settings: null, consenter_ids: null,
      },
      {
        transaction_id: "t_waiver", type: "waiver", status: "complete", status_updated: null,
        created: 1_700_000_100_000, leg: 3, roster_ids: [2],
        adds: { "222": 2 }, drops: { "333": 2 }, draft_picks: null, waiver_budget: null,
        settings: { waiver_bid: 17 }, consenter_ids: null,
      },
      {
        transaction_id: "t_trade", type: "trade", status: "complete", status_updated: null,
        created: 1_700_000_200_000, leg: 4, roster_ids: [1, 2],
        adds: { "444": 1, "555": 2 }, drops: null, draft_picks: null,
        waiver_budget: [{ sender: 1, receiver: 2, amount: 5 }], settings: null, consenter_ids: [1, 2],
      },
    ];
    const canon = toCanonicalTransactions("fixture-league", 2026, raw, null);
    const byId = Object.fromEntries(canon.map((t) => [t.provenance.provider_id, t]));
    assert.equal(byId.t_add!.type, "free_agent_add");
    assert.equal(byId.t_waiver!.type, "waiver_add");
    assert.equal(byId.t_waiver!.faab_spent, 17);
    assert.equal(byId.t_trade!.type, "trade");
    assert.equal(byId.t_trade!.trade_legs.length, 2);
    assert.ok(canon.every((t) => t.canonical_league_id === "league:fixture-league"));
  });
});

/* ------------------------------------------------ Yahoo fixture -> canonical */

describe("Yahoo fixture -> the same canonical schema", () => {
  it("produces canonical entities with yahoo provenance", async () => {
    const cw = await PlayerCrosswalk.create(NoCrosswalk);
    const out = yahooBundleToCanonical("maclin-on-chicks-xvi", yahooFixture, cw, "2026-01-01T00:00:00Z");

    assert.equal(out.league.league_slug, "maclin-on-chicks-xvi");
    assert.equal(out.league.season, 2026);
    assert.equal(out.league.provenance.provider, "yahoo");
    assert.equal(out.teams.length, 2);
    assert.equal(out.managers.length, 2);
    assert.ok(out.standings[0]!.rank === 1);
    assert.ok(out.transactions.some((t) => t.type === "trade"));
    assert.ok(out.transactions.some((t) => t.type === "waiver_add" && t.faab_spent === 16));
    // The unmatched rookie has no crosswalk row and no stable external id map ->
    // still gets a yahoo-scoped id, but is flagged as low/none confidence.
    const rookie = out.players.find((p) => p.full_name === "Some Unmatched Rookie");
    assert.ok(rookie);
    assert.equal(rookie.identifiers.yahoo_player_key, "449.p.40000");
  });

  it("with a crosswalk, Yahoo players align to the SAME canonical ids as Sleeper", async () => {
    const cw = await PlayerCrosswalk.create(crosswalkSource(CROSSWALK_ROWS));
    const out = yahooBundleToCanonical("maclin-on-chicks-xvi", yahooFixture, cw, null);
    const mahomes = out.players.find((p) => p.full_name === "Patrick Mahomes")!;
    assert.equal(mahomes.canonical_player_id, "player:gsis:00-0033873");
    const cmc = out.players.find((p) => p.full_name === "Christian McCaffrey")!;
    assert.equal(cmc.canonical_player_id, "player:gsis:00-0033280");
  });
});

describe("schema version is pinned", () => {
  it("is 1 for this phase", () => {
    assert.equal(CANONICAL_SCHEMA_VERSION, 1);
  });
});
