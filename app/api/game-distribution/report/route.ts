/** GET /api/game-distribution/report?season=2026[&week=3] — read-only Phase-3 report over the persisted analysis rows (models A/B/C/D, SHADOW_ONLY; no production influence). */
import { handleOptions, jsonResponse, errorResponse } from "@/lib/http";
import { defaultWeeklyAuditRest } from "@/lib/persistence/supabase/weekly-audit-store";
import { readCurrentDistributionAnalysis } from "@/lib/game-distribution/store";
import { distributionReport, MODEL_LABELS } from "@/lib/game-distribution/report";
import { GAME_DISTRIBUTION_MODEL_VERSION } from "@/lib/game-distribution/priors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams; const season = Number(p.get("season"));
  if (!Number.isInteger(season)) return errorResponse(400, "invalid_query_parameter", "season is required");
  const week = p.get("week") ? Number(p.get("week")) : undefined; const rest = defaultWeeklyAuditRest();
  if (!rest) return errorResponse(503, "persistence_unavailable", "Supabase not configured");
  const rows = await readCurrentDistributionAnalysis(rest, season, week);
  return jsonResponse({ season, week: week ?? null, mode: "SHADOW_ONLY", model_version: GAME_DISTRIBUTION_MODEL_VERSION, production_influence: "NONE", models: MODEL_LABELS, report: distributionReport(rows) }, { headers: { "Cache-Control": "no-store" } });
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
