/**
 * GET /api/health — liveness probe.
 *
 *   (bare)     cheap; no upstream calls. Player-cache + registry only.
 *   ?draft=1   also reports the active draft id/status (two small cached calls).
 *   ?deep=1    operational trust surface (Stage D): per-league published-pointer
 *              state, source connectivity, snapshot integrity + capability
 *              health, cross-surface discrepancy count, unresolved material
 *              identities, feature-flag state. READ-ONLY — never refreshes,
 *              never builds a published candidate, never advances the pointer.
 */

import {
  SleeperError,
  getLeagueDrafts,
  getPlayerCacheStatus,
} from "@/lib/sleeper/client";
import { selectActiveDraft } from "@/lib/sleeper/draft";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { listLeagueTargets, leagueConfigStatus } from "@/lib/leagues/registry";
import { parseLeagueSelector } from "@/lib/analytics/query";
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { reconcilePublishCandidate } from "@/lib/canonical/reconcile";
import { buildFreshnessEnvelope, compactCapabilities } from "@/lib/canonical/freshness-envelope";
import { publishedSnapshotEnabled } from "@/lib/canonical/published-flag";
import { getProvider } from "@/lib/providers/registry";
import { getPersistence } from "@/lib/persistence";
import { CANONICAL_SCHEMA_VERSION } from "@/lib/canonical/schema";
import { emitBridgeEvent } from "@/lib/observability/events";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;

  const leagueSelectorResult = parseLeagueSelector(searchParams.get("league"));
  if ("error" in leagueSelectorResult) {
    return errorResponse(400, "invalid_query_parameter", leagueSelectorResult.error);
  }
  const leagueId = resolveLeagueId(leagueSelectorResult.value);
  const wantsDraft = searchParams.get("draft") === "1";
  const wantsDeep = searchParams.get("deep") === "1";

  const base = {
    ok: true,
    service: "bloodline-bowl-sleeper-bridge",
    league_id: leagueId,
    timestamp: new Date().toISOString(),
    player_cache: getPlayerCacheStatus(),
    available_leagues: listLeagueTargets().map((target) => ({
      key: target.key,
      display_name: target.display_name,
      league_id: target.league_id,
    })),
  };

  if (wantsDeep) {
    return jsonResponse(await deepHealth(base), { headers: { "Cache-Control": "no-store" } });
  }

  if (!wantsDraft) {
    return jsonResponse(base, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const drafts = await getLeagueDrafts(leagueId);
    const active = selectActiveDraft(drafts);
    return jsonResponse(
      {
        ...base,
        sleeper: true,
        active_draft_id: active?.draft_id ?? null,
        draft_status: active?.status ?? null,
        draft_type: active?.type ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return jsonResponse(
      {
        ...base,
        sleeper: false,
        active_draft_id: null,
        draft_status: null,
        draft_type: null,
        sleeper_error:
          error instanceof SleeperError || error instanceof Error ? error.message : "Unknown error",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

async function deepHealth(base: Record<string, unknown>): Promise<Record<string, unknown>> {
  const now = Date.now();
  const persistence = getPersistence();

  const [sleeperHealth, historyStatus, pointerStatus] = await Promise.all([
    getProvider("sleeper").healthCheck().catch((e) => ({
      provider: "sleeper" as const,
      status: "PROVIDER_ERROR" as const,
      detail: e instanceof Error ? e.message : String(e),
    })),
    persistence.status().catch(() => "PERSISTENCE_ERROR" as const),
    persistence.published.status().catch(() => "PERSISTENCE_ERROR" as const),
  ]);

  const targets = listLeagueTargets().filter(
    (t) => t.provider === "sleeper" && leagueConfigStatus(t) === "READY",
  );

  const leagues = await Promise.all(
    targets.map(async (t) => {
      try {
        const state = await buildCanonicalLeagueState(t.key, {
          includeMatchups: true,
          includeRecentTransactions: true,
          reportPersistence: false,
        });
        const snap = state.snapshot;
        const pointer = await persistence.published.get(t.key, t.season ?? snap?.season ?? 0).catch(() => null);

        if (!snap) {
          return {
            league_slug: t.key,
            reachable: false,
            detail: state.detail ?? "no snapshot",
            published_snapshot: { present: !!pointer, snapshot_id: pointer?.league_snapshot_id ?? null },
          };
        }

        const rec = reconcilePublishCandidate(snap);
        const env = buildFreshnessEnvelope({
          servedSnapshot: snap,
          stateSource: "LEGACY_LIVE_PATH",
          pointer,
          now,
        });

        return {
          league_slug: t.key,
          reachable: true,
          week: snap.week,
          live_provider_status: snap.live_provider_status,
          response_state_lineage: env.response_state_lineage,
          freshness: env.freshness,
          published_snapshot: env.published_snapshot,
          snapshot_integrity: rec.capabilities.snapshot_integrity,
          integrity_failures: rec.capabilities.integrity_failures,
          cross_surface_discrepancy_count: rec.discrepancies.length,
          structural_problem_count: rec.structural.length,
          material_unresolved_count: rec.capabilities.material_unresolved.length,
          benign_unresolved_count: rec.capabilities.benign_unresolved_count,
          unresolved_categories: rec.capabilities.unresolved_categories,
          capabilities: compactCapabilities(rec.capabilities.capabilities),
          last_successful_publication: pointer?.published_at ?? null,
          last_failed_publication: null, // not persisted yet — Stage E
          warnings: snap.warnings.map((w) => w.code),
        };
      } catch (e) {
        return {
          league_slug: t.key,
          reachable: false,
          detail: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );

  emitBridgeEvent("deep_health_checked", {
    leagues: leagues.length,
    sleeper: sleeperHealth.status,
    pointer_store: pointerStatus,
    flag_on: publishedSnapshotEnabled(),
  });

  const anyDegraded =
    sleeperHealth.status !== "READY" ||
    leagues.some(
      (l) => !l.reachable || (l as { snapshot_integrity?: string }).snapshot_integrity === "REJECTED",
    );

  return {
    ...base,
    ok: !anyDegraded,
    deep: true,
    schema: { canonical_schema_version: CANONICAL_SCHEMA_VERSION },
    feature_flags: {
      BRIDGE_PUBLISHED_SNAPSHOT: publishedSnapshotEnabled(),
      note: "OFF ⇒ every route serves state from the legacy live path; the published pointer is inspection-only",
    },
    source_connectivity: sleeperHealth,
    persistence: { history_stores: historyStatus, published_pointer_store: pointerStatus },
    leagues,
    can_i_trust_the_bridge: anyDegraded
      ? "PARTIAL — see per-league integrity / source_connectivity"
      : "YES — all active leagues certified, source reachable",
  };
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
