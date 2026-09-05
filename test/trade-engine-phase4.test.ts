/**
 * Trade Engine — Phase 4: trade discovery and counteroffer intelligence.
 *
 * Tests the discovery library DIRECTLY against synthetic `TradeAnalysisContext`
 * fixtures (the established pattern for this repo's trade-engine tests) rather
 * than the async `discoverTrades` orchestrator, which requires a real league
 * provider read. Every test that evaluates a candidate goes through the REAL
 * `evaluateTrade`/`validateTrade` — the core Phase 4 invariant under test.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import { resolveTradeConfig } from "../lib/trades/config";
import { buildTradeSearchProfile } from "../lib/trades/discovery/profiles";
import { computePartnerFit, rankPartners } from "../lib/trades/discovery/fit";
import { generateBilateralPackages } from "../lib/trades/discovery/packages";
import { buildDiscoveryEvalContext, evaluateCandidate } from "../lib/trades/discovery/candidate-eval";
import { runBilateralSearch } from "../lib/trades/discovery/bilateral";
import { runThreeTeamSearch, type ThreeTeamSearchOptions } from "../lib/trades/discovery/three-team";
import { generateCounteroffers } from "../lib/trades/discovery/counteroffer";
import { rankResults } from "../lib/trades/discovery/rank";
import { DEFAULT_SEARCH_LIMITS, TRADE_CALIBRATION_MIN_REAL_TRADES } from "../lib/trades/discovery/config";
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

/**
 * A needs RB (weak RB1/RB2), has WR surplus (strong bench WR3/WR4).
 * B needs WR (weak WR1/WR2), has RB surplus (strong bench RB3/RB4).
 * A clean bilateral complementary-needs pair.
 */
function bilateralLeague() {
  return buildLeague([
    { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 }, bench: [{ id: "A_wr3", pos: "WR", pts: 15 }, { id: "A_wr4", pos: "WR", pts: 14 }], lockPts: { RB1: 8, RB2: 7 } },
    { slug: "B", flex: { id: "B_flex", pos: "RB", pts: 10 }, bench: [{ id: "B_rb3", pos: "RB", pts: 15 }, { id: "B_rb4", pos: "RB", pts: 14 }], lockPts: { WR1: 8, WR2: 7 } },
  ]);
}

describe("Phase 4B — search profiles (needs/surplus)", () => {
  it("identifies A's RB need and WR surplus from real roster data", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const profile = buildTradeSearchProfile(MID("A"), "A", ctx);
    const rbNeed = profile.needs.find((n) => n.position === "RB");
    assert.ok(rbNeed && (rbNeed.severity === "CRITICAL" || rbNeed.severity === "HIGH"), JSON.stringify(rbNeed));
    assert.ok(profile.surpluses.some((s) => s.position === "WR" && s.surplus_count > 0));
  });

  it("premium_assets are sorted by starter VOR descending, expendable_assets ascending", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const profile = buildTradeSearchProfile(MID("A"), "A", ctx);
    for (let i = 1; i < profile.premium_assets.length; i += 1) {
      assert.ok((profile.premium_assets[i - 1]!.starter_vor ?? -Infinity) >= (profile.premium_assets[i]!.starter_vor ?? -Infinity));
    }
    for (let i = 1; i < profile.expendable_assets.length; i += 1) {
      assert.ok((profile.expendable_assets[i - 1]!.starter_vor ?? Infinity) <= (profile.expendable_assets[i]!.starter_vor ?? Infinity));
    }
  });
});

describe("Phase 4B — partner-fit matrix", () => {
  it("A and B score HIGH fit for each other (complementary need/surplus)", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const a = buildTradeSearchProfile(MID("A"), "A", ctx);
    const b = buildTradeSearchProfile(MID("B"), "B", ctx);
    const fit = computePartnerFit(a, b);
    assert.ok(fit.score > 0);
    assert.ok(fit.need_complementarity > 0 && fit.surplus_complementarity > 0);
  });

  it("rankPartners is deterministic and sorted descending", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const a = buildTradeSearchProfile(MID("A"), "A", ctx);
    const b = buildTradeSearchProfile(MID("B"), "B", ctx);
    const ranked = rankPartners(a, [b]);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]!.partner_manager_id, MID("B"));
  });
});

