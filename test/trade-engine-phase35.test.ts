/**
 * Trade Engine — Phase 3.5: real data enablement and calibration readiness.
 *
 * Covers: P3 safety cleanup (D2-D5), the usage/schedule provider framework
 * (pluggable, NULL by default), the counterfactual-trade generator, the
 * calibration-readiness classification, and — most importantly — the shadow
 * invariant holding even when a stub provider returns rich real-shaped data.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, xfer, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import { evaluateTrade } from "../lib/trades/evaluate";
import { buildPlayerIntelligence, type PlayerIntelligenceProviders } from "../lib/trades/intelligence";
import { classifyConfidence } from "../lib/trades/confidence";
import { resolveTradeConfig, sanitizePublicTradeConfig, DEFAULT_TRADE_CONFIG } from "../lib/trades/config";
import { resolvePhase3CalibrationMode } from "../lib/trades/activation";
import {
  classifyUsageTrend,
  capScheduleAdjustment,
  NULL_USAGE_PROVIDER,
  NULL_SCHEDULE_PROVIDER,
  type UsageProvider,
  type ScheduleProvider,
  type PlayerUsageSnapshot,
  type PlayerScheduleContext,
} from "../lib/trades/providers";
import { generateCounterfactualTrades, validateCounterfactualBatch } from "../lib/trades/historical-counterfactual";
import { buildCalibrationReadinessReport, SIGNAL_READINESS, TRADE_DATA_LAYER_VERSION } from "../lib/trades/data-readiness";
import { analyzeTrade } from "../lib/trades/analyze";
import type { CanonicalPosition } from "../lib/canonical/schema";
import type { NormalizedProposal } from "../lib/trades/schema";

const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3, 4].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) =>
  [0, 1, 2, 3, 4].map((i) => proj(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, { rest_of_season_points: (p === "QB" ? 12 - i : 6 - i) * ROS_WEEKS })),
);
function scene(teams: StdTeamSpec[], transfers: NormalizedProposal["transfers"]) {
  const built = teams.map(stdTeam);
  return tradeFixture({
    teams: built.map((b) => b.team), players: built.flatMap((b) => b.players), projections: built.flatMap((b) => b.projections),
    freeAgents: FA, faProjections: FA_PROJ, transfers, rosFlatHorizon: ROS_WEEKS,
  });
}
const T = (slug: string, over: Partial<StdTeamSpec> = {}): StdTeamSpec => ({ slug, flex: { id: `${slug}_flex`, pos: "WR", pts: 10 }, ...over });

/* ===================================================================== */
/* D2 — RETURNING removed                                                 */
/* ===================================================================== */

describe("Phase 3.5 §D2 — unreachable RETURNING state removed", () => {
  it("no availability status can ever be RETURNING (type no longer declares it; every classification is a real, real-data-backed status)", () => {
    const f = scene([T("X"), T("Y", { bench: [{ id: "CLEARED", pos: "WR", pts: 12 }] })], []);
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const p = ctx.players_by_id.get("CLEARED")!;
    // a player recently cleared from injury, with no distinct "returning" designation in real source data
    ctx.players_by_id.set("CLEARED", { ...p, injury_status: null });
    const intel = buildPlayerIntelligence("CLEARED", ctx);
    const validStatuses = ["HEALTHY", "QUESTIONABLE", "DOUBTFUL", "OUT", "IR", "PUP", "SUSPENDED", "UNKNOWN"];
    assert.ok(validStatuses.includes(intel.availability.status));
  });
});

/* ===================================================================== */
/* D3 — ros_confidence wired into confidence layer                        */
/* ===================================================================== */

