/**
 * W1.P2 injury-model calibration + evaluation, reproducible from committed point-in-time data. NOT production code
 * (production must not import lib/role-calibration; this lives under scripts/ for that reason).
 *
 * Evidence (all public, all knowable before kickoff):
 *   - lib/role-calibration/data/injury_reports.csv   nflverse FINAL team-week designation + practice participation (no timestamp
 *     is published, so the final pre-game designation is used: the same documented assumption as Role Calibration Phase 2)
 *   - lib/role-calibration/data/observed_role_game.csv   outcome: offensive snaps (played = snaps > 0)
 *   - lib/game-distribution/data/historical_player_game_stats_2025.csv   2025 stat lines -> fantasy points (proxy scoring below)
 *
 * What this CANNOT measure (stated, not hidden): there is no stored history of the actual Sleeper/RotoWire weekly SOURCE
 * projection, so "source projection MAE" is measured against a proxy source = the player's mean fantasy points over his previous
 * (up to 4) games, strictly earlier. That proxy is conditional-on-active by construction, so it is evaluated with λ=0
 * (CONDITIONAL_ON_ACTIVE). It tests the injury arithmetic; it cannot reveal how much injury risk Sleeper already embeds.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv, num } from "../../lib/role-calibration/csv";
import { evaluateInjuryModel, normalizeInjuryStatus, type InjuryEvidence } from "../../lib/weekly/forecast/injury-model";
import {
  INJURY_PRIOR_VERSION,
  RELEVANT_SOURCE_POINTS,
  type Counts,
  type InjuryPriorCounts,
  type Practice,
  type RoleTier,
} from "../../lib/weekly/forecast/injury-priors";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

export type Designation = "QUESTIONABLE" | "DOUBTFUL" | "OUT" | "NONE";

export interface Case {
  season: number;
  week: number;
  gsis: string;
  position: string;
  designation: Designation;
  raw_status: string | null;
  practice: Practice | null;
  played: boolean;
  /** snap share this game / mean of up to 4 strictly-earlier games (null if no history) */
  prior_snap: number | null;
  snap_ratio: number | null;
  /** proxy source projection (2025 only) */
  baseline: number | null;
  actual_points: number | null;
}

/** League-style proxy scoring used ONLY to turn 2025 stat lines into comparable fantasy points. */
export function proxyPoints(r: Record<string, string>): number {
  const g = (k: string) => num(r[k]) ?? 0;
  return (
    g("passing_yards") * 0.04 + g("passing_tds") * 4 - 2 * g("passing_interceptions") +
    g("rushing_yards") * 0.1 + g("rushing_tds") * 6 +
    g("receptions") * 0.5 + g("receiving_yards") * 0.1 + g("receiving_tds") * 6 -
    2 * (g("rushing_fumbles_lost") + g("receiving_fumbles_lost") + g("sack_fumbles_lost")) +
    2 * (g("passing_2pt_conversions") + g("rushing_2pt_conversions") + g("receiving_2pt_conversions"))
  );
}

const practiceOf = (s: string): Practice | null =>
  s.startsWith("Full") ? "FULL" : s.startsWith("Limited") ? "LIMITED" : s.startsWith("Did Not") ? "DNP" : null;

export interface Dataset {
  cases: Case[];
  /** league-wide pool for comparable-player pairing (2025): players with a baseline and NO injury row that week */
  healthyPool: Array<{ week: number; gsis: string; position: string; baseline: number; actual: number }>;
}

