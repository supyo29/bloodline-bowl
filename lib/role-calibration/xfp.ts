/**
 * Opportunity -> expected football stat line -> expected fantasy points ("xFP").
 *
 * Yields are league-wide, PRIOR-SEASON (out-of-sample), red-zone split, scoring neutral (analysis/role_calibration/export_position_yields.R).
 * Fantasy scoring is applied per league fingerprint with the repo's single scoring path (Phase 6 `materializeScoringEvents` +
 * `scoreWeeklyLine`) so one football forecast translates differently per league.
 *
 * The SAME function prices forecast opportunity and actual opportunity, which makes the decomposition in decompose.ts an exact identity.
 * Not modeled (identically on both sides): threshold bonuses (e.g. 100-yard games), 2-pt conversions, WR/TE rushing, return yards.
 */
import { materializeScoringEvents } from "@/lib/scoring/derived-events";
import { scoreWeeklyLine } from "@/lib/weekly/scoring";
import type { ObservedRow, YieldTable } from "./data";
import type { ExpectedOpportunity, RolePosition } from "./types";

type Line = Record<string, number>;
const add = (l: Line, k: string, v: number): void => { l[k] = (l[k] ?? 0) + v; };

export function expectedStatLine(pos: RolePosition, o: ExpectedOpportunity, y: YieldTable): Line {
  const line: Line = {};
  const rush = (position: string, kind: string, carries: number | null, rzCarries: number | null) => {
    if (carries == null || carries <= 0) return;
    const rz = Math.min(rzCarries ?? 0, carries), non = carries - rz;
    const nz = y.rush.find((r) => r.position === position && r.kind === kind && r.zone === "nonrz");
    const rzy = y.rush.find((r) => r.position === position && r.kind === kind && r.zone === "rz");
    if (!nz || !rzy) return;
    add(line, "rush_att", carries);
    add(line, "rush_yd", non * nz.ypc + rz * rzy.ypc);
    add(line, "rush_td", non * nz.td + rz * rzy.td);
    add(line, "fum_lost", non * nz.fum_lost + rz * rzy.fum_lost);
  };
  if (pos === "QB") {
    const D = o.dropbacks ?? 0;
    if (D > 0) {
      const rzD = Math.min(o.rz_dropbacks ?? 0, D), nonD = D - rzD;
      const dbN = y.qb_dropback.find((r) => r.zone === "nonrz"), dbR = y.qb_dropback.find((r) => r.zone === "rz");
      const paN = y.qb_pass_attempt.find((r) => r.zone === "nonrz"), paR = y.qb_pass_attempt.find((r) => r.zone === "rz");
      if (dbN && dbR && paN && paR) {
        const attN = nonD * dbN.pass_att_rate, attR = rzD * dbR.pass_att_rate;
        add(line, "pass_att", attN + attR);
        add(line, "pass_cmp", attN * paN.cmp_rate + attR * paR.cmp_rate);
        add(line, "pass_yd", attN * paN.yards_per_att + attR * paR.yards_per_att);
        add(line, "pass_td", attN * paN.td_per_att + attR * paR.td_per_att);
        add(line, "pass_int", attN * paN.int_per_att + attR * paR.int_per_att);
        add(line, "pass_sack", nonD * dbN.sack_rate + rzD * dbR.sack_rate);
      }
    }
    // QB rushing: designed + scrambles, priced with the league-wide QB mixture of red-zone / non-red-zone yields
    for (const [kind, n] of [["designed", o.designed_rushes], ["scramble", o.scrambles]] as const) {
      if (n == null || n <= 0) continue;
      const nz = y.rush.find((r) => r.position === "QB" && r.kind === kind && r.zone === "nonrz"), rz = y.rush.find((r) => r.position === "QB" && r.kind === kind && r.zone === "rz");
      if (!nz || !rz) continue;
      const w = nz.n / (nz.n + rz.n);
      add(line, "rush_att", n); add(line, "rush_yd", n * (w * nz.ypc + (1 - w) * rz.ypc)); add(line, "rush_td", n * (w * nz.td + (1 - w) * rz.td)); add(line, "fum_lost", n * (w * nz.fum_lost + (1 - w) * rz.fum_lost));
    }
    return line;
  }
  if (pos === "RB") rush("RB", "rush", o.carries, o.rz_carries);
  const T = o.targets ?? 0;
  if (T > 0) {
    const rz = Math.min(o.rz_targets ?? 0, T), non = T - rz;
    const nz = y.receiving.find((r) => r.position === pos && r.zone === "nonrz"), rzy = y.receiving.find((r) => r.position === pos && r.zone === "rz");
    if (nz && rzy) {
      add(line, "rec_tgt", T);
      add(line, "rec", non * nz.catch_rate + rz * rzy.catch_rate);
      add(line, "rec_yd", non * nz.yards_per_target + rz * rzy.yards_per_target);
      add(line, "rec_td", non * nz.td_per_target + rz * rzy.td_per_target);
      add(line, "fum_lost", non * nz.fum_lost + rz * rzy.fum_lost);
    }
  }
  return line;
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
/** Expected fantasy points for an expected stat line under one league's raw scoring (the repo's single scoring path). */
export function scoreExpectedLine(pos: RolePosition, line: Line, rawScoring: Record<string, number>): number {
  if (!Object.keys(line).length) return 0;
  const materialized = materializeScoringEvents(line, { position: pos }).stats;
  return r4(scoreWeeklyLine(materialized, rawScoring).points);
}
export const expectedPoints = (pos: RolePosition, o: ExpectedOpportunity, y: YieldTable, rawScoring: Record<string, number>): number => scoreExpectedLine(pos, expectedStatLine(pos, o, y), rawScoring);

/** ACTUAL opportunity of a completed game, structured exactly like the forecast (position rules identical). */
export function opportunityFromObserved(pos: RolePosition, r: ObservedRow): ExpectedOpportunity {
  const empty: ExpectedOpportunity = { carries: null, rz_carries: null, targets: null, rz_targets: null, dropbacks: null, rz_dropbacks: null, designed_rushes: null, scrambles: null };
  if (pos === "QB") {
    const ratio = r.team_pass_att && r.team_rz_pass_att != null ? Math.min(1, r.team_rz_pass_att / r.team_pass_att) : null;
    return { ...empty, dropbacks: r.dropbacks, rz_dropbacks: r.dropbacks != null && ratio != null ? r.dropbacks * ratio : null, designed_rushes: r.designed_rushes, scrambles: r.qb_scrambles };
  }
  return { ...empty, carries: pos === "RB" ? r.carries : null, rz_carries: pos === "RB" ? r.red_zone_carries : null, targets: r.targets, rz_targets: r.red_zone_targets };
}
