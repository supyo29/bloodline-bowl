/**
 * REHEARSAL-ONLY mock-draft override (`?draft_id=`) — lifecycle + framing +
 * source-integrity regression suite.
 *
 * The engine, projections, market, survival, tiers, weights and geometry are
 * frozen and untouched. These tests cover ONLY the Sleeper draft-state ingestion
 * boundary: the Bloodline-frame clamp, slot resolution, per-manager roster
 * attribution, terminal-state derivation, and VALID / DEGRADED / INVALID
 * classification.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveMockDraftState, validateMockDraftState } from "@/lib/draft/mock-draft";
import { computeSnakeTurnState } from "@/lib/draft/geometry";
import type { NormalizedPlayer, RawDraft, RawDraftPick } from "@/lib/sleeper/types";

const TEAMS = 12;
const BLOODLINE_ROUNDS = 15; // QB/RB/RB/WR/WR/TE/FLEX/FLEX/K/DEF + 5 BN
const FRAME = TEAMS * BLOODLINE_ROUNDS; // 180
const SUPYO = "1308955807408230400";
const MOCK_ID = "1396600871957061632";

const SLOT7_PICKS = [7, 18, 31, 42, 55, 66, 79, 90, 103, 114, 127, 138, 151, 162, 175];

function player(id: string, position: string, name = `P-${id}`): NormalizedPlayer {
  return {
    player_id: id, full_name: name, first_name: null, last_name: null,
    position, fantasy_positions: [position], team: "AAA", age: 25, years_exp: 3,
    status: null, injury_status: null, number: null, active: true, search_rank: 40,
    depth_chart_order: 1, depth_chart_position: null, resolved: true,
  };
}

function meta(over: Partial<RawDraft> = {}): RawDraft {
  return {
    draft_id: MOCK_ID, league_id: null as unknown as string, season: "2026",
    season_type: "regular", sport: "nfl", status: "drafting", type: "snake",
    start_time: null, created: 1787338104620, last_picked: 1787773751588,
    settings: { teams: 12, rounds: 16, slots_flex: 3 } as Record<string, number>,
    metadata: null, draft_order: null, slot_to_roster_id: null, creators: null,
    ...over,
  };
}

/** `roundsMade` full snake rounds of sequential picks over a `roundsTotal`-round mock. */
function picksThroughRounds(roundsMade: number, roundsTotal = 16): RawDraftPick[] {
  const out: RawDraftPick[] = [];
  let n = 1;
  for (let r = 1; r <= roundsTotal; r++) {
    const order = r % 2 === 1
      ? Array.from({ length: TEAMS }, (_, i) => i + 1)
      : Array.from({ length: TEAMS }, (_, i) => TEAMS - i);
    for (const slot of order) {
      if (n > roundsMade * TEAMS) return out;
      out.push({
        draft_id: MOCK_ID, player_id: `pl${n}`, picked_by: "", roster_id: null,
        round: r, draft_slot: slot, pick_no: n, is_keeper: null, metadata: null,
      });
      n += 1;
    }
  }
  return out;
}

/** `n` sequential first-round picks (draft_slot == pick_no). */
function firstRoundPicks(n: number): RawDraftPick[] {
  return Array.from({ length: n }, (_, i) => ({
    draft_id: MOCK_ID, player_id: `pl${i + 1}`, picked_by: "", roster_id: null,
    round: 1, draft_slot: i + 1, pick_no: i + 1, is_keeper: null, metadata: null,
  }));
}

function index(picks: RawDraftPick[]): Map<string, NormalizedPlayer> {
  const positions = ["RB", "WR", "WR", "RB", "TE", "QB"];
  const m = new Map<string, NormalizedPlayer>();
  picks.forEach((p, i) => { if (p.player_id) m.set(p.player_id, player(p.player_id, positions[i % positions.length]!)); });
  return m;
}

function derive(picks: RawDraftPick[], m: RawDraft, requestedSlot: number | null = null) {
  return deriveMockDraftState({
    meta: m, picks, playerIndex: index(picks), managerUserId: SUPYO,
    requestedDraftId: m.draft_id, requestedSlot, numTeams: TEAMS, rounds: BLOODLINE_ROUNDS,
  });
}

