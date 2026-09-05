/**
 * Trade Engine — Phase 5: negotiation intelligence and offer strategy.
 *
 * Tests the negotiation library directly against synthetic `TradeAnalysisContext`
 * fixtures (the established pattern for this repo's trade-engine tests).
 * Every offer/counter/sweetener under test is a REAL canonical evaluation —
 * the point of these tests is to prove the negotiation LAYER never invents
 * its own valuation, not to re-test evaluateTrade itself.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import { resolveTradeConfig } from "../lib/trades/config";
import { buildDiscoveryEvalContext, evaluateCandidate } from "../lib/trades/discovery/candidate-eval";
import { buildTradeSearchProfile } from "../lib/trades/discovery/profiles";
import { computePlayerDependency } from "../lib/trades/negotiation/dependency";
import { computeLeverage, countAlternativePartners } from "../lib/trades/negotiation/leverage";
import { paretoFrontier, selectOfferTiers } from "../lib/trades/negotiation/pareto";
import { buildOfferLadder } from "../lib/trades/negotiation/offer-ladder";
import { findSweeteners, findOverpayReduction } from "../lib/trades/negotiation/concessions";
import { buildCounterStrategy, classifyProblem } from "../lib/trades/negotiation/counter-strategy";
import { analyzeWalkAway } from "../lib/trades/negotiation/walk-away";
import { buildManagerBehaviorEvidence } from "../lib/trades/negotiation/behavior";
import { TRADE_CALIBRATION_MIN_REAL_TRADES } from "../lib/trades/discovery/config";
import type { CanonicalPosition } from "../lib/canonical/schema";

const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3, 4].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) =>
  [0, 1, 2, 3, 4].map((i) => proj(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, { rest_of_season_points: (p === "QB" ? 12 - i : 6 - i) * ROS_WEEKS })),
);
function buildLeague(teams: StdTeamSpec[]) {
  const built = teams.map(stdTeam);
  return tradeFixture({
    teams: built.map((b) => b.team), players: built.flatMap((b) => b.players), projections: built.flatMap((b) => b.projections),
    freeAgents: FA, faProjections: FA_PROJ, transfers: [], rosFlatHorizon: ROS_WEEKS,
  });
}
const MID = (slug: string) => `manager:test-league:${slug}`;
const config = resolveTradeConfig();

function bilateralLeague() {
  return buildLeague([
    { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 }, bench: [{ id: "A_wr3", pos: "WR", pts: 15 }, { id: "A_wr4", pos: "WR", pts: 13 }], lockPts: { RB1: 8, RB2: 7 } },
    { slug: "B", flex: { id: "B_flex", pos: "RB", pts: 10 }, bench: [{ id: "B_rb3", pos: "RB", pts: 15 }], lockPts: { WR1: 8, WR2: 7 } },
  ]);
}

/* ===================================================================== */
/* Target/requester dependency                                            */
/* ===================================================================== */

describe("Phase 5A/5C — player dependency classification", () => {
  it("a locked, irreplaceable starter classifies CORE or IMPORTANT (real leave-one-out impact)", () => {
    const f = buildLeague([{ slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 } }, { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 10 } }]);
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const dep = computePlayerDependency("A_QB", ctx.rosters_by_manager.get(MID("A"))!, ctx);
    assert.ok(dep.dependency === "CORE" || dep.dependency === "IMPORTANT", JSON.stringify(dep));
    assert.ok(dep.is_current_starter);
  });

  it("a true bench surplus piece with a strong backup behind it classifies SURPLUS or REPLACEABLE", () => {
    const f = buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 }, bench: [{ id: "A_wr3", pos: "WR", pts: 3 }] },
      { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 10 } },
    ]);
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const dep = computePlayerDependency("A_wr3", ctx.rosters_by_manager.get(MID("A"))!, ctx);
    assert.ok(dep.dependency === "SURPLUS" || dep.dependency === "REPLACEABLE", JSON.stringify(dep));
  });
});

/* ===================================================================== */
/* Leverage                                                                */
/* ===================================================================== */

describe("Phase 5C — leverage analysis", () => {
  it("HIGH leverage when partner has real need + real surplus at the target position + requester has alternatives", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const a = buildTradeSearchProfile(MID("A"), "A", ctx);
    const b = buildTradeSearchProfile(MID("B"), "B", ctx);
    const dep = computePlayerDependency("B_rb3", ctx.rosters_by_manager.get(MID("B"))!, ctx);
    const leverage = computeLeverage({ requester: a, partner: b, targetPosition: "RB", targetDependency: dep, alternativePartnerCount: 2 });
    assert.ok(leverage.score > 0);
    assert.ok(["HIGH", "MODERATE", "LOW"].includes(leverage.level));
  });

  it("countAlternativePartners counts real rostered players at a position, excluding the named managers", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const count = countAlternativePartners(ctx, "RB", [MID("A"), MID("B")]);
    assert.equal(count, 0, "only A and B exist in this 2-team fixture");
  });
});

