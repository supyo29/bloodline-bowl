/**
 * The ONE sanctioned integration point for FI to influence a production weekly projection batch, permanently gated by the
 * deployment contract AND (Phase 8) by a feature-family x position gate.
 *
 * Nothing in production calls this today (a source-scan test pins that). It exists so a future explicit deployment can wire it
 * in one place, and so tests can prove FI cannot enter production without: a PRODUCTION_ACTIVE position, a PRODUCTION_ACTIVE
 * FAMILY, certified evidence, a certified translation, a CURRENT canonical freshness assessment with the family's own sources
 * usable, a compatible scoring fingerprint, resolved Phase 7 temporal identity, and an FI vintage that does not post-date the
 * decision. Any gate failing -> that family contributes nothing; no gate context -> nothing is applied (fail closed).
 *
 * Phase 8 tightening: position-level PRODUCTION_ACTIVE is now NECESSARY BUT NOT SUFFICIENT. A position that is ACTIVE with no
 * ACTIVE family applies nothing, so an uncertified family can never ride along with a certified one.
 *
 * Consumer scope: START_SIT only. TIE_BREAK_ONLY families are never added to `projected_points` (that would leak into the lineup
 * optimizer, waivers, matchup, trades); their expected adjustment is recorded in the ledger for `startSitPick()` alone.
 */

import type { WeeklyProjectionBatch, WeeklyProjection } from "../schema";
import type { StartSitModel } from "./translate";
import { translateFiAdjustment } from "./translate";
import { fiMayInfluenceProduction, deploymentContract } from "./deployment";
import { loadFootballIntelligence } from "@/lib/football-intel";
import { certifiedTranslationFor, evaluateFamilyGate, type FamilyGateContext } from "./family-gate";
import { ContributionLedger, FI_CONTRIBUTION_OWNER, type FiContributionEntry } from "./contribution-ledger";
import type { FiCertification } from "./certification";

export interface ProductionGateResult {
  batch: WeeklyProjectionBatch;
  /** true only if the contract activated at least one family AND a value changed. */
  fi_applied: boolean;
  applied_positions: string[];
  deployment: string;
  reason: string;
  /** Phase 8: every family-level decision (applied or blocked) for traceability. */
  ledger: readonly FiContributionEntry[];
  ledger_violations: readonly string[];
}

