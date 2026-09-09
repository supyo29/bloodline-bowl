/**
 * Competitive Trade Intelligence — current-season evidence families
 * (Checkpoint B.5). Pure.
 *
 * Separates 2026 in-season observations into FOUR families (§13) and weights
 * them by within-season recency (§11). Crucially, market perception and private
 * forward value consume these families with DIFFERENT weights (§14) — market
 * reacts to RESULT, our model reacts to ROLE — so this module only produces the
 * per-family signals; the two consumers (`market-state.ts`, `private-forward.ts`)
 * apply their own weights.
 *
 * Opponent adjustment (§15–§19): each game's result is compared to a
 * matchup-adjusted expectation. Repeatedly beating tough defenses raises
 * BREAKOUT CREDIBILITY (confidence), not raw points (§18).
 */

import { recencyWeightedMean } from "./temporal";
import type { CurveParams } from "./calibration";
import type {
  BreakoutCredibility,
  EvidenceSignal,
  OpponentAdjustedResidual,
} from "./schema";

/** One observed game of in-season data. All fields optional / nullable — missing ≠ 0. */
export interface GameObservation {
  week: number;
  /** true when the player was actually in a meaningful role this game (drives games_observed) */
  meaningful: boolean;
  // ---- ROLE / opportunity ----
  snap_share?: number | null;
  target_share?: number | null;
  rush_share?: number | null;
  goal_line_share?: number | null;
  // ---- RESULT ----
  fantasy_points?: number | null;
  // ---- EFFICIENCY ----
  yards_per_route?: number | null;
  yards_per_carry?: number | null;
  success_rate?: number | null;
  // ---- CONTEXT ----
  /** −1 (hard) .. +1 (easy) — from the schedule-strength table */
  opponent_matchup_score?: number | null;
  /** the pre-game expectation for this player (e.g. their weekly projection) */
  baseline_expected_points?: number | null;
}

export interface CurrentSeasonEvidence {
  games_observed: number;
  /** recency-weighted, position-relative where possible. null ⇒ family unavailable */
  role_signal: number | null;
  efficiency_signal: number | null;
  result_signal: number | null;
  context_signal: number | null;
  opponent_adjusted: OpponentAdjustedResidual;
  breakout_credibility: BreakoutCredibility;
  /** avg opponent difficulty faced so far (−1 hard .. +1 easy) */
  opponent_difficulty_index: number | null;
  /** true when the schedule to date was unusually easy (inflation risk) */
  weak_schedule_inflation: boolean;
  /** RESULT is high but ROLE is thin — TD-driven, not opportunity-driven */
  touchdown_mirage_risk: boolean;
  signals: EvidenceSignal[];
  reasons: string[];
}

const TOUGH_MATCHUP = -0.2; // matchup_score below this = a tough defense
const EASY_MATCHUP = 0.2;
const OPP_ADJ_K = 0.6; // matchup_score of +1 shifts expectation by +60%

export interface BuildEvidenceInput {
  observations: GameObservation[];
  position: string;
  as_of_week: number;
  /** recency curve for each family (from calibration) */
  recency: { ROLE: CurveParams; EFFICIENCY: CurveParams; RESULT: CurveParams; CONTEXT: CurveParams };
  /** position-relative role baseline (share a startable player at this position typically holds) */
  role_baseline?: number;
}

/**
 * Metric-appropriate "startable player" baselines and spreads for the ROLE
 * z-ish normalization. A WR1 target share is ~0.26; a lead RB rush share ~0.55;
 * snap share for a starter ~0.75. Conflating these scales (an earlier bug)
 * made a real WR1 target share look like a thin role.
 */
const ROLE_METRIC_NORM: Record<string, { baseline: number; spread: number }> = {
  target_share: { baseline: 0.18, spread: 0.09 },
  rush_share: { baseline: 0.45, spread: 0.18 },
  snap_share: { baseline: 0.7, spread: 0.18 },
};

