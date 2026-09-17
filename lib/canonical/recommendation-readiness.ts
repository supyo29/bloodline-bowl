/**
 * Intelligence Modernization Phase 1, Checkpoint C — composes canonical
 * league-state freshness with Football Intelligence freshness and
 * deployment permission, WITHOUT collapsing them into one unexplained
 * boolean and WITHOUT duplicating either engine's logic.
 *
 *   RecommendationReadiness = canonical freshness
 *                           + Football Intelligence freshness
 *                           + deployment permission
 *                           + overall (a summary judgment that still
 *                             exposes every component that produced it)
 *
 * Ownership stays exactly where Checkpoint A found it:
 *   - canonical snapshot freshness is owned by `lib/canonical/freshness.ts`
 *     (`deriveFreshness`) -- this module calls it, never reimplements it.
 *   - Football Intelligence freshness is owned by
 *     `lib/canonical/intelligence-freshness.ts` -- called, never
 *     reimplemented.
 *   - deployment permission (is a feature family/position actually
 *     PRODUCTION_ACTIVE right now) is owned by
 *     `lib/weekly/start-sit-fi/deployment.ts` and
 *     `lib/weekly/matchup-intelligence/deployment.ts` -- this module
 *     deliberately does NOT import either (canonical must not depend on
 *     weekly; that would invert the real dependency direction). Callers in
 *     `lib/weekly/*` compute their own `DeploymentPermission` from those
 *     gates and pass it in.
 */

import { deriveFreshness, type Freshness, type RefreshMode } from "./freshness";
import {
  assessIntelligenceFreshness,
  summarizeIntelligenceFreshness,
  type IntelligenceFreshnessAssessment,
  type IntelligenceFreshnessRequest,
} from "./intelligence-freshness";
import type { SnapshotLineage } from "./lineage";

export interface DeploymentPermission {
  /** true only when the caller's own gate function said this feature/position is PRODUCTION_ACTIVE right now. */
  football_intelligence_production_active: boolean;
  /** which gate produced this, for traceability -- never invented if the operation has no such gate at all. */
  source: "start_sit_fi" | "matchup_intelligence" | "not_applicable";
  detail: string;
}

export const DEPLOYMENT_NOT_APPLICABLE: DeploymentPermission = {
  football_intelligence_production_active: false,
  source: "not_applicable",
  detail: "this operation has no Football Intelligence deployment gate (Waiver, Trade, Roster Planning, Analysis)",
};

export type OverallReadinessStatus = "READY" | "READY_DEGRADED" | "NOT_READY";

export interface RecommendationReadiness {
  canonical: Freshness | null;
  football_intelligence: IntelligenceFreshnessAssessment;
  deployment: DeploymentPermission;
  overall: {
    status: OverallReadinessStatus;
    usable: boolean;
    reasons: string[];
  };
}

/**
 * Feeds `deriveFreshness()` (the existing, unmodified canonical engine)
 * from the fields a `SnapshotLineage` already carries. This is composition,
 * not reimplementation -- every age-bucket/threshold decision still lives
 * in `lib/canonical/freshness.ts`.
 */
export function deriveCanonicalFreshnessFromLineage(
  snapshot: SnapshotLineage,
  opts: { mode?: RefreshMode; now?: number } = {},
): Freshness {
  return deriveFreshness({
    mode: opts.mode ?? "NORMAL",
    source_synced_at: snapshot.generated_at,
    snapshot_id: snapshot.league_snapshot_id,
    content_hash: snapshot.content_hash,
    // A lineage only exists for a snapshot that was actually built; there is
    // no separate certification signal at this layer to consult, so this
    // reflects "a real snapshot produced this," not a claim about data quality.
    certified: true,
    now: opts.now,
  });
}

