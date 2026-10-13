/**
 * W2.P2 — Role Shadow: the FROZEN challenger and Role-free control, loaded from the W2.P1 artifacts and pinned by hash.
 *
 * RESEARCH-ONLY. Production forecast code must never import this module (pinned by `test/role-shadow-isolation.test.ts`). Nothing here
 * changes a production number: the module only describes how a SHADOW challenger / control delta is computed from frozen coefficients.
 *
 * Frozen artifacts (W2.P1, branch intelligence-convergence-w2-p1-role-opportunity), shipped here as REVIEWED, VERSIONED COPIES in ./frozen/
 * (W2.P1 section 15: production-side code never imports the research harness or its artifacts; a future artifact must be a reviewed, versioned
 * config). `test/role-shadow-frozen.test.ts` proves each copy equals its W2.P1 original:
 *   frozen/role-opportunity-challenger-2026.0.json   byte-identical to the W2.P1 SHADOW challenger spec (centered, Role-only coefficients)
 *   frozen/w2p1-frozen-models-half.json              the 8 HALF models (Role-free control C0 and full C2 x QB/RB/WR/TE), entry-for-entry equal to FROZEN.json
 *
 * Nothing is refit, re-tuned or rewritten here. A proposed model change must ship as a NEW, separately identified model id; the integrity
 * check below makes a silent edit of a frozen coefficient fail closed (capture refuses to run, records never validate).
 */

import { contentHash } from "@/lib/bridge/hash";
import challengerJson from "./frozen/role-opportunity-challenger-2026.0.json";
import frozenJson from "./frozen/w2p1-frozen-models-half.json";

export const ROLE_SHADOW_MODULE_VERSION = "role-shadow-2026.1" as const;
export const ROLE_SHADOW_RECORD_SCHEMA_VERSION = 1 as const;

export const CHALLENGER_MODEL_ID = "role-opportunity-challenger-2026.0" as const;
export const CONTROL_MODEL_ID = "role-free-control-c0-2026.0" as const;
/** Diagnostic only (never a gate): the full offline C2 (Role features + intercept + baseline term). Reproduces the offline T2b contrast. */
export const C2_FULL_MODEL_ID = "role-opportunity-c2-full-2026.0-diagnostic" as const;

export type ShadowPosition = "QB" | "RB" | "WR" | "TE";
export const SHADOW_POSITIONS: readonly ShadowPosition[] = ["QB", "RB", "WR", "TE"];
export type RoleConfidence = "MEDIUM" | "LOW" | "INSUFFICIENT_SAMPLE";

/** Frozen shrinkage / cap convention (the existing Role shadow convention, not re-tuned). Local copies on purpose: a silent edit of
 *  `lib/role-calibration/shadow.ts` must not silently change the frozen challenger (a test pins these equal to the spec text). */
export const FROZEN_CONF_WEIGHT: Record<RoleConfidence, number> = { MEDIUM: 1, LOW: 0.6, INSUFFICIENT_SAMPLE: 0 };
export const FROZEN_CAP_FRACTION = 0.25;
export const FROZEN_CAP_FLOOR_POINTS = 1;

/** The scoring the frozen coefficients were fit on (prereg PRIMARY scoring HALF). Other scorings require their own frozen fit. */
export const FROZEN_SCORING_TEMPLATE = "HALF" as const;

export interface ChallengerFeatureSpec { feature: string; mean: number; sd: number; coefficient_per_sd: number }
export interface ChallengerPositionSpec { ridge_lambda: number; n_fit: number; role_features: ChallengerFeatureSpec[] }
export interface RidgeModelSpec { position: ShadowPosition; scoring: string; lambda: number; mean: number[]; sd: number[]; coef: number[]; intercept: number; n_fit: number; features: string[] }

interface ChallengerJson { model_id: string; status: string; positions: Record<string, ChallengerPositionSpec>; prereg_sha256: string }
interface FrozenJson { prereg_sha256: string; harness_sha256: string; driver_sha256: string; models: Record<string, RidgeModelSpec | null> }

const challengerSpec = challengerJson as unknown as ChallengerJson;
const frozen = frozenJson as unknown as FrozenJson;

