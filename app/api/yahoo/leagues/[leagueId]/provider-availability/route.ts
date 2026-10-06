/**
 * GET /api/yahoo/leagues/{leagueId}/provider-availability
 *
 * Read-only view of what the CANONICAL Yahoo provider (`YahooProvider`) reports:
 * its capabilities, and the result of `getWaiverState` (summary counts by
 * ownership, optionally filtered rows) — so provider-level behavior can be
 * compared against `/players/available`, which reads the same shared module.
 *
 *   view=capabilities            provider capability flags only (no Yahoo calls)
 *   view=waiver-state (default)  getWaiverState summary; add `player_id=1,2` to
 *                                include those rows, `rows=true` for every row
 *                                (large: ~1,000+ rows)
 *   view=available               getAvailablePlayers (FA/W/available/rostered with
 *                                status/position/search/start/count/all as on
 *                                /players/available)
 */

import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { findLeagueTarget } from "@/lib/leagues/registry";
import { defaultCrosswalkSource } from "@/lib/persistence/supabase/crosswalk-source";
import { YahooProvider } from "@/lib/providers/yahoo/provider";
import type { ProviderLeagueContext } from "@/lib/providers/types";
import type { YahooPoolSelector } from "@/lib/providers/yahoo/players";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };
const SELECTORS: Record<string, YahooPoolSelector> = { available: "available", fa: "FA", w: "W", waivers: "W", rostered: "rostered", t: "rostered" };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  const { leagueId: raw } = await params;
  const target = findLeagueTarget(raw) ?? findLeagueTarget(raw.toLowerCase());
  if (!target || target.provider !== "yahoo") {
    return errorResponse(404, "yahoo_league_not_registered", `"${raw}" is not a registered Yahoo league slug.`);
  }
  const sp = new URL(request.url).searchParams;
  const view = sp.get("view") ?? "waiver-state";
  const provider = new YahooProvider({ connectionId: target.yahoo_connection_id ?? undefined });

  if (view === "capabilities") {
    return jsonResponse({ ok: true, league: target.key, provider: provider.name, capabilities: provider.capabilities() }, { headers: NO_STORE });
  }

  const ctx: ProviderLeagueContext = {
    league_slug: target.key,
    external_league_id: target.external_league_id,
    season: target.season,
    crosswalk: new PlayerCrosswalk(defaultCrosswalkSource() ?? NoCrosswalk),
  };
  const base = { ok: true, league: target.key, capabilities: provider.capabilities() };

  if (view === "available") {
    const status = SELECTORS[(sp.get("status") ?? "available").toLowerCase()];
    if (!status) return errorResponse(400, "invalid_status", "status must be one of: available, FA, W, rostered.");
    const res = await provider.getAvailablePlayers(ctx, {
      status,
      position: sp.get("position"),
      search: sp.get("search"),
      start: Number(sp.get("start") ?? 0) || 0,
      count: Math.min(500, Number(sp.get("count") ?? 25) || 25),
      all: ["true", "1"].includes((sp.get("all") ?? "").toLowerCase()),
    });
    return jsonResponse({ ...base, view, provider_status: res.status, warnings: res.warnings, result: res.data }, { status: res.data ? 200 : 502, headers: NO_STORE });
  }

  if (view !== "waiver-state") return errorResponse(400, "invalid_view", "view must be capabilities, waiver-state or available.");

  const res = await provider.getWaiverState(ctx);
  if (!res.data) return jsonResponse({ ...base, view, provider_status: res.status, warnings: res.warnings }, { status: 502, headers: NO_STORE });
  const rows = res.data.players;
  const ids = new Set((sp.get("player_id") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const counts: Record<string, number> = {};
  for (const p of rows) counts[p.ownership] = (counts[p.ownership] ?? 0) + 1;
  const includeAll = sp.get("rows") === "true";
  return jsonResponse(
    {
      ...base,
      view,
      provider_status: res.status,
      warnings: res.warnings,
      canonical_league_id: res.data.canonical_league_id,
      total: rows.length,
      counts_by_ownership: counts,
      waiver_clear_dates: [...new Set(rows.map((p) => p.waiver_clears_at).filter(Boolean))],
      players: includeAll ? rows : rows.filter((p) => p.provider_player_id && ids.has(p.provider_player_id)),
      generated_at: res.provider_synced_at,
    },
    { headers: NO_STORE },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
