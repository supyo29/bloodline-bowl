/**
 * POST /api/refresh — authenticated, on-demand publication of the canonical
 * snapshot. Stage E.
 *
 *   POST /api/refresh?league=<slug>     refresh one league
 *   POST /api/refresh?scope=all         refresh every READY Sleeper league
 *   Authorization: Bearer <REFRESH_SECRET>   (or X-Refresh-Secret: <secret>)
 *
 * This is the ONLY route that advances the published pointer. It does NOT change
 * which state path serves ordinary reads — that stays LEGACY_LIVE_PATH until
 * Stage F. GET is not allowed (no mutation via GET).
 *
 * Status codes:
 *   200  published | unchanged | pointer race resolved to a valid newer pointer
 *   401  missing / invalid REFRESH_SECRET
 *   404  unknown league
 *   422  candidate failed certification / integrity
 *   503  provider/source unavailable — nothing published, last-known-good intact
 *   207  mixed per-league outcomes on scope=all
 */

import { authorizeSecret } from "@/lib/http-auth";
import { publishLeagueSnapshot } from "@/lib/canonical/publish";
import { resolveRefreshPolicy } from "@/lib/canonical/refresh-policy";
import { listLeagueTargets, leagueConfigStatus } from "@/lib/leagues/registry";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeSecret(request, "REFRESH_SECRET", { header: "x-refresh-secret" });
  if (!auth.ok) {
    return errorResponse(auth.status, auth.code, auth.detail);
  }

  const url = new URL(request.url);
  const scope = url.searchParams.get("scope");
  const leagueParam = url.searchParams.get("league");
  const forced = url.searchParams.get("forced") !== "0"; // default true

  let slugs: string[];
  if (scope === "all") {
    slugs = listLeagueTargets()
      .filter((t) => t.provider === "sleeper" && leagueConfigStatus(t) === "READY")
      .map((t) => t.key);
  } else if (leagueParam) {
    slugs = [leagueParam];
  } else {
    return errorResponse(
      400,
      "missing_target",
      "Specify ?league=<slug> or ?scope=all.",
    );
  }

  const policy = resolveRefreshPolicy({ forced });
  const results = [];
  for (const slug of slugs) {
    // Sequential — no uncontrolled fan-out; one league's failure never marks
    // another successful. Each league is audited independently.
    results.push(await publishLeagueSnapshot(slug, { trigger: "API", forced, mode: policy.mode }));
  }

  const anyFail = results.some((r) => !r.ok);
  const allFail = results.every((r) => !r.ok);
  const status =
    results.length === 1
      ? results[0]!.http_status
      : allFail
        ? Math.max(...results.map((r) => r.http_status))
        : anyFail
          ? 207
          : 200;

  return jsonResponse(
    {
      ok: !anyFail,
      requested: slugs,
      mode: policy.mode,
      results: results.map((r) => ({
        league_slug: r.league_slug,
        ok: r.ok,
        http_status: r.http_status,
        outcome: r.outcome,
        snapshot_id: r.snapshot_id,
        prior_pointer_seq: r.prior_pointer_seq,
        resulting_pointer_seq: r.resulting_pointer_seq,
        pointer_advanced: r.pointer_advanced,
        snapshot_persisted: r.snapshot_persisted,
        integrity: r.integrity,
        validation_detail: r.validation_detail,
        source_status: r.source_status,
        error_category: r.error_category,
        detail: r.detail,
        freshness: r.freshness,
        duration_ms: r.duration_ms,
        audit_id: r.audit_id,
      })),
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** No mutation via GET. */
export async function GET(): Promise<Response> {
  return errorResponse(405, "method_not_allowed", "Use POST with Authorization: Bearer <REFRESH_SECRET>.");
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
