/**
 * Canonical scoring fingerprint — the ONE authoritative identity for a league's
 * scoring configuration on the canonical path.
 *
 * Phase 1A found two independent scoring-rule normalizers and two hash
 * conventions:
 *   - `lib/analytics/historical-scoring.ts#hashScoringSettings` — a 32-bit
 *     rolling hash, used by the season projection model's cache keys and
 *     surfaced as `scoring_hash` on projection responses.
 *   - `lib/providers/sleeper/canonical.ts#toCanonicalScoringRules` — produces a
 *     sorted `scoring_rules[]` array but no hash at all.
 *
 * `scoringFingerprint()` is now authoritative for everything the canonical
 * snapshot touches (`CanonicalLeague.scoring_fingerprint`, the snapshot
 * lineage, and every downstream engine's lineage envelope). The legacy
 * `hashScoringSettings` is UNCHANGED — the season model and the historical
 * analytics surface keep using it until Phase 1B.2, so legacy readers never
 * break. `leagueScoringContext` additionally exposes this canonical fingerprint
 * alongside its own `scoring_hash`.
 *
 * Determinism / equivalence rules (documented, test-enforced):
 *   1. Key ORDER is irrelevant — entries are sorted before hashing.
 *   2. A rule whose value is exactly 0 is SEMANTICALLY EQUIVALENT to the rule
 *      being absent (`calculateFantasyPoints` skips unknown keys and multiplies
 *      known ones, so both contribute zero). Zero-valued rules are dropped, so a
 *      "standard" league that lists `rec: 0` and one that omits `rec` share a
 *      fingerprint.
 *   3. Numeric serialization noise is collapsed — `1` and `1.0`, `-0` and `0`,
 *      and IEEE-754 dust below 1e-6 all normalize to the same token.
 *   4. Any change to a NON-zero rule value, or adding/removing a non-zero rule,
 *      changes the fingerprint.
 *   5. Non-finite / non-numeric values are ignored (never in a real Sleeper or
 *      Yahoo scoring map, but the function must not throw).
 */

import { createHash } from "node:crypto";

export const SCORING_FINGERPRINT_VERSION = "v1" as const;

/** Collapse numeric serialization differences to a stable token. */
function normalizeScoringValue(value: number): string {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  if (Object.is(rounded, -0) || rounded === 0) return "0";
  return String(rounded);
}

/**
 * Deterministic, order-independent fingerprint of a raw scoring map.
 * Shape: `scoring:v1:<24 hex chars>`.
 */
export function scoringFingerprint(rawScoring: Record<string, number> | null | undefined): string {
  const entries = Object.entries(rawScoring ?? {})
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v) && normalizeScoringValue(v) !== "0")
    .map(([k, v]) => [k, normalizeScoringValue(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const serialized = entries.map(([k, v]) => `${k}=${v}`).join("|");
  const digest = createHash("sha256").update(serialized).digest("hex").slice(0, 24);
  return `scoring:${SCORING_FINGERPRINT_VERSION}:${digest}`;
}

/** Whether two raw scoring maps are scoring-equivalent under the rules above. */
export function scoringEquivalent(
  a: Record<string, number> | null | undefined,
  b: Record<string, number> | null | undefined,
): boolean {
  return scoringFingerprint(a) === scoringFingerprint(b);
}