export function loadDataset(): Dataset {
  const inj = parseCsv(read("lib/role-calibration/data/injury_reports.csv"));
  const obs = parseCsv(read("lib/role-calibration/data/observed_role_game.csv"));
  const stats = parseCsv(read("lib/game-distribution/data/historical_player_game_stats_2025.csv"));

  const snaps = new Map<string, { snaps: number; share: number }>();
  const hist = new Map<string, Array<{ week: number; share: number; snaps: number }>>();
  for (const o of obs) {
    const snapN = num(o.offensive_snaps) ?? 0;
    const share = num(o.snap_share_derived) ?? 0;
    snaps.set(`${o.season}|${o.week}|${o.gsis_id}`, { snaps: snapN, share });
    const hk = `${o.season}|${o.gsis_id}`;
    if (!hist.has(hk)) hist.set(hk, []);
    hist.get(hk)!.push({ week: Number(o.week), share, snaps: snapN });
  }
  const priorSnap = (season: string, gsis: string, week: number): number | null => {
    const h = (hist.get(`${season}|${gsis}`) ?? []).filter((x) => x.week < week && x.snaps > 0).sort((a, b) => a.week - b.week).slice(-4);
    return h.length ? h.reduce((s, x) => s + x.share, 0) / h.length : null;
  };

  const pts = new Map<string, Array<{ week: number; pts: number }>>();
  const posOf = new Map<string, string>();
  const actual = new Map<string, number>();
  for (const r of stats) {
    const id = r.player_id!;
    const p = proxyPoints(r);
    if (!pts.has(id)) pts.set(id, []);
    pts.get(id)!.push({ week: Number(r.week), pts: p });
    posOf.set(id, r.position ?? "");
    actual.set(`${r.week}|${id}`, p);
  }
  const baselineOf = (gsis: string, week: number): number | null => {
    const h = (pts.get(gsis) ?? []).filter((x) => x.week < week).sort((a, b) => a.week - b.week).slice(-4);
    return h.length ? h.reduce((s, x) => s + x.pts, 0) / h.length : null;
  };

  const injKeys = new Set<string>();
  const cases: Case[] = [];
  for (const x of inj) {
    const week = Number(x.week);
    if (week > 18) continue;
    injKeys.add(`${x.season}|${week}|${x.gsis_id}`);
    const norm = normalizeInjuryStatus(x.report_status ?? "");
    const designation: Designation = norm === "QUESTIONABLE" ? "QUESTIONABLE" : norm === "DOUBTFUL" ? "DOUBTFUL" : norm === "OUT" ? "OUT" : "NONE";
    const o = snaps.get(`${x.season}|${x.week}|${x.gsis_id}`);
    const played = (o?.snaps ?? 0) > 0;
    const ps = priorSnap(x.season!, x.gsis_id!, week);
    const is25 = x.season === "2025";
    cases.push({
      season: Number(x.season),
      week,
      gsis: x.gsis_id!,
      position: x.position ?? "",
      designation,
      raw_status: x.report_status || null,
      practice: practiceOf(x.practice_status ?? ""),
      played,
      prior_snap: ps,
      snap_ratio: played && ps != null && ps > 0.05 && o ? o.share / ps : null,
      baseline: is25 ? baselineOf(x.gsis_id!, week) : null,
      actual_points: is25 ? actual.get(`${week}|${x.gsis_id}`) ?? 0 : null,
    });
  }

  const healthyPool: Dataset["healthyPool"] = [];
  for (const [id, rows] of pts) {
    for (const r of rows) {
      if (injKeys.has(`2025|${r.week}|${id}`)) continue;
      const b = baselineOf(id, r.week);
      if (b == null) continue;
      healthyPool.push({ week: r.week, gsis: id, position: posOf.get(id) ?? "", baseline: b, actual: r.pts });
    }
  }
  return { cases, healthyPool };
}

const zero: Counts = [0, 0];
const add = (c: Counts, played: boolean): Counts => [c[0] + 1, c[1] + (played ? 1 : 0)];

const tierOfBaseline = (b: number | null): RoleTier | null => (b == null ? null : b >= RELEVANT_SOURCE_POINTS ? "RELEVANT" : "FRINGE");

/** Fit evidence counts from a case set (training window). Tier = proxy baseline >= RELEVANT_SOURCE_POINTS. */
export function fitCounts(train: Case[]): InjuryPriorCounts {
  const q = train.filter((c) => c.designation === "QUESTIONABLE");
  let pooled: Counts = zero;
  const tier: Record<RoleTier, Counts> = { RELEVANT: zero, FRINGE: zero };
  const cell: Record<RoleTier, Record<Practice, Counts>> = {
    RELEVANT: { FULL: zero, LIMITED: zero, DNP: zero },
    FRINGE: { FULL: zero, LIMITED: zero, DNP: zero },
  };
  for (const c of q) {
    pooled = add(pooled, c.played);
    const t = tierOfBaseline(c.baseline);
    if (!t) continue;
    tier[t] = add(tier[t], c.played);
    if (c.practice) cell[t][c.practice] = add(cell[t][c.practice], c.played);
  }
  let doubtful: Counts = zero;
  let out: Counts = zero;
  for (const c of train) {
    if (c.designation === "DOUBTFUL") doubtful = add(doubtful, c.played);
    if (c.designation === "OUT") out = add(out, c.played);
  }
  return { version: INJURY_PRIOR_VERSION, questionable: { pooled, tier, cell }, doubtful, out };
}

const LEGACY_HEURISTIC: Record<Designation, number> = { QUESTIONABLE: 0.78, DOUBTFUL: 0.3, OUT: 0.03, NONE: 1 };

