/**
 * Stage E — the publication orchestrator.
 *
 * `publishLeagueSnapshot(slug, { trigger })` is the ONE entry point that both
 * `POST /api/refresh` and `/api/cron/publish` call. It:
 *
 *   1. resolves the league (unknown slug ⇒ 404, NOTHING written);
 *   2. reads the prior pointer (for the audit + the concurrency guard);
 *   3. runs `getPublishedLeagueSnapshot` (real persistence, NOT dry-run):
 *        build → reconcile gate → immutable SnapshotStore.put → atomic
 *        published_seq-guarded pointer advance;
 *   4. records ONE audit row (best-effort — an audit failure never fails a
 *      publish, and never advances/retracts the pointer);
 *   5. returns an operational result with an HTTP status that is NEVER 200 for
 *      a failed publication.
 *
 * It changes no model, scoring, trade, waiver, Team-State, or canonical-state
 * semantics — it only sequences the existing Stage B machinery and audits it.
 */

import { getPublishedLeagueSnapshot, type PublishOutcome } from "./published";
import type { CanonicalStateResult } from "./state";
import { assessCapabilities, type CapabilityReport } from "./capabilities";
import { formatReconcileFailure } from "./reconcile";
import type { RefreshSignals } from "./refresh-policy";
import type { Freshness, RefreshMode } from "./freshness";
import { emitBridgeEvent } from "@/lib/observability/events";
import { getPersistence } from "@/lib/persistence";
import type { PersistenceBundle, PublicationAudit, PublishedPointer } from "@/lib/persistence/types";
import { resolveLeagueStrict } from "@/lib/leagues/resolve";

export interface PublishResult {
  ok: boolean;
  /** HTTP status for the route. NEVER 200 on a failed publication. */
  http_status: number;
  league_slug: string;
  season: number;
  outcome: PublishOutcome;
  snapshot_id: string | null;
  content_hash: string | null;
  pointer: PublishedPointer | null;
  prior_pointer_seq: number | null;
  resulting_pointer_seq: number | null;
  pointer_advanced: boolean;
  snapshot_persisted: PublicationAudit["snapshot_persisted"];
  integrity: "CERTIFIED" | "REJECTED" | null;
  validation_detail: string | null;
  source_status: string;
  error_category: string | null;
  detail: string | null;
  freshness: Freshness;
  capabilities: CapabilityReport | null;
  duration_ms: number;
  attempted_at: string;
  audit_id: string | null;
}

export interface PublishOptions {
  trigger: PublicationAudit["trigger"];
  /** Force a rebuild even inside the reuse window (operator refresh). Default true. */
  forced?: boolean;
  mode?: RefreshMode;
  signals?: RefreshSignals;
  persistence?: PersistenceBundle;
  /** Test seam: supply the candidate build instead of hitting a provider. */
  buildOverride?: () => Promise<CanonicalStateResult>;
  now?: number;
}

function errorCategory(
  outcome: PublishOutcome,
  failureKind?: "PROVIDER" | "CERTIFICATION" | "PERSISTENCE" | "POINTER",
): string | null {
  switch (outcome) {
    case "published":
    case "unchanged":
    case "reused":
    case "raced":
      return null;
    case "rejected":
    case "uncertified":
      return "CERTIFICATION_FAILED";
    case "source_unavailable":
      return failureKind === "PERSISTENCE"
        ? "PERSISTENCE_UNAVAILABLE"
        : failureKind === "POINTER"
          ? "POINTER_ADVANCE_FAILED"
          : "PROVIDER_UNAVAILABLE";
    case "dry_run":
      return "DRY_RUN";
    default:
      return "UNKNOWN";
  }
}

/** HTTP status per outcome — never 200 for a publication that did not succeed. */
function httpStatus(outcome: PublishOutcome, priorPointerPresent: boolean): number {
  switch (outcome) {
    case "published":
    case "unchanged":
    case "raced":
      return 200;
    case "rejected":
    case "uncertified":
      return 422; // candidate failed validation
    case "source_unavailable":
      // The operation failed to publish. LKG (if any) is intact, but this is
      // not a success — 503, not 200.
      return priorPointerPresent ? 503 : 503;
    case "reused":
      return 200; // (only reachable when forced:false and inside the reuse window)
    default:
      return 500;
  }
}

