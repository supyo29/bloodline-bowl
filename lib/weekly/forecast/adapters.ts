/**
 * Translate existing shadow-model outputs into canonical `ForecastShadowSignals` entries. Pure and read-only: these never
 * produce a PRODUCTION-mode signal (the type does not allow it).
 *
 * Deliberately STRUCTURAL: production code must not import `lib/role-calibration` (pinned by the Role Calibration
 * production-isolation test). A Role Calibration `ShadowCandidate` satisfies `RoleShadowCandidateLike` by shape, so the
 * caller that already holds one (calibration/audit code, tests) can pass it in without this module depending on it.
 */

import type { ShadowSignalInput } from "./schema";

export interface RoleShadowCandidateLike {
  mode: "SHADOW_ONLY";
  role_adjustment: number;
  teammate_only_adjustment: number;
  confidence: string;
  reason_codes: string[];
  contributions: unknown;
}

// Ordinal map of the calibration model's own labels. NOT a probability and not a calibrated confidence: it only keeps the
// three labels ordered (MEDIUM > LOW > INSUFFICIENT_SAMPLE). Unknown labels map to null.
const CONF_ORDINAL: Record<string, number> = { MEDIUM: 0.5, LOW: 0.25, INSUFFICIENT_SAMPLE: 0 };

export function roleSignalFromShadowCandidate(
  c: RoleShadowCandidateLike,
): ShadowSignalInput<{ state: unknown; adjustment_points: number; confidence: number | null }> {
  return {
    mode: "SHADOW",
    signal: {
      state: {
        contributions: c.contributions,
        reason_codes: c.reason_codes,
        teammate_only_adjustment: c.teammate_only_adjustment,
        confidence_label: c.confidence,
      },
      adjustment_points: c.role_adjustment,
      confidence: CONF_ORDINAL[c.confidence] ?? null,
    },
    reason: "Role Calibration shadow candidate (SHADOW_ONLY); not applied to expected_points",
  };
}
