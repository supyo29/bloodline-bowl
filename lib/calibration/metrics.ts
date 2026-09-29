/**
 * Deterministic, hand-verifiable calibration math. Continuous errors only — NO MET/OVER/UNDER threshold lives here.
 * Full precision is preserved per case; only aggregates are rounded (4 dp, matching lib/weekly-audit/calibration.ts).
 */
import type { RangeStatus } from "./types";

const r4 = (v: number): number => Math.round(v * 10_000) / 10_000;

export interface CaseErrors { error: number; abs_error: number; squared_error: number }
/** error = actual - projected (positive = the model UNDER-projected). Rounded to 6 dp to absorb IEEE-754 noise only. */
export function caseErrors(projected: number, actual: number): CaseErrors {
  const e = Math.round((actual - projected) * 1e6) / 1e6;
  return { error: e, abs_error: Math.abs(e), squared_error: Math.round(e * e * 1e6) / 1e6 };
}

export interface RangeResult { range_status: RangeStatus; below_floor: boolean | null; inside_projected_range: boolean | null; above_ceiling: boolean | null }
/** Inclusive band: actual == floor or == ceiling is INSIDE. A missing/inverted range is RANGE_UNAVAILABLE, never guessed. */
export function rangeResult(actual: number | null, floor: number | null, ceiling: number | null): RangeResult {
  if (actual == null) return { range_status: "NOT_EVALUATED", below_floor: null, inside_projected_range: null, above_ceiling: null };
  if (floor == null || ceiling == null || !Number.isFinite(floor) || !Number.isFinite(ceiling) || floor > ceiling) {
    return { range_status: "RANGE_UNAVAILABLE", below_floor: null, inside_projected_range: null, above_ceiling: null };
  }
  if (actual < floor) return { range_status: "BELOW_FLOOR", below_floor: true, inside_projected_range: false, above_ceiling: false };
  if (actual > ceiling) return { range_status: "ABOVE_CEILING", below_floor: false, inside_projected_range: false, above_ceiling: true };
  return { range_status: "INSIDE_RANGE", below_floor: false, inside_projected_range: true, above_ceiling: false };
}

export interface MetricRow { error: number | null; abs_error: number | null; squared_error: number | null; range_status: RangeStatus }
export interface AggregateMetrics {
  n: number;
  /** mean(actual - projected): positive => under-projection */
  bias: number | null;
  mae: number | null;
  rmse: number | null;
  /** cases with a usable floor/ceiling */
  range_n: number;
  below_floor: number; inside_range: number; above_ceiling: number;
  /** inside_range / range_n — the floor/ceiling coverage rate */
  coverage_rate: number | null;
}
export function aggregateMetrics(rows: readonly MetricRow[]): AggregateMetrics {
  const m = rows.filter((r) => r.error != null && r.abs_error != null && r.squared_error != null);
  const n = m.length;
  const below = rows.filter((r) => r.error != null && r.range_status === "BELOW_FLOOR").length;
  const inside = rows.filter((r) => r.error != null && r.range_status === "INSIDE_RANGE").length;
  const above = rows.filter((r) => r.error != null && r.range_status === "ABOVE_CEILING").length;
  const rangeN = below + inside + above;
  return {
    n,
    bias: n ? r4(m.reduce((s, r) => s + r.error!, 0) / n) : null,
    mae: n ? r4(m.reduce((s, r) => s + r.abs_error!, 0) / n) : null,
    rmse: n ? r4(Math.sqrt(m.reduce((s, r) => s + r.squared_error!, 0) / n)) : null,
    range_n: rangeN, below_floor: below, inside_range: inside, above_ceiling: above,
    coverage_rate: rangeN ? r4(inside / rangeN) : null,
  };
}
