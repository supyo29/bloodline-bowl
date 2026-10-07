/**
 * @deprecated W1.P1 COMPATIBILITY ADAPTERS — scheduled for retirement.
 *
 * These exist only so a consumer can read the canonical forecast while returning the exact numbers the legacy
 * `WeeklyProjection` shape returned. They are NOT a second projection abstraction: they read one canonical object and
 * flatten it. Retire each one as its consumer adopts `expected_points` / `availability` semantics directly
 * (W1.P2 availability-aware value, W1.P3 bye-aware value).
 */

import type { CanonicalWeeklyPlayerForecast } from "./schema";

/** Legacy `WeeklyProjection.projected_points`: production expected value; a verified bye is the compat 0; unknown is null. */
export function getLegacyProjectedPoints(forecast: CanonicalWeeklyPlayerForecast | null | undefined): number | null {
  return forecast?.projection.expected_points ?? null;
}

/** Legacy `WeeklyProjection.expected_availability`: a bye reads 0 (the legacy conflation); otherwise the heuristic. null when no source row. */
export function getLegacyExpectedAvailability(forecast: CanonicalWeeklyPlayerForecast | null | undefined): number | null {
  if (!forecast) return null;
  if (forecast.game_status.is_bye) return 0;
  return forecast.availability.probability_active;
}
