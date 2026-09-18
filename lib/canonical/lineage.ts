/**
 * The shared lineage contract.
 *
 * Phase 1B.1 goal: every current and future management engine output
 * (weekly, trade, waivers, lineup, start/sit, matchup, ROS, Football
 * Intelligence, orchestrator) can state EXACTLY which canonical league state
 * and which external model versions produced it — without a consumer having to
 * infer the source from unrelated fields.
 *
 * Two nested shapes:
 *   - {@link SnapshotLineage}  — identity of the canonical league state itself.
 *     Lives on `CanonicalLeagueSnapshot.lineage` and is produced once, by
 *     `buildCanonicalLeagueState`.
 *   - {@link RecommendationLineage} — what an ENGINE result carries: the
 *     snapshot lineage it consumed, plus the projection sources/versions it
 *     used and its own engine version(s).
 *
 * Progressive adoption: every field an engine cannot yet populate is optional.
 * A `ProjectionLineageEntry` with `status: "UNRESOLVED"` is how a consumer
 * distinguishes "no projection model ran" from "a model ran and returned
 * nothing".
 */

import type { ProviderName } from "./schema";

/** Identity of one immutable canonical league state. */
export interface SnapshotLineage {
  /** `snap:<league_slug>:<season>:w<week>:<contentHash16>` — deterministic. */
  league_snapshot_id: string;
  /** `CANONICAL_SCHEMA_VERSION` the snapshot was built under. */
  snapshot_schema_version: number;
  /** Full sha256 of the content-hashed subset (see `serialize.ts`). */
  content_hash: string;
  /** Wall-clock capture time. NOT part of the id (identical content ⇒ same id). */
  generated_at: string;
  provider: ProviderName;
  league_slug: string;
  /** Provider-native league id. */
  league_id: string;
  season: number;
  week: number;
  /** Canonical scoring identity — `lib/canonical/scoring-fingerprint.ts`. */
  scoring_fingerprint: string;
  /** sha256 of the normalized roster-settings object. */
  roster_fingerprint: string;
  /**
   * Content hash of per-player material metadata (team, position, injury/status)
   * for every player in the snapshot. NOT a timestamp — Sleeper does not version
   * `/players/nfl`. Lets two recommendations be compared for "did the underlying
   * player metadata materially differ". See `lib/canonical/player-data-version.ts`.
   */
  player_data_version: string;
  /** Identity crosswalk generation (`<source name>:<row count>`), or null when no crosswalk. */
  crosswalk_version: string | null;
}

/**
 * Football Intelligence's own week-completion state, mirrored from
 * `FootballIntelligenceWeekCompletion` (`lib/football-intel/schema.ts`).
 * Duplicated as a small standalone shape here (not imported) so
 * `lib/canonical/` -- the core substrate every engine depends on -- never
 * takes a compile-time dependency on one optional subsystem's module; keep
 * the two shapes in sync if either changes.
 */
export interface FootballIntelligenceWeekCompletion {
  latest_week: number;
  week_state: "PARTIAL" | "COMPLETE";
  games_completed_in_latest_week: number;
  games_scheduled_in_latest_week: number;
  latest_completed_game_date: string | null;
}

/**
 * Identity/provenance of one Football Intelligence snapshot, as consulted by
 * an engine. This is IDENTITY only -- what FI says about itself. Whether
 * that identity is fresh enough, which feature families it covers, and
 * whether it's permitted to influence a production result are separate
 * questions answered by `lib/canonical/intelligence-freshness.ts`, never by
 * this type. Built exclusively by
 * `buildFootballIntelligenceLineage()` (`lib/football-intel/lineage.ts`) --
 * no consumer should construct this by hand.
 */
export interface FootballIntelligenceLineage {
  /** `fi:<season>:w<week>:<12 hex>` */
  version: string;
  model_tag: string;
  season: number;
  through_week: number;
  /** `null` only for a manifest frozen before week_completion existed -- never fabricated. */
  week_completion: FootballIntelligenceWeekCompletion | null;
  /** per-source max NFL week actually ingested, exactly as FI published it. */
  data_cutoff: Record<string, number>;
  /** every output-class value FI's contract declares (e.g. OBSERVED/MODELED/DESCRIPTIVE_ONLY) -- informational, not per-metric. */
  output_classes: string[];
  generated_at: string;
}

