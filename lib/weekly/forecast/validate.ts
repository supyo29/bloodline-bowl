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

  // 3. nothing but the base, the bye compat zero and the injury model may be PRODUCTION; role/environment/matchup stay unpromoted
  for (const k of ["role", "environment", "matchup"] as const) {
    if (f[k].mode === "PRODUCTION") v.push(`${k.toUpperCase()}_PROMOTED`);
  }
  if (prod.some((c) => ["ROLE", "ENVIRONMENT", "MATCHUP", "AVAILABILITY", "FOOTBALL_INTELLIGENCE"].includes(c.phenomenon))) {
    v.push("NON_BASE_PRODUCTION_CONTRIBUTION");
  }

  // 4. injury accounting (W1.P2)
  const im = f.injury_model;
  const injuryProd = prod.filter((c) => c.phenomenon === "INJURY_AVAILABILITY" || c.phenomenon === "INJURY_WORKLOAD");
  if (injuryProd.length > 0 && im.mode !== "PRODUCTION") v.push("INJURY_PRODUCTION_ENTRY_WITHOUT_PRODUCTION_MODE");
  const injurySum = Math.round(injuryProd.reduce((s2, c) => s2 + c.points_delta, 0) * 100) / 100;
  if (im.mode === "PRODUCTION" && !f.game_status.is_bye && Math.abs(injurySum - Math.round((im.availability_delta + im.workload_delta) * 100) / 100) > 0.005) {
    v.push("INJURY_LEDGER_NEQ_MODEL_DELTAS");
  }
  const injuryApplied = f.availability.applied_to_expected_points;
  if (injuryApplied && im.mode !== "PRODUCTION") v.push("INJURY_APPLIED_WITHOUT_PRODUCTION_MODE");
  if (!injuryApplied && injuryProd.some((c) => c.points_delta !== 0)) v.push("INJURY_DELTA_PRESENT_BUT_NOT_APPLIED");
  // double-counting guard: an UNCONDITIONAL source already embeds P(active) -> no availability delta unless known unavailable
  if (im.source_projection_injury_semantics === "UNCONDITIONAL" && im.basis !== "OFFICIAL_UNAVAILABLE_KNOWN_ZERO" && im.availability_delta !== 0) {
    v.push("DOUBLE_COUNTED_AVAILABILITY_ON_UNCONDITIONAL_SOURCE");
  }
  // source truth survives: a recorded source status is never rewritten by normalisation
  if (im.source_status != null && f.availability.injury_status != null && im.source_status !== f.availability.injury_status) v.push("SOURCE_STATUS_OVERWRITTEN");
  // known unavailable is a known zero with the source value still visible
  if (f.value_state === "KNOWN_UNAVAILABLE") {
    if (f.projection.expected_points !== 0) v.push("KNOWN_UNAVAILABLE_NOT_ZERO");
    if (f.projection.expected_points_basis !== "OFFICIAL_UNAVAILABLE_KNOWN_ZERO") v.push("KNOWN_UNAVAILABLE_WRONG_BASIS");
    if (f.game_status.is_bye) v.push("KNOWN_UNAVAILABLE_ERASED_BYE");
  }
  // a missing source projection is never turned into a number by injury processing unless the player is KNOWN unavailable
  if (f.projection.source_points == null && f.projection.expected_points != null && !f.game_status.is_bye && f.value_state !== "KNOWN_UNAVAILABLE" && f.projection.expected_points_basis !== "SOURCE_PLUS_FI_PRODUCTION") {
    v.push("EXPECTED_WITHOUT_SOURCE_AND_NOT_UNAVAILABLE");
  }

  // 5. bye semantics
  if (f.game_status.is_bye !== (f.value_state === "BYE_VERIFIED")) v.push("BYE_FLAG_VALUE_STATE_MISMATCH");
  if (f.game_status.is_bye) {
    if (f.projection.expected_points_basis !== "BYE_COMPAT_ZERO") v.push("BYE_WITHOUT_COMPAT_BASIS");
    if (f.availability.status !== "BYE") v.push("BYE_AVAILABILITY_STATUS_NOT_BYE");
    if (f.projection.conditional_active_points === 0 && f.projection.source_points == null) v.push("BYE_CONDITIONAL_ZERO_FABRICATED");
  }

  // 5b. W1.P3 current-week vs asset semantics
  const wv = f.weekly_value;
  const ac = f.asset_context;
  if (wv.current_week_points !== f.projection.expected_points) v.push("WEEKLY_VALUE_NEQ_EXPECTED_POINTS");
  if (f.game_status.is_bye) {
    if (wv.current_week_points !== 0 || wv.current_week_state !== "BYE") v.push("BYE_CURRENT_WEEK_NOT_KNOWN_ZERO");
    if (!ac.bye_suppressed_current_week || ac.temporary_unavailability_reason !== "BYE") v.push("BYE_ASSET_CONTEXT_MISSING");
    if (wv.underlying_points_if_game_played === 0 && wv.underlying_basis !== "SOURCE_PROJECTION_PRE_BYE") v.push("BYE_UNDERLYING_FABRICATED_ZERO");
  } else {
    if (wv.current_week_state === "BYE" || ac.bye_suppressed_current_week || ac.temporary_unavailability_reason === "BYE") v.push("BYE_STATE_ON_NON_BYE_PLAYER");
  }
  if (wv.current_week_state === "UNKNOWN" && wv.current_week_points != null) v.push("UNKNOWN_STATE_CARRIES_CURRENT_WEEK_POINTS");
  if (wv.current_week_state === "KNOWN_ZERO" && (wv.current_week_points !== 0 || f.game_status.is_bye)) v.push("KNOWN_ZERO_STATE_INVALID");
  if (wv.underlying_basis === "UNAVAILABLE" && wv.underlying_points_if_game_played != null) v.push("UNDERLYING_VALUE_WITHOUT_BASIS");
  if (wv.underlying_points_if_game_played != null && !ac.forward_value_available) v.push("FORWARD_VALUE_FLAG_INCONSISTENT");

  // 6. null = unknown: an unknown value state may never carry a number
  const unknownStates = ["SOURCE_MISSING_PLAYER", "SOURCE_FETCH_FAILURE", "PLAYER_NOT_FOUND", "PLAYER_OUT_IN_SOURCE", "UNSUPPORTED_SCORING_DATA", "PROJECTION_UNAVAILABLE", "NO_SCHEDULED_GAME", "UNKNOWN"];
  if (unknownStates.includes(f.value_state) && f.projection.expected_points != null) v.push("UNKNOWN_STATE_CARRIES_NUMBER");
  if (f.value_state === "KNOWN_ZERO_PROJECTION" && f.projection.expected_points !== 0) v.push("KNOWN_ZERO_NOT_ZERO");
  // 7. DEF is never run through an individual injury model
  if ((f.position ?? "").toUpperCase() === "DEF" && f.injury_model.normalized_state !== "NOT_APPLICABLE") v.push("DEF_TREATED_AS_INDIVIDUAL_INJURY");

  return v;
}
