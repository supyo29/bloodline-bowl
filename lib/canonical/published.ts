/**
 * The authoritative published-snapshot accessor.
 *
 * Answers the one question the real-time-state phase exists for:
 *   "Which already-certified snapshot IS the current league reality, how fresh
 *    is it, and are all consumers reading the same generation?"
 *
 * It does NOT invent a new canonical model. The pipeline is:
 *
 *   buildCanonicalLeagueState()      ← existing ingestion + lineage (unchanged)
 *        ↓  candidate
 *   reconcilePublishCandidate()      ← existing certify() + integrity gate
 *        ↓  certified
 *   SnapshotStore.put()              ← existing immutable store (unchanged)
 *        ↓
 *   PublishedPointerStore.advance()  ← NEW durable atomic pointer
 *        ↓
 *   published snapshot + freshness   → state-sensitive Bridge surfaces
 *
 * Authority lives in the durable pointer row, not in any process-local or
 * Next-cache state. A failed candidate never advances the pointer; snapshot N
 * stays authoritative and the response is marked DEGRADED with a reason.
 *
 * Stage B: this primitive is complete and tested but NOTHING in `app/` calls it
 * yet — route adoption is gated by `publishedSnapshotEnabled()` from Stage E on.
 */

import { buildCanonicalLeagueState, type CanonicalStateResult } from "./state";
import { reconcilePublishCandidate, formatReconcileFailure, type ReconcileResult } from "./reconcile";
import { snapshotContentHash, leagueSnapshotId } from "@/lib/persistence/serialize";
import {
  deriveFreshness,
  type Freshness,
  type RefreshMode,
  type SourceStatus,
  type DegradedReason,
} from "./freshness";
import { resolveRefreshPolicy, type RefreshPolicy, type RefreshSignals } from "./refresh-policy";
import { emitBridgeEvent } from "@/lib/observability/events";
import { getPersistence } from "@/lib/persistence";
import type { PersistenceBundle, PublishedPointer } from "@/lib/persistence/types";
import { resolveLeagueStrict } from "@/lib/leagues/resolve";
import type { CanonicalLeagueSnapshot } from "./schema";

export type PublishOutcome =
  | "reused" // pointer still within its reuse window; served as-is
  | "published" // built a new candidate, certified it, advanced the pointer
  | "unchanged" // built a candidate identical to the current pointer
  | "raced" // another instance advanced the pointer first; served the winner
  | "rejected" // candidate failed the gate; served the prior published snapshot
  | "uncertified" // candidate failed the gate and there is NO prior snapshot
  | "source_unavailable"; // provider read failed; served the prior published snapshot (if any)

export interface PublishedSnapshotResult {
  ok: boolean;
  status: number;
  code?: string;
  detail?: string;
  outcome: PublishOutcome;
  snapshot: CanonicalLeagueSnapshot | null;
  freshness: Freshness;
  pointer: PublishedPointer | null;
  policy: RefreshPolicy;
  reconcile?: ReconcileResult;
}

export interface PublishedSnapshotOptions {
  /** Force a specific mode; otherwise derived from `signals`. */
  mode?: RefreshMode;
  signals?: RefreshSignals;
  /** Operator/forced refresh — bypass the reuse window, always rebuild. */
  forced?: boolean;
  persistence?: PersistenceBundle;
  /** Test seam: supply the candidate build instead of hitting a provider. */
  buildOverride?: () => Promise<CanonicalStateResult>;
  /** Clock injection for tests. */
  now?: number;
}

function ageOf(basis: string | null | undefined, now: number): number | null {
  if (!basis) return null;
  const t = Date.parse(basis);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 1000));
}

