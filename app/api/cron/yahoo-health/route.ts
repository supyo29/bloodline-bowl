/**
 * GET /api/cron/yahoo-health — low-frequency Yahoo authentication keep-alive (read-only against Yahoo).
 *
 * For each registered connection: refresh ONLY if the access token is within the wide health window of expiry (never unconditionally, never
 * twice: the same single-flight + CAS rotation path as every request), then ONE authenticated read-only Fantasy probe, so a dead credential is found
 * before a waiver request needs it. No league data is mutated and nothing is written to Yahoo. Failures are per connection and visible.
 * Auth: `Authorization: Bearer $CRON_SECRET`.
 */
import { authorizeSecret } from "@/lib/http-auth";
import { runYahooHealthJob } from "@/lib/providers/yahoo/health-job";
import { handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeSecret(request, "CRON_SECRET");
  if (!auth.ok) return jsonResponse({ ok: false, code: auth.code, detail: auth.detail }, { status: auth.status, headers: { "Cache-Control": "no-store" } });
  const startedAt = new Date().toISOString(); const results = await runYahooHealthJob();
  const failed = results.filter((r) => !r.ok).length;
  return jsonResponse({ ok: failed === 0, status: failed ? "PARTIAL" : "OK", started_at: startedAt, finished_at: new Date().toISOString(), connections: results }, { status: failed ? 500 : 200, headers: { "Cache-Control": "no-store" } });
}
export async function OPTIONS(): Promise<Response> { return handleOptions(); }