export interface Metrics {
  n: number;
  brier_new: number;
  brier_legacy: number;
  brier_climatology: number;
  observed_active_rate: number;
  mean_p_new: number;
  mean_p_legacy: number;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

function evidenceFor(c: Case, tierFromSnap: boolean): InjuryEvidence {
  return {
    source_status: c.raw_status,
    position: c.position,
    source_points: tierFromSnap ? null : c.baseline,
    role_tier: tierFromSnap ? (c.prior_snap == null ? null : c.prior_snap >= 0.5 ? "RELEVANT" : "FRINGE") : undefined,
    practice: c.practice,
    source_semantics: "CONDITIONAL_ON_ACTIVE",
  };
}

export function probabilityMetrics(test: Case[], priors: InjuryPriorCounts, tierFromSnap: boolean): Metrics {
  const rows = test.filter((c) => c.designation !== "NONE");
  const pNew = rows.map((c) => evaluateInjuryModel(evidenceFor(c, tierFromSnap), priors).probability_active ?? 1);
  const pLeg = rows.map((c) => LEGACY_HEURISTIC[c.designation]);
  const y = rows.map((c) => (c.played ? 1 : 0));
  const clim = mean(y);
  const brier = (p: number[]) => mean(p.map((v, i) => (v - y[i]!) ** 2));
  return {
    n: rows.length,
    brier_new: r4(brier(pNew)),
    brier_legacy: r4(brier(pLeg)),
    brier_climatology: r4(mean(y.map((v) => (clim - v) ** 2))),
    observed_active_rate: r4(clim),
    mean_p_new: r4(mean(pNew)),
    mean_p_legacy: r4(mean(pLeg)),
  };
}

export function calibrationBuckets(test: Case[], priors: InjuryPriorCounts, tierFromSnap: boolean) {
  const rows = test.filter((c) => c.designation !== "NONE");
  const edges = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
  return edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1]!;
    const inB = rows.filter((c) => {
      const p = evaluateInjuryModel(evidenceFor(c, tierFromSnap), priors).probability_active ?? 1;
      return p >= lo && p < hi;
    });
    const ps = inB.map((c) => evaluateInjuryModel(evidenceFor(c, tierFromSnap), priors).probability_active ?? 1);
    return { bucket: `${lo.toFixed(1)}-${Math.min(1, hi).toFixed(1)}`, n: inB.length, mean_p: inB.length ? r4(mean(ps)) : null, observed_active: inB.length ? r4(mean(inB.map((c) => (c.played ? 1 : 0)))) : null };
  });
}

export interface PointMetrics {
  n: number;
  mae_source_proxy: number;
  mae_adjusted: number;
  mae_legacy_heuristic: number;
  bias_source_proxy: number;
  bias_adjusted: number;
  bias_legacy_heuristic: number;
}

/** Point accuracy of baseline vs injury-adjusted vs legacy-heuristic-adjusted, vs ACTUAL points (inactive = 0). 2025 only. */
export function pointMetrics(test: Case[], priors: InjuryPriorCounts, designations: Designation[]): PointMetrics {
  const rows = test.filter((c) => designations.includes(c.designation) && c.baseline != null && c.actual_points != null);
  const base = rows.map((c) => c.baseline!);
  const act = rows.map((c) => c.actual_points!);
  const adj = rows.map((c) => evaluateInjuryModel(evidenceFor(c, false), priors).injury_adjusted_expected_points ?? c.baseline!);
  const leg = rows.map((c) => c.baseline! * LEGACY_HEURISTIC[c.designation]);
  const mae = (p: number[]) => mean(p.map((v, i) => Math.abs(v - act[i]!)));
  const bias = (p: number[]) => mean(p.map((v, i) => v - act[i]!));
  return {
    n: rows.length,
    mae_source_proxy: r4(mae(base)), mae_adjusted: r4(mae(adj)), mae_legacy_heuristic: r4(mae(leg)),
    bias_source_proxy: r4(bias(base)), bias_adjusted: r4(bias(adj)), bias_legacy_heuristic: r4(bias(leg)),
  };
}

export interface DecisionMetrics {
  pairs: number;
  unadjusted: { false_bench: number; false_start: number; correct: number; rate_false_bench: number; rate_false_start: number; accuracy: number };
  adjusted: { false_bench: number; false_start: number; correct: number; rate_false_bench: number; rate_false_start: number; accuracy: number };
}

/**
 * Pairwise start/sit proxy. A = injury-designated player; H = deterministic nearest healthy same-position player (|ΔB| <= 2,
 * same week, no injury row). Decision: start the higher expected value. Truth: higher ACTUAL points (ties skipped).
 * false-bench = picked H but A scored more; false-start = picked A but H scored more.
 */
