/**
 * GET /api/cron/game-environment — Phase 3 pregame capture + post-game analysis (CRON_SECRET; idempotent, insert-only, SHADOW_ONLY).
 *
 *   live      : for the current and next NFL week (only where committed role inputs cover the week): capture NWS weather, LIVE role forecasts, game environments and
 *               player outcome distributions for every game whose kickoff is still in the future. Per-game freeze: a game that has kicked off is never captured.
 *   analysis  : for the previous and current week: join the Phase-1 ledger x role forecasts x simulated distributions into the analysis table (models A/B/C/D).
 * `?dry_run=1` builds without writing; `?mode=live|analysis|both`; `?season=&week=` target explicitly; `?sims=` overrides the simulation count.
 *
 * Cadence: the Vercel cron runs daily (one run per game day is the infrastructure's limit); .github/workflows/pregame-capture.yml re-invokes this route every
 * two hours on Thu/Sun/Mon when its CRON_SECRET/APP_URL repo secrets exist, so the FINAL pre-kickoff state (injury news, forecast updates) is frozen.
 */
import { authorizeSecret } from "@/lib/http-auth";
import { handleOptions, jsonResponse } from "@/lib/http";
import { getNflState } from "@/lib/sleeper/client";
import { loadLeagueScoringInputs } from "@/lib/calibration/leagues";
import { defaultWeeklyAuditRest } from "@/lib/persistence/supabase/weekly-audit-store";
import { loadRoleProfilesAsOf } from "@/lib/role-calibration/data";
import { captureLiveWeek, persistWeek } from "@/lib/game-distribution/materialize";
import { DEFAULT_SIMS, evaluateWeek } from "@/lib/game-distribution/run-week";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeSecret(request, "CRON_SECRET");
  if (!auth.ok) return jsonResponse({ ok: false, code: auth.code, detail: auth.detail }, { status: auth.status, headers: { "Cache-Control": "no-store" } });
  const url = new URL(request.url); const state = await getNflState().catch(() => null);
  const season = Number(url.searchParams.get("season") ?? state?.season ?? new Date().getFullYear());
  const current = Number(url.searchParams.get("week") ?? state?.week ?? 1);
  const mode = url.searchParams.get("mode") ?? "both"; const write = url.searchParams.get("dry_run") !== "1"; const sims = Number(url.searchParams.get("sims") ?? DEFAULT_SIMS);
  const started = new Date().toISOString();
  try {
    const leagues = await loadLeagueScoringInputs(); const rest = defaultWeeklyAuditRest(); const out: { live: unknown[]; analysis: unknown[] } = { live: [], analysis: [] };
    const covered = new Set(loadRoleProfilesAsOf().map((p) => p.target_week));
    if (mode !== "analysis") for (const w of [current, current + 1]) {
      if (!covered.has(w)) { out.live.push({ week: w, skipped: "no committed role inputs for this target week (refresh workflow has not covered it yet)" }); continue; }
      out.live.push(await captureLiveWeek({ season, week: w, leagues, rest, write, sims }));
    }
    if (mode !== "live") for (const w of [...new Set([Math.max(1, current - 1), current])]) {
      if (!rest) { out.analysis.push({ week: w, skipped: "Supabase not configured" }); continue; }
      const ev = await evaluateWeek({ season, week: w, rest, leagues, sims });
      if (!ev.rows.length) { out.analysis.push({ week: w, skipped: "no completed ledger cases to analyze yet" }); continue; }
      out.analysis.push({ week: w, rows: ev.rows.length, persisted: write ? await persistWeek({ rest, ev, leagues, season, week: w, sims }) : null });
    }
    return jsonResponse({ ok: true, season, current_week: current, mode, write_attempted: write, sims, started_at: started, finished_at: new Date().toISOString(), ...out }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return jsonResponse({ ok: false, code: "game_environment_failed", detail: e instanceof Error ? e.message : String(e) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
