/**
 * W2.P2 — the three Role Shadow arms, computed from the PRODUCTION champion forecast and a point-in-time Role forecast.
 *
 *   CHALLENGER  frozen `role-opportunity-challenger-2026.0`: centered, Role-only coefficients (intercept and baseline term deliberately dropped).
 *   CONTROL     frozen Role-free control C0: intercept + baseline term only; identical cap, confidence weight, eligibility and injury application.
 *   C2_FULL     DIAGNOSTIC (never a gate): the full offline C2 (Role + intercept + baseline term) — reproduces the offline T2b contrast (C2 vs C0).
 *
 * APPLICATION ORDER (frozen): the delta corrects the CONDITIONAL-ON-ACTIVE value; availability is then supplied exactly once by the production
 * Wave 1 injury model. The injury model is NOT linear in the source projection (a Questionable player's P(active) depends on a role tier derived
 * from `source_points`, so a Role delta can cross the tier threshold). Each arm therefore RE-RUNS the production `evaluateInjuryModel` on the
 * adjusted source value, with the champion's own recorded evidence — exactly what the frozen W2.P1 harness did (`injuryExpected(b0 + delta)`).
 *
 * IDENTITY GUARD: before any arm applies, the model re-run on the UNADJUSTED recorded evidence must reproduce the champion's conditional-active
 * and expected points EXACTLY. A mismatch (e.g. an FI adjustment baked into the value, a bye, evidence this module does not know about) makes every
 * arm neutral — fail closed, never guessed.
 *
 * No arm ever reads an outcome, a later observation or another player's value: inputs are the champion's own stored fields and the Role forecast.
 */

import { INJURY_MODEL_VERSION, evaluateInjuryModel, type InjuryEvidence, type SourceInjurySemantics } from "@/lib/weekly/forecast/injury-model";
import { INJURY_PRIOR_VERSION } from "@/lib/weekly/forecast/injury-priors";
import {
  C2_FULL_MODEL_ID,
  CHALLENGER_MODEL_ID,
  CONTROL_MODEL_ID,
  FROZEN_CAP_FLOOR_POINTS,
  FROZEN_CAP_FRACTION,
  FROZEN_CONF_WEIGHT,
  c2FullModel,
  challengerPositionSpec,
  controlModel,
  type RidgeModelSpec,
  type RoleConfidence,
  type ShadowPosition,
} from "./spec";

export type ArmId = "CHALLENGER" | "CONTROL" | "C2_FULL";
export const ARM_MODEL_ID: Record<ArmId, string> = { CHALLENGER: CHALLENGER_MODEL_ID, CONTROL: CONTROL_MODEL_ID, C2_FULL: C2_FULL_MODEL_ID };

export type ArmState =
  | "APPLIED"
  | "NEUTRAL_UNAVAILABLE"
  | "NEUTRAL_NOT_COVERED"
  | "NEUTRAL_MISSING_FEATURE"
  | "NEUTRAL_NO_BASELINE"
  | "NEUTRAL_NO_FROZEN_FIT"
  | "NEUTRAL_IDENTITY_MISMATCH";

export interface ArmResult {
  arm: ArmId;
  state: ArmState;
  /** points added to the conditional-on-active value; exactly 0 whenever the arm is neutral */
  delta: number;
  /** the unclamped, unweighted model output (null when neutral) */
  raw: number | null;
  capped: boolean;
  cap: number | null;
  /** the production injury model re-run on the adjusted value; equals the champion exactly when neutral */
  expected_points: number | null;
  /** P(active) after the re-run: differs from the champion's only when the delta crossed the injury model's role-tier threshold */
  p_active: number | null;
}

/** Structural subset of `RoleForecast` (lib/role-calibration/types.ts) so this module needs no import of the Role calibration code. */
export interface RoleFeatureSource {
  confidence: RoleConfidence;
  opportunity: {
    carries: number | null; rz_carries: number | null; targets: number | null; rz_targets: number | null;
    dropbacks: number | null; designed_rushes: number | null; scrambles: number | null;
  };
  metrics: { snap_share?: { value: number | null } | null; air_yards_share?: { value: number | null } | null };
}

