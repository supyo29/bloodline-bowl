/**
 * Role & Opportunity SHADOW candidate. Never touches a production projection: it reads a baseline number and returns a
 * separate candidate with full accounting. PRE-REGISTERED, unfitted parameters (chosen from football meaning before any
 * Week-3 error was inspected; the sensitivity grid in evaluate.ts is diagnostic only and never used to choose them):
 *
 *   xfp_eff    = (1 - p_absent) * xFP(forecast opportunity incl. teammate pressure)
 *   adjustment = clamp( KAPPA * conf_weight * (xfp_eff - baseline), +/- max(1, 0.25*|baseline|) )
 *   candidate  = baseline + adjustment                                   (SHADOW_ONLY)
 *
 * A second, narrower candidate isolates teammate-absence redistribution:
 *   adjustment_tm = clamp( KAPPA * conf_weight * (1-p_absent) * (xFP(with pressure) - xFP(without pressure)), same cap )
 */
import { SHADOW_MODE, type ForecastConfidence } from "./types";

export const ROLE_SHADOW_KAPPA = 0.3;
export const ROLE_SHADOW_CONF_WEIGHT: Record<ForecastConfidence, number> = { MEDIUM: 1, LOW: 0.6, INSUFFICIENT_SAMPLE: 0 };
export const ROLE_SHADOW_CAP_FRACTION = 0.25;
export const ROLE_SHADOW_CAP_FLOOR_POINTS = 1;
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4 + 0; // + 0 normalizes -0
const capOf = (baseline: number): number => Math.max(ROLE_SHADOW_CAP_FLOOR_POINTS, ROLE_SHADOW_CAP_FRACTION * Math.abs(baseline));
const clamp = (v: number, cap: number): number => Math.max(-cap, Math.min(cap, v));

export interface ShadowInput { baseline: number; xfp_forecast: number; xfp_no_pressure: number; p_absent: number; confidence: ForecastConfidence; kappa?: number }
export interface ShadowCandidate {
  mode: typeof SHADOW_MODE;
  baseline_projection: number; role_adjustment: number; candidate_projection: number;
  teammate_only_adjustment: number; teammate_only_candidate: number;
  contributions: { xfp_forecast: number; xfp_effective: number; xfp_gap_vs_baseline: number; teammate_pressure_points: number; kappa: number; confidence_weight: number; capped: boolean };
  confidence: ForecastConfidence; reason_codes: string[];
}
export function shadowCandidate(i: ShadowInput): ShadowCandidate {
  const kappa = i.kappa ?? ROLE_SHADOW_KAPPA, cw = ROLE_SHADOW_CONF_WEIGHT[i.confidence];
  const xEff = (1 - i.p_absent) * i.xfp_forecast, gap = xEff - i.baseline, cap = capOf(i.baseline);
  const raw = kappa * cw * gap, adj = clamp(raw, cap);
  const tmPoints = (1 - i.p_absent) * (i.xfp_forecast - i.xfp_no_pressure);
  const adjTm = clamp(kappa * cw * tmPoints, cap);
  const reasons: string[] = [];
  if (cw === 0) reasons.push("ROLE_CONFIDENCE_INSUFFICIENT_NO_ADJUSTMENT");
  else {
    if (Math.abs(adj) < 0.05) reasons.push("ROLE_FORECAST_CONSISTENT_WITH_BASELINE");
    else reasons.push(adj > 0 ? "ROLE_FORECAST_ABOVE_BASELINE" : "ROLE_FORECAST_BELOW_BASELINE");
    if (i.confidence === "LOW") reasons.push("LOW_CONFIDENCE_DAMPED");
    if (Math.abs(tmPoints) >= 0.25) reasons.push("TEAMMATE_ABSENCE_PRESSURE");
    if (i.p_absent > 0) reasons.push("AVAILABILITY_DISCOUNT_APPLIED");
    if (raw !== adj) reasons.push("ADJUSTMENT_CAPPED");
  }
  return { mode: SHADOW_MODE, baseline_projection: i.baseline, role_adjustment: r4(adj), candidate_projection: r4(i.baseline + adj), teammate_only_adjustment: r4(adjTm), teammate_only_candidate: r4(i.baseline + adjTm),
    contributions: { xfp_forecast: r4(i.xfp_forecast), xfp_effective: r4(xEff), xfp_gap_vs_baseline: r4(gap), teammate_pressure_points: r4(tmPoints), kappa, confidence_weight: cw, capped: raw !== adj }, confidence: i.confidence, reason_codes: reasons };
}
