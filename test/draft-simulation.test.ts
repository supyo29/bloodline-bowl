/**
 * Mid-auction simulation.
 *
 * The real Bloodline Bowl draft is still pre-draft, so this drives the full
 * team-assembly pipeline with completed auction picks (real Sleeper player ids,
 * prices in Sleeper's `metadata.amount` string form) to prove that spend,
 * remaining budget, max bid, needs, and availability all behave once bidding
 * actually starts.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { getPlayerIndex, type PlayerIndex } from "../lib/sleeper/client";
import { DEFAULT_MINIMUM_BID } from "../lib/sleeper/budget";
import {
  assembleDraftTeams,
  buildAvailablePlayers,
  parsePickPrice,
} from "../lib/sleeper/draft";
import type {
  DraftAcquisition,
  DraftTeam,
  RawDraftPick,
  RawLeagueUser,
  RawRoster,
} from "../lib/sleeper/types";
import { PLAYER_IDS } from "./fixtures";

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

const SLOTS_REQUIRED = 16;
const STARTING_BUDGET = 200;

let playerIndex: PlayerIndex;
let teams: DraftTeam[];

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
  {
    user_id: "u2",
    display_name: "BetaManager",
    avatar: null,
    is_owner: false,
    is_bot: false,
    league_id: "l",
    metadata: null,
    settings: null,
  },
];

const rosters: RawRoster[] = [1, 2, 3].map((rosterId) => ({
  roster_id: rosterId,
  league_id: "l",
  owner_id: rosterId === 1 ? "u1" : rosterId === 2 ? "u2" : null,
  co_owners: null,
  players: [],
  starters: [],
  reserve: [],
  taxi: [],
  keepers: [],
  settings: null,
  metadata: null,
}));

/** A completed auction pick, shaped exactly as Sleeper returns one. */
function auctionPick(
  pickNo: number,
  rosterId: number,
  playerId: string,
  amount: string | null,
): RawDraftPick {
  return {
    draft_id: "d",
    player_id: playerId,
    picked_by: rosterId === 1 ? "u1" : "u2",
    roster_id: String(rosterId),
    round: pickNo,
    draft_slot: rosterId,
    pick_no: pickNo,
    is_keeper: null,
    metadata: amount === null ? { position: "RB" } : { amount },
  };
}

/**
 * Roster 1 spends $120 on four players; roster 2 spends $45 on two, one of
 * which Sleeper did not price.
 */
const PICKS: RawDraftPick[] = [
  auctionPick(1, 1, PLAYER_IDS.mccaffrey, "62"), // RB
  auctionPick(2, 2, PLAYER_IDS.jefferson, "45"), // WR
  auctionPick(3, 1, PLAYER_IDS.mahomes, "38"), // QB
  auctionPick(4, 1, PLAYER_IDS.lamb, "15"), // WR
  auctionPick(5, 1, PLAYER_IDS.irving, "5"), // RB
  auctionPick(6, 2, PLAYER_IDS.loveland, null), // TE, price missing
];

before(async () => {
  playerIndex = await getPlayerIndex();

  const acquisitionsByRoster = new Map<number, DraftAcquisition[]>();
  for (const pick of PICKS) {
    const rosterId = Number.parseInt(String(pick.roster_id), 10);
    const acquisition: DraftAcquisition = {
      pick_no: pick.pick_no,
      round: pick.round,
      draft_slot: pick.draft_slot,
      roster_id: rosterId,
      manager: { user_id: pick.picked_by, display_name: null },
      player: playerIndex.get(pick.player_id as string) ?? null,
      price: parsePickPrice(pick),
      is_keeper: false,
    };
    const bucket = acquisitionsByRoster.get(rosterId) ?? [];
    bucket.push(acquisition);
    acquisitionsByRoster.set(rosterId, bucket);
  }

  teams = assembleDraftTeams({
    rosters,
    usersById: new Map(users.map((user) => [user.user_id, user])),
    acquisitionsByRoster,
    slotByRosterId: new Map([
      [1, 1],
      [2, 2],
      [3, 3],
    ]),
    slotsRequired: SLOTS_REQUIRED,
    startingBudget: STARTING_BUDGET,
    minimumBid: DEFAULT_MINIMUM_BID,
    rosterPositions: ROSTER_POSITIONS,
  });
});

const team = (rosterId: number): DraftTeam => {
  const found = teams.find((t) => t.roster_id === rosterId);
  assert.ok(found, `roster ${rosterId} missing`);
  return found;
};

