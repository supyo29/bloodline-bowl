/**
 * GET /api/role-calibration/evaluate?season=2026&week=3[&players=Gibbs,Kittle] — READ-ONLY live evaluation (no writes).
 *
 * Reads Phase-1 ledger cases + any persisted role forecasts, reconstructs the labeled AS_OF forecast for players without one, builds the
 * analysis rows in memory and returns the full Phase-2 report (coverage, role accuracy, role-vs-fantasy, shadow vs baseline incl. tail
 * misses). SHADOW_ONLY; production projections are untouched. Cached at the edge for 10 minutes (compute-heavy, public read-only data).
 */
import { handleOptions, jsonResponse, errorResponse } from "@/lib/http";
import { defaultWeeklyAuditRest } from "@/lib/persistence/supabase/weekly-audit-store";
import { loadLeagueScoringInputs } from "@/lib/calibration/leagues";
import { materializeRoleAnalysis, forecastsForWeek, loadExclusions } from "@/lib/role-calibration/materialize";
import { roleReport } from "@/lib/role-calibration/report";
import { ROLE_CALIBRATION_ANALYSIS_VERSION, SHADOW_MODE } from "@/lib/role-calibration/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  const season = Number(p.get("season")), week = Number(p.get("week"));
  if (!Number.isInteger(season) || !Number.isInteger(week)) return errorResponse(400, "invalid_query_parameter", "season and week are required");
  const rest = defaultWeeklyAuditRest();
  if (!rest) return errorResponse(503, "persistence_unavailable", "Supabase not configured");
  const leagues = await loadLeagueScoringInputs();
  const fw = await forecastsForWeek(rest, season, week);
  const { rows, summary } = await materializeRoleAnalysis({ season, week, leagues, rest, write: false, forecasts: fw.forecasts });
  const names = (p.get("players") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const detail = names.length ? rows.filter((r) => r.league_slug === (p.get("league") ?? "bloodline-bowl") && names.some((n) => (r.player_name ?? "").toLowerCase().includes(n))) : undefined;
  return jsonResponse({
    season, week, mode: SHADOW_MODE, analysis_version: ROLE_CALIBRATION_ANALYSIS_VERSION, production_influence: "NONE", persisted: false,
    forecasts: { persisted: fw.persisted, reconstructed_as_of: fw.reconstructed }, analysis: summary, exclusions_listed: loadExclusions().length,
    report: roleReport(rows), detail,
  }, { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200" } });
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
