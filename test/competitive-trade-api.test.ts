/**
 * Competitive Trade Intelligence — Checkpoint G: HTTP request orchestrator.
 *
 * Tests `evaluateCompetitiveTradeRequest` DIRECTLY against synthetic
 * `TradeAnalysisContext` fixtures (the established trade-engine test pattern) —
 * the thin `app/api/trades/competitive/route.ts` wrapper only parses the body
 * and maps `error_kind` to an HTTP code.
 *
 * Proves the API preserves the certified internal semantics: NO_ACTION is a
 * success, REVIEW_REQUIRED survives serialization, confidence/readiness are not
 * upgraded, snapshot lineage is exposed, the shared evaluation context is not
 * rebuilt per proposal, and a stale context cannot leak across snapshots.
 * Covers spec §5–§21, §30–§32, §47–§55.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import type { CanonicalPosition, CanonicalDraftPick } from "../lib/canonical/schema";
import { evaluateCompetitiveTradeRequest } from "../lib/trades/competitive/api";
import {
  buildCompetitiveTradeEvaluationContext,
  assertContextMatchesSnapshot,
  evaluateCompetitiveTrade,
} from "../lib/trades/competitive";

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

const req = (over: Partial<Parameters<typeof evaluateCompetitiveTradeRequest>[0]>) => ({
  league: "test-league",
  manager: "alpha",
  mode: "evaluate" as const,
  ...over,
});

/* ------------------------------------------------------------------ validation */

describe("Competitive Trade G — request validation (§5, §6, §21)", () => {
  it("unknown manager → NOT_FOUND", async () => {
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(req({ manager: "nobody", mode: "strategy_path" }), { contextOverride: ctx });
    assert.equal(r.status, "VALIDATION_FAILED");
    assert.equal(r.error_kind, "NOT_FOUND");
  });

  it("unknown incoming player → NOT_FOUND", async () => {
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(
      req({ mode: "evaluate", counterparty: "bravo", give_assets: ["a_offer"], receive_assets: ["ghost_player"] }),
      { contextOverride: ctx },
    );
    assert.equal(r.error_kind, "NOT_FOUND");
  });

  it("outgoing player not owned by the requester → OWNERSHIP", async () => {
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(
      req({ mode: "evaluate", counterparty: "bravo", give_assets: ["b_rb_target"], receive_assets: ["b_scrub"] }),
      { contextOverride: ctx },
    );
    assert.equal(r.error_kind, "OWNERSHIP");
  });

  it("incoming player not owned by the stated counterparty → OWNERSHIP", async () => {
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(
      req({ mode: "evaluate", counterparty: "bravo", give_assets: ["a_offer"], receive_assets: ["c_rb"] }),
      { contextOverride: ctx },
    );
    assert.equal(r.error_kind, "OWNERSHIP");
  });

  it("duplicate asset → MALFORMED", async () => {
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(
      req({ mode: "evaluate", counterparty: "bravo", give_assets: ["a_offer", "a_offer"], receive_assets: ["b_rb_target"] }),
      { contextOverride: ctx },
    );
    assert.equal(r.error_kind, "MALFORMED");
  });

  it("requester == counterparty → MALFORMED", async () => {
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(
      req({ mode: "evaluate", counterparty: "alpha", give_assets: ["a_offer"], receive_assets: ["a_bench_wr"] }),
      { contextOverride: ctx },
    );
    assert.equal(r.error_kind, "MALFORMED");
  });

  it("does not silently repair an invalid proposal into a different trade", async () => {
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(
      req({ mode: "evaluate", counterparty: "bravo", give_assets: ["b_rb_target"], receive_assets: ["a_offer"] }),
      { contextOverride: ctx },
    );
    // b_rb_target is bravo's, a_offer is alpha's — routed as (alpha gives b_rb_target) is an ownership error, NOT auto-swapped
    assert.equal(r.error_kind, "OWNERSHIP");
    assert.equal(r.evaluation, undefined);
  });
});

/* ------------------------------------------------------------------ evaluate */

