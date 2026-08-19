/**
 * The scoring engine: applies a league's scoring settings to a stat line.
 *
 * Pure and HTTP-free so it is directly testable and reusable by the archetype
 * examples, the sensitivity analysis, and `POST /api/scoring/calculate`.
 */

import { SCORING_CATALOG, humanizeKey } from "./catalog";
import type { CalculationResult, ScoringBreakdownEntry, StatLine } from "./types";

/** Round to 4 decimal places to absorb IEEE-754 noise (e.g. `0.04 * 300`). */
export function roundPoints(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Apply `scoringSettings` to `stats`, one key at a time.
 *
 * A stat key with no matching scoring-settings entry does not throw: it is
 * skipped, contributes zero points, and is recorded in `warnings`. This is what
 * lets `POST /api/scoring/calculate` safely accept caller-supplied stat lines
 * and what keeps `/api/scoring`'s archetype/sensitivity sections resilient to
 * future Sleeper scoring keys this catalog does not yet recognize.
 */
export function calculateFantasyPoints(
  stats: StatLine,
  scoringSettings: Record<string, number>,
): CalculationResult {
  const breakdown: ScoringBreakdownEntry[] = [];
  const warnings: string[] = [];
  let total = 0;

  for (const [key, rawValue] of Object.entries(stats)) {
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
      warnings.push(`Stat '${key}' has a non-numeric value and was ignored.`);
      continue;
    }

    const multiplier = scoringSettings[key];
    if (typeof multiplier !== "number" || !Number.isFinite(multiplier)) {
      warnings.push(
        `Scoring key '${key}' is not yet supported by the local calculator.`,
      );
      continue;
    }

    const points = roundPoints(rawValue * multiplier);
    total += points;

    const meta = SCORING_CATALOG[key];
    breakdown.push({
      stat: key,
      label: meta?.label ?? humanizeKey(key),
      category: meta?.category ?? "other",
      value: rawValue,
      multiplier,
      points,
    });
  }

  return { fantasy_points: roundPoints(total), breakdown, warnings };
}
