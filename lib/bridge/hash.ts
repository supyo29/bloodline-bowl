/**
 * Deterministic content hashing for Bridge identity checks.
 *
 * The scoring/roster hashes let a ChatGPT snapshot prove which league's rules
 * produced it, and let the Bridge fail an export closed when the active
 * league's live rules no longer match what a stored draft state was built
 * against.
 */

import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted recursively so semantically-equal inputs
 * always stringify identically. Arrays keep their order (it is meaningful for
 * `roster_positions`).
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** SHA-256 hex digest of the canonical JSON form of `value`. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * The scoring identity for a league: a hash over its live Sleeper
 * `scoring_settings` plus the roster positions those points are scored into.
 */
export function scoringIdentityHash(
  scoringSettings: Record<string, number>,
  rosterPositions: string[],
): string {
  return contentHash({
    scoring_settings: scoringSettings,
    roster_positions: rosterPositions,
  });
}