function turnFor(state: ReturnType<typeof derive>) {
  return computeSnakeTurnState({
    slot: state.applied_slot, teamCount: TEAMS, rounds: BLOODLINE_ROUNDS,
    overallPicksMade: state.completed_picks.length, order: "snake",
  });
}

describe("mock override — lifecycle", () => {
  it("Test 1 — pre_draft, no picks: engine not terminal, next pick 7", () => {
    const s = derive([], meta({ status: "pre_draft" }));
    assert.equal(s.completed_picks.length, 0);
    assert.equal(s.roster_players.length, 0);
    assert.equal(s.diagnostics.framed_pick_count, 0);
    const t = turnFor(s);
    assert.equal(t.current_pick?.overall, 7);
    assert.notEqual(t.current_pick, null);
    assert.equal(s.diagnostics.state_validation, "DEGRADED"); // 16 vs 15 rounds
  });

  it("Test 2 — 6 picks (before slot 7): manager roster empty, current/next pick 7", () => {
    const s = derive(firstRoundPicks(6), meta({ status: "drafting" }));
    const t = turnFor(s);
    assert.equal(s.completed_picks.length, 6);
    assert.equal(s.roster_players.length, 0);
    assert.equal(t.current_pick?.overall, 7);
  });

  it("Test 3 — 7 picks (after our pick 7): roster 1, player unavailable, next pick 18", () => {
    const picks = firstRoundPicks(7); // pick 7 is draft_slot 7 == supyo
    const s = derive(picks, meta({ status: "drafting" }));
    const t = turnFor(s);
    assert.equal(s.roster_players.length, 1);
    assert.equal(s.roster_players[0]!.player_id, "pl7");
    assert.ok(s.completed_picks.some((p) => p.player_id === "pl7"), "pl7 is a completed pick (removed from availability)");
    assert.equal(t.current_pick?.overall, 18);
    assert.equal(s.diagnostics.manager_source_picks.join(","), "7");
  });

  it("Test 4 — 18 picks: manager owns 7 and 18, next pick 31", () => {
    const s = derive(picksThroughRounds(2).slice(0, 18), meta({ status: "drafting" }));
    const t = turnFor(s);
    assert.deepEqual(s.diagnostics.manager_source_picks, [7, 18]);
    assert.equal(s.roster_players.length, 2);
    assert.equal(t.current_pick?.overall, 31);
  });

  it("Test 5 — the real rehearsal: picks 7/18/31/42 → own_picks_made 4, roster 4, next pick 55", () => {
    // 42 sequential picks; supyo (slot 7) owns overalls 7, 18, 31, 42.
    const picks = picksThroughRounds(4).slice(0, 42);
    // name the four manager picks so the assertion is legible
    const idx = index(picks);
    idx.set("pl7", player("pl7", "WR", "Amon-Ra St. Brown"));
    idx.set("pl18", player("pl18", "RB", "Chase Brown"));
    idx.set("pl31", player("pl31", "WR", "Rashee Rice"));
    idx.set("pl42", player("pl42", "WR", "Ladd McConkey"));
    const s = deriveMockDraftState({
      meta: meta({ status: "drafting" }), picks, playerIndex: idx, managerUserId: SUPYO,
      requestedDraftId: MOCK_ID, requestedSlot: null, numTeams: TEAMS, rounds: BLOODLINE_ROUNDS,
    });
    const t = computeSnakeTurnState({
      slot: 7, teamCount: TEAMS, rounds: BLOODLINE_ROUNDS,
      overallPicksMade: s.completed_picks.length, order: "snake",
    });
    assert.equal(t.own_picks_made, 4, "own picks made");
    assert.equal(s.roster_players.length, 4, "roster count");
    assert.deepEqual(s.roster_players.map((p) => p.full_name),
      ["Amon-Ra St. Brown", "Chase Brown", "Rashee Rice", "Ladd McConkey"]);
    assert.equal(t.current_pick?.overall, 55, "next pick");
    for (const id of ["pl7", "pl18", "pl31", "pl42"]) {
      assert.ok(s.completed_picks.some((p) => p.player_id === id), `${id} unavailable`);
    }
    assert.notEqual(t.current_pick, null, "engine still active");
  });
});