export async function publishLeagueSnapshot(
  leagueSlug: string,
  opts: PublishOptions,
): Promise<PublishResult> {
  const attemptedAt = new Date(opts.now ?? Date.now()).toISOString();
  const persistence = opts.persistence ?? getPersistence();

  const resolution = resolveLeagueStrict(leagueSlug);
  if (!resolution.ok) {
    // Unknown / unresolvable slug — reject BEFORE touching any store.
    return {
      ok: false,
      http_status: resolution.status === 400 ? 400 : 404,
      league_slug: leagueSlug,
      season: 0,
      outcome: "source_unavailable",
      snapshot_id: null,
      content_hash: null,
      pointer: null,
      prior_pointer_seq: null,
      resulting_pointer_seq: null,
      pointer_advanced: false,
      snapshot_persisted: "not_attempted",
      integrity: null,
      validation_detail: null,
      source_status: "UNRESOLVED_LEAGUE",
      error_category: "UNKNOWN_LEAGUE",
      detail: resolution.detail,
      freshness: {
        status: "UNKNOWN",
        source_status: "AVAILABLE",
        mode: opts.mode ?? "NORMAL",
        age_seconds: null,
        published_at: null,
        source_synced_at: null,
        snapshot_id: null,
        content_hash: null,
        certified: false,
        degraded_reason: "NO_PUBLISHED_SNAPSHOT",
        thresholds: { fresh_seconds: 0, acceptable_seconds: 0 },
        notes: [resolution.detail],
      },
      capabilities: null,
      duration_ms: 0,
      attempted_at: attemptedAt,
      audit_id: null,
    };
  }
  const { league_slug, season } = resolution.league;

  const prior = await persistence.published.get(league_slug, season).catch(() => null);

  emitBridgeEvent("refresh_started", {
    league_slug,
    trigger: opts.trigger,
    forced: opts.forced ?? true,
    prior_pointer_seq: prior?.published_seq ?? null,
  });

  const t0 = Date.now();
  const res = await getPublishedLeagueSnapshot(league_slug, {
    persistence,
    forced: opts.forced ?? true,
    mode: opts.mode,
    signals: opts.signals,
    buildOverride: opts.buildOverride,
    now: opts.now,
  });
  const duration_ms = Date.now() - t0;

  const pointer = res.pointer;
  const resultingSeq = pointer?.published_seq ?? null;
  const priorSeq = prior?.published_seq ?? null;
  const pointerAdvanced = (resultingSeq ?? 0) > (priorSeq ?? 0);

  const integrity: "CERTIFIED" | "REJECTED" | null =
    res.reconcile?.capabilities.snapshot_integrity ??
    (res.capabilities?.snapshot_integrity ?? null);

  const validationDetail =
    res.reconcile && !res.reconcile.ok ? formatReconcileFailure(res.reconcile) : null;

  const snapshotPersisted: PublicationAudit["snapshot_persisted"] =
    res.snapshot_put_outcome === "created"
      ? "created"
      : res.snapshot_put_outcome === "duplicate"
        ? "duplicate"
        : res.snapshot_put_outcome === "error"
          ? "error"
          : res.outcome === "rejected" || res.outcome === "uncertified"
            ? "skipped"
            : "not_attempted";

  const outcome = res.outcome;
  const httpStatusCode = httpStatus(outcome, !!prior);
  const published = outcome === "published" || outcome === "unchanged" || outcome === "raced";

  const capabilities =
    res.capabilities ?? (res.snapshot ? assessCapabilities(res.snapshot) : null);

  const audit: PublicationAudit = {
    league_slug,
    season,
    trigger: opts.trigger,
    attempted_at: attemptedAt,
    finished_at: new Date().toISOString(),
    duration_ms,
    outcome,
    ok: published,
    candidate_snapshot_id: res.freshness.snapshot_id ?? pointer?.league_snapshot_id ?? null,
    candidate_content_hash: res.freshness.content_hash ?? pointer?.content_hash ?? null,
    prior_pointer_seq: priorSeq,
    resulting_pointer_seq: resultingSeq,
    pointer_advanced: pointerAdvanced,
    snapshot_persisted: snapshotPersisted,
    integrity,
    validation_detail: validationDetail,
    source_status: res.freshness.source_status,
    error_category: errorCategory(outcome, res.failure_kind),
    error: published ? null : (res.detail ?? validationDetail ?? null),
  };

  const recorded = await persistence.publication_audit.record(audit).catch(() => ({ id: null }));

  emitBridgeEvent(published ? "refresh_completed" : "refresh_failed", {
    league_slug,
    outcome,
    pointer_advanced: pointerAdvanced,
    resulting_pointer_seq: resultingSeq,
    duration_ms,
    error_category: audit.error_category,
  });

  return {
    ok: published,
    http_status: httpStatusCode,
    league_slug,
    season,
    outcome,
    snapshot_id: audit.candidate_snapshot_id,
    content_hash: audit.candidate_content_hash,
    pointer,
    prior_pointer_seq: priorSeq,
    resulting_pointer_seq: resultingSeq,
    pointer_advanced: pointerAdvanced,
    snapshot_persisted: snapshotPersisted,
    integrity,
    validation_detail: validationDetail,
    source_status: res.freshness.source_status,
    error_category: audit.error_category,
    detail: audit.error,
    freshness: res.freshness,
    capabilities,
    duration_ms,
    attempted_at: attemptedAt,
    audit_id: recorded.id ?? null,
  };
}
