/**
 * GET /api/cron/role-shadow-capture — scheduled PROSPECTIVE Role Shadow capture (W2.P2).
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`. OPT-IN: a complete no-op unless `ROLE_SHADOW_CAPTURE=1` (returns status DISABLED without building a
 * context or touching the database). Read-only toward fantasy platforms; writes only independent, insert-only research rows
 * (`bridge_role_shadow_captures`); never alters a projection, lineup, waiver, matchup, trade or any production decision.
 * `?dry_run=1` builds and counts without writing. Not scheduled in vercel.json by this change: enabling is an explicit deployment step
 * (docs/DECISION_MODEL_CONVERGENCE_W2_P2_GATE_CERTIFICATION.md, section I).
 */
import { authorizeSecret } from "@/lib/http-auth";
import { handleOptions, jsonResponse } from "@/lib/http";
import { runScheduledRoleShadowCapture } from "@/lib/persistence/supabase/role-shadow-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeSecret(request, "CRON_SECRET");
  if (!auth.ok) return jsonResponse({ ok: false, code: auth.code, detail: auth.detail }, { status: auth.status, headers: { "Cache-Control": "no-store" } });
  const dryRun = new URL(request.url).searchParams.get("dry_run") === "1";
  const startedAt = new Date().toISOString();
  const summary = await runScheduledRoleShadowCapture({ dryRun });
  return jsonResponse(
    { ok: summary.status === "OK" || summary.status === "DISABLED", started_at: startedAt, finished_at: new Date().toISOString(), shadow_only: true, ...summary },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
