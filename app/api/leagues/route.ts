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
import { loadYahooConfig } from "@/lib/providers/yahoo/config";
import { cacheHeader, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  // Cheap env-only read (no network) — enough to distinguish "Yahoo has no
  // credentials configured" from "configured, live accessibility unknown from
  // a static read" (see `leagueConfigStatus`). A live per-league probe is
  // `/api/providers`'s job, not this route's.
  const yahooOAuthConfigured = loadYahooConfig().configured;
  const leagues = listLeagueTargets().map((target) => {
    const base = `/api/leagues/${target.key}`;
    const isSleeper = target.provider === "sleeper";
    return {
      league_slug: target.key,
      league_name: target.display_name,
      league_id: target.league_id,
      provider: target.provider,
      season: target.season,
      config_status: leagueConfigStatus(target, { yahooOAuthConfigured }),
      known_managers: target.known_managers,
      commissioner_sleeper_username: target.sleeper_username,
      // Provider-independent — every provider serves these from the shared
      // canonical layer.
      canonical_urls: {
        state: `/api/league/${target.key}/state`,
        context_template: `/api/context/${target.key}/{managerSlug}`,
        history_template: `/api/history/${target.key}/week/{week}`,
        transactions: `/api/transactions/${target.key}`,
      },
      // Sleeper-specific legacy surface (`/api/leagues/{slug}/*`) — imports
      // `lib/sleeper/*` directly and is NOT provider-independent. `null` for a
      // non-Sleeper league: those requests fail closed with
      // `sleeper_only_route` rather than misrouting a foreign provider id into
      // a Sleeper API call. Use `canonical_urls` for any non-Sleeper league.
      sleeper_only_urls: isSleeper
        ? {
            league: base,
            draft: `${base}/draft`,
            snapshot: `${base}/snapshot`,
            scoring: `${base}/scoring`,
            managers: `${base}/managers`,
          }
        : null,
      manager_route_template: isSleeper ? `${base}/managers/{managerSlug}` : null,
      manager_route_note: isSleeper
        ? `GET ${base}/managers for every manager in this league with their canonical slug, ` +
          `roster id, and draft slot (verified live). Membership is validated per request — a ` +
          `manager who is not in this league returns 404, never a fallback.`
        : `"${target.key}" is served by ${target.provider}, not Sleeper — the /api/leagues/{slug}/managers ` +
          `surface is Sleeper-only. Manager identity for this league comes from the canonical state route: ` +
          `/api/league/${target.key}/state (managers[]), and personalized data from ` +
          `/api/context/${target.key}/{managerSlug}.`,
    };
  });

  return jsonResponse(
    {
      generated_at: new Date().toISOString(),
      ai_discovery: "/api/ai",
      ai_discovery_note:
        "Fresh AI assistants should start at /api/ai for the full service map (capabilities, route templates, known managers).",
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