describe("mock override — 16-round framing (Phase B)", () => {
  it("Test 6 — a 192-pick / 16-round mock is clamped to the 180-pick Bloodline frame", () => {
    const picks = picksThroughRounds(16); // 192 genuine picks
    assert.equal(picks.length, 192);
    const s = derive(picks, meta({ status: "complete", settings: { teams: 12, rounds: 16 } as Record<string, number> }));
    assert.equal(s.diagnostics.raw_pick_count, 192);
    assert.equal(s.diagnostics.framed_pick_count, 180);
    assert.equal(s.diagnostics.raw_max_pick_no, 192);
    assert.equal(s.diagnostics.framed_max_pick_no, 180);
    assert.equal(s.diagnostics.picks_discarded_outside_frame, 12);
    assert.equal(s.completed_picks.length, 180);
    assert.ok(s.completed_picks.every((p) => p.overall <= FRAME), "no completed pick beyond 180");
    // manager owns exactly 15 framed picks (the 16th-round pick #186 is excluded)
    assert.equal(s.roster_players.length, 15);
    assert.deepEqual(s.diagnostics.manager_source_picks, SLOT7_PICKS);
    // terminal state derives from 180, never 192
    const t = turnFor(s);
    assert.equal(t.overall_picks_made, 180);
    assert.equal(t.current_pick, null); // slot 7 has spent all 15 within the 15-round frame
  });

  it("Test 7 — the incident regression: overall_picks_made can NEVER be 192 in a 15-round frame", () => {
    const picks = picksThroughRounds(16);
    const s = derive(picks, meta({ status: "complete" }));
    const t = turnFor(s);
    assert.notEqual(t.overall_picks_made, 192);
    assert.ok(t.overall_picks_made <= FRAME, `overall_picks_made ${t.overall_picks_made} <= ${FRAME}`);
    assert.ok(s.completed_picks.length <= FRAME);
    // round-16 selections (pick_no 181..192) cannot touch availability
    for (let pn = 181; pn <= 192; pn++) {
      assert.ok(!s.completed_picks.some((p) => p.overall === pn), `pick ${pn} excluded from completed_picks`);
    }
  });
});

