/**
 * GET /api/calibration/report?season=2026[&week=3][&league=...][&group_by=league_slug,position]
 * Read-only aggregate over the calibration ledger (current revisions). Default grouping: league_slug,position.
 * Reports N, bias, MAE, RMSE and floor/ceiling coverage; no coefficients, no promotion decisions.
 */
import { handleOptions, jsonResponse, errorResponse } from "@/lib/http";
import { defaultWeeklyAuditRest } from "@/lib/persistence/supabase/weekly-audit-store";
import { readCurrentCases } from "@/lib/calibration/store";
import { buildCalibrationReport, statusCounts, type ReportDimension } from "@/lib/calibration/report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const DIMS: ReportDimension[] = ["season", "week", "league_slug", "scoring_fingerprint", "provider", "position", "projection_model_version", "projection_source", "evidence_status", "scoring_approximation", "range_status", "participation_state", "projection_artifact_kind"];

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  const season = Number(p.get("season"));
  if (!Number.isInteger(season)) return errorResponse(400, "invalid_query_parameter", "season is required");
  const week = p.get("week") ? Number(p.get("week")) : undefined;
  const group = (p.get("group_by") ?? "league_slug,position").split(",").filter(Boolean) as ReportDimension[];
  if (group.some((g) => !DIMS.includes(g))) return errorResponse(400, "invalid_query_parameter", `group_by must be from: ${DIMS.join(",")}`);
  const rest = defaultWeeklyAuditRest();
  if (!rest) return errorResponse(503, "persistence_unavailable", "Supabase not configured");
  const rows = await readCurrentCases(rest, { season, week, league_slug: p.get("league") ?? undefined });
  return jsonResponse({ season, week: week ?? null, total_cases: rows.length, status_counts: statusCounts(rows), report: buildCalibrationReport(rows, group) }, { headers: { "Cache-Control": "no-store" } });
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