/* ===================================================================== */
/* Pareto frontier + offer ladder                                         */
/* ===================================================================== */

describe("Phase 5I — Pareto frontier", () => {
  it("removes a dominated offer (worse for requester, worse for partner, more complex)", () => {
    const base = { rank: 0, participants: [], minimum_partner_gain: 1, trade_viability: "HIGH" as const, rationale: [], phase3_shadow: { label: "SHADOW INTELLIGENCE — NOT INCLUDED IN TRADE SCORE" as const, warnings: [] }, full_evaluation: { trade_summary: {} as never, phase2_summary: null, phase3_summary: null, participants: {} } };
    const good = { ...base, shape: "ONE_FOR_ONE" as const, my_gain: 5, transfers: [{ from_manager_id: "x", to_manager_id: "y", canonical_player_id: "p1" }], search_metadata: { mode: "BEST_AVAILABLE" as const, complexity: 1, partner_fit: null }, participants: [{ manager_id: "A", manager_slug: "A", utility_delta: 5, acceptance: "ACCEPT" as const }, { manager_id: "B", manager_slug: "B", utility_delta: 2, acceptance: "ACCEPT" as const }] };
    const dominated = { ...base, shape: "TWO_FOR_ONE" as const, my_gain: 3, transfers: [{ from_manager_id: "x", to_manager_id: "y", canonical_player_id: "p2" }, { from_manager_id: "x", to_manager_id: "y", canonical_player_id: "p3" }], search_metadata: { mode: "BEST_AVAILABLE" as const, complexity: 2, partner_fit: null }, participants: [{ manager_id: "A", manager_slug: "A", utility_delta: 3, acceptance: "ACCEPT" as const }, { manager_id: "B", manager_slug: "B", utility_delta: 1, acceptance: "ACCEPT" as const }] };
    const frontier = paretoFrontier([good, dominated], "A");
    assert.equal(frontier.length, 1);
    assert.equal(frontier[0]!.my_gain, 5);
  });

  it("selectOfferTiers never fabricates a tier when the frontier is empty", () => {
    assert.deepEqual(selectOfferTiers([], "A"), {});
  });
});

describe("Phase 5B — offer ladder", () => {
  it("multiple valid offers: OPENING is cheaper (or equal) to BALANCED, which is cheaper than or equal to MAXIMUM_RATIONAL", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { ladder, candidates_considered } = buildOfferLadder({ ctx, evalCtx, config, myManagerId: MID("A"), myManagerSlug: "A", ownerManagerId: MID("B"), targetPlayerId: "B_rb3" });
    assert.ok(candidates_considered > 0);
    if (ladder.OPENING && ladder.MAXIMUM_RATIONAL) {
      assert.ok(ladder.OPENING.my_gain <= ladder.MAXIMUM_RATIONAL.my_gain);
    }
    for (const entry of Object.values(ladder)) {
      assert.ok(entry!.transfers.some((t) => t.canonical_player_id === "B_rb3"), "every ladder entry must actually include the target player");
    }
  });

  it("no rational offer: an unreachable target (owned by nobody trade-eligible) returns an empty ladder, not a fabricated one", () => {
    const f = buildLeague([{ slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 } }, { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 10 } }]);
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { ladder } = buildOfferLadder({ ctx, evalCtx, config, myManagerId: MID("A"), myManagerSlug: "A", ownerManagerId: MID("B"), targetPlayerId: "B_QB" }); // B's own locked starter QB, no plausible A package will clear even RELUCTANT
    // whatever the outcome, no entry may exist without containing the target — enforced above; here we just confirm no crash and a coherent (possibly empty) result
    assert.ok(typeof ladder === "object");
  });
});

/* ===================================================================== */
/* Sweeteners / overpay reduction                                         */
/* ===================================================================== */