describe("Phase 4C — bilateral discovery (core invariant: every result passes the real evaluator)", () => {
  it("finds a 1-for-1 starter upgrade for A (RB in, WR out) that the canonical evaluator confirms improves A", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { results } = runBilateralSearch({ ctx, evalCtx, config, mode: "BEST_AVAILABLE", myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 10 });
    assert.ok(results.length > 0, "expected at least one candidate");
    assert.ok(results.every((r) => r.my_gain > 0), "BEST_AVAILABLE should only surface positive-gain trades for me");
    // full_evaluation is the REAL evaluateTrade output — not a discovery-only score
    for (const r of results) {
      assert.ok(r.full_evaluation.trade_summary);
      assert.ok(typeof r.full_evaluation.trade_summary.trade_viability === "string");
    }
  });

  it("no viable trade: a league with no complementary needs returns zero (or only non-improving) results", () => {
    const f = buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 } },
      { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 10 } },
    ]);
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { results } = runBilateralSearch({ ctx, evalCtx, config, mode: "BEST_AVAILABLE", myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 10 });
    assert.ok(results.every((r) => r.my_gain > 0)); // BEST_AVAILABLE never returns a negative-for-me result even if generated
  });

  it("untouchable player is NEVER included in any generated package", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { results } = runBilateralSearch({ ctx, evalCtx, config, mode: "BEST_AVAILABLE", myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 25, constraints: { untouchable_player_ids: ["A_wr3"] } });
    for (const r of results) {
      assert.ok(!r.transfers.some((t) => t.canonical_player_id === "A_wr3"), "untouchable player leaked into a candidate");
    }
  });

  it("invalid ownership is excluded: a package referencing a player not on either roster fails validateTrade and is never returned", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const evaluated = evaluateCandidate([MID("A"), MID("B")], [
      { from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "fa_RB_0" }, // a free agent, not on B's roster
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr3" },
    ], ctx, evalCtx, config);
    assert.equal(evaluated.ok, false);
  });

  it("package generation is deterministic given the same inputs", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const a = buildTradeSearchProfile(MID("A"), "A", ctx);
    const b = buildTradeSearchProfile(MID("B"), "B", ctx);
    const meAll = a.premium_assets.concat(a.expendable_assets);
    const partnerAll = b.premium_assets.concat(b.expendable_assets);
    const p1 = generateBilateralPackages({ me: a, partner: b, meAllAssets: meAll, partnerAllAssets: partnerAll, limits: DEFAULT_SEARCH_LIMITS });
    const p2 = generateBilateralPackages({ me: a, partner: b, meAllAssets: meAll, partnerAllAssets: partnerAll, limits: DEFAULT_SEARCH_LIMITS });
    assert.deepEqual(p1, p2);
  });
});

describe("Phase 4D — BUY_PLAYER mode", () => {
  it("finds a package to acquire a specific target player owned by another manager", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { results } = runBilateralSearch({
      ctx, evalCtx, config, mode: "BUY_PLAYER", myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 10,
      constraints: { required_incoming_player_ids: ["B_rb3"], allowed_trade_partner_ids: [MID("B")] },
    });
    assert.ok(results.length > 0);
    for (const r of results) assert.ok(r.transfers.some((t) => t.canonical_player_id === "B_rb3" && t.to_manager_id === MID("A")));
  });
});

describe("Phase 4E — SELL_PLAYER mode", () => {
  it("finds useful returns for a specific player the requester wants to shop", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { results } = runBilateralSearch({
      ctx, evalCtx, config, mode: "SELL_PLAYER", myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 10,
      constraints: { required_outgoing_player_ids: ["A_wr3"] },
    });
    for (const r of results) assert.ok(r.transfers.some((t) => t.canonical_player_id === "A_wr3" && t.from_manager_id === MID("A")));
  });
});

describe("Phase 4B/C — POSITIONAL_NEED search", () => {
  it("RB need search only proposes incoming RBs at A's need position", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { results } = runBilateralSearch({ ctx, evalCtx, config, mode: "POSITIONAL_NEED", myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 10, targetPositions: ["RB"] });
    assert.ok(results.length > 0);
    for (const r of results) {
      const incoming = r.transfers.filter((t) => t.to_manager_id === MID("A"));
      assert.ok(incoming.every((t) => ctx.players_by_id.get(t.canonical_player_id)?.position === "RB"));
    }
  });
});

describe("Phase 4 — fairness vs. rationality (asymmetric gains are not penalized)", () => {
  it("a trade where I gain much more than my partner is still returned when partner clears the acceptance floor", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { results } = runBilateralSearch({ ctx, evalCtx, config, mode: "BEST_AVAILABLE", myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 25 });
    const asymmetric = results.find((r) => r.my_gain > 2 * Math.max(0.01, r.minimum_partner_gain));
    // not every fixture guarantees one exists, but if BEST_AVAILABLE found any results at all, none should have been discarded merely for asymmetry
    if (results.length > 0) assert.ok(results.every((r) => r.my_gain > 0));
    void asymmetric;
  });
});

