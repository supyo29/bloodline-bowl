/**
 * Manager-scoped draft context: compose the SHARED league draft state (board,
 * picks, available players) with ONE manager's personalized state (roster,
 * roster id, draft slot, picks, positional needs, recommendations).
 *
 * The recommendation step is deliberately roster-driven and fully traceable:
 * every recommendation response carries a `recommendation_context` that echoes
 * the exact `roster_id` / `sleeper_user_id` / roster composition the engine
 * reasoned over. A test can assert that BijiMac's recommendations used BijiMac's
 * roster id — not merely that the response was labelled "BijiMac".
 *
 * Ranking basis is Sleeper `search_rank` (the same ordering `/api/draft` already
 * uses). This module does not invent projections or a strategy model.
 *
 * ⚠️ SEMANTICS (Phase 4 §3): what this module produces is a NEEDS-FILTERED
 * BEST-AVAILABLE CANDIDATE LIST, not a decision-engine recommendation. The real
 * snake recommendation engine — turn geometry, tier cliffs, survival, reach
 * cost, roster-construction risk, two-pick turn optimisation — lives in
 * `lib/draft/` and is served from
 * `GET /api/leagues/:slug/managers/:slug/recommendations`
 * (`recommendation_version: ri-snake-decision-2026.2`). This list is kept as the
 * lightweight candidate feed and is labelled accordingly in the response.
 */

import {
  getLeague,
  getLeagueRosters,
  getPlayerIndex,
  slimPlayer,
  type PlayerIndex,
} from "@/lib/sleeper/client";
import {
  buildDraftBundle,
  type DraftBundle,
} from "@/lib/sleeper/draft-service";
import {
  computeRosterNeeds,
  eligiblePositions,
  type RosterNeeds,
} from "@/lib/sleeper/draft";
import { isCurrentlyDraftable } from "@/lib/sleeper/eligibility";
import type {
  DraftAcquisition,
  NormalizedPlayer,
  RawRoster,
} from "@/lib/sleeper/types";
import type { ResolvedManager } from "./resolve";

const FLEX_POSITIONS = ["RB", "WR", "TE"];
const DEFAULT_RECOMMENDATION_COUNT = 12;

export interface ManagerRecommendation {
  rank: number | null;
  name: string;
  position: string | null;
  team: string | null;
  player_id: string;
  bye_week: number | null;
  reason: string;
}

export interface ManagerRecommendationContext {
  /** The identity the recommendation engine ACTUALLY used (must match `manager`). */
  used_manager_slug: string;
  used_sleeper_user_id: string;
  used_roster_id: number;
  used_draft_slot: number | null;
  /** Snapshot of the roster the engine reasoned over. */
  roster_player_count: number;
  roster_position_counts: Record<string, number>;
  positional_needs: RosterNeeds;
  /** How the candidate pool was filtered. */
  needed_positions: string[];
  candidate_pool_size: number;
  ranking_basis: "sleeper_search_rank";
  /** Phase 4 §3: this is a candidate list, not the decision engine. */
  result_kind: "needs_filtered_best_available_candidates";
  full_recommendation_engine: string;
  note: string;
}

export interface ManagerDraftContext {
  /* ---- shared league state (safe to reuse across managers) ---- */
  league: {
    league_id: string;
    name: string;
    season: string;
    roster_positions: string[];
  };
  draft: {
    draft_id: string | null;
    status: string | null;
    type: string | null;
    rounds: number | null;
    completed_picks: number | null;
    total_picks: number | null;
  };
  board: {
    available_players_returned: number;
    total_matching: number;
    ordering: string;
  };
  picks: DraftAcquisition[];
  available_players: NormalizedPlayer[];

  /* ---- this manager only ---- */
  manager: {
    manager_slug: string;
    sleeper_username: string;
    sleeper_user_id: string;
    manager_roster_id: number;
    manager_draft_slot: number | null;
    manager_roster: NormalizedPlayer[];
    manager_picks: DraftAcquisition[];
    roster_construction: Record<string, number>;
    positional_needs: RosterNeeds;
    recommendations: ManagerRecommendation[];
    recommendation_context: ManagerRecommendationContext;
  };
}