/**
 * Identity/provenance of one Role & Opportunity Intelligence snapshot
 * (Phase 2), as consulted by an engine. Structurally parallel to
 * {@link FootballIntelligenceLineage} on purpose -- same identity-only
 * contract, same "this is not a freshness verdict" boundary -- but a
 * DISTINCT product: Role & Opportunity Intelligence is independently
 * versioned from Football Intelligence even though both are built from
 * overlapping raw nflverse sources (Checkpoint B/D). Built exclusively by
 * `buildRoleOpportunityIntelligenceLineage()`
 * (`lib/player-role-intelligence/lineage.ts`) -- no consumer should
 * construct this by hand.
 */
export interface RoleOpportunityIntelligenceLineage {
  /** `roi:<season>:w<week>:<12 hex>` */
  version: string;
  model_tag: string;
  feature_schema_version: string;
  season: number;
  through_week: number;
  /** `null` only for a manifest that predates week_completion -- never fabricated. */
  week_completion: FootballIntelligenceWeekCompletion | null;
  /** per-raw-source max NFL week actually ingested (pbp, participation, snap_counts), exactly as the manifest published it. */
  data_cutoff: Record<string, number>;
  /** Checkpoint B's grain/schema contract version this artifact was built under. */
  substrate_schema_version: string;
  generated_at: string;
}

/** One projection model that fed an engine result. */
export interface ProjectionLineageEntry {
  /** What role this projection played in the engine. */
  role: "weekly_absolute" | "season_ordinal" | "special_teams" | "benchmark";
  /** e.g. `sleeper_weekly`, `roster_intel_season`. */
  source: string;
  /** e.g. `sleeper-weekly-rotowire`, `ri-structural-2026.3`. */
  model_version: string;
  /** When the model produced its numbers, when the source exposes it. */
  generated_at: string | null;
  /** MUST equal the snapshot's `scoring_fingerprint`; a mismatch is a defect a consumer can detect. */
  scoring_fingerprint: string | null;
  status: "READY" | "PARTIAL" | "UNAVAILABLE" | "UNRESOLVED";
}

/** The lineage envelope an engine result carries. */
export interface RecommendationLineage {
  snapshot: SnapshotLineage;
  /** Projection models consumed (empty for engines that use none). */
  projections: ProjectionLineageEntry[];
  /**
   * Football Intelligence's identity, if this engine call consulted it at
   * all. `null` means "not consulted" -- an explicit, typed fact, not an
   * absent field a consumer could mistake for "consulted but empty."
   * Intelligence-Modernization Phase 1 (see
   * `docs/INTELLIGENCE_MODERNIZATION_PHASE_1_AUDIT.md`).
   */
  football_intelligence: FootballIntelligenceLineage | null;
  /**
   * Role & Opportunity Intelligence's identity, if this engine call
   * consulted it at all (Phase 2, Checkpoint D). `null` means "not
   * consulted" -- same explicit-fact convention as `football_intelligence`.
   * Attaching this lineage is never itself evidence of numeric influence --
   * see `lib/player-role-intelligence/README` / Checkpoint D report for the
   * deployment-state gate that governs whether it may ever be one.
   *
   * Optional (unlike `football_intelligence`) so every pre-existing
   * `RecommendationLineage` literal in the codebase keeps typechecking
   * without modification -- `undefined` and `null` both mean "not
   * consulted" for this field; new code should prefer `null` explicitly
   * (via `buildRecommendationLineage`, which always sets it).
   */
  role_opportunity_intelligence?: RoleOpportunityIntelligenceLineage | null;
  /** Engine name -> version. e.g. `{ weekly_engine: "post-draft-intel-2026.1" }`. */
  engine_versions: Record<string, string>;
}

/** Build a `RecommendationLineage` from a snapshot lineage + engine additions. */
export function buildRecommendationLineage(
  snapshot: SnapshotLineage,
  engineVersions: Record<string, string>,
  projections: ProjectionLineageEntry[] = [],
  footballIntelligence: FootballIntelligenceLineage | null = null,
  roleOpportunityIntelligence: RoleOpportunityIntelligenceLineage | null = null,
): RecommendationLineage {
  return {
    snapshot,
    projections,
    football_intelligence: footballIntelligence,
    role_opportunity_intelligence: roleOpportunityIntelligence,
    engine_versions: { ...engineVersions },
  };
}
