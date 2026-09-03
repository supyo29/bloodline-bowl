/**
 * Trade Engine — Phase 1 foundation (deterministic, no network).
 *
 * Proves the central invariant: a fantasy asset's trade value is the MARGINAL
 * effect it has on the receiving and sending rosters — recomputed from scratch
 * through the same optimal-lineup / VOR / positional-need machinery — not its
 * standalone player ranking.
 *
 * Covers: validation failure codes, before/after reconstruction, 2-team and
 * 3-team trades (circular + non-circular routing, no A<->C exchange), lineup
 * displacement vs raw-value divergence, acceptance is roster-specific,
 * thresholds are configurable, and determinism.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { player, proj, roster, weeklyContext, STD_CONSTRAINTS } from "./fixtures/weekly";
import { reconstructRosters } from "../lib/trades/reconstruct";
import { validateTrade, type TradeResolution } from "../lib/trades/validate";
import { evaluateTrade, type TradeEvaluationInput } from "../lib/trades/evaluate";
import { resolveTradeConfig } from "../lib/trades/config";
import type { CanonicalPlayer } from "../lib/canonical/schema";
import type { NormalizedProposal } from "../lib/trades/schema";

/* --------------------------------------------------------------- test helper */

interface PSpec {
  slug: string;
  starters: string[];
  bench?: string[];
}

/**
 * Build a fully-synthetic `TradeEvaluationInput` for N participants. Projections
 * + replacement frontier come from the SAME `weeklyContext` fixture the lineup /
 * waiver tests use, so the trade engine consumes identical inputs.
 */
function buildInput(opts: {
  participants: PSpec[];
  players: CanonicalPlayer[];
  projections: ReturnType<typeof proj>[];
  freeAgents?: CanonicalPlayer[];
  faProjections?: ReturnType<typeof proj>[];
  normalizedTransfers: NormalizedProposal["transfers"];
  config?: Parameters<typeof resolveTradeConfig>[0];
}): TradeEvaluationInput {
  const rosters = opts.participants.map((p) => roster(`team:test-league:${p.slug}`, p.starters, p.bench ?? []));
  // Harvest league-wide projections + replacement from one weeklyContext.
  const ctx = weeklyContext({
    myRoster: rosters[0]!,
    players: opts.players,
    projections: opts.projections,
    freeAgents: opts.freeAgents,
    faProjections: opts.faProjections,
  });

  const players_by_id = new Map(opts.players.map((p) => [p.canonical_player_id, p]));
  const normalized: NormalizedProposal = {
    league_slug: "test-league",
    participant_manager_ids: opts.participants.map((p) => `manager:${p.slug}`),
    transfers: opts.normalizedTransfers,
  };

  return {
    normalized,
    week: 1,
    constraints: STD_CONSTRAINTS,
    team_count: 12,
    projections: ctx.projections,
    replacement: ctx.replacement,
    players_by_id,
    participants: opts.participants.map((p, i) => ({
      manager: { canonical_manager_id: `manager:${p.slug}`, manager_slug: p.slug } as never,
      team: { canonical_team_id: `team:test-league:${p.slug}` } as never,
      roster: rosters[i]!,
    })),
    config: resolveTradeConfig(opts.config),
    projections_status: "READY",
  };
}

function resolutionFor(
  participants: Array<{ input: string; mid: string | null; team: string | null }>,
  transfers: Array<{ from: string; to: string; pid: string; cid: string | null }>,
  rosterByManager: Map<string, ReturnType<typeof roster>>,
  ownership: Map<string, string>,
  playerPositions?: Map<string, string[]>,
): TradeResolution {
  return {
    league_slug: "test-league",
    participants: participants.map((p) => ({
      input_id: p.input,
      canonical_manager_id: p.mid,
      manager_slug: p.mid,
      canonical_team_id: p.team,
    })),
    transfers: transfers.map((t) => ({
      from_input: t.from,
      to_input: t.to,
      from_manager_id: participants.find((p) => p.input === t.from)?.mid ?? null,
      to_manager_id: participants.find((p) => p.input === t.to)?.mid ?? null,
      input_player_id: t.pid,
      canonical_player_id: t.cid,
    })),
    ownership,
    roster_by_manager: rosterByManager,
    constraints: STD_CONSTRAINTS,
    player_positions: playerPositions,
  };
}

