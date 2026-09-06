/**
 * Canonical JSON serialization + content hashing.
 *
 * The canonical schema — not any store's table shape — is the portability
 * contract. These helpers give a stable, order-independent JSON encoding so:
 *   - a re-captured snapshot with identical content hashes identically
 *     (dedupe / immutability rely on this)
 *   - snapshots/transactions can be exported to a file and re-imported or
 *     committed to the repo as milestone archives
 */

import { createHash } from "node:crypto";
import type {
  CanonicalLeagueSnapshot,
  CanonicalTransaction,
} from "@/lib/canonical/schema";

/** Deterministic JSON: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * Snapshot fields excluded from the content hash: volatile per-run fields
 * (capture time, statuses, warnings) plus `lineage`, which is DERIVED from the
 * rest of the snapshot — `lineage.content_hash` and `lineage.league_snapshot_id`
 * are computed FROM this hash, so hashing them would be circular.
 *
 * Everything else contributes: `schema_version`, `league` (incl. `raw_scoring`,
 * `roster_settings`, `playoff_settings`, `waiver_settings`, the derived
 * `scoring_fingerprint`/`roster_fingerprint`), `season`, `week`, `managers`,
 * `teams`, `rosters` (so a starter/bench/IR change DOES change the id),
 * `standings`, `matchups`, `recent_transactions`, `draft_picks`, `players`,
 * `unresolved_players`.
 */
const VOLATILE_SNAPSHOT_KEYS: ReadonlyArray<keyof CanonicalLeagueSnapshot> = [
  "captured_at",
  "provider_synced_at",
  "live_provider_status",
  "history_persistence_status",
  "warnings",
  "lineage",
];

/**
 * Keys that appear DEEP in the snapshot (inside every `provenance` block) and
 * carry a per-read wall-clock stamp rather than league state. Two reads of an
 * unchanged league differ only by these, so they are nulled out before hashing —
 * this is what makes `league_snapshot_id` deterministic and makes persistence
 * dedupe actually collapse identical re-captures.
 */
const DEEP_VOLATILE_KEYS = new Set(["provider_synced_at"]);

function stripDeepVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDeepVolatile);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = DEEP_VOLATILE_KEYS.has(k) ? null : stripDeepVolatile(v);
    }
    return out;
  }
  return value;
}

/**
 * Content hash of a snapshot, EXCLUDING volatile + derived fields so two
 * captures of the same underlying league state collapse to one stored version.
 */
export function snapshotContentHash(snapshot: CanonicalLeagueSnapshot): string {
  const stable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!VOLATILE_SNAPSHOT_KEYS.includes(key as keyof CanonicalLeagueSnapshot)) {
      stable[key] = stripDeepVolatile(value);
    }
  }
  return sha256(stableStringify(stable));
}

/**
 * Deterministic `league_snapshot_id`: a content-addressed identity for the
 * effective league state downstream engines consume. Same canonical content ⇒
 * same id; a material roster / scoring / matchup / player change ⇒ new id;
 * request time and per-run status never affect it.
 *
 * Shape: `snap:<league_slug>:<season>:w<week>:<first 16 hex of content hash>`.
 */
export function leagueSnapshotId(snapshot: CanonicalLeagueSnapshot): string {
  const hash = snapshotContentHash(snapshot);
  return `snap:${snapshot.league.league_slug}:${snapshot.season}:w${snapshot.week}:${hash.slice(0, 16)}`;
}

export function transactionContentHash(txn: CanonicalTransaction): string {
  return sha256(stableStringify(txn));
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/* ------------------------------------------------------------- portability */

export interface SnapshotArchive {
  kind: "bridge.snapshot";
  schema_version: number;
  exported_at: string;
  snapshot: CanonicalLeagueSnapshot;
}

export interface TransactionArchive {
  kind: "bridge.transactions";
  schema_version: number;
  league_slug: string;
  season: number;
  exported_at: string;
  transactions: CanonicalTransaction[];
}

export function toSnapshotArchive(snapshot: CanonicalLeagueSnapshot): SnapshotArchive {
  return {
    kind: "bridge.snapshot",
    schema_version: snapshot.schema_version,
    exported_at: new Date().toISOString(),
    snapshot,
  };
}

export function toTransactionArchive(
  league_slug: string,
  season: number,
  transactions: CanonicalTransaction[],
): TransactionArchive {
  return {
    kind: "bridge.transactions",
    schema_version: 1,
    league_slug,
    season,
    exported_at: new Date().toISOString(),
    transactions,
  };
}
