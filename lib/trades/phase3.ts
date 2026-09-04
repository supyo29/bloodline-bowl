/**
 * Trade Engine — Phase 3: calibration + player intelligence (SHADOW MODE).
 *
 * Phase 3 answers "which contextual signals are actually useful, how much
 * confidence should we place in them, and how should player role / uncertainty
 * modify the valuation" — WITHOUT becoming the authoritative result yet.
 *
 * `shadow_utility_delta` and `shadow_acceptance` are informational: they run
 * alongside Phase 1 (`roster_utility_delta`/`acceptance`, frozen) and Phase 2
 * (`contextual_utility_delta`/`contextual_acceptance`, frozen) and change
 * NEITHER. Per the Phase 3 calibration gate, `config.phase3.weights` default
 * to 0 (no role/schedule signal in this repo has passed ablation against a
 * real dataset — see `lib/trades/calibration.ts` and the calibration report),
 * so today `shadow_utility_delta === contextual_utility_delta` and
 * `shadow_acceptance === contextual_acceptance` EXACTLY, by construction.
 *
 * Confidence (`lib/trades/confidence.ts`) is a DATA-QUALITY signal, never a
 * value judgement — a confident result can be confidently neutral.
 */

import type { TradeConfig } from "./config";
import { classifyAcceptance } from "./config";
import { buildPlayerIntelligence, type VolatilityLevel } from "./intelligence";
import { classifyConfidence, detectModelDisagreement, buildValuationRange } from "./confidence";
import type { TradeAnalysisContext } from "./context";
import type {
  AcceptanceClass,
  Phase3ParticipantResult,
  Phase3PlayerAttribution,
  Phase3Summary,
  TradeDiagnostic,
} from "./schema";
import type { Phase2ParticipantResult } from "./schema";

/**
 * Calibration/player-intelligence version (shadow mode). Bump on any change
 * that can alter a Phase 3 result.
 *   2026.1 — initial Phase 3A–3E: calibration framework, real-data-only player
 *            intelligence (availability + volatility; usage/role/trend/schedule
 *            always UNAVAILABLE — no source exists), confidence layer, shadow
 *            composite at weight 0.
 *   2026.2 — audit fix (D1, P1): an entirely unresolved player identity (no
 *            canonical record AND no weekly projection) was classified
 *            `availability.status: "HEALTHY"` — asserting a specific favorable
 *            claim from zero evidence, not the "no injury reported" case it was
 *            meant for. Now classified `UNKNOWN` with a diagnostic. See
 *            `lib/trades/intelligence.ts` and `docs/TRADE_ENGINE_PHASE3_AUDIT.md`.
 */
export const TRADE_CALIBRATED_VERSION = "ri-trade-calibrated-2026.2" as const;

const round2 = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * 100) / 100;
  // `v * 100` can itself overflow to +/-Infinity for an extreme-but-finite `v`
  // (e.g. near Number.MAX_VALUE) — fall back to the unrounded finite value
  // rather than propagate a non-finite result.
  if (!Number.isFinite(r)) return v;
  return r === 0 ? 0 : r;
};
/** Clamp an adjustment to +/- the configured cap. Exported for direct unit testing of the cap mechanism. */
export const clamp = (v: number, cap: number): number => Math.max(-Math.abs(cap), Math.min(Math.abs(cap), v));

/**
 * Pure composite math: `contextual_utility_delta + weight·roleAdjustment +
 * weight·scheduleAdjustment`, exported so the weighting/cap/normalization
 * mechanism can be unit-tested with synthetic adjustment values WITHOUT
 * implying any real role/schedule signal drives it in production today (both
 * adjustments are hardcoded to 0 in `evaluatePhase3Participant` — see the
 * module doc). Guards against non-finite results.
 */
export function computeShadowUtility(
  contextualUtilityDelta: number,
  roleAdjustment: number,
  scheduleAdjustment: number,
  weights: TradeConfig["phase3"]["weights"],
): number {
  const raw = contextualUtilityDelta + weights.role_adjustment * roleAdjustment + weights.schedule_adjustment * scheduleAdjustment;
  return round2(Number.isFinite(raw) ? raw : contextualUtilityDelta);
}

export interface Phase3EvalInput {
  ctx: TradeAnalysisContext;
  config: TradeConfig;
  phase1_acceptance: AcceptanceClass;
  phase2: Phase2ParticipantResult;
  incoming_ids: string[];
  outgoing_ids: string[];
  /** current-week projection batch status, for the confidence layer */
  projections_status: "READY" | "PROJECTIONS_PARTIAL" | "PROJECTIONS_UNAVAILABLE";
  roster_size: number;
}

