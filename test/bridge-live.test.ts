/**
 * Draft Bridge — live smoke tests against the real Sleeper API.
 *
 * Requires network access. Both leagues are pre-draft, so these assert the
 * invariants that must hold in any state plus the deterministic DarthMarker
 * mock-draft walkthrough the addendum requires (§29) and the Bloodline control
 * (§30).
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { buildBridgeBoard } from "../lib/bridge/board";
import {
  emptyDraftState,
  markPlayer,
  overallPicksMade,
  type BridgeDraftState,
} from "../lib/bridge/state";
import { buildBridgeSnapshot, renderSnapshotText } from "../lib/bridge/snapshot";
import { findBridgeProfile } from "../lib/bridge/profiles";
import { computeDraftGeometry } from "../lib/bridge/geometry";
import type { BridgeBoardResponse } from "../lib/bridge/board";

const BLOODLINE = findBridgeProfile("bloodline_bowl")!;
const DEVOTED = findBridgeProfile("devoted_to_the_game")!;

describe("live: bridge board resolves each league in isolation", () => {
  let bloodline: BridgeBoardResponse;
  let devoted: BridgeBoardResponse;

  before(async () => {
    [bloodline, devoted] = await Promise.all([
      buildBridgeBoard("bloodline_bowl"),
      buildBridgeBoard("devoted_to_the_game"),
    ]);
  });

  it("returns the requested league, never the other", () => {
    assert.equal(bloodline.league_identity.league_key, "bloodline_bowl");
    assert.equal(bloodline.league_identity.platform_league_id, BLOODLINE.platform_league_id);
    assert.equal(devoted.league_identity.league_key, "devoted_to_the_game");
    assert.equal(devoted.league_identity.platform_league_id, DEVOTED.platform_league_id);
  });

  it("gives each league its own scoring identity", () => {
    assert.notEqual(
      bloodline.scoring.scoring_sha256,
      devoted.scoring.scoring_sha256,
    );
    // Devoted is full PPR; Bloodline is not.
    assert.equal(devoted.scoring.ppr_label, "full_ppr");
    assert.notEqual(bloodline.scoring.ppr_label, "full_ppr");
  });

  it("confirms DarthMarker at draft slot 4 from Sleeper's live draft_order", () => {
    assert.equal(devoted.league_identity.draft_slot, 4);
    assert.equal(devoted.league_identity.draft_slot_source, "sleeper_draft_order");
    const me = devoted.draft_feed.slots.find((s) => s.is_me);
    assert.equal(me?.slot, 4);
  });

  it("activates the DarthMarker v7 ranking pack against live scoring + roster", () => {
    assert.equal(devoted.model_profile.ranking_source, "model_pack");
    assert.equal(devoted.model_profile.ranking_fallback_active, false);
    assert.equal(devoted.ranking_quality.status, "MODEL");
    assert.ok(devoted.ranking_pack);
    assert.equal(devoted.ranking_pack!.status, "ACTIVE");
    assert.equal(devoted.ranking_pack!.scoring_status, "MATCH");
    assert.equal(devoted.ranking_pack!.roster_status, "MATCH");
    assert.equal(devoted.ranking_pack!.model_version, "v7");
    assert.equal(devoted.ranking_pack!.player_count, 240);
    assert.equal(devoted.ranking_pack!.missing_from_sleeper.length, 0);
    // Board order comes from the model, not Sleeper. Before the draft the top
    // of the pool is model rank 1; once players are drafted it is simply the
    // lowest still-available model rank, and the pool stays model-ordered.
    const topModelRank = devoted.pool[0]!.model_rank;
    assert.ok(topModelRank != null && topModelRank >= 1);
    if (devoted.draft_feed.status === "pre_draft") {
      assert.equal(topModelRank, 1);
    }
    const modelRanked = devoted.pool
      .map((p) => p.model_rank)
      .filter((r): r is number => r != null);
    for (let i = 1; i < modelRanked.length; i += 1) {
      assert.ok(modelRanked[i]! >= modelRanked[i - 1]!, "pool stays model-ordered");
    }
    assert.ok(devoted.pool[0]!.model_value! > 0);
    // No Bloodline identity leaked in.
    assert.ok(
      !JSON.stringify(devoted).includes("bloodline_production_20260827113702"),
    );
    assert.ok(!/bloodline/i.test(JSON.stringify(devoted.model_profile)));
  });

  it("keeps Bloodline's declared (unverified) candidate id", () => {
    assert.equal(
      bloodline.model_profile.candidate_id,
      "bloodline_production_20260827113702",
    );
    assert.equal(bloodline.model_profile.candidate_verified, false);
  });

  it("ranks a non-empty available pool for each league", () => {
    assert.ok(devoted.pool.length > 100);
    assert.ok(bloodline.pool.length > 100);
    // pool[0].rank == 1 only before any player is drafted; otherwise it is the
    // best still-available rank. Either way the pool must be rank-ordered.
    assert.ok((devoted.pool[0]!.rank ?? Infinity) >= 1);
    if (devoted.draft_feed.status === "pre_draft") {
      assert.equal(devoted.pool[0]!.rank, 1);
    }
  });

  it("validates its own draft feed as belonging to the league", () => {
    assert.equal(devoted.draft_feed.source_check.ok, true);
    assert.equal(bloodline.draft_feed.source_check.ok, true);
  });
});

describe("live: DarthMarker deterministic mock draft (addendum §29)", () => {
  let board: BridgeBoardResponse;

  before(async () => {
    board = await buildBridgeBoard("devoted_to_the_game");
  });

  it("produces a self-identifying snapshot after a few mock picks", () => {
    let state: BridgeDraftState = {
      ...emptyDraftState(DEVOTED),
      scoring_sha: board.scoring.scoring_sha256,
    };
    // Draft the top 3 off the board to other teams, take the 4th.
    const [p1, p2, p3, mine] = board.pool;
    state = markPlayer(state, p1!.player_id, "drafted", {
      player: {
        name: p1!.name,
        position: p1!.position,
        team: p1!.team,
        fantasy_positions: p1!.fantasy_positions,
      },
      pick_no: 1,
      round: 1,
    });
    state = markPlayer(state, p2!.player_id, "drafted", { pick_no: 2, round: 1 });
    state = markPlayer(state, p3!.player_id, "drafted", { pick_no: 3, round: 1 });
    state = markPlayer(state, mine!.player_id, "mine", {
      player: {
        name: mine!.name,
        position: mine!.position,
        team: mine!.team,
        fantasy_positions: mine!.fantasy_positions,
      },
      pick_no: 4,
      round: 1,
    });

    const snap = buildBridgeSnapshot({
      activeLeagueKey: "devoted_to_the_game",
      board,
      state,
    });

    assert.equal(snap.integrity.verdict, "PASS");
    assert.match(snap.snapshot_title, /DARTHMARKER/);
    assert.equal(snap.league_identity.league_name, "Devoted to the Game");
    assert.equal(snap.league_identity.draft_slot, 4);
    assert.equal((snap.draft_state.my_team as unknown[]).length, 1);

    const geo = snap.draft_state.geometry as Record<string, unknown>;
    const nextPick = geo.next_pick as { overall: number } | null;
    if (board.draft_feed.status === "pre_draft") {
      // 4 mock picks, slot 4 → next pick is overall 21 (round 2).
      assert.equal(nextPick?.overall, 21);
    } else {
      // The real draft has already run; geometry reflects the live pick count
      // (either a valid remaining pick or null once slot 4 is done). Just
      // require it to be internally consistent.
      if (nextPick) {
        assert.ok(nextPick.overall > (geo.picks_until_next as number));
      }
    }

    const text = JSON.stringify(snap);
    assert.ok(!/bloodline/i.test(text));
    assert.ok(!text.includes("1395549281678532608"));

    // best_available excludes the 4 marked players.
    const baIds = (
      snap.best_available_overall as Array<{ player_id: string }>
    ).map((p) => p.player_id);
    assert.ok(!baIds.includes(mine!.player_id));
    assert.ok(!baIds.includes(p1!.player_id));

    // Plain-text companion names the league on line 1.
    assert.match(renderSnapshotText(snap).split("\n")[0]!, /DEVOTED TO THE GAME/);
  });

  it("derives geometry from the active league's own slot/rounds", () => {
    const state = emptyDraftState(DEVOTED);
    const geo = computeDraftGeometry({
      slot: board.league_identity.draft_slot!,
      teamCount: board.rules.team_count,
      rounds: board.rules.rounds,
      overallPicksMade: overallPicksMade(state),
      order: "snake",
    });
    assert.equal(geo.rounds, 16);
    assert.equal(geo.all_picks[0]!.overall, 4);
  });
});

describe("live: Bloodline control (addendum §30)", () => {
  it("carries candidate_id bloodline_production_20260827113702 and no DarthMarker identity", async () => {
    const board = await buildBridgeBoard("bloodline_bowl");
    const state = {
      ...emptyDraftState(BLOODLINE),
      scoring_sha: board.scoring.scoring_sha256,
    };
    const snap = buildBridgeSnapshot({
      activeLeagueKey: "bloodline_bowl",
      board,
      state,
    });
    assert.equal(
      (snap.model as Record<string, unknown>).candidate_id,
      "bloodline_production_20260827113702",
    );
    const text = JSON.stringify(snap);
    assert.ok(!/darthmarker/i.test(text));
    assert.ok(!/devoted/i.test(text));
    assert.ok(!/rosterintel/i.test(text));
    assert.ok(!text.includes("1389735763649761280"));
    // Bloodline runs on Sleeper market ordering; no model pack.
    assert.equal((snap.ranking_quality as Record<string, unknown>).status, "MARKET");
    assert.equal(snap.ranking_pack, null);
  });
});
