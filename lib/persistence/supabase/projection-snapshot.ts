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
  buildProjectionSnapshotArtifact,
  hydrateProjectionSnapshotBatch,
  projectionSnapshotScope,
  type ProjectionSnapshotArtifact,
  type ProjectionSnapshotHit,
  type ProjectionSnapshotPlayerRecord,
  type ProjectionSnapshotStore,
  type ProjectionSnapshotWriteResult,
} from "@/lib/weekly/projections/canonical-snapshot";
import { STALE_FALLBACK_MAX_AGE_MS, TIER_MAX_AGE_MS } from "@/lib/weekly/freshness/policy";
import type { ProjectionRequest } from "@/lib/weekly/projections/types";
import type { WeeklyProjectionBatch, WeeklyWarning } from "@/lib/weekly/schema";
import { classifySchemaMismatch, loadSupabaseConfig, SupabaseRest, SupabaseRestError } from "./rest";

const SNAPSHOT_TABLE = "bridge_projection_snapshots";
const PLAYER_TABLE = "bridge_projection_snapshot_players";
const POINTER_TABLE = "bridge_projection_latest";
const PLAYER_INSERT_CHUNK = 250;
const PLAYER_READ_PAGE = 1000;
/**
 * Process-local read memo. It only prevents repeated Supabase pagination inside one warm
 * serverless process / logical orchestration; it is NOT a freshness authority — every memo
 * hit is still gated on the SOURCE age the freshness policy requires (see readLatest).
 */
export const PROJECTION_SNAPSHOT_LOCAL_READ_TTL_MS = 60_000;

interface SnapshotRow {
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
  request_fingerprint: string;
  artifact_id: string;
  observed_at: string;
  /** W1.P4 (nullable: legacy pointers) — when Bloodline observed the upstream source state behind `artifact_id` */
  source_observed_at?: string | null;
  source_observation_id?: string | null;
}

const POINTER_BASE_COLUMNS = "league_slug,season,week,scoring_fingerprint,request_fingerprint,artifact_id,observed_at";
const POINTER_SOURCE_COLUMNS = ",source_observed_at,source_observation_id";
/**
 * W1.R1: the W1.P4 pointer columns are absent (migration not applied). Decided from the STRUCTURED error (status/code/table) the REST
 * wrapper raises — never from message text, which the wrapper deliberately does not populate with the server's body. Only a missing-column
 * failure on the pointer table counts; an unrelated 400/404 (other code, other table) must surface, not silently enable legacy mode.
 */
const isPointerSchemaLegacy = (e: unknown): boolean => classifySchemaMismatch(e) === "MISSING_COLUMN" && e instanceof SupabaseRestError && e.table === POINTER_TABLE;
/** a "legacy schema" verdict is re-probed after this long, so applying the migration to a live deployment takes effect without a restart */
const LEGACY_SCHEMA_REPROBE_MS = 5 * 60_000;

