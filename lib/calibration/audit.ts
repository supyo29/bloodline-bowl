/** Composes the weekly-audit calibration-ledger component FROM granular cases (the audit never stores player-level evidence itself). */
import { createHash } from "node:crypto";
import { aggregateMetrics, type AggregateMetrics } from "./metrics";
import { buildCalibrationReport, statusCounts, type ReportGroup } from "./report";
import type { CalibrationCase } from "./types";

export interface LedgerWeekAudit {
  ledger_digest: string; total_cases: number; graded_cases: number; status_counts: Record<string, number>;
  overall: AggregateMetrics; by_league: ReportGroup[]; by_position: ReportGroup[]; by_scoring_approximation: ReportGroup[];
  note: string;
}
export function ledgerDigest(rows: ReadonlyArray<Pick<CalibrationCase, "case_id" | "evidence_digest">>): string {
  return createHash("sha256").update(rows.map((r) => `${r.case_id}:${r.evidence_digest}`).sort().join("|")).digest("hex").slice(0, 16);
}
export function buildLedgerWeekAudit(rows: readonly CalibrationCase[]): LedgerWeekAudit {
  const rep = buildCalibrationReport(rows, []);
  return {
    ledger_digest: ledgerDigest(rows), total_cases: rows.length, graded_cases: rep.graded_cases, status_counts: statusCounts(rows),
    overall: rep.groups[0]?.metrics ?? aggregateMetrics([]),
    by_league: buildCalibrationReport(rows, ["league_slug"]).groups,
    by_position: buildCalibrationReport(rows, ["position"]).groups,
    by_scoring_approximation: buildCalibrationReport(rows, ["scoring_approximation"]).groups,
    note: "Composed from bridge_calibration_cases_current; continuous errors only, no thresholds or coefficients.",
  };
}
