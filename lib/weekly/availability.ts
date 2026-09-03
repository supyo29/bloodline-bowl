/**
 * League-specific free-agent / ownership determination — CANONICAL identity only.
 *
 * A player is a free agent in a league ONLY if their canonical id is not on any
 * roster in THAT league. False availability is a high-impact defect, so:
 *  - ownership is matched on `canonical_player_id`
 *  - every rostered player also contributes its provider ids as a belt-and-braces
 *    exclusion set (a free-agent candidate matching either is excluded)
 *  - provider players whose identity could NOT be resolved are treated as
 *    rostered-and-unavailable and surfaced in `unresolved_rostered` — never
 *    silently offered as free agents
 */

import type { CanonicalLeagueSnapshot, CanonicalPlayer } from "@/lib/canonical/schema";
import type {
  AvailablePlayer,
  LeagueAvailability,
  OwnershipState,
  WeeklyWarning,
} from "./schema";

export interface AvailabilityInput {
  snapshot: CanonicalLeagueSnapshot;
  /** The canonical team the requesting manager owns. */
  manager_team_id: string;
  week: number;
  /** Candidate NFL players to classify (typically everyone projected this week). */
  candidates: CanonicalPlayer[];
  /** Positions this league starts — a candidate with no eligible starting position is `locked_ineligible`. */
  startable_positions: Set<string>;
}

export function buildLeagueAvailability(input: AvailabilityInput): LeagueAvailability {
  const { snapshot, manager_team_id, week, candidates, startable_positions } = input;
  const warnings: WeeklyWarning[] = [];

  // canonical_player_id -> owning canonical_team_id (any roster in THIS league).
  const ownerByCanonical = new Map<string, string>();
  // provider ids of rostered players -> owning team (belt).
  const ownerByProviderId = new Map<string, string>();
  const playerById = new Map<string, CanonicalPlayer>(
    snapshot.players.map((p) => [p.canonical_player_id, p]),
  );

  for (const roster of snapshot.rosters) {
    for (const cid of roster.all_players) {
      ownerByCanonical.set(cid, roster.canonical_team_id);
      const meta = playerById.get(cid);
      for (const key of ["sleeper_id", "yahoo_id", "yahoo_player_key", "gsis_id"] as const) {
        const v = meta?.identifiers?.[key];
        if (v) ownerByProviderId.set(String(v), roster.canonical_team_id);
      }
    }
  }

  // Unresolved provider players are on SOMEONE's roster (the provider listed
  // them) but we can't line them up canonically — treat as unavailable.
  const unresolved_rostered = snapshot.unresolved_players.map((u) => ({
    provider: u.provider,
    provider_player_id: u.provider_player_id,
    observed_name: u.observed_name,
  }));
  const unresolvedProviderIds = new Set(
    snapshot.unresolved_players
      .map((u) => u.provider_player_id)
      .filter((x): x is string => Boolean(x)),
  );
  if (unresolved_rostered.length > 0) {
    warnings.push({
      code: "identity_unresolved_rostered",
      message: `${unresolved_rostered.length} rostered provider player(s) could not be resolved to a canonical identity; excluded from free agency.`,
      severity: "warning",
    });
  }

  const classify = (p: CanonicalPlayer): { ownership: OwnershipState; team: string | null; note: string | null } => {
    // Identity resolution failed for this candidate -> never a free agent.
    if (p.resolution.method === "unresolved") {
      return { ownership: "locked_ineligible", team: null, note: p.resolution.note ?? "unresolved identity" };
    }
    // Any provider id of this candidate matches an unresolved rostered id.
    for (const v of Object.values(p.identifiers)) {
      if (v && unresolvedProviderIds.has(String(v))) {
        return { ownership: "rostered_other", team: null, note: "matches an unresolved rostered provider id" };
      }
    }
    const byCanonical = ownerByCanonical.get(p.canonical_player_id);
    if (byCanonical) {
      return {
        ownership: byCanonical === manager_team_id ? "rostered_by_manager" : "rostered_other",
        team: byCanonical,
        note: null,
      };
    }
    for (const v of Object.values(p.identifiers)) {
      const t = v ? ownerByProviderId.get(String(v)) : undefined;
      if (t) {
        return {
          ownership: t === manager_team_id ? "rostered_by_manager" : "rostered_other",
          team: t,
          note: "matched on a provider id, not the canonical id",
        };
      }
    }
    // Not on any roster -> free agent (waiver vs FA distinction is provider-specific;
    // Sleeper does not expose per-player waiver windows, so `free_agent` unless a
    // future provider says otherwise).
    const eligible = p.eligible_positions.some((pos) => startable_positions.has(pos)) || startable_positions.has(p.position);
    if (!eligible) return { ownership: "locked_ineligible", team: null, note: "no eligible starting position in this league" };
    return { ownership: "free_agent", team: null, note: null };
  };

  const players: AvailablePlayer[] = candidates.map((p) => {
    const c = classify(p);
    return {
      canonical_player_id: p.canonical_player_id,
      player: p,
      ownership: c.ownership,
      owned_by_team_id: c.team,
      unresolved_note: c.note,
    };
  });

  const free_agents = players.filter((p) => p.ownership === "free_agent");

  return {
    league_slug: snapshot.league.league_slug,
    week,
    players,
    free_agents,
    unresolved_rostered,
    warnings,
  };
}
