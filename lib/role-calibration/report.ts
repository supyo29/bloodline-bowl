/** Composes the full Phase-2 evaluation report from analysis rows (pure). Used by the read-only route, the weekly audit and the certify script. */
import { bucketMagnitude, bucketVolatility, compare, coverage, dedupeFootball, kappaSensitivity, roleAccuracy, roleVsFantasy, segment, tail, tailAttribution } from "./evaluate";
import type { RoleAnalysisRow } from "./analysis";
import { createHash } from "node:crypto";

export function roleReport(all: readonly RoleAnalysisRow[]) {
  const sleeper = dedupeFootball(all);
  const evalRows = sleeper.filter((r) => r.eval_populations.projection_eval);
  const excludedInjury = sleeper.filter((r) => r.labels.injury_contamination).length;
  const byFp = Object.fromEntries([...new Set(all.map((r) => `${r.provider}|${r.scoring_fingerprint}`))].sort().map((k) => {
    const rows = dedupeFootball(all.filter((r) => `${r.provider}|${r.scoring_fingerprint}` === k), { includeYahoo: true }).filter((r) => r.eval_populations.projection_eval);
    return [k, { role: compare(rows, "role"), teammate_only: compare(rows, "teammate_only") }];
  }));
  return {
    rows_total: all.length, football_rows_sleeper_deduped: sleeper.length, projection_eval_rows: evalRows.length, injury_contaminated_excluded: excludedInjury,
    coverage: coverage(sleeper), role_accuracy: roleAccuracy(sleeper), role_vs_fantasy: { all: roleVsFantasy(sleeper), by_position: Object.fromEntries(["QB", "RB", "WR", "TE"].map((p) => [p, roleVsFantasy(sleeper, p)])) },
    tail_attribution: [5, 8, 10].map((t) => tailAttribution(sleeper, t)),
    shadow: {
      overall: compare(evalRows, "role"), teammate_only: compare(evalRows, "teammate_only"),
      by_position: segment(evalRows, (r) => r.position), by_confidence: segment(evalRows, (r) => r.forecast_confidence ?? "NONE"),
      by_projection_magnitude: segment(evalRows, (r) => bucketMagnitude(r.baseline_projection)), by_role_volatility: segment(evalRows, (r) => bucketVolatility(r.labels.role_volatility)),
      by_starter_vs_committee: segment(evalRows, (r) => (r.labels.depth_starter == null ? "UNKNOWN" : r.labels.depth_starter ? "DEPTH_STARTER" : "NOT_DEPTH_STARTER")),
      by_role_trend: segment(evalRows, (r) => r.labels.role_trend), by_teammate_absence: segment(evalRows, (r) => (r.labels.teammate_absence ? "TEAMMATE_ABSENT" : "NO_HARD_ABSENCE")),
      tail: [5, 8, 10].map((t) => tail(evalRows, t)), tail_teammate_only: [5, 8, 10].map((t) => tail(evalRows, t, "teammate_only")),
      kappa_sensitivity_diagnostic_only: kappaSensitivity(evalRows),
    },
    by_scoring_fingerprint: byFp,
  };
}
export const roleReportDigest = (rows: readonly RoleAnalysisRow[]): string => createHash("sha256").update(rows.map((r) => r.analysis_id).sort().join("|")).digest("hex").slice(0, 16);

/** Compact weekly-audit component (the audit composes from analysis rows; it never stores player-level evidence). */
export function roleAuditComponent(all: readonly RoleAnalysisRow[]) {
  const r = roleReport(all);
  return {
    role_digest: roleReportDigest(all), analysis_rows: r.rows_total, projection_eval_rows: r.projection_eval_rows, injury_contaminated_excluded: r.injury_contaminated_excluded,
    coverage: r.coverage, role_accuracy: r.role_accuracy, role_vs_fantasy: r.role_vs_fantasy.all, tail_attribution: r.tail_attribution,
    shadow: { mode: "SHADOW_ONLY" as const, overall: r.shadow.overall, teammate_only: r.shadow.teammate_only, by_position: r.shadow.by_position, tail: r.shadow.tail },
    note: "Role & Opportunity calibration (Phase 2). SHADOW_ONLY: production projections are unchanged.",
  };
}
export type RoleAuditComponent = ReturnType<typeof roleAuditComponent>;