/** The feature table, defined exactly as the frozen harness defines it (`scripts/lib/role-qualification.ts`, `x`). */
export function roleFeatures(f: RoleFeatureSource): Record<string, number | null> {
  const o = f.opportunity;
  return {
    exp_carries: o.carries, exp_targets: o.targets, exp_rz_carries: o.rz_carries, exp_rz_targets: o.rz_targets,
    exp_dropbacks: o.dropbacks, exp_designed_rushes: o.designed_rushes, exp_scrambles: o.scrambles,
    snap_share: f.metrics.snap_share?.value ?? null, air_yards_share: f.metrics.air_yards_share?.value ?? null,
  };
}

/** The injury-model evidence needed to REPRODUCE the champion's availability treatment (and re-run it on an adjusted value). */
export interface InjuryEvidenceRecord {
  source_status: string | null;
  position: string | null;
  /** the source projection the injury model saw (before availability) */
  source_points: number | null;
  source_semantics: SourceInjurySemantics;
  practice: InjuryEvidence["practice"] | null;
  official_inactive: boolean | null;
  official_active: boolean | null;
  returning_from_injury: boolean | null;
  /** only an EXPLICIT tier is replayed; a proxy tier is re-derived from the adjusted source value (that is the model's behavior) */
  role_tier: InjuryEvidence["role_tier"] | null;
  expected_workload: { fraction: number; lower?: number; upper?: number; reason?: string } | null;
  observed_at: string | null;
  mode: NonNullable<InjuryEvidence["mode"]>;
}

export interface ArmsInput {
  position: ShadowPosition;
  /** the Role forecast reduced to what the frozen models read: its confidence label and the feature table (see `roleFeatures`) */
  role: { confidence: RoleConfidence; features: Record<string, number | null> };
  /** the champion's conditional-on-active points in league scoring (production canonical forecast) */
  conditional_active_points: number | null;
  /** the champion's expected points (what production consumes) */
  expected_points: number | null;
  probability_active: number | null;
  /** the injury model's assumed embedded fraction of injury risk already in the source (null when there was no discount risk) */
  embedded_fraction: number | null;
  injury: InjuryEvidenceRecord;
  /** known unavailable (OUT / IR / SUS), bye, or no game: no arm may contribute */
  unavailable: boolean;
}

export interface ArmsOutput {
  challenger: ArmResult;
  control: ArmResult;
  c2_full: ArmResult;
  /** champion expected − expected from re-running the injury model on the UNADJUSTED recorded evidence (must be ~0 or every arm is neutral) */
  identity_residual: number | null;
  /** the shared gate that decided whether any arm may apply */
  shared_state: ArmState;
}

/** The re-run on unadjusted evidence must reproduce the champion; both are 0.01-rounded outputs of the same function, so equality is exact up to float noise. */
export const IDENTITY_TOLERANCE = 1e-6;
export const INJURY_VERSIONS = { model: INJURY_MODEL_VERSION, prior: INJURY_PRIOR_VERSION } as const;

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4 + 0; // + 0 normalizes -0
const capOf = (cond: number): number => Math.max(FROZEN_CAP_FLOOR_POINTS, FROZEN_CAP_FRACTION * Math.abs(cond));
const clamp = (v: number, cap: number): number => Math.max(-cap, Math.min(cap, v));

function neutral(arm: ArmId, state: ArmState, champion: number | null, p: number | null): ArmResult {
  return { arm, state, delta: 0, raw: null, capped: false, cap: null, expected_points: champion, p_active: p };
}

function evidenceOf(e: InjuryEvidenceRecord, sourcePoints: number): InjuryEvidence {
  return {
    source_status: e.source_status, position: e.position, source_points: sourcePoints, source_semantics: e.source_semantics, mode: e.mode,
    practice: e.practice ?? null, official_inactive: e.official_inactive, official_active: e.official_active, returning_from_injury: e.returning_from_injury,
    role_tier: e.role_tier ?? null, expected_workload: e.expected_workload, observed_at: e.observed_at,
  };
}

