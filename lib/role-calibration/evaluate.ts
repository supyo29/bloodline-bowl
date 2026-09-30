/**
 * Deterministic evaluation of the role layer: (1) how well was ROLE forecast, (2) how role error relates to fantasy projection
 * error, (3) baseline vs SHADOW candidate incl. tail misses and segments. Continuous, hand-verifiable, no thresholds chosen post hoc
 * (the 5/8/10-point tail cut-offs and the neutral epsilon are fixed by the phase spec / NEUTRAL_EPS).
 */
import { shadowCandidate } from "./shadow";
import { NEUTRAL_EPS } from "./types";
import type { RoleAnalysisRow } from "./analysis";

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const mean = (xs: number[]): number | null => (xs.length ? r4(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i]! - mx, dy = ys[i]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? r4(sxy / Math.sqrt(sxx * syy)) : null;
}

/** One row per (season, week, player, scoring fingerprint), Sleeper-provided only: the same football outcome under the same scoring is never counted twice (Devoted == Sporty's), and Yahoo (approximate) is not a fitting/pooling cohort. */
export function dedupeFootball(rows: readonly RoleAnalysisRow[], opts: { includeYahoo?: boolean } = {}): RoleAnalysisRow[] {
  const seen = new Map<string, RoleAnalysisRow>();
  for (const r of [...rows].sort((a, b) => (a.league_slug < b.league_slug ? -1 : 1))) {
    if (!opts.includeYahoo && r.provider !== "sleeper") continue;
    const k = `${r.season}|${r.week}|${r.gsis_id ?? r.canonical_player_id}|${r.scoring_fingerprint}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

export interface ErrStats { n: number; mae: number | null; rmse: number | null; bias: number | null }
export function errStats(errs: number[]): ErrStats {
  const n = errs.length;
  return { n, mae: n ? r4(errs.reduce((s, e) => s + Math.abs(e), 0) / n) : null, rmse: n ? r4(Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / n)) : null, bias: n ? r4(errs.reduce((s, e) => s + e, 0) / n) : null };
}

export interface CompareStats {
  n: number; baseline: ErrStats; candidate: ErrStats;
  mean_abs_error_improvement: number | null; pct_helped: number | null; pct_hurt: number | null; pct_neutral: number | null;
}
type CandidateKind = "role" | "teammate_only";
const candOf = (r: RoleAnalysisRow, kind: CandidateKind): number | null => (r.shadow ? (kind === "role" ? r.shadow.candidate_projection : r.shadow.teammate_only_candidate) : null);
export function compare(rows: readonly RoleAnalysisRow[], kind: CandidateKind = "role", candidateOverride?: (r: RoleAnalysisRow) => number | null): CompareStats {
  const be: number[] = [], ce: number[] = []; let helped = 0, hurt = 0, neutral = 0;
  for (const r of rows) {
    const cand = candidateOverride ? candidateOverride(r) : candOf(r, kind);
    if (r.actual_fantasy_points == null || r.baseline_projection == null || cand == null) continue;
    const b = r.actual_fantasy_points - r.baseline_projection, c = r.actual_fantasy_points - cand;
    be.push(b); ce.push(c);
    const d = Math.abs(b) - Math.abs(c);
    if (d > NEUTRAL_EPS) helped++; else if (d < -NEUTRAL_EPS) hurt++; else neutral++;
  }
  const n = be.length;
  return { n, baseline: errStats(be), candidate: errStats(ce), mean_abs_error_improvement: n ? r4(be.reduce((s, e) => s + Math.abs(e), 0) / n - ce.reduce((s, e) => s + Math.abs(e), 0) / n) : null,
    pct_helped: n ? r4(helped / n) : null, pct_hurt: n ? r4(hurt / n) : null, pct_neutral: n ? r4(neutral / n) : null };
}

export function bucketMagnitude(base: number | null): string { return base == null ? "UNKNOWN" : base < 5 ? "<5" : base < 10 ? "5-10" : base < 15 ? "10-15" : ">=15"; }
export function bucketVolatility(v: number | null): string { return v == null ? "UNKNOWN" : v < 0.03 ? "LOW(<0.03)" : v < 0.08 ? "MEDIUM(0.03-0.08)" : "HIGH(>=0.08)"; }

export function segment(rows: readonly RoleAnalysisRow[], keyOf: (r: RoleAnalysisRow) => string, kind: CandidateKind = "role"): Record<string, CompareStats> {
  const groups = new Map<string, RoleAnalysisRow[]>();
  for (const r of rows) { const k = keyOf(r); (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, compare(v, kind)]));
}

export interface TailStats { threshold: number; n_baseline_misses: number; baseline_mae: number | null; candidate_mae_on_same: number | null; pct_reduced: number | null; mean_reduction_points: number | null; pct_still_at_or_above: number | null; new_tail_misses_created: number }
export function tail(rows: readonly RoleAnalysisRow[], threshold: number, kind: CandidateKind = "role"): TailStats {
  const misses: Array<{ b: number; c: number }> = []; let created = 0;
  for (const r of rows) {
    const cand = candOf(r, kind);
    if (r.actual_fantasy_points == null || r.baseline_projection == null || cand == null) continue;
    const b = Math.abs(r.actual_fantasy_points - r.baseline_projection), c = Math.abs(r.actual_fantasy_points - cand);
    if (b >= threshold) misses.push({ b, c }); else if (c >= threshold) created++;
  }
  const n = misses.length;
  return { threshold, n_baseline_misses: n, baseline_mae: n ? r4(misses.reduce((s, m) => s + m.b, 0) / n) : null, candidate_mae_on_same: n ? r4(misses.reduce((s, m) => s + m.c, 0) / n) : null,
    pct_reduced: n ? r4(misses.filter((m) => m.c < m.b - NEUTRAL_EPS).length / n) : null, mean_reduction_points: n ? r4(misses.reduce((s, m) => s + (m.b - m.c), 0) / n) : null, pct_still_at_or_above: n ? r4(misses.filter((m) => m.c >= threshold).length / n) : null, new_tail_misses_created: created };
}

/** Diagnostic ONLY (never used to choose KAPPA): effect of the blend weight on the same rows. */
export function kappaSensitivity(rows: readonly RoleAnalysisRow[], grid: readonly number[] = [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1]): Array<{ kappa: number; mae: number | null; rmse: number | null }> {
  return grid.map((k) => {
    const errs: number[] = [];
    for (const r of rows) {
      if (r.actual_fantasy_points == null || r.baseline_projection == null || !r.shadow || r.forecast_confidence == null) continue;
      const c = shadowCandidate({ baseline: r.baseline_projection, xfp_forecast: r.shadow.contributions.xfp_forecast, xfp_no_pressure: r.xfp.forecast_no_pressure ?? r.shadow.contributions.xfp_forecast, p_absent: 1 - (r.shadow.contributions.xfp_forecast === 0 ? 1 : r.shadow.contributions.xfp_effective / r.shadow.contributions.xfp_forecast), confidence: r.forecast_confidence as "MEDIUM" | "LOW" | "INSUFFICIENT_SAMPLE", kappa: k });
      errs.push(r.actual_fantasy_points - c.candidate_projection);
    }
    const s = errStats(errs); return { kappa: k, mae: s.mae, rmse: s.rmse };
  });
}

export interface RoleAccuracyRow { position: string; metric: string; n: number; forecast_mae: number | null; forecast_bias: number | null; naive_last_game_mae: number | null; naive_season_mean_mae: number | null; forecast_beats_last_game: boolean | null }
export function roleAccuracy(rows: readonly RoleAnalysisRow[]): RoleAccuracyRow[] {
  const acc = new Map<string, { pos: string; m: string; f: number[]; fb: number[]; last: number[]; sm: number[] }>();
  for (const r of rows) {
    if (!r.eval_populations.role_accuracy) continue;
    for (const [m, c] of Object.entries(r.role)) {
      if (!c || c.forecast == null || c.actual == null) continue;
      const k = `${r.position}|${m}`; const a = acc.get(k) ?? acc.set(k, { pos: r.position, m, f: [], fb: [], last: [], sm: [] }).get(k)!;
      a.f.push(Math.abs(c.actual - c.forecast)); a.fb.push(c.actual - c.forecast);
      if (c.naive_last_game != null) a.last.push(Math.abs(c.actual - c.naive_last_game));
      if (c.naive_season_mean != null) a.sm.push(Math.abs(c.actual - c.naive_season_mean));
    }
  }
  return [...acc.values()].sort((a, b) => (a.pos + a.m < b.pos + b.m ? -1 : 1)).map((a) => {
    const fm = mean(a.f), lm = mean(a.last);
    return { position: a.pos, metric: a.m, n: a.f.length, forecast_mae: fm, forecast_bias: mean(a.fb), naive_last_game_mae: lm, naive_season_mean_mae: mean(a.sm), forecast_beats_last_game: fm != null && lm != null ? fm < lm : null };
  });
}

export interface RoleVsFantasy { position: string; n: number; corr_role_error_vs_total_error: number | null; corr_efficiency_vs_total_error: number | null; share_sq_error_role: number | null; share_sq_error_efficiency: number | null; share_sq_error_baseline_gap: number | null; mean_abs: { total: number | null; role: number | null; efficiency: number | null; baseline_gap: number | null } }
/** How much of the fantasy projection error is ROLE (opportunity) vs efficiency/TD vs baseline-disagreement. Squared-error shares are of the sum of each component's squares (components are correlated, so shares are descriptive, not additive). */
export function roleVsFantasy(rows: readonly RoleAnalysisRow[], position?: string): RoleVsFantasy {
  const d = rows.filter((r) => r.eval_populations.role_accuracy && r.decomposition && (!position || r.position === position)).map((r) => r.decomposition!);
  const tot = d.map((x) => x.total_error!), role = d.map((x) => x.role_error_points!), eff = d.map((x) => x.efficiency_td_residual!), gap = d.map((x) => x.baseline_vs_role_gap!);
  const ss = (xs: number[]) => xs.reduce((s, x) => s + x * x, 0), sum = ss(role) + ss(eff) + ss(gap);
  return { position: position ?? "ALL", n: d.length, corr_role_error_vs_total_error: pearson(role, tot), corr_efficiency_vs_total_error: pearson(eff, tot),
    share_sq_error_role: sum ? r4(ss(role) / sum) : null, share_sq_error_efficiency: sum ? r4(ss(eff) / sum) : null, share_sq_error_baseline_gap: sum ? r4(ss(gap) / sum) : null,
    mean_abs: { total: mean(tot.map(Math.abs)), role: mean(role.map(Math.abs)), efficiency: mean(eff.map(Math.abs)), baseline_gap: mean(gap.map(Math.abs)) } };
}

/** Large-miss attribution: for cases with |actual-baseline| >= threshold, how often is |role error| the dominant component? */
export function tailAttribution(rows: readonly RoleAnalysisRow[], threshold: number): { threshold: number; n: number; role_dominant: number | null; efficiency_dominant: number | null; baseline_gap_dominant: number | null } {
  const big = rows.filter((r) => r.eval_populations.role_accuracy && r.decomposition && Math.abs(r.decomposition.total_error!) >= threshold).map((r) => r.decomposition!);
  const dom = (k: "role" | "eff" | "gap") => big.filter((x) => { const a = { role: Math.abs(x.role_error_points!), eff: Math.abs(x.efficiency_td_residual!), gap: Math.abs(x.baseline_vs_role_gap!) }; return a[k] === Math.max(a.role, a.eff, a.gap); }).length;
  const n = big.length;
  return { threshold, n, role_dominant: n ? r4(dom("role") / n) : null, efficiency_dominant: n ? r4(dom("eff") / n) : null, baseline_gap_dominant: n ? r4(dom("gap") / n) : null };
}

/** Coverage of pre-game role evidence over a case population (eligible RB/WR/TE by default). */
export function coverage(rows: readonly RoleAnalysisRow[], positions: readonly string[] = ["RB", "WR", "TE"]): Record<string, { cases: number; with_forecast: number; pct_with_forecast: number | null; metrics: Record<string, { with_value: number; pct: number | null; prior_season_only_pct: number | null }> }> {
  const out: ReturnType<typeof coverage> = {};
  for (const pos of [...positions, "ALL"]) {
    const sub = rows.filter((r) => (pos === "ALL" ? positions.includes(r.position) : r.position === pos));
    const withF = sub.filter((r) => r.forecast_id != null && r.forecast_confidence !== "INSUFFICIENT_SAMPLE");
    const metrics: Record<string, { with_value: number; pct: number | null; prior_season_only_pct: number | null }> = {};
    for (const m of ["snap_share", "route_participation", "target_share", "rush_share"]) {
      const applicable = sub.filter((r) => r.role[m as keyof RoleAnalysisRow["role"]] !== undefined);
      const has = applicable.filter((r) => r.role[m as keyof RoleAnalysisRow["role"]]!.forecast != null);
      metrics[m] = { with_value: has.length, pct: applicable.length ? r4(has.length / applicable.length) : null, prior_season_only_pct: has.length ? r4(has.filter((r) => (r.confidence_score ?? 1) === 0 || false).length / has.length) : null };
    }
    out[pos] = { cases: sub.length, with_forecast: withF.length, pct_with_forecast: sub.length ? r4(withF.length / sub.length) : null, metrics };
  }
  return out;
}
