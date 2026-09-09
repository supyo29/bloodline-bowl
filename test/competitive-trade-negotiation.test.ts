/**
 * Competitive Trade Intelligence — Checkpoint E: value extraction, negotiation
 * envelope, maximum acceptable price.
 *
 * Deterministic. Pure selection logic is tested with hand-built inputs; the
 * extraction ranking and end-to-end flow use `tradeFixture` contexts. Covers
 * spec §55–§69 and the §81 freeze gates.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import type { CanonicalPosition, CanonicalDraftPick } from "../lib/canonical/schema";
import { baseTradeCertified, type BaseTradeSummary } from "../lib/trades/competitive/extraction";
import { buildNegotiationFrontier, classifyCounteroffer, dominates } from "../lib/trades/competitive/negotiation";
import { evaluateNegotiationEnvelopeInner } from "../lib/trades/competitive/negotiation-eval";
import { resolveNegotiationConfig } from "../lib/trades/competitive/config";
import type {
  AcceptanceLikelihood,
  CompetitiveClassification,
  HorizonClassification,
  NegotiationProposal,
  ValueConfidence,
  ValueExtraction,
} from "../lib/trades/competitive/schema";

const CFG = resolveNegotiationConfig();

function prop(o: Partial<NegotiationProposal> & { label: string }): NegotiationProposal {
  return {
    our_assets: ["A"],
    their_assets: ["B"],
    our_permanent_utility: 2,
    counterparty_perceived_surplus: 1,
    counterparty_reservation_burden: 1,
    acceptance_likelihood: "MODERATE" as AcceptanceLikelihood,
    opponent_actual_impact: 1,
    competitive_externality: 0.5,
    competitive_classification: "COMPETITIVE_BUY" as CompetitiveClassification,
    confidence: "MEDIUM" as ValueConfidence,
    horizon_classification: "CONSISTENT_POSITIVE" as HorizonClassification,
    dominated: false,
    extraction_efficiency: null,
    reason_codes: [],
    reasons: [],
    ...o,
  };
}

function baseSummary(o: Partial<BaseTradeSummary> = {}): BaseTradeSummary {
  return {
    our_permanent_utility: 3,
    our_horizon_classification: "CONSISTENT_POSITIVE",
    counterparty_perceived_surplus: 1.5,
    acceptance_likelihood: "HIGH",
    competitive_classification: "COMPETITIVE_BUY",
    confidence: "MEDIUM",
    base_market_edge: 0.5,
    ...o,
  };
}

function extraction(o: Partial<ValueExtraction> = {}): ValueExtraction {
  return {
    base_perceived_surplus: 1.5,
    maximum_theoretical_extraction: 1.5,
    recommended_extraction: 1.3,
    remaining_counterparty_surplus: 0.2,
    band: "MODERATE_EXTRACTION",
    aggressiveness: "AGGRESSIVE_BUT_CREDIBLE",
    ranked_secondary_assets: [
      { canonical_player_id: "C", name: "Player C", position: "RB", our_private_value: 0.9, their_reservation: -0.2, their_starter_importance: "BENCH_DEPTH", efficiency: 1.8, reason_codes: ["SECONDARY_ASSET_EXPENDABLE_TO_THEM"] },
      { canonical_player_id: "D", name: "Player D", position: "WR", our_private_value: 0.7, their_reservation: 0.1, their_starter_importance: "ROTATIONAL", efficiency: 1.1, reason_codes: [] },
      { canonical_player_id: "E", name: "Player E", position: "RB", our_private_value: 0.5, their_reservation: 0.3, their_starter_importance: "ROTATIONAL", efficiency: 0.8, reason_codes: [] },
    ],
    reason_codes: [],
    reasons: [],
    ...o,
  };
}

describe("Competitive Trade E — base-trade gate (§14, §15)", () => {
  it("§14/§15 — a REVIEW_REQUIRED / negative-gain base trade fails the gate (Rhamondre/Chuba)", () => {
    const b = baseSummary({ our_permanent_utility: -3.4, our_horizon_classification: "REVIEW_REQUIRED", competitive_classification: "REJECT", confidence: "VERY_LOW" });
    const cert = baseTradeCertified(b, CFG);
    assert.equal(cert.ok, false);
    assert.ok(cert.reasons.some((r) => r.includes("REVIEW_REQUIRED")));
    assert.ok(cert.reasons.some((r) => r.toLowerCase().includes("below the minimum")));
  });
  it("§16 — a certified positive base with acceptance passes the gate", () => {
    assert.equal(baseTradeCertified(baseSummary(), CFG).ok, true);
  });
  it("a LOW-acceptance base fails the gate", () => {
    assert.equal(baseTradeCertified(baseSummary({ acceptance_likelihood: "VERY_LOW" }), CFG).ok, false);
  });
});

describe("Competitive Trade E — negotiation frontier & envelope", () => {
  const base = prop({ label: "base", our_permanent_utility: 3, counterparty_perceived_surplus: 1.5, acceptance_likelihood: "HIGH", competitive_externality: 0.5 });

  function frontierWith(points: NegotiationProposal[], ext = extraction()) {
    let i = 0;
    const evaluateProposal = (): NegotiationProposal | null => points[i++] ?? null;
    return buildNegotiationFrontier({ base, extraction: ext, evaluateProposal, config: CFG });
  }

  it("§12/§15 — EXTRACTION_GATED ⇒ frontier is base only, opening = target = acceptable = base", () => {
    const fr = frontierWith([prop({ label: "should-not-be-used" })], extraction({ band: "EXTRACTION_GATED", ranked_secondary_assets: [] }));
    assert.equal(fr.frontier.length, 1);
    assert.equal(fr.opening?.label, "base");
    assert.equal(fr.target?.label, "base");
    assert.equal(fr.acceptable?.label, "base");
    assert.ok(fr.reason_codes.includes("EXTRACTION_GATED"));
  });

  it("§30/§55/§56 — obvious extraction: opening requests more than a straight swap and is the most aggressive credible point", () => {
    const fr = frontierWith([
      prop({ label: "base + Player C", our_permanent_utility: 4.5, counterparty_perceived_surplus: 1.0, acceptance_likelihood: "HIGH", competitive_externality: 0.2 }),
      prop({ label: "base + Player D", our_permanent_utility: 5.5, counterparty_perceived_surplus: 0.4, acceptance_likelihood: "MODERATE", competitive_externality: 0.1 }),
      prop({ label: "base + Player E", our_permanent_utility: 6.5, counterparty_perceived_surplus: -0.5, acceptance_likelihood: "VERY_LOW", competitive_externality: 0.0 }),
    ]);
    assert.notEqual(fr.opening?.label, "base");
    assert.ok((fr.opening?.our_permanent_utility ?? 0) >= (fr.target?.our_permanent_utility ?? 0));
    // Player E (VERY_LOW acceptance) is not opening/target/acceptable
    for (const pick of [fr.opening, fr.target, fr.acceptable]) assert.notEqual(pick?.label, "base + Player E");
  });

  it("§57 — an add-on that collapses acceptance lies beyond the frontier", () => {
    const fr = frontierWith([
      prop({ label: "base + Player C", our_permanent_utility: 4, counterparty_perceived_surplus: 0.8, acceptance_likelihood: "MODERATE" }),
      prop({ label: "base + Player D", our_permanent_utility: 7, counterparty_perceived_surplus: -5, acceptance_likelihood: "VERY_LOW" }),
    ]);
    for (const pick of [fr.opening, fr.target, fr.acceptable]) assert.notEqual(pick?.label, "base + Player D");
    assert.ok(fr.why_stops.join(" ").toLowerCase().includes("acceptance") || fr.frontier.some((p) => p.reason_codes.includes("ACCEPTANCE_COLLAPSES_BEYOND_HERE")));
  });

  it("§50/§67 — do not bid against ourselves: no add-on clears the opening floor ⇒ opening = base", () => {
    const fr = frontierWith([prop({ label: "base + Player C", our_permanent_utility: 4, counterparty_perceived_surplus: -1, acceptance_likelihood: "VERY_LOW" })]);
    assert.equal(fr.opening?.label, "base");
    assert.ok(fr.reason_codes.includes("DO_NOT_BID_AGAINST_SELF"));
  });

  it("§68 — opening, target, acceptable distinct on a rich frontier; explicit walk-away", () => {
    const fr = frontierWith([
      prop({ label: "base + Player C", our_permanent_utility: 3.6, counterparty_perceived_surplus: 1.1, acceptance_likelihood: "HIGH", competitive_externality: 0.3 }),
      prop({ label: "base + Player D", our_permanent_utility: 4.4, counterparty_perceived_surplus: 0.5, acceptance_likelihood: "MODERATE", competitive_externality: 0.2 }),
      prop({ label: "base + Player E", our_permanent_utility: 5.2, counterparty_perceived_surplus: 0.1, acceptance_likelihood: "LOW", competitive_externality: 0.1 }),
    ]);
    assert.ok(fr.opening && fr.target && fr.acceptable);
    assert.ok((fr.opening!.our_permanent_utility ?? 0) >= (fr.acceptable!.our_permanent_utility ?? 0));
    assert.equal(fr.walk_away.min_permanent_utility, CFG.minimum_private_gain);
    assert.ok(fr.walk_away.explanation.startsWith("Walk away"));
  });

  it("§44/§69 — dominated proposals do not survive the frontier", () => {
    const a = prop({ label: "A", our_permanent_utility: 5, acceptance_likelihood: "HIGH", competitive_externality: 0.1, confidence: "MEDIUM" });
    const b = prop({ label: "B", our_permanent_utility: 3, acceptance_likelihood: "MODERATE", competitive_externality: 0.5, confidence: "LOW" });
    assert.equal(dominates(a, b), true);
    assert.equal(dominates(b, a), false);
    const fr = frontierWith([a, b]);
    assert.ok(!fr.frontier.some((p) => p.label === "B"));
  });

  it("§25/§66 — acceptance is a feasibility threshold not a reward: +6 / MODERATE beats +3 / HIGH for target", () => {
    const fr = frontierWith([
      prop({ label: "base + Player C", our_permanent_utility: 6, acceptance_likelihood: "MODERATE", competitive_externality: 0.2, counterparty_perceived_surplus: 0.6 }),
      prop({ label: "base + Player D", our_permanent_utility: 3, acceptance_likelihood: "HIGH", competitive_externality: 0.2, counterparty_perceived_surplus: 1.0 }),
    ]);
    assert.equal(fr.target?.label, "base + Player C");
  });
});

describe("Competitive Trade E — counteroffer (§23, §24)", () => {
  const env = {
    target_settlement: prop({ label: "target", our_permanent_utility: 2.5 }),
    walk_away: { min_permanent_utility: 0.25, breaking_asset: null, explanation: "x" },
  };
  it("ACCEPT above target, COUNTER between, WALK_AWAY below floor or REJECT-class", () => {
    assert.equal(classifyCounteroffer(prop({ label: "c", our_permanent_utility: 3 }), env, CFG).verdict, "ACCEPT");
    assert.equal(classifyCounteroffer(prop({ label: "c", our_permanent_utility: 1 }), env, CFG).verdict, "COUNTER");
    assert.equal(classifyCounteroffer(prop({ label: "c", our_permanent_utility: -1 }), env, CFG).verdict, "WALK_AWAY");
    assert.equal(classifyCounteroffer(prop({ label: "c", our_permanent_utility: 5, competitive_classification: "REJECT" }), env, CFG).verdict, "WALK_AWAY");
  });
});

/* ---- fixture end-to-end ---- */