export function decisionMetrics(test: Case[], pool: Dataset["healthyPool"], priors: InjuryPriorCounts): DecisionMetrics {
  const rows = test.filter((c) => (c.designation === "QUESTIONABLE" || c.designation === "DOUBTFUL") && c.baseline != null && c.actual_points != null);
  const tally = () => ({ fb: 0, fs: 0, ok: 0 });
  const un = tally();
  const ad = tally();
  let pairs = 0;
  for (const a of rows) {
    const cands = pool
      .filter((h) => h.week === a.week && h.position === a.position && h.gsis !== a.gsis && Math.abs(h.baseline - a.baseline!) <= 2)
      .sort((x, y) => Math.abs(x.baseline - a.baseline!) - Math.abs(y.baseline - a.baseline!) || x.gsis.localeCompare(y.gsis));
    const h = cands[0];
    if (!h || h.actual === a.actual_points!) continue;
    pairs += 1;
    const e = evaluateInjuryModel(evidenceFor(a, false), priors).injury_adjusted_expected_points ?? a.baseline!;
    const truthA = a.actual_points! > h.actual;
    for (const [t, ev] of [[un, a.baseline!], [ad, e]] as const) {
      const startA = ev >= h.baseline;
      if (startA && !truthA) t.fs += 1;
      else if (!startA && truthA) t.fb += 1;
      else t.ok += 1;
    }
  }
  const fin = (t: { fb: number; fs: number; ok: number }) => ({
    false_bench: t.fb, false_start: t.fs, correct: t.ok,
    rate_false_bench: r4(t.fb / Math.max(1, pairs)), rate_false_start: r4(t.fs / Math.max(1, pairs)), accuracy: r4(t.ok / Math.max(1, pairs)),
  });
  return { pairs, unadjusted: fin(un), adjusted: fin(ad) };
}

/** Workload evidence: snap-share when active vs own recent games, by designation. */
export function workloadSummary(cs: Case[]) {
  const out: Record<string, { n: number; mean: number; median: number }> = {};
  for (const d of ["NONE", "QUESTIONABLE"] as Designation[]) {
    const r = cs.filter((c) => c.designation === d && c.snap_ratio != null).map((c) => c.snap_ratio!).sort((a, b) => a - b);
    out[d] = { n: r.length, mean: r4(mean(r)), median: r4(r.length ? r[Math.floor(r.length / 2)]! : NaN) };
  }
  return out;
}

export function runCalibration() {
  const ds = loadDataset();
  const c25 = ds.cases.filter((c) => c.season === 2025);
  const c26 = ds.cases.filter((c) => c.season === 2026 && c.week <= 4);
  const shipped = fitCounts(c25); // the priors committed in injury-priors.ts: 2025 only
  const early = fitCounts(c25.filter((c) => c.week <= 9));
  const late = c25.filter((c) => c.week >= 10);
  const poolLate = ds.healthyPool.filter((h) => h.week >= 10);
  return {
    prior_version: INJURY_PRIOR_VERSION,
    data: { cases_2025: c25.length, cases_2026_w1_4: c26.length },
    shipped_counts: shipped,
    split_2025_temporal: {
      fit: "2025 W1-9", test: "2025 W10-18",
      probability: probabilityMetrics(late, early, false),
      probability_excl_out: probabilityMetrics(late.filter((c) => c.designation !== "OUT"), early, false),
      buckets: calibrationBuckets(late, early, false),
      points_all_designated: pointMetrics(late, early, ["QUESTIONABLE", "DOUBTFUL", "OUT"]),
      points_questionable_doubtful: pointMetrics(late, early, ["QUESTIONABLE", "DOUBTFUL"]),
      points_questionable: pointMetrics(late, early, ["QUESTIONABLE"]),
      points_doubtful: pointMetrics(late, early, ["DOUBTFUL"]),
      decisions: decisionMetrics(late, poolLate, early),
    },
    out_of_time_2026_w1_4: {
      fit: "2025 W1-18", test: "2026 W1-4", note: "no 2026 stat file: probability only; role tier proxied by prior snap share >= 0.5",
      probability: probabilityMetrics(c26, shipped, true),
      probability_excl_out: probabilityMetrics(c26.filter((c) => c.designation !== "OUT"), shipped, true),
      buckets: calibrationBuckets(c26, shipped, true),
    },
    in_sample_2025_for_reference_only: {
      probability: probabilityMetrics(c25, shipped, false),
      points_questionable_doubtful: pointMetrics(c25, shipped, ["QUESTIONABLE", "DOUBTFUL"]),
    },
    workload_when_active: workloadSummary(c25),
    by_designation_2025: Object.fromEntries(
      (["QUESTIONABLE", "DOUBTFUL", "OUT", "NONE"] as Designation[]).map((d) => {
        const r = c25.filter((c) => c.designation === d);
        return [d, { n: r.length, active_rate: r4(mean(r.map((c) => (c.played ? 1 : 0)))) }];
      }),
    ),
  };
}
