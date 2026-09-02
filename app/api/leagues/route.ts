/**
 * GET /api/leagues — AI-friendly discovery.
 *
 * Lists every configured league with its canonical slug, Sleeper id, and the
 * canonical resource + manager URLs. This is the entry point an AI client
 * should read first to learn the permanent routes — no query-string
 * construction required.
 *
 * Exposes routing metadata only. No secrets, tokens, or private account data.
 */

import { leagueConfigStatus, listLeagueTargets } from "@/lib/leagues/registry";
import { cacheHeader, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const leagues = listLeagueTargets().map((target) => {
    const base = `/api/leagues/${target.key}`;
    return {
      league_slug: target.key,
      league_name: target.display_name,
      league_id: target.league_id,
      provider: target.provider,
      season: target.season,
      config_status: leagueConfigStatus(target),
      known_managers: target.known_managers,
      commissioner_sleeper_username: target.sleeper_username,
      canonical_urls: {
        state: `/api/league/${target.key}/state`,
        context_template: `/api/context/${target.key}/{managerSlug}`,
        history_template: `/api/history/${target.key}/week/{week}`,
        transactions: `/api/transactions/${target.key}`,
        // Legacy Sleeper-native routes (Sleeper leagues only):
        league: base,
        draft: `${base}/draft`,
        snapshot: `${base}/snapshot`,
        scoring: `${base}/scoring`,
        managers: `${base}/managers`,
      },
      manager_route_template: `${base}/managers/{managerSlug}`,
      manager_route_note:
        `GET ${base}/managers for every manager in this league with their canonical slug, ` +
        `roster id, and draft slot (verified live). Membership is validated per request — a ` +
        `manager who is not in this league returns 404, never a fallback.`,
    };
  });

  return jsonResponse(
    {
      generated_at: new Date().toISOString(),
      identity_model: {
        note: "league identity != manager identity. Use a manager-specific route for personalized (roster / draft slot / recommendation) data.",
        league_route: "/api/leagues/{leagueSlug}",
        manager_route: "/api/leagues/{leagueSlug}/managers/{managerSlug}",
        legacy_query_form_still_supported: "/api/draft?league={leagueSlug}",
      },
      leagues,
    },
    { headers: { "Cache-Control": cacheHeader(300, 900) } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
