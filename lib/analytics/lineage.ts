/**
 * Safe traversal of a Sleeper league's season lineage via `previous_league_id`.
 *
 * Sleeper creates a new `league_id` each season and links backward, so
 * "history" means walking that chain — which can be missing, deleted,
 * malformed, or (in principle) circular. This module is the one place that
 * walk happens, guarded against all of those failure modes.
 */

import { SleeperError, getLeague } from "@/lib/sleeper/client";
import type { RawLeague } from "@/lib/sleeper/types";

/** Refuses to walk further back than this many seasons, even if the chain is longer. */
export const MAX_LINEAGE_DEPTH = 15;

export interface LineageEntry {
  league: RawLeague;
  depth: number;
}

export interface LineageResult {
  seasons: LineageEntry[];
  warnings: string[];
}

/**
 * Walk `previous_league_id` starting from `leagueId`, most recent season first.
 *
 * Stops when: the chain ends (`previous_league_id` is null), a linked league
 * cannot be fetched (deleted/private/network failure — recorded as a warning,
 * not a thrown error), a league id repeats (circular chain guard), or
 * {@link MAX_LINEAGE_DEPTH} is reached.
 */
export async function traverseLeagueLineage(
  leagueId: string,
): Promise<LineageResult> {
  const seasons: LineageEntry[] = [];
  const warnings: string[] = [];
  const visited = new Set<string>();

  let currentId: string | null = leagueId;
  let depth = 0;

  while (currentId !== null) {
    if (visited.has(currentId)) {
      warnings.push(
        `League lineage traversal stopped: league id ${currentId} was already visited, indicating a circular previous_league_id chain.`,
      );
      break;
    }
    if (depth >= MAX_LINEAGE_DEPTH) {
      warnings.push(
        `League lineage traversal stopped after reaching the maximum depth of ${MAX_LINEAGE_DEPTH} seasons.`,
      );
      break;
    }
    visited.add(currentId);

    let league: RawLeague;
    try {
      league = await getLeague(currentId);
    } catch (error) {
      const message =
        error instanceof SleeperError ? error.message : String(error);
      warnings.push(
        `Could not load league ${currentId} while walking season history: ${message}`,
      );
      break;
    }

    if (!league || !league.league_id) {
      warnings.push(
        `League ${currentId} returned a malformed response while walking season history.`,
      );
      break;
    }

    seasons.push({ league, depth });
    depth += 1;

    const next = league.previous_league_id;
    // Sleeper has been observed to use "0" as a sentinel for "no prior season".
    currentId = next && next !== "0" ? next : null;
  }

  return { seasons, warnings };
}