export function challengerPositionSpec(pos: ShadowPosition): ChallengerPositionSpec | null {
  return challengerSpec.positions[pos] ?? null;
}
/** Role-free control C0: features = [b0] only, fitted on DEV exactly like C2 (frozen). */
export function controlModel(pos: ShadowPosition): RidgeModelSpec | null {
  return frozen.models[`C0|${pos}|${FROZEN_SCORING_TEMPLATE}`] ?? null;
}
export function c2FullModel(pos: ShadowPosition): RidgeModelSpec | null {
  return frozen.models[`C2|${pos}|${FROZEN_SCORING_TEMPLATE}`] ?? null;
}

const subset = (prefix: "C0" | "C2") =>
  Object.fromEntries(SHADOW_POSITIONS.map((p) => [p, frozen.models[`${prefix}|${p}|${FROZEN_SCORING_TEMPLATE}`] ?? null]));

/** Content hashes of the frozen configurations (canonical-JSON SHA-256, 32 hex). Carried on every capture record. */
export const configHashes = () => ({
  challenger: contentHash(challengerJson).slice(0, 32),
  control: contentHash({ id: CONTROL_MODEL_ID, models: subset("C0") }).slice(0, 32),
  c2_full: contentHash({ id: C2_FULL_MODEL_ID, models: subset("C2") }).slice(0, 32),
});

/**
 * Pinned values. File-level hashes are verified against the working tree by `test/role-shadow-frozen.test.ts`; the config hashes are
 * verified at RUNTIME (`verifyFrozenIntegrity`) because the bundled deployment cannot re-read the source files.
 */
export const PINNED = {
  candidate_file_sha256: "696c2a51a6eb8598483107623c3c9b4b15df28966b997709819a9aa3704cd23b",
  frozen_file_sha256: "ec313a8771120717da3bca0e3eda1e5375e510863b4f3eaa4b93d6ea8c908d3d",
  prereg_sha256: "aefb0ee42021f8c6a824c1fef7c5709f9d13e2bbe6e6d6e8b0d4b14651337967",
  harness_sha256: "393f064a23b0b851dc402a38aaee94091b631afce080896942f161a15c380169",
  driver_sha256: "3070507cddc779de52b16a95bbe8c94bc80464dd8655b80dc044209a3a12ab3d",
  challenger_config_hash: "a95fe2c494cee49e4dec475bb176a6bc",
  control_config_hash: "327a30acfcba88b5dc8c37576c8a25e0",
  c2_full_config_hash: "757319e18c28caa4223fd297e770a7e3",
} as const;

export interface IntegrityResult { ok: boolean; mismatches: string[] }

/** Fail-closed check that the loaded frozen configuration is byte-for-byte what W2.P1 froze. */
export function verifyFrozenIntegrity(): IntegrityResult {
  const bad: string[] = [];
  const h = configHashes();
  if (challengerSpec.model_id !== CHALLENGER_MODEL_ID) bad.push(`challenger model_id is ${challengerSpec.model_id}`);
  if (challengerSpec.prereg_sha256 !== PINNED.prereg_sha256) bad.push("challenger spec prereg_sha256 differs from the pinned pre-registration");
  if (frozen.prereg_sha256 !== PINNED.prereg_sha256) bad.push("FROZEN.json prereg_sha256 differs from the pinned pre-registration");
  if (frozen.harness_sha256 !== PINNED.harness_sha256) bad.push("FROZEN.json harness_sha256 differs from the pinned harness");
  if (frozen.driver_sha256 !== PINNED.driver_sha256) bad.push("FROZEN.json driver_sha256 differs from the pinned driver");
  if (h.challenger !== PINNED.challenger_config_hash) bad.push(`challenger config hash ${h.challenger} != pinned`);
  if (h.control !== PINNED.control_config_hash) bad.push(`control config hash ${h.control} != pinned`);
  if (h.c2_full !== PINNED.c2_full_config_hash) bad.push(`c2_full config hash ${h.c2_full} != pinned`);
  for (const p of SHADOW_POSITIONS) {
    if (!challengerPositionSpec(p)) bad.push(`challenger spec missing position ${p}`);
    if (!controlModel(p)) bad.push(`control model missing position ${p}`);
  }
  return { ok: bad.length === 0, mismatches: bad };
}

/** Versions the validator will accept on a stored record: the model id and the exact config hash it was captured under. */
export function knownModelVersions(): Record<string, string> {
  return {
    [CHALLENGER_MODEL_ID]: PINNED.challenger_config_hash,
    [CONTROL_MODEL_ID]: PINNED.control_config_hash,
    [C2_FULL_MODEL_ID]: PINNED.c2_full_config_hash,
  };
}
