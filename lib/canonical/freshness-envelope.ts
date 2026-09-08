/**
 * The additive `freshness` + `capabilities` envelope for observability surfaces
 * (`/api/league/[l]/state`, `/api/context/[l]/[m]`, `/api/health?deep=1`).
 *
 * Stage D is OBSERVATIONAL. Production routes still serve state from the legacy
 * live path; this envelope must say so honestly:
 *
 *   state_source            = "LEGACY_LIVE_PATH"  (until Stage F migrates the route)
 *   response_state_lineage  = what ACTUALLY served this response
 *   published_snapshot      = the durable pointer, INSPECTED, not necessarily served
 *   freshness               = classification of the state that served this response
 *   integrity / capabilities= centralised model from ./capabilities + ./reconcile
 *
 * Timestamp honesty (§5): `response_state_lineage.observed_at` is the provider
 * READ time (`provider_synced_at`), stamped when the Bridge began the provider
 * read. The read itself may have been served from the Next data cache, so the
 * underlying provider data can be up to `source_max_staleness_seconds` older
 * than that. Freshness `status` is therefore classified against the
 * CONSERVATIVE age (`age_seconds + source_max_staleness_seconds`), never the
 * optimistic read time — so a request that rebuilt in 1s but read 4-minute-old
 * cached rosters is not labelled FRESH.
 *
 * Pure. No I/O. No mutation.
 */

import { CORE_REVALIDATE_SECONDS } from "@/lib/sleeper/client";
import { deriveFreshness, type Freshness, type RefreshMode } from "./freshness";
import { reconcilePublishCandidate } from "./reconcile";
import type { CapabilityName, CapabilityReport, SnapshotIntegrity } from "./capabilities";
import { snapshotLineage } from "./snapshot-lineage";
import type { CanonicalLeagueSnapshot } from "./schema";
import type { PublishedPointer } from "@/lib/persistence/types";

export type StateSource = "LEGACY_LIVE_PATH" | "PUBLISHED_SNAPSHOT";

export interface ResponseStateLineage {
  /** Canonical snapshot id the state serving THIS response was built from. */
  snapshot_id: string | null;
  /** Provider read start time (`provider_synced_at`). */
  observed_at: string | null;
  age_basis: "provider_read_start";
  /** now − observed_at, precisely measured. */
  age_seconds: number | null;
  /** The provider read may itself have been cache-served up to this old. */
  source_max_staleness_seconds: number;
  /** age_seconds + source_max_staleness_seconds — the worst-case data age. */
  conservative_age_seconds: number | null;
  /** Freshness bucket of THIS served payload (classified from conservative age). */
  served_freshness: import("./freshness").FreshnessStatus;
  note: string;
}

export interface PublishedSnapshotInspection {
  present: boolean;
  snapshot_id: string | null;
  content_hash: string | null;
  published_seq: number | null;
  published_at: string | null;
  source_synced_at: string | null;
  age_seconds: number | null;
  week: number | null;
  certified: boolean | null;
}

export interface EnvelopeFallback {
  occurred: boolean;
  reason: string | null;
}

export interface FreshnessEnvelope {
  state_source: StateSource;
  /** Set when an eligible route wanted the published snapshot but served legacy. */
  fallback: EnvelopeFallback;
  /** What actually served this response. */
  response_state_lineage: ResponseStateLineage | null;
  /** The durable published pointer, INSPECTED. Not necessarily what served you. */
  published_snapshot: PublishedSnapshotInspection;
  /**
   * Freshness of the PUBLISHED certified snapshot. `UNKNOWN` when no pointer
   * exists yet (Stage D: expected — the flag is off and nothing publishes).
   * Once Stage F migrates the route, this equals the served payload's freshness.
   */
  freshness: Freshness;
  integrity: { snapshot_integrity: SnapshotIntegrity; failures: string[] };
  capabilities: CapabilityReport["capabilities"];
  material_unresolved: CapabilityReport["material_unresolved"];
  unresolved_categories: Record<string, number>;
}

export interface BuildEnvelopeInput {
  /** The snapshot that actually served this response (null on a hard failure). */
  servedSnapshot: CanonicalLeagueSnapshot | null;
  stateSource: StateSource;
  /** The durable pointer, read for inspection only. */
  pointer: PublishedPointer | null;
  mode?: RefreshMode;
  /** Cache TTL of the provider reads behind `servedSnapshot`. */
  sourceMaxStalenessSeconds?: number;
  /** Provider was unreachable while building `servedSnapshot`. */
  sourceUnavailable?: boolean;
  /** When an eligible route wanted the pointer but fell back to legacy. */
  fallback?: EnvelopeFallback;
  now?: number;
}

