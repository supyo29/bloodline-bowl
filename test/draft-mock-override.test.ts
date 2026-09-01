/**
 * REHEARSAL-ONLY mock-draft override (`?draft_id=`).
 *
 * Smallest-necessary coverage: the pure `deriveMockDraftState` mapping and the
 * Bloodline snake geometry it feeds. The override must (a) attribute picks to the
 * right slot, (b) keep the BLOODLINE geometry frame, (c) surface every drafted
 * player as taken, (d) populate the manager roster from their slot's picks,
 * (e) put the manager "on the clock" at pick 7 and move the next pick to 18.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveMockDraftState } from "@/lib/draft/mock-draft";
import { computeSnakeTurnState } from "@/lib/draft/geometry";
import type { NormalizedPlayer, RawDraft, RawDraftPick } from "@/lib/sleeper/types";

const TEAMS = 12;
const BLOODLINE_ROUNDS = 15; // QB/RB/RB/WR/WR/TE/FLEX/FLEX/K/DEF + 5 BN

function player(id: string, position: string): NormalizedPlayer {
  return {
    player_id: id, full_name: `P-${id}`, first_name: null, last_name: null,
    position, fantasy_positions: [position], team: "AAA", age: 25, years_exp: 3,
    status: null, injury_status: null, number: null, active: true, search_rank: 40,
    depth_chart_order: 1, depth_chart_position: null, resolved: true,
  };
}

/** A 12-team snake mock. `roundsMade` full rounds of best-player-available. */
function mockPicks(roundsMade: number, roundsTotal = 16): RawDraftPick[] {
  const picks: RawDraftPick[] = [];
  let n = 1;
  for (let r = 1; r <= roundsTotal; r++) {
    const order = r % 2 === 1 ? [...Array(TEAMS).keys()].map((i) => i + 1) : [...Array(TEAMS).keys()].map((i) => TEAMS - i);
    for (const slot of order) {
      if (n > roundsMade * TEAMS) return picks;
      picks.push({
        draft_id: "MOCK", player_id: `pl${n}`, picked_by: "", roster_id: null,
        round: r, draft_slot: slot, pick_no: n, is_keeper: null, metadata: null,
      });
      n += 1;
    }
  }
  return picks;
}

function mockMeta(over: Partial<RawDraft> = {}): RawDraft {
  return {
    draft_id: "1396600871957061632", league_id: null as unknown as string, season: "2026",
    season_type: "regular", sport: "nfl", status: "drafting", type: "snake",
    start_time: null, created: null, last_picked: null,
    settings: { teams: 12, rounds: 16, slots_flex: 3 } as Record<string, number>,
    metadata: null, draft_order: null, slot_to_roster_id: null, creators: null,
    ...over,
  };
}

const SUPYO = "1308955807408230400";

function index(picks: RawDraftPick[]): Map<string, NormalizedPlayer> {
  const positions = ["RB", "WR", "WR", "RB", "TE", "QB"];
  const m = new Map<string, NormalizedPlayer>();
  picks.forEach((p, i) => { if (p.player_id) m.set(p.player_id, player(p.player_id, positions[i % positions.length]!)); });
  return m;
}