describe("mock override — source-integrity validation (Phase C)", () => {
  const baseArgs = {
    numTeams: TEAMS, rounds: BLOODLINE_ROUNDS, frameLimit: FRAME,
    rawPickCount: 10, framedPickCount: 10, framedMaxPickNo: 10,
    framedPickNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], rawHasNonPositiveIntPickNo: false,
    managerSourcePicks: [7], managerExpectedPickNumbers: SLOT7_PICKS,
    requestedDraftId: MOCK_ID,
  };

  it("Test 8 — duplicate overall pick numbers → INVALID", () => {
    const r = validateMockDraftState({
      ...baseArgs, meta: meta({ status: "drafting" }),
      framedPickNumbers: [1, 2, 3, 3, 4], framedPickCount: 5, framedMaxPickNo: 4,
    });
    assert.equal(r.state_validation, "INVALID");
    assert.ok(r.validation_reasons.some((x) => /duplicate/i.test(x)));
  });

  it("Test 9 — a manager selection at a pick that cannot be their slot → INVALID", () => {
    const r = validateMockDraftState({
      ...baseArgs, meta: meta({ status: "drafting" }),
      managerSourcePicks: [7, 19], // 19 is not in slot-7 geometry
    });
    assert.equal(r.state_validation, "INVALID");
    assert.ok(r.validation_reasons.some((x) => /cannot belong to slot/i.test(x)));
  });

  it("more INVALID: draft-id mismatch, framed > frame, too many manager picks, bad pick_no", () => {
    assert.equal(validateMockDraftState({ ...baseArgs, meta: meta({ draft_id: "999" }) }).state_validation, "INVALID");
    assert.equal(validateMockDraftState({ ...baseArgs, meta: meta(), framedPickCount: FRAME + 1 }).state_validation, "INVALID");
    assert.equal(validateMockDraftState({ ...baseArgs, meta: meta(), managerSourcePicks: [...SLOT7_PICKS, 999] }).state_validation, "INVALID");
    assert.equal(validateMockDraftState({ ...baseArgs, meta: meta(), rawHasNonPositiveIntPickNo: true }).state_validation, "INVALID");
    assert.equal(validateMockDraftState({ ...baseArgs, meta: meta({ type: "" }) }).state_validation, "INVALID");
  });

  it("DEGRADED: complete draft, round mismatch, status/progression conflict", () => {
    assert.equal(validateMockDraftState({ ...baseArgs, meta: meta({ status: "complete" }) }).state_validation, "DEGRADED");
    assert.equal(validateMockDraftState({ ...baseArgs, meta: meta({ settings: { teams: 12, rounds: 16 } as Record<string, number> }) }).state_validation, "DEGRADED");
    assert.equal(validateMockDraftState({ ...baseArgs, meta: meta({ status: "pre_draft" }), framedPickCount: 5 }).state_validation, "DEGRADED");
    assert.equal(validateMockDraftState({ ...baseArgs, meta: meta({ status: "drafting", settings: { rounds: 15, teams: 12 } as Record<string, number> }), rawPickCount: 0, framedPickCount: 0, framedPickNumbers: [] }).state_validation, "DEGRADED");
  });

  it("VALID: in-progress, matching frame, geometry-consistent", () => {
    const r = validateMockDraftState({
      ...baseArgs,
      meta: meta({ status: "drafting", settings: { teams: 12, rounds: 15 } as Record<string, number> }),
    });
    assert.equal(r.state_validation, "VALID");
    assert.deepEqual(r.validation_reasons, []);
  });

  it("an INVALID payload's diagnostics carry the reasons (engine must be withheld upstream)", () => {
    const picks = [
      ...firstRoundPicks(6),
      { draft_id: MOCK_ID, player_id: "dup", picked_by: "", roster_id: null, round: 1, draft_slot: 7, pick_no: 6, is_keeper: null, metadata: null },
    ] as RawDraftPick[];
    const s = derive(picks, meta({ status: "drafting" }));
    assert.equal(s.diagnostics.state_validation, "INVALID");
  });
});

describe("mock override — slot resolution + real-draft parity", () => {
  it("defaults supyo29 to slot 7; honours ?slot=; prefers the mock's draft_order", () => {
    assert.equal(derive(firstRoundPicks(1), meta()).applied_slot, 7);
    assert.equal(derive(firstRoundPicks(1), meta()).diagnostics.slot_source, "default_slot_7");
    assert.equal(derive(firstRoundPicks(1), meta(), 3).applied_slot, 3);
    assert.equal(derive(firstRoundPicks(1), meta(), 3).diagnostics.slot_source, "explicit_request");
    assert.equal(derive(firstRoundPicks(1), meta({ draft_order: { [SUPYO]: 10 } }), 3).applied_slot, 10);
    assert.equal(derive(firstRoundPicks(1), meta({ draft_order: { [SUPYO]: 10 } }), 3).diagnostics.slot_source, "mock_draft_order");
  });

  it("Test 10 — production path (no draft_id) is exercised by draft-recommendation.test.ts; this module never runs for it", () => {
    // deriveMockDraftState is ONLY called from the mock branch of the service.
    // Assert the module has no side effects on import and is pure given inputs.
    const a = derive(firstRoundPicks(5), meta({ status: "drafting" }));
    const b = derive(firstRoundPicks(5), meta({ status: "drafting" }));
    assert.deepEqual(a.completed_picks, b.completed_picks);
    assert.deepEqual(a.diagnostics.manager_expected_pick_numbers, SLOT7_PICKS);
  });

  it("recent_picks carries the last 5 framed picks with resolved names", () => {
    const s = derive(picksThroughRounds(2).slice(0, 18), meta({ status: "drafting" }));
    assert.equal(s.diagnostics.recent_picks.length, 5);
    assert.deepEqual(s.diagnostics.recent_picks.map((p) => p.pick_no), [14, 15, 16, 17, 18]);
    assert.ok(s.diagnostics.recent_picks.every((p) => typeof p.player_name === "string" && p.player_name.length > 0));
  });
});
