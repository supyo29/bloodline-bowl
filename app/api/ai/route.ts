/**
 * GET /api/ai — the universal AI-assistant discovery endpoint.
 *
 * "One link to rule them all." A completely fresh model can fetch this single
 * URL and learn: what the service is, which leagues exist and their provider /
 * readiness, which known managers belong to which league, the canonical routing
 * hierarchy, every read-only analysis capability with a concrete route
 * template, and which routes are canonical vs. legacy.
 *
 * Pure + deterministic — no network calls, no secrets. Safe to cache hard.
 */

import {
  CAPABILITIES,
  GITHUB_REPOSITORY,
  IDENTITY_MODEL,
  LEGACY_ROUTES,
  PRODUCTION_BASE_URL,
  SERVICE_DESCRIPTION,
  absoluteUrl,
  discoveryLeagues,
  discoveryManagers,
} from "@/lib/discovery";
import { cacheHeader, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const leagues = discoveryLeagues();
  const managers = discoveryManagers();

  const body = {
    service: SERVICE_DESCRIPTION,
    identity_model: IDENTITY_MODEL,
    start_here: {
      ai_discovery: "/api/ai",
      league_discovery: "/api/leagues",
      manager_discovery_template: "/api/leagues/{leagueSlug}/managers",
      league_overview_template: "/api/leagues/{leagueSlug}",
      manager_home_template: "/api/leagues/{leagueSlug}/managers/{managerSlug}",
      traversal: [
        "/api/ai",
        "/api/leagues",
        "/api/leagues/{leagueSlug}",
        "/api/leagues/{leagueSlug}/managers",
        "/api/leagues/{leagueSlug}/managers/{managerSlug}",
        "→ any capability route template below",
      ],
    },
    leagues,
    registered_managers: managers,
    capabilities: CAPABILITIES.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      scope: c.scope,
      temporality: c.temporality,
      canonical: c.canonical,
      route_template: c.route_template,
      absolute_route_template: absoluteUrl(c.route_template),
      ...(c.query_params ? { query_params: c.query_params } : {}),
    })),
    route_templates: {
      canonical: Object.fromEntries(
        CAPABILITIES.map((c) => [c.id, c.route_template]),
      ),
      note:
        "Substitute {leagueSlug} and {managerSlug} with values from `leagues` / `registered_managers`. " +
        "Substitute {week} with the current NFL week from /api/league/{leagueSlug}/state (state.current_week). " +
        "Scope 'manager-week' routes use the /api/{capability}/{leagueSlug}/{managerSlug}/week/{week} shape, " +
        "NOT the /api/leagues/... prefix.",
    },
    legacy_routes: {
      note:
        "`?league=` query-form routes remain supported for existing clients. Prefer the canonical path routes above. " +
        "A few historical-analysis capabilities are currently only available in this legacy form (canonical_equivalent: null).",
      routes: LEGACY_ROUTES,
    },
    methodology: {
      note: "Optional. For inspecting how the numbers are produced. Not required to use the bridge.",
      github_repository: GITHUB_REPOSITORY,
      docs: [
        `${GITHUB_REPOSITORY}/blob/main/README.md`,
        `${GITHUB_REPOSITORY}/blob/main/docs/POST_DRAFT_FOUNDATION.md`,
      ],
      llms_txt: "/llms.txt",
    },
    meta: {
      generated_at: new Date().toISOString(),
      production_base_url: PRODUCTION_BASE_URL,
      read_only: true,
      contains_secrets: false,
    },
  };

  return jsonResponse(body, {
    headers: {
      "Cache-Control": cacheHeader(300, 900),
      "X-Bridge-Context": "ai-discovery",
    },
  });
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
