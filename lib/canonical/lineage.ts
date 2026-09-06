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
  /** Engine name -> version. e.g. `{ weekly_engine: "post-draft-intel-2026.1" }`. */
  engine_versions: Record<string, string>;
}

/** Build a `RecommendationLineage` from a snapshot lineage + engine additions. */
export function buildRecommendationLineage(
  snapshot: SnapshotLineage,
  engineVersions: Record<string, string>,
  projections: ProjectionLineageEntry[] = [],
): RecommendationLineage {
  return { snapshot, projections, engine_versions: { ...engineVersions } };
}