describe("mock-draft override — deriveMockDraftState", () => {
  it("defaults supyo29 to slot 7 when the mock has no draft_order entry", () => {
    const picks = mockPicks(1);
    const s = deriveMockDraftState({
      meta: mockMeta({ draft_order: { "someone-else": 5 } }),
      picks, playerIndex: index(picks), managerUserId: SUPYO,
      requestedSlot: null, numTeams: TEAMS, rounds: BLOODLINE_ROUNDS,
    });
    assert.equal(s.applied_slot, 7);
    assert.equal(s.info.slot_source, "default_slot_7");
  });

  it("honours an explicit ?slot= when the mock has no mapping", () => {
    const picks = mockPicks(1);
    const s = deriveMockDraftState({
      meta: mockMeta(), picks, playerIndex: index(picks), managerUserId: SUPYO,
      requestedSlot: 3, numTeams: TEAMS, rounds: BLOODLINE_ROUNDS,
    });
    assert.equal(s.applied_slot, 3);
    assert.equal(s.info.slot_source, "explicit_request");
  });

  it("prefers the mock's own draft_order when it maps this manager", () => {
    const picks = mockPicks(1);
    const s = deriveMockDraftState({
      meta: mockMeta({ draft_order: { [SUPYO]: 10 } }), picks, playerIndex: index(picks),
      managerUserId: SUPYO, requestedSlot: 4, numTeams: TEAMS, rounds: BLOODLINE_ROUNDS,
    });
    assert.equal(s.applied_slot, 10);
    assert.equal(s.info.slot_source, "mock_draft_order");
  });

  it("marks every drafted player as taken and reports the mock config verbatim", () => {
    const picks = mockPicks(3); // 36 picks
    const s = deriveMockDraftState({
      meta: mockMeta(), picks, playerIndex: index(picks), managerUserId: SUPYO,
      requestedSlot: null, numTeams: TEAMS, rounds: BLOODLINE_ROUNDS,
    });
    assert.equal(s.completed_picks.length, 36);
    assert.deepEqual(s.completed_picks.map((p) => p.player_id).slice(0, 3), ["pl1", "pl2", "pl3"]);
    assert.equal(s.info.mock_teams, 12);
    assert.equal(s.info.mock_rounds, 16);
    assert.equal(s.info.applied_teams, 12);
    assert.equal(s.info.applied_rounds, 15); // Bloodline frame, not the mock's 16
  });

  it("builds the manager roster from their slot's picks, clamped to the Bloodline frame", () => {
    const picks = mockPicks(16); // a COMPLETE 16-round mock = 192 picks
    const s = deriveMockDraftState({
      meta: mockMeta({ status: "complete" }), picks, playerIndex: index(picks),
      managerUserId: SUPYO, requestedSlot: null, numTeams: TEAMS, rounds: BLOODLINE_ROUNDS,
    });
    // slot 7 has 16 mock picks; only the 15 within overall<=180 count.
    assert.equal(s.roster_players.length, 15);
    // slot-7 pick_no sequence is exactly the Bloodline slot-7 geometry
    const slot7Overalls = picks.filter((p) => p.draft_slot === 7).map((p) => p.pick_no).slice(0, 15);
    assert.deepEqual(slot7Overalls, [7, 18, 31, 42, 55, 66, 79, 90, 103, 114, 127, 138, 151, 162, 175]);
  });

  it("feeds Bloodline geometry: 6 mock picks ⇒ supyo on the clock at 7; 7 ⇒ next pick 18", () => {
    for (const [made, expectCurrent, expectNext] of [[6, 7, 18], [7, 18, 31]] as const) {
      const picks = Array.from({ length: made }, (_, i) => ({
        draft_id: "MOCK", player_id: `pl${i + 1}`, picked_by: "", roster_id: null,
        round: 1, draft_slot: i + 1, pick_no: i + 1, is_keeper: null, metadata: null,
      })) as RawDraftPick[];
      const s = deriveMockDraftState({
        meta: mockMeta(), picks, playerIndex: index(picks), managerUserId: SUPYO,
        requestedSlot: null, numTeams: TEAMS, rounds: BLOODLINE_ROUNDS,
      });
      const turn = computeSnakeTurnState({
        slot: s.applied_slot, teamCount: TEAMS, rounds: BLOODLINE_ROUNDS,
        overallPicksMade: s.completed_picks.length, order: "snake",
      });
      assert.equal(turn.current_pick?.overall, expectCurrent, `made ${made}: current`);
      assert.equal(turn.next_manager_pick?.overall, expectNext, `made ${made}: next`);
    }
  });

  it("a completed 16-round mock (192 picks) drives slot 7 to a terminal state under Bloodline geometry", () => {
    const picks = mockPicks(16);
    const s = deriveMockDraftState({
      meta: mockMeta({ status: "complete" }), picks, playerIndex: index(picks),
      managerUserId: SUPYO, requestedSlot: null, numTeams: TEAMS, rounds: BLOODLINE_ROUNDS,
    });
    const turn = computeSnakeTurnState({
      slot: 7, teamCount: TEAMS, rounds: BLOODLINE_ROUNDS,
      overallPicksMade: s.completed_picks.length, order: "snake",
    });
    assert.equal(turn.current_pick, null, "slot 7 has no pick left in a 15-round frame once 192 picks are in");
  });
});