function combineOverall(
  canonical: Freshness | null,
  fi: IntelligenceFreshnessAssessment,
  deployment: DeploymentPermission,
): RecommendationReadiness["overall"] {
  const reasons: string[] = [];
  // Object wrapper -- see the identical pattern (and its comment) in
  // lib/canonical/intelligence-freshness.ts: a plain `let` narrows to its
  // literal initializer type across these closure-mutated escalate() calls.
  const state: { status: OverallReadinessStatus } = { status: "READY" };
  const RANK: Record<OverallReadinessStatus, number> = { READY: 0, READY_DEGRADED: 1, NOT_READY: 2 };
  const escalate = (next: OverallReadinessStatus) => {
    if (RANK[next] > RANK[state.status]) state.status = next;
  };

  if (canonical) {
    if (canonical.status === "SOURCE_UNAVAILABLE") {
      reasons.push("canonical league snapshot: provider unreachable");
      escalate("NOT_READY");
    } else if (canonical.status === "STALE" || canonical.status === "DEGRADED") {
      reasons.push(`canonical league snapshot: ${canonical.status}`);
      escalate("READY_DEGRADED");
    } else if (canonical.status === "REFRESHING" || canonical.status === "UNKNOWN") {
      reasons.push(`canonical league snapshot: ${canonical.status}`);
      escalate("READY_DEGRADED");
    }
  }

  if (fi.overall_status === "INCOMPATIBLE") {
    reasons.push("football intelligence: INCOMPATIBLE");
    escalate("NOT_READY");
  } else if (fi.fallback_required) {
    reasons.push("football intelligence: fallback required for this operation");
    escalate("READY_DEGRADED");
  } else if (fi.overall_status === "STALE" || fi.overall_status === "DEGRADED") {
    // Only escalate overall readiness for a materially-affected operation --
    // assessIntelligenceFreshness() already scaled fallback_required/
    // confidence_cap by operation materiality, so a LOW-materiality
    // STALE/DEGRADED FI verdict (Waiver, Start/Sit baseline) does not by
    // itself demote overall readiness; a HIGH-materiality one already set
    // fallback_required above.
    if (fi.confidence_cap === "LOW" || fi.confidence_cap === "INSUFFICIENT_SAMPLE") {
      reasons.push(`football intelligence: ${fi.overall_status} (confidence capped ${fi.confidence_cap})`);
      escalate("READY_DEGRADED");
    }
  }

  if (deployment.football_intelligence_production_active && fi.overall_status !== "CURRENT" && fi.overall_status !== "PARTIAL_CURRENT") {
    // Deployment permission and freshness are independent, but if a future
    // phase ever DOES promote a family to PRODUCTION_ACTIVE, using it while
    // stale is exactly the failure this whole phase exists to prevent.
    reasons.push("Football Intelligence is PRODUCTION_ACTIVE for this call but its freshness is not CURRENT/PARTIAL_CURRENT");
    escalate("NOT_READY");
  }

  return { status: state.status, usable: state.status !== "NOT_READY", reasons };
}

export function assessRecommendationReadiness(
  request: IntelligenceFreshnessRequest,
  opts: {
    deployment?: DeploymentPermission;
    canonicalMode?: RefreshMode;
    now?: number;
    /** set false only when there is genuinely no canonical snapshot to assess (e.g. a pure synthetic/offline analysis). */
    includeCanonical?: boolean;
  } = {},
): RecommendationReadiness {
  const deployment = opts.deployment ?? DEPLOYMENT_NOT_APPLICABLE;
  const canonical =
    opts.includeCanonical === false
      ? null
      : deriveCanonicalFreshnessFromLineage(request.lineage.snapshot, { mode: opts.canonicalMode, now: opts.now });
  const football_intelligence = assessIntelligenceFreshness(request);
  return {
    canonical,
    football_intelligence,
    deployment,
    overall: combineOverall(canonical, football_intelligence, deployment),
  };
}

/** Human-readable summary of the FULL composition, built from the typed structures -- never recomputes freshness. */
export function summarizeRecommendationReadiness(readiness: RecommendationReadiness): string {
  const lines: string[] = [];
  if (readiness.canonical) {
    lines.push(`League state: ${readiness.canonical.status} -- ${readiness.canonical.snapshot_id ?? "unknown"}`);
  }
  lines.push(
    summarizeIntelligenceFreshness(readiness.football_intelligence, {
      deployment_active: readiness.deployment.football_intelligence_production_active,
    }),
  );
  lines.push(`Overall readiness: ${readiness.overall.status} / ${readiness.overall.usable ? "usable" : "not usable"}`);
  for (const r of readiness.overall.reasons) lines.push(`  - ${r}`);
  return lines.join("\n");
}
