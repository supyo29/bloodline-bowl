/**
 * Canonical projection provider wrapper: durable snapshots + the W1.P4 freshness authority.
 *
 * Read path:
 *   request-scope memo hit            -> the SAME resolved batch (one evidence set per logical request)
 *   durable snapshot whose SOURCE observation satisfies the policy and is not superseded by an event -> serve it
 *   otherwise                         -> live provider (told how old the source may be) -> best-effort persist -> serve
 *   live failed                       -> last known snapshot, MARKED STALE with the failed refresh recorded (never zero/healthy/unknown)
 *
 * How old a source observation may be is NOT decided here: `freshness/policy.ts` decides it from the next kickoff (absolute NFL instants),
 * injury relevance and invalidation events. The wrapper never turns a persistence failure into projection unavailability, and a provider
 * failure is never converted into football information.
 *
 * Honest limits: there is no background revalidation runner in this architecture, so a stale-but-usable response is only ever served
 * AFTER a synchronous refresh attempt has failed, and it says so. Nothing here is asynchronous revalidation.
 */

import { contentHash } from "@/lib/bridge/hash";
import { getProjectionSnapshotStore } from "@/lib/persistence/supabase/projection-snapshot";
import { activeProjectionScope } from "@/lib/canonical/request-scope";
import { InvalidationLedger, type InvalidationEvent } from "../freshness/events";
import { nextKickoff, type KickoffGame, type KickoffSource } from "../freshness/kickoff";
import { requiredMaxAgeForBatch, STALE_FALLBACK_MAX_AGE_MS, type RefreshOutcome } from "../freshness/policy";
import type { WeeklyProjectionBatch, WeeklyWarning } from "../schema";
import type { ProjectionProvider, ProjectionRequest } from "./types";
import { projectionSnapshotScope, type ProjectionSnapshotStore } from "./canonical-snapshot";

function info(code: string, message: string): WeeklyWarning {
  return { code, message, severity: "info" };
}

/** Everything time- and event-related is injected so freshness behaviour is deterministic under test. */
export interface FreshnessDeps {
  now?: () => number;
  /** NFL kickoff source. null/absent => kickoff unknown => the conservative KICKOFF_UNKNOWN tier (never "far away"). */
  kickoffSource?: KickoffSource | null;
  /** events learned in this process (from observation diffs / official inactives / manual). */
  ledger?: InvalidationLedger;
}

/** events older than this no longer describe the current week's state for serving decisions */
const EVENT_HORIZON_MS = 48 * 60 * 60 * 1000;

export class CanonicalProjectionSnapshotProvider implements ProjectionProvider {
  readonly name: string;
  readonly model_version: string;
  readonly #now: () => number;
  readonly #kickoff: KickoffSource | null;
  readonly #ledger: InvalidationLedger;

  constructor(
    private readonly live: ProjectionProvider,
    private readonly store: ProjectionSnapshotStore = getProjectionSnapshotStore(),
    deps: FreshnessDeps = {},
  ) {
    this.name = live.name;
    this.model_version = live.model_version;
    this.#now = deps.now ?? Date.now;
    this.#kickoff = deps.kickoffSource ?? null;
    this.#ledger = deps.ledger ?? new InvalidationLedger();
  }

  get ledger(): InvalidationLedger {
    return this.#ledger;
  }

