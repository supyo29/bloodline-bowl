/**
 * PHASE 4 §21 / §21.4 — evidence-backed recommendation explanations.
 *
 * Every reason string is generated FROM the real decision components on the
 * recommendation object. No generic prose. The human-readable text and the
 * machine-readable `reason_codes` are two views of the same numbers, so a
 * client can show the sentence and a test can assert the code.
 */

import type {
  DraftRecommendation,
  ReasonCode,
  RosterTrajectory,
  SnakeTurnState,
} from "./schema";

export interface ReasonContext {
  turn: SnakeTurnState;
  kdstReleased: boolean;
  kdstReleaseRound: number;
  trajectory: RosterTrajectory;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

export function buildReason(
  r: DraftRecommendation,
  ctx: ReasonContext,
): { codes: ReasonCode[]; text: string } {
  const codes: ReasonCode[] = [];
  const clauses: string[] = [];

  // K/DST held
  if ((r.position === "K" || r.position === "DEF") && r.kind !== "PRIMARY_RECOMMENDATION") {
    // handled elsewhere; nothing to add
  }
  if ((r.position === "K" || r.position === "DEF") && ctx.kdstReleased) {
    codes.push("KDST_HELD_UNTIL_ENDGAME");
    clauses.push(`K/DST released at round ${ctx.kdstReleaseRound}; drafting one now is on-schedule`);
  }

  // tier cliff
  if (r.tier_drop >= 8 && r.distance_to_next_tier >= 8) {
    codes.push("TIER_CLIFF_URGENT");
    clauses.push(
      `${r.position} Tier ${r.tier} ends with this player — the next tier starts ${fmt(r.distance_to_next_tier)} points lower ` +
        `(${fmt(r.tier_survival.p_tier_survives_next_pick * 100)}% chance an equal-tier ${r.position} is still there at pick ${r.next_manager_pick ?? "?"})`,
    );
  }

  // wait loss (the core snake argument)
  const [wlLo, wlHi] = r.wait_comparison.wait_projection_loss;
  const [wvLo, wvHi] = r.wait_comparison.wait_vor_loss;
  if (Math.max(wlLo, wlHi) >= 8) {
    codes.push("EXPECTED_WAIT_LOSS");
    clauses.push(
      `passing him costs roughly ${fmt(Math.min(wlLo, wlHi))}–${fmt(Math.max(wlLo, wlHi))} projected points ` +
        `(${fmt(Math.min(wvLo, wvHi))}–${fmt(Math.max(wvLo, wvHi))} VOR): ${r.wait_comparison.basis}`,
    );
    if (r.position === "RB" && Math.max(wlLo, wlHi) >= 18) codes.push("RB_WAIT_LOSS_HIGH");
    if (r.position === "WR" && Math.max(wlLo, wlHi) >= 18) codes.push("WR_WAIT_LOSS_HIGH");
  }

  // cross-position opportunity cost (§21.3)
  const cheaperWait = r.cross_position_costs
    .filter((c) => {
      const mid = (c.wait_projection_loss[0] + c.wait_projection_loss[1]) / 2;
      const mineMid = (wlLo + wlHi) / 2;
      return mid + 6 < mineMid; // the other position holds materially better
    })
    .map((c) => c.position);
  if (cheaperWait.length > 0 && r.kind === "PRIMARY_RECOMMENDATION") {
    clauses.push(
      `${cheaperWait.join("/")} value is expected to hold better until your next pick, so the scarce board is here at ${r.position}`,
    );
  }

  // survival
  if (r.survival.p_survives_next_pick <= 0.35) {
    codes.push("LIKELY_NOT_SURVIVE");
    clauses.push(`only ${pct(r.survival.p_survives_next_pick)} estimated to reach your next pick (${r.survival.confidence.toLowerCase()} confidence)`);
  } else if (r.tier_survival.p_tier_survives_next_pick >= 0.7 && r.tier_drop < 6) {
    codes.push("EQUIVALENT_TIER_LIKELY_SURVIVES");
    clauses.push(`a comparable ${r.position} is ${pct(r.tier_survival.p_tier_survives_next_pick)} likely to still be available next turn`);
  }

  // positional advantage (QB/TE especially)
  if (r.positional_advantage >= 15) {
    codes.push("POSITIONAL_ADVANTAGE");
    clauses.push(
      `he projects ${fmt(r.positional_advantage)} points above the ${r.position} you would realistically get at your next pick`,
    );
  }

  // roster need
  if (r.roster_need > 5) {
    codes.push("ROSTER_STARTER_NEED");
    clauses.push(`fills an open ${r.position} starter need`);
  }

  // VOR anchor
  if (r.vor >= 25) {
    codes.push("HIGH_VOR");
    clauses.push(`+${fmt(r.vor)} VOR (${r.position}${r.position_rank})`);
  }

  // runs
  if (r.utility_components.urgency > 0 && r.survival.p_survives_next_pick < 0.5 && r.warnings.includes("SURVIVAL_UNCERTAIN")) {
    // leave as survival clause
  }

  // construction relief
  if (r.construction_effect.relieves_position && r.construction_effect.starter_completion_risk_before >= 0.4) {
    codes.push("CONSTRUCTION_RISK_RELIEF");
    clauses.push(
      `takes your starter-completion risk from ${pct(r.construction_effect.starter_completion_risk_before)} to ${pct(r.construction_effect.starter_completion_risk_after)}`,
    );
  }

  // market inefficiency
  if (r.warnings.includes("MARKET_DIVERGENCE_RI_HIGH")) {
    codes.push("MARKET_VALUE_INEFFICIENCY");
    clauses.push(`Roster Intel values him well above market — a potential value, flagged not vetoed`);
  }

  // uncertainty framing
  if (r.confidence.projection === "LOW" || r.confidence.projection === "VERY_LOW") {
    if (ctx.trajectory.starter_completion_risk >= 0.5) {
      codes.push("SAFE_FLOOR");
    } else {
      codes.push("CEILING_UPSIDE");
      clauses.push(`higher-variance projection — the ceiling has value this early`);
    }
  }

  // do-not-reach
  if (r.kind === "DO_NOT_REACH") {
    codes.push("DO_NOT_REACH_SURVIVES");
    clauses.push(
      `${pct(r.survival.p_survives_next_pick)} likely to still be available at pick ${r.next_manager_pick ?? "?"} — ` +
        `spending pick ${r.current_pick ?? "?"} on him is ~${fmt(r.reach_cost)} points of avoidable reach`,
    );
  }

  const verb =
    r.kind === "PRIMARY_RECOMMENDATION"
      ? "Draft"
      : r.kind === "DO_NOT_REACH"
        ? "Do not reach for"
        : r.kind === "WAIT_CANDIDATE"
          ? "Can wait on"
          : "Alternative:";
  const head = `${verb} ${r.player_name} (${r.position}${r.position_rank}, Tier ${r.tier}).`;
  const body = clauses.length > 0 ? ` ${clauses.join(". ")}.` : ` +${fmt(r.vor)} VOR; score ${fmt(r.recommendation_score)}.`;

  return { codes: dedupe(codes), text: (head + body).replace(/\.\./g, ".") };
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
