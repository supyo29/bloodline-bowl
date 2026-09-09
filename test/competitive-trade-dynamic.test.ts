/**
 * Competitive Trade Intelligence — Checkpoint B.5: dynamic in-season market
 * value, season maturity, recency, opponent adjustment, anomaly safeguards.
 *
 * Deterministic. Drives the composed pipeline
 *   buildTemporalContext → buildCurrentSeasonEvidence
 *     → buildMarketState + buildPrivateForwardValue → applyDynamicMarketToEdge
 * with synthetic inputs (no live ranks, no network). Covers spec §45–§55 and
 * the §68 freeze gates.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  seasonMaturityWeight,
  recencyWeight,
  recencyWeightedMean,
  buildTemporalContext,
} from "../lib/trades/competitive/temporal";
import { buildCurrentSeasonEvidence, type GameObservation } from "../lib/trades/competitive/evidence";
import { buildMarketState } from "../lib/trades/competitive/market-state";
import { buildPrivateForwardValue } from "../lib/trades/competitive/private-forward";
import { applyDynamicMarketToEdge } from "../lib/trades/competitive/dynamic-edge";
import {
  DEFAULT_COMPETITIVE_MARKET_CALIBRATION,
  loadCompetitiveMarketCalibration,
  resolveCurves,
} from "../lib/trades/competitive/calibration";
import { resolveCompetitiveTradeConfig } from "../lib/trades/competitive/config";
import type { MarketEdge, NormalizedValue } from "../lib/trades/competitive/schema";

const CAL = DEFAULT_COMPETITIVE_MARKET_CALIBRATION;
const CFG = resolveCompetitiveTradeConfig();

function nv(z: number | null, conf: "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW" = "MEDIUM", rank: number | null = null): NormalizedValue {
  return { basis: "ri_ros_weekly_vor", raw: z, normalized_value: z, percentile: null, position_rank: rank, confidence: conf, as_of: "2026-10-20", model_version: "test" };
}

function baseEdge(overrides: Partial<MarketEdge> = {}): MarketEdge {
  return {
    canonical_player_id: "p1",
    name: "Test Player",
    position: "RB",
    nfl_team: "KC",
    private_value: nv(0.5, "MEDIUM", 20),
    market_value: nv(0.5, "MEDIUM", 20),
    direction: "FAIR",
    edge_score: 0,
    actionable_edge: 0,
    confidence: "MEDIUM",
    reason_codes: [],
    reasons: [],
    lineage: { sources: [], primary_source_type: "provider_benchmark", usable_source_count: 1, dispersion: 0, worst_readiness: "CURRENT", scoring_normalization: "test" },
    analytical_only: true,
    ...overrides,
  };
}

const RECENCY = {
  ROLE: resolveCurves(CAL, "RB", "ROLE").recency,
  EFFICIENCY: resolveCurves(CAL, "RB", "EFFICIENCY").recency,
  RESULT: resolveCurves(CAL, "RB", "RESULT").recency,
  CONTEXT: resolveCurves(CAL, "RB", "CONTEXT").recency,
};

interface DynSpec {
  position?: string;
  as_of_week: number;
  games: GameObservation[];
  private_prior_z: number;
  preseason_market_z: number;
  current_public_z: number;
  current_public_readiness?: "CURRENT" | "PARTIAL" | "STALE" | "UNAVAILABLE";
  private_horizon?: "ROS_WEEKLY_RATE" | "FULL_SEASON" | "UNKNOWN";
  market_horizon?: "ROS_WEEKLY_RATE" | "FULL_SEASON" | "UNKNOWN";
  private_prior_conf?: "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";
}

function runDynamic(spec: DynSpec): MarketEdge {
  const position = spec.position ?? "RB";
  const meaningful = spec.games.filter((g) => g.meaningful).length;
  const temporal = buildTemporalContext({
    as_of_week: spec.as_of_week,
    season: 2026,
    meaningful_games_observed: spec.games.length > 0 ? meaningful : spec.as_of_week <= 1 ? 0 : null,
    games_source: spec.games.length > 0 ? "ROLE_OBSERVED_GAMES" : "GAMES_PLAYED",
    position,
    metric_family: "ROLE",
    calibration: CAL,
  });
  const recency = {
    ROLE: resolveCurves(CAL, position, "ROLE").recency,
    EFFICIENCY: resolveCurves(CAL, position, "EFFICIENCY").recency,
    RESULT: resolveCurves(CAL, position, "RESULT").recency,
    CONTEXT: resolveCurves(CAL, position, "CONTEXT").recency,
  };
  const evidence = buildCurrentSeasonEvidence({ observations: spec.games, position, as_of_week: spec.as_of_week, recency });
  const prior = nv(spec.private_prior_z, spec.private_prior_conf ?? "MEDIUM", 15);
  const pf = buildPrivateForwardValue({
    canonical_player_id: "p1",
    prior,
    evidence,
    temporal,
    calibration: CAL,
    remaining_games_expected: 18 - spec.as_of_week,
  });
  const ms = buildMarketState({
    canonical_player_id: "p1",
    season: 2026,
    as_of_week: spec.as_of_week,
    preseason_prior_z: spec.preseason_market_z,
    preseason_prior_rank: null,
    preseason_sources: ["adp_consensus"],
    current_public_z: spec.current_public_z,
    current_public_rank: null,
    current_public_readiness: spec.current_public_readiness ?? "CURRENT",
    current_public_source: "sleeper",
    season_points_rank: null,
    recent_rank: null,
    evidence,
    temporal,
    calibration: CAL,
    lineage: baseEdge().lineage,
  });
  return applyDynamicMarketToEdge({
    base_edge: baseEdge({ position, private_value: prior, market_value: nv(spec.current_public_z, "MEDIUM"), edge_score: (spec.private_prior_z - spec.current_public_z) }),
    private_forward: pf,
    market_state: ms,
    temporal,
    config: CFG,
    calibration: CAL,
    private_horizon: spec.private_horizon ?? "ROS_WEEKLY_RATE",
    market_horizon: spec.market_horizon ?? "ROS_WEEKLY_RATE",
    private_as_of_week: spec.as_of_week,
    market_as_of_week: spec.as_of_week,
    evidence_flags: { weak_schedule_inflation: evidence.weak_schedule_inflation, touchdown_mirage_risk: evidence.touchdown_mirage_risk },
  });
}

function roleGame(week: number, opts: Partial<GameObservation> = {}): GameObservation {
  return { week, meaningful: true, snap_share: 0.8, rush_share: 0.75, fantasy_points: 14, baseline_expected_points: 13, opponent_matchup_score: 0, ...opts };
}

describe("Competitive Trade B.5 — season maturity + recency (pure)", () => {
  const curve = CAL.by_position_metric["*"]!["ROLE"]!.season_maturity;

  it("§45 — season maturity weight is monotonic non-decreasing, nonlinear, capped below 1", () => {
    const ws = [0, 1, 2, 4, 8, 12, 20].map((g) => seasonMaturityWeight(g, curve));
    for (let i = 1; i < ws.length; i += 1) assert.ok(ws[i]! >= ws[i - 1]!, `w(${i}) monotonic`);
    assert.ok(ws[0]! < 0.05, "≈0 at g=0");
    assert.ok(ws.at(-1)! <= (curve.max_weight ?? 1) + 1e-9, "respects max_weight cap");
    assert.ok(ws.at(-1)! < 1, "never fully erases the prior");
    // nonlinear: first-game jump exceeds an 8→9 game jump
    const early = seasonMaturityWeight(1, curve) - seasonMaturityWeight(0, curve);
    const late = seasonMaturityWeight(9, curve) - seasonMaturityWeight(8, curve);
    assert.ok(early > late * 2, "diminishing returns");
  });

  it("§46 — recency weight decays monotonically with age", () => {
    const rc = CAL.by_position_metric["*"]!["RESULT"]!.recency;
    const ws = [0, 1, 2, 4, 8].map((a) => recencyWeight(a, rc));
    for (let i = 1; i < ws.length; i += 1) assert.ok(ws[i]! < ws[i - 1]!);
    assert.equal(ws[0], 1);
  });

  it("§47 — maturity and recency are independent mechanisms", () => {
    // At week 8 (high total authority) a week-1 obs still gets less recency weight than week-7.
    const series = [1, 2, 3, 4, 5, 6, 7].map((w) => ({ w, v: w }));
    const rc = CAL.by_position_metric["*"]!["RESULT"]!.recency;
    const wtdMean = recencyWeightedMean(series, (g) => g.v, rc)!;
    const plainMean = series.reduce((s, g) => s + g.v, 0) / series.length;
    assert.ok(wtdMean > plainMean, "recent games (higher v) pulled the mean up");
    // season maturity at 7 games is high regardless
    assert.ok(seasonMaturityWeight(7, curve) > 0.7);
  });
});

describe("Competitive Trade B.5 — evidence & dynamic edge", () => {
  it("§48 — beating a matchup-adjusted expectation vs tough defenses raises breakout credibility", () => {
    const vsTough = buildCurrentSeasonEvidence({
      observations: [1, 2, 3, 4].map((w) => roleGame(w, { fantasy_points: 22, baseline_expected_points: 15, opponent_matchup_score: -0.6, rush_share: 0.8 })),
      position: "RB", as_of_week: 5, recency: RECENCY,
    });
    const vsWeak = buildCurrentSeasonEvidence({
      observations: [1, 2, 3, 4].map((w) => roleGame(w, { fantasy_points: 22, baseline_expected_points: 15, opponent_matchup_score: 0.6, rush_share: 0.8 })),
      position: "RB", as_of_week: 5, recency: RECENCY,
    });
    assert.ok(vsTough.opponent_adjusted.outperformed_tough_count >= 3);
    const order = ["NO_BREAKOUT_SIGNAL", "EARLY_SIGNAL", "EMERGING", "SUPPORTED", "HIGH_CONFIDENCE"];
    assert.ok(order.indexOf(vsTough.breakout_credibility) >= order.indexOf(vsWeak.breakout_credibility));
    assert.ok(vsWeak.weak_schedule_inflation);
    assert.ok(!vsTough.weak_schedule_inflation);
  });

  it("§49 — identical output vs weak schedule is flagged for inflation; private favors the tough-schedule player", () => {
    const tough = runDynamic({
      as_of_week: 6, private_prior_z: 0.5, preseason_market_z: 0.5, current_public_z: 0.5,
      games: [1, 2, 3, 4, 5].map((w) => roleGame(w, { fantasy_points: 18, baseline_expected_points: 12, opponent_matchup_score: -0.5, rush_share: 0.82 })),
    });
    const weak = runDynamic({
      as_of_week: 6, private_prior_z: 0.5, preseason_market_z: 0.5, current_public_z: 0.5,
      games: [1, 2, 3, 4, 5].map((w) => roleGame(w, { fantasy_points: 18, baseline_expected_points: 12, opponent_matchup_score: 0.5, rush_share: 0.82 })),
    });
    assert.ok(weak.reason_codes.includes("WEAK_SCHEDULE_INFLATION"));
    assert.ok((tough.edge_vs_current_market ?? 0) >= (weak.edge_vs_current_market ?? 0));
  });

  it("§50 — touchdown mirage: market proxy rises more than private forward value", () => {
    const mirage = runDynamic({
      as_of_week: 6, private_prior_z: 0, preseason_market_z: 0, current_public_z: 0,
      games: [1, 2, 3, 4].map((w) => roleGame(w, { fantasy_points: 24, baseline_expected_points: 10, rush_share: 0.3, snap_share: 0.38 })),
    });
    assert.ok(mirage.reason_codes.includes("TOUCHDOWN_MIRAGE_RISK") || mirage.reasons.join(" ").toLowerCase().includes("touchdown"));
    // private forward value should be well below where the raw scoring would put it → SELL-ish or FAIR edge vs current market
    assert.ok((mirage.edge_vs_current_market ?? 0) <= 0.4, `expected muted/negative private-vs-market edge, got ${mirage.edge_vs_current_market}`);
  });

  it("§51 — usage breakout with modest scoring moves private forward value up (BUY)", () => {
    const breakout = runDynamic({
      as_of_week: 7, private_prior_z: -0.5, preseason_market_z: -0.5, current_public_z: -0.5,
      games: [1, 2, 3, 4, 5, 6].map((w) => roleGame(w, { fantasy_points: 11, baseline_expected_points: 9, rush_share: 0.82, snap_share: 0.79, goal_line_share: 0.7, opponent_matchup_score: -0.4 })),
    });
    assert.ok((breakout.edge_vs_current_market ?? 0) > 0.2, `expected positive private edge, got ${breakout.edge_vs_current_market}`);
    assert.ok(["BUY", "STRONG_BUY"].includes(breakout.direction));
    assert.ok(breakout.reason_codes.includes("USAGE_BREAKOUT_SUPPORTS_PRIVATE"));
  });

  it("§52 — market catches up: a large preseason edge shrinks; correction detected", () => {
    const e = runDynamic({
      as_of_week: 6,
      private_prior_z: 1.4, preseason_market_z: -0.6, // preseason: we were way higher
      current_public_z: 1.2, // market has moved to us
      games: [1, 2, 3, 4, 5].map((w) => roleGame(w, { fantasy_points: 17, rush_share: 0.7 })),
    });
    assert.ok(Math.abs(e.edge_vs_current_market ?? 99) < Math.abs(e.edge_vs_preseason_market ?? 0), "current edge < preseason edge");
    assert.ok(["MARKET_CORRECTED", "MARKET_PARTIALLY_CORRECTED"].includes(e.market_correction ?? ""));
  });

  it("§53 — market overshoot flips BUY → SELL", () => {
    const e = runDynamic({
      as_of_week: 7,
      private_prior_z: 0.0, preseason_market_z: -0.9, // preseason BUY edge (+0.9)
      current_public_z: 2.1, // market now well ABOVE our forward value (TD-fueled)
      games: [1, 2, 3, 4, 5, 6].map((w) => roleGame(w, { fantasy_points: 28, baseline_expected_points: 11, rush_share: 0.34, snap_share: 0.42 })),
    });
    assert.ok((e.edge_vs_preseason_market ?? 0) > 0, "preseason edge was BUY");
    assert.ok((e.edge_vs_current_market ?? 0) < 0, "current edge is SELL");
    assert.equal(e.market_correction, "MARKET_OVERSHOT");
    assert.ok(["SELL", "STRONG_SELL"].includes(e.direction));
  });

  it("§54 — private/market temporal horizon mismatch fails closed (no fake comparison)", () => {
    const e = runDynamic({
      as_of_week: 6, private_prior_z: 1.5, preseason_market_z: 0, current_public_z: 0,
      games: [roleGame(1), roleGame(2)],
      private_horizon: "FULL_SEASON",
      market_horizon: "ROS_WEEKLY_RATE",
    });
    assert.equal(e.direction, "INSUFFICIENT_DATA");
    assert.equal(e.edge_score, null);
    assert.equal(e.edge_vs_current_market, null);
    assert.ok(e.reason_codes.includes("PRIVATE_MARKET_HORIZON_MISMATCH"));
    assert.equal(e.quality_status, "REVIEW_REQUIRED");
  });

  it("§55 — extreme edge unsupported by confidence ⇒ REVIEW_REQUIRED, not STRONG_BUY", () => {
    const e = runDynamic({
      as_of_week: 2, // barely any evidence
      private_prior_z: 2.6, preseason_market_z: 0, current_public_z: 0,
      private_prior_conf: "VERY_LOW",
      games: [roleGame(1, { snap_share: 0.05, rush_share: 0.04 })], // 2 snaps ≈ nothing
    });
    assert.equal(e.quality_status, "REVIEW_REQUIRED");
    assert.notEqual(e.direction, "STRONG_BUY");
    assert.ok(e.reason_codes.includes("PRIVATE_MARKET_DIVERGENCE_EXTREME"));
    assert.ok(e.reason_codes.includes("REVIEW_REQUIRED_UNSUPPORTED_CONVICTION"));
  });
});

describe("Competitive Trade B.5 — §68 freeze gates", () => {
  it("preseason ADP is a DECAYING prior — current-season authority grows with games", () => {
    const curve = CAL.by_position_metric["RB"]!["ROLE"]!.season_maturity;
    const w1 = seasonMaturityWeight(1, curve);
    const w4 = seasonMaturityWeight(4, curve);
    const w8 = seasonMaturityWeight(8, curve);
    assert.ok(w1 < 0.5 && w4 > w1 && w8 > w4);
  });

  it("current_market_proxy is SEPARATE from the public ROS projection and from private forward value", () => {
    const games = [1, 2, 3, 4, 5].map((w) => roleGame(w, { fantasy_points: 25, baseline_expected_points: 12, rush_share: 0.35 }));
    const temporal = buildTemporalContext({ as_of_week: 6, season: 2026, meaningful_games_observed: 5, games_source: "ROLE_OBSERVED_GAMES", position: "RB", metric_family: "ROLE", calibration: CAL });
    const evidence = buildCurrentSeasonEvidence({ observations: games, position: "RB", as_of_week: 6, recency: RECENCY });
    const ms = buildMarketState({
      canonical_player_id: "p1", season: 2026, as_of_week: 6,
      preseason_prior_z: 0, preseason_prior_rank: null, preseason_sources: [],
      current_public_z: 0.1, current_public_rank: null, current_public_readiness: "PARTIAL", current_public_source: "sleeper",
      season_points_rank: 4, recent_rank: 3, evidence, temporal, calibration: CAL, lineage: baseEdge().lineage,
    });
    const pf = buildPrivateForwardValue({ canonical_player_id: "p1", prior: nv(0, "MEDIUM"), evidence, temporal, calibration: CAL, remaining_games_expected: 12 });
    assert.notEqual(ms.current_market_proxy.normalized_value, ms.current_public_projection.normalized_value);
    assert.equal(ms.current_market_proxy.is_estimate, true);
    // proxy (RESULT-driven, TD mirage) should sit ABOVE private forward (ROLE-driven, discounts the mirage)
    assert.ok((ms.current_market_proxy.normalized_value ?? 0) > (pf.projected_ros_value.normalized_value ?? 0));
  });

  it("Week-1 output stays uncertain — PRESEASON_ONLY, never HIGH confidence, proxy ≈ prior", () => {
    const e = runDynamic({ as_of_week: 1, private_prior_z: 1.0, preseason_market_z: -0.2, current_public_z: -0.2, games: [] });
    assert.equal(e.temporal?.evidence_readiness, "PRESEASON_ONLY");
    assert.notEqual(e.confidence, "HIGH");
    assert.ok(e.reason_codes.includes("PRESEASON_PRIOR_DOMINATES"));
    // with no current evidence the current-market edge ≈ the preseason edge
    assert.ok(Math.abs((e.edge_vs_current_market ?? 0) - (e.edge_vs_preseason_market ?? 0)) < 0.5);
  });

  it("calibration artifact loads as DEFAULT_PRIOR when absent; never HIGH confidence on default priors", () => {
    const cal = loadCompetitiveMarketCalibration("/nonexistent/path/cal.json");
    assert.equal(cal.status, "DEFAULT_PRIOR");
    const e = runDynamic({
      as_of_week: 8, private_prior_z: 0.5, preseason_market_z: 0.5, current_public_z: 0.5,
      games: [1, 2, 3, 4, 5, 6, 7].map((w) => roleGame(w, { rush_share: 0.85, fantasy_points: 16, opponent_matchup_score: -0.5 })),
    });
    assert.notEqual(e.confidence, "HIGH");
  });

  it("legacy Checkpoint B static edge is untouched when no dynamic inputs are supplied", () => {
    const be = baseEdge({ edge_score: 1.5, actionable_edge: 1.0, direction: "STRONG_BUY", confidence: "HIGH" });
    // applyDynamicMarketToEdge is only invoked by the dynamic path; a plain
    // MarketEdge from Checkpoint B has no `temporal` field.
    assert.equal(be.temporal, undefined);
    assert.equal(be.quality_status, undefined);
  });
});
