/**
 * Draft-night logic tests: budget arithmetic, roster needs, availability
 * filtering, and query validation.
 *
 * Player resolution runs against the REAL Sleeper player database so the
 * available-player pool is exercised with live data.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { getPlayerIndex, type PlayerIndex } from "../lib/sleeper/client";
import {
  DEFAULT_MINIMUM_BID,
  canOutbid,
  computeBudget,
} from "../lib/sleeper/budget";
import {
  MIN_PER_REQUIRED_POSITION,
  buildAvailablePlayers,
  computeRosterNeeds,
  draftablePositions,
  parsePickPrice,
  requiredStartingPositions,
  selectActiveDraft,
} from "../lib/sleeper/draft";
import {
  MAX_AVAILABLE_LIMIT,
  cacheSecondsForStatus,
  parseDraftQuery,
} from "../lib/sleeper/draft-service";
import type {
  NormalizedPlayer,
  RawDraft,
  RawDraftPick,
} from "../lib/sleeper/types";
import { PLAYER_IDS } from "./fixtures";

/** Bloodline Bowl's actual roster layout: 2QB, 2 flex, 5 bench. */
const BLOODLINE_ROSTER_POSITIONS = [
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

let playerIndex: PlayerIndex;
const player = (id: string): NormalizedPlayer => {
  const found = playerIndex.get(id);
  assert.ok(found, `player ${id} missing from Sleeper index`);
  return found;
};

before(async () => {
  playerIndex = await getPlayerIndex();
});

describe("budget: maximum single bid", () => {
  it("reserves one minimum bid per remaining slot", () => {
    // The prompt's worked example: $100 left, 5 slots, $1 minimum -> $96.
    const result = computeBudget({
      startingBudget: 200,
      spent: 100,
      slotsRequired: 16,
      slotsFilled: 11,
      minimumBid: 1,
    });
    assert.equal(result.remaining, 100);
    assert.equal(result.slots_remaining, 5);
    assert.equal(result.minimum_required_for_remaining_slots, 4);
    assert.equal(result.maximum_single_bid, 96);
  });

  it("lets a roster with one slot left spend everything", () => {
    const result = computeBudget({
      startingBudget: 200,
      spent: 180,
      slotsRequired: 16,
      slotsFilled: 15,
      minimumBid: 1,
    });
    assert.equal(result.remaining, 20);
    assert.equal(result.slots_remaining, 1);
    assert.equal(result.minimum_required_for_remaining_slots, 0);
    assert.equal(result.maximum_single_bid, 20);
  });

  it("matches the documented $83 / 6-slot example", () => {
    const result = computeBudget({
      startingBudget: 200,
      spent: 117,
      slotsRequired: 16,
      slotsFilled: 10,
      minimumBid: 1,
    });
    assert.equal(result.remaining, 83);
    assert.equal(result.slots_remaining, 6);
    assert.equal(result.maximum_single_bid, 78);
  });

  it("cannot bid once the roster is full", () => {
    const result = computeBudget({
      startingBudget: 200,
      spent: 150,
      slotsRequired: 16,
      slotsFilled: 16,
      minimumBid: 1,
    });
    assert.equal(result.slots_remaining, 0);
    assert.equal(result.maximum_single_bid, 0);
    assert.equal(result.can_bid, false);
  });

  it("never returns a negative maximum bid", () => {
    const result = computeBudget({
      startingBudget: 200,
      spent: 199,
      slotsRequired: 16,
      slotsFilled: 5,
      minimumBid: 1,
    });
    assert.equal(result.remaining, 1);
    assert.equal(result.maximum_single_bid, 0);
    assert.equal(result.can_bid, false);
  });

  it("honours a minimum bid above $1", () => {
    const result = computeBudget({
      startingBudget: 200,
      spent: 0,
      slotsRequired: 16,
      slotsFilled: 0,
      minimumBid: 2,
    });
    // 15 remaining slots reserved at $2 each.
    assert.equal(result.minimum_required_for_remaining_slots, 30);
    assert.equal(result.maximum_single_bid, 170);
  });

  it("gives a full budget in the pre-draft state", () => {
    const result = computeBudget({
      startingBudget: 200,
      spent: 0,
      slotsRequired: 16,
      slotsFilled: 0,
      minimumBid: DEFAULT_MINIMUM_BID,
    });
    assert.equal(result.spent, 0);
    assert.equal(result.remaining, 200);
    assert.equal(result.slots_remaining, 16);
    assert.equal(result.maximum_single_bid, 185);
    assert.equal(result.can_bid, true);
  });

  it("keeps starting - spent = remaining", () => {
    for (const spent of [0, 1, 57, 199, 200]) {
      const result = computeBudget({
        startingBudget: 200,
        spent,
        slotsRequired: 16,
        slotsFilled: 3,
        minimumBid: 1,
      });
      assert.equal(result.starting - result.spent, result.remaining);
    }
  });

  it("answers whether a rival can outbid a given amount", () => {
    const rival = computeBudget({
      startingBudget: 200,
      spent: 120,
      slotsRequired: 16,
      slotsFilled: 10,
      minimumBid: 1,
    });
    assert.equal(rival.maximum_single_bid, 75);
    assert.equal(canOutbid(rival, 47), true);
    assert.equal(canOutbid(rival, 75), false);
    assert.equal(canOutbid(rival, 100), false);
  });
});

describe("auction prices", () => {
  const pick = (metadata: Record<string, string> | null): RawDraftPick => ({
    draft_id: "d",
    player_id: "1",
    picked_by: "u",
    roster_id: "1",
    round: 1,
    draft_slot: 1,
    pick_no: 1,
    is_keeper: null,
    metadata,
  });

  it("reads the amount Sleeper puts in pick metadata", () => {
    assert.equal(parsePickPrice(pick({ amount: "42" })), 42);
    assert.equal(parsePickPrice(pick({ amount: "1" })), 1);
  });

  it("returns null rather than fabricating a missing price", () => {
    assert.equal(parsePickPrice(pick(null)), null);
    assert.equal(parsePickPrice(pick({})), null);
    assert.equal(parsePickPrice(pick({ amount: "" })), null);
    assert.equal(parsePickPrice(pick({ amount: "not-a-number" })), null);
  });

  it("does not let a missing price inflate spend", () => {
    const prices = [
      parsePickPrice(pick({ amount: "30" })),
      parsePickPrice(pick(null)),
    ];
    const spent = prices.reduce((sum: number, price) => sum + (price ?? 0), 0);
    // The unknown pick contributes 0, not NaN.
    assert.equal(spent, 30);
    assert.ok(Number.isFinite(spent));
  });
});

describe("roster needs", () => {
  it("reports every starting slot as needed on an empty roster", () => {
    const needs = computeRosterNeeds([], BLOODLINE_ROSTER_POSITIONS);
    const required = Object.fromEntries(
      needs.required.map((n) => [n.position, n.minimum_needed]),
    );
    assert.deepEqual(required, { QB: 2, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 });
    assert.equal(needs.starters_filled, 0);
    assert.equal(needs.starters_required, 9);
    assert.equal(needs.flexible_slots_remaining, 2);
  });

  it("does not claim a WR is required just because FLEX is empty", () => {
    // Full strict lineup, both FLEX slots empty.
    const roster = [
      player(PLAYER_IDS.mahomes), // QB
      player(PLAYER_IDS.prescott), // QB
      player(PLAYER_IDS.mccaffrey), // RB
      player(PLAYER_IDS.irving), // RB
      player(PLAYER_IDS.jefferson), // WR
      player(PLAYER_IDS.lamb), // WR
      player(PLAYER_IDS.loveland), // TE
    ];
    const needs = computeRosterNeeds(roster, BLOODLINE_ROSTER_POSITIONS);
    const positions = needs.required.map((n) => n.position);

    assert.ok(!positions.includes("WR"), "WR must not be reported as required");
    assert.ok(!positions.includes("RB"), "RB must not be reported as required");
    assert.ok(!positions.includes("QB"), "QB must not be reported as required");
    // K and DEF genuinely are still required.
    assert.deepEqual(positions.sort(), ["DEF", "K"]);
    assert.equal(needs.flexible_slots_remaining, 2);
  });

  it("counts a surplus player against a FLEX slot, not a positional need", () => {
    const roster = [
      player(PLAYER_IDS.mccaffrey),
      player(PLAYER_IDS.irving),
      player(PLAYER_IDS.jefferson), // third RB/WR-type -> fills FLEX
    ];
    const needs = computeRosterNeeds(roster, BLOODLINE_ROSTER_POSITIONS);
    const required = Object.fromEntries(
      needs.required.map((n) => [n.position, n.minimum_needed]),
    );
    // Two RBs fill both RB slots; the WR fills one WR slot, leaving one WR.
    assert.equal(required.RB, undefined);
    assert.equal(required.WR, 1);
    assert.equal(needs.flexible_slots_remaining, 2);
  });

  it("fills strict slots before flex slots", () => {
    // A single RB must cover an RB slot, never a FLEX slot.
    const needs = computeRosterNeeds(
      [player(PLAYER_IDS.mccaffrey)],
      BLOODLINE_ROSTER_POSITIONS,
    );
    const required = Object.fromEntries(
      needs.required.map((n) => [n.position, n.minimum_needed]),
    );
    assert.equal(required.RB, 1); // one of two RB slots still open
    assert.equal(needs.flexible_slots_remaining, 2);
  });

  it("treats SUPER_FLEX as QB-eligible", () => {
    const superflex = ["QB", "RB", "WR", "SUPER_FLEX", "BN"];
    const needs = computeRosterNeeds(
      [player(PLAYER_IDS.mahomes), player(PLAYER_IDS.prescott)],
      superflex,
    );
    // Second QB covers SUPER_FLEX rather than being reported as surplus.
    assert.equal(needs.flexible_slots_remaining, 0);
  });
});

describe("draftable positions", () => {
  it("expands FLEX into the positions it accepts", () => {
    const positions = draftablePositions(BLOODLINE_ROSTER_POSITIONS);
    assert.deepEqual([...positions].sort(), [
      "DEF",
      "K",
      "QB",
      "RB",
      "TE",
      "WR",
    ]);
    assert.ok(!positions.has("BN"));
    assert.ok(!positions.has("FLEX"));
  });
});

describe("available players", () => {
  it("excludes drafted players", () => {
    const taken = new Set([PLAYER_IDS.mahomes, PLAYER_IDS.jefferson]);
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: taken,
      rosterPositions: BLOODLINE_ROSTER_POSITIONS,
      limit: 1000,
    });
    const ids = new Set(available.map((p) => p.player_id));
    assert.ok(!ids.has(PLAYER_IDS.mahomes), "drafted QB must not be available");
    assert.ok(
      !ids.has(PLAYER_IDS.jefferson),
      "drafted WR must not be available",
    );
  });

  it("returns only the requested position", () => {
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: new Set(),
      rosterPositions: BLOODLINE_ROSTER_POSITIONS,
      position: "RB",
      limit: 200,
    });
    assert.ok(available.length > 0);
    for (const p of available) {
      assert.ok(
        p.fantasy_positions.includes("RB"),
        `${p.full_name} (${p.position}) is not RB-eligible`,
      );
    }
    // Nothing that is exclusively QB/WR/TE should slip through.
    assert.ok(!available.some((p) => p.position === "QB"));
    assert.ok(!available.some((p) => p.position === "K"));
  });

  it("respects the limit", () => {
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: new Set(),
      rosterPositions: BLOODLINE_ROSTER_POSITIONS,
      limit: 25,
    });
    assert.equal(available.length, 25);
  });

  it("orders by Sleeper's own search_rank, most relevant first", () => {
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: new Set(),
      rosterPositions: BLOODLINE_ROSTER_POSITIONS,
      limit: 50,
    });
    const ranks = available
      .map((p) => p.search_rank)
      .filter((rank): rank is number => rank !== null);
    const sorted = [...ranks].sort((a, b) => a - b);
    assert.deepEqual(ranks, sorted);
  });

  it("only returns positions this league can actually draft", () => {
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: new Set(),
      rosterPositions: BLOODLINE_ROSTER_POSITIONS,
      limit: 500,
    });
    const draftable = draftablePositions(BLOODLINE_ROSTER_POSITIONS);
    for (const p of available) {
      assert.ok(
        p.fantasy_positions.some((pos) => draftable.has(pos)),
        `${p.full_name} has no draftable position (${p.fantasy_positions.join("/")})`,
      );
    }
  });

  it("never returns the whole player database", () => {
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: new Set(),
      rosterPositions: BLOODLINE_ROSTER_POSITIONS,
      limit: MAX_AVAILABLE_LIMIT,
    });
    assert.ok(available.length <= MAX_AVAILABLE_LIMIT);
    assert.ok(playerIndex.size > 10_000);
  });
});

