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

/** Volatile snapshot fields excluded from the content hash. */
const VOLATILE_SNAPSHOT_KEYS: ReadonlyArray<keyof CanonicalLeagueSnapshot> = [
  "captured_at",
  "provider_synced_at",
  "live_provider_status",
  "history_persistence_status",
  "warnings",
];

/**
 * Content hash of a snapshot, EXCLUDING volatile fields (capture time, per-run
 * statuses/warnings) so two captures of the same underlying league state
 * collapse to one stored version.
 */
export function snapshotContentHash(snapshot: CanonicalLeagueSnapshot): string {
  const stable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!VOLATILE_SNAPSHOT_KEYS.includes(key as keyof CanonicalLeagueSnapshot)) {
      stable[key] = value;
    }
  }
  return sha256(stableStringify(stable));
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
