/**
 * Competitive Trade Intelligence — time-indexed MARKET STATE (Checkpoint B.5).
 *
 * The four concepts kept physically separate (spec §7):
 *   A preseason_market_prior     — ADP consensus + this-league draft cost
 *   B current_public_projection  — Sleeper/RotoWire ROS (a source, not the proxy)
 *     current_performance_signal — realized positional finish / recent rank
 *   C current_market_proxy       — ESTIMATE of current fantasy trade pricing
 *
 * `current_market_proxy` blends the preseason prior with a RESULT-dominant
 * current-market composite (spec §14: fantasy managers react to the scoreboard),
 * weighted by SEASON MATURITY so preseason ADP decays as a prior (spec §6). It
 * is NEVER our private forecast — this module does not import `private-forward.ts`.
 */

import { blendWithPrior } from "./temporal";
import type { CompetitiveMarketCalibration } from "./calibration";
import type { CurrentSeasonEvidence } from "./evidence";
import type {
  MarketLineage,
  MarketReadiness,
  MarketState,
  MarketTrajectory,
  TemporalContext,
  ValueConfidence,
} from "./schema";

const LEVEL_CONF: ValueConfidence[] = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];

export interface BuildMarketStateInput {
  canonical_player_id: string;
  season: number;
  as_of_week: number;
  /** A: preseason prior, z-scored within position (from ADP / league draft cost) */
  preseason_prior_z: number | null;
  preseason_prior_rank: number | null;
  preseason_sources: string[];
  /** B: current public ROS projection, z-scored (Sleeper benchmark from Checkpoint B) */
  current_public_z: number | null;
  current_public_rank: number | null;
  current_public_readiness: MarketReadiness;
  current_public_source: string;
  /** realized fantasy standing */
  season_points_rank: number | null;
  recent_rank: number | null;
  evidence: CurrentSeasonEvidence;
  temporal: TemporalContext;
  calibration: CompetitiveMarketCalibration;
  lineage: MarketLineage;
  /** an earlier stored market snapshot's proxy z, for trajectory (§21). null ⇒ UNKNOWN */
  prior_snapshot_proxy_z?: number | null;
}

