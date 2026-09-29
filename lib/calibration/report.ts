/**
 * Deterministic reader/report builder over ledger cases. Groups by any combination of the supported dimensions and
 * reports N, bias, MAE, RMSE and floor/ceiling coverage. No coefficients, no thresholds, no promotion decisions.
 * Weekly model audits are COMPOSED from these granular rows — the audit is never the sole store of player evidence.
 */
import { aggregateMetrics, type AggregateMetrics } from "./metrics";
import type { CalibrationCase } from "./types";

export type ReportDimension =
  | "season" | "week" | "league_slug" | "scoring_fingerprint" | "provider" | "position" | "projection_model_version" | "projection_source"
  | "evidence_status" | "scoring_approximation" | "range_status" | "participation_state" | "projection_artifact_kind";

type ReportRow = Pick<CalibrationCase, "season" | "week" | "league_slug" | "scoring_fingerprint" | "provider" | "position" | "projection_model_version" | "projection_source" | "evidence_status" | "projection_scoring_exactness" | "actual_scoring_exactness" | "range_status" | "participation_state" | "projection_artifact_kind" | "error" | "abs_error" | "squared_error">;

/** "APPROXIMATE" if either the projection or the actual was not league-exact (K/DST provider-standard, Yahoo unmapped stats). */
export function scoringApproximationLabel(c: Pick<CalibrationCase, "projection_scoring_exactness" | "actual_scoring_exactness">): string {
  const p = c.projection_scoring_exactness, a = c.actual_scoring_exactness;
  if (!p && !a) return "NOT_APPLICABLE";
  return p === "LEAGUE_EXACT" && a === "LEAGUE_EXACT" ? "EXACT" : "APPROXIMATE";
}
const keyOf = (c: ReportRow, dim: ReportDimension): string => {
  switch (dim) {
    case "scoring_approximation": return scoringApproximationLabel(c);
    case "position": return c.position ?? "UNKNOWN";
    case "projection_model_version": return c.projection_model_version ?? "NONE";
    case "projection_source": return c.projection_source ?? "NONE";
    case "projection_artifact_kind": return c.projection_artifact_kind ?? "NONE";
    default: return String(c[dim]);
  }
};

export interface ReportGroup { key: Record<string, string>; total_cases: number; metrics: AggregateMetrics }
export interface CalibrationReport { dimensions: ReportDimension[]; total_cases: number; graded_cases: number; groups: ReportGroup[] }

/** `gradedOnly` (default) restricts the metrics population to certified cases; total_cases always counts every row in each group. */
export function buildCalibrationReport(rows: readonly ReportRow[], dimensions: readonly ReportDimension[], opts: { includeUncertified?: boolean } = {}): CalibrationReport {
  const groups = new Map<string, { key: Record<string, string>; rows: ReportRow[] }>();
  for (const r of rows) {
    const key = Object.fromEntries(dimensions.map((d) => [d, keyOf(r, d)]));
    const k = JSON.stringify(dimensions.map((d) => key[d]));
    (groups.get(k) ?? groups.set(k, { key, rows: [] }).get(k)!).rows.push(r);
  }
  const graded = (r: ReportRow) => r.error != null && (opts.includeUncertified || r.evidence_status === "CERTIFIED" || r.evidence_status === "CERTIFIED_APPROXIMATE_SCORING");
  const out: ReportGroup[] = [...groups.values()]
    .sort((a, b) => (JSON.stringify(a.key) < JSON.stringify(b.key) ? -1 : 1))
    .map((g) => ({ key: g.key, total_cases: g.rows.length, metrics: aggregateMetrics(g.rows.filter(graded)) }));
  return { dimensions: [...dimensions], total_cases: rows.length, graded_cases: rows.filter(graded).length, groups: out };
}

/** Status histogram — the "what is and is not covered" view. */
export function statusCounts(rows: ReadonlyArray<Pick<CalibrationCase, "evidence_status">>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const r of rows) o[r.evidence_status] = (o[r.evidence_status] ?? 0) + 1;
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}