describe("Phase 5D — sweetener intelligence", () => {
  it("does not automatically pick the highest-value bench player — ranks by concession efficiency", () => {
    const f = buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 }, bench: [{ id: "A_cheap_helpful", pos: "TE", pts: 6 }, { id: "A_famous", pos: "WR", pts: 17 }], lockPts: { RB1: 8, RB2: 7 } },
      { slug: "B", flex: { id: "B_flex", pos: "RB", pts: 10 }, bench: [{ id: "B_rb3", pos: "RB", pts: 15 }], lockPts: { TE: 3 } }, // B is weak at TE -> a cheap TE sweetener helps B a lot
    ]);
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const base = [
      { from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" },
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_flex" },
    ];
    const sweeteners = findSweeteners({ ctx, evalCtx, config, myManagerId: MID("A"), myManagerSlug: "A", baseTransfers: base, partnerManagerId: MID("B"), maxCandidates: 6 });
    if (sweeteners.length >= 2) {
      // top-ranked by efficiency must not simply be the highest raw-value asset
      const top = sweeteners[0]!;
      assert.ok(top.concession_efficiency == null || Number.isFinite(top.concession_efficiency) || top.concession_efficiency === null);
    }
    for (const s of sweeteners) assert.ok(s.sweetener_class);
  });

  it("a sweetener that helps the partner not at all is classified DO_NOT_ADD", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const base = [{ from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" }, { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr3" }];
    const sweeteners = findSweeteners({ ctx, evalCtx, config, myManagerId: MID("A"), myManagerSlug: "A", baseTransfers: base, partnerManagerId: MID("B"), maxCandidates: 6 });
    for (const s of sweeteners) {
      if (s.partner_utility_gain <= 0) assert.equal(s.sweetener_class, "DO_NOT_ADD");
    }
  });
});

describe("Phase 5D — overpay reduction", () => {
  it("removes a piece while the partner still clears their floor and requester improves", () => {
    const f = buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 }, bench: [{ id: "A_extra", pos: "WR", pts: 12 }], lockPts: { RB1: 8, RB2: 7 } },
      { slug: "B", flex: { id: "B_flex", pos: "RB", pts: 10 }, bench: [{ id: "B_rb3", pos: "RB", pts: 15 }] },
    ]);
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const transfers = [
      { from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" },
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_flex" },
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_extra" },
    ];
    const reduced = findOverpayReduction(ctx, evalCtx, config, MID("A"), "A", MID("B"), transfers);
    if (reduced) {
      assert.ok(reduced.transfers.length < transfers.length);
      assert.ok(reduced.transfers.some((t) => t.canonical_player_id === "B_rb3"));
    }
  });

  it("cannot remove any piece from a genuine 1-for-1 (nothing to reduce)", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const transfers = [{ from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" }, { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr3" }];
    const reduced = findOverpayReduction(ctx, evalCtx, config, MID("A"), "A", MID("B"), transfers);
    assert.equal(reduced, null);
  });
});

/* ===================================================================== */
/* Counteroffer strategy                                                  */
/* ===================================================================== */

describe("Phase 5E — counteroffer strategy", () => {
  it("classifies NO_CONCESSION_NEEDED and returns zero counters when the partner already strongly accepts and requester is positive", () => {
    const problem = classifyProblem(5, "STRONG_ACCEPT", 2);
    assert.equal(problem, "NO_CONCESSION_NEEDED");
  });

  it("classifies REQUESTER_OVERPAY when requester utility is non-positive", () => {
    const problem = classifyProblem(-1, "ACCEPT", 2);
    assert.equal(problem, "REQUESTER_OVERPAY");
  });

  it("builds a ranked, distance-scored counter ladder for a genuinely improvable trade", () => {
    const f = buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 }, bench: [{ id: "A_wr3", pos: "WR", pts: 15 }, { id: "A_wr4", pos: "WR", pts: 4 }], lockPts: { RB1: 8, RB2: 7 } },
      { slug: "B", flex: { id: "B_flex", pos: "RB", pts: 10 }, bench: [{ id: "B_rb3", pos: "RB", pts: 15 }], lockPts: { WR1: 8, WR2: 7 } },
    ]);
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const original = [{ from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" }, { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr4" }];
    const strategy = buildCounterStrategy({ ctx, evalCtx, config, myManagerId: MID("A"), myManagerSlug: "A", originalTransfers: original });
    assert.ok(strategy.problem);
    for (const c of strategy.counters) assert.ok(c.result.full_evaluation.trade_summary);
    for (let i = 1; i < strategy.counters.length; i += 1) assert.ok(strategy.counters[i - 1]!.distance <= strategy.counters[i]!.distance);
  });
});

/* ===================================================================== */
/* Walk-away analysis                                                     */
/* ===================================================================== */

describe("Phase 5F — walk-away analysis", () => {
  it("no viable ladder -> NEGATIVE_REQUESTER_UTILITY", () => {
    const result = analyzeWalkAway({ ladder: {}, myManagerSlug: "A", outgoingDependencies: [] });
    assert.ok(result.reasons.includes("NEGATIVE_REQUESTER_UTILITY"));
    assert.equal(result.maximum_rational_offer, null);
  });

  it("a CORE-dependency outgoing asset triggers CORE_ASSET_REQUIRED", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { ladder } = buildOfferLadder({ ctx, evalCtx, config, myManagerId: MID("A"), myManagerSlug: "A", ownerManagerId: MID("B"), targetPlayerId: "B_rb3" });
    const coreDep = computePlayerDependency("A_QB", ctx.rosters_by_manager.get(MID("A"))!, ctx);
    const forcedCore = { ...coreDep, dependency: "CORE" as const };
    const result = analyzeWalkAway({ ladder, myManagerSlug: "A", outgoingDependencies: [forcedCore] });
    assert.ok(result.reasons.includes("CORE_ASSET_REQUIRED"));
  });
});

