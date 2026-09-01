/**
 * Phase 3 — draft-capital rookie opportunity prior (`ri-structural-2026.3`).
 *
 * RESEARCH RESULT (`analysis/phase3_rookie_role_model.R`, rolling season-aware
 * validation over draft classes 2015-2025, 2025 held out):
 *
 *   - The pre-Phase-3 prior (`rookieRolePrior`, a depth-chart-slot lookup) ranks
 *     rookies poorly (Spearman 0.40) and has MAE ~50 season PPR points.
 *   - A quasi-Poisson GLM on **NFL draft position alone** (`log(1+pick)` +
 *     `round`), one per position, cuts held-out MAE to ~40, lifts Spearman to
 *     ~0.61, and beats the old prior by a paired −8 to −10 PPR points
 *     (2025 holdout: −8.0 [−14.1, −1.9], 99% of bootstraps improved).
 *   - **College production / usage / shares add NO incremental value after
 *     draft capital** (M4 vs M1 paired CI spans 0; M5 with destination context
 *     HURTS). College data is deliberately excluded.
 *   - Applied to WR / RB / TE only. QB draft-capital effect is directionally
 *     positive but its paired CI spans 0 (n=81, dispersion 4.9) so QB handling
 *     in `model.ts` is unchanged (Phase 3 report §22).
 *
 * Coefficients are frozen from a full-cohort fit (2015-2025) — see
 * `outputs/projections-2026/phase3_frozen_rookie_model.csv`. The R harness and
 * this module are parity-checked in `test/projection-rookie-model.test.ts`.
 *
 * Integration: this replaces only the WR/RB/TE branch of `rookieRolePrior`; the
 * output shape (`target_pg`, `carry_pg`, `snap_share`) is identical so the
 * existing team-pool normalisation / efficiency / games layers are untouched.
 */

import type { FantasyPosition } from "./schema";

export const ROOKIE_MODEL_VERSION = "ri-structural-2026.3";

/** Quasi-Poisson (log link) coefficients, frozen from the 2015-2025 cohort. */
interface RookieCoef {
  intercept: number;
  b_log_pick: number;
  b_round: number;
  /** multiplicative residual ratios actual/predicted at P20 / P50 / P80 */
  resid_q20: number;
  resid_q50: number;
  resid_q80: number;
  /** football-plausibility clamp on the per-game prediction (~observed range) */
  cap: number;
}

const COEF: Record<string, RookieCoef> = {
  WR_target_pg: { intercept: 2.61785, b_log_pick: -0.28364, b_round: -0.07143, resid_q20: 0.594, resid_q50: 0.922, resid_q80: 1.384, cap: 9.0 },
  TE_target_pg: { intercept: 2.77562, b_log_pick: -0.40086, b_round: -0.02273, resid_q20: 0.631, resid_q50: 0.901, resid_q80: 1.340, cap: 8.5 },
  RB_carry_pg:  { intercept: 3.33206, b_log_pick: -0.17999, b_round: -0.16212, resid_q20: 0.518, resid_q50: 0.901, resid_q80: 1.444, cap: 16.0 },
  RB_target_pg: { intercept: 2.14726, b_log_pick: -0.24508, b_round: -0.13929, resid_q20: 0.474, resid_q50: 0.945, resid_q80: 1.528, cap: 6.0 },
};

/** UDFA / unknown pick sentinel: treated as pick 261, round 8. */
export const UDFA_PICK = 261;
export const UDFA_ROUND = 8;

function predictPg(key: string, pick: number, round: number): number {
  const c = COEF[key]!;
  const raw = Math.exp(c.intercept + c.b_log_pick * Math.log1p(pick) + c.b_round * round);
  return Math.min(raw, c.cap);
}

export interface RookieDraft {
  pick: number;
  round: number;
}

export interface RookieOpportunity {
  target_pg: number;
  carry_pg: number;
  snap_share: number;
  /** P20 / P80 multiplicative band on the projected opportunity (for uncertainty). */
  band: { lo: number; hi: number };
  source: "draft_capital";
}

/**
 * Draft-capital opportunity prior for a WR / RB / TE rookie. Returns the same
 * per-game quantities as the legacy `rookieRolePrior`, plus an uncertainty band.
 * Returns `null` for QB (handled elsewhere) or an unsupported position.
 */
export function rookieOpportunityPrior(
  position: FantasyPosition,
  draft: RookieDraft,
): RookieOpportunity | null {
  const pick = Number.isFinite(draft.pick) && draft.pick > 0 ? draft.pick : UDFA_PICK;
  const round = Number.isFinite(draft.round) && draft.round > 0 ? draft.round : UDFA_ROUND;

  if (position === "WR") {
    const t = predictPg("WR_target_pg", pick, round);
    return {
      target_pg: t,
      carry_pg: 0.3,
      snap_share: snapFromTargets(t, "WR"),
      band: bandFor("WR_target_pg", t),
      source: "draft_capital",
    };
  }
  if (position === "TE") {
    const t = predictPg("TE_target_pg", pick, round);
    return {
      target_pg: t,
      carry_pg: 0,
      snap_share: snapFromTargets(t, "TE"),
      band: bandFor("TE_target_pg", t),
      source: "draft_capital",
    };
  }
  if (position === "RB") {
    const carry = predictPg("RB_carry_pg", pick, round);
    const tgt = predictPg("RB_target_pg", pick, round);
    return {
      target_pg: tgt,
      carry_pg: carry,
      snap_share: snapFromRb(carry + tgt),
      band: bandFor("RB_carry_pg", carry),
      source: "draft_capital",
    };
  }
  return null;
}

function bandFor(key: string, pointPg: number): { lo: number; hi: number } {
  const c = COEF[key]!;
  return {
    lo: round2((pointPg / Math.max(c.resid_q50, 1e-6)) * c.resid_q20),
    hi: round2((pointPg / Math.max(c.resid_q50, 1e-6)) * c.resid_q80),
  };
}

/** Rough snap share from projected target volume — matches the scale of the old prior. */
function snapFromTargets(tpg: number, pos: "WR" | "TE"): number {
  if (pos === "WR") return clamp(0.30 + 0.065 * tpg, 0.15, 0.9);
  return clamp(0.28 + 0.085 * tpg, 0.12, 0.85);
}
function snapFromRb(oppPg: number): number {
  return clamp(0.12 + 0.033 * oppPg, 0.1, 0.85);
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/* -------------------------------------------------------- 2026 draft crosswalk */

import { ROOKIE_DRAFT_2026 } from "./data/rookie-draft-2026";

let draftBySleeperId: Map<string, RookieDraft> | null = null;

/** `sleeper_id -> {pick, round}` for 2026 skill rookies, from the vendored nflverse crosswalk. */
export function rookieDraftFor(sleeperPlayerId: string): RookieDraft | null {
  if (!draftBySleeperId) {
    draftBySleeperId = new Map();
    for (const p of ROOKIE_DRAFT_2026.picks) {
      draftBySleeperId.set(p.sleeper_id, { pick: p.pick, round: p.round });
    }
  }
  return draftBySleeperId.get(sleeperPlayerId) ?? null;
}

export function rookieDraftClassSize(): number {
  return ROOKIE_DRAFT_2026.picks.length;
}