  #events(nowMs: number): InvalidationEvent[] {
    return this.#ledger.all().filter((e) => nowMs - Date.parse(e.known_at) <= EVENT_HORIZON_MS);
  }

  /** attach the inputs the per-forecast freshness authority needs; the batch's values are untouched */
  #withContext(
    batch: WeeklyProjectionBatch,
    nowMs: number,
    games: KickoffGame[] | null,
    refresh: RefreshOutcome | null,
    batchPolicy: { tier: string; required_max_age_ms: number },
  ): WeeklyProjectionBatch {
    return {
      ...batch,
      freshness_context: {
        now_ms: nowMs,
        game_clock: games ? { games, source: this.#kickoff?.name ?? "unknown" } : null,
        events: this.#events(nowMs),
        refresh,
        batch_policy: batchPolicy,
      },
    };
  }

  async getWeeklyProjections(req: ProjectionRequest): Promise<WeeklyProjectionBatch> {
    // The request fingerprint includes crosswalk.version. Load it before ANY
    // snapshot scope is computed so readLatest() and a later record() cannot
    // disagree merely because the live provider initialized the crosswalk.
    await req.crosswalk.ensureLoaded();
    const policy = req.projection_snapshot_policy ?? "prefer";

    // ---- request-scoped consistency: one logical operation resolves a given league/week/scoring batch ONCE -------------------
    // The memo holds a PRISTINE batch that is never handed out; every caller (including the first) receives its own clone, because
    // downstream assembly (bye override, ROS signals) mutates batches in place and must not leak into another section of the same request.
    const scope = activeProjectionScope();
    const scopeKey = (() => {
      const s = projectionSnapshotScope(req);
      return `batch|${s.league_slug}|${s.season}|${s.week}|${s.scoring_fingerprint}|${s.request_fingerprint}|${contentHash([...req.canonical_player_ids].sort()).slice(0, 16)}`;
    })();
    if (scope && policy === "prefer") {
      let memo = scope.get(scopeKey) as Promise<WeeklyProjectionBatch> | undefined;
      const hit = memo != null;
      if (!memo) {
        memo = this.#resolve(req, policy);
        scope.set(scopeKey, memo);
      }
      const resolved = structuredClone(await memo);
      return hit && resolved.canonical_snapshot ? { ...resolved, canonical_snapshot: { ...resolved.canonical_snapshot, read_path: "REQUEST_MEMO" } } : resolved;
    }
    const result = await this.#resolve(req, policy);
    // a forced refresh becomes the request's evidence for everyone who follows
    if (scope && policy !== "bypass") scope.set(scopeKey, Promise.resolve(structuredClone(result)));
    return result;
  }

  async #resolve(req: ProjectionRequest, policy: NonNullable<ProjectionRequest["projection_snapshot_policy"]>): Promise<WeeklyProjectionBatch> {
    const nowMs = this.#now();
    const season = req.league.season;
    const week = req.week;

    // ---- kickoff + the batch-level freshness requirement (next not-yet-started kickoff governs a league-wide snapshot) ------------
    let games: KickoffGame[] | null = null;
    try {
      games = this.#kickoff ? await this.#kickoff.getWeekGames(season, week) : null;
    } catch {
      games = null;
    }
    const nk = games ? nextKickoff(games, nowMs) : null;
    const batchPolicy = requiredMaxAgeForBatch({
      now_ms: nowMs,
      next_kickoff_at: nk?.next_kickoff_at ?? null,
      kickoff_known: games != null && !nk?.any_unknown_kickoff,
      any_injury_uncertain: true, // a league-wide batch always contains designated players
    });

    let readFailure: string | null = null;
    // events learned after the snapshot's source observation supersede it, whatever its age
    const supersedingSince = (sourceObservedAt: string | null): InvalidationEvent[] => {
      const t = sourceObservedAt ? Date.parse(sourceObservedAt) : NaN;
      return this.#events(nowMs).filter((e) => (e.scope.kind === "PLAYER" || e.scope.kind === "TEAM" || e.scope.kind === "GAME" || e.scope.kind === "SOURCE_SNAPSHOT") && (!Number.isFinite(t) || Date.parse(e.known_at) > t));
    };

    if (policy === "prefer") {
      try {
        const hit = await this.store.readLatest(req, { maxAgeMs: batchPolicy.required_max_age_ms, now: () => nowMs });
        if (hit) {
          const superseded = supersedingSince(hit.source_observed_at ?? null);
          // double-check the gate for stores that do not enforce it themselves
          const ok = hit.age_ms <= batchPolicy.required_max_age_ms && superseded.length === 0;
          if (ok) return this.#withContext(hit.batch, nowMs, games, null, batchPolicy);
          if (superseded.length > 0) readFailure = `snapshot superseded by ${superseded.length} newer source event(s)`;
        }
      } catch (error) {
        readFailure = error instanceof Error ? error.message : String(error);
      }
    }

    // a live source older than the event that superseded the snapshot is useless: demand an observation newer than the newest event
    const newestEventMs = this.#events(nowMs).reduce((m, e) => Math.max(m, Date.parse(e.known_at)), 0);
    const maxSourceAge = Math.max(0, Math.min(batchPolicy.required_max_age_ms, newestEventMs > 0 ? nowMs - newestEventMs - 1 : Infinity));
    const liveBatch = await this.live.getWeeklyProjections({ ...req, max_source_age_ms: policy === "refresh" ? 0 : maxSourceAge });
    const readPath = policy === "refresh" ? "LIVE_REFRESH" : policy === "bypass" ? "LIVE_BYPASS" : "LIVE_FALLBACK";

    // ---- refresh failed: retain the last known forecast, marked STALE — never zero / healthy / unknown / unavailable -------------
    if (liveBatch.status === "PROJECTIONS_UNAVAILABLE" || liveBatch.by_player.size === 0) {
      if (policy !== "bypass") {
        try {
          const last = await this.store.readLatest(req, { allowStale: true, now: () => nowMs });
          const lastObserved = last ? last.source_observed_at ?? last.observed_at : null;
          if (last && lastObserved && nowMs - Date.parse(lastObserved) <= STALE_FALLBACK_MAX_AGE_MS) {
            const reason = liveBatch.warnings.find((w) => w.severity === "error")?.message ?? "live projection source unavailable";
            const refresh: RefreshOutcome = { attempted: true, succeeded: false, failed_at: new Date(nowMs).toISOString(), reason };
            const stale: WeeklyProjectionBatch = {
              ...last.batch,
              warnings: [
                ...last.batch.warnings,
                { code: "projection_refresh_failed_using_last_known", message: `Latest projection refresh failed (${reason}); serving the last known snapshot observed at ${lastObserved}. Treat as STALE.`, severity: "warning" },
              ],
              canonical_snapshot: last.batch.canonical_snapshot ? { ...last.batch.canonical_snapshot, read_path: "SUPABASE_STALE_FALLBACK" } : last.batch.canonical_snapshot,
            };
            return this.#withContext(stale, nowMs, games, refresh, batchPolicy);
          }
        } catch {
          /* no usable last-known snapshot: fall through to the honest unavailable batch */
        }
      }
      const refresh: RefreshOutcome = { attempted: true, succeeded: false, failed_at: new Date(nowMs).toISOString(), reason: liveBatch.warnings.find((w) => w.severity === "error")?.message ?? "live projection source unavailable" };
      return this.#withContext(liveBatch, nowMs, games, refresh, batchPolicy);
    }

    let snapshot = {
      read_path: readPath as NonNullable<WeeklyProjectionBatch["canonical_snapshot"]>["read_path"],
      artifact_id: null as string | null,
      observed_at: null as string | null,
      age_ms: null as number | null,
      durable: false,
      source_observed_at: liveBatch.source_observation?.observed_at ?? null,
    };
    const warnings = [...liveBatch.warnings];

    if (readFailure) {
      warnings.push(
        info(
          "canonical_projection_snapshot_read_failed",
          `Canonical projection snapshot not served (${readFailure}); live projection fallback remained available.`,
        ),
      );
    }

    if (policy !== "bypass") {
      const observedAt = new Date(nowMs).toISOString();
      const written = await this.store.record(req, liveBatch, observedAt);
      const sourceAt = liveBatch.source_observation?.observed_at ?? null;
      snapshot = {
        read_path: readPath,
        artifact_id: written.artifact_id,
        observed_at: written.observed_at,
        // age of the SOURCE (a payload re-served from the process cache is older than "0" even though the snapshot was just written)
        age_ms: sourceAt ? Math.max(0, nowMs - Date.parse(sourceAt)) : 0,
        durable: written.durable && (written.status === "INSERTED" || written.status === "DUPLICATE_IDENTICAL"),
        source_observed_at: sourceAt,
      };
      if (written.status === "ERROR" || written.status === "NOT_CONFIGURED") {
        warnings.push(
          info(
            "canonical_projection_snapshot_write_unavailable",
            written.error ?? `Canonical projection snapshot write status: ${written.status}.`,
          ),
        );
      }
    }

    return this.#withContext({ ...liveBatch, warnings, canonical_snapshot: snapshot }, nowMs, games, { attempted: policy !== "bypass", succeeded: true, failed_at: null, reason: null }, batchPolicy);
  }
}