function positionCountsOf(players: NormalizedPlayer[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of players) {
    const pos = p.position ?? "UNKNOWN";
    counts[pos] = (counts[pos] ?? 0) + 1;
  }
  return counts;
}

/** Positions this manager still needs, given the shared roster rules. */
export function neededPositions(
  needs: RosterNeeds,
  flexPositions: string[] = FLEX_POSITIONS,
): string[] {
  const wanted = new Set<string>();
  for (const req of needs.required) wanted.add(req.position);
  if (needs.flexible_slots_remaining > 0) {
    for (const p of flexPositions) wanted.add(p);
  }
  return [...wanted].sort();
}

/**
 * Build recommendations from an EXPLICIT roster + available pool. Pure and
 * synchronous so a unit test can prove that two different rosters yield two
 * different recommendation sets with two different `used_roster_id` values.
 */
export function buildManagerRecommendations(input: {
  manager: {
    manager_slug: string;
    sleeper_user_id: string;
    roster_id: number;
    draft_slot: number | null;
  };
  rosterPlayers: NormalizedPlayer[];
  rosterPositions: string[];
  availablePlayers: NormalizedPlayer[];
  count?: number;
}): {
  recommendations: ManagerRecommendation[];
  context: ManagerRecommendationContext;
  needs: RosterNeeds;
  roster_construction: Record<string, number>;
} {
  const { manager, rosterPlayers, rosterPositions, availablePlayers } = input;
  const count = input.count ?? DEFAULT_RECOMMENDATION_COUNT;

  const needs = computeRosterNeeds(rosterPlayers, rosterPositions);
  const rosterConstruction = positionCountsOf(rosterPlayers);
  const wanted = neededPositions(needs);
  const wantedSet = new Set(wanted);

  const matches = (p: NormalizedPlayer): boolean => {
    // Defense in depth: the shared pool is already filtered by
    // `isCurrentlyDraftable`, but the recommendation candidate list re-checks so
    // a stale record can never reach a manager's recommendations by any path.
    if (!isCurrentlyDraftable(p)) return false;
    if (wantedSet.size === 0) return true; // starters full -> pure best-available
    return eligiblePositions(p).some((pos) => wantedSet.has(pos));
  };

  const strictNeed = new Set(needs.required.map((r) => r.position));
  const recommendations: ManagerRecommendation[] = availablePlayers
    .filter(matches)
    .slice(0, count)
    .map((p) => {
      const positions = eligiblePositions(p);
      const fillsStrict = positions.some((pos) => strictNeed.has(pos));
      return {
        rank: p.search_rank ?? null,
        name: p.full_name,
        position: p.position,
        team: p.team,
        player_id: p.player_id,
        bye_week: null,
        reason: fillsStrict
          ? `Fills an open starting ${positions.find((pos) => strictNeed.has(pos))} slot for roster ${manager.roster_id}`
          : needs.flexible_slots_remaining > 0
            ? `FLEX-eligible depth for roster ${manager.roster_id}`
            : `Best available for roster ${manager.roster_id}`,
      } satisfies ManagerRecommendation & { reason: string };
    });

  const context: ManagerRecommendationContext = {
    used_manager_slug: manager.manager_slug,
    used_sleeper_user_id: manager.sleeper_user_id,
    used_roster_id: manager.roster_id,
    used_draft_slot: manager.draft_slot,
    roster_player_count: rosterPlayers.length,
    roster_position_counts: rosterConstruction,
    positional_needs: needs,
    needed_positions: wanted,
    candidate_pool_size: availablePlayers.length,
    ranking_basis: "sleeper_search_rank",
    result_kind: "needs_filtered_best_available_candidates",
    full_recommendation_engine:
      "GET /api/leagues/{league}/managers/{manager}/recommendations (ri-snake-decision-2026.2)",
    note:
      "This is a needs-filtered best-available CANDIDATE list (Sleeper search_rank), " +
      "not a decision-engine recommendation. For turn-aware recommendations — tier " +
      "cliffs, survival, reach cost, roster-construction risk, and snake turn-pair " +
      "optimisation — call the recommendations endpoint above. The identity here is " +
      "the exact roster the list was built for, not the response label.",
  };

  return {
    recommendations,
    context,
    needs,
    roster_construction: rosterConstruction,
  };
}