export async function getPublishedLeagueSnapshot(
  leagueSlug: string,
  options: PublishedSnapshotOptions = {},
): Promise<PublishedSnapshotResult> {
  const now = options.now ?? Date.now();
  const policy = options.mode
    ? { ...resolveRefreshPolicy({ ...options.signals, forced: options.forced }), mode: options.mode }
    : resolveRefreshPolicy({ ...options.signals, forced: options.forced });

  const resolution = resolveLeagueStrict(leagueSlug);
  if (!resolution.ok) {
    return {
      ok: false,
      status: resolution.status,
      code: resolution.code,
      detail: resolution.detail,
      outcome: "source_unavailable",
      snapshot: null,
      pointer: null,
      policy,
      freshness: deriveFreshness({
        mode: policy.mode,
        degraded_reason: "NO_PUBLISHED_SNAPSHOT",
        source_status: "AVAILABLE",
        notes: [resolution.detail],
        now,
      }),
    };
  }
  const { league_slug, season } = resolution.league;
  const persistence = options.persistence ?? getPersistence();

  const pointer = await persistence.published.get(league_slug, season).catch(() => null);
  const priorAge = pointer
    ? ageOf(pointer.source_provider_synced_at ?? pointer.published_at, now)
    : null;

  const mustRebuild =
    !!options.forced ||
    !pointer ||
    priorAge == null ||
    priorAge > policy.rebuild_after_seconds;

  // --- reuse path -----------------------------------------------------------
  if (!mustRebuild && pointer) {
    const stored = await persistence.snapshots.getById(pointer.snapshot_id).catch(() => null);
    emitBridgeEvent("snapshot_reused", {
      league_slug,
      snapshot_id: pointer.league_snapshot_id,
      age_seconds: priorAge,
      mode: policy.mode,
    });
    return {
      ok: true,
      status: 200,
      outcome: "reused",
      snapshot: stored?.payload ?? null,
      pointer,
      policy,
      freshness: freshnessFor(pointer, policy.mode, "AVAILABLE", null, now),
    };
  }

  // --- rebuild path --------------------------------------------------------
  emitBridgeEvent("refresh_started", { league_slug, mode: policy.mode, forced: !!options.forced });
  const built = options.buildOverride
    ? await options.buildOverride()
    : await buildCanonicalLeagueState(league_slug, {
        includeMatchups: true,
        includeRecentTransactions: true,
        reportPersistence: false,
      });

  if (!built.ok || !built.snapshot || built.snapshot.teams.length === 0) {
    emitBridgeEvent("source_unavailable", {
      league_slug,
      detail: built.detail ?? built.snapshot?.live_provider_status ?? "no snapshot",
    });
    emitBridgeEvent("refresh_failed", { league_slug, reason: "provider_unavailable" });
    return await servePrior(
      persistence,
      pointer,
      policy,
      "source_unavailable",
      "SOURCE_UNAVAILABLE",
      "REFRESH_FAILED",
      built.detail ?? "provider returned no usable snapshot",
      now,
      built.snapshot,
    );
  }

  const candidate = built.snapshot;
  const reconcile = reconcilePublishCandidate(candidate);

  if (!reconcile.ok) {
    const reason: DegradedReason =
      reconcile.discrepancies.length > 0 ? "RECONCILIATION_DISCREPANCY" : "CERTIFICATION_FAILED";
    emitBridgeEvent("snapshot_rejected", {
      league_slug,
      reason,
      detail: formatReconcileFailure(reconcile),
    });
    if (reconcile.discrepancies.length > 0) {
      emitBridgeEvent("cross_surface_discrepancy", {
        league_slug,
        count: reconcile.discrepancies.length,
        detail: formatReconcileFailure(reconcile),
      });
    }
    emitBridgeEvent("refresh_failed", { league_slug, reason });
    const served = await servePrior(
      persistence,
      pointer,
      policy,
      pointer ? "rejected" : "uncertified",
      "AVAILABLE",
      reason,
      formatReconcileFailure(reconcile),
      now,
      pointer ? null : candidate,
    );
    return { ...served, reconcile };
  }

  // Certified — persist the immutable snapshot, then advance the pointer.
  const put = await persistence.snapshots.put(candidate, { capture_type: "AD_HOC" });
  if (put.outcome === "error" || !put.meta) {
    emitBridgeEvent("refresh_failed", { league_slug, reason: "snapshot_put_failed", detail: put.error ?? "" });
    const served = await servePrior(
      persistence,
      pointer,
      policy,
      "source_unavailable",
      "DEGRADED",
      "REFRESH_FAILED",
      `snapshot store rejected the candidate: ${put.error ?? "unknown"}`,
      now,
      pointer ? null : candidate,
    );
    return { ...served, reconcile };
  }
  if (put.outcome === "created") {
    emitBridgeEvent("snapshot_created", { league_slug, snapshot_id: leagueSnapshotId(candidate) });
  }

  const contentHash = snapshotContentHash(candidate);
  const advance = await persistence.published.advance(
    {
      league_slug,
      season,
      snapshot_id: put.meta.id,
      league_snapshot_id: leagueSnapshotId(candidate),
      content_hash: contentHash,
      week: candidate.week,
      source_provider_synced_at: candidate.provider_synced_at,
      schema_version: candidate.schema_version,
    },
    pointer?.published_seq ?? 0,
  );

  if (advance.outcome === "error") {
    emitBridgeEvent("refresh_failed", { league_slug, reason: "pointer_advance_failed", detail: advance.error ?? "" });
    const served = await servePrior(
      persistence,
      pointer,
      policy,
      "source_unavailable",
      "DEGRADED",
      "REFRESH_FAILED",
      `published pointer advance failed: ${advance.error ?? "unknown"}`,
      now,
      pointer ? null : candidate,
    );
    return { ...served, reconcile };
  }

  if (advance.outcome === "raced") {
    emitBridgeEvent("pointer_race_lost", { league_slug, winner: advance.pointer?.league_snapshot_id ?? null });
    const winnerSnap = advance.pointer
      ? await persistence.snapshots.getById(advance.pointer.snapshot_id).catch(() => null)
      : null;
    return {
      ok: true,
      status: 200,
      outcome: "raced",
      snapshot: winnerSnap?.payload ?? candidate,
      pointer: advance.pointer,
      policy,
      reconcile,
      freshness: advance.pointer
        ? freshnessFor(advance.pointer, policy.mode, "AVAILABLE", null, now)
        : freshnessFor(null, policy.mode, "AVAILABLE", "REFRESH_FAILED", now),
    };
  }

  const changed = !pointer || pointer.content_hash !== contentHash;
  emitBridgeEvent(changed ? "source_changed" : "source_unchanged", {
    league_slug,
    snapshot_id: leagueSnapshotId(candidate),
    previous_snapshot_id: pointer?.league_snapshot_id ?? null,
  });
  emitBridgeEvent("snapshot_published", {
    league_slug,
    snapshot_id: advance.pointer?.league_snapshot_id ?? leagueSnapshotId(candidate),
    published_seq: advance.pointer?.published_seq ?? null,
    outcome: advance.outcome,
  });
  emitBridgeEvent("refresh_completed", { league_slug, mode: policy.mode, changed });

  return {
    ok: true,
    status: 200,
    outcome: advance.outcome === "unchanged" ? "unchanged" : "published",
    snapshot: candidate,
    pointer: advance.pointer,
    policy,
    reconcile,
    freshness: advance.pointer
      ? freshnessFor(advance.pointer, policy.mode, "AVAILABLE", null, now)
      : deriveFreshness({
          mode: policy.mode,
          source_synced_at: candidate.provider_synced_at,
          published_at: candidate.captured_at,
          snapshot_id: leagueSnapshotId(candidate),
          content_hash: contentHash,
          certified: true,
          source_status: "AVAILABLE",
          now,
        }),
  };
}

