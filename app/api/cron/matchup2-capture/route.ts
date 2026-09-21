/**
 * GET /api/cron/matchup2-capture — scheduled PROSPECTIVE shadow capture for Matchup Intelligence 2.0 (Phase 5).
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` (sent automatically by Vercel Cron). Read-only toward fantasy platforms; SHADOW ONLY.
 * The capture CLASS is derived from evidence (own game verifiably pre-game + a server-derived production baseline ⇒ LIVE_CAPTURED; otherwise
 * LIVE_POST_LOCK / LIVE_UNVERIFIED). Being invoked by cron is provenance, never eligibility. A public request cannot create a record: this is the
 * only writer and it requires the secret.
 */
import { authorizeSecret } from "@/lib/http-auth";
import { runScheduledMatchup2Capture } from "@/lib/persistence/supabase/matchup2-capture";
import { handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeSecret(request, "CRON_SECRET");
  if (!auth.ok) return jsonResponse({ ok: false, code: auth.code, detail: auth.detail }, { status: auth.status, headers: { "Cache-Control": "no-store" } });
  const startedAt = new Date().toISOString(); const s = await runScheduledMatchup2Capture();
  return jsonResponse({ ok: s.failures === 0, status: s.failures ? "PARTIAL" : "OK", started_at: startedAt, finished_at: new Date().toISOString(), shadow_only: true, by_class: s.by_class, by_status: s.by_status, leagues: s.leagues }, { status: s.failures ? 500 : 200, headers: { "Cache-Control": "no-store" } });
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