function resolveRosterPlayers(
  roster: RawRoster | undefined,
  index: PlayerIndex,
): NormalizedPlayer[] {
  return (roster?.players ?? [])
    .filter((id): id is string => typeof id === "string" && id !== "0")
    .map((id) => index.get(id) ?? slimPlayer(id, undefined));
}

/**
 * The full manager draft context. Fetches the SHARED league draft bundle once
 * and this manager's roster, then composes. Every manager-scoped value is keyed
 * off `manager.roster_id` / `manager.sleeper_user_id` — never the first roster,
 * never a default.
 */
export async function buildManagerDraftContext(
  manager: ResolvedManager,
  options: { availableLimit?: number; recommendationCount?: number } = {},
): Promise<ManagerDraftContext> {
  const availableLimit = options.availableLimit ?? 300;

  const [league, rosters, playerIndex, draftBundle]: [
    Awaited<ReturnType<typeof getLeague>>,
    RawRoster[],
    PlayerIndex,
    DraftBundle,
  ] = await Promise.all([
    getLeague(manager.league_id),
    getLeagueRosters(manager.league_id),
    getPlayerIndex(),
    buildDraftBundle(manager.league_id, {
      availableLimit,
      position: null,
    }),
  ]);

  const draft = draftBundle.response;
  const rosterPositions = league.roster_positions ?? [];

  // EXPLICIT: this manager's roster, by the verified roster id only.
  const managerRoster = rosters.find((r) => r.roster_id === manager.roster_id);
  const rosterPlayers = resolveRosterPlayers(managerRoster, playerIndex);

  // This manager's picks only.
  const managerPicks = draft.picks.filter(
    (p) => p.roster_id === manager.roster_id,
  );

  // If the roster has no players yet (pre-draft), fall back to the manager's
  // own draft picks so needs still reflect what this manager has taken.
  const effectiveRosterPlayers =
    rosterPlayers.length > 0
      ? rosterPlayers
      : managerPicks
          .map((p) => p.player)
          .filter((p): p is NormalizedPlayer => p !== null);

  const { recommendations, context, needs, roster_construction } =
    buildManagerRecommendations({
      manager: {
        manager_slug: manager.manager_slug,
        sleeper_user_id: manager.sleeper_user_id,
        roster_id: manager.roster_id,
        draft_slot: manager.draft_slot,
      },
      rosterPlayers: effectiveRosterPlayers,
      rosterPositions,
      availablePlayers: draft.available_players,
      count: options.recommendationCount,
    });

  return {
    league: {
      league_id: league.league_id,
      name: league.name,
      season: league.season,
      roster_positions: rosterPositions,
    },
    draft: {
      draft_id: draft.draft?.draft_id ?? null,
      status: draft.draft?.status ?? null,
      type: draft.draft?.type ?? null,
      rounds: draft.draft?.rounds ?? null,
      completed_picks: draft.draft?.completed_picks ?? null,
      total_picks: draft.draft?.total_picks ?? null,
    },
    board: {
      available_players_returned: draft.available_players.length,
      total_matching: draft.metadata.available_players.total_matching,
      ordering: draft.metadata.available_players.ordering,
    },
    picks: draft.picks,
    available_players: draft.available_players,
    manager: {
      manager_slug: manager.manager_slug,
      sleeper_username: manager.sleeper_username,
      sleeper_user_id: manager.sleeper_user_id,
      manager_roster_id: manager.roster_id,
      manager_draft_slot: manager.draft_slot,
      manager_roster: rosterPlayers,
      manager_picks: managerPicks,
      roster_construction,
      positional_needs: needs,
      recommendations,
      recommendation_context: context,
    },
  };
}
