/**
 * GET /api/leagues/:leagueSlug/managers/:managerSlug/orchestrate
 *
 * Phase 8 — Team Management Orchestrator (Scope 2, ADVISORY_ONLY), one manager.
 *
 * "What, if anything, should this manager do right now?" — a HOLD / WATCH /
 * ACTION assessment synthesised from the frozen Phase 1–7 specialists.
 * `?include_trade_search=1` opts into concrete trade discovery for a material
 * depth need (expensive — §14). ADVISORY_ONLY: this endpoint recommends; it
 * NEVER executes a transaction and mutates NO specialist engine.
 */

import { buildManagerOrchestration } from "@/lib/orchestrator";
import { managerContext } from "@/lib/leagues/resolve";
import { resolveManagerRoute } from "@/lib/leagues/api";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leagueSlug: string; managerSlug: string }> },
): Promise<Response> {
  const resolved = await resolveManagerRoute(params);
  if (!resolved.ok) return resolved.response;
  const { manager } = resolved;

  const sp = new URL(request.url).searchParams;
  const flag = (k: string) => ["1", "true", "yes"].includes((sp.get(k) ?? "").toLowerCase());
  const includeTradeSearch = flag("include_trade_search");
  // audit-only trace: which models contributed to this answer (System Trust Audit §14/§37)
  const includeTrace = flag("include_trace");

  try {
    const res = await buildManagerOrchestration(manager.league_slug, manager.manager_slug, { includeTradeSearch, includeTrace });
    if (!res.ok) return errorResponse(res.status, res.code, res.detail);
    return jsonResponse(
      { context: managerContext(manager), deployment: "ADVISORY_ONLY", ...res.result, ...(res.trace ? { trace: res.trace } : {}) },
      {
        headers: {
          "Cache-Control": cacheHeader(30, 120),
          "X-Bridge-Context": `manager:${manager.league_slug}/${manager.manager_slug}`,
          "X-Orchestrator-Version": res.result.orchestrator_version,
          "X-Orchestrator-Deployment": "ADVISORY_ONLY",
        },
      },
    );
  } catch (err) {
    return errorResponse(502, "orchestrator_unavailable", err instanceof Error ? err.message : String(err));
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
