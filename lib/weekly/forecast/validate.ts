/**
 * Structural invariants of a canonical forecast. Returns violations (empty = valid) so tests and diagnostics can assert
 * the contract instead of trusting the builder.
 */

import type { CanonicalWeeklyPlayerForecast } from "./schema";

export function validateForecastInvariants(f: CanonicalWeeklyPlayerForecast): string[] {
  const v: string[] = [];
  const prod = f.contributions.filter((c) => c.mode === "PRODUCTION");

  // 1. ledger reconstructs expected_points exactly (to the cent); unknown expected has no production entries
  const sum = Math.round(prod.reduce((s, c) => s + c.points_delta, 0) * 100) / 100;
  if (f.projection.expected_points == null) {
    if (prod.length > 0) v.push("PRODUCTION_CONTRIBUTIONS_PRESENT_FOR_UNKNOWN_EXPECTED");
  } else if (Math.abs(sum - Math.round(f.projection.expected_points * 100) / 100) > 0.005) {
    v.push(`LEDGER_SUM_${sum}_NEQ_EXPECTED_${f.projection.expected_points}`);
  }

  // 2. no two PRODUCTION entries may adjust the same phenomenon
  const seen = new Set<string>();
  for (const c of prod) {
    if (seen.has(c.phenomenon)) v.push(`DUPLICATE_PRODUCTION_PHENOMENON_${c.phenomenon}`);
    seen.add(c.phenomenon);
  }

  // 3. W1.P1 promotes nothing: role/environment/matchup are never PRODUCTION
  for (const k of ["role", "environment", "matchup"] as const) {
    if (f[k].mode === "PRODUCTION") v.push(`${k.toUpperCase()}_PROMOTED_IN_W1_P1`);
  }
  if (prod.some((c) => ["ROLE", "ENVIRONMENT", "MATCHUP", "AVAILABILITY"].includes(c.phenomenon))) {
    v.push("NON_BASE_PRODUCTION_CONTRIBUTION_IN_W1_P1");
  }

  // 4. availability is never applied yet
  if (f.availability.applied_to_expected_points !== false) v.push("AVAILABILITY_APPLIED_IN_W1_P1");

  // 5. bye semantics
  if (f.game_status.is_bye !== (f.value_state === "BYE_VERIFIED")) v.push("BYE_FLAG_VALUE_STATE_MISMATCH");
  if (f.game_status.is_bye) {
    if (f.projection.expected_points_basis !== "BYE_COMPAT_ZERO") v.push("BYE_WITHOUT_COMPAT_BASIS");
    if (f.availability.status !== "BYE") v.push("BYE_AVAILABILITY_STATUS_NOT_BYE");
    if (f.projection.conditional_active_points === 0 && f.projection.source_points == null) v.push("BYE_CONDITIONAL_ZERO_FABRICATED");
  }

  // 6. null = unknown: an unknown value state may never carry a number
  const unknownStates = ["SOURCE_MISSING_PLAYER", "SOURCE_FETCH_FAILURE", "PLAYER_NOT_FOUND", "PLAYER_OUT_IN_SOURCE", "UNSUPPORTED_SCORING_DATA", "PROJECTION_UNAVAILABLE", "NO_SCHEDULED_GAME", "UNKNOWN"];
  if (unknownStates.includes(f.value_state) && f.projection.expected_points != null) v.push("UNKNOWN_STATE_CARRIES_NUMBER");
  if (f.value_state === "KNOWN_ZERO_PROJECTION" && f.projection.expected_points !== 0) v.push("KNOWN_ZERO_NOT_ZERO");

  return v;
}