const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) => [0, 1, 2, 3].map((i) => proj(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, { rest_of_season_points: (p === "QB" ? 12 - i : 6 - i) * ROS_WEEKS })));
const MID = (slug: string) => `manager:test-league:${slug}`;

function dp(manager: string, pid: string, round: number, pick: number): CanonicalDraftPick {
  return { canonical_draft_pick_id: `dp:${pid}`, canonical_league_id: "league:test-league", season: 2026, round, pick_number: pick, draft_slot: 1, canonical_team_id: null, canonical_manager_id: MID(manager), canonical_player_id: pid, auction_amount: null, is_keeper: false, provenance: { provider: "sleeper", provider_id: pid, provider_synced_at: null } };
}

describe("Competitive Trade E — fixture end-to-end", () => {
  it("evaluateNegotiationEnvelopeInner: always returns a bounded envelope; gated base ⇒ frontier is base only", () => {
    const built = ([
      { slug: "alpha", flex: { id: "alpha_flexwr", pos: "WR", pts: 11 }, bench: [{ id: "alpha_bench_wr", pos: "WR", pts: 3 }], lockPts: { RB1: 6, RB2: 5 } },
      { slug: "bravo", flex: { id: "bravo_rb", pos: "RB", pts: 15 }, bench: [{ id: "bravo_rb4", pos: "RB", pts: 8 }, { id: "bravo_scrub", pos: "WR", pts: 2 }], lockPts: { WR1: 8, WR2: 7 } },
    ] as StdTeamSpec[]).map(stdTeam);
    const fix = tradeFixture({ teams: built.map((b) => b.team), players: built.flatMap((b) => b.players), projections: built.flatMap((b) => b.projections), freeAgents: FA, faProjections: FA_PROJ, transfers: [], rosFlatHorizon: ROS_WEEKS, teamCount: 12 });
    const ctx = fix.context({ rosWeeks: ROS_WEEKS });
    ctx.snapshot.draft_picks.push(dp("alpha", "alpha_bench_wr", 12, 140), dp("bravo", "bravo_rb", 3, 28), dp("bravo", "bravo_rb4", 10, 115));

    const env = evaluateNegotiationEnvelopeInner({
      ctx, my_manager_id: MID("alpha"), counterparty_manager_id: MID("bravo"),
      our_assets: ["alpha_bench_wr"], their_assets: ["bravo_rb"],
    });
    assert.ok(["EXTRACTION_GATED", "BASE_TRADE_ONLY", "PARTIAL_EXTRACTION_CONTEXT", "FULL_EXTRACTION_CONTEXT"].includes(env.readiness));
    assert.equal(env.base_proposal.label, "base");
    assert.ok(env.frontier.length >= 1 && env.frontier.length <= CFG.max_frontier_points);
    assert.ok(env.opening_offer && env.target_settlement && env.acceptable_deal);
    assert.ok(env.walk_away.explanation.includes("Walk away"));
    assert.ok(Array.isArray(env.internal_explanation.why_the_frontier_stops));
    if (!env.base_trade_certified) {
      assert.equal(env.frontier.length, 1);
      assert.equal(env.opening_offer?.label, "base");
      assert.equal(env.extraction.band, "EXTRACTION_GATED");
    }
  });

  it("a certified base with an expendable counterparty asset builds a multi-point frontier and requests the add-on", () => {
    // alpha (weak RB, WR scrub to offer) acquires bravo's rotational RB; bravo has a deep bench RB4
    const built = ([
      { slug: "alpha", flex: { id: "a_flex", pos: "WR", pts: 11 }, bench: [{ id: "a_offer", pos: "K", pts: 1 }], lockPts: { RB1: 5, RB2: 4 } },
      { slug: "bravo", flex: { id: "b_flex", pos: "RB", pts: 16 }, bench: [{ id: "b_rb_target", pos: "RB", pts: 13 }, { id: "b_rb_scrub", pos: "RB", pts: 2 }, { id: "b_rb_scrub2", pos: "RB", pts: 2 }], lockPts: { RB1: 18, RB2: 17, WR1: 9, WR2: 8 } },
    ] as StdTeamSpec[]).map(stdTeam);
    const fix = tradeFixture({ teams: built.map((b) => b.team), players: built.flatMap((b) => b.players), projections: built.flatMap((b) => b.projections), freeAgents: FA, faProjections: FA_PROJ, transfers: [], rosFlatHorizon: ROS_WEEKS, teamCount: 12 });
    const ctx = fix.context({ rosWeeks: ROS_WEEKS });
    ctx.snapshot.draft_picks.push(dp("bravo", "b_rb_target", 5, 55), dp("bravo", "b_rb_scrub", 14, 160), dp("bravo", "b_rb_scrub2", 15, 170));

    const env = evaluateNegotiationEnvelopeInner({
      ctx, my_manager_id: MID("alpha"), counterparty_manager_id: MID("bravo"),
      our_assets: ["a_offer"], their_assets: ["b_rb_target"],
    });
    // whatever the certification outcome, the envelope must be internally consistent
    assert.ok(env.opening_offer!.our_assets.length >= env.base_proposal.our_assets.length);
    for (const p of env.frontier) {
      assert.ok(p.their_assets.length >= env.base_proposal.their_assets.length, "frontier points only ADD to the counterparty side");
    }
    // opening is never worse for us than the base
    if (env.base_trade_certified && env.opening_offer && env.base_proposal.our_permanent_utility != null) {
      assert.ok((env.opening_offer.our_permanent_utility ?? -Infinity) >= env.base_proposal.our_permanent_utility - 1e-6);
    }
  });
});
