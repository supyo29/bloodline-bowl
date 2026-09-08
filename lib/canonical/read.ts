/**
 * Stage F — the ONE shared published-snapshot reader for ordinary eligible reads.
 *
 * `readLeagueState(slug, opts)` is a near drop-in for `buildCanonicalLeagueState`:
 * it returns the same `{ ok, status, code?, detail?, snapshot }` plus a
 * `provenance` block. Every migrated read surface calls THIS instead of
 * `buildCanonicalLeagueState` directly.
 *
 *   flag off for this wave          → legacy live path (provenance FLAG_OFF)
 *   flag on, pointer serves         → published snapshot (state_source PUBLISHED_SNAPSHOT)
 *   flag on, pointer cannot serve   → legacy live path + an observable fallback_reason
 *
 * It is NOT a second canonical normalizer — it reads the already-certified
 * immutable snapshot the Stage E publication path produced, validates the
 * pointer→snapshot relationship, checks integrity + serving freshness, and
 * otherwise falls back. It never fabricates or partially reconstructs state.
 *
 * The publication / capture path (`lib/canonical/publish.ts`,
 * `lib/persistence/capture.ts`) and `/api/health` deliberately do NOT use this —
 * they must always read live.
 */

import {
  buildCanonicalLeagueState,
  type BuildStateOptions,
  type CanonicalStateResult,
} from "./state";
import { reconcilePublishCandidate } from "./reconcile";
import { snapshotLineage } from "./snapshot-lineage";
import { snapshotContentHash } from "@/lib/persistence/serialize";
import {
  deriveFreshness,
  type FreshnessStatus,
  type RefreshMode,
} from "./freshness";
import { publishedReadEnabled, type ReadWave } from "./published-flag";
import { emitBridgeEvent } from "@/lib/observability/events";
import { getPersistence } from "@/lib/persistence";
import type { PersistenceBundle } from "@/lib/persistence/types";
import { resolveLeagueStrict } from "@/lib/leagues/resolve";
import type { CanonicalLeagueSnapshot } from "./schema";

export type FallbackReason =
  | "FLAG_OFF"
  | "NO_POINTER"
  | "TARGET_MISSING"
  | "ID_MISMATCH"
  | "LEAGUE_MISMATCH"
  | "UNSUPPORTED_SCHEMA"
  | "INTEGRITY_FAILED"
  | "PERSISTENCE_UNAVAILABLE"
  | "TOO_STALE"
  | "MALFORMED";

export type ReadStateSource = "PUBLISHED_SNAPSHOT" | "LEGACY_LIVE_PATH";

export interface ReadProvenance {
  state_source: ReadStateSource;
  served_from_pointer: boolean;
  /** Non-null whenever an eligible read did NOT serve from the pointer. */
  fallback_reason: FallbackReason | null;
  pointer_present: boolean;
  pointer_snapshot_id: string | null;
  pointer_published_seq: number | null;
  /** Freshness bucket of the published snapshot at read time (when a pointer exists). */
  serving_freshness: FreshnessStatus | null;
  wave: ReadWave;
}

export interface LeagueReadResult {
  ok: boolean;
  status: number;
  code?: string;
  detail?: string;
  snapshot: CanonicalLeagueSnapshot | null;
  provenance: ReadProvenance;
}

export interface ReadOptions extends BuildStateOptions {
  /** Which migration wave this call belongs to. Default 1. */
  wave?: ReadWave;
  /** Freshness mode for the serving policy. Default NORMAL. */
  mode?: RefreshMode;
  persistence?: PersistenceBundle;
  now?: number;
}

/** Schema versions the reader will serve. `hydratePersistedSnapshot` lifts 1/2 → 3. */
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2, 3]);

/** Serving-freshness policy (§10): a published snapshot MAY serve when… */
const SERVEABLE: ReadonlySet<FreshnessStatus> = new Set<FreshnessStatus>(["FRESH", "ACCEPTABLE"]);
// STALE / REFRESHING / DEGRADED / SOURCE_UNAVAILABLE / UNKNOWN ⇒ fall back to live.
// Rationale: a certified-but-STALE snapshot is not invalidated (it stays visible and
// CERTIFIED in `published_snapshot`), but a fresher live read is preferable when the
// provider is reachable; if the live read ALSO fails, `buildCanonicalLeagueState`
// returns its own explicit degraded result. Integrity and freshness stay separate.

function legacy(
  slug: string,
  options: ReadOptions,
  wave: ReadWave,
  fallbackReason: FallbackReason,
  pointerInfo: Partial<ReadProvenance> = {},
): Promise<LeagueReadResult> {
  return buildCanonicalLeagueState(slug, options).then((r: CanonicalStateResult) => ({
    ...r,
    provenance: {
      state_source: "LEGACY_LIVE_PATH" as const,
      served_from_pointer: false,
      fallback_reason: fallbackReason === "FLAG_OFF" ? null : fallbackReason,
      pointer_present: pointerInfo.pointer_present ?? false,
      pointer_snapshot_id: pointerInfo.pointer_snapshot_id ?? null,
      pointer_published_seq: pointerInfo.pointer_published_seq ?? null,
      serving_freshness: pointerInfo.serving_freshness ?? null,
      wave,
    },
  }));
}

