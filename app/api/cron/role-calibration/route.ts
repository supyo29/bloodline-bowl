/**
 * GET /api/cron/role-calibration — idempotent Role & Opportunity calibration job (CRON_SECRET).
 *
 *   1. capture LIVE pre-game role forecasts for the current NFL week (per-player: only games whose kickoff is still in the future;
 *      the database also rejects a LIVE_CAPTURED row at/after kickoff),
 *   2. after games finalize, join forecast x observed role x Phase-1 ledger case into the analysis table (idempotent by analysis_id);
 *      a completed week that has no persisted forecast for a player is bootstrapped with a LABELED AS_OF_RECONSTRUCTION (strictly-earlier inputs only).
 *
 * Insert-only; never touches a projection, weight, floor/ceiling or any production decision. `?dry_run=1` builds without writing;
 * `?season=&week=` targets one week; `?mode=capture|analysis|both` (default both).
 */
import { authorizeSecret } from "@/lib/http-auth";
import { handleOptions, jsonResponse } from "@/lib/http";
import { getNflState } from "@/lib/sleeper/client";
import { loadLeagueScoringInputs } from "@/lib/calibration/leagues";
import { captureRoleForecasts, materializeRoleAnalysis } from "@/lib/role-calibration/materialize";
import { loadRoleProfilesAsOf } from "@/lib/role-calibration/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeSecret(request, "CRON_SECRET");
  if (!auth.ok) return jsonResponse({ ok: false, code: auth.code, detail: auth.detail }, { status: auth.status, headers: { "Cache-Control": "no-store" } });
  const url = new URL(request.url);
  const state = await getNflState().catch(() => null);
  const season = Number(url.searchParams.get("season") ?? state?.season ?? new Date().getFullYear());
  const current = Number(url.searchParams.get("week") ?? state?.week ?? 1);
  const mode = url.searchParams.get("mode") ?? "both";
  const write = url.searchParams.get("dry_run") !== "1";
  const started = new Date().toISOString();
  try {
    const out: Record<string, unknown> = { capture: [] as unknown[], analysis: [] as unknown[] };
    const availableProfileWeeks = new Set(loadRoleProfilesAsOf().map((p) => p.target_week));
    if (mode !== "analysis") {
      // capture the current week and the next, but only for weeks the committed role inputs actually cover (never a guess)
      for (const w of [current, current + 1]) {
        if (!availableProfileWeeks.has(w)) { (out.capture as unknown[]).push({ week: w, skipped: "no committed role profiles for this target week (refresh workflow has not covered it yet)" }); continue; }
        (out.capture as unknown[]).push((await captureRoleForecasts({ season, week: w, kind: "LIVE_CAPTURED", write })).summary);
      }
    }
    if (mode !== "capture") {
      const leagues = await loadLeagueScoringInputs();
      for (const w of [...new Set([Math.max(1, current - 1), current])]) (out.analysis as unknown[]).push((await materializeRoleAnalysis({ season, week: w, leagues, write, reconstructMissing: true })).summary);
    }
    return jsonResponse({ ok: true, season, current_week: current, mode, write_attempted: write, started_at: started, finished_at: new Date().toISOString(), ...out }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return jsonResponse({ ok: false, code: "role_calibration_failed", detail: e instanceof Error ? e.message : String(e) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
