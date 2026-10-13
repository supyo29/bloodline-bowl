/**
 * W2.P2 — league-scoring compatibility with the frozen fit.
 *
 * The frozen coefficients were fitted on ONE scoring (HALF: 0.5 PPR, 4pt pass TD, -2 INT/fumble lost, 2pt = 2; `scripts/w2p1/prereg.json`).
 * The challenger spec states "other scorings require their own frozen fit". A league whose modeled scoring rules differ is therefore NOT
 * eligible: the frozen HALF delta is never silently applied to, say, a PPR league (that would be an unvalidated league-scoring transformation).
 *
 * RECONSTRUCTED RULE R-S1 (not previously frozen): a league is compatible iff every MODELED rule below equals the template. Rules the fit never
 * saw (bonuses, sack/pick-six penalties, fumble-recovery points, ...) are NOT silently ignored: they are listed on the record
 * (`unmodeled_offense_keys`) so the evaluation can be stratified by them, and the report states that they are a known approximation.
 */

export const MODELED_SCORING_KEYS = ["pass_yd", "pass_td", "pass_int", "rush_yd", "rush_td", "rec", "rec_yd", "rec_td", "fum_lost", "pass_2pt", "rush_2pt", "rec_2pt"] as const;

/** HALF template, exactly the points function the harness scored with (scripts/lib/role-qualification.ts `pointsOf`, scoring HALF). */
export const FROZEN_SCORING_RULES: Readonly<Record<(typeof MODELED_SCORING_KEYS)[number], number>> = {
  pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6, rec: 0.5, rec_yd: 0.1, rec_td: 6, fum_lost: -2, pass_2pt: 2, rush_2pt: 2, rec_2pt: 2,
};

/** Keys that score kickers, team defense / special teams, or IDP — irrelevant to a QB/RB/WR/TE offensive forecast. */
const NON_OFFENSE = /^(def_|st_|fg|xp|pts_allow|yds_allow|blk_kick|safe|tkl|qb_hit|ff$|sack$|int$|int_ret|sack_yd$|def)/;

export type ScoringCompatibility = "TEMPLATE_HALF_ON_MODELED_KEYS" | "NO_FROZEN_FIT" | "SCORING_UNAVAILABLE";

export interface ScoringAssessment {
  compatibility: ScoringCompatibility;
  /** modeled rules that differ from the template: `[key, league value, template value]` */
  deviations: Array<[string, number, number]>;
  /** non-zero offensive rules the fit never modeled (provenance for stratification) */
  unmodeled_offense_keys: string[];
}

const eq = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

export function assessScoring(raw: Record<string, number> | null | undefined): ScoringAssessment {
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) return { compatibility: "SCORING_UNAVAILABLE", deviations: [], unmodeled_offense_keys: [] };
  const deviations: ScoringAssessment["deviations"] = [];
  for (const k of MODELED_SCORING_KEYS) {
    const v = typeof raw[k] === "number" && Number.isFinite(raw[k]) ? (raw[k] as number) : 0;
    if (!eq(v, FROZEN_SCORING_RULES[k])) deviations.push([k, v, FROZEN_SCORING_RULES[k]]);
  }
  const modeled = new Set<string>(MODELED_SCORING_KEYS);
  const unmodeled = Object.entries(raw)
    .filter(([k, v]) => typeof v === "number" && Number.isFinite(v) && v !== 0 && !modeled.has(k) && !NON_OFFENSE.test(k))
    .map(([k]) => k)
    .sort();
  return { compatibility: deviations.length === 0 ? "TEMPLATE_HALF_ON_MODELED_KEYS" : "NO_FROZEN_FIT", deviations, unmodeled_offense_keys: unmodeled };
}