/* ------------------------------------------------------------------- rosters */

// A: strong at RB, thin at WR.  B: strong at WR, thin at RB.  A<->B one-for-one
// RB<->WR should help BOTH.
const A_PLAYERS = [
  player("A_qb", "QB"), player("A_rb1", "RB"), player("A_rb2", "RB"), player("A_rb3", "RB", { name: "A depth RB" }),
  player("A_wr1", "WR"), player("A_wr2", "WR", { name: "A weak WR2" }), player("A_te", "TE"),
  player("A_flexweak", "WR", { name: "A scrub FLEX" }),
  player("A_k", "K"), player("A_def", "DEF"),
];
const B_PLAYERS = [
  player("B_qb", "QB"), player("B_rb1", "RB", { name: "B weak RB1" }), player("B_rb2", "RB", { name: "B weak RB2" }),
  player("B_wr1", "WR"), player("B_wr2", "WR"), player("B_wr3", "WR", { name: "B depth WR" }), player("B_te", "TE"),
  player("B_k", "K"), player("B_def", "DEF"),
];

const A_PROJS = [
  proj("A_qb", "QB", 20), proj("A_rb1", "RB", 18), proj("A_rb2", "RB", 15), proj("A_rb3", "RB", 12, { rest_of_season_points: 140 }),
  proj("A_wr1", "WR", 14), proj("A_wr2", "WR", 6), proj("A_te", "TE", 9), proj("A_flexweak", "WR", 5),
  proj("A_k", "K", 8), proj("A_def", "DEF", 7),
];
const B_PROJS = [
  proj("B_qb", "QB", 19), proj("B_rb1", "RB", 7), proj("B_rb2", "RB", 6), proj("B_wr1", "WR", 16),
  proj("B_wr2", "WR", 15), proj("B_wr3", "WR", 11, { rest_of_season_points: 130 }), proj("B_te", "TE", 9),
  proj("B_k", "K", 8), proj("B_def", "DEF", 7),
];

const FILLER_FA = ["fa1", "fa2", "fa3", "fa4", "fa5", "fa6", "fa7", "fa8"].flatMap((id) => [id]);
const FA_PLAYERS = FILLER_FA.flatMap((id) => [player(`${id}_rb`, "RB"), player(`${id}_wr`, "WR")]);
const FA_PROJS = FILLER_FA.flatMap((id) => [proj(`${id}_rb`, "RB", 5), proj(`${id}_wr`, "WR", 5)]);

/* ------------------------------------------------------------------- tests */