export function evaluatePhase3Participant(input: Phase3EvalInput): Phase3ParticipantResult {
  const { ctx, config, phase1_acceptance, phase2, incoming_ids, outgoing_ids } = input;
  const w = config.phase3.weights;
  const caps = config.phase3.caps;
  const diagnostics: TradeDiagnostic[] = [{ code: "PHASE3_SHADOW_ONLY", message: "Phase 3 output is informational (shadow mode) and does not alter Phase 1 or Phase 2 results.", severity: "info" }];

  if (w.role_adjustment === 0) diagnostics.push({ code: "CALIBRATION_SIGNAL_DISABLED", message: "role_adjustment weight is 0 — no validated role/usage signal exists in this repository (see PLAYER_INTELLIGENCE_UNAVAILABLE).", severity: "info" });
  if (w.schedule_adjustment === 0) diagnostics.push({ code: "CALIBRATION_SIGNAL_DISABLED", message: "schedule_adjustment weight is 0 — no validated opponent-adjusted schedule-strength signal exists in this repository.", severity: "info" });

  const marginalById = new Map(phase2.ros.marginal_player_utility.map((m) => [m.canonical_player_id, m]));
  const attribution: Phase3PlayerAttribution[] = [];
  const seenIntelDiag = new Set<string>();
  let unknownVolatilityCount = 0;

  for (const [ids, direction] of [[incoming_ids, "INCOMING"], [outgoing_ids, "OUTGOING"]] as const) {
    for (const id of ids) {
      const intel = buildPlayerIntelligence(id, ctx);
      for (const d of intel.diagnostics) {
        const key = `${d.code}:${id}`;
        if (!seenIntelDiag.has(key)) {
          seenIntelDiag.add(key);
          diagnostics.push(d);
        }
      }
      if (intel.volatility.level === "UNKNOWN") unknownVolatilityCount += 1;

      const marginal = marginalById.get(id);
      const roleAdjustment = clamp(0, caps.max_role_adjustment); // always 0 — see module doc
      const scheduleAdjustment = clamp(0, caps.max_schedule_adjustment); // always 0 — see module doc
      const base = marginal?.marginal_ros_delta ?? null;
      attribution.push({
        canonical_player_id: id,
        direction,
        phase2_marginal_ros: base,
        role_adjustment: roleAdjustment,
        schedule_adjustment: scheduleAdjustment,
        uncertainty: intel.volatility.level,
        phase3_adjusted_value: base == null ? null : round2(base + roleAdjustment + scheduleAdjustment),
      });
    }
  }

  const totalRoleAdj = attribution.reduce((s, a) => s + a.role_adjustment, 0);
  const totalScheduleAdj = attribution.reduce((s, a) => s + a.schedule_adjustment, 0);

  const phase2RosValue = phase2.ros.ros_usable_value_delta;
  const phase3RoleAdjustedRos = round2(phase2RosValue + totalRoleAdj + totalScheduleAdj);

  const shadowUtilityDelta = computeShadowUtility(phase2.contextual_utility_delta, totalRoleAdj, totalScheduleAdj, w);
  const shadowAcceptance = classifyAcceptance(shadowUtilityDelta, config);

  const modelDisagreement = detectModelDisagreement(phase1_acceptance, phase2.contextual_acceptance, shadowAcceptance);
  const confidence = classifyConfidence({
    projections_status: input.projections_status,
    ros_uncovered_count: new Set([...phase2.ros.before.uncovered_player_ids, ...phase2.ros.after.uncovered_player_ids]).size,
    roster_size: input.roster_size,
    unresolved_player_count: ctx.snapshot.unresolved_players.length,
    ros_schedule_status: ctx.ros.schedule_status,
    intelligence_unknown_count: unknownVolatilityCount,
    transferred_player_count: attribution.length,
    model_disagreement: modelDisagreement,
  });

  const avgCv = (() => {
    const cvs = attribution
      .map((a) => a.canonical_player_id)
      .map((id) => buildPlayerIntelligence(id, ctx).volatility.weekly_coefficient_of_variation)
      .filter((x): x is number => x != null);
    return cvs.length > 0 ? cvs.reduce((s, v) => s + v, 0) / cvs.length : null;
  })();
  const valuationRange = buildValuationRange(shadowUtilityDelta, avgCv);

  let divergenceReason: string | null = null;
  if (shadowAcceptance !== phase2.contextual_acceptance) {
    const drivers: string[] = [];
    if (totalRoleAdj !== 0) drivers.push(`role adjustment ${totalRoleAdj > 0 ? "+" : ""}${totalRoleAdj.toFixed(1)}`);
    if (totalScheduleAdj !== 0) drivers.push(`schedule adjustment ${totalScheduleAdj > 0 ? "+" : ""}${totalScheduleAdj.toFixed(1)}`);
    divergenceReason = `Phase 2: ${phase2.contextual_acceptance}; Phase 3 shadow: ${shadowAcceptance}. ${drivers.join("; ") || "calibrated weights shifted the composite"}.`;
  }

  return {
    phase2_ros_value: phase2RosValue,
    phase3_role_adjusted_ros_value: phase3RoleAdjustedRos,
    shadow_utility_delta: shadowUtilityDelta,
    shadow_acceptance: shadowAcceptance,
    phase2_contextual_acceptance: phase2.contextual_acceptance,
    phase1_acceptance,
    confidence: confidence.level,
    confidence_reasons: confidence.reasons,
    valuation_range: valuationRange,
    divergence_reason: divergenceReason,
    player_attribution: attribution,
    diagnostics,
  };
}

export function summarizePhase3(results: Array<{ manager_slug: string; phase3: Phase3ParticipantResult | undefined }>): Phase3Summary {
  const withP3 = results.filter((r): r is { manager_slug: string; phase3: Phase3ParticipantResult } => Boolean(r.phase3));
  return {
    shadow_only: true,
    participants_with_divergence: withP3.filter((r) => r.phase3.divergence_reason != null).map((r) => r.manager_slug),
    participants_with_low_confidence: withP3.filter((r) => r.phase3.confidence === "LOW" || r.phase3.confidence === "DEGRADED").map((r) => r.manager_slug),
  };
}

export type { VolatilityLevel };