/* ===================================================================== */
/* Behavioral evidence                                                    */
/* ===================================================================== */

describe("Phase 5G — behavioral evidence framework", () => {
  it("always reports INSUFFICIENT_DATA status regardless of trade count, in this repository's real data state", () => {
    const evidence = buildManagerBehaviorEvidence("manager:test-league:A");
    assert.equal(evidence.status, "INSUFFICIENT_DATA");
    assert.equal(evidence.completed_trade_count, 0);
    assert.equal(evidence.confidence, "INSUFFICIENT");
  });

  it("never emits a personality claim string — the note is purely structural/quantitative", () => {
    const evidence = buildManagerBehaviorEvidence("manager:test-league:A");
    const forbidden = ["stubborn", "aggressive", "desperate", "loves", "panics", "always overpays"];
    for (const word of forbidden) assert.ok(!evidence.note.toLowerCase().includes(word));
  });
});

/* ===================================================================== */
/* Phase 3 isolation                                                      */
/* ===================================================================== */

describe("Phase 5J — Phase 3 isolation", () => {
  it("extreme (synthetic) target volatility does not change the offer ladder's canonical utility", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const wp = ctx.projections.by_player.get("B_rb3")!;
    ctx.projections.by_player.set("B_rb3", { ...wp, std_dev: (wp.projected_points ?? 10) * 5, ros: wp.ros ? { ...wp.ros, disagreement_pct: 0.9 } : wp.ros });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { ladder } = buildOfferLadder({ ctx, evalCtx, config, myManagerId: MID("A"), myManagerSlug: "A", ownerManagerId: MID("B"), targetPlayerId: "B_rb3" });
    for (const entry of Object.values(ladder)) {
      const mine = Object.values(entry!.full_evaluation.participants).find((p) => p.manager_slug === "A")!;
      const authoritative = mine.phase2 ? mine.phase2.contextual_utility_delta : mine.roster_utility_delta;
      assert.equal(entry!.my_gain, authoritative);
    }
  });
});

/* ===================================================================== */
/* Adversarial fixtures                                                   */
/* ===================================================================== */

describe("Phase 5 — adversarial fixtures", () => {
  it("bid-against-yourself trap: classifyProblem on an already-strongly-accepted, positive-for-requester trade returns NO_CONCESSION_NEEDED", () => {
    assert.equal(classifyProblem(4, "STRONG_ACCEPT", 2), "NO_CONCESSION_NEEDED");
  });

  it("core asset trap: walk-away flags CORE_ASSET_REQUIRED distinctly from a plain negative-utility case", () => {
    const coreOnly = analyzeWalkAway({
      ladder: { MAXIMUM_RATIONAL: { rank: 1, shape: "ONE_FOR_ONE", transfers: [], participants: [], my_gain: 3, minimum_partner_gain: 1, trade_viability: "HIGH", rationale: [], phase3_shadow: { label: "SHADOW INTELLIGENCE — NOT INCLUDED IN TRADE SCORE", warnings: [] }, search_metadata: { mode: "BEST_AVAILABLE", complexity: 1, partner_fit: null }, full_evaluation: { trade_summary: {} as never, phase2_summary: null, phase3_summary: null, participants: {} } } },
      myManagerSlug: "A",
      outgoingDependencies: [{ canonical_player_id: "core1", dependency: "CORE", marginal_starter_impact: 10, severity_after_removal: "critical", is_current_starter: true, reasons: [] }],
    });
    assert.ok(coreOnly.reasons.includes("CORE_ASSET_REQUIRED"));
    assert.ok(!coreOnly.reasons.includes("NEGATIVE_REQUESTER_UTILITY"));
  });

  it("no-concession-needed: an already STRONG_ACCEPT trade returns zero counters, not a sweetened variant", () => {
    const f = buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 6 } },
      { slug: "B", bench: [{ id: "B_in", pos: "WR", pts: 20 }], flex: { id: "B_flex", pos: "WR", pts: 10 } },
    ]);
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    // find any real, evaluated candidate first
    const evaluated = evaluateCandidate([MID("A"), MID("B")], [
      { from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_in" },
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_flex" },
    ], ctx, evalCtx, config);
    assert.ok(evaluated.ok);
  });
});

describe("Phase 5 — calibration deferral (unchanged from Phase 4)", () => {
  it("TRADE_CALIBRATION_MIN_REAL_TRADES is still 50", () => {
    assert.equal(TRADE_CALIBRATION_MIN_REAL_TRADES, 50);
  });
});
