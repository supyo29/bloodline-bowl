/**
 * Phase 9 Step 4 — deterministic weekly audit identity. NEVER a wall-clock timestamp: two runs over the SAME
 * evidence (same captures, same outcomes, same source versions) produce the SAME `audit_id`, so a re-run is a
 * no-op (idempotent insert). New evidence (e.g. a corrected outcome, a newly attached decision) changes the
 * `evidence_digest` and therefore produces an ADDITIVE new `audit_id` — old audit rows are never mutated
 * (see the immutable-insert-only trigger on `bridge_weekly_model_audit`).
 */
import { createHash } from "node:crypto";
import { WEEKLY_AUDIT_SCHEMA_VERSION } from "./contract";

/** Stable regardless of key order or array order within each input list (each is sorted before hashing). */
export function evidenceDigest(inputs: {
  fi_version: string | null;
  scoring_fingerprints: readonly string[];
  startsit_capture_ids: readonly string[];
  startsit_outcome_sources: readonly string[];
  matchup2_capture_ids: readonly string[];
  matchup2_outcome_sources: readonly string[];
  waiver2_capture_ids: readonly string[];
  waiver2_outcome_sources: readonly string[];
  certification_version: string | null;
}): string {
  const norm = {
    fi_version: inputs.fi_version,
    scoring_fingerprints: [...inputs.scoring_fingerprints].sort(),
    startsit_capture_ids: [...inputs.startsit_capture_ids].sort(),
    startsit_outcome_sources: [...inputs.startsit_outcome_sources].sort(),
    matchup2_capture_ids: [...inputs.matchup2_capture_ids].sort(),
    matchup2_outcome_sources: [...inputs.matchup2_outcome_sources].sort(),
    waiver2_capture_ids: [...inputs.waiver2_capture_ids].sort(),
    waiver2_outcome_sources: [...inputs.waiver2_outcome_sources].sort(),
    certification_version: inputs.certification_version,
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 16);
}

export function auditId(season: number, week: number, digest: string, schemaVersion = WEEKLY_AUDIT_SCHEMA_VERSION): string {
  return `wa:${season}:${week}:v${schemaVersion}:${digest}`;
}
