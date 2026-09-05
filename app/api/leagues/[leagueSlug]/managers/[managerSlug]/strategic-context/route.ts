/**
 * GET /api/leagues/:leagueSlug/managers/:managerSlug/strategic-context
 *
 * Trade Engine — Phase 6 (`ri-trade-strategy-2026.2`): standalone read of one
 * manager's season-state strategic profile (season stage, standings, playoff
 * status/odds, strategic archetype, urgency, preferred time horizons) — the
 * SAME `ManagerStrategicProfile` that `POST /api/trades/{discover,negotiate}`
 * attach to their results when `include_strategic: true`.
 *
 * Read-only, stateless — one canonical league-state read
 * (`buildTradeAnalysisContext`), no mutation, no persistence.
 */

import { resolveManagerRoute } from "@/lib/leagues/api";
import { resolveManager } from "@/lib/canonical/manager-context";
import { buildTradeAnalysisContext } from "@/lib/trades/context";
import { buildManagerStrategicProfile } from "@/lib/trades/strategy/profile";
import { TRADE_STRATEGY_VERSION } from "@/lib/trades/strategy/config";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ leagueSlug: string; managerSlug: string }> },
): Promise<Response> {
  const resolved = await resolveManagerRoute(params);
  if (!resolved.ok) return resolved.response;
  const { manager } = resolved;

  const ctxResult = await buildTradeAnalysisContext(manager.league_slug);
  if (!ctxResult.context) {
    return errorResponse(
      ctxResult.status,
      ctxResult.code ?? "league_state_unavailable",
      ctxResult.detail ?? `Trade-analysis context for "${manager.league_slug}" is unavailable.`,
    );
  }
  const ctx = ctxResult.context;

  const canonicalManager = resolveManager(ctx.snapshot.managers, manager.manager_slug);
  if (!canonicalManager) {
    return errorResponse(404, "unknown_manager", `Manager "${manager.manager_slug}" was not found in league "${manager.league_slug}"'s canonical snapshot.`);
  }

  let profile;
  try {
    profile = buildManagerStrategicProfile(ctx, canonicalManager.canonical_manager_id, canonicalManager.manager_slug);
  } catch (error) {
    return errorResponse(500, "strategic_context_error", error instanceof Error ? error.message : "Unknown error building strategic context.");
  }

  return jsonResponse(
    {
      status: "OK",
      league_slug: manager.league_slug,
      manager_slug: manager.manager_slug,
      strategy_version: TRADE_STRATEGY_VERSION,
      season_stage: profile.season.season_stage,
      manager: profile,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
