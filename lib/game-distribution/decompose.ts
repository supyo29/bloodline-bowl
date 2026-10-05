/**
 * Six-way exact decomposition of a fantasy projection error (points, one league scoring), extending Phase 2's role/efficiency split with GAME VOLUME
 * (script) and with touchdown / turnover components carved out of efficiency:
 *
 *   actual - baseline = baseline_gap        (xFP_forecast - baseline)            non-role disagreement of the baseline with the football forecast
 *                     + volume_script       (xFP_actualVolume - xFP_forecast)    team pass/rush volume differed from forecast (game script)
 *                     + role_share          (xFP_actualOpp - xFP_actualVolume)   player's share of that volume differed from forecast
 *                     + td_variance         (actual TD pts - expected TD pts at the actual opportunity)
 *                     + turnover_variance   (actual INT/fumble pts - expected at the actual opportunity)
 *                     + yardage_efficiency  (the remainder: yards, catches, other scored events)
 * The identity is exact by construction (yardage_efficiency is the remainder).
 */
import { expectedStatLine, scoreExpectedLine, opportunityFromObserved } from "@/lib/role-calibration/xfp";
import { opportunityFrom } from "@/lib/role-calibration/forecast";
import type { ObservedRow, YieldTable } from "@/lib/role-calibration/data";
import type { RoleForecast, RolePosition } from "@/lib/role-calibration/types";

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
export interface Decomp6 { total_error: number; baseline_gap: number; volume_script: number; role_share: number; td_variance: number; turnover_variance: number; yardage_efficiency: number }

function tdTurnoverPoints(line: Record<string, number>, pos: RolePosition, raw: Record<string, number>): { td: number; to: number } {
  const only = (keys: string[]) => { const l: Record<string, number> = {}; for (const k of keys) if (line[k]) l[k] = line[k]!; return scoreExpectedLine(pos, l, raw); };
  return { td: only(["pass_td", "rush_td", "rec_td"]), to: only(["pass_int", "fum_lost"]) };
}
/** `actualLine` = provider stat line of the game (Sleeper keys); `actualRow` = observed role row (team volumes + opportunity). */
export function decompose6(a: { pos: RolePosition; baseline: number; actual: number; forecast: RoleForecast; actualRow: ObservedRow; actualLine: Record<string, number> | null; yields: YieldTable; raw: Record<string, number> }): Decomp6 | null {
  const { pos, forecast: f, actualRow: r, yields: y, raw } = a;
  const xf = scoreExpectedLine(pos, expectedStatLine(pos, f.opportunity, y), raw);
  // forecast SHARES applied to the ACTUAL team volumes
  const av = { team_pass_att: r.team_pass_att, team_rush_att: r.team_rush_att, team_rz_pass_att: r.team_rz_pass_att, team_rz_rush_att: r.team_rz_rush_att };
  const v = (m: "rush_share" | "rz_carry_share" | "target_share" | "rz_target_share") => f.metrics[m]?.value_with_pressure ?? null;
  const qbScaled = pos === "QB" && f.opportunity.dropbacks != null && f.volumes.team_pass_att ? { dropbacks: f.opportunity.dropbacks * ((av.team_pass_att ?? f.volumes.team_pass_att) / f.volumes.team_pass_att), designed_rushes: f.opportunity.designed_rushes, scrambles: f.opportunity.scrambles } : null;
  const oppV = opportunityFrom(pos, { rush_share: v("rush_share"), rz_carry_share: v("rz_carry_share"), target_share: v("target_share"), rz_target_share: v("rz_target_share") }, { ...av }, qbScaled);
  const xv = scoreExpectedLine(pos, expectedStatLine(pos, oppV, y), raw);
  const actualOpp = opportunityFromObserved(pos, r);
  const lineA = expectedStatLine(pos, actualOpp, y);
  const xa = scoreExpectedLine(pos, lineA, raw);
  if (!a.actualLine) return null;
  const exp = tdTurnoverPoints(lineA, pos, raw), act = tdTurnoverPoints(a.actualLine, pos, raw);
  const td = act.td - exp.td, to = act.to - exp.to;
  const efficiencyTotal = a.actual - xa;
  return { total_error: r4(a.actual - a.baseline), baseline_gap: r4(xf - a.baseline), volume_script: r4(xv - xf), role_share: r4(xa - xv), td_variance: r4(td), turnover_variance: r4(to), yardage_efficiency: r4(efficiencyTotal - td - to) };
}
export const DECOMP6_KEYS = ["baseline_gap", "volume_script", "role_share", "td_variance", "turnover_variance", "yardage_efficiency"] as const;
