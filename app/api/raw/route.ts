/**
 * GET /api/raw?resource=<name>[&draft_id=<id>] — untouched Sleeper payloads.
 *
 * Debugging aid for comparing normalized output against the source. This is NOT
 * an open proxy: `resource` is matched against a fixed allowlist and any
 * `draft_id` must be numeric, so no caller-supplied URL ever reaches Sleeper.
 * The full player database is intentionally not exposed here.
 */

import { SleeperError, fetchSleeper } from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { parseLeagueSelector } from "@/lib/analytics/query";
import {
  cacheHeader,
  errorResponse,
  handleOptions,
  jsonResponse,
} from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Allowlisted resources, each a template over the fixed league id. */
const LEAGUE_RESOURCES = {
  league: (leagueId: string) => `/league/${leagueId}`,
  users: (leagueId: string) => `/league/${leagueId}/users`,
  rosters: (leagueId: string) => `/league/${leagueId}/rosters`,
  drafts: (leagueId: string) => `/league/${leagueId}/drafts`,
  traded_picks: (leagueId: string) => `/league/${leagueId}/traded_picks`,
  state: () => `/state/nfl`,
} as const;

const ALLOWED_RESOURCES = [
  "league",
  "users",
  "rosters",
  "drafts",
  "traded_picks",
  "state",
  "draft_picks",
] as const;

type AllowedResource = (typeof ALLOWED_RESOURCES)[number];

function isAllowedResource(value: string): value is AllowedResource {
  return (ALLOWED_RESOURCES as readonly string[]).includes(value);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource");

  if (!resource) {
    return errorResponse(
      400,
      "missing_parameter",
      `Provide ?resource= one of: ${ALLOWED_RESOURCES.join(", ")}`,
    );
  }

  if (!isAllowedResource(resource)) {
    return errorResponse(
      400,
      "invalid_resource",
      `Unknown resource "${resource}". Allowed: ${ALLOWED_RESOURCES.join(", ")}`,
    );
  }

  const leagueSelectorResult = parseLeagueSelector(
    url.searchParams.get("league"),
  );
  if ("error" in leagueSelectorResult) {
    return errorResponse(
      400,
      "invalid_query_parameter",
      leagueSelectorResult.error,
    );
  }
  const leagueId = resolveLeagueId(leagueSelectorResult.value);
  let path: string;

  if (resource === "draft_picks") {
    const draftId = url.searchParams.get("draft_id");
    // Sleeper ids are numeric strings; reject anything else outright.
    if (!draftId || !/^\d{1,25}$/.test(draftId)) {
      return errorResponse(
        400,
        "invalid_draft_id",
        "draft_picks requires a numeric &draft_id= parameter.",
      );
    }
    path = `/draft/${draftId}/picks`;
  } else {
    path = LEAGUE_RESOURCES[resource](leagueId);
  }

  try {
    const data = await fetchSleeper<unknown>(path);
    return jsonResponse(
      { resource, path, fetched_at: new Date().toISOString(), data },
      { headers: { "Cache-Control": cacheHeader(300, 900) } },
    );
  } catch (error) {
    if (error instanceof SleeperError) {
      return errorResponse(
        error.status === 404 ? 404 : 502,
        "sleeper_upstream_error",
        error.message,
      );
    }
    return errorResponse(
      500,
      "internal_error",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
