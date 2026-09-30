/** GET /api/role-calibration/report?season=2026[&week=3] — read-only Role & Opportunity calibration report over the current analysis rows (SHADOW_ONLY candidate; no production influence). */
import { handleOptions, jsonResponse, errorResponse } from "@/lib/http";
import { defaultWeeklyAuditRest } from "@/lib/persistence/supabase/weekly-audit-store";
import { readCurrentAnalysis } from "@/lib/role-calibration/store";
import { roleReport } from "@/lib/role-calibration/report";
import { ROLE_CALIBRATION_ANALYSIS_VERSION, SHADOW_MODE } from "@/lib/role-calibration/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  const season = Number(p.get("season"));
  if (!Number.isInteger(season)) return errorResponse(400, "invalid_query_parameter", "season is required");
  const week = p.get("week") ? Number(p.get("week")) : undefined;
  const rest = defaultWeeklyAuditRest();
  if (!rest) return errorResponse(503, "persistence_unavailable", "Supabase not configured");
  const rows = await readCurrentAnalysis(rest, season, week);
  return jsonResponse({ season, week: week ?? null, mode: SHADOW_MODE, analysis_version: ROLE_CALIBRATION_ANALYSIS_VERSION, production_influence: "NONE", report: roleReport(rows) }, { headers: { "Cache-Control": "no-store" } });
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