export async function readLeagueState(
  leagueSlug: string,
  options: ReadOptions = {},
): Promise<LeagueReadResult> {
  const wave: ReadWave = options.wave ?? 1;
  const now = options.now ?? Date.now();
  const mode: RefreshMode = options.mode ?? "NORMAL";

  if (!publishedReadEnabled(wave, process.env)) {
    return legacy(leagueSlug, options, wave, "FLAG_OFF");
  }

  const resolution = resolveLeagueStrict(leagueSlug);
  if (!resolution.ok) {
    // Let the legacy path produce the canonical error response.
    return legacy(leagueSlug, options, wave, "MALFORMED");
  }
  const { league_slug, season } = resolution.league;
  const persistence = options.persistence ?? getPersistence();

  // --- pointer ----------------------------------------------------------
  if ((await persistence.published.status().catch(() => "PERSISTENCE_ERROR")) !== "READY") {
    return fallbackFrom(leagueSlug, options, wave, "PERSISTENCE_UNAVAILABLE", null, now);
  }
  const pointer = await persistence.published.get(league_slug, season).catch(() => null);
  if (!pointer) {
    return fallbackFrom(leagueSlug, options, wave, "NO_POINTER", null, now);
  }
  if (pointer.league_slug !== league_slug || pointer.season !== season) {
    return fallbackFrom(leagueSlug, options, wave, "LEAGUE_MISMATCH", pointer, now);
  }

  // --- snapshot target -------------------------------------------------
  const stored = await persistence.snapshots.getById(pointer.snapshot_id).catch(() => null);
  if (!stored || !stored.payload) {
    return fallbackFrom(leagueSlug, options, wave, "TARGET_MISSING", pointer, now);
  }
  const snapshot = stored.payload;

  if (!SUPPORTED_SCHEMA_VERSIONS.has(snapshot.schema_version)) {
    return fallbackFrom(leagueSlug, options, wave, "UNSUPPORTED_SCHEMA", pointer, now);
  }
  if (
    snapshot.league?.league_slug !== league_slug ||
    snapshot.season !== season ||
    !Array.isArray(snapshot.teams) ||
    snapshot.teams.length === 0
  ) {
    return fallbackFrom(leagueSlug, options, wave, "MALFORMED", pointer, now);
  }
  if (
    snapshotLineage(snapshot).league_snapshot_id !== pointer.league_snapshot_id ||
    snapshotContentHash(snapshot) !== pointer.content_hash
  ) {
    return fallbackFrom(leagueSlug, options, wave, "ID_MISMATCH", pointer, now);
  }

  // --- integrity ------------------------------------------------------
  const rec = reconcilePublishCandidate(snapshot);
  if (rec.capabilities.snapshot_integrity !== "CERTIFIED") {
    return fallbackFrom(leagueSlug, options, wave, "INTEGRITY_FAILED", pointer, now);
  }

  // --- serving freshness --------------------------------------------
  const freshness = deriveFreshness({
    mode,
    source_synced_at: pointer.source_provider_synced_at,
    published_at: pointer.published_at,
    now,
  });
  if (!SERVEABLE.has(freshness.status)) {
    return fallbackFrom(leagueSlug, options, wave, "TOO_STALE", pointer, now, freshness.status);
  }

  // --- serve published --------------------------------------------
  emitBridgeEvent("freshness_evaluated", {
    league_slug,
    state_source: "PUBLISHED_SNAPSHOT",
    serving_freshness: freshness.status,
    published_seq: pointer.published_seq,
    wave,
  });

  return {
    ok: true,
    status: 200,
    snapshot,
    provenance: {
      state_source: "PUBLISHED_SNAPSHOT",
      served_from_pointer: true,
      fallback_reason: null,
      pointer_present: true,
      pointer_snapshot_id: pointer.league_snapshot_id,
      pointer_published_seq: pointer.published_seq,
      serving_freshness: freshness.status,
      wave,
    },
  };
}

function fallbackFrom(
  slug: string,
  options: ReadOptions,
  wave: ReadWave,
  reason: FallbackReason,
  pointer: import("@/lib/persistence/types").PublishedPointer | null,
  now: number,
  freshnessStatus?: FreshnessStatus,
): Promise<LeagueReadResult> {
  emitBridgeEvent("stale_snapshot_served", {
    league_slug: slug,
    reason,
    fallback: true,
    wave,
  });
  return legacy(slug, options, wave, reason, {
    pointer_present: !!pointer,
    pointer_snapshot_id: pointer?.league_snapshot_id ?? null,
    pointer_published_seq: pointer?.published_seq ?? null,
    serving_freshness:
      freshnessStatus ??
      (pointer
        ? deriveFreshness({
            mode: options.mode ?? "NORMAL",
            source_synced_at: pointer.source_provider_synced_at,
            published_at: pointer.published_at,
            now,
          }).status
        : null),
  });
}