export function buildCurrentSeasonEvidence(input: BuildEvidenceInput): CurrentSeasonEvidence {
  const games = input.observations.filter((o) => o.meaningful);
  const reasons: string[] = [];
  const signals: EvidenceSignal[] = [];

  if (games.length === 0) {
    return {
      games_observed: 0,
      role_signal: null,
      efficiency_signal: null,
      result_signal: null,
      context_signal: null,
      opponent_adjusted: emptyResidual(["no meaningful games observed"]),
      breakout_credibility: "NO_BREAKOUT_SIGNAL",
      opponent_difficulty_index: null,
      weak_schedule_inflation: false,
      touchdown_mirage_risk: false,
      signals,
      reasons: ["no meaningful in-season games — current-season evidence unavailable"],
    };
  }

  // ---- ROLE: the position's primary opportunity share, normalized on its OWN scale ----
  const roleMetric =
    input.position === "RB" ? "rush_share" : input.position === "WR" || input.position === "TE" ? "target_share" : "snap_share";
  const roleOf = (o: GameObservation): number | null => {
    if (roleMetric === "rush_share") return firstNum(o.rush_share, o.snap_share);
    if (roleMetric === "target_share") return firstNum(o.target_share, o.snap_share);
    return firstNum(o.snap_share);
  };
  // pick the norm for the metric that actually produced the reading
  const roleMean = recencyWeightedMean(games, roleOf, input.recency.ROLE);
  const usedSnapFallback =
    roleMetric !== "snap_share" && games.every((o) => (roleMetric === "rush_share" ? o.rush_share : o.target_share) == null);
  const norm = ROLE_METRIC_NORM[usedSnapFallback ? "snap_share" : roleMetric]!;
  const roleBaseline = input.role_baseline ?? norm.baseline;
  const roleSignal = roleMean == null ? null : round4((roleMean - roleBaseline) / norm.spread);
  if (roleMean != null) {
    signals.push(sig("ROLE", usedSnapFallback ? "snap_share" : roleMetric, roleSignal, "share", games.length, true, input.as_of_week));
  }

  // ---- EFFICIENCY ----
  const effOf = (o: GameObservation): number | null =>
    input.position === "RB" ? firstNum(o.yards_per_carry, o.success_rate) : firstNum(o.yards_per_route, o.success_rate);
  const effMeanRaw = recencyWeightedMean(games, effOf, input.recency.EFFICIENCY);
  const effSignal = effMeanRaw == null ? null : round4(effMeanRaw);
  if (effMeanRaw != null) signals.push(sig("EFFICIENCY", "yards_per_opportunity", effSignal, "yds", games.length, true, input.as_of_week));

  // ---- RESULT ----
  const resMean = recencyWeightedMean(games, (o) => firstNum(o.fantasy_points), input.recency.RESULT);
  const resSignal = resMean == null ? null : round4(resMean);
  if (resMean != null) signals.push(sig("RESULT", "fantasy_points", resSignal, "pts", games.length, true, input.as_of_week));

  // ---- CONTEXT: schedule difficulty faced ----
  const matchups = games.map((o) => o.opponent_matchup_score).filter((x): x is number => x != null && Number.isFinite(x));
  const oppDifficulty = matchups.length > 0 ? round4(mean(matchups)) : null;
  const contextSignal = oppDifficulty; // positive = faced easy schedule
  if (oppDifficulty != null) {
    signals.push(sig("CONTEXT", "schedule_strength_to_date", oppDifficulty, "idx", matchups.length, false, input.as_of_week));
  }
  const weakScheduleInflation = oppDifficulty != null && oppDifficulty >= EASY_MATCHUP;
  if (weakScheduleInflation) reasons.push(`schedule to date has been easy (opponent difficulty index ${oppDifficulty}) — realized production is inflated`);

  // ---- opponent-adjusted residuals ----
  const opp = buildOpponentAdjusted(games, input.recency.RESULT);

  // ---- touchdown-mirage: high RESULT, thin ROLE ----
  const touchdownMirage =
    resSignal != null && roleSignal != null && resSignal >= 15 && roleSignal <= -0.4;
  if (touchdownMirage) reasons.push("fantasy production is high but opportunity share is thin — likely touchdown-driven, not role-driven");

  // ---- breakout credibility ----
  const breakout = classifyBreakout({
    roleSignal,
    games: games.length,
    outperformedTough: opp.outperformed_tough_count,
    toughGames: opp.games_vs_tough_defenses,
    weakScheduleInflation,
    touchdownMirage,
  });

  return {
    games_observed: games.length,
    role_signal: roleSignal,
    efficiency_signal: effSignal,
    result_signal: resSignal,
    context_signal: contextSignal,
    opponent_adjusted: opp,
    breakout_credibility: breakout,
    opponent_difficulty_index: oppDifficulty,
    weak_schedule_inflation: weakScheduleInflation,
    touchdown_mirage_risk: touchdownMirage,
    signals,
    reasons,
  };
}

