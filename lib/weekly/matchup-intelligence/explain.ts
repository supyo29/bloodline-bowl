/**
 * Phase 5 — scenario explanations. Every message maps to actual simulator
 * inputs (spec §24) — no invented football narrative.
 */
import type { ScenarioExplanation } from "./schema";
import type { SimOutput } from "./simulator";

export function buildExplanations(sim: SimOutput, ctx: {
  team_expected: number;
  opp_expected: number;
  team_sd: number;
  opp_sd: number;
  questionable_starters: number;
  uncalibrated_positions: string[];
  opponent_view: string;
}): ScenarioExplanation[] {
  const out: ScenarioExplanation[] = [];
  const wp = sim.win_probability;
  const edge = ctx.team_expected - ctx.opp_expected;

  out.push({
    code: "EXPECTED_SCORE_EDGE",
    message: `Expected ${ctx.team_expected.toFixed(1)} vs ${ctx.opp_expected.toFixed(1)} (${edge >= 0 ? "+" : ""}${edge.toFixed(1)}); simulated win probability ${Math.round(wp * 100)}%.`,
    evidence: { team_expected: ctx.team_expected, opp_expected: ctx.opp_expected, expected_margin: sim.expected_margin, win_probability: sim.win_probability },
  });

  if (wp >= 0.65 && sim.upset_probability === 0) {
    out.push({
      code: "FAVORED",
      message: `Favored — the opponent needs a ${(-sim.margin.p10 + edge).toFixed(0)}+ point swing (their ~90th percentile vs your ~10th) to win.`,
      evidence: { win_probability: wp, margin_p10: sim.margin.p10, blowout_probability: sim.blowout_probability },
    });
  } else if (wp <= 0.35) {
    out.push({
      code: "UNDERDOG",
      message: `Underdog — a win needs your upside: your ${sim.team_score.p90.toFixed(0)} ceiling against their ${sim.opponent_score.p25.toFixed(0)} floor. Upset probability ${Math.round(sim.upset_probability * 100)}%.`,
      evidence: { win_probability: wp, team_p90: sim.team_score.p90, opp_p25: sim.opponent_score.p25, upset_probability: sim.upset_probability },
    });
  } else {
    out.push({
      code: "TOSS_UP",
      message: `Close matchup (${Math.round(wp * 100)}%±${Math.round(sim.win_probability_se * 100)}%) — the margin distribution straddles 0 (p25 ${sim.margin.p25.toFixed(0)}, p75 ${sim.margin.p75.toFixed(0)}).`,
      evidence: { win_probability: wp, margin_p25: sim.margin.p25, margin_p75: sim.margin.p75, sim_se: sim.win_probability_se },
    });
  }

  if (ctx.questionable_starters > 0) {
    out.push({
      code: "INJURY_VARIANCE",
      message: `${ctx.questionable_starters} questionable starter(s) — their distributions are widened by the validated injury factor, so the win probability is less certain than the point margin suggests.`,
      evidence: { questionable_starters: ctx.questionable_starters, team_sd: ctx.team_sd },
    });
  }
  if (ctx.uncalibrated_positions.length > 0) {
    out.push({
      code: "UNCALIBRATED_POSITION",
      message: `Distribution not calibrated for ${ctx.uncalibrated_positions.join(", ")} — that position falls back to the heuristic band and the win probability is degraded accordingly.`,
      evidence: { uncalibrated_positions: ctx.uncalibrated_positions.join(",") },
    });
  }
  if (ctx.opponent_view !== "SUBMITTED") {
    out.push({
      code: "OPPONENT_LINEUP_ASSUMED",
      message: `Opponent evaluated on their ${ctx.opponent_view} lineup (their submitted lineup had a bye/out/empty starter a manager would fix), not their exact current starters.`,
      evidence: { opponent_view: ctx.opponent_view },
    });
  }
  return out;
}
