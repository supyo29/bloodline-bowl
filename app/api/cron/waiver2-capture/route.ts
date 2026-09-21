/**
 * GET /api/cron/waiver2-capture — scheduled PROSPECTIVE shadow capture (Phase 4.5).
 *
 * Once the canonical market state certifies a league's free-agent pool, this job evaluates Waiver Intelligence 2.0 for every manager and
 * records (a) the immutable market-state snapshot and (b) the shadow capture record — with no manual step and no new deployment. It is the
 * same code path the evidence route uses (`buildWaiverInputForManager` → `evaluateWaiver2` → `persistWaiver2Evidence`); the capture class is
 * DERIVED (LIVE_CAPTURED only when every involved game is verifiably pre-game), so a scheduled run that lands after a kickoff is honestly
 * LIVE_POST_LOCK / LIVE_UNVERIFIED, never pristine. Blocked pools record a NOT_ACTIONABLE readiness fact only.
 *
 * SHADOW ONLY: nothing is submitted, no production surface reads any of this, and Waiver 2.0 stays SHADOW_ONLY.
 * Auth: `Authorization: Bearer $CRON_SECRET` (sent automatically by Vercel Cron). Failures are per manager and never mark another successful.
 */
import { authorizeSecret } from "@/lib/http-auth";
import { runScheduledWaiver2Capture } from "@/lib/persistence/supabase/waiver2-capture-runtime";
import { handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeSecret(request, "CRON_SECRET");
  if (!auth.ok) return jsonResponse({ ok: false, code: auth.code, detail: auth.detail }, { status: auth.status, headers: { "Cache-Control": "no-store" } });

  const startedAt = new Date().toISOString(); const { failures, leagues } = await runScheduledWaiver2Capture();
  return jsonResponse({ ok: failures === 0, status: failures ? "PARTIAL" : "OK", started_at: startedAt, finished_at: new Date().toISOString(), shadow_only: true, leagues }, { status: failures ? 500 : 200, headers: { "Cache-Control": "no-store" } });
}

export async function OPTIONS(): Promise<Response> { return handleOptions(); }