function freshnessFor(
  pointer: PublishedPointer | null,
  mode: RefreshMode,
  sourceStatus: SourceStatus,
  degradedReason: DegradedReason | null,
  now: number,
): Freshness {
  if (!pointer) {
    return deriveFreshness({
      mode,
      degraded_reason: degradedReason ?? "NO_PUBLISHED_SNAPSHOT",
      source_status: sourceStatus,
      now,
    });
  }
  return deriveFreshness({
    mode,
    source_synced_at: pointer.source_provider_synced_at,
    published_at: pointer.published_at,
    snapshot_id: pointer.league_snapshot_id,
    content_hash: pointer.content_hash,
    certified: pointer.certified,
    source_status: sourceStatus,
    degraded_reason: degradedReason,
    now,
  });
}

async function servePrior(
  persistence: PersistenceBundle,
  pointer: PublishedPointer | null,
  policy: RefreshPolicy,
  outcome: PublishOutcome,
  sourceStatus: SourceStatus,
  degradedReason: DegradedReason,
  detail: string,
  now: number,
  fallbackSnapshot: CanonicalLeagueSnapshot | null,
): Promise<PublishedSnapshotResult> {
  const prior = pointer
    ? await persistence.snapshots.getById(pointer.snapshot_id).catch(() => null)
    : null;

  if (pointer && prior) {
    emitBridgeEvent("stale_snapshot_served", {
      league_slug: pointer.league_slug,
      snapshot_id: pointer.league_snapshot_id,
      reason: degradedReason,
    });
  }

  return {
    ok: !!(pointer && prior), // authoritative state still exists ⇒ ok:true, degraded
    status: pointer && prior ? 200 : 503,
    code: pointer && prior ? undefined : "no_published_snapshot",
    detail,
    outcome,
    snapshot: prior?.payload ?? fallbackSnapshot,
    pointer,
    policy,
    freshness: freshnessFor(
      pointer,
      policy.mode,
      sourceStatus,
      pointer ? degradedReason : "NO_PUBLISHED_SNAPSHOT",
      now,
    ),
  };
}
