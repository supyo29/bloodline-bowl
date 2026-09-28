/**
 * Phase 5 — canonical weekly projection snapshot contract.
 *
 * A snapshot is the normalized, league-scored projection evidence consumed by
 * weekly analytics AFTER provider stat lines have been translated into canonical
 * player ids and the league's scoring. It is deliberately not the raw Sleeper
 * payload.
 *
 * Content identity excludes observation time. The mutable "latest" pointer owns
 * freshness; immutable artifacts own semantics.
 */

import { contentHash } from "@/lib/bridge/hash";
import { scoringFingerprint } from "@/lib/canonical/scoring-fingerprint";
import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { WeeklyProjection, WeeklyProjectionBatch, WeeklyWarning } from "../schema";
import type { ProjectionRequest } from "./types";

export const PROJECTION_SNAPSHOT_FORMAT = 1 as const;
/** 90-minute serving window. A daily cron warms the store; ordinary requests self-refresh stale/missing snapshots. */
export const PROJECTION_SNAPSHOT_MAX_AGE_MS = 90 * 60 * 1000;

export interface ProjectionSnapshotScope {
  league_slug: string;
  season: number;
  week: number;
  scoring_fingerprint: string;
  /**
   * Fingerprint of every request input that can change normalized projection
   * output while league/week/scoring stay constant. This prevents one caller's
   * ROS / return-game / crosswalk variant from being served to another.
   */
  request_fingerprint: string;
}

export interface ProjectionSnapshotPlayerRecord {
  canonical_player_id: string;
  projection: WeeklyProjection;
  resolved_player: CanonicalPlayer | null;
}

export interface ProjectionSnapshotArtifact {
  format: typeof PROJECTION_SNAPSHOT_FORMAT;
  artifact_id: string;
  content_hash: string;
  league_slug: string;
  season: number;
  week: number;
  scoring_fingerprint: string;
  request_fingerprint: string;
  status: WeeklyProjectionBatch["status"];
  source: string;
  model_version: string;
  teams_with_games: string[];
  warnings: WeeklyWarning[];
  row_count: number;
  players: ProjectionSnapshotPlayerRecord[];
}

export interface ProjectionSnapshotHit {
  artifact: ProjectionSnapshotArtifact;
  observed_at: string;
  age_ms: number;
  batch: WeeklyProjectionBatch;
}

export type ProjectionSnapshotWriteStatus =
  | "INSERTED"
  | "DUPLICATE_IDENTICAL"
  | "NOT_CONFIGURED"
  | "ERROR";

export interface ProjectionSnapshotWriteResult {
  status: ProjectionSnapshotWriteStatus;
  artifact_id: string | null;
  observed_at: string | null;
  durable: boolean;
  error?: string;
}

export interface ProjectionSnapshotStore {
  readonly kind: string;
  readonly durable: boolean;
  readLatest(
    req: ProjectionRequest,
    opts?: { maxAgeMs?: number; now?: () => number },
  ): Promise<ProjectionSnapshotHit | null>;
  record(
    req: ProjectionRequest,
    batch: WeeklyProjectionBatch,
    observedAt?: string,
  ): Promise<ProjectionSnapshotWriteResult>;
}

function sortedMapEntries<T>(m: ReadonlyMap<string, T> | undefined): Array<[string, T]> {
  return m ? [...m.entries()].sort(([a], [b]) => a.localeCompare(b)) : [];
}

export function projectionSnapshotRequestFingerprint(req: ProjectionRequest): string {
  const semantic = {
    format: 1,
    want_rest_of_season: req.want_rest_of_season === true,
    crosswalk_version: req.crosswalk.version ?? null,
    return_game_season: sortedMapEntries(req.return_game_season),
    return_game_recent_attempts: sortedMapEntries(req.return_game_recent_attempts).map(([id, attempts]) => [
      id,
      [...attempts],
    ]),
  };
  return `projreq:v1:${contentHash(semantic).slice(0, 24)}`;
}

export function projectionSnapshotScope(req: ProjectionRequest): ProjectionSnapshotScope {
  return {
    league_slug: req.league.league_slug,
    season: req.league.season,
    week: req.week,
    scoring_fingerprint: scoringFingerprint(req.league.raw_scoring),
    request_fingerprint: projectionSnapshotRequestFingerprint(req),
  };
}

function semanticPlayerRows(batch: WeeklyProjectionBatch): ProjectionSnapshotPlayerRecord[] {
  return [...batch.by_player.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([canonical_player_id, projection]) => ({
      canonical_player_id,
      projection,
      resolved_player: batch.resolved_players.get(canonical_player_id) ?? null,
    }));
}

export function buildProjectionSnapshotArtifact(
  req: ProjectionRequest,
  batch: WeeklyProjectionBatch,
): ProjectionSnapshotArtifact {
  const scope = projectionSnapshotScope(req);
  const players = semanticPlayerRows(batch);
  const semantic = {
    format: PROJECTION_SNAPSHOT_FORMAT,
    ...scope,
    status: batch.status,
    source: batch.source,
    model_version: batch.model_version,
    teams_with_games: [...batch.teams_with_games].sort(),
    warnings: batch.warnings,
    players,
  };
  const hash = contentHash(semantic);
  return {
    ...semantic,
    artifact_id: `projsnap:${hash.slice(0, 20)}`,
    content_hash: hash,
    row_count: players.length,
  };
}

export function hydrateProjectionSnapshotBatch(
  artifact: ProjectionSnapshotArtifact,
  requestedIds: readonly string[],
  provenance: {
    observed_at: string;
    age_ms: number;
    durable: boolean;
  },
): WeeklyProjectionBatch {
  const by_player = new Map<string, WeeklyProjection>();
  const resolved_players = new Map<string, CanonicalPlayer>();
  for (const row of artifact.players) {
    // The durable/process-local artifact is immutable shared evidence. Every
    // caller receives its own mutable projection/player objects because
    // downstream enrichment (for example assembleRosSignals) intentionally
    // mutates the returned batch in place.
    by_player.set(row.canonical_player_id, structuredClone(row.projection));
    if (row.resolved_player) {
      resolved_players.set(row.canonical_player_id, structuredClone(row.resolved_player));
    }
  }

  const warnings = [
    ...artifact.warnings,
    {
      code: "canonical_projection_snapshot_hit",
      message: `Served normalized projection artifact ${artifact.artifact_id} observed at ${provenance.observed_at}.`,
      severity: "info" as const,
    },
  ];

  return {
    league_slug: artifact.league_slug,
    season: artifact.season,
    week: artifact.week,
    status: artifact.status,
    by_player,
    resolved_players,
    source: artifact.source,
    model_version: artifact.model_version,
    missing: requestedIds.filter((id) => !by_player.has(id)),
    teams_with_games: [...artifact.teams_with_games],
    warnings,
    canonical_snapshot: {
      read_path: "SUPABASE_HIT",
      artifact_id: artifact.artifact_id,
      observed_at: provenance.observed_at,
      age_ms: provenance.age_ms,
      durable: provenance.durable,
    },
  };
}
