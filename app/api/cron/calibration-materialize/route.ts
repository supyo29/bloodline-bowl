/**
 * GET /api/cron/calibration-materialize — idempotent projection-calibration ledger materializer.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`. Writes insert-only ledger rows (bridge_calibration_*) for every FINAL NFL
 * game of the target week(s) across every configured league; never touches a projection, model weight or production
 * surface. Default weeks: the NFL frontier week and the one before it (late-finishing Monday games / corrections).
 * `?dry_run=1` builds and reports without writing. `?season=&week=` targets one week explicitly.
 */
import { authorizeSecret } from "@/lib/http-auth";
import { handleOptions, jsonResponse } from "@/lib/http";
import { getNflState } from "@/lib/sleeper/client";
import { loadLeagueScoringInputs } from "@/lib/calibration/leagues";
import { materializeCalibrationWeek } from "@/lib/calibration/materialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeSecret(request, "CRON_SECRET");
  if (!auth.ok) return jsonResponse({ ok: false, code: auth.code, detail: auth.detail }, { status: auth.status, headers: { "Cache-Control": "no-store" } });
  const url = new URL(request.url);
  const state = await getNflState().catch(() => null);
  const season = Number(url.searchParams.get("season") ?? state?.season ?? new Date().getFullYear());
  const explicit = url.searchParams.get("week");
  const current = state?.week ?? 1;
  const weeks = explicit ? [Number(explicit)] : [...new Set([Math.max(1, current - 1), current])];
  const write = url.searchParams.get("dry_run") !== "1";
  const startedAt = new Date().toISOString();
  try {
    const leagues = await loadLeagueScoringInputs();
    const results = [];
    for (const week of weeks) {
      const { summary } = await materializeCalibrationWeek({ season, week, leagues, rest: null, write });
      results.push(summary);
    }
    return jsonResponse({ ok: true, season, weeks, write_attempted: write, started_at: startedAt, finished_at: new Date().toISOString(),
      leagues: leagues.map((l) => ({ league_slug: l.league_slug, provider: l.provider, scoring_fingerprint: l.scoring_fingerprint, scoring_available: !!l.raw_scoring, note: l.note ?? null })), results }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return jsonResponse({ ok: false, code: "calibration_materialize_failed", detail: e instanceof Error ? e.message : String(e) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
