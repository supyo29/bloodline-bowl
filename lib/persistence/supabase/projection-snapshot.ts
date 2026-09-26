/**
 * Phase 5 — Supabase-backed canonical projection snapshots.
 *
 * Three-table design:
 *   bridge_projection_snapshots         immutable content-addressed metadata
 *   bridge_projection_snapshot_players  immutable normalized player rows
 *   bridge_projection_latest            mutable freshness pointer per league/week/scoring
 *
 * A repeated observation of identical projection content advances only the
 * pointer. This keeps history compact while freshness remains truthful.
 */

import {
  PROJECTION_SNAPSHOT_FORMAT,
  PROJECTION_SNAPSHOT_MAX_AGE_MS,
  buildProjectionSnapshotArtifact,
  hydrateProjectionSnapshotBatch,
  projectionSnapshotScope,
  type ProjectionSnapshotArtifact,
  type ProjectionSnapshotHit,
  type ProjectionSnapshotPlayerRecord,
  type ProjectionSnapshotStore,
  type ProjectionSnapshotWriteResult,
} from "@/lib/weekly/projections/canonical-snapshot";
import type { ProjectionRequest } from "@/lib/weekly/projections/types";
import type { WeeklyProjectionBatch, WeeklyWarning } from "@/lib/weekly/schema";
import { loadSupabaseConfig, SupabaseRest } from "./rest";

const SNAPSHOT_TABLE = "bridge_projection_snapshots";
const PLAYER_TABLE = "bridge_projection_snapshot_players";
const POINTER_TABLE = "bridge_projection_latest";
const PLAYER_INSERT_CHUNK = 250;
const PLAYER_READ_PAGE = 1000;
/**
 * Process-local read memo. Shorter than the canonical 90-minute serving window:
 * it only prevents repeated Supabase pagination inside one warm serverless
 * process / logical orchestration; it is not a second freshness authority.
 */
export const PROJECTION_SNAPSHOT_LOCAL_READ_TTL_MS = 60_000;

interface SnapshotRow {
  artifact_id: string;
  content_hash: string;
  league_slug: string;
  season: number;
  week: number;
  scoring_fingerprint: string;
  status: WeeklyProjectionBatch["status"];
  source: string;
  model_version: string;
  teams_with_games: string[];
  warnings: WeeklyWarning[];
  row_count: number;
  format: number;
}

interface PlayerRow {
  artifact_id: string;
  canonical_player_id: string;
  projection: ProjectionSnapshotPlayerRecord["projection"];
  resolved_player: ProjectionSnapshotPlayerRecord["resolved_player"];
}

interface PointerRow {
  league_slug: string;
  season: number;
  week: number;
  scoring_fingerprint: string;
  artifact_id: string;
  observed_at: string;
}

function parentRow(a: ProjectionSnapshotArtifact): SnapshotRow {
  return {
    artifact_id: a.artifact_id,
    content_hash: a.content_hash,
    league_slug: a.league_slug,
    season: a.season,
    week: a.week,
    scoring_fingerprint: a.scoring_fingerprint,
    status: a.status,
    source: a.source,
    model_version: a.model_version,
    teams_with_games: a.teams_with_games,
    warnings: a.warnings,
    row_count: a.row_count,
    format: a.format,
  };
}

function playerRows(a: ProjectionSnapshotArtifact): PlayerRow[] {
  return a.players.map((p) => ({
    artifact_id: a.artifact_id,
    canonical_player_id: p.canonical_player_id,
    projection: p.projection,
    resolved_player: p.resolved_player,
  }));
}

function artifactFromRows(parent: SnapshotRow, players: PlayerRow[]): ProjectionSnapshotArtifact | null {
  if (parent.format !== PROJECTION_SNAPSHOT_FORMAT || players.length !== parent.row_count) return null;
  const sorted = [...players].sort((a, b) => a.canonical_player_id.localeCompare(b.canonical_player_id));
  return {
    format: PROJECTION_SNAPSHOT_FORMAT,
    artifact_id: parent.artifact_id,
    content_hash: parent.content_hash,
    league_slug: parent.league_slug,
    season: parent.season,
    week: parent.week,
    scoring_fingerprint: parent.scoring_fingerprint,
    status: parent.status,
    source: parent.source,
    model_version: parent.model_version,
    teams_with_games: parent.teams_with_games ?? [],
    warnings: parent.warnings ?? [],
    row_count: parent.row_count,
    players: sorted.map((r) => ({
      canonical_player_id: r.canonical_player_id,
      projection: r.projection,
      resolved_player: r.resolved_player ?? null,
    })),
  };
}