function buildOpponentAdjusted(games: GameObservation[], resultRecency: CurveParams): OpponentAdjustedResidual {
  const notes: string[] = [];
  let toughGames = 0;
  let outperformedTough = 0;
  const baseResiduals: Array<{ v: number }> = [];
  const oppResiduals: Array<{ v: number }> = [];
  const oppDiff: number[] = [];

  for (const o of games) {
    const actual = o.fantasy_points;
    const base = o.baseline_expected_points;
    const m = o.opponent_matchup_score;
    if (m != null) oppDiff.push(m);
    if (actual == null || base == null) continue;
    const oppExpected = m != null ? base * (1 + OPP_ADJ_K * m) : base;
    baseResiduals.push({ v: actual - base });
    oppResiduals.push({ v: actual - oppExpected });
    if (m != null && m <= TOUGH_MATCHUP) {
      toughGames += 1;
      if (actual > oppExpected) outperformedTough += 1;
    }
  }

  if (toughGames > 0) {
    notes.push(`${outperformedTough}/${toughGames} game(s) vs a tough defense beat the matchup-adjusted expectation`);
  }

  return {
    baseline_expected: null,
    opponent_adjusted_expected: null,
    actual: null,
    residual_vs_baseline: recencyWeightedMean(baseResiduals, (r) => r.v, resultRecency),
    residual_vs_opponent_expectation: recencyWeightedMean(oppResiduals, (r) => r.v, resultRecency),
    opponent_difficulty_index: oppDiff.length > 0 ? round4(mean(oppDiff)) : null,
    games_vs_tough_defenses: toughGames,
    outperformed_tough_count: outperformedTough,
    notes,
  };
}

function classifyBreakout(x: {
  roleSignal: number | null;
  games: number;
  outperformedTough: number;
  toughGames: number;
  weakScheduleInflation: boolean;
  touchdownMirage: boolean;
}): BreakoutCredibility {
  if (x.roleSignal == null || x.roleSignal <= 0.15) return "NO_BREAKOUT_SIGNAL";
  if (x.touchdownMirage) return "EARLY_SIGNAL"; // production without opportunity — do not over-credit
  let score = 0;
  if (x.roleSignal >= 0.4) score += 1;
  if (x.roleSignal >= 0.9) score += 1;
  if (x.games >= 3) score += 1;
  if (x.games >= 5) score += 1;
  if (x.toughGames >= 1 && x.outperformedTough >= 1) score += 1;
  if (x.toughGames >= 2 && x.outperformedTough >= 2) score += 1;
  if (x.weakScheduleInflation) score -= 1;
  if (score <= 1) return "EARLY_SIGNAL";
  if (score === 2) return "EMERGING";
  if (score <= 4) return "SUPPORTED";
  return "HIGH_CONFIDENCE";
}

function emptyResidual(notes: string[]): OpponentAdjustedResidual {
  return {
    baseline_expected: null,
    opponent_adjusted_expected: null,
    actual: null,
    residual_vs_baseline: null,
    residual_vs_opponent_expectation: null,
    opponent_difficulty_index: null,
    games_vs_tough_defenses: 0,
    outperformed_tough_count: 0,
    notes,
  };
}

function sig(
  family: EvidenceSignal["family"],
  metric: string,
  value: number | null,
  unit: string | null,
  games: number,
  recencyWeighted: boolean,
  week: number,
): EvidenceSignal {
  return { family, metric, value, unit, games_contributing: games, recency_weighted: recencyWeighted, source: "current_season_observations", as_of_week: week, notes: [] };
}

function firstNum(...xs: Array<number | null | undefined>): number | null {
  for (const x of xs) if (x != null && Number.isFinite(x)) return x;
  return null;
}
function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}
function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
