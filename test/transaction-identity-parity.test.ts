/**
 * Canonical player identity parity across surfaces — deterministic (no network).
 *
 * Every player reference — roster slot, matchup, transaction add/drop, trade
 * leg, draft pick — passes through the SAME crosswalk resolver, so the same NFL
 * player gets ONE `canonical_player_id` everywhere.
 *
 * Proves:
 *   Sleeper roster player  ==  Sleeper transaction player
 *   Yahoo roster player    ==  Yahoo transaction player
 *   Sleeper player         ==  Yahoo player            (with crosswalk evidence)
 *   unresolved -> provider provenance + explicit resolution status + warning
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PlayerCrosswalk, NoCrosswalk, type CrosswalkSource } from "../lib/canonical/players";
import {
  createSleeperResolver,
  toCanonicalRosters,
  toCanonicalTransactions,
} from "../lib/providers/sleeper/canonical";
import { yahooBundleToCanonical } from "../lib/providers/yahoo/canonical";
import { slimPlayer } from "../lib/sleeper/client";
import type { RawRoster, RawTransaction } from "../lib/sleeper/types";
import { yahooFixture, rogersParkFixture, CROSSWALK_ROWS } from "./fixtures/yahoo";

const source = (rows: unknown[]): CrosswalkSource => ({ name: "test", load: async () => rows as never });

/* ---- Christian McCaffrey: sleeper 4034 / yahoo 31883 / gsis 00-0033280 ---- */

const CMC_SLEEPER = "4034";
const CMC_CANONICAL = "player:gsis:00-0033280";

function sleeperIndex(): Map<string, ReturnType<typeof slimPlayer>> {
  return new Map([
    [CMC_SLEEPER, slimPlayer(CMC_SLEEPER, { first_name: "Christian", last_name: "McCaffrey", position: "RB", team: "SF", fantasy_positions: ["RB"] })],
  ]);
}

describe("Sleeper: roster player id == transaction player id", () => {
  it("the same NFL player resolves identically on both surfaces (crosswalk present)", async () => {
    const cw = await PlayerCrosswalk.create(source(CROSSWALK_ROWS));
    const idx = sleeperIndex();

    const roster: RawRoster = {
      roster_id: 1, league_id: "L", owner_id: "u1", co_owners: null,
      players: [CMC_SLEEPER], starters: [CMC_SLEEPER], reserve: null, taxi: null, keepers: null,
      settings: { wins: 1, losses: 0, ties: 0 }, metadata: null,
    };
    const txn: RawTransaction = {
      transaction_id: "tx1", type: "free_agent", status: "complete", status_updated: null,
      created: 1_700_000_000_000, leg: 2, roster_ids: [1],
      adds: { [CMC_SLEEPER]: 1 }, drops: null, draft_picks: null, waiver_budget: null, settings: null, consenter_ids: null,
    };

    // Independent resolvers -> proves the id is deterministic, not shared state.
    const rosterOut = toCanonicalRosters("L", [roster], ["RB"], idx, cw, null, createSleeperResolver(idx, cw));
    const txnOut = toCanonicalTransactions("L", 2026, [txn], null, createSleeperResolver(idx, cw));

    const fromRoster = rosterOut.rosters[0]!.all_players[0];
    const fromTxn = txnOut[0]!.players_added[0]!.canonical_player_id;
    assert.equal(fromRoster, CMC_CANONICAL);
    assert.equal(fromTxn, CMC_CANONICAL);
    assert.equal(fromRoster, fromTxn);
  });

  it("a shared resolver also aligns trade-leg ids with roster ids", async () => {
    const cw = await PlayerCrosswalk.create(source(CROSSWALK_ROWS));
    const idx = sleeperIndex();
    const resolver = createSleeperResolver(idx, cw);
    const trade: RawTransaction = {
      transaction_id: "tr1", type: "trade", status: "complete", status_updated: null,
      created: 1_700_000_000_000, leg: 3, roster_ids: [1, 2],
      adds: { [CMC_SLEEPER]: 2 }, drops: null, draft_picks: null, waiver_budget: null, settings: null, consenter_ids: [1, 2],
    };
    const out = toCanonicalTransactions("px", 2026, [trade], null, resolver);
    const leg = out[0]!.trade_legs.find((l) => l.received_player_ids.length > 0)!;
    assert.equal(leg.canonical_team_id, "team:px:2");
    assert.deepEqual(leg.received_player_ids, [CMC_CANONICAL]);
    assert.equal(out[0]!.players_added[0]!.canonical_player_id, CMC_CANONICAL);
  });
});