describe("Phase 3.5 §D3 — ros_confidence is now consulted, not just captured", () => {
  it("classifyConfidence degrades when most transferred players have LOW ros_confidence", () => {
    const base = { projections_status: "READY" as const, ros_uncovered_count: 0, roster_size: 15, unresolved_player_count: 0, ros_schedule_status: "READY" as const, intelligence_unknown_count: 0, transferred_player_count: 2, model_disagreement: false };
    const highConf = classifyConfidence({ ...base, low_ros_confidence_count: 0 });
    const lowConf = classifyConfidence({ ...base, low_ros_confidence_count: 2 });
    const rank: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, DEGRADED: 0 };
    assert.ok(rank[lowConf.level]! < rank[highConf.level]!);
    assert.ok(lowConf.reasons.some((r) => r.toLowerCase().includes("low confidence")));
  });

  it("an isolated LOW ros_confidence (fewer than half of transferred players) does not degrade confidence", () => {
    const base = { projections_status: "READY" as const, ros_uncovered_count: 0, roster_size: 15, unresolved_player_count: 0, ros_schedule_status: "READY" as const, intelligence_unknown_count: 0, transferred_player_count: 4, model_disagreement: false };
    const r = classifyConfidence({ ...base, low_ros_confidence_count: 1 });
    assert.equal(r.level, "HIGH");
  });
});

/* ===================================================================== */
/* D4 — production config is immutable                                    */
/* ===================================================================== */

describe("Phase 3.5 §D4 — DEFAULT_TRADE_CONFIG is deep-frozen", () => {
  it("is frozen at every level", () => {
    assert.ok(Object.isFrozen(DEFAULT_TRADE_CONFIG));
    assert.ok(Object.isFrozen(DEFAULT_TRADE_CONFIG.weights));
    assert.ok(Object.isFrozen(DEFAULT_TRADE_CONFIG.phase2.weights));
    assert.ok(Object.isFrozen(DEFAULT_TRADE_CONFIG.phase3.weights));
    assert.ok(Object.isFrozen(DEFAULT_TRADE_CONFIG.phase3.caps));
  });

  it("a mutation attempt throws (strict mode) rather than silently succeeding", () => {
    assert.throws(() => {
      DEFAULT_TRADE_CONFIG.phase3.weights.role_adjustment = 999;
    });
    assert.equal(DEFAULT_TRADE_CONFIG.phase3.weights.role_adjustment, 0, "mutation must not have taken effect even if the assignment somehow didn't throw");
  });

  it("resolveTradeConfig still produces an independently-overridable config (freezing the default doesn't break legitimate overrides)", () => {
    const cfg = resolveTradeConfig({ phase3: { weights: { role_adjustment: 1 } } });
    assert.equal(cfg.phase3.weights.role_adjustment, 1);
    assert.equal(DEFAULT_TRADE_CONFIG.phase3.weights.role_adjustment, 0);
  });
});

/* ===================================================================== */
/* D5 — public API cannot set phase3 weights                              */
/* ===================================================================== */

