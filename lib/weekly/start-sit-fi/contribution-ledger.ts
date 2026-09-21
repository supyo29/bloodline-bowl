/**
 * Phase 8 — FI numeric contribution ledger. Single owner, no double counting, fully traceable.
 *
 * Exactly ONE consumer (START_SIT) owns a numeric FI contribution. Waivers, Matchup, Trades, FAAB and roster valuation
 * consume the production baseline projection directly and must never receive an FI-adjusted value; this ledger makes any
 * second application of the same (player, family) contribution a recorded violation instead of a silent double count.
 * Every entry carries what is needed to reproduce it: family, position, FI version, scoring fingerprint, baseline
 * projection version, translation/certification version, deployment state, freshness state, expected adjustment,
 * baseline and final projection, and why a blocked family was blocked.
 */
import type { DeploymentState } from "./deployment";
import type { FamilyBlockReason } from "./family-gate";

export const FI_CONTRIBUTION_OWNER = "START_SIT" as const;

export interface FiContributionEntry {
  owner: typeof FI_CONTRIBUTION_OWNER;
  canonical_player_id: string;
  position: string;
  family: string;
  fi_version: string | null;
  fi_through_week: number | null;
  scoring_fingerprint: string | null;
  baseline_projection_version: string | null;
  translation_version: string | null;
  certification_version: string | null;
  deployment_state: DeploymentState;
  freshness_status: string | null;
  temporal_membership_version: string | null;
  expected_adjustment: number;
  baseline_projection: number | null;
  final_projection: number | null;
  applied: boolean;
  blocked_by: FamilyBlockReason[];
}

export class ContributionLedger {
  private readonly rows: FiContributionEntry[] = [];
  private readonly seen = new Set<string>();
  readonly violations: string[] = [];

  /** Records one entry. Returns false (and logs a violation) if this (player, family) already has a contribution or the owner is not START_SIT. */
  record(e: FiContributionEntry): boolean {
    if (e.owner !== FI_CONTRIBUTION_OWNER) { this.violations.push(`owner ${String(e.owner)} is not ${FI_CONTRIBUTION_OWNER}`); return false; }
    const k = `${e.canonical_player_id}|${e.family}`;
    if (this.seen.has(k)) { this.violations.push(`duplicate contribution for ${k} (double count refused)`); return false; }
    this.seen.add(k); this.rows.push(e); return true;
  }
  entries(): readonly FiContributionEntry[] { return this.rows; }
  /** total APPLIED adjustment for a player (blocked/zero entries contribute 0). */
  appliedTotal(playerId: string): number { return this.rows.filter((r) => r.canonical_player_id === playerId && r.applied).reduce((s, r) => s + r.expected_adjustment, 0); }
  influencedAnyRecommendation(): boolean { return this.rows.some((r) => r.applied && r.expected_adjustment !== 0); }
}