function ridgeRaw(m: RidgeModelSpec, valueOf: (feature: string) => number | null): number | null {
  let s = m.intercept;
  for (let j = 0; j < m.features.length; j++) {
    const v = valueOf(m.features[j]!);
    if (v == null || !Number.isFinite(v)) return null;
    s += ((v - m.mean[j]!) / m.sd[j]!) * m.coef[j]!;
  }
  return s;
}

export function computeArms(i: ArmsInput): ArmsOutput {
  const champion = i.expected_points;
  const p0 = i.probability_active;
  const all = (state: ArmState, residual: number | null = null): ArmsOutput => ({
    challenger: neutral("CHALLENGER", state, champion, p0), control: neutral("CONTROL", state, champion, p0), c2_full: neutral("C2_FULL", state, champion, p0),
    identity_residual: residual, shared_state: state,
  });
  if (i.unavailable) return all("NEUTRAL_UNAVAILABLE");
  const cond = i.conditional_active_points;
  const src = i.injury.source_points;
  if (cond == null || !Number.isFinite(cond) || champion == null || !Number.isFinite(champion) || src == null || !Number.isFinite(src)) return all("NEUTRAL_NO_BASELINE");

  // identity guard: replaying the recorded evidence through the production model must reproduce the champion exactly
  const rerun0 = evaluateInjuryModel(evidenceOf(i.injury, src));
  const residual = r4(champion - (rerun0.injury_adjusted_expected_points ?? NaN));
  if (!Number.isFinite(residual) || Math.abs(champion - (rerun0.injury_adjusted_expected_points ?? NaN)) > IDENTITY_TOLERANCE || Math.abs(cond - (rerun0.conditional_active_points ?? NaN)) > IDENTITY_TOLERANCE) {
    return all("NEUTRAL_IDENTITY_MISMATCH", Number.isFinite(residual) ? residual : null);
  }
  if (i.role.confidence === "INSUFFICIENT_SAMPLE") return all("NEUTRAL_NOT_COVERED", residual);

  const spec = challengerPositionSpec(i.position);
  const ctrl = controlModel(i.position);
  const full = c2FullModel(i.position);
  if (!spec || !ctrl || !full) return all("NEUTRAL_NO_FROZEN_FIT", residual);

  const feats = i.role.features;
  // identical eligibility: the shared gate requires EVERY Role feature the challenger needs; the control and C2_FULL follow it
  const challengerRaw = (() => {
    let s = 0;
    for (const f of spec.role_features) {
      const v = feats[f.feature];
      if (v == null || !Number.isFinite(v)) return null;
      s += f.coefficient_per_sd * ((v - f.mean) / f.sd);
    }
    return s;
  })();
  if (challengerRaw == null) return all("NEUTRAL_MISSING_FEATURE", residual);

  const valueOf = (feature: string): number | null => (feature === "b0" ? cond : feats[feature] ?? null);
  const controlRaw = ridgeRaw(ctrl, valueOf);
  const fullRaw = ridgeRaw(full, valueOf);
  if (controlRaw == null || fullRaw == null) return all("NEUTRAL_MISSING_FEATURE", residual);

  // a delta on CONDITIONAL points maps to the source value through the champion's own source-semantics factor: cond = source / (1 - lambda(1 - p))
  const lambda = i.embedded_fraction ?? 0;
  const mS = 1 - lambda * (1 - (p0 ?? 1));
  const apply = (arm: ArmId, raw: number): ArmResult => {
    const cap = capOf(cond);
    const delta = r4(FROZEN_CONF_WEIGHT[i.role.confidence] * clamp(raw, cap));
    const rr = evaluateInjuryModel(evidenceOf(i.injury, src + delta * mS));
    return { arm, state: "APPLIED", delta, raw: r4(raw), capped: Math.abs(raw) > cap, cap: r4(cap), expected_points: rr.injury_adjusted_expected_points == null ? champion : r4(rr.injury_adjusted_expected_points), p_active: rr.probability_active };
  };
  return {
    challenger: apply("CHALLENGER", challengerRaw), control: apply("CONTROL", controlRaw), c2_full: apply("C2_FULL", fullRaw),
    identity_residual: residual, shared_state: "APPLIED",
  };
}
