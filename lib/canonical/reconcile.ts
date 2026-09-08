/**
 * Publish-time reconciliation gate.
 *
 * Before a freshly built candidate snapshot becomes the authoritative published
 * generation it must pass this gate. It is the runtime enforcement of the Phase
 * 1C certification work: `certify()` and `factsFromCanonical` are reused verbatim
 * — this module adds only (a) a second, independent fact derivation from the SAME
 * snapshot so `certify()` has two sides to compare, and (b) referential-integrity
 * checks `certify()` cannot express. The integrity VERDICT and the
 * capability/materiality analysis live in `./capabilities.ts` so no route ever
 * re-invents "which warnings are tolerable".
 *
 * A candidate whose `capabilities.snapshot_integrity` is `REJECTED` FAILS
 * publication: the previous published snapshot stays authoritative and the
 * candidate is recorded as rejected. It never merely logs.
 */

import { certify, factsFromCanonical, type Discrepancy, type LeagueFacts, type TeamFacts } from "./certification/harness";
import { assessCapabilities, summarizeCapabilities, type CapabilityReport } from "./capabilities";
import type { CanonicalLeagueSnapshot } from "./schema";

export interface ReconcileResult {
  ok: boolean;
  /** Cross-surface disagreements found by `certify()`. */
  discrepancies: Discrepancy[];
  /** Referential / structural problems `certify()` cannot express. */
  structural: string[];
  /** Full capability + materiality analysis (integrity verdict lives here). */
  capabilities: CapabilityReport;
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
  if (snap.standings.length > 0 && snap.standings.length !== snap.teams.length) {
    problems.push(
      `standings has ${snap.standings.length} rows but league has ${snap.teams.length} teams`,
    );
  }

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

export function reconcilePublishCandidate(
  snapshot: CanonicalLeagueSnapshot,
): ReconcileResult {
  const structural = checkStructuralIntegrity(snapshot);
  const discrepancies = certify(
    factsFromCanonical(snapshot),
    factsFromTeamRecords(snapshot),
  );
  const capabilities = assessCapabilities(snapshot, { discrepancies, structural });

  return {
    ok: capabilities.snapshot_integrity === "CERTIFIED",
    discrepancies,
    structural,
    capabilities,
  };
}

export function formatReconcileFailure(r: ReconcileResult): string {
  if (r.ok) return "ok";
  return `${summarizeCapabilities(r.capabilities)} :: ${r.capabilities.integrity_failures.join("; ")}`;
}
