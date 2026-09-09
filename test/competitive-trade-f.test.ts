/**
 * Competitive Trade Intelligence — Checkpoint F: liquidity, market appreciation,
 * buy-and-hold, direct-vs-two-step paths, and the shared request-scoped
 * evaluation context.
 *
 * Deterministic. Shared-context correctness (§74) and performance counters
 * (§75) use `tradeFixture` contexts — NO wall-clock assertions. Liquidity /
 * appreciation / hold selection logic is unit-tested with hand-built inputs.
 * Covers spec §5–§56, §72–§75 and the §86 freeze gates.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import type { CanonicalPosition, CanonicalDraftPick } from "../lib/canonical/schema";
import {
  buildCompetitiveTradeEvaluationContext,
  assertContextMatchesSnapshot,
  evaluateCompetitiveTrade,
  buildTradeLiquidity,
  buildMarketAppreciation,
  buildHoldEvaluation,
  buildStrategyPathComparison,
  describeReservationLevel,
} from "../lib/trades/competitive";
import type { CompetitiveTradeEvaluationContext } from "../lib/trades/competitive";
import type { MarketEdge, TradeLiquidity, MarketAppreciation } from "../lib/trades/competitive/schema";

const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) =>
  [0, 1, 2, 3].map((i) => proj(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, { rest_of_season_points: (p === "QB" ? 12 - i : 6 - i) * ROS_WEEKS })),
);
const MID = (slug: string) => `manager:test-league:${slug}`;

function dp(manager: string, pid: string, round: number, pick: number): CanonicalDraftPick {
  return {
    canonical_draft_pick_id: `dp:${pid}`,
    canonical_league_id: "league:test-league",
    season: 2026,
    round,
    pick_number: pick,
    draft_slot: 1,
    canonical_team_id: null,
    canonical_manager_id: MID(manager),
    canonical_player_id: pid,
    auction_amount: null,
    is_keeper: false,
    provenance: { provider: "sleeper", provider_id: pid, provider_synced_at: null },
  };
}

function fixtureCtx() {
  const built = ([
    { slug: "alpha", flex: { id: "a_flex", pos: "WR", pts: 11 }, bench: [{ id: "a_offer", pos: "RB", pts: 6 }, { id: "a_bench_wr", pos: "WR", pts: 4 }], lockPts: { RB1: 6, RB2: 5 } },
    { slug: "bravo", flex: { id: "b_flex", pos: "RB", pts: 15 }, bench: [{ id: "b_rb_target", pos: "RB", pts: 13 }, { id: "b_scrub", pos: "WR", pts: 2 }], lockPts: { WR1: 8, WR2: 7 } },
    { slug: "charlie", flex: { id: "c_flex", pos: "WR", pts: 12 }, bench: [{ id: "c_rb", pos: "RB", pts: 10 }], lockPts: { RB1: 7, RB2: 6 } },
  ] as StdTeamSpec[]).map(stdTeam);
  const fix = tradeFixture({
    teams: built.map((b) => b.team),
    players: built.flatMap((b) => b.players),
    projections: built.flatMap((b) => b.projections),
    freeAgents: FA,
    faProjections: FA_PROJ,
    transfers: [],
    rosFlatHorizon: ROS_WEEKS,
    teamCount: 12,
  });
  const ctx = fix.context({ rosWeeks: ROS_WEEKS });
  ctx.snapshot.draft_picks.push(dp("bravo", "b_rb_target", 5, 55), dp("alpha", "a_offer", 9, 100));
  return ctx;
}

/* ------------------------------------------------------------------ §74/§75 */