function ageSeconds(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 1000));
}

function inspectPointer(pointer: PublishedPointer | null, now: number): PublishedSnapshotInspection {
  if (!pointer) {
    return {
      present: false,
      snapshot_id: null,
      content_hash: null,
      published_seq: null,
      published_at: null,
      source_synced_at: null,
      age_seconds: null,
      week: null,
      certified: null,
    };
  }
  return {
    present: true,
    snapshot_id: pointer.league_snapshot_id,
    content_hash: pointer.content_hash,
    published_seq: pointer.published_seq,
    published_at: pointer.published_at,
    source_synced_at: pointer.source_provider_synced_at,
    age_seconds: ageSeconds(pointer.source_provider_synced_at ?? pointer.published_at, now),
    week: pointer.week,
    certified: pointer.certified,
  };
}

const EMPTY_CAPS: CapabilityReport["capabilities"] = {
  roster_state: { status: "UNAVAILABLE", reasons: ["no state served"], missing_inputs: ["snapshot"] },
  ownership: { status: "UNAVAILABLE", reasons: ["no state served"], missing_inputs: ["snapshot"] },
  standings: { status: "UNAVAILABLE", reasons: ["no state served"], missing_inputs: ["snapshot"] },
  matchups: { status: "UNAVAILABLE", reasons: ["no state served"], missing_inputs: ["snapshot"] },
  transactions: { status: "UNAVAILABLE", reasons: ["no state served"], missing_inputs: ["snapshot"] },
  history_persistence: { status: "UNAVAILABLE", reasons: ["no state served"], missing_inputs: ["snapshot"] },
  free_agent_pool: { status: "UNAVAILABLE", reasons: ["no state served"], missing_inputs: ["snapshot"] },
  draft_availability: { status: "UNAVAILABLE", reasons: ["no state served"], missing_inputs: ["snapshot"] },
  player_identity: { status: "UNAVAILABLE", reasons: ["no state served"], missing_inputs: ["snapshot"] },
};

export function buildFreshnessEnvelope(input: BuildEnvelopeInput): FreshnessEnvelope {
  const now = input.now ?? Date.now();
  const mode: RefreshMode = input.mode ?? "NORMAL";
  const maxStale = input.sourceMaxStalenessSeconds ?? CORE_REVALIDATE_SECONDS;
  const pointerInspection = inspectPointer(input.pointer, now);

  // --- response lineage (what actually served) ---------------------------
  let lineage: ResponseStateLineage | null = null;
  if (input.servedSnapshot) {
    const observedAt = input.servedSnapshot.provider_synced_at;
    const measured = ageSeconds(observedAt, now);
    const conservative = measured == null ? null : measured + maxStale;
    const servedFreshness =
      conservative == null
        ? "UNKNOWN"
        : deriveFreshness({
            mode,
            source_synced_at: new Date(now - conservative * 1000).toISOString(),
            source_status: input.sourceUnavailable ? "DEGRADED" : "AVAILABLE",
            now,
          }).status;
    lineage = {
      snapshot_id: snapshotLineage(input.servedSnapshot).league_snapshot_id,
      observed_at: observedAt,
      age_basis: "provider_read_start",
      age_seconds: measured,
      source_max_staleness_seconds: maxStale,
      conservative_age_seconds: conservative,
      served_freshness: servedFreshness,
      note:
        input.stateSource === "LEGACY_LIVE_PATH"
          ? "state served by the legacy live path; observed_at is the provider read time; the read may itself have been cache-served up to source_max_staleness_seconds old; served_freshness is classified from the conservative worst-case age"
          : "state served from the published certified snapshot",
    };
  }

  // --- integrity + capabilities ----------------------------------------
  let integrity: FreshnessEnvelope["integrity"];
  let capabilities: CapabilityReport["capabilities"];
  let material: CapabilityReport["material_unresolved"] = [];
  let categories: Record<string, number> = {};
  if (input.servedSnapshot) {
    const rec = reconcilePublishCandidate(input.servedSnapshot);
    integrity = {
      snapshot_integrity: rec.capabilities.snapshot_integrity,
      failures: rec.capabilities.integrity_failures,
    };
    capabilities = rec.capabilities.capabilities;
    material = rec.capabilities.material_unresolved;
    categories = rec.capabilities.unresolved_categories;
  } else {
    integrity = { snapshot_integrity: "REJECTED", failures: ["no state served"] };
    capabilities = EMPTY_CAPS;
  }

  // --- freshness of the PUBLISHED certified snapshot (the pointer) -------
  // Kept SEPARATE from `response_state_lineage.served_freshness` so a response
  // can never imply its payload came from the published snapshot when it did not.
  let freshness: Freshness;
  if (!input.pointer) {
    freshness = deriveFreshness({ mode, degraded_reason: "NO_PUBLISHED_SNAPSHOT", now });
  } else {
    freshness = deriveFreshness({
      mode,
      source_synced_at: input.pointer.source_provider_synced_at,
      published_at: input.pointer.published_at,
      snapshot_id: input.pointer.league_snapshot_id,
      content_hash: input.pointer.content_hash,
      certified: input.pointer.certified,
      source_status: input.sourceUnavailable ? "SOURCE_UNAVAILABLE" : "AVAILABLE",
      now,
    });
  }

  return {
    state_source: input.stateSource,
    fallback: input.fallback ?? { occurred: false, reason: null },
    response_state_lineage: lineage,
    published_snapshot: pointerInspection,
    freshness,
    integrity,
    capabilities,
    material_unresolved: material,
    unresolved_categories: categories,
  };
}