describe("trade validation — explicit failure codes", () => {
  const rbm = new Map([
    ["manager:A", roster("team:test-league:A", ["A_qb", "A_rb1", "A_rb2", "A_wr1", "A_wr2", "A_te", "A_rb3", "A_k", "A_def"])],
    ["manager:B", roster("team:test-league:B", ["B_qb", "B_rb1", "B_rb2", "B_wr1", "B_wr2", "B_te", "B_wr3", "B_k", "B_def"])],
  ]);
  const ownership = new Map<string, string>();
  for (const [mid, r] of rbm) for (const id of r.all_players) ownership.set(id, `team:test-league:${mid.split(":")[1]}`);
  const pp = new Map([...A_PLAYERS, ...B_PLAYERS].map((p) => [p.canonical_player_id, [p.position]]));
  const parts = [
    { input: "A", mid: "manager:A", team: "team:test-league:A" },
    { input: "B", mid: "manager:B", team: "team:test-league:B" },
  ];

  it("rejects an unknown manager", () => {
    const r = validateTrade(resolutionFor(
      [parts[0]!, { input: "ghost", mid: null, team: null }],
      [{ from: "A", to: "ghost", pid: "A_rb1", cid: "A_rb1" }], rbm, ownership, pp));
    assert.equal(r.result.ok, false);
    assert.ok(r.result.failures.some((f) => f.code === "UNKNOWN_MANAGER"));
  });

  it("rejects an unknown player", () => {
    const r = validateTrade(resolutionFor(parts,
      [{ from: "A", to: "B", pid: "nobody", cid: null }], rbm, ownership, pp));
    assert.ok(r.result.failures.some((f) => f.code === "UNKNOWN_PLAYER"));
  });

  it("rejects a player not owned by the sender", () => {
    const r = validateTrade(resolutionFor(parts,
      [{ from: "A", to: "B", pid: "B_wr1", cid: "B_wr1" }], rbm, ownership, pp));
    assert.ok(r.result.failures.some((f) => f.code === "PLAYER_NOT_OWNED_BY_SENDER"));
  });

  it("rejects a duplicate transfer of the same player", () => {
    const r = validateTrade(resolutionFor(parts, [
      { from: "A", to: "B", pid: "A_rb1", cid: "A_rb1" },
      { from: "A", to: "B", pid: "A_rb1", cid: "A_rb1" },
    ], rbm, ownership, pp));
    assert.ok(r.result.failures.some((f) => f.code === "DUPLICATE_TRANSFER"));
  });

  it("rejects a self-transfer", () => {
    const r = validateTrade(resolutionFor(parts,
      [{ from: "A", to: "A", pid: "A_rb1", cid: "A_rb1" }], rbm, ownership, pp));
    assert.ok(r.result.failures.some((f) => f.code === "SELF_TRANSFER"));
  });

  it("rejects a transfer endpoint outside the participant set", () => {
    const r = validateTrade(resolutionFor(parts,
      [{ from: "A", to: "C", pid: "A_rb1", cid: "A_rb1" }], rbm, ownership, pp));
    assert.ok(r.result.failures.some((f) => f.code === "INVALID_PARTICIPANT"));
  });

  it("rejects a post-trade roster that cannot field a legal lineup", () => {
    // A trades away BOTH its QBs-equivalent: give away the only QB, receive nothing eligible.
    const r = validateTrade(resolutionFor(parts,
      [{ from: "A", to: "B", pid: "A_qb", cid: "A_qb" }], rbm, ownership, pp));
    assert.ok(r.result.failures.some((f) => f.code === "POST_TRADE_ROSTER_ILLEGAL"),
      JSON.stringify(r.result.failures));
  });

  it("accepts a clean one-for-one and returns a normalized proposal", () => {
    const r = validateTrade(resolutionFor(parts, [
      { from: "A", to: "B", pid: "A_rb3", cid: "A_rb3" },
      { from: "B", to: "A", pid: "B_wr3", cid: "B_wr3" },
    ], rbm, ownership, pp));
    assert.equal(r.result.ok, true, JSON.stringify(r.result.failures));
    assert.ok(r.normalized);
    assert.equal(r.normalized!.transfers.length, 2);
  });
});

describe("before/after roster reconstruction", () => {
  it("removes outgoing from every list and adds incoming; before is untouched", () => {
    const rbm = new Map([
      ["manager:A", roster("team:test-league:A", ["A_qb", "A_rb1", "A_rb2", "A_wr1", "A_wr2", "A_te", "A_rb3", "A_k", "A_def"])],
      ["manager:B", roster("team:test-league:B", ["B_qb", "B_rb1", "B_rb2", "B_wr1", "B_wr2", "B_te", "B_wr3", "B_k", "B_def"])],
    ]);
    const normalized: NormalizedProposal = {
      league_slug: "test-league",
      participant_manager_ids: ["manager:A", "manager:B"],
      transfers: [
        { from_manager_id: "manager:A", to_manager_id: "manager:B", canonical_player_id: "A_rb3", input_player_id: "A_rb3" },
        { from_manager_id: "manager:B", to_manager_id: "manager:A", canonical_player_id: "B_wr3", input_player_id: "B_wr3" },
      ],
    };
    const recon = reconstructRosters(normalized, rbm);
    const a = recon.by_manager.get("manager:A")!;
    assert.ok(a.before.all_players.includes("A_rb3"));
    assert.ok(!a.after.all_players.includes("A_rb3"));
    assert.ok(a.after.all_players.includes("B_wr3"));
    assert.ok(!a.after.starters.includes("A_rb3"));
    // immutability of the input roster
    assert.ok(rbm.get("manager:A")!.all_players.includes("A_rb3"));
  });
});