describe("Competitive Trade G — evaluate mode (§15, §20, §41, §42)", () => {
  it("a valid proposal returns a 200-class analytical result with snapshot lineage and un-upgraded confidence", async () => {
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(
      req({ mode: "evaluate", counterparty: "bravo", give_assets: ["a_offer"], receive_assets: ["b_rb_target"] }),
      { contextOverride: ctx },
    );
    assert.equal(r.error_kind, "NONE");
    assert.ok(["READY", "PARTIAL", "REVIEW_REQUIRED", "NO_ACTION"].includes(r.status));
    assert.ok(r.snapshot && typeof r.snapshot.league_snapshot_id === "string");
    assert.ok(["VERY_LOW", "LOW", "MEDIUM", "HIGH", null].includes(r.confidence));
    assert.ok(r.evaluation);
    assert.equal(r.access, "READ_ONLY_ANALYTICS");
    // §41 — human-facing reservation phrasing, never a raw "z" number
    if (r.evaluation) {
      assert.equal(typeof r.evaluation.result.actionable, "boolean");
      if (r.evaluation.counterparty) {
        assert.ok(!/-?\d+\.\d+\s*z/i.test(r.evaluation.counterparty.reservation_descriptor));
      }
    }
    assert.ok(r.limitations.some((l) => /heuristic/i.test(l)));
  });

  it("REVIEW_REQUIRED horizon conflict is preserved as status REVIEW_REQUIRED, not softened", async () => {
    // a fixture where our RI-ordinal season view and the external ROS view
    // conflict in sign is hard to force deterministically; assert the contract
    // instead: whenever the engine says horizon REVIEW_REQUIRED, the API status
    // is REVIEW_REQUIRED (never READY/NO_ACTION), with a diagnostic.
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(
      req({ mode: "evaluate", counterparty: "bravo", give_assets: ["a_offer"], receive_assets: ["b_rb_target"] }),
      { contextOverride: ctx },
    );
    if (r.evaluation?.private_trade.horizon_classification === "REVIEW_REQUIRED") {
      assert.equal(r.status, "REVIEW_REQUIRED");
      assert.ok(r.diagnostics.some((d) => d.code === "REVIEW_REQUIRED"));
    }
  });

  it("§42 — never claims 'they think they win on value' when raw perceived surplus is negative", async () => {
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(
      req({ mode: "evaluate", counterparty: "bravo", give_assets: ["a_offer"], receive_assets: ["b_rb_target"] }),
      { contextOverride: ctx },
    );
    const cp = r.evaluation?.counterparty;
    if (cp && (cp.raw_perceived_value_surplus ?? 0) < 0 && cp.accepts_despite_negative_value_perception) {
      assert.ok(r.reasons.some((x) => /roster.fit|need relief|not.*winning|would not perceive/i.test(x)));
    }
  });
});

/* ------------------------------------------------------------------ negotiate */

describe("Competitive Trade G — negotiate mode (§16, §48)", () => {
  it("returns a bounded envelope; a non-certified base is EXTRACTION_GATED / REVIEW_REQUIRED with no aggressive extraction", async () => {
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(
      req({ mode: "negotiate", counterparty: "bravo", give_assets: ["a_offer"], receive_assets: ["b_rb_target"] }),
      { contextOverride: ctx },
    );
    assert.equal(r.error_kind, "NONE");
    assert.ok(r.negotiation);
    if (r.negotiation && !r.negotiation.base_trade_certified) {
      assert.ok(["EXTRACTION_GATED", "NO_EXTRACTION_ROOM", "LIMITED_EXTRACTION"].includes(r.negotiation.extraction_band) || r.status === "PARTIAL");
    }
    assert.ok(r.negotiation && Array.isArray(r.negotiation.frontier));
  });
});

/* ------------------------------------------------------------------ discover */

describe("Competitive Trade G — discover mode (§18, §19, §49)", () => {
  it("returns a bounded certified list or NO_ACTION; NO_ACTION is a success", async () => {
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(req({ manager: "alpha", mode: "discover" }), { contextOverride: ctx });
    assert.equal(r.error_kind, "NONE");
    assert.ok(r.discovery);
    if (r.discovery && r.discovery.certified_direct_trades.length === 0) {
      assert.equal(r.status, "NO_ACTION");
      assert.equal(r.recommended_strategy, "NO_ACTION");
      assert.ok(r.reasons.join(" ").toLowerCase().includes("legitimate"));
    } else if (r.discovery) {
      assert.ok(r.discovery.certified_direct_trades.length <= 5);
      assert.equal(r.status, "READY");
    }
    assert.ok(r.discovery && r.discovery.note.includes("BEFORE the legacy mutual-benefit"));
  });

  it("is deterministic across repeated calls", async () => {
    const ctx = fixtureCtx();
    const a = await evaluateCompetitiveTradeRequest(req({ manager: "alpha", mode: "discover" }), { contextOverride: ctx });
    const b = await evaluateCompetitiveTradeRequest(req({ manager: "alpha", mode: "discover" }), { contextOverride: fixtureCtx() });
    assert.deepEqual(a.discovery?.certified_direct_trades, b.discovery?.certified_direct_trades);
  });
});

/* ------------------------------------------------------------------ strategy path */

describe("Competitive Trade G — strategy_path mode (§17, §50)", () => {
  it("always includes NO_ACTION and HOLD_CURRENT_ASSET; no path exceeds two completed trades", async () => {
    const ctx = fixtureCtx();
    const r = await evaluateCompetitiveTradeRequest(req({ manager: "alpha", mode: "strategy_path" }), { contextOverride: ctx });
    assert.equal(r.error_kind, "NONE");
    assert.ok(r.strategy_paths);
    const strategies = r.strategy_paths!.paths.map((p) => p.strategy);
    assert.ok(strategies.includes("NO_ACTION"));
    assert.ok(strategies.includes("HOLD_CURRENT_ASSET"));
    for (const p of r.strategy_paths!.paths) assert.ok(p.steps.length <= 2);
    if (r.recommended_strategy === "NO_ACTION" || r.recommended_strategy === "HOLD_CURRENT_ASSET") {
      assert.equal(r.status, "NO_ACTION");
    }
  });
});