/**
 * I/O wrapper: read the durable pointer (inspection only — NEVER advanced),
 * build the envelope, and emit the Stage D observability events. The pointer
 * read is the only side effect and it is read-only.
 */
export async function resolveFreshnessEnvelope(opts: {
  leagueSlug: string;
  season: number;
  servedSnapshot: CanonicalLeagueSnapshot | null;
  stateSource: StateSource;
  sourceUnavailable?: boolean;
  fallback?: EnvelopeFallback;
  mode?: RefreshMode;
  now?: number;
  persistence?: import("@/lib/persistence/types").PersistenceBundle;
}): Promise<FreshnessEnvelope> {
  const { getPersistence } = await import("@/lib/persistence");
  const { emitBridgeEvent } = await import("@/lib/observability/events");
  const persistence = opts.persistence ?? getPersistence();
  const pointer = await persistence.published
    .get(opts.leagueSlug, opts.season)
    .catch(() => null);

  const envelope = buildFreshnessEnvelope({
    servedSnapshot: opts.servedSnapshot,
    stateSource: opts.stateSource,
    pointer,
    mode: opts.mode,
    sourceUnavailable: opts.sourceUnavailable,
    fallback: opts.fallback,
    now: opts.now,
  });

  emitBridgeEvent("freshness_evaluated", {
    league_slug: opts.leagueSlug,
    state_source: envelope.state_source,
    freshness: envelope.freshness.status,
    integrity: envelope.integrity.snapshot_integrity,
    published_pointer: envelope.published_snapshot.present,
    conservative_age_seconds: envelope.response_state_lineage?.conservative_age_seconds ?? null,
  });
  if (!envelope.published_snapshot.present) {
    emitBridgeEvent("snapshot_missing", { league_slug: opts.leagueSlug });
  }
  if (envelope.freshness.status === "STALE") {
    emitBridgeEvent("snapshot_stale", {
      league_slug: opts.leagueSlug,
      age_seconds: envelope.freshness.age_seconds,
    });
  }
  for (const [name, cap] of Object.entries(envelope.capabilities)) {
    if (cap.status === "DEGRADED") {
      emitBridgeEvent("capability_degraded", { league_slug: opts.leagueSlug, capability: name });
    } else if (cap.status === "UNAVAILABLE") {
      emitBridgeEvent("capability_unavailable", { league_slug: opts.leagueSlug, capability: name });
    }
  }

  return envelope;
}

/** Compact per-capability status map for a response that doesn't want the full report. */
export function compactCapabilities(
  caps: CapabilityReport["capabilities"],
): Record<CapabilityName, string> {
  return Object.fromEntries(
    Object.entries(caps).map(([k, v]) => [k, v.status]),
  ) as Record<CapabilityName, string>;
}