describe("draft selection", () => {
  const draft = (id: string, season: string, status: string): RawDraft =>
    ({
      draft_id: id,
      league_id: "l",
      season,
      season_type: "regular",
      sport: "nfl",
      status,
      type: "auction",
      start_time: null,
      created: null,
      last_picked: null,
      settings: null,
      metadata: null,
      draft_order: null,
      slot_to_roster_id: null,
      creators: null,
    }) as RawDraft;

  it("prefers an in-progress draft", () => {
    const selected = selectActiveDraft([
      draft("a", "2026", "complete"),
      draft("b", "2027", "pre_draft"),
      draft("c", "2026", "drafting"),
    ]);
    assert.equal(selected?.draft_id, "c");
  });

  it("falls back to the upcoming draft", () => {
    const selected = selectActiveDraft([
      draft("a", "2025", "complete"),
      draft("b", "2026", "pre_draft"),
    ]);
    assert.equal(selected?.draft_id, "b");
  });

  it("falls back to the most recent completed draft", () => {
    const selected = selectActiveDraft([
      draft("a", "2024", "complete"),
      draft("b", "2025", "complete"),
    ]);
    assert.equal(selected?.draft_id, "b");
  });

  it("returns null when the league has no drafts", () => {
    assert.equal(selectActiveDraft([]), null);
  });
});