function parentRow(a: ProjectionSnapshotArtifact): SnapshotRow {
  return {
    artifact_id: a.artifact_id,
    content_hash: a.content_hash,
    league_slug: a.league_slug,
    season: a.season,
    week: a.week,
    scoring_fingerprint: a.scoring_fingerprint,
    request_fingerprint: a.request_fingerprint,
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
    request_fingerprint: parent.request_fingerprint,
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

interface Loaded {
  artifact: ProjectionSnapshotArtifact;
  observed_at: string;
  source_observed_at: string | null;
  source_observation_id: string | null;
}
type CacheEntry = Loaded & { cached_at_ms: number };

export class SupabaseProjectionSnapshotStore implements ProjectionSnapshotStore {
  readonly kind = "supabase";
  readonly durable = true;

  /** null = unknown yet; false = the W1.P4 pointer columns are not deployed (legacy mode: source time unknown) */
  #pointerHasSourceColumns: boolean | null = null;
  #legacySinceMs = 0;
  #readCache = new Map<string, CacheEntry>();
  #inFlightReads = new Map<string, Promise<Loaded | null>>();

  constructor(private readonly rest: SupabaseRest) {}

  #scopeKey(scope: ReturnType<typeof projectionSnapshotScope>): string {
    return `${scope.league_slug}|${scope.season}|${scope.week}|${scope.scoring_fingerprint}|${scope.request_fingerprint}`;
  }


  #cacheNewerOrEqual(key: string, next: CacheEntry): CacheEntry {
    const current = this.#readCache.get(key);
    if (current) {
      // newer = later SOURCE observation when both know it, else later snapshot pointer time
      const cur = Date.parse(current.source_observed_at ?? current.observed_at);
      const nxt = Date.parse(next.source_observed_at ?? next.observed_at);
      if (Number.isFinite(cur) && Number.isFinite(nxt) && cur > nxt) return current;
    }
    this.#readCache.set(key, next);
    return next;
  }

  #hydrateHit(req: ProjectionRequest, loaded: Loaded, nowMs: number, staleFallback = false): ProjectionSnapshotHit {
    // Freshness is a property of the SOURCE observation. A legacy pointer has no source time, so its (conservative) snapshot age stands in
    // for gating only; the batch then reports source_observed_at = null (UNKNOWN), never the snapshot time.
    const basis = Date.parse(loaded.source_observed_at ?? loaded.observed_at);
    const ageMs = Number.isFinite(basis) ? Math.max(0, nowMs - basis) : Number.POSITIVE_INFINITY;
    const batch = hydrateProjectionSnapshotBatch(loaded.artifact, req.canonical_player_ids, {
      observed_at: loaded.observed_at,
      age_ms: ageMs,
      durable: true,
      source_observed_at: loaded.source_observed_at,
      source_observation_id: loaded.source_observation_id,
    });
    if (loaded.source_observed_at == null) {
      // honest degradation: gating used the snapshot pointer time as a conservative stand-in, which cannot prove the source's age
      batch.warnings.push({
        code: "projection_snapshot_source_time_unknown",
        message:
          "This snapshot's pointer carries no source observation time (the W1.P4 freshness columns are not applied, or the pointer predates them). Its age was gated on the snapshot write time, so freshness confidence is degraded; the source observation time is reported as unknown, not guessed.",
        severity: "info",
      });
    }
    return {
      artifact: loaded.artifact,
      observed_at: loaded.observed_at,
      age_ms: ageMs,
      source_observed_at: loaded.source_observed_at,
      source_observation_id: loaded.source_observation_id,
      stale_fallback: staleFallback,
      batch,
    };
  }

  async readLatest(
    req: ProjectionRequest,
    opts: { maxAgeMs?: number; now?: () => number; allowStale?: boolean } = {},
  ): Promise<ProjectionSnapshotHit | null> {
    const scope = projectionSnapshotScope(req);
    const key = this.#scopeKey(scope);
    const now = opts.now ?? Date.now;
    const nowMs = now();
    const allowStale = opts.allowStale === true;
    // The age gate is supplied by the freshness authority; the fallback default is its most conservative tier, not a universal window.
    const maxAgeMs = allowStale ? STALE_FALLBACK_MAX_AGE_MS : (opts.maxAgeMs ?? TIER_MAX_AGE_MS.KICKOFF_UNKNOWN);

    const ageOf = (l: Loaded): number => {
      const t = Date.parse(l.source_observed_at ?? l.observed_at);
      return Number.isFinite(t) ? Math.max(0, nowMs - t) : Number.POSITIVE_INFINITY;
    };

    const memo = this.#readCache.get(key);
    if (memo && nowMs - memo.cached_at_ms <= PROJECTION_SNAPSHOT_LOCAL_READ_TTL_MS) {
      if (ageOf(memo) <= maxAgeMs) return this.#hydrateHit(req, memo, nowMs, allowStale && ageOf(memo) > (opts.maxAgeMs ?? TIER_MAX_AGE_MS.KICKOFF_UNKNOWN));
      if (!allowStale) this.#readCache.delete(key);
    }

    let pending = this.#inFlightReads.get(key);
    if (!pending) {
      pending = this.#readArtifact(scope);
      this.#inFlightReads.set(key, pending);
      const cleanup = () => {
        if (this.#inFlightReads.get(key) === pending) this.#inFlightReads.delete(key);
      };
      void pending.then(cleanup, cleanup);
    }

    const loaded = await pending;
    if (!loaded) return null;
    const chosen = this.#cacheNewerOrEqual(key, { ...loaded, cached_at_ms: nowMs });
    if (ageOf(chosen) > maxAgeMs) return null;
    return this.#hydrateHit(req, chosen, nowMs, allowStale && ageOf(chosen) > (opts.maxAgeMs ?? TIER_MAX_AGE_MS.KICKOFF_UNKNOWN));
  }

  #markLegacy(): void {
    this.#pointerHasSourceColumns = false;
    this.#legacySinceMs = Date.now();
  }

  #expireLegacyVerdict(): void {
    if (this.#pointerHasSourceColumns === false && Date.now() - this.#legacySinceMs >= LEGACY_SCHEMA_REPROBE_MS) this.#pointerHasSourceColumns = null;
  }

  async #readPointer(scope: ReturnType<typeof projectionSnapshotScope>): Promise<PointerRow | undefined> {
    const filter = {
      league_slug: `eq.${scope.league_slug}`,
      season: `eq.${scope.season}`,
      week: `eq.${scope.week}`,
      scoring_fingerprint: `eq.${scope.scoring_fingerprint}`,
      request_fingerprint: `eq.${scope.request_fingerprint}`,
    };
    this.#expireLegacyVerdict();
    if (this.#pointerHasSourceColumns !== false) {
      try {
        const rows = await this.rest.select<PointerRow>(POINTER_TABLE, { filter, limit: 1, select: POINTER_BASE_COLUMNS + POINTER_SOURCE_COLUMNS });
        this.#pointerHasSourceColumns = true;
        return rows[0];
      } catch (e) {
        if (!isPointerSchemaLegacy(e)) throw e;
        this.#markLegacy(); // legacy schema: fall through to the base columns
      }
    }
    return (await this.rest.select<PointerRow>(POINTER_TABLE, { filter, limit: 1, select: POINTER_BASE_COLUMNS }))[0];
  }

  async #readArtifact(scope: ReturnType<typeof projectionSnapshotScope>): Promise<Loaded | null> {
    const pointer = await this.#readPointer(scope);
    if (!pointer) return null;

    const parent = (
      await this.rest.select<SnapshotRow>(SNAPSHOT_TABLE, {
        filter: { artifact_id: `eq.${pointer.artifact_id}` },
        limit: 1,
        select:
          "artifact_id,content_hash,league_slug,season,week,scoring_fingerprint,request_fingerprint,status,source,model_version,teams_with_games,warnings,row_count,format",
      })
    )[0];
    if (!parent) return null;
    if (
      parent.league_slug !== scope.league_slug ||
      parent.season !== scope.season ||
      parent.week !== scope.week ||
      parent.scoring_fingerprint !== scope.scoring_fingerprint ||
      parent.request_fingerprint !== scope.request_fingerprint
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
      source_observed_at: pointer.source_observed_at ?? null,
      source_observation_id: pointer.source_observation_id ?? null,
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
      const sourceAt = batch.source_observation?.observed_at ?? null;
      const sourceId = batch.source_observation?.observation_id ?? null;
      this.#expireLegacyVerdict();
      const withSource = this.#pointerHasSourceColumns !== false;
      const pointer = {
        ...scope,
        artifact_id: artifact.artifact_id,
        observed_at: observedAt,
        ...(withSource ? { source_observed_at: sourceAt, source_observation_id: sourceId } : {}),
      };
      const conflictKey = ["league_slug", "season", "week", "scoring_fingerprint", "request_fingerprint"];
      const pointerFilter = {
        league_slug: `eq.${scope.league_slug}`,
        season: `eq.${scope.season}`,
        week: `eq.${scope.week}`,
        scoring_fingerprint: `eq.${scope.scoring_fingerprint}`,
        request_fingerprint: `eq.${scope.request_fingerprint}`,
      };
      let pointerInserted: PointerRow[] = [];
      let pointerAdvanced: PointerRow[] = [];
      const attempt = async (useSource: boolean): Promise<void> => {
        const row = useSource ? pointer : { ...scope, artifact_id: artifact.artifact_id, observed_at: observedAt };
        // Create-once...
        pointerInserted = await this.rest.insertIgnoreDuplicates<PointerRow>(POINTER_TABLE, [row], conflictKey);
        // ...then advance monotonically. With the W1.P4 columns the guard is the SOURCE time, so a re-wrapped older payload can never make
        // the pointer look newer: the source instant only moves forward, whatever the snapshot write time is.
        const patch = { artifact_id: artifact.artifact_id, observed_at: observedAt, updated_at: new Date().toISOString(), ...(useSource ? { source_observed_at: sourceAt, source_observation_id: sourceId } : {}) };
        if (useSource && sourceAt != null) {
          pointerAdvanced = await this.rest.updateReturning<PointerRow>(POINTER_TABLE, { ...pointerFilter, source_observed_at: `lt.${sourceAt}` }, patch);
          if (pointerAdvanced.length === 0) {
            // legacy pointer rows (NULL source time) are upgraded once, by any write that knows its source time
            pointerAdvanced = await this.rest.updateReturning<PointerRow>(POINTER_TABLE, { ...pointerFilter, source_observed_at: "is.null" }, patch);
          }
        } else {
          // a writer that cannot establish a source time (legacy/fake providers) advances by snapshot time and leaves the SOURCE time unknown (null):
          // snapshot time is never promoted to a source observation, and a new artifact never inherits another artifact's source instant.
          pointerAdvanced = await this.rest.updateReturning<PointerRow>(POINTER_TABLE, { ...pointerFilter, observed_at: `lt.${observedAt}` }, { ...patch, ...(useSource ? { source_observed_at: null, source_observation_id: null } : {}) });
        }
      };
      try {
        await attempt(withSource);
        if (withSource) this.#pointerHasSourceColumns = true;
      } catch (e) {
        if (!withSource || !isPointerSchemaLegacy(e)) throw e;
        this.#markLegacy();
        await attempt(false);
      }

      // If this write won the pointer race, make the normalized artifact
      // immediately reusable by every other analytical stage in this process.
      if (pointerInserted.length > 0 || pointerAdvanced.length > 0) {
        this.#cacheNewerOrEqual(this.#scopeKey(scope), {
          artifact,
          observed_at: observedAt,
          source_observed_at: sourceAt,
          source_observation_id: sourceId,
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