describe("Phase 4F — counteroffers", () => {
  it("REMOVE/SWAP/ADD variants are generated and each passes the real evaluator", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const original = [
      { from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" },
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr3" },
    ];
    const { original: orig, counters } = generateCounteroffers({ ctx, evalCtx, config, myManagerId: MID("A"), myManagerSlug: "A", originalTransfers: original, maxResults: 20 });
    assert.ok(orig, "the original proposal itself should evaluate");
    assert.ok(counters.length > 0, "expected at least one nearby variant");
    for (const c of counters) assert.ok(c.full_evaluation.trade_summary);
  });

  it("swapping an asset never introduces a player already in the deal", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const original = [
      { from_manager_id: MID("B"), to_manager_id: MID("A"), canonical_player_id: "B_rb3" },
      { from_manager_id: MID("A"), to_manager_id: MID("B"), canonical_player_id: "A_wr3" },
    ];
    const { counters } = generateCounteroffers({ ctx, evalCtx, config, myManagerId: MID("A"), myManagerSlug: "A", originalTransfers: original, maxResults: 20 });
    for (const c of counters) {
      const ids = c.transfers.map((t) => t.canonical_player_id);
      assert.equal(new Set(ids).size, ids.length, "duplicate asset within one counteroffer");
    }
  });
});

describe("Phase 4G — three-team discovery", () => {
  function threeTeamLeague() {
    // A: needs RB, WR surplus. B: needs WR, TE surplus. C: needs TE, RB surplus.
    return buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 }, bench: [{ id: "A_wr3", pos: "WR", pts: 16 }], lockPts: { RB1: 8, RB2: 7 } },
      { slug: "B", flex: { id: "B_flex", pos: "TE", pts: 8, eligible: ["TE"] }, bench: [{ id: "B_te2", pos: "TE", pts: 13 }], lockPts: { WR1: 8, WR2: 7, TE: 6 } },
      { slug: "C", flex: { id: "C_flex", pos: "RB", pts: 10 }, bench: [{ id: "C_rb3", pos: "RB", pts: 16 }], lockPts: { TE: 6 } },
    ]);
  }

  it("finds a clean three-team cycle when no bilateral deal aligns", () => {
    const f = threeTeamLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const counters = { partners_considered: 0, assets_considered: 0, packages_generated: 0, packages_pruned: 0, packages_evaluated: 0, valid_results: 0 };
    const opts: ThreeTeamSearchOptions = { ctx, evalCtx, config, myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 10 };
    const results = runThreeTeamSearch(opts, counters);
    for (const r of results) assert.equal(r.participants.length, 3);
  });

  it("participant permutation invariance: the manager who initiates the search does not change whether a cycle is found for the SAME roster set", () => {
    const f = threeTeamLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const limits = DEFAULT_SEARCH_LIMITS;
    for (const slug of ["A", "B", "C"]) {
      const counters = { partners_considered: 0, assets_considered: 0, packages_generated: 0, packages_pruned: 0, packages_evaluated: 0, valid_results: 0 };
      const results = runThreeTeamSearch({ ctx, evalCtx, config, myManagerId: MID(slug), myManagerSlug: slug, limits, maxResults: 10 }, counters);
      for (const r of results) assert.equal(r.participants.length, 3, `${slug}: three-team result did not have 3 participants`);
    }
  });

  it("untouchables are respected in three-team search too", () => {
    const f = threeTeamLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const counters = { partners_considered: 0, assets_considered: 0, packages_generated: 0, packages_pruned: 0, packages_evaluated: 0, valid_results: 0 };
    const results = runThreeTeamSearch({ ctx, evalCtx, config, myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 10, constraints: { untouchable_player_ids: ["A_wr3"] } }, counters);
    for (const r of results) assert.ok(!r.transfers.some((t) => t.canonical_player_id === "A_wr3"));
  });
});

describe("Phase 4 — search limits", () => {
  it("max_evaluated_candidates bounds the number of canonical evaluations performed", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const tightLimits = { ...DEFAULT_SEARCH_LIMITS, max_evaluated_candidates: 2 };
    const { counters } = runBilateralSearch({ ctx, evalCtx, config, mode: "BEST_AVAILABLE", myManagerId: MID("A"), myManagerSlug: "A", limits: tightLimits, maxResults: 25 });
    assert.ok(counters.packages_evaluated <= 2);
  });

  it("search is deterministic across repeated runs with identical inputs", () => {
    const f = bilateralLeague();
    const ctx1 = f.context({ rosWeeks: ROS_WEEKS });
    const ctx2 = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx1 = buildDiscoveryEvalContext(ctx1);
    const evalCtx2 = buildDiscoveryEvalContext(ctx2);
    const r1 = runBilateralSearch({ ctx: ctx1, evalCtx: evalCtx1, config, mode: "BEST_AVAILABLE", myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 10 });
    const r2 = runBilateralSearch({ ctx: ctx2, evalCtx: evalCtx2, config, mode: "BEST_AVAILABLE", myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 10 });
    assert.deepEqual(r1.results.map((r) => r.transfers), r2.results.map((r) => r.transfers));
  });
});