describe("2-team trade — both rosters independently recalculated", () => {
  // A: 2-for-1 — sends bench A_rb3 (12) + weak starter A_wr2 (6), receives elite
  // B_wr1 (16). Raw player-value method: 16 - (12 + 6) = -2 (A "loses"). Actual
  // roster method: B_wr1 takes WR2, A_wr2 leaves the lineup, A_rb3's FLEX seat is
  // backfilled by the scrub A_flexweak (5) -> A's starter total RISES ~+3.
  const A_STARTERS = ["A_qb", "A_rb1", "A_rb2", "A_wr1", "A_wr2", "A_te", "A_flexweak", "A_k", "A_def"];
  const B_STARTERS = ["B_qb", "B_rb1", "B_rb2", "B_wr1", "B_wr2", "B_te", "B_wr3", "B_k", "B_def"];
  const TRANSFERS = [
    { from_manager_id: "manager:A", to_manager_id: "manager:B", canonical_player_id: "A_rb3", input_player_id: "A_rb3" },
    { from_manager_id: "manager:A", to_manager_id: "manager:B", canonical_player_id: "A_wr2", input_player_id: "A_wr2" },
    { from_manager_id: "manager:B", to_manager_id: "manager:A", canonical_player_id: "B_wr1", input_player_id: "B_wr1" },
  ];
  const mk = (config?: Parameters<typeof resolveTradeConfig>[0]) => evaluateTrade(buildInput({
    participants: [
      { slug: "A", starters: A_STARTERS, bench: ["A_rb3"] },
      { slug: "B", starters: B_STARTERS },
    ],
    players: [...A_PLAYERS, ...B_PLAYERS],
    projections: [...A_PROJS, ...B_PROJS],
    freeAgents: FA_PLAYERS, faProjections: FA_PROJS,
    normalizedTransfers: TRANSFERS,
    config,
  }));
  const out = mk();

  it("produces a roster-specific result per participant", () => {
    assert.ok(out.participants.A && out.participants.B);
    assert.notEqual(out.participants.A!.roster_utility_delta, out.participants.B!.roster_utility_delta);
  });

  it("starter delta is the recomputed lineup effect, NOT a subtraction of swapped projections", () => {
    const a = out.participants.A!;
    const naiveSwap = 16 - (12 + 6); // = -2
    assert.equal(a.starter_points_delta_status, "RESOLVED");
    assert.ok(Math.abs(a.starter_points_delta! - naiveSwap) >= 2,
      `actual (${a.starter_points_delta}) should diverge materially from naive swap (${naiveSwap})`);
    assert.ok(a.starter_points_delta! > 0, `A's lineup actually improves: ${a.starter_points_delta}`);
    assert.ok(a.lineup_displacement.entered_starting_lineup.includes("B_wr1"));
    assert.ok(a.lineup_displacement.left_starting_lineup.includes("A_wr2"));
  });

  it("acceptance is roster-specific — the same trade helps A and hurts B", () => {
    assert.ok(out.participants.A!.roster_utility_delta > 0);
    assert.ok(out.participants.B!.roster_utility_delta < 0);
    assert.equal(out.trade_summary.largest_beneficiary, "A");
    assert.equal(out.trade_summary.largest_negative, "B");
    assert.equal(out.trade_summary.all_teams_improve, false);
  });

  it("records a trade-level verdict distinct from the per-team results", () => {
    assert.ok(["HIGH", "MODERATE", "LOW", "NON_VIABLE"].includes(out.trade_summary.trade_viability));
    assert.equal(typeof out.trade_summary.utility_gain_variance, "number");
    assert.ok(out.trade_summary.utility_gain_spread > 0);
  });

  it("is deterministic", () => {
    assert.deepEqual(mk().participants.A!.roster_utility_components, out.participants.A!.roster_utility_components);
    assert.equal(mk().participants.B!.roster_utility_delta, out.participants.B!.roster_utility_delta);
  });

  it("acceptance thresholds are configurable", () => {
    const strict = mk({ thresholds: { strong_accept: 999, accept: 998 } });
    // With an unreachable accept bar, nobody can land STRONG_ACCEPT/ACCEPT.
    for (const p of Object.values(strict.participants)) {
      assert.ok(!["STRONG_ACCEPT", "ACCEPT"].includes(p.acceptance));
    }
  });
});