describe("mid-auction: spend and budget", () => {
  it("sums auction prices into spent", () => {
    // 62 + 38 + 15 + 5
    assert.equal(team(1).budget?.spent, 120);
    assert.equal(team(1).roster.players_acquired, 4);
  });

  it("derives remaining budget as starting minus spent", () => {
    assert.equal(team(1).budget?.starting, 200);
    assert.equal(team(1).budget?.remaining, 80);
  });

  it("computes the live maximum bid", () => {
    // 12 slots left -> reserve 11 -> 80 - 11 = 69
    assert.equal(team(1).roster.slots_remaining, 12);
    assert.equal(team(1).budget?.minimum_required_for_remaining_slots, 11);
    assert.equal(team(1).budget?.maximum_single_bid, 69);
    assert.equal(team(1).budget?.can_bid, true);
  });

  it("leaves an untouched roster at full budget", () => {
    assert.equal(team(3).budget?.spent, 0);
    assert.equal(team(3).budget?.remaining, 200);
    assert.equal(team(3).budget?.maximum_single_bid, 185);
    assert.equal(team(3).manager.is_vacant, true);
  });
});

describe("mid-auction: missing prices", () => {
  it("counts an unpriced pick as $0 spent rather than corrupting the math", () => {
    // Roster 2 bought two players; only the $45 one carried a price.
    assert.equal(team(2).roster.players_acquired, 2);
    assert.equal(team(2).budget?.spent, 45);
    assert.equal(team(2).budget?.remaining, 155);
    assert.ok(Number.isFinite(team(2).budget?.remaining));
  });

  it("still consumes a roster slot for the unpriced pick", () => {
    assert.equal(team(2).roster.slots_remaining, 14);
    // 155 - 13 = 142
    assert.equal(team(2).budget?.maximum_single_bid, 142);
  });

  it("reports the unknown price as null, not zero", () => {
    const unpriced = team(2).players_acquired.find(
      (p) => p.player_id === PLAYER_IDS.loveland,
    );
    assert.ok(unpriced);
    assert.equal(unpriced.price, null);
  });
});

describe("mid-auction: roster composition", () => {
  it("resolves acquired players to real names and prices", () => {
    const acquired = team(1).players_acquired;
    assert.deepEqual(
      acquired.map((p) => [p.full_name, p.price]),
      [
        ["Christian McCaffrey", 62],
        ["Patrick Mahomes", 38],
        ["CeeDee Lamb", 15],
        ["Bucky Irving", 5],
      ],
    );
  });

  it("counts positions acquired", () => {
    assert.deepEqual(team(1).positions, { RB: 2, QB: 1, WR: 1 });
  });

  it("reports remaining strict needs without flex noise", () => {
    const needs = team(1).needs;
    const required = Object.fromEntries(
      needs.required.map((n) => [n.position, n.minimum_needed]),
    );
    // Two RBs fill both RB slots; one QB of two; one WR of two.
    assert.equal(required.RB, undefined);
    assert.equal(required.QB, 1);
    assert.equal(required.WR, 1);
    assert.equal(required.TE, 1);
    assert.equal(required.K, 1);
    assert.equal(required.DEF, 1);
    assert.equal(needs.starters_filled, 4);
    assert.equal(needs.flexible_slots_remaining, 2);
  });
});

describe("mid-auction: availability", () => {
  it("removes every drafted player from the available pool", () => {
    const taken = new Set(
      PICKS.map((pick) => pick.player_id).filter(
        (id): id is string => id !== null,
      ),
    );
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: taken,
      rosterPositions: ROSTER_POSITIONS,
      limit: 1000,
    });
    const ids = new Set(available.map((p) => p.player_id));
    for (const drafted of taken) {
      assert.ok(!ids.has(drafted), `drafted player ${drafted} still available`);
    }
  });

  it("keeps undrafted stars available", () => {
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: new Set([PLAYER_IDS.mccaffrey]),
      rosterPositions: ROSTER_POSITIONS,
      position: "RB",
      limit: 50,
    });
    assert.ok(available.length > 0);
    assert.ok(!available.some((p) => p.player_id === PLAYER_IDS.mccaffrey));
  });
});

describe("mid-auction: market view", () => {
  it("identifies who can outbid whom", () => {
    const maxBids = teams.map((t) => t.budget?.maximum_single_bid ?? 0);
    assert.deepEqual(maxBids, [69, 142, 185]);

    // Roster 3 (untouched) is the strongest bidder; roster 1 the weakest.
    assert.equal(Math.max(...maxBids), 185);
    assert.equal(Math.min(...maxBids), 69);

    // "Can anyone outbid me at $70?" -> yes, rosters 2 and 3.
    const rivals = teams.filter(
      (t) => (t.budget?.maximum_single_bid ?? 0) > 70,
    );
    assert.deepEqual(
      rivals.map((t) => t.roster_id),
      [2, 3],
    );
  });
});