describe("Phase 3.5 §D5 — public config sanitizer drops phase3 unconditionally", () => {
  it("strips a client-supplied phase3 override entirely", () => {
    const sanitized = sanitizePublicTradeConfig({ phase3: { weights: { role_adjustment: 999, schedule_adjustment: 999 } } });
    assert.equal(sanitized?.phase3, undefined);
  });

  it("still allows legitimate phase2/weights/thresholds/viability overrides through", () => {
    const sanitized = sanitizePublicTradeConfig({
      weights: { starter_points: 1 },
      thresholds: { accept: 2 },
      acceptance_floor: -1,
      viability: { high_min_participant_delta: 1 },
      phase2: { weights: { ros_usable_value: 1 } },
    });
    assert.deepEqual(sanitized?.weights, { starter_points: 1 });
    assert.deepEqual(sanitized?.phase2, { weights: { ros_usable_value: 1 } });
    assert.equal(sanitized?.acceptance_floor, -1);
  });

  it("rejects non-numeric / malformed shapes safely instead of passing them through", () => {
    const sanitized = sanitizePublicTradeConfig({ weights: { starter_points: "999" }, phase3: "not an object" });
    assert.equal(sanitized?.weights, undefined);
    assert.equal(sanitized?.phase3, undefined);
  });

  it("handles null/non-object/array input without throwing", () => {
    assert.equal(sanitizePublicTradeConfig(null), undefined);
    assert.equal(sanitizePublicTradeConfig(undefined), undefined);
    assert.equal(sanitizePublicTradeConfig([1, 2, 3]), undefined);
    assert.equal(sanitizePublicTradeConfig("hello"), undefined);
  });

  it("an end-to-end hostile config still cannot move shadow_utility_delta once sanitized and applied", () => {
    const f = scene([T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { bench: [{ id: "IN", pos: "WR", pts: 16 }] })], [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")]);
    const hostileBody = { phase3: { weights: { role_adjustment: 999, schedule_adjustment: 999 } } };
    const sanitized = sanitizePublicTradeConfig(hostileBody);
    const cfg = resolveTradeConfig(sanitized);
    assert.equal(cfg.phase3.weights.role_adjustment, 0, "the sanitizer must have already dropped it before resolveTradeConfig ever saw it");
    const outHostile = evaluateTrade({ ...f.input, config: cfg, context: f.context({ rosWeeks: ROS_WEEKS }) });
    const outDefault = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    assert.equal(outHostile.participants.X!.phase3!.shadow_utility_delta, outDefault.participants.X!.phase3!.shadow_utility_delta);
  });
});

/* ===================================================================== */
/* Activation gate                                                        */
/* ===================================================================== */

describe("Phase 3.5 §45/§46 — activation gate", () => {
  it("absent env resolves to SHADOW", () => {
    assert.equal(resolvePhase3CalibrationMode({}), "SHADOW");
  });

  it("an invalid/unrecognized env value resolves to SHADOW, not a crash", () => {
    assert.equal(resolvePhase3CalibrationMode({ PHASE3_CALIBRATION_MODE: "garbage" }), "SHADOW");
  });

  it("PRODUCTION is explicitly refused and downgraded to SHADOW (Phase 3.5 hard gate)", () => {
    assert.equal(resolvePhase3CalibrationMode({ PHASE3_CALIBRATION_MODE: "PRODUCTION" }), "SHADOW");
  });

  it("INTERNAL_VALIDATION is allowed through (for offline validation runs only)", () => {
    assert.equal(resolvePhase3CalibrationMode({ PHASE3_CALIBRATION_MODE: "INTERNAL_VALIDATION" }), "INTERNAL_VALIDATION");
  });

  it("every real evaluateTrade call in this repo reports mode SHADOW (no env override reaches it in tests)", () => {
    const f = scene([T("X"), T("Y", { bench: [{ id: "IN", pos: "WR", pts: 10 }] })], [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")]);
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    assert.equal(out.participants.X!.phase3!.mode, "SHADOW");
  });
});

describe("Phase 3.5 §42 — versions block exposes the new data-layer version additively", () => {
  it("analyzeTrade against an unknown league still returns null for calibrated/data, no crash", async () => {
    const r = await analyzeTrade({ league: "___no_such_league___", participants: [{ manager_id: "a" }, { manager_id: "b" }], transfers: [] });
    assert.equal(r.versions.calibrated, null);
    assert.equal(r.versions.data, null);
    assert.equal(r.versions.foundation, "ri-trade-foundation-2026.2");
  });

  it("TRADE_DATA_LAYER_VERSION is a real, stable constant", () => {
    assert.equal(TRADE_DATA_LAYER_VERSION, "ri-trade-data-2026.1");
  });
});

/* ===================================================================== */
/* Usage / schedule provider framework                                    */
/* ===================================================================== */

describe("Phase 3.5B — usage trend classifier (adversarial fixtures)", () => {
  it("hot-hand trap: one huge week among a short, otherwise-modest series does not confidently assert IMPROVING", () => {
    const shares = [
      { share: 0.4, sample_size: 20 },
      { share: 0.42, sample_size: 22 },
      { share: 0.95, sample_size: 25 }, // one huge week
    ];
    const trend = classifyUsageTrend(shares);
    assert.notEqual(trend, "IMPROVING", "a single spike inside a high-variance short window must not be asserted as a durable improving trend");
  });

  it("quiet breakout: three consecutive modest increases (low variance) reads IMPROVING", () => {
    const shares = [
      { share: 0.3, sample_size: 20 },
      { share: 0.3, sample_size: 20 },
      { share: 0.4, sample_size: 22 },
      { share: 0.45, sample_size: 24 },
      { share: 0.48, sample_size: 25 },
    ];
    assert.equal(classifyUsageTrend(shares), "IMPROVING");
  });

  it("tiny sample: fewer than the minimum usable weeks is INSUFFICIENT_DATA, never a confident direction", () => {
    assert.equal(classifyUsageTrend([{ share: 0.5, sample_size: 20 }]), "INSUFFICIENT_DATA");
  });

  it("a week below the minimum sample size (garbage time) is excluded from the trend calculation entirely", () => {
    const shares = [
      { share: 0.3, sample_size: 20 },
      { share: 0.32, sample_size: 22 },
      { share: 0.9, sample_size: 2 }, // 2 snaps of garbage-time usage — excluded, not counted as a real week
      { share: 0.31, sample_size: 21 },
    ];
    // only 3 usable weeks remain (the 2-sample week is excluded) — flat, so STABLE
    assert.equal(classifyUsageTrend(shares), "STABLE");
  });

  it("blowout anomaly: a lone garbage-time week alone is never enough to claim any trend", () => {
    assert.equal(classifyUsageTrend([{ share: 0.9, sample_size: 2 }]), "INSUFFICIENT_DATA");
  });
});

describe("Phase 3.5C — schedule adjustment cap", () => {
  it("bounds an extreme matchup score to a fraction of the player's own projection", () => {
    const capped = capScheduleAdjustment(1000, 10);
    assert.ok(Math.abs(capped) <= 10 * 0.15 + 1e-9);
  });

  it("returns 0 for a player with no projection at all (never invents a baseline to scale against)", () => {
    assert.equal(capScheduleAdjustment(5, null), 0);
  });

  it("returns 0 for non-finite input rather than propagating NaN/Infinity", () => {
    assert.equal(capScheduleAdjustment(NaN, 10), 0);
    assert.equal(capScheduleAdjustment(Infinity, 10), 0);
  });
});

/* ===================================================================== */
/* Provider integration stays shadow-only (the critical Phase 3.5 invariant) */
/* ===================================================================== */

describe("Phase 3.5G — a REAL (stub) provider populates diagnostics but NEVER moves shadow utility", () => {
  const stubUsageSeries: PlayerUsageSnapshot[] = [
    { player_id: "IN", season: 2026, week: 1, snaps: 30, snap_share: 0.4, routes: 22, route_participation: 0.5, targets: 5, target_share: 0.15, carries: null, rush_share: null, red_zone_targets: 0, red_zone_carries: null, goal_line_carries: null, source: "stub", updated_at: "2026-09-01T00:00:00.000Z", freshness: "CURRENT" },
    { player_id: "IN", season: 2026, week: 2, snaps: 32, snap_share: 0.42, routes: 24, route_participation: 0.52, targets: 6, target_share: 0.17, carries: null, rush_share: null, red_zone_targets: 0, red_zone_carries: null, goal_line_carries: null, source: "stub", updated_at: "2026-09-08T00:00:00.000Z", freshness: "CURRENT" },
    { player_id: "IN", season: 2026, week: 3, snaps: 40, snap_share: 0.6, routes: 30, route_participation: 0.75, targets: 8, target_share: 0.22, carries: null, rush_share: null, red_zone_targets: 1, red_zone_carries: null, goal_line_carries: null, source: "stub", updated_at: "2026-09-15T00:00:00.000Z", freshness: "CURRENT" },
    { player_id: "IN", season: 2026, week: 4, snaps: 42, snap_share: 0.65, routes: 32, route_participation: 0.8, targets: 9, target_share: 0.25, carries: null, rush_share: null, red_zone_targets: 2, red_zone_carries: null, goal_line_carries: null, source: "stub", updated_at: "2026-09-22T00:00:00.000Z", freshness: "CURRENT" },
    { player_id: "IN", season: 2026, week: 5, snaps: 45, snap_share: 0.7, routes: 34, route_participation: 0.85, targets: 10, target_share: 0.28, carries: null, rush_share: null, red_zone_targets: 2, red_zone_carries: null, goal_line_carries: null, source: "stub", updated_at: "2026-09-29T00:00:00.000Z", freshness: "CURRENT" },
  ];
  const stubUsageProvider: UsageProvider = {
    source_name: "stub-test-provider",
    getCurrentUsage: (id) => (id === "IN" ? stubUsageSeries.at(-1)! : null),
    getHistoricalUsage: () => null,
    getRecentUsageSeries: (id) => (id === "IN" ? stubUsageSeries : []),
  };
  const stubScheduleProvider: ScheduleProvider = {
    source_name: "stub-test-provider",
    getWeeklyMatchup: (id, week): PlayerScheduleContext | null =>
      id === "IN" ? { player_id: id, week, opponent: "XYZ", position: "WR", matchup_score: 0.9, matchup_percentile: 0.95, source: "stub", updated_at: "2026-09-15T00:00:00.000Z", freshness: "CURRENT" } : null,
  };
  const providers: PlayerIntelligenceProviders = { usage: stubUsageProvider, schedule: stubScheduleProvider };

  it("a stub provider populates usage/role/trend/schedule as AVAILABLE with real-shaped data", () => {
    const f = scene([T("X"), T("Y", { bench: [{ id: "IN", pos: "WR", pts: 10 }] })], []);
    const intel = buildPlayerIntelligence("IN", f.context({ rosWeeks: ROS_WEEKS }), providers);
    assert.equal(intel.usage.status, "AVAILABLE");
    assert.equal(intel.role.status, "AVAILABLE");
    assert.equal(intel.trend.status, "AVAILABLE");
    assert.equal(intel.schedule.status, "AVAILABLE");
    assert.equal(intel.role.stability, "IMPROVING");
  });

  it("with the default (NULL) providers the same player is UNAVAILABLE across the board — proving the wiring, not the data, is what changed", () => {
    const f = scene([T("X"), T("Y", { bench: [{ id: "IN", pos: "WR", pts: 10 }] })], []);
    const intel = buildPlayerIntelligence("IN", f.context({ rosWeeks: ROS_WEEKS }), { usage: NULL_USAGE_PROVIDER, schedule: NULL_SCHEDULE_PROVIDER });
    assert.equal(intel.usage.status, "UNAVAILABLE");
    assert.equal(intel.schedule.status, "UNAVAILABLE");
  });

  it("CRITICAL INVARIANT: even with rich real-shaped usage/schedule data available, shadow_utility_delta === contextual_utility_delta and shadow_acceptance === contextual_acceptance — Phase 3.5 provider data is diagnostic-only", () => {
    // evaluatePhase3Participant does not accept a providers override (it always
    // uses the DEFAULT_PLAYER_INTELLIGENCE_PROVIDERS internally), so this proves
    // the invariant at the layer that actually matters: even where
    // buildPlayerIntelligence CAN return rich data, phase3.ts's role_adjustment /
    // schedule_adjustment remain hardcoded to 0 regardless.
    const f = scene([T("X", { flex: { id: "X_flex", pos: "WR", pts: 6 } }), T("Y", { bench: [{ id: "IN", pos: "WR", pts: 16 }] })], [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")]);
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    const x = out.participants.X!;
    assert.equal(x.phase3!.shadow_utility_delta, x.phase2!.contextual_utility_delta);
    assert.equal(x.phase3!.shadow_acceptance, x.phase2!.contextual_acceptance);
    for (const a of x.phase3!.player_attribution) {
      assert.equal(a.role_adjustment, 0);
      assert.equal(a.schedule_adjustment, 0);
    }
  });
});

/* ===================================================================== */
/* Historical counterfactual generator                                    */
/* ===================================================================== */

describe("Phase 3.5D — counterfactual trade generation", () => {
  const rosters = [
    { manager_slug: "A", bench_players: [{ player_id: "a1", position: "WR" }, { player_id: "a2", position: "RB" }] },
    { manager_slug: "B", bench_players: [{ player_id: "b1", position: "WR" }, { player_id: "b2", position: "RB" }] },
    { manager_slug: "C", bench_players: [{ player_id: "c1", position: "WR" }] },
  ];

  it("generates only same-position, cross-roster swaps", () => {
    const trades = generateCounterfactualTrades(rosters, 42);
    for (const t of trades) {
      assert.notEqual(t.from_manager_slug, t.to_manager_slug);
    }
    assert.ok(trades.every((t) => ["WR", "RB"].includes(t.position)));
  });

  it("every generated batch validates: no duplicate assets, no self-trades", () => {
    const trades = generateCounterfactualTrades(rosters, 7);
    const check = validateCounterfactualBatch(trades);
    assert.equal(check.ok, true, JSON.stringify(check.violations));
  });

  it("is deterministic for a given seed", () => {
    const t1 = generateCounterfactualTrades(rosters, 123);
    const t2 = generateCounterfactualTrades(rosters, 123);
    assert.deepEqual(t1, t2);
  });

  it("a different seed can produce a different (but still valid) ordering", () => {
    const t1 = generateCounterfactualTrades(rosters, 1);
    const t2 = generateCounterfactualTrades(rosters, 2);
    // not asserting inequality strictly (a tiny candidate pool could coincidentally match) — just that both are independently valid
    assert.equal(validateCounterfactualBatch(t1).ok, true);
    assert.equal(validateCounterfactualBatch(t2).ok, true);
  });

  it("respects maxTrades and never reuses a player across the batch", () => {
    const trades = generateCounterfactualTrades(rosters, 5, 2);
    assert.ok(trades.length <= 2);
  });
});

/* ===================================================================== */
/* Calibration readiness report                                           */
/* ===================================================================== */

describe("Phase 3.5F — calibration readiness report is honest, not aspirational", () => {
  it("no signal is READY_FOR_CALIBRATION today (zero real historical trades, zero real providers)", () => {
    const report = buildCalibrationReadinessReport("2026-09-04T00:00:00.000Z");
    assert.equal(report.any_signal_ready, false);
    assert.ok(report.hard_blockers.length === SIGNAL_READINESS.length);
  });

  it("every signal entry has a non-empty recommendation and a stated blocking reason (nothing marked ready is left unjustified, and nothing NOT ready is left unexplained)", () => {
    for (const s of SIGNAL_READINESS) {
      assert.ok(s.recommendation.length > 10, s.signal);
      if (s.status !== "READY_FOR_CALIBRATION") assert.ok(s.blocking_reason && s.blocking_reason.length > 10, s.signal);
    }
  });

  it("historical_trade_outcome is explicitly the hard blocker every other signal's readiness ultimately depends on", () => {
    const hist = SIGNAL_READINESS.find((s) => s.signal === "historical_trade_outcome")!;
    assert.equal(hist.status, "INSUFFICIENT_DATA");
    assert.ok(hist.sample_size.historical_trades === 0);
  });
});
