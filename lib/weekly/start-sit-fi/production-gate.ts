/**
 * Phase 4 remediation Part A — the ONE sanctioned integration point for FI to
 * influence a production weekly projection batch, permanently gated by the
 * deployment contract.
 *
 * Nothing in production calls this today. It exists so that (a) a future
 * explicit deployment can wire it in one place, and (b) a regression test can
 * prove FI cannot enter production without a `PRODUCTION_ACTIVE` contract.
 *
 * `buildOptimalLineup`, `compareStartSit`, waiver / matchup / trade code all
 * consume `ctx.projections` directly and never see an FI-adjusted value.
 */

import type { WeeklyProjectionBatch, WeeklyProjection } from "../schema";
import type { StartSitModel } from "./translate";
import { translateFiAdjustment } from "./translate";
import { fiMayInfluenceProduction, deploymentContract } from "./deployment";
import { loadFootballIntelligence } from "@/lib/football-intel";

export interface ProductionGateResult {
  batch: WeeklyProjectionBatch;
  /** true only if the contract activated at least one position AND a value changed. */
  fi_applied: boolean;
  applied_positions: string[];
  deployment: string;
  reason: string;
}

/**
 * Return a projection batch for the production optimizer. Identical to the
 * input unless the deployment contract marks a player's position
 * `PRODUCTION_ACTIVE` — in which case that player's projection carries the
 * bounded FI adjustment. Pure given (batch, model, FI snapshot).
 */
export function applyFiToProductionBatch(
  batch: WeeklyProjectionBatch,
  input: {
    positionOf: (canonicalPlayerId: string) => string | null;
    request_season: number;
    model?: StartSitModel | null;
    fi?: ReturnType<typeof loadFootballIntelligence> | null;
  },
): ProductionGateResult {
  const model = input.model ?? null;
  const contract = deploymentContract(model);

  // fast path: no position is PRODUCTION_ACTIVE -> guaranteed identity batch
  const anyActive =
    contract.deployment === "PRODUCTION_ACTIVE" ||
    Object.values(contract.positions).some((s) => s === "PRODUCTION_ACTIVE");
  if (!anyActive) {
    return {
      batch,
      fi_applied: false,
      applied_positions: [],
      deployment: contract.deployment,
      reason: "no position is PRODUCTION_ACTIVE — projection batch returned unchanged",
    };
  }

  const fi = input.fi !== undefined ? input.fi : loadFootballIntelligence();
  const next = new Map<string, WeeklyProjection>();
  const applied = new Set<string>();
  for (const [id, proj] of batch.by_player) {
    const pos = input.positionOf(id) ?? proj.position;
    if (!pos || !fiMayInfluenceProduction(model, pos) || proj.projected_points == null) {
      next.set(id, proj);
      continue;
    }
    const adj = translateFiAdjustment({
      canonical_player_id: id,
      position: pos,
      nfl_team: proj.nfl_team,
      opponent: proj.opponent,
      baseline_projection: proj.projected_points,
      request_season: input.request_season,
      fi,
      model,
    });
    if (adj.expected_adjustment === 0) {
      next.set(id, proj);
      continue;
    }
    applied.add(pos);
    next.set(id, {
      ...proj,
      projected_points: Math.round((proj.projected_points + adj.expected_adjustment) * 100) / 100,
      warnings: [...proj.warnings, `fi_production_adjustment_applied:${model?.start_sit_model_version ?? "?"}`],
    });
  }

  return {
    batch: { ...batch, by_player: next },
    fi_applied: applied.size > 0,
    applied_positions: [...applied],
    deployment: contract.deployment,
    reason:
      applied.size > 0
        ? `FI applied for PRODUCTION_ACTIVE position(s): ${[...applied].join(", ")}`
        : "positions active but no non-zero adjustment produced",
  };
}
