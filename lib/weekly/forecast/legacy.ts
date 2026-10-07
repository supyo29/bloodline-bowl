/**
 * @deprecated COMPATIBILITY ADAPTERS — scheduled for retirement.
 *
 * Read one canonical object and flatten it to a legacy shape. They are NOT a second projection abstraction.
 *
 * W1.P2 NOTE: `getLegacyProjectedPoints` returns the canonical production `expected_points`, which is now INJURY-AWARE. It no
 * longer equals the legacy `WeeklyProjection.projected_points` (the source value) for injured players. Consumers that must stay on
 * the SOURCE basis (waiver/drop ranking, VOR against a source-based replacement pool) keep reading the legacy batch until their own
 * phase; use `getSourceProjectedPoints` to say so explicitly.
 */

import type { CanonicalWeeklyPlayerForecast } from "./schema";

/** Canonical production expected value for current-week decisions (injury-aware from W1.P2); a verified bye is the compat 0; unknown is null. */
export function getLegacyProjectedPoints(forecast: CanonicalWeeklyPlayerForecast | null | undefined): number | null {
  return forecast?.projection.expected_points ?? null;
}

/** The provider's number, i.e. what legacy `projected_points` meant before W1.P2. null when unknown or not recoverable. */
export function getSourceProjectedPoints(forecast: CanonicalWeeklyPlayerForecast | null | undefined): number | null {
  return forecast?.projection.source_points ?? null;
}

/** Legacy `WeeklyProjection.expected_availability`: the provider's fixed heuristic (bye reads 0). null when no source row. */
export function getLegacyExpectedAvailability(forecast: CanonicalWeeklyPlayerForecast | null | undefined): number | null {
  if (!forecast) return null;
  if (forecast.game_status.is_bye) return 0;
  return forecast.availability.source_heuristic_availability;
}