describe("Competitive Trade F — shared evaluation context (§74, §75)", () => {
  it("precomputes every league-wide input exactly once and never rebuilds it per proposal", () => {
    const ctx = fixtureCtx();
    const ec = buildCompetitiveTradeEvaluationContext(ctx);
    assert.deepEqual(ec.build_counts, { market_table: 1, dynamic_edges: 1, league_threat: 1, market_consensus: 1 });

    for (let i = 0; i < 5; i++) {
      evaluateCompetitiveTrade({
        baseline: fakeBaseline(),
        ctx,
        my_manager_id: MID("alpha"),
        incoming_player_ids: ["b_rb_target"],
        outgoing_player_ids: ["a_offer"],
        counterparty_manager_id: MID("bravo"),
        eval_context: ec,
      });
    }
    // counters, NOT wall-clock — the shared structures were reused every time
    assert.deepEqual(ec.build_counts, { market_table: 1, dynamic_edges: 1, league_threat: 1, market_consensus: 1 });
  });

  it("a shared-context evaluation is byte-equivalent to a fresh one (§74)", () => {
    const ctx = fixtureCtx();
    const ec = buildCompetitiveTradeEvaluationContext(ctx);
    const args = {
      baseline: fakeBaseline(),
      ctx,
      my_manager_id: MID("alpha"),
      incoming_player_ids: ["b_rb_target"],
      outgoing_player_ids: ["a_offer"],
      counterparty_manager_id: MID("bravo"),
    };
    const fresh = evaluateCompetitiveTrade({ ...args });
    const shared = evaluateCompetitiveTrade({ ...args, eval_context: ec });
    assert.deepEqual(stripVolatile(shared.competitive), stripVolatile(fresh.competitive));
  });

  it("different managers get different owner contexts; the snapshot guard rejects a mismatched ctx", () => {
    const ctx = fixtureCtx();
    const ec = buildCompetitiveTradeEvaluationContext(ctx);
    const a = ec.owner_context(MID("alpha"));
    const b = ec.owner_context(MID("bravo"));
    assert.notEqual(a.manager_id, b.manager_id);
    assert.notDeepEqual(
      a.profile.needs.map((n) => `${n.position}:${n.severity}`).sort(),
      b.profile.needs.map((n) => `${n.position}:${n.severity}`).sort(),
    );
    // memoized — same object back
    assert.equal(ec.owner_context(MID("alpha")), a);

    const other = fixtureCtx();
    other.snapshot.captured_at = new Date(Date.parse(other.snapshot.captured_at) + 86_400_000).toISOString();
    assert.throws(() => assertContextMatchesSnapshot(ec, other), /snapshot mismatch/);
  });
});

/* ------------------------------------------------------------------- §5–§9  */

describe("Competitive Trade F — trade liquidity (§5–§9)", () => {
  it("is estimated for US as the hypothetical owner and never scans the current owner", () => {
    const ctx = fixtureCtx();
    const ec = buildCompetitiveTradeEvaluationContext(ctx);
    const liq = buildTradeLiquidity({
      ec,
      canonical_player_id: "b_rb_target",
      current_owner_manager_id: MID("bravo"),
      my_manager_id: MID("alpha"),
    });
    assert.equal(liq.hypothetical_owner, "US_POST_ACQUISITION");
    assert.ok(["VERY_LOW", "LOW", "MODERATE", "HIGH", "VERY_HIGH"].includes(liq.classification));
    assert.equal(liq.buyer_count, liq.high_fit_buyers + liq.moderate_fit_buyers);
    for (const buyer of liq.potential_buyers) {
      assert.notEqual(buyer.manager_id, MID("bravo"), "current owner is excluded (§9)");
      assert.notEqual(buyer.manager_id, MID("alpha"), "we are the hypothetical owner, not a buyer");
    }
    assert.ok((liq.reasons[0] ?? "").includes("owner-independent"));
  });

  it("more plausible buyers ⇒ at least as liquid (monotonic)", () => {
    const ctx = fixtureCtx();
    const ec = buildCompetitiveTradeEvaluationContext(ctx);
    const rank = (l: TradeLiquidity) => ["VERY_LOW", "LOW", "MODERATE", "HIGH", "VERY_HIGH"].indexOf(l.classification);
    const strict = buildTradeLiquidity({ ec, canonical_player_id: "b_rb_target", current_owner_manager_id: MID("bravo"), my_manager_id: MID("alpha") });
    const loose = buildTradeLiquidity({
      ec,
      canonical_player_id: "b_rb_target",
      current_owner_manager_id: MID("bravo"),
      my_manager_id: MID("alpha"),
      config: { liquidity: { bands: { very_high: 3, high: 2, moderate: 1, low: 1 } } },
    });
    assert.ok(rank(loose) >= rank(strict));
  });
});

/* ----------------------------------------------------------------- §10–§16  */

function edge(o: Partial<MarketEdge>): MarketEdge {
  return {
    canonical_player_id: "X",
    name: "Player X",
    position: "RB",
    nfl_team: "AAA",
    private_value: { basis: "ri_ros_weekly_vor", raw: 10, normalized_value: 1.2, percentile: 0.9, position_rank: 3, confidence: "MEDIUM", as_of: null, model_version: null },
    market_value: { basis: "weekly_vor", raw: 6, normalized_value: 0.2, percentile: 0.6, position_rank: 12, confidence: "MEDIUM", as_of: null, model_version: null },
    direction: "BUY",
    edge_score: 1.0,
    actionable_edge: 0.8,
    confidence: "MEDIUM",
    reason_codes: [],
    reasons: [],
    lineage: {} as never,
    analytical_only: true,
    edge_vs_current_market: 1.0,
    market_correction: "MARKET_NOT_CORRECTED",
    market_trajectory: "STABLE",
    quality_status: "NORMAL",
    temporal: { evidence_readiness: "CURRENT" } as never,
    ...o,
  };
}