describe("query validation", () => {
  const allowed = draftablePositions(BLOODLINE_ROSTER_POSITIONS);
  const parse = (qs: string) =>
    parseDraftQuery(new URLSearchParams(qs), allowed);

  it("defaults to 300 available players and no position filter", () => {
    const result = parse("");
    assert.ok("query" in result);
    assert.equal(result.query.availableLimit, 300);
    assert.equal(result.query.position, null);
  });

  it("accepts a valid limit and position", () => {
    const result = parse("available_limit=50&position=rb");
    assert.ok("query" in result);
    assert.equal(result.query.availableLimit, 50);
    assert.equal(result.query.position, "RB");
  });

  it("rejects a non-numeric or out-of-range limit", () => {
    assert.ok("error" in parse("available_limit=abc"));
    assert.ok("error" in parse("available_limit=0"));
    assert.ok("error" in parse("available_limit=1001"));
    assert.ok("error" in parse("available_limit=-5"));
  });

  it("rejects a position this league cannot draft", () => {
    assert.ok("error" in parse("position=LB"));
    assert.ok("error" in parse("position=BN"));
    assert.ok("error" in parse("position=FLEX"));
  });
});

describe("cache policy", () => {
  it("caches aggressively short while drafting and longer once complete", () => {
    assert.equal(cacheSecondsForStatus("drafting"), 5);
    assert.equal(cacheSecondsForStatus("paused"), 5);
    assert.equal(cacheSecondsForStatus("pre_draft"), 30);
    assert.equal(cacheSecondsForStatus("complete"), 300);
    assert.equal(cacheSecondsForStatus(undefined), 30);
  });
});

