/**
 * Publish-time reconciliation gate.
 *
 * Before a freshly built candidate snapshot is allowed to become the authoritative
 * published generation, it must pass an integrity check. This is the runtime
 * enforcement of the Phase 1C certification work: `certify()` and
 * `factsFromCanonical` are reused verbatim — this module adds only (a) a second,
 * independent fact derivation from the SAME snapshot so `certify()` has two sides
 * to compare, and (b) referential-integrity checks `certify()` cannot express.
 *
 * A non-empty result FAILS publication: the previous published snapshot stays
 * authoritative and the candidate is recorded as rejected. It never merely logs.
 */

import { certify, factsFromCanonical, type Discrepancy, type LeagueFacts, type TeamFacts } from "./certification/harness";
import type { CanonicalLeagueSnapshot } from "./schema";

/** Provider states that are never eligible to be published as "current". */
const NON_PUBLISHABLE_STATUSES = new Set([
  "PROVIDER_ERROR",
  "AUTH_REQUIRED",
  "NOT_CONFIGURED",
  "DEGRADED",
]);

/**
 * Warning codes that make `live_provider_status` PARTIAL but do NOT represent a
 * corrupt or half-refreshed league state — a handful of unresolvable
 * practice-squad / rookie ids, history persistence being down, the free-agent
 * pool deliberately not materialized. A candidate is still publishable with
 * these; anything else keeps it out.
 */
const BENIGN_WARNING_CODES = new Set([
  "unresolved_player_identities",
  "HISTORY_PERSISTENCE_UNAVAILABLE",
  "free_agent_pool_not_materialized",
  "week_transactions_unavailable",
]);

export interface ReconcileResult {
  ok: boolean;
  /** Cross-surface disagreements found by `certify()`. */
  discrepancies: Discrepancy[];
  /** Referential / structural problems `certify()` cannot express. */
  structural: string[];
  /** Provider-status / warning reasons the candidate is not publishable. */
  eligibility: string[];
}

/**
 * A second `LeagueFacts` view built ONLY from `snapshot.teams[].record` and
 * recomputed ranks — deliberately ignoring `snapshot.standings`. If the two
 * disagree, the snapshot contradicts itself and must not be published.
 */
function factsFromTeamRecords(snap: CanonicalLeagueSnapshot): LeagueFacts {
  const managerById = new Map(snap.managers.map((m) => [m.canonical_manager_id, m]));
  const teams = new Map<number, TeamFacts>();
  for (const team of snap.teams) {
    const rosterId = Number(team.provider_team_id);
    if (!Number.isFinite(rosterId)) continue;
    const owner = team.canonical_manager_ids[0]
      ? managerById.get(team.canonical_manager_ids[0])
      : undefined;
    teams.set(rosterId, {
      roster_id: rosterId,
      owner_user_id: owner?.provider_user_id ?? team.provider_owner_id ?? null,
      manager_display_name: owner?.display_name ?? null,
      team_name: team.team_name,
      wins: team.record.wins,
      losses: team.record.losses,
      ties: team.record.ties,
      points_for: team.record.points_for,
      points_against: team.record.points_against,
    });
  }
  return { source: "team-records", teams };
}

function checkStructuralIntegrity(snap: CanonicalLeagueSnapshot): string[] {
  const problems: string[] = [];
  const teamIds = new Set(snap.teams.map((t) => t.canonical_team_id));
  const playerIds = new Set(snap.players.map((p) => p.canonical_player_id));

  // Every roster belongs to a real team.
  for (const r of snap.rosters) {
    if (!teamIds.has(r.canonical_team_id)) {
      problems.push(`roster references unknown team ${r.canonical_team_id}`);
    }
    for (const pid of r.all_players ?? []) {
      if (!playerIds.has(pid)) {
        problems.push(`roster ${r.canonical_team_id} references unknown player ${pid}`);
      }
    }
  }

  // Every standings row and every matchup side names a real team.
  for (const s of snap.standings) {
    if (!teamIds.has(s.canonical_team_id)) {
      problems.push(`standings references unknown team ${s.canonical_team_id}`);
    }
  }
  for (const m of snap.matchups) {
    for (const side of m.sides) {
      if (!teamIds.has(side.canonical_team_id)) {
        problems.push(`matchup wk${m.week} references unknown team ${side.canonical_team_id}`);
      }
    }
  }

  // Standings and teams describe the same set of teams.
  if (snap.standings.length > 0 && snap.standings.length !== snap.teams.length) {
    problems.push(
      `standings has ${snap.standings.length} rows but league has ${snap.teams.length} teams`,
    );
  }

  // A player is rostered by at most one team.
  const ownerByPlayer = new Map<string, string>();
  for (const r of snap.rosters) {
    for (const pid of r.all_players ?? []) {
      const prev = ownerByPlayer.get(pid);
      if (prev && prev !== r.canonical_team_id) {
        problems.push(`player ${pid} rostered by both ${prev} and ${r.canonical_team_id}`);
      }
      ownerByPlayer.set(pid, r.canonical_team_id);
    }
  }

  return problems;
}

function checkEligibility(snap: CanonicalLeagueSnapshot): string[] {
  const reasons: string[] = [];
  if (NON_PUBLISHABLE_STATUSES.has(snap.live_provider_status)) {
    reasons.push(`live_provider_status=${snap.live_provider_status}`);
  }
  for (const w of snap.warnings) {
    if (!BENIGN_WARNING_CODES.has(w.code)) {
      reasons.push(`non-benign warning: ${w.code}`);
    }
  }
  if (snap.teams.length === 0) reasons.push("candidate has no teams");
  return reasons;
}

export function reconcilePublishCandidate(
  snapshot: CanonicalLeagueSnapshot,
): ReconcileResult {
  const eligibility = checkEligibility(snapshot);
  const structural = checkStructuralIntegrity(snapshot);
  const discrepancies = certify(
    factsFromCanonical(snapshot),
    factsFromTeamRecords(snapshot),
    // team-records view has no player map / league scalars — certify() already
    // skips fields absent on either side, so no explicit allow-list is needed.
  );

  return {
    ok: eligibility.length === 0 && structural.length === 0 && discrepancies.length === 0,
    discrepancies,
    structural,
    eligibility,
  };
}

export function formatReconcileFailure(r: ReconcileResult): string {
  const parts: string[] = [];
  if (r.eligibility.length) parts.push(`ineligible: ${r.eligibility.join("; ")}`);
  if (r.structural.length) parts.push(`structural: ${r.structural.join("; ")}`);
  if (r.discrepancies.length) {
    parts.push(
      `discrepancies: ${r.discrepancies
        .map((d) => `[${d.scope}] ${d.field} ${JSON.stringify(d.a_value)}≠${JSON.stringify(d.b_value)}`)
        .join("; ")}`,
    );
  }
  return parts.join(" | ") || "ok";
}
