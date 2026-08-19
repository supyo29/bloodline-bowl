/**
 * GET /api/value — player values from named, timestamped sources. Never a
 * fabricated universal value, never an unlabeled consensus average.
 *
 * Query: ?player_id=<id> or ?roster_id=<n>. Omit both to just report provider
 * availability with no player list.
 */

import { SleeperError, getLeagueRosters, getPlayerIndex } from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { buildValueFacts } from "@/lib/analytics/value";
import { getValueProvider } from "@/lib/values/provider";
import { buildMetadata } from "@/lib/analytics/types";
import { parsePlayerId, parseRosterId } from "@/lib/analytics/query";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const leagueId = resolveLeagueId();
  const params = new URL(request.url).searchParams;

  try {
    const playerIdResult = parsePlayerId(params.get("player_id"));
    if ("error" in playerIdResult) {
      return errorResponse(400, "invalid_query_parameter", playerIdResult.error);
    }
    const rosterIdResult = parseRosterId(params.get("roster_id"));
    if ("error" in rosterIdResult) {
      return errorResponse(400, "invalid_query_parameter", rosterIdResult.error);
    }

    let playerIds: string[] = [];
    if (playerIdResult.value !== null) {
      playerIds = [playerIdResult.value];
    } else if (rosterIdResult.value !== null) {
      const rosters = await getLeagueRosters(leagueId);
      const roster = rosters.find((r) => r.roster_id === rosterIdResult.value);
      if (!roster) {
        return errorResponse(
          404,
          "roster_not_found",
          `No roster with id ${rosterIdResult.value} exists in this league.`,
        );
      }
      playerIds = (roster.players ?? []).filter((id) => id !== "0");
    }

    const playerIndex = await getPlayerIndex();
    const { players, provider_available, warnings } = await buildValueFacts(
      playerIds,
      playerIndex,
    );
    const provider = getValueProvider();

    const metadata = buildMetadata({
      league_id: leagueId,
      sources: [{ name: provider.name, type: "player_value", updated_at: null }],
      data_freshness: {},
      warnings,
    });

    return jsonResponse(
      {
        provider: {
          name: provider.name,
          available: provider_available,
          unavailable_reason: provider.unavailableReason(),
        },
        players,
        metadata,
      },
      { headers: { "Cache-Control": cacheHeader(3600, 21600) } },
    );
  } catch (error) {
    if (error instanceof SleeperError) {
      return errorResponse(502, "sleeper_upstream_error", error.message);
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
