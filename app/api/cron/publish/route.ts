/**
 * GET /api/cron/publish — scheduled publication of the canonical snapshot.
 *
 * Wired to Vercel Cron (see vercel.json). Vercel sends
 * `Authorization: Bearer $CRON_SECRET` automatically. This is the production
 * mechanism that advances the published pointer without manual intervention, so
 * `freshness.status` stops being `UNKNOWN` once it has run.
 *
 * Distinct from `/api/cron/capture` (historical snapshot + transaction ledger,
 * daily) — this one keeps the LIVE published pointer current. It calls the same
 * `publishLeagueSnapshot` orchestrator `POST /api/refresh` uses, per league,
 * sequentially. `forced: false` — it respects the refresh-policy reuse window so
 * back-to-back runs don't hammer Sleeper.
 *
 * It does NOT change which state path serves reads (still LEGACY_LIVE_PATH).
 *
 * FAILURE VISIBILITY: any per-league failure returns a non-2xx status and logs
 * `[cron:publish]` lines — one league's failure never marks another successful.
 */

import { authorizeSecret } from "@/lib/http-auth";
import { publishLeagueSnapshot } from "@/lib/canonical/publish";
import { resolveRefreshPolicy } from "@/lib/canonical/refresh-policy";
import { listLeagueTargets, leagueConfigStatus } from "@/lib/leagues/registry";
import { handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeSecret(request, "CRON_SECRET");
  if (!auth.ok) {
    return jsonResponse(
      { ok: false, code: auth.code, detail: auth.detail },
      { status: auth.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  const startedAt = new Date().toISOString();
  const targets = listLeagueTargets().filter(
    (t) => t.provider === "sleeper" && leagueConfigStatus(t) === "READY",
  );
  const policy = resolveRefreshPolicy({ forced: false });

  const results = [];
  let anyFailure = false;
  for (const t of targets) {
    const r = await publishLeagueSnapshot(t.key, { trigger: "CRON", forced: false, mode: policy.mode });
    if (!r.ok) anyFailure = true;
    console.log(
      `[cron:publish] ${t.key}: outcome=${r.outcome} advanced=${r.pointer_advanced}` +
        ` seq=${r.prior_pointer_seq ?? "-"}→${r.resulting_pointer_seq ?? "-"}` +
        ` integrity=${r.integrity ?? "-"} source=${r.source_status} ${r.duration_ms}ms` +
        (r.error_category ? ` error=${r.error_category}` : ""),
    );
    results.push({
      league_slug: r.league_slug,
      ok: r.ok,
      outcome: r.outcome,
      pointer_advanced: r.pointer_advanced,
      prior_pointer_seq: r.prior_pointer_seq,
      resulting_pointer_seq: r.resulting_pointer_seq,
      integrity: r.integrity,
      source_status: r.source_status,
      error_category: r.error_category,
      audit_id: r.audit_id,
    });
  }

  return jsonResponse(
    {
      ok: !anyFailure,
      status: anyFailure ? "PARTIAL" : "OK",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      mode: policy.mode,
      published: targets.map((t) => t.key),
      results,
    },
    { status: anyFailure ? 500 : 200, headers: { "Cache-Control": "no-store" } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