export class SupabaseProjectionSnapshotStore implements ProjectionSnapshotStore {
  readonly kind = "supabase";
  readonly durable = true;

  #readCache = new Map<
    string,
    { artifact: ProjectionSnapshotArtifact; observed_at: string; cached_at_ms: number }
  >();
  #inFlightReads = new Map<
    string,
    Promise<{ artifact: ProjectionSnapshotArtifact; observed_at: string } | null>
  >();

  constructor(private readonly rest: SupabaseRest) {}

  #scopeKey(scope: ReturnType<typeof projectionSnapshotScope>): string {
    return `${scope.league_slug}|${scope.season}|${scope.week}|${scope.scoring_fingerprint}`;
  }

  #hydrateHit(
    req: ProjectionRequest,
    artifact: ProjectionSnapshotArtifact,
    observedAt: string,
    nowMs: number,
  ): ProjectionSnapshotHit {
    const observedMs = Date.parse(observedAt);
    const ageMs = Number.isFinite(observedMs)
      ? Math.max(0, nowMs - observedMs)
      : Number.POSITIVE_INFINITY;
    return {
      artifact,
      observed_at: observedAt,
      age_ms: ageMs,
      batch: hydrateProjectionSnapshotBatch(artifact, req.canonical_player_ids, {
        observed_at: observedAt,
        age_ms: ageMs,
        durable: true,
      }),
    };
  }

  async readLatest(
    req: ProjectionRequest,
    opts: { maxAgeMs?: number; now?: () => number } = {},
  ): Promise<ProjectionSnapshotHit | null> {
    const scope = projectionSnapshotScope(req);
    const key = this.#scopeKey(scope);
    const now = opts.now ?? Date.now;
    const nowMs = now();
    const maxAgeMs = opts.maxAgeMs ?? PROJECTION_SNAPSHOT_MAX_AGE_MS;

    const memo = this.#readCache.get(key);
    if (memo && nowMs - memo.cached_at_ms <= PROJECTION_SNAPSHOT_LOCAL_READ_TTL_MS) {
      const hit = this.#hydrateHit(req, memo.artifact, memo.observed_at, nowMs);
      if (hit.age_ms <= maxAgeMs) return hit;
      this.#readCache.delete(key);
    }

    let pending = this.#inFlightReads.get(key);
    if (!pending) {
      pending = this.#readArtifact(scope, maxAgeMs, nowMs);
      this.#inFlightReads.set(key, pending);
      void pending.finally(() => {
        if (this.#inFlightReads.get(key) === pending) this.#inFlightReads.delete(key);
      });
    }

    const loaded = await pending;
    if (!loaded) return null;
    this.#readCache.set(key, {
      artifact: loaded.artifact,
      observed_at: loaded.observed_at,
      cached_at_ms: nowMs,
    });
    return this.#hydrateHit(req, loaded.artifact, loaded.observed_at, nowMs);
  }

  async #readArtifact(
    scope: ReturnType<typeof projectionSnapshotScope>,
    maxAgeMs: number,
    nowMs: number,
  ): Promise<{ artifact: ProjectionSnapshotArtifact; observed_at: string } | null> {
    const rows = await this.rest.select<PointerRow>(POINTER_TABLE, {
      filter: {
        league_slug: `eq.${scope.league_slug}`,
        season: `eq.${scope.season}`,
        week: `eq.${scope.week}`,
        scoring_fingerprint: `eq.${scope.scoring_fingerprint}`,
      },
      limit: 1,
      select: "league_slug,season,week,scoring_fingerprint,artifact_id,observed_at",
    });
    const pointer = rows[0];
    if (!pointer) return null;

    const observedMs = Date.parse(pointer.observed_at);
    const ageMs = Number.isFinite(observedMs) ? Math.max(0, nowMs - observedMs) : Number.POSITIVE_INFINITY;
    if (ageMs > maxAgeMs) return null;

    const parent = (
      await this.rest.select<SnapshotRow>(SNAPSHOT_TABLE, {
        filter: { artifact_id: `eq.${pointer.artifact_id}` },
        limit: 1,
        select:
          "artifact_id,content_hash,league_slug,season,week,scoring_fingerprint,status,source,model_version,teams_with_games,warnings,row_count,format",
      })
    )[0];
    if (!parent) return null;
    if (
      parent.league_slug !== scope.league_slug ||
      parent.season !== scope.season ||
      parent.week !== scope.week ||
      parent.scoring_fingerprint !== scope.scoring_fingerprint
    ) {
      return null;
    }

    const players: PlayerRow[] = [];
    // Supabase/PostgREST commonly caps one response page at 1,000 rows even
    // when the client asks for more. Projection artifacts are league-wide and
    // can exceed 3,000 rows, so read deterministically in bounded pages.
    for (let offset = 0; offset < parent.row_count; offset += PLAYER_READ_PAGE) {
      const page = await this.rest.select<PlayerRow>(PLAYER_TABLE, {
        filter: { artifact_id: `eq.${pointer.artifact_id}` },
        order: "canonical_player_id.asc",
        limit: PLAYER_READ_PAGE,
        offset,
        select: "artifact_id,canonical_player_id,projection,resolved_player",
      });
      players.push(...page);
      if (page.length < PLAYER_READ_PAGE) break;
    }
    const artifact = artifactFromRows(parent, players);
    if (!artifact) return null;

    return {
      artifact,
      observed_at: pointer.observed_at,
    };
  }

  async record(
    req: ProjectionRequest,
    batch: WeeklyProjectionBatch,
    observedAt = new Date().toISOString(),
  ): Promise<ProjectionSnapshotWriteResult> {
    const artifact = buildProjectionSnapshotArtifact(req, batch);
    try {
      const inserted = await this.rest.insertIgnoreDuplicates<{ artifact_id: string }>(
        SNAPSHOT_TABLE,
        [parentRow(artifact)],
        ["artifact_id"],
      );

      const children = playerRows(artifact);
      for (let i = 0; i < children.length; i += PLAYER_INSERT_CHUNK) {
        await this.rest.insertIgnoreDuplicates(
          PLAYER_TABLE,
          children.slice(i, i + PLAYER_INSERT_CHUNK),
          ["artifact_id", "canonical_player_id"],
        );
      }

      const scope = projectionSnapshotScope(req);
      const pointer = {
        ...scope,
        artifact_id: artifact.artifact_id,
        observed_at: observedAt,
      };
      // Create-once, then advance only if the stored observation is older. This
      // prevents a slow older request from overwriting a newer observation.
      const pointerInserted = await this.rest.insertIgnoreDuplicates<PointerRow>(POINTER_TABLE, [pointer], [
        "league_slug",
        "season",
        "week",
        "scoring_fingerprint",
      ]);
      const pointerAdvanced = await this.rest.updateReturning<PointerRow>(
        POINTER_TABLE,
        {
          league_slug: `eq.${scope.league_slug}`,
          season: `eq.${scope.season}`,
          week: `eq.${scope.week}`,
          scoring_fingerprint: `eq.${scope.scoring_fingerprint}`,
          observed_at: `lt.${observedAt}`,
        },
        { artifact_id: artifact.artifact_id, observed_at: observedAt, updated_at: new Date().toISOString() },
      );

      // If this write won the pointer race, make the normalized artifact
      // immediately reusable by every other analytical stage in this process.
      if (pointerInserted.length > 0 || pointerAdvanced.length > 0) {
        this.#readCache.set(this.#scopeKey(scope), {
          artifact,
          observed_at: observedAt,
          cached_at_ms: Date.now(),
        });
      }

      return {
        status: inserted.length > 0 ? "INSERTED" : "DUPLICATE_IDENTICAL",
        artifact_id: artifact.artifact_id,
        observed_at: observedAt,
        durable: true,
      };
    } catch (error) {
      return {
        status: "ERROR",
        artifact_id: artifact.artifact_id,
        observed_at: observedAt,
        durable: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

class UnconfiguredProjectionSnapshotStore implements ProjectionSnapshotStore {
  readonly kind = "none";
  readonly durable = false;
  async readLatest(): Promise<null> {
    return null;
  }
  async record(): Promise<ProjectionSnapshotWriteResult> {
    return {
      status: "NOT_CONFIGURED",
      artifact_id: null,
      observed_at: null,
      durable: false,
      error: "projection snapshot persistence not configured",
    };
  }
}

let cached: ProjectionSnapshotStore | null = null;

export function getProjectionSnapshotStore(env: NodeJS.ProcessEnv = process.env): ProjectionSnapshotStore {
  if (env === process.env && cached) return cached;
  const cfg = loadSupabaseConfig(env);
  const store: ProjectionSnapshotStore =
    cfg.configured && cfg.config
      ? new SupabaseProjectionSnapshotStore(new SupabaseRest(cfg.config))
      : new UnconfiguredProjectionSnapshotStore();
  if (env === process.env) cached = store;
  return store;
}

export function __setProjectionSnapshotStore(store: ProjectionSnapshotStore | null): void {
  cached = store;
}
