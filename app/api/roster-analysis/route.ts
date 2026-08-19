/**
 * GET /api/roster-analysis — deterministic structural facts about one or all
 * rosters: composition, age, FLEX/SUPER_FLEX-aware slot coverage, auction
 * spend, and draft-pick ownership. No roster grade of any kind.
 *
 * Query: ?season=2026 ?roster_id=3
 */

import {
  SleeperError,
  getDraftPicks,
  getLeague,
  getLeagueDrafts,
  getLeagueRosters,
  getLeagueTradedPicks,
  getLeagueUsers,
  getNflState,
  getPlayerIndex,
  slimPlayer,
  type PlayerIndex,
} from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { buildDraftCapital } from "@/lib/sleeper/normalize";
import { parsePickPrice, selectActiveDraft } from "@/lib/sleeper/draft";
import {
  buildAgeFacts,
  buildAuctionSpendFacts,
  buildRosterComposition,
  buildSlotCoverage,
} from "@/lib/analytics/roster";
import { buildMetadata } from "@/lib/analytics/types";
import { parseRosterId, parseSeason } from "@/lib/analytics/query";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";
import type { NormalizedPlayer, RawRoster } from "@/lib/sleeper/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function resolveIds(ids: string[] | null | undefined, index: PlayerIndex): NormalizedPlayer[] {
  return (ids ?? [])
    .filter((id) => id !== "0")
    .map((id) => index.get(id) ?? slimPlayer(id, undefined));
}

export async function GET(request: Request): Promise<Response> {
  const leagueId = resolveLeagueId();
  const params = new URL(request.url).searchParams;

  try {
    const league = await getLeague(leagueId);
    const nflState = await getNflState().catch(() => null);
    const currentSeason = nflState?.season ?? league.season;

    const seasonResult = parseSeason(params.get("season"), currentSeason);
    if ("error" in seasonResult) {
      return errorResponse(400, "invalid_query_parameter", seasonResult.error);
    }
    if (seasonResult.value !== currentSeason) {
      return errorResponse(
        400,
        "unsupported_season",
        "roster-analysis only supports the current season's live rosters.",
      );
    }
    const rosterIdResult = parseRosterId(params.get("roster_id"));
    if ("error" in rosterIdResult) {
      return errorResponse(400, "invalid_query_parameter", rosterIdResult.error);
    }

    const [rosters, users, drafts, tradedPicks, playerIndex] = await Promise.all([
      getLeagueRosters(leagueId),
      getLeagueUsers(leagueId),
      getLeagueDrafts(leagueId),
      getLeagueTradedPicks(leagueId),
      getPlayerIndex(),
    ]);

    let targetRosters: RawRoster[] = rosters;
    if (rosterIdResult.value !== null) {
      targetRosters = rosters.filter((r) => r.roster_id === rosterIdResult.value);
      if (targetRosters.length === 0) {
        return errorResponse(
          404,
          "roster_not_found",
          `No roster with id ${rosterIdResult.value} exists in this league.`,
        );
      }
    }

    const warnings: string[] = [];
    const draft = selectActiveDraft(drafts);
    const pricesByRoster = new Map<number, Map<string, number>>();
    let startingBudget: number | null = null;

    if (draft) {
      startingBudget = draft.type === "auction" ? (draft.settings?.budget ?? null) : null;
      try {
        const picks = await getDraftPicks(draft.draft_id);
        for (const pick of picks) {
          const rosterId =
            typeof pick.roster_id === "number"
              ? pick.roster_id
              : typeof pick.roster_id === "string"
                ? Number.parseInt(pick.roster_id, 10)
                : null;
          const price = parsePickPrice(pick);
          if (rosterId === null || !pick.player_id || price === null) continue;
          const bucket = pricesByRoster.get(rosterId) ?? new Map<string, number>();
          bucket.set(pick.player_id, price);
          pricesByRoster.set(rosterId, bucket);
        }
      } catch (error) {
        warnings.push(
          `Could not load draft picks for acquisition pricing: ${
            error instanceof SleeperError || error instanceof Error
              ? error.message
              : String(error)
          }`,
        );
      }
    } else {
      warnings.push("This league has no draft, so acquisition price and budget spend are unavailable.");
    }

    const draftCapital = buildDraftCapital(rosters, drafts, tradedPicks, league, nflState);
    const usersById = new Map(users.map((u) => [u.user_id, u]));
    const rosterPositions = league.roster_positions ?? [];
    const totalRosterSlots = rosterPositions.length;

    const rosterAnalyses = targetRosters
      .map((roster) => {
        const allPlayers = resolveIds(roster.players, playerIndex);
        const starterIds = new Set((roster.starters ?? []).filter((id) => id !== "0"));
        const taxiIds = new Set(roster.taxi ?? []);
        const reserveIds = new Set(roster.reserve ?? []);

        const starters = allPlayers.filter((p) => starterIds.has(p.player_id));
        const taxi = allPlayers.filter((p) => taxiIds.has(p.player_id));
        const reserve = allPlayers.filter((p) => reserveIds.has(p.player_id));
        const bench = allPlayers.filter(
          (p) =>
            !starterIds.has(p.player_id) &&
            !taxiIds.has(p.player_id) &&
            !reserveIds.has(p.player_id),
        );

        const priceByPlayer = pricesByRoster.get(roster.roster_id) ?? new Map<string, number>();
        const acquisitions = allPlayers.map((player) => ({
          player,
          price: priceByPlayer.get(player.player_id) ?? null,
        }));

        const user = roster.owner_id ? usersById.get(roster.owner_id) : undefined;

        return {
          roster_id: roster.roster_id,
          manager: {
            user_id: roster.owner_id ?? null,
            display_name: user?.display_name ?? null,
            team_name: (user?.metadata?.team_name as string | undefined) ?? null,
          },
          composition: buildRosterComposition(
            allPlayers,
            starters,
            bench,
            taxi,
            reserve,
            totalRosterSlots,
          ),
          age: buildAgeFacts(allPlayers),
          slot_coverage: buildSlotCoverage(allPlayers, rosterPositions),
          auction_spend: buildAuctionSpendFacts(acquisitions, startingBudget),
          draft_pick_ownership: draftCapital.byOwner.get(roster.roster_id) ?? [],
        };
      })
      .sort((a, b) => a.roster_id - b.roster_id);

    const metadata = buildMetadata({
      league_id: leagueId,
      season: currentSeason,
      sources: [{ name: "Sleeper", type: "league_data" }],
      data_freshness: { rosters: "1m" },
      warnings,
    });

    return jsonResponse(
      { rosters: rosterAnalyses, metadata },
      { headers: { "Cache-Control": cacheHeader(60, 300) } },
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