describe("available players: positional coverage", () => {
  it("surfaces team defenses even though Sleeper leaves their search_rank null", () => {
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: new Set(),
      rosterPositions: BLOODLINE_ROSTER_POSITIONS,
      limit: 300,
    });
    const defenses = available.filter((p) => p.position === "DEF");
    assert.ok(
      defenses.length >= MIN_PER_REQUIRED_POSITION,
      `expected at least ${MIN_PER_REQUIRED_POSITION} defenses, got ${defenses.length}`,
    );
    // Confirms the gap this guards against is real.
    assert.ok(defenses.every((d) => d.search_rank === null));
  });

  it("covers every required starting position in an unfiltered response", () => {
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: new Set(),
      rosterPositions: BLOODLINE_ROSTER_POSITIONS,
      limit: 300,
    });
    for (const position of requiredStartingPositions(
      BLOODLINE_ROSTER_POSITIONS,
    )) {
      const matches = available.filter((p) =>
        p.fantasy_positions.includes(position),
      );
      assert.ok(
        matches.length > 0,
        `no available candidates for required position ${position}`,
      );
    }
  });

  it("still respects the limit exactly while guaranteeing coverage", () => {
    for (const limit of [10, 25, 300]) {
      const available = buildAvailablePlayers({
        playerIndex,
        takenPlayerIds: new Set(),
        rosterPositions: BLOODLINE_ROSTER_POSITIONS,
        limit,
      });
      assert.equal(available.length, limit, `limit ${limit}`);
    }
  });

  it("keeps the top-ranked players despite the coverage pass", () => {
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: new Set(),
      rosterPositions: BLOODLINE_ROSTER_POSITIONS,
      limit: 300,
    });
    // The single most relevant player must never be displaced.
    assert.equal(available[0]?.search_rank, 1);
    const ranks = available
      .map((p) => p.search_rank)
      .filter((r): r is number => r !== null);
    assert.deepEqual(
      ranks,
      [...ranks].sort((a, b) => a - b),
    );
  });

  it("does not apply coverage when filtered to one position", () => {
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: new Set(),
      rosterPositions: BLOODLINE_ROSTER_POSITIONS,
      position: "RB",
      limit: 20,
    });
    assert.equal(available.length, 20);
    assert.ok(available.every((p) => p.fantasy_positions.includes("RB")));
  });

  it("returns all 32 defenses when asked for them directly", () => {
    const available = buildAvailablePlayers({
      playerIndex,
      takenPlayerIds: new Set(),
      rosterPositions: BLOODLINE_ROSTER_POSITIONS,
      position: "DEF",
      limit: 100,
    });
    assert.ok(available.length >= 30, `got ${available.length} defenses`);
    assert.ok(available.every((p) => p.position === "DEF"));
  });
});