describe("3-team trade — circular routing, no direct A<->C exchange", () => {
  // A->B (A_rb3), B->C (B_wr3), C->A (C_te2). No bilateral pair.
  const C_PLAYERS = [
    player("C_qb", "QB"), player("C_rb1", "RB"), player("C_rb2", "RB"), player("C_wr1", "WR"), player("C_wr2", "WR"),
    player("C_te", "TE"), player("C_te2", "TE", { name: "C spare TE" }), player("C_k", "K"), player("C_def", "DEF"),
  ];
  const C_PROJS = [
    proj("C_qb", "QB", 18), proj("C_rb1", "RB", 14), proj("C_rb2", "RB", 12), proj("C_wr1", "WR", 13),
    proj("C_wr2", "WR", 12), proj("C_te", "TE", 12), proj("C_te2", "TE", 8, { rest_of_season_points: 90 }),
    proj("C_k", "K", 8), proj("C_def", "DEF", 7),
  ];
  const mk = (cfg?: Parameters<typeof resolveTradeConfig>[0]) => evaluateTrade(buildInput({
    participants: [
      { slug: "A", starters: ["A_qb", "A_rb1", "A_rb2", "A_wr1", "A_wr2", "A_te", "A_rb3", "A_k", "A_def"] },
      { slug: "B", starters: ["B_qb", "B_rb1", "B_rb2", "B_wr1", "B_wr2", "B_te", "B_wr3", "B_k", "B_def"] },
      { slug: "C", starters: ["C_qb", "C_rb1", "C_rb2", "C_wr1", "C_wr2", "C_te", "C_te2", "C_k", "C_def"] },
    ],
    players: [...A_PLAYERS, ...B_PLAYERS, ...C_PLAYERS],
    projections: [...A_PROJS, ...B_PROJS, ...C_PROJS],
    freeAgents: FA_PLAYERS, faProjections: FA_PROJS,
    normalizedTransfers: [
      { from_manager_id: "manager:A", to_manager_id: "manager:B", canonical_player_id: "A_rb3", input_player_id: "A_rb3" },
      { from_manager_id: "manager:B", to_manager_id: "manager:C", canonical_player_id: "B_wr3", input_player_id: "B_wr3" },
      { from_manager_id: "manager:C", to_manager_id: "manager:A", canonical_player_id: "C_te2", input_player_id: "C_te2" },
    ],
    config: cfg,
  }));

  it("evaluates all three rosters independently", () => {
    const out = mk();
    assert.deepEqual(Object.keys(out.participants).sort(), ["A", "B", "C"]);
    for (const p of Object.values(out.participants)) {
      assert.equal(typeof p.roster_utility_delta, "number");
      assert.ok(p.before.optimal_starters.length > 0 && p.after.optimal_starters.length > 0);
    }
  });

  it("tracks the outgoing/incoming player on the right roster (routing, not reciprocity)", () => {
    const out = mk();
    assert.deepEqual(out.participants.A!.after.incoming_player_ids, ["C_te2"]);
    assert.deepEqual(out.participants.A!.after.outgoing_player_ids, ["A_rb3"]);
    assert.deepEqual(out.participants.C!.after.incoming_player_ids, ["B_wr3"]);
  });

  it("summary separates rationality from fairness / distribution", () => {
    const out = mk();
    assert.equal(typeof out.trade_summary.rationality.every_participant_rational, "boolean");
    assert.equal(typeof out.trade_summary.fairness.imbalance_index, "number");
    assert.ok(out.trade_summary.utility_gain_spread >= 0);
  });

  it("is deterministic across repeated evaluation", () => {
    assert.deepEqual(mk().participants.C!.roster_utility_components, mk().participants.C!.roster_utility_components);
  });
});
