/**
 * Freshness classification for a published league snapshot.
 *
 * Two DISTINCT axes, never collapsed into one:
 *   - `source_status`  — can we reach the provider at all right now?
 *   - `status`         — how usable is the state we are serving?
 *
 * So `{ status: "STALE", source_status: "AVAILABLE" }` (nobody has refreshed in a
 * while, but Sleeper is fine) is a different situation from
 * `{ status: "SOURCE_UNAVAILABLE", source_status: "SOURCE_UNAVAILABLE" }`
 * (we are pinned to the last good snapshot because Sleeper is down), and both are
 * different from `{ status: "DEGRADED", degraded_reason: "CERTIFICATION_FAILED" }`
 * (a fresh candidate existed but failed an integrity gate, so we kept snapshot N).
 *
 * `DEGRADED` is NOT an age bucket — it always carries a `degraded_reason`.
 *
 * This module is pure. It does no I/O and imports nothing from the provider or
 * persistence layers.
 */

export type RefreshMode = "NORMAL" | "HIGH_ACTIVITY" | "LIVE_DRAFT";

export type FreshnessStatus =
  | "FRESH"
  | "ACCEPTABLE"
  | "STALE"
  | "REFRESHING"
  | "DEGRADED"
  | "SOURCE_UNAVAILABLE"
  /** No published snapshot exists yet — age is genuinely unknown, NOT stale. */
  | "UNKNOWN";

export type SourceStatus = "AVAILABLE" | "DEGRADED" | "SOURCE_UNAVAILABLE";

export type DegradedReason =
  | "REFRESH_FAILED"
  | "CERTIFICATION_FAILED"
  | "RECONCILIATION_DISCREPANCY"
  | "PARTIAL_PROVIDER"
  | "NO_PUBLISHED_SNAPSHOT";

/** Age boundaries per mode, in seconds. `> acceptable` ⇒ STALE. */
export const FRESHNESS_THRESHOLDS: Record<
  RefreshMode,
  { fresh_seconds: number; acceptable_seconds: number }
> = {
  NORMAL: { fresh_seconds: 120, acceptable_seconds: 600 },
  HIGH_ACTIVITY: { fresh_seconds: 30, acceptable_seconds: 90 },
  LIVE_DRAFT: { fresh_seconds: 10, acceptable_seconds: 30 },
};

export interface Freshness {
  status: FreshnessStatus;
  source_status: SourceStatus;
  mode: RefreshMode;
  /** Seconds since the published snapshot's provider sync (or publish time). */
  age_seconds: number | null;
  published_at: string | null;
  source_synced_at: string | null;
  /** Deterministic `snap:...` id of the published snapshot. */
  snapshot_id: string | null;
  content_hash: string | null;
  certified: boolean;
  degraded_reason: DegradedReason | null;
  thresholds: { fresh_seconds: number; acceptable_seconds: number };
  notes: string[];
}

export interface DeriveFreshnessInput {
  mode: RefreshMode;
  /** Preferred age basis: provider sync time of the published snapshot. */
  source_synced_at?: string | null;
  /** Fallback age basis when no provider sync stamp exists. */
  published_at?: string | null;
  snapshot_id?: string | null;
  content_hash?: string | null;
  certified?: boolean;
  /** True while a refresh for this league is known to be in flight. */
  refreshing?: boolean;
  /** Provider reachability observed on the most recent refresh attempt. */
  source_status?: SourceStatus;
  /** Set when a fresh candidate was rejected — pins us to the prior snapshot. */
  degraded_reason?: DegradedReason | null;
  /** Extra human-readable context (warning codes, rejection detail). */
  notes?: string[];
  /** Clock injection for tests. */
  now?: number;
}

function ageSeconds(basis: string | null | undefined, now: number): number | null {
  if (!basis) return null;
  const t = Date.parse(basis);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}

export function deriveFreshness(input: DeriveFreshnessInput): Freshness {
  const now = input.now ?? Date.now();
  const thresholds = FRESHNESS_THRESHOLDS[input.mode];
  const sourceStatus: SourceStatus = input.source_status ?? "AVAILABLE";
  const notes = [...(input.notes ?? [])];

  const basis = input.source_synced_at ?? input.published_at ?? null;
  const age = ageSeconds(basis, now);

  let status: FreshnessStatus;
  if (sourceStatus === "SOURCE_UNAVAILABLE") {
    // The provider is unreachable — that is the most useful thing to report,
    // whether or not a prior snapshot exists to fall back to.
    status = "SOURCE_UNAVAILABLE";
  } else if (input.degraded_reason === "NO_PUBLISHED_SNAPSHOT") {
    // Distinct from STALE and from DEGRADED: nothing is wrong, there is simply
    // no published generation to measure the age of.
    status = "UNKNOWN";
  } else if (input.degraded_reason) {
    status = "DEGRADED";
  } else if (input.refreshing) {
    status = "REFRESHING";
  } else if (age == null) {
    status = "DEGRADED";
    notes.push("no age basis available for the published snapshot");
  } else if (age <= thresholds.fresh_seconds) {
    status = "FRESH";
  } else if (age <= thresholds.acceptable_seconds) {
    status = "ACCEPTABLE";
  } else {
    status = "STALE";
  }

  return {
    status,
    source_status: sourceStatus,
    mode: input.mode,
    age_seconds: age,
    published_at: input.published_at ?? null,
    source_synced_at: input.source_synced_at ?? null,
    snapshot_id: input.snapshot_id ?? null,
    content_hash: input.content_hash ?? null,
    certified: input.certified ?? false,
    degraded_reason:
      status === "DEGRADED"
        ? (input.degraded_reason ?? "REFRESH_FAILED")
        : status === "UNKNOWN"
          ? "NO_PUBLISHED_SNAPSHOT"
          : null,
    thresholds,
    notes,
  };
}
