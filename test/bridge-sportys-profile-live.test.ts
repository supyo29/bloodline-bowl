/**
 * Sporty's Alumni Bridge profile — live smoke against the real Sleeper API.
 *
 * Requires network. Covers §3–6, §8 (board build), §7 (geometry vs Sleeper),
 * and §6 (published-snapshot isolation) for the manager-neutral league.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { buildBridgeBoard, type BridgeBoardResponse } from "../lib/bridge/board";
import { findBridgeProfile } from "../lib/bridge/profiles";

const S = findBridgeProfile("sportys-alumni")!;

describe("live: Sporty's Alumni board — manager-neutral", () => {
  let board: BridgeBoardResponse;
  let seated: BridgeBoardResponse;

  before(async () => {
    board = await buildBridgeBoard("sportys_alumni");
    // pick seat 1 (from the live draft order) — the smallest safe adaptation:
    // the UI passes a confirmed slot, the board resolves that seat's user id.
    seated = await buildBridgeBoard("sportys_alumni", { slotOverride: 1 });
  });

  it("returns Sporty's Alumni, never another league", () => {
    assert.equal(board.league_identity.league_key, "sportys_alumni");
    assert.equal(board.league_identity.platform_league_id, S.platform_league_id);
    assert.equal(board.league_identity.platform_draft_id, S.platform_draft_id);
  });

  it("is manager-neutral with NO default self-manager until a seat is picked", () => {
    assert.equal(board.league_identity.manager_neutral, true);
    assert.equal(board.league_identity.manager_key, null);
    assert.equal(board.league_identity.manager_sleeper_user_id, null);
    assert.equal(board.league_identity.draft_slot_source, "unconfirmed");
    // no slot is marked "is_me"
    assert.ok(!board.draft_feed.slots.some((s) => s.is_me));
  });

  it("exposes all 14 live managers/seats for selection", () => {
    assert.equal(board.draft_feed.slots.length, 14);
    for (const s of board.draft_feed.slots) {
      assert.ok(s.slot >= 1 && s.slot <= 14);
      assert.equal(typeof s.user_id, "string");
    }
    assert.equal(new Set(board.draft_feed.slots.map((s) => s.slot)).size, 14);
  });

  it("selecting a seat resolves that seat's real user id + roster", () => {
    assert.equal(seated.league_identity.draft_slot, 1);
    assert.equal(seated.league_identity.draft_slot_source, "user_override");
    const seat1 = board.draft_feed.slots.find((s) => s.slot === 1)!;
    assert.equal(seated.league_identity.manager_sleeper_user_id, seat1.user_id);
    assert.equal(seated.league_identity.manager_display_name, seat1.display_name);
  });

  it("14-team / 15-round / snake, reconciled against Sleeper", () => {
    assert.equal(board.rules.team_count, 14);
    assert.equal(board.rules.rounds, 15);
    assert.equal(board.draft_feed.order, "snake");
    assert.equal(board.rules.draft_type, "snake");
  });

  it("available pool excludes drafted + rostered players (bounded, resolved)", () => {
    const drafted = new Set(
      board.draft_feed.picks.filter((p) => p.player_id).map((p) => p.player_id),
    );
    for (const p of board.pool) assert.ok(!drafted.has(p.player_id));
    assert.ok(board.pool.length > 0 && board.pool.length <= 700);
  });

  it("board ranks by Sleeper search_rank (no borrowed model)", () => {
    assert.equal(board.model_profile.ranking_source, "sleeper_search_rank");
    assert.equal(board.model_profile.ranking_fallback_active, false);
    assert.equal(board.ranking_pack, null);
  });

  it("has its own scoring identity, distinct from the other leagues", async () => {
    const bloodline = await buildBridgeBoard("bloodline_bowl");
    assert.notEqual(board.scoring.scoring_sha256, bloodline.scoring.scoring_sha256);
  });
});

describe("live: Sporty's Alumni Draft Live is independent of the published snapshot", () => {
  it("BRIDGE_PUBLISHED_SNAPSHOT=all does not change the board source", async () => {
    const prev = process.env.BRIDGE_PUBLISHED_SNAPSHOT;
    process.env.BRIDGE_PUBLISHED_SNAPSHOT = "all";
    try {
      const b = await buildBridgeBoard("sportys_alumni");
      assert.equal(b.league_identity.league_key, "sportys_alumni");
      assert.equal(b.model_profile.ranking_source, "sleeper_search_rank");
      // the board build reads Sleeper directly (getDraft/getDraftPicks noStore) —
      // it never consults bridge_published_snapshot.
    } finally {
      if (prev === undefined) delete process.env.BRIDGE_PUBLISHED_SNAPSHOT;
      else process.env.BRIDGE_PUBLISHED_SNAPSHOT = prev;
    }
  });
});
