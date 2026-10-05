/**
 * GET /api/game-distribution/evaluate?season=2026&week=3[&players=Gibbs,Purdy][&league=bloodline-bowl] — READ-ONLY live evaluation (no writes).
 * Simulates the labeled as-of distributions for a completed week, scores models A/B/C/D against the Phase-1 ledger and returns the report (+ optional per-player
 * detail). SHADOW_ONLY. Cached at the edge for 10 minutes (compute-heavy, public read-only data).
 */
import { handleOptions, jsonResponse, errorResponse } from "@/lib/http";
import { defaultWeeklyAuditRest } from "@/lib/persistence/supabase/weekly-audit-store";
import { loadLeagueScoringInputs } from "@/lib/calibration/leagues";
import { evaluateWeek } from "@/lib/game-distribution/run-week";
import { distributionReport } from "@/lib/game-distribution/report";
import { GAME_DISTRIBUTION_MODEL_VERSION } from "@/lib/game-distribution/priors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams; const season = Number(p.get("season")), week = Number(p.get("week"));
  if (!Number.isInteger(season) || !Number.isInteger(week)) return errorResponse(400, "invalid_query_parameter", "season and week are required");
  const rest = defaultWeeklyAuditRest(); if (!rest) return errorResponse(503, "persistence_unavailable", "Supabase not configured");
  const ev = await evaluateWeek({ season, week, rest, leagues: await loadLeagueScoringInputs() });
  const names = (p.get("players") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const detail = names.length ? ev.rows.filter((r) => r.league_slug === (p.get("league") ?? "bloodline-bowl") && names.some((n) => (r.player_name ?? "").toLowerCase().includes(n))) : undefined;
  return jsonResponse({ season, week, mode: "SHADOW_ONLY", model_version: GAME_DISTRIBUTION_MODEL_VERSION, production_influence: "NONE", persisted: false, report: distributionReport(ev.rows), environments: ev.envs.length, detail }, { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200" } });
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
