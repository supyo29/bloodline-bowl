/**
 * Orchestrates the Sleeper fetches behind `GET /api/league`.
 *
 * Failure policy: the league, users, and rosters are *required* — without them
 * there is no meaningful response, so a failure there propagates. Everything
 * else (NFL state, drafts, picks, traded picks, the player database) degrades to
 * a warning so a single flaky secondary call cannot take down the endpoint.
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
  type PlayerIndex,
} from "./client";
import { buildLeagueResponse } from "./normalize";
import { DEFAULT_LEAGUE_KEY, findLeagueTarget } from "@/lib/leagues/registry";
import type {
  LeagueResponse,
  RawDraft,
  RawDraftPick,
  RawNflState,
  RawTradedPick,
  ResponseWarning,
} from "./types";

/** Bloodline Bowl. Overridable via `SLEEPER_LEAGUE_ID` for reuse/testing. */
export const BLOODLINE_BOWL_LEAGUE_ID = "1395549281678532608";

/**
 * Resolve a `league_id` to fetch from Sleeper.
 *
 * Resolution order, in priority:
 *  1. `selector` — an explicit `?league=` value from the caller. It may be
 *     either a {@link https://github.com registry key} (e.g.
 *     `"devoted-to-the-game"`) or a raw numeric Sleeper league id, so any
 *     league is always reachable directly even if it was never added to the
 *     registry. An unrecognized non-numeric selector falls through to the
 *     default rather than throwing — callers that want a hard 400 on a bad
 *     selector should validate it first with
 *     `lib/analytics/query.ts#parseLeagueSelector`.
 *  2. `SLEEPER_LEAGUE_ID` env var, for local overrides/testing.
 *  3. The default registry target ({@link DEFAULT_LEAGUE_KEY}), falling back
 *     to the hardcoded Bloodline Bowl id if the registry is ever empty.
 */
export function resolveLeagueId(selector?: string | null): string {
  if (selector) {
    const target = findLeagueTarget(selector);
    if (target) return target.league_id;
    if (/^\d+$/.test(selector)) return selector;
  }

  const configured = process.env.SLEEPER_LEAGUE_ID?.trim();
  if (configured && /^\d+$/.test(configured)) return configured;

  return (
    findLeagueTarget(DEFAULT_LEAGUE_KEY)?.league_id ?? BLOODLINE_BOWL_LEAGUE_ID
  );
}

function describeError(error: unknown): string {
  if (error instanceof SleeperError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Run a non-critical fetch, converting failure into a warning + fallback value. */
async function optional<T>(
  resource: string,
  code: string,
  warnings: ResponseWarning[],
  fallback: T,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    warnings.push({ code, resource, message: describeError(error) });
    return fallback;
  }
}

export interface LeagueBundle {
  response: LeagueResponse;
  /** True when every secondary resource also loaded cleanly. */
  complete: boolean;
}

export async function buildLeagueBundle(
  leagueId: string,
): Promise<LeagueBundle> {
  const startedAt = Date.now();
  const warnings: ResponseWarning[] = [];

  // Required core. A rejection here fails the request.
  const [league, users, rosters] = await Promise.all([
    getLeague(leagueId),
    getLeagueUsers(leagueId),
    getLeagueRosters(leagueId),
  ]);

  if (!league || typeof league !== "object" || !league.league_id) {
    throw new SleeperError(
      `Sleeper returned no league for id ${leagueId}`,
      `/league/${leagueId}`,
      404,
    );
  }

  // Secondary resources, all tolerant of failure.
  const [nflState, drafts, tradedPicks, playerIndex] = await Promise.all([
    optional<RawNflState | null>(
      "/state/nfl",
      "nfl_state_unavailable",
      warnings,
      null,
      getNflState,
    ),
    optional<RawDraft[]>(
      `/league/${leagueId}/drafts`,
      "drafts_unavailable",
      warnings,
      [],
      () => getLeagueDrafts(leagueId),
    ),
    optional<RawTradedPick[]>(
      `/league/${leagueId}/traded_picks`,
      "traded_picks_unavailable",
      warnings,
      [],
      () => getLeagueTradedPicks(leagueId),
    ),
    optional<PlayerIndex>(
      "/players/nfl",
      "player_database_unavailable",
      warnings,
      new Map(),
      getPlayerIndex,
    ),
  ]);

  const safeDrafts = Array.isArray(drafts) ? drafts : [];
  const safeTradedPicks = Array.isArray(tradedPicks) ? tradedPicks : [];

  // Draft picks: one call per draft, each independently tolerant of failure.
  const draftPicksByDraftId = new Map<string, RawDraftPick[]>();
  const pickResults = await Promise.all(
    safeDrafts.map(async (draft) => {
      const picks = await optional<RawDraftPick[]>(
        `/draft/${draft.draft_id}/picks`,
        "draft_picks_unavailable",
        warnings,
        [],
        () => getDraftPicks(draft.draft_id),
      );
      return [draft.draft_id, Array.isArray(picks) ? picks : []] as const;
    }),
  );
  for (const [draftId, picks] of pickResults) {
    draftPicksByDraftId.set(draftId, picks);
  }

  if (playerIndex.size === 0) {
    warnings.push({
      code: "players_unresolved",
      resource: "/players/nfl",
      message:
        "Player database unavailable; player objects are returned as unresolved stubs with ids only.",
    });
  }

  const response = buildLeagueResponse({
    leagueId,
    league,
    users: Array.isArray(users) ? users : [],
    rosters: Array.isArray(rosters) ? rosters : [],
    drafts: safeDrafts,
    draftPicksByDraftId,
    tradedPicks: safeTradedPicks,
    nflState,
    playerIndex,
    warnings,
    startedAt,
  });

  return { response, complete: warnings.length === 0 };
}