export function applyFiToProductionBatch(
  batch: WeeklyProjectionBatch,
  input: {
    positionOf: (canonicalPlayerId: string) => string | null;
    request_season: number;
    model?: StartSitModel | null;
    fi?: ReturnType<typeof loadFootballIntelligence> | null;
    /** Phase 8: per-request gate context (canonical freshness assessment, scoring fingerprint, decision week, ...). Required whenever any family is active. */
    gate?: Omit<FamilyGateContext, "temporal_membership_resolved"> & { temporal_resolved_for?: (canonicalPlayerId: string) => boolean };
    certification?: FiCertification | null;
    baseline_projection_version?: string | null;
  },
): ProductionGateResult {
  const model = input.model ?? null;
  const contract = deploymentContract(model);
  const ledger = new ContributionLedger();
  const done = (b: WeeklyProjectionBatch, applied: boolean, positions: string[], reason: string): ProductionGateResult =>
    ({ batch: b, fi_applied: applied, applied_positions: positions, deployment: contract.deployment, reason, ledger: ledger.entries(), ledger_violations: ledger.violations });

  const anyFamilyActive = Object.values(contract.family_positions ?? {}).some((fams) => Object.values(fams ?? {}).some((s) => s === "PRODUCTION_ACTIVE"));
  // fast path: no FAMILY is PRODUCTION_ACTIVE -> guaranteed identity batch (position/whole-model state alone never applies FI)
  if (!anyFamilyActive) return done(batch, false, [], "no feature family is PRODUCTION_ACTIVE — projection batch returned unchanged");
  // fail closed: an active family with no per-request gate context can never be verified fresh/compatible
  if (!input.gate) return done(batch, false, [], "family gate context not supplied — projection batch returned unchanged (fail closed)");

  const fi = input.fi !== undefined ? input.fi : loadFootballIntelligence();
  const next = new Map<string, WeeklyProjection>();
  const applied = new Set<string>();
  for (const [id, proj] of batch.by_player) {
    const pos = input.positionOf(id) ?? proj.position;
    const mp = pos ? model?.positions[pos] : undefined;
    if (!pos || !mp?.families?.length || !fiMayInfluenceProduction(model, pos) || proj.projected_points == null) { next.set(id, proj); continue; }

    const ctx: FamilyGateContext = { ...input.gate, temporal_membership_resolved: input.gate.temporal_resolved_for ? input.gate.temporal_resolved_for(id) : false };
    const allowed = new Set<string>();
    const residualFamilies = new Set<string>();
    for (const f of mp.families) {
      const dec = evaluateFamilyGate(model, f.family, pos, ctx, input.certification);
      const tr = certifiedTranslationFor(model, f.family, pos);
      // the certified translation must be the one that was evaluated: a coefficient mismatch blocks the family
      const mismatch = !!tr && Math.abs(tr.beta - f.beta) > 1e-6;
      const ok = dec.allowed && !mismatch;
      if (ok) { allowed.add(f.family); if (tr!.kind === "RESIDUAL_ADJUSTMENT") residualFamilies.add(f.family); }
      else if (dec.family_state === "PRODUCTION_ACTIVE") {
        ledger.record({ owner: FI_CONTRIBUTION_OWNER, canonical_player_id: id, position: pos, family: f.family, fi_version: fi?.manifest.version ?? null, fi_through_week: ctx.fi_through_week,
          scoring_fingerprint: ctx.scoring_fingerprint, baseline_projection_version: input.baseline_projection_version ?? null, translation_version: tr?.certification_version ?? null,
          certification_version: tr?.certification_version ?? null, deployment_state: dec.family_state, freshness_status: ctx.freshness?.overall_status ?? null, temporal_membership_version: null,
          expected_adjustment: 0, baseline_projection: proj.projected_points, final_projection: proj.projected_points, applied: false,
          blocked_by: mismatch ? [...dec.reasons, "NO_CERTIFIED_TRANSLATION"] : dec.reasons });
      }
    }
    if (!allowed.size) { next.set(id, proj); continue; }

    const adj = translateFiAdjustment({ canonical_player_id: id, position: pos, nfl_team: proj.nfl_team, opponent: proj.opponent, baseline_projection: proj.projected_points,
      request_season: input.request_season, fi, model, only_families: allowed });
    let addToProjection = 0;
    for (const c of adj.contributions) {
      const tr = certifiedTranslationFor(model, c.family, pos)!;
      const cap = tr.cap_fraction * Math.abs(proj.projected_points);
      const bounded = Number.isFinite(c.points_contribution) ? Math.max(-cap, Math.min(cap, c.points_contribution)) : 0;
      const isResidual = residualFamilies.has(c.family);
      if (isResidual) addToProjection += bounded;
      ledger.record({ owner: FI_CONTRIBUTION_OWNER, canonical_player_id: id, position: pos, family: c.family, fi_version: fi?.manifest.version ?? null, fi_through_week: ctx.fi_through_week,
        scoring_fingerprint: ctx.scoring_fingerprint, baseline_projection_version: input.baseline_projection_version ?? null, translation_version: tr.certification_version,
        certification_version: tr.certification_version, deployment_state: "PRODUCTION_ACTIVE", freshness_status: ctx.freshness?.overall_status ?? null, temporal_membership_version: null,
        expected_adjustment: bounded, baseline_projection: proj.projected_points, final_projection: isResidual ? Math.round((proj.projected_points + bounded) * 100) / 100 : proj.projected_points,
        applied: isResidual, blocked_by: [] });
    }
    if (addToProjection === 0) { next.set(id, proj); continue; }
    applied.add(pos);
    next.set(id, { ...proj, projected_points: Math.round((proj.projected_points + addToProjection) * 100) / 100,
      warnings: [...proj.warnings, `fi_production_adjustment_applied:${model?.start_sit_model_version ?? "?"}`] });
  }

  return done({ ...batch, by_player: next }, applied.size > 0, [...applied],
    applied.size > 0 ? `FI applied for certified PRODUCTION_ACTIVE famil(ies) at position(s): ${[...applied].join(", ")}` : "families active but no gate-allowed non-zero residual adjustment produced");
}