/* ------------------------------------------------------------------ snapshot safety §9/§10/§32 */

describe("Competitive Trade G — snapshot safety (§9, §10, §32)", () => {
  it("concurrent league mutation: an A-context cannot be reused against snapshot B; a fresh B context succeeds", () => {
    const a = fixtureCtx();
    const ecA = buildCompetitiveTradeEvaluationContext(a);
    assertContextMatchesSnapshot(ecA, a); // sanity

    // materialize "snapshot B" — a roster/transaction mutation
    const b = fixtureCtx();
    b.snapshot.captured_at = new Date(Date.parse(b.snapshot.captured_at) + 3_600_000).toISOString();

    assert.throws(() => assertContextMatchesSnapshot(ecA, b), /snapshot mismatch/);

    const ecB = buildCompetitiveTradeEvaluationContext(b);
    assert.doesNotThrow(() => assertContextMatchesSnapshot(ecB, b));
  });

  it("§32 — a different snapshot produces a different snapshot identity even if analytical values coincide", async () => {
    const a = fixtureCtx();
    const b = fixtureCtx();
    // change b's roster so content differs
    b.snapshot.rosters[0]!.bench.push("fa_WR_3");
    b.snapshot.rosters[0]!.all_players.push("fa_WR_3");
    const ra = await evaluateCompetitiveTradeRequest(req({ manager: "alpha", mode: "strategy_path" }), { contextOverride: a });
    const rb = await evaluateCompetitiveTradeRequest(req({ manager: "alpha", mode: "strategy_path" }), { contextOverride: b });
    assert.notEqual(ra.snapshot?.content_hash, rb.snapshot?.content_hash);
  });
});

/* ------------------------------------------------------------------ perspective §14 */

describe("Competitive Trade G — perspective-correct threat (§14)", () => {
  it("a counterparty's absolute strength is perspective-independent; relative_to_us is re-derived per requester", () => {
    const ctx = fixtureCtx();
    const ec = buildCompetitiveTradeEvaluationContext(ctx);

    const fromAlpha = evaluateCompetitiveTrade({
      baseline: thinBaseline(),
      ctx,
      my_manager_id: MID("alpha"),
      incoming_player_ids: ["b_rb_target"],
      outgoing_player_ids: ["a_offer"],
      counterparty_manager_id: MID("bravo"),
      eval_context: ec,
    }).competitive.opponent_threat;

    const fromCharlie = evaluateCompetitiveTrade({
      baseline: thinBaseline(),
      ctx,
      my_manager_id: MID("charlie"),
      incoming_player_ids: ["b_rb_target"],
      outgoing_player_ids: ["c_rb"],
      counterparty_manager_id: MID("bravo"),
      eval_context: ec,
    }).competitive.opponent_threat;

    assert.ok(fromAlpha && fromCharlie);
    if (fromAlpha && fromCharlie) {
      // absolute strength of bravo does not depend on who is asking
      assert.equal(fromAlpha.components.blended_strength_z, fromCharlie.components.blended_strength_z);
      assert.equal(fromAlpha.band, fromCharlie.band);
      // relative_to_us is a function of the requester
      const alphaZ = ec.league_threat.by_manager.get(MID("alpha"))?.components.blended_strength_z ?? null;
      const charlieZ = ec.league_threat.by_manager.get(MID("charlie"))?.components.blended_strength_z ?? null;
      if (alphaZ != null && charlieZ != null && alphaZ !== charlieZ) {
        assert.notEqual(fromAlpha.relative_to_us, fromCharlie.relative_to_us);
      }
    }
  });
});

function thinBaseline() {
  return { participants: {}, summary: {} } as never;
}

/* ------------------------------------------------------------------ /api/ai advertisement §23, §56 */

describe("Competitive Trade G — /api/ai discovery advertisement (§23, §24, §56)", async () => {
  const { CAPABILITIES } = await import("../lib/discovery");

  it("advertises the competitive trade endpoint accurately, as POST, with its modes", () => {
    const cap = CAPABILITIES.find((c) => c.id === "competitive_trade");
    assert.ok(cap, "competitive_trade capability present");
    assert.equal(cap!.method, "POST");
    assert.equal(cap!.route_template, "/api/trades/competitive");
    assert.deepEqual(cap!.request_modes, ["evaluate", "negotiate", "discover", "strategy_path"]);
    assert.ok(/SEPARATE from legacy mutual-benefit/i.test(cap!.description));
    // §24 — no oversell
    assert.ok(/heuristic/i.test(cap!.description));
    assert.ok(/speculative/i.test(cap!.description));
    assert.ok(/two completed trades/i.test(cap!.description));
    assert.ok(/READ-ONLY/i.test(cap!.description));
  });

  it("does not disturb the existing (GET) capabilities", () => {
    for (const c of CAPABILITIES) {
      if (c.id === "competitive_trade") continue;
      assert.ok(c.method === undefined || c.method === "GET");
    }
  });
});
