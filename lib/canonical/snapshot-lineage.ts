/**
 * Produce / recover a `SnapshotLineage` for a canonical snapshot.
 *
 *   - `deriveSnapshotLineage(snapshot, { crosswalkVersion })` — compute it from
 *     scratch. `buildCanonicalLeagueState` calls this once.
 *   - `snapshotLineage(snapshot)` — the safe accessor every consumer should use:
 *     returns `snapshot.lineage` when present, otherwise BACKFILLS a
 *     deterministic lineage from the snapshot body (a v1 persisted row, or an
 *     older test fixture, never carries one). Never returns `undefined`.
 *
 * The backfill is deterministic: the same v1 snapshot always yields the same
 * `league_snapshot_id`, so a recommendation made against a rehydrated old
 * snapshot is still traceable.
 */

import { leagueSnapshotId, snapshotContentHash } from "@/lib/persistence/serialize";
import { scoringFingerprint } from "./scoring-fingerprint";
import { attachLeagueFingerprints, rosterFingerprint } from "./league-fingerprints";
import { playerDataVersion } from "./player-data-version";
import type { SnapshotLineage } from "./lineage";
import type { CanonicalLeagueSnapshot } from "./schema";

export interface DeriveLineageOptions {
  /** `<crosswalk source name>:<row count>` or null when no crosswalk was used. */
  crosswalkVersion?: string | null;
}

export function deriveSnapshotLineage(
  snapshot: CanonicalLeagueSnapshot,
  options: DeriveLineageOptions = {},
): SnapshotLineage {
  return {
    league_snapshot_id: leagueSnapshotId(snapshot),
    snapshot_schema_version: snapshot.schema_version,
    content_hash: snapshotContentHash(snapshot),
    generated_at: snapshot.captured_at,
    provider: snapshot.league.provenance.provider,
    league_slug: snapshot.league.league_slug,
    league_id: snapshot.league.provenance.provider_id ?? snapshot.league.league_slug,
    season: snapshot.season,
    week: snapshot.week,
    scoring_fingerprint:
      snapshot.league.scoring_fingerprint ?? scoringFingerprint(snapshot.league.raw_scoring),
    roster_fingerprint:
      snapshot.league.roster_fingerprint ?? rosterFingerprint(snapshot.league.roster_settings),
    player_data_version: playerDataVersion(snapshot.players),
    crosswalk_version: options.crosswalkVersion ?? null,
  };
}

/** Safe accessor — always returns a lineage, backfilling for a v1 snapshot. */
export function snapshotLineage(snapshot: CanonicalLeagueSnapshot): SnapshotLineage {
  return snapshot.lineage ?? deriveSnapshotLineage(snapshot);
}

/**
 * Reader tolerance for pre-Phase-1B.1 (schema v1) persisted snapshots: a payload
 * written before this phase carries no `lineage` and no league
 * `scoring_fingerprint` / `roster_fingerprint`. Backfill deterministic values so
 * every consumer of a rehydrated snapshot sees a complete, traceable object. A
 * v2+ payload is returned untouched.
 */
export function hydratePersistedSnapshot(
  payload: CanonicalLeagueSnapshot,
): CanonicalLeagueSnapshot {
  if (payload.lineage && payload.league.scoring_fingerprint && payload.league.roster_fingerprint) {
    return payload;
  }
  const hydrated: CanonicalLeagueSnapshot = {
    ...payload,
    league: payload.league.scoring_fingerprint
      ? payload.league
      : attachLeagueFingerprints(payload.league),
  };
  hydrated.lineage =
    payload.lineage ?? deriveSnapshotLineage(hydrated, { crosswalkVersion: null });
  return hydrated;
}
