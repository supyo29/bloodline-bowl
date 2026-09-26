/**
 * GET /api/cron/projection-snapshot — Phase 5 canonical projection refresh.
 *
 * Refreshes one normalized league-scored projection artifact per configured
 * Sleeper league. The raw Sleeper feeds are still process-deduplicated by the
 * Phase 2 cache, so multiple leagues can be rescored without redownloading the
 * multi-MB source for each league.
 *
 * The cron forces LIVE projection evaluation and advances the durable Supabase
 * pointer. Regular requests prefer that pointer and only fall back live when it
 * is missing/stale/unavailable.
 */

import { authorizeSecret } from "@/lib/http-auth";
import { handleOptions, jsonResponse } from "@/lib/http";
import { listLeagueTargets, leagueConfigStatus } from "@/lib/leagues/registry";
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { buildWeeklyTeamContext } from "@/lib/weekly/context";

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
  const leagues: Array<Record<string, unknown>> = [];
  let failures = 0;

  for (const target of listLeagueTargets().filter(
    (t) => t.provider === "sleeper" && leagueConfigStatus(t) === "READY",
  )) {
    try {
      const state = await buildCanonicalLeagueState(target.key, {
        reportPersistence: false,
      });
      const snap = state.snapshot;
      const manager = snap?.managers[0] ?? null;
      if (!snap || !manager) {
        failures += 1;
        leagues.push({
          league_slug: target.key,
          ok: false,
          code: "projection_snapshot_no_manager_context",
        });
        continue;
      }

      const built = await buildWeeklyTeamContext(target.key, manager.manager_slug, {
        snapshotOverride: snap,
        projectionSnapshotPolicy: "refresh",
        enableMarketStatePool: false,
      });
      const projection = built.context?.projections ?? null;
      const persisted = projection?.canonical_snapshot ?? null;
      const ok =
        Boolean(built.context) &&
        projection?.status !== "PROJECTIONS_UNAVAILABLE" &&
        persisted?.durable === true;

      if (!ok) failures += 1;
      leagues.push({
        league_slug: target.key,
        ok,
        week: snap.week,
        projection_status: projection?.status ?? null,
        artifact_id: persisted?.artifact_id ?? null,
        observed_at: persisted?.observed_at ?? null,
        durable: persisted?.durable ?? false,
        read_path: persisted?.read_path ?? null,
      });
    } catch (error) {
      failures += 1;
      leagues.push({
        league_slug: target.key,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return jsonResponse(
    {
      ok: failures === 0,
      status: failures === 0 ? "OK" : "PARTIAL",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      failures,
      leagues,
    },
    {
      status: failures === 0 ? 200 : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