describe("Yahoo: roster player id == transaction player id", () => {
  it("McCaffrey is rostered (team 2) AND traded in the fixture — one canonical id", async () => {
    const cw = await PlayerCrosswalk.create(NoCrosswalk);
    const out = yahooBundleToCanonical("maclin-on-chicks-xvi", yahooFixture, cw, null);

    const tradeTxn = out.transactions.find((t) => t.type === "trade")!;
    const txnPlayerId = tradeTxn.players_added[0]!.canonical_player_id;
    const rosterHasIt = out.rosters.some((r) => r.all_players.includes(txnPlayerId));
    assert.ok(rosterHasIt, "the traded player's canonical id must match a roster entry");

    // And it is the crosswalk/provider identity, not a bare fallback string.
    const player = out.players.find((p) => p.canonical_player_id === txnPlayerId)!;
    assert.equal(player.identifiers.yahoo_player_key, "449.p.31883");
  });

  it("Rogers Park: the added RB (Derrick Henry) has one id across roster + transaction", async () => {
    const cw = await PlayerCrosswalk.create(NoCrosswalk);
    const out = yahooBundleToCanonical("rogers-park", rogersParkFixture, cw, null);
    const addTxn = out.transactions[0]!;
    const added = addTxn.players_added[0]!.canonical_player_id;
    assert.ok(out.rosters.some((r) => r.all_players.includes(added)));
  });
});

describe("cross-provider: Sleeper player id == Yahoo player id (crosswalk evidence)", () => {
  it("McCaffrey from a Sleeper transaction and a Yahoo transaction share a canonical id", async () => {
    const cw = await PlayerCrosswalk.create(source(CROSSWALK_ROWS));
    const idx = sleeperIndex();

    const sleeperTxn: RawTransaction = {
      transaction_id: "s1", type: "free_agent", status: "complete", status_updated: null,
      created: 1, leg: 1, roster_ids: [1], adds: { [CMC_SLEEPER]: 1 }, drops: null,
      draft_picks: null, waiver_budget: null, settings: null, consenter_ids: null,
    };
    const sleeperId = toCanonicalTransactions("bloodline-bowl", 2026, [sleeperTxn], null, createSleeperResolver(idx, cw))[0]!
      .players_added[0]!.canonical_player_id;

    const yahooOut = yahooBundleToCanonical("maclin-on-chicks-xvi", yahooFixture, cw, null);
    const yahooId = yahooOut.transactions.find((t) => t.type === "trade")!.players_added[0]!.canonical_player_id;

    assert.equal(sleeperId, CMC_CANONICAL);
    assert.equal(yahooId, CMC_CANONICAL);
    assert.equal(sleeperId, yahooId);
  });
});

describe("unresolved identities keep provenance + explicit status, never guessed", () => {
  it("Sleeper: an id absent from the player DB with no crosswalk row is marked unresolved", async () => {
    const cw = await PlayerCrosswalk.create(NoCrosswalk);
    const resolver = createSleeperResolver(new Map(), cw);
    const txn: RawTransaction = {
      transaction_id: "u1", type: "free_agent", status: "complete", status_updated: null,
      created: 1, leg: 1, roster_ids: [1], adds: { "99999999": 1 }, drops: null,
      draft_picks: null, waiver_budget: null, settings: null, consenter_ids: null,
    };
    const out = toCanonicalTransactions("px", 2026, [txn], null, resolver);
    const id = out[0]!.players_added[0]!.canonical_player_id;
    // Provider provenance preserved: the id is still scoped to the sleeper id...
    assert.equal(id, "player:sleeper:99999999");
    const player = resolver.players.get(id)!;
    assert.equal(player.identifiers.sleeper_id, "99999999");
    // ...but with no name and no crosswalk row it is explicitly unresolved, not guessed.
    assert.equal(player.resolution.method, "unresolved");
    assert.equal(player.resolution.confidence, "none");
    assert.ok(player.resolution.note);
    assert.ok(
      resolver.unresolved.some((u) => u.provider === "sleeper" && u.provider_player_id === "99999999"),
      "unresolved sleeper transaction player is surfaced with provenance",
    );
    // A truly unresolvable ref (no id, no name) is recorded, not guessed.
    const { unresolved } = cw.resolve({ provider: "yahoo", provider_player_id: null, full_name: null, position: null, nfl_team: null });
    assert.ok(unresolved);
    assert.match(unresolved.reason, /no usable name or stable id/);
  });

  it("Yahoo: a transaction-only player_key with no name and no crosswalk row is recorded as unresolved", async () => {
    // yahooFixture tr.11 drops `449.p.99999` which is NOT in bundle.players.
    const cw = await PlayerCrosswalk.create(NoCrosswalk);
    const out = yahooBundleToCanonical("maclin-on-chicks-xvi", yahooFixture, cw, null);
    const dropId = out.transactions
      .flatMap((t) => t.players_dropped)
      .map((d) => d.canonical_player_id)
      .find((id) => id.includes("99999"));
    assert.ok(dropId, "the dropped-only player still gets a canonical id");
    const rec = out.players.find((p) => p.canonical_player_id === dropId)!;
    assert.equal(rec.identifiers.yahoo_player_key, "449.p.99999");
    assert.ok(
      out.unresolved_players.some((u) => u.provider === "yahoo" && u.provider_player_id === "449.p.99999"),
      "unresolved yahoo transaction player is surfaced with provenance",
    );
  });
});
