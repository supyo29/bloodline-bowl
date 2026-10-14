/**
 * W2.R1 S6 empirical breakout / upside primitives (SHADOW; DIAGNOSTIC). Pure functions mirrored from the research harness (scripts/w2r1/s6_*.R) and golden-linked to its recorded results.
 * Rules: base-rate-first, per-position labels (never pooled), time-ordered splits only, calibration measured not assumed, probabilities displayed ONLY for a position whose gates pass.
 */
import { confidenceWeight } from "./gameplan";

export type Pos = "QB" | "RB" | "WR" | "TE" | "K" | "DST";
/** preregistered PRIMARY labels: weekly top-N finish among the position's players (TE/K/DST: top-6). */
export const PRIMARY_TOP_N: Record<Pos, number> = { QB: 12, RB: 12, WR: 12, TE: 6, K: 6, DST: 6 };
export const ALERT_ELEVATED = 1.5;
export const ALERT_HIGH = 2.0;
export type Tier = "STARTER" | "FLEX" | "FRINGE";
export const tierOf = (b0: number): Tier => (b0 >= 12 ? "STARTER" : b0 >= 6 ? "FLEX" : "FRINGE");

/** label = actual >= the N-th best score that week (ties included); a player who did not play can never be a positive. */
export function topNCut(scores: readonly number[], n: number): number {
  const s = [...scores].sort((a, b) => b - a);
  return s[Math.min(n, s.length) - 1] ?? Number.POSITIVE_INFINITY;
}
export const isBreakout = (pos: Pos, actual: number, played: boolean, weeklyScores: readonly number[]): boolean => played && actual >= topNCut(weeklyScores, PRIMARY_TOP_N[pos]);

/** time-ordered split: every FIT target strictly precedes every VAL target. Random splits are forbidden. */
export function assertTimeSplit(fit: ReadonlyArray<{ season: number; week: number }>, val: ReadonlyArray<{ season: number; week: number }>): void {
  const key = (g: { season: number; week: number }) => g.season * 100 + g.week;
  const maxFit = Math.max(...fit.map(key)), minVal = Math.min(...val.map(key));
  if (!(maxFit < minVal)) throw new Error(`time split violated: FIT max ${maxFit} >= VAL min ${minVal}`);
}

/** Laplace-smoothed tier base rate. */
export const tierRate = (events: number, n: number): number => (events + 1) / (n + 2);

/**
 * The probability that may be SHOWN for a row: the model probability shrunk toward the tier base rate by the small-sample weight (>= 4 prior played games: 1; 2-3: 0.6; < 2: 0).
 * Unknown model output or missing history lowers confidence toward the BASE RATE — never to 0 and never to an extreme.
 */
export function shownProbability(pModel: number | null, baseRate: number, priorGames: number): number {
  if (pModel == null || !Number.isFinite(pModel)) return baseRate;
  const w = confidenceWeight(priorGames, priorGames);
  return Math.min(0.999, Math.max(0.001, w * pModel + (1 - w) * baseRate));
}

export function brier(p: readonly number[], y: readonly number[]): number { return p.reduce((s, v, i) => s + (v - y[i]!) ** 2, 0) / p.length; }
export function logLoss(p: readonly number[], y: readonly number[]): number {
  return -p.reduce((s, v, i) => { const q = Math.min(1 - 1e-4, Math.max(1e-4, v)); return s + y[i]! * Math.log(q) + (1 - y[i]!) * Math.log(1 - q); }, 0) / p.length;
}
/** relative Brier skill versus the base-rate model (positive = better). */
export const brierSkill = (b: number, bBase: number): number => 1 - b / bBase;

export interface GateInput { events: number; skillVsBase: number; skillLo95: number; logLossGain: number; slope: number | null; ece: number; topDecileLift: number | null; topDecileEvents: number; lateSkill: number; lateLogLossGain: number }
export type BreakoutVerdict = "VALIDATION CANDIDATE" | "DIAGNOSTIC ONLY" | "NO RELIABLE BREAKOUT SIGNAL" | "INSUFFICIENT SAMPLE";
/** preregistered gates B1-B5 (+ VAL-LATE repeat). Thresholds are CONSTANTS here: changing them after validation is forbidden (mutant-tested). */
export function breakoutVerdict(g: GateInput | null): BreakoutVerdict {
  if (!g) return "NO RELIABLE BREAKOUT SIGNAL";
  if (g.events < 40) return "INSUFFICIENT SAMPLE";
  const b2 = g.skillVsBase >= 0.02 && g.skillLo95 > 0;
  const b3 = g.logLossGain > 0;
  if (!b2 || !b3) return "NO RELIABLE BREAKOUT SIGNAL";
  const b4 = g.slope != null && g.slope >= 0.8 && g.slope <= 1.2 && g.ece <= 0.03;
  const b5 = g.topDecileLift != null && g.topDecileLift >= 1.3 && g.topDecileEvents >= 10;
  const late = g.lateSkill >= 0.02 && g.lateLogLossGain > 0;
  return b4 && b5 && late ? "VALIDATION CANDIDATE" : "DIAGNOSTIC ONLY";
}

export type Band = "Low" | "Typical" | "Elevated" | "High";
export function alertLevel(p: number, positionBaseRate: number): "HIGH" | "ELEVATED" | "NONE" {
  return p >= ALERT_HIGH * positionBaseRate ? "HIGH" : p >= ALERT_ELEVATED * positionBaseRate ? "ELEVATED" : "NONE";
}
export const bandOf = (p: number, base: number): Band => (p >= ALERT_HIGH * base ? "High" : p >= ALERT_ELEVATED * base ? "Elevated" : p < 0.5 * base ? "Low" : "Typical");

/** What the product may SHOW. A raw / uncalibrated classifier score is NEVER displayed as a probability: unless the position's verdict is VALIDATION CANDIDATE the answer is the verdict itself. */
export function displayBreakout(verdict: BreakoutVerdict, shownP: number, positionBaseRate: number, comparable: { n: number; events: number } | null): { text: string; band: Band | null; percent: number | null } {
  if (verdict !== "VALIDATION CANDIDATE") return { text: verdict === "INSUFFICIENT SAMPLE" ? "INSUFFICIENT SAMPLE" : "NO RELIABLE BREAKOUT SIGNAL", band: null, percent: null };
  const pct = Math.round(shownP * 100); const baseP = Math.round(positionBaseRate * 100);
  const comp = comparable ? ` Comparable situations: ${comparable.n}; breakouts: ${comparable.events}; empirical rate: ${Math.round((100 * comparable.events) / Math.max(1, comparable.n))}%.` : "";
  return { text: `Upside likelihood: ${bandOf(shownP, positionBaseRate)} (about ${pct}% vs position base rate ${baseP}%).${comp}`, band: bandOf(shownP, positionBaseRate), percent: pct };
}

/** negative examples are part of every cohort statistic (survivor-bias guard). */
export function cohortStats(rows: ReadonlyArray<{ label: 0 | 1; tierExpected: number }>, positionBaseRate: number): { n: number; positives: number; negatives: number; rate: number; baseRate: number; liftOverBase: number; liftOverTierExpected: number } {
  const n = rows.length, positives = rows.reduce((s, r) => s + r.label, 0);
  const rate = n ? positives / n : 0; const exp = n ? rows.reduce((s, r) => s + r.tierExpected, 0) / n : 0;
  return { n, positives, negatives: n - positives, rate, baseRate: positionBaseRate, liftOverBase: positionBaseRate > 0 ? rate / positionBaseRate : 0, liftOverTierExpected: exp > 0 ? rate / exp : 0 };
}