function fakeEc(e: MarketEdge): CompetitiveTradeEvaluationContext {
  return {
    ctx: { players_by_id: new Map([[e.canonical_player_id, { full_name: e.name, position: e.position }]]) },
    dynamic_edges: new Map([[e.canonical_player_id, e]]),
    market_table: { edges: { by_player: new Map([[e.canonical_player_id, e]]) } },
  } as unknown as CompetitiveTradeEvaluationContext;
}

describe("Competitive Trade F — market appreciation potential (§10–§16)", () => {
  it("consumes the Checkpoint B.5 correction state — never recomputes it (§14)", () => {
    const corrected = buildMarketAppreciation({ ec: fakeEc(edge({ market_correction: "MARKET_CORRECTED" })), canonical_player_id: "X" });
    assert.equal(corrected.classification, "MARKET_ALREADY_CORRECTED");
    const overshot = buildMarketAppreciation({ ec: fakeEc(edge({ market_correction: "MARKET_OVERSHOT" })), canonical_player_id: "X" });
    assert.equal(overshot.classification, "DEPRECIATION_RISK");
  });

  it("a large gap not supported by confidence / quality ⇒ REVIEW_REQUIRED, never HIGH (§13)", () => {
    const a = buildMarketAppreciation({
      ec: fakeEc(edge({ edge_vs_current_market: 1.8, confidence: "VERY_LOW", quality_status: "REVIEW_REQUIRED" })),
      canonical_player_id: "X",
    });
    assert.equal(a.classification, "REVIEW_REQUIRED");
  });

  it("early-season evidence caps appreciation certainty (§55) and the result is always speculative (§30)", () => {
    const a = buildMarketAppreciation({
      ec: fakeEc(edge({ edge_vs_current_market: 1.4, reason_codes: ["USAGE_BREAKOUT_SUPPORTS_PRIVATE", "OPPONENT_ADJUSTED_OUTPERFORMANCE"], temporal: { evidence_readiness: "EARLY_SEASON" } as never })),
      canonical_player_id: "X",
    });
    assert.notEqual(a.classification, "HIGH_APPRECIATION_POTENTIAL");
    assert.equal(a.is_speculative, true);
  });
});

/* ----------------------------------------------------------------- §17–§34  */

function liq(o: Partial<TradeLiquidity>): TradeLiquidity {
  return {
    canonical_player_id: "X",
    name: "Player X",
    position: "RB",
    hypothetical_owner: "US_POST_ACQUISITION",
    classification: "MODERATE",
    potential_buyers: [],
    buyer_count: 3,
    high_fit_buyers: 1,
    moderate_fit_buyers: 2,
    positional_scarcity_ratio: 1.0,
    market_perception_confidence: "MEDIUM",
    readiness: "FULL_LIQUIDITY_CONTEXT",
    reasons: [],
    ...o,
  };
}
function appr(o: Partial<MarketAppreciation>): MarketAppreciation {
  return {
    canonical_player_id: "X",
    name: "Player X",
    position: "RB",
    classification: "LIMITED_APPRECIATION_POTENTIAL",
    private_market_gap: 0.2,
    market_correction_state: "MARKET_NOT_CORRECTED",
    market_trajectory: "STABLE",
    evidence_readiness: "CURRENT",
    confidence: "MEDIUM",
    catalysts: [],
    invalidation_conditions: [],
    is_speculative: true,
    reasons: [],
    ...o,
  };
}