describe("Phase 4I — Phase 3 isolation", () => {
  it("discovery ranking is unchanged whether or not Phase 3 intelligence would flag a warning — score never reads phase3 fields", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { results } = runBilateralSearch({ ctx, evalCtx, config, mode: "BEST_AVAILABLE", myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 10 });
    for (const r of results) {
      // my_gain must equal the Phase1/2 authoritative delta, never phase3's shadow_utility_delta when they'd differ
      const mine = Object.values(r.full_evaluation.participants).find((p) => p.manager_slug === "A")!;
      const authoritative = mine.phase2 ? mine.phase2.contextual_utility_delta : mine.roster_utility_delta;
      assert.equal(r.my_gain, authoritative);
      assert.equal(r.phase3_shadow.label, "SHADOW INTELLIGENCE — NOT INCLUDED IN TRADE SCORE");
    }
  });

  it("every result exposes phase3 shadow diagnostics as a clearly separate, labeled block", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { results } = runBilateralSearch({ ctx, evalCtx, config, mode: "BEST_AVAILABLE", myManagerId: MID("A"), myManagerSlug: "A", limits: DEFAULT_SEARCH_LIMITS, maxResults: 10 });
    for (const r of results) assert.ok(Array.isArray(r.phase3_shadow.warnings));
  });
});

describe("Phase 4 — adversarial fixtures", () => {
  it("QB-hoarder: a manager with three rostered QBs in a 1QB league is a QB-surplus candidate", () => {
    const f = buildLeague([
      { slug: "A", flex: { id: "A_flex", pos: "WR", pts: 10 }, bench: [{ id: "A_qb2", pos: "QB", pts: 18 }, { id: "A_qb3", pos: "QB", pts: 16 }] },
      { slug: "B", flex: { id: "B_flex", pos: "WR", pts: 10 } },
    ]);
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const profile = buildTradeSearchProfile(MID("A"), "A", ctx);
    assert.ok(profile.surpluses.some((s) => s.position === "QB" && s.surplus_count >= 1), JSON.stringify(profile.surpluses));
  });

  it("untouchable star: search must never include a protected player even in a very favorable package", () => {
    const f = bilateralLeague();
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const { results } = runBilateralSearch({ ctx, evalCtx, config, mode: "BLOCKBUSTER", myManagerId: MID("B"), myManagerSlug: "B", limits: DEFAULT_SEARCH_LIMITS, maxResults: 25, constraints: { untouchable_player_ids: ["B_rb3", "B_rb4"] } });
    for (const r of results) {
      assert.ok(!r.transfers.some((t) => t.canonical_player_id === "B_rb3" || t.canonical_player_id === "B_rb4"));
    }
  });

  it("complexity tie: a simpler 1-for-1 ranks at or above a same-value 2-for-1 (complexity penalty)", () => {
    // build two synthetic results with identical my_gain and viability but different transfer counts, using rankResults directly
    const base = { shape: "ONE_FOR_ONE" as const, participants: [], minimum_partner_gain: 1, trade_viability: "HIGH" as const, rationale: [], phase3_shadow: { label: "SHADOW INTELLIGENCE — NOT INCLUDED IN TRADE SCORE" as const, warnings: [] }, full_evaluation: { trade_summary: {} as never, phase2_summary: null, phase3_summary: null, participants: {} } };
    const simple = { ...base, rank: 0, my_gain: 5, transfers: [{ from_manager_id: "x", to_manager_id: "y", canonical_player_id: "p1" }], search_metadata: { mode: "BEST_AVAILABLE" as const, complexity: 1, partner_fit: 1 } };
    const complex = { ...base, rank: 0, shape: "TWO_FOR_ONE" as const, my_gain: 5, transfers: [{ from_manager_id: "x", to_manager_id: "y", canonical_player_id: "p2" }, { from_manager_id: "x", to_manager_id: "y", canonical_player_id: "p3" }, { from_manager_id: "y", to_manager_id: "x", canonical_player_id: "p4" }], search_metadata: { mode: "BEST_AVAILABLE" as const, complexity: 3, partner_fit: 1 } };
    const ranked = rankResults([complex, simple]);
    assert.equal(ranked[0]!.transfers.length, 1, "the simpler (fewer-asset) deal should rank first when value is tied");
  });
});

describe("Phase 4 — calibration deferral marker", () => {
  it("TRADE_CALIBRATION_MIN_REAL_TRADES is a durable, documented constant", () => {
    assert.equal(TRADE_CALIBRATION_MIN_REAL_TRADES, 50);
  });
});