export function buildMarketState(input: BuildMarketStateInput): MarketState {
  const { evidence, temporal, calibration } = input;
  const w = calibration.performance_market_weights;

  // ---- current-market composite (RESULT-dominant), as a z-delta from prior ----
  let composite: number | null = null;
  let num = 0;
  let den = 0;
  const add = (v: number | null, weight: number): void => {
    if (v == null || !Number.isFinite(v)) return;
    num += weight * v;
    den += weight;
  };
  // RESULT: realized fantasy points, centered ~12 and scaled
  add(evidence.result_signal != null ? clampZ((evidence.result_signal - 12) / 6) : null, w.RESULT ?? 0.55);
  // ROLE: markets do notice obvious usage changes, but weakly
  add(evidence.role_signal, w.ROLE ?? 0.2);
  // EFFICIENCY: markets barely price this
  add(evidence.efficiency_signal != null ? clampZ(evidence.efficiency_signal / 6) : null, w.EFFICIENCY ?? 0.15);
  // CONTEXT: markets rarely schedule-adjust
  add(evidence.context_signal != null ? -clampZ(evidence.context_signal) * 0.3 : null, w.CONTEXT ?? 0.1);
  if (den > 0) composite = num / den;

  // ---- current_market_proxy: the freshest usable estimate of trade pricing ----
  // §34 source hierarchy: a current public ROS projection > a performance proxy
  // > the preseason ADP prior. With NO current-season evidence, the proxy is
  // simply the freshest market source (Sleeper ROS), NOT a divergent ADP rank.
  const sm = temporal.season_maturity_weight;
  const preZ = input.preseason_prior_z;
  const pubZ = input.current_public_z;
  const pubFresh = input.current_public_readiness === "CURRENT" || input.current_public_readiness === "PARTIAL";

  let proxyZ: number | null;
  let proxyTier: MarketState["proxy_source_tier"];

  if (evidence.games_observed === 0) {
    // preseason only — freshest market source governs
    if (pubZ != null) {
      proxyZ = pubZ;
      proxyTier = pubFresh ? "CURRENT_PROVIDER_PROJECTION" : "PRESEASON_ADP";
    } else {
      proxyZ = preZ;
      proxyTier = "PRESEASON_ADP";
    }
  } else {
    // performance proxy: decay the preseason prior toward (prior + current composite)
    const base = preZ ?? pubZ;
    let perf = composite != null && base != null ? blendWithPrior(base, base + composite, sm) : base;
    proxyTier = "CURRENT_PERFORMANCE_PROXY";
    if (pubZ != null && pubFresh) {
      perf = perf == null ? pubZ : 0.5 * pubZ + 0.5 * perf;
      proxyTier = "CURRENT_PUBLIC_ROS_CONSENSUS";
    }
    proxyZ = perf;
  }

  // ---- trajectory (§21) ----
  const trajectory = classifyTrajectory({
    preseasonZ: input.preseason_prior_z,
    proxyZ,
    priorSnapshotProxyZ: input.prior_snapshot_proxy_z ?? null,
    resultSignal: evidence.result_signal,
    gamesObserved: evidence.games_observed,
  });

  // ---- confidence: never HIGH early or on default priors; one big week ≠ HIGH ----
  let level = 2; // MEDIUM baseline
  if (temporal.evidence_readiness === "PRESEASON_ONLY") level = input.preseason_prior_z != null ? 2 : 0;
  if (temporal.evidence_readiness === "EARLY_SEASON") level = 1;
  if (temporal.evidence_readiness === "PARTIAL_CURRENT") level = 2;
  if (temporal.evidence_readiness === "CURRENT") level = input.current_public_readiness === "CURRENT" ? 3 : 2;
  if (input.lineage.dispersion >= 12) level = Math.max(0, level - 1);
  if (temporal.calibration_status !== "CALIBRATED") level = Math.min(level, 2);
  const confidence = LEVEL_CONF[Math.max(0, Math.min(3, level))]!;

  return {
    canonical_player_id: input.canonical_player_id,
    as_of_week: input.as_of_week,
    season: input.season,
    preseason_market_prior: {
      position_rank: input.preseason_prior_rank,
      normalized_value: input.preseason_prior_z,
      sources: input.preseason_sources,
    },
    current_public_projection: {
      position_rank: input.current_public_rank,
      normalized_value: input.current_public_z,
      source: input.current_public_source,
      readiness: input.current_public_readiness,
    },
    current_performance_signal: {
      season_points_rank: input.season_points_rank,
      recent_rank: input.recent_rank,
      games: evidence.games_observed,
    },
    current_market_proxy: {
      position_rank: null,
      normalized_value: proxyZ == null ? null : round4(proxyZ),
      components: [
        `preseason_prior(w=${(1 - sm).toFixed(2)})`,
        ...(composite != null ? [`current_result_composite(w=${sm.toFixed(2)})`] : []),
        ...(input.current_public_z != null && input.current_public_readiness === "CURRENT" ? ["current_public_ros"] : []),
      ],
      is_estimate: true,
    },
    market_trajectory: trajectory,
    evidence_readiness: temporal.evidence_readiness,
    confidence,
    lineage: input.lineage,
    proxy_source_tier: proxyTier,
  };
}

function classifyTrajectory(x: {
  preseasonZ: number | null;
  proxyZ: number | null;
  priorSnapshotProxyZ: number | null;
  resultSignal: number | null;
  gamesObserved: number;
}): MarketTrajectory {
  if (x.gamesObserved === 0) return "UNKNOWN";
  // prefer a real two-snapshot slope
  if (x.priorSnapshotProxyZ != null && x.proxyZ != null) {
    const d = x.proxyZ - x.priorSnapshotProxyZ;
    if (d >= 0.8) return "RISING_FAST";
    if (d >= 0.25) return "RISING";
    if (d <= -0.8) return "FALLING_FAST";
    if (d <= -0.25) return "FALLING";
    return "STABLE";
  }
  // one snapshot only: compare proxy to preseason prior + lean on recent result
  if (x.preseasonZ != null && x.proxyZ != null) {
    const d = x.proxyZ - x.preseasonZ;
    const hot = x.resultSignal != null && x.resultSignal >= 18;
    const cold = x.resultSignal != null && x.resultSignal <= 6;
    if (d >= 0.8 || (d >= 0.4 && hot)) return "RISING_FAST";
    if (d >= 0.25) return "RISING";
    if (d <= -0.8 || (d <= -0.4 && cold)) return "FALLING_FAST";
    if (d <= -0.25) return "FALLING";
    return "STABLE";
  }
  return "UNKNOWN";
}

function clampZ(v: number): number {
  return Math.max(-4, Math.min(4, v));
}
function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