describe("Competitive Trade F — buy-and-hold (§17–§19, §34)", () => {
  it("DO_NOTHING is a legitimate terminal decision, not a failure", () => {
    const h = buildHoldEvaluation({
      acquire_ids: ["X"],
      permanent_gain: 0.05,
      permanent_confidence: "LOW",
      liquidity: [liq({ classification: "LOW", buyer_count: 1, high_fit_buyers: 0, moderate_fit_buyers: 1 })],
      appreciation: [appr({ classification: "LIMITED_APPRECIATION_POTENTIAL" })],
      weeks_remaining: 6,
    });
    assert.equal(h.decision, "DO_NOTHING");
    assert.ok(h.reasons.join(" ").toLowerCase().includes("not a failure") || h.reasons.join(" ").includes("§17"));
  });

  it("a solid permanent gain with optionality ⇒ ACQUIRE_AND_HOLD; components are decomposed with no fake dollars", () => {
    const h = buildHoldEvaluation({
      acquire_ids: ["X"],
      permanent_gain: 2.4,
      permanent_confidence: "MEDIUM",
      liquidity: [liq({ classification: "HIGH", buyer_count: 5, high_fit_buyers: 3, moderate_fit_buyers: 2, positional_scarcity_ratio: 0.7 })],
      appreciation: [appr({ classification: "MODERATE_APPRECIATION_POTENTIAL", confidence: "MEDIUM" })],
      weeks_remaining: 10,
    });
    assert.equal(h.decision, "ACQUIRE_AND_HOLD");
    for (const v of Object.values(h.components)) assert.ok(v == null || Number.isFinite(v));
    assert.ok(Number.isFinite(h.future_optionality.score));
    // §34 — optionality is distinct from the permanent roster gain
    assert.notEqual(h.future_optionality.score, h.components.current_permanent_roster_gain);
    assert.ok(h.hold_until_conditions.length > 0);
  });
});

/* ----------------------------------------------------------------- §20–§54  */

describe("Competitive Trade F — bounded multi-step trade paths (§20–§54, §77)", () => {
  it("always includes NO_ACTION and HOLD_CURRENT_ASSET; no path exceeds two completed trades; deterministic", () => {
    const ctx = fixtureCtx();
    const ec = buildCompetitiveTradeEvaluationContext(ctx);
    const a = buildStrategyPathComparison({ ec, my_manager_id: MID("alpha") });
    const b = buildStrategyPathComparison({ ec, my_manager_id: MID("alpha") });

    const strategies = a.paths.map((p) => p.strategy);
    assert.ok(strategies.includes("NO_ACTION"));
    assert.ok(strategies.includes("HOLD_CURRENT_ASSET"));
    for (const p of a.paths) {
      assert.ok(p.steps.length <= 2, "max_completed_trades = 2");
      assert.ok(p.aggregate.transactions <= 2);
    }
    assert.ok(["DIRECT_ACQUISITION", "BUY_AND_HOLD", "INTERMEDIATE_TRADE", "TWO_STEP_UPGRADE", "HOLD_CURRENT_ASSET", "NO_ACTION", "REVIEW_REQUIRED"].includes(a.recommended));
    assert.equal(typeof a.search_stats.circular_paths_blocked, "number");

    const norm = (c: typeof a) => ({ ...c, search_stats: { ...c.search_stats, elapsed_ms: 0 } });
    assert.deepEqual(norm(a), norm(b));
  });
});

/* ------------------------------------------------------------------- §72/§73 */

describe("Competitive Trade F — human-facing value semantics (§72, §73)", () => {
  it("§72 — a small negative reservation is never described as negative fantasy value", () => {
    const d = describeReservationLevel(-0.41);
    assert.ok(!/negative/i.test(d));
    assert.ok(/low owner reservation value relative to league baseline/i.test(d));
  });

  it("§73 — acceptance separates raw perceived value surplus from the context adjustments", () => {
    const ctx = fixtureCtx();
    const ec = buildCompetitiveTradeEvaluationContext(ctx);
    const out = evaluateCompetitiveTrade({
      baseline: fakeBaseline(),
      ctx,
      my_manager_id: MID("alpha"),
      incoming_player_ids: ["b_rb_target"],
      outgoing_player_ids: ["a_offer"],
      counterparty_manager_id: MID("bravo"),
      eval_context: ec,
    });
    const acc = out.competitive.acceptance;
    assert.ok(acc, "acceptance present");
    if (acc) {
      assert.ok(acc.raw_perceived_value_surplus === null || Number.isFinite(acc.raw_perceived_value_surplus));
      assert.ok(Number.isFinite(acc.acceptance_context_adjustments.total));
      assert.equal(acc.overall_acceptance_likelihood, acc.likelihood);
      if ((acc.raw_perceived_value_surplus ?? 0) >= 0) assert.equal(acc.accepts_despite_negative_value_perception, false);
    }
  });
});

/* ---- minimal baseline (competitive layer reads only participants[*].phase2) ---- */
function fakeBaseline() {
  // evaluateCompetitiveTrade tolerates a thin baseline for the market-edge path;
  // the C/D/F blocks that need richer data degrade to PARTIAL readiness.
  return {
    participants: {},
    summary: {},
  } as never;
}

function stripVolatile<T>(block: T): T {
  return JSON.parse(
    JSON.stringify(block, (k, v) => (k === "elapsed_ms" || k === "search_stats" ? undefined : v)),
  );
}
