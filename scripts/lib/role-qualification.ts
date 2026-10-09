/**
 * W2.P1 — Role & Opportunity OFFLINE QUALIFICATION harness. Research code: lives under scripts/ because production must never import
 * lib/role-calibration (pinned by test/role-calibration.test.ts). Protocol and thresholds: scripts/w2p1/prereg.json (declared before any
 * evaluation of the FINAL split). Nothing here changes a production number.
 *
 * Honest limits (also in the report): there is NO stored history of the real Sleeper/RotoWire source projection, so the baseline is the W1.P2
 * proxy (mean of the previous <= 4 games), and the champion applies the production Wave 1 injury model to it. Gains over this proxy are an upper
 * bound on gains over the real Wave 1 canonical forecast.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv, num } from "../../lib/role-calibration/csv";
import { parseObservedCsv, parseProfileCsv, loadInjuryReports, loadPositionYields, type ObservedRow, type InjuryRow } from "../../lib/role-calibration/data";
import { buildHistoricalForecasts } from "../../lib/game-distribution/fit";
import { designationOf } from "../../lib/role-calibration/forecast";
import { expectedPoints } from "../../lib/role-calibration/xfp";
import { ROLE_SHADOW_CONF_WEIGHT, shadowCandidate } from "../../lib/role-calibration/shadow";
import type { ForecastConfidence, RoleForecast, RolePosition } from "../../lib/role-calibration/types";
import { evaluateInjuryModel } from "../../lib/weekly/forecast/injury-model";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const D = "lib/game-distribution/data/";

export const PREREG_PATH = "scripts/w2p1/prereg.json";
export const preregSha = (): string => createHash("sha256").update(readFileSync(join(ROOT, PREREG_PATH))).digest("hex");

export type Split = "DEV" | "VAL" | "FINAL";
export const SPLIT_WEEKS: Record<Split, readonly number[]> = { DEV: [3, 4, 5, 6, 7, 8, 9], VAL: [10, 11, 12, 13], FINAL: [14, 15, 16, 17] };
export type Scoring = "HALF" | "STD" | "PPR";
export const SCORINGS: readonly Scoring[] = ["HALF", "STD", "PPR"];
const REC_W: Record<Scoring, number> = { HALF: 0.5, STD: 0, PPR: 1 };
export const RAW_SCORING: Record<Scoring, Record<string, number>> = {
  HALF: { pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6, rec: 0.5, rec_yd: 0.1, rec_td: 6, fum_lost: -2 },
  STD: { pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6, rec: 0, rec_yd: 0.1, rec_td: 6, fum_lost: -2 },
  PPR: { pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2 },
};
export const POSITIONS: readonly RolePosition[] = ["QB", "RB", "WR", "TE"];
export const FEATURES: Record<RolePosition, readonly string[]> = {
  RB: ["exp_carries", "exp_targets", "exp_rz_carries", "exp_rz_targets", "snap_share", "b0"],
  WR: ["exp_targets", "exp_rz_targets", "snap_share", "air_yards_share", "b0"],
  TE: ["exp_targets", "exp_rz_targets", "snap_share", "air_yards_share", "b0"],
  QB: ["exp_dropbacks", "exp_designed_rushes", "exp_scrambles", "snap_share", "b0"],
};
export const RIDGE_GRID = [1, 10, 100, 1000] as const;
export const TIER_OF = (b0: number): "STARTER" | "FLEX" | "FRINGE" => (b0 >= 12 ? "STARTER" : b0 >= 6 ? "FLEX" : "FRINGE");

const pointsOf = (r: Record<string, string>, s: Scoring): number => {
  const g = (k: string) => num(r[k]) ?? 0;
  return g("passing_yards") * 0.04 + g("passing_tds") * 4 - 2 * g("passing_interceptions") + g("rushing_yards") * 0.1 + g("rushing_tds") * 6 + g("receptions") * REC_W[s] + g("receiving_yards") * 0.1 + g("receiving_tds") * 6
    - 2 * (g("rushing_fumbles_lost") + g("receiving_fumbles_lost") + g("sack_fumbles_lost")) + 2 * (g("passing_2pt_conversions") + g("rushing_2pt_conversions") + g("receiving_2pt_conversions"));
};

export interface Row {
  split: Split; week: number; gsis: string; team: string; position: RolePosition;
  designation: "NONE" | "QUESTIONABLE" | "DOUBTFUL" | "OUT"; raw_status: string | null; practice: "FULL" | "LIMITED" | "DNP" | null;
  played: boolean; tier: "STARTER" | "FLEX" | "FRINGE";
  b0: Record<Scoring, number>; actual: Record<Scoring, number>;
  forecast: RoleForecast; covered: boolean; conf: ForecastConfidence;
  x: Record<string, number | null>; // role features (point-in-time, from the as-of forecast)
  oracle: Record<string, number | null>; // CONTROL ONLY: the target game's actual opportunity (leakage sensitivity check)
  actual_opp: { targets: number | null; carries: number | null; dropbacks: number | null };
  last_opp: { targets: number | null; carries: number | null; dropbacks: number | null; last3: { targets: number | null; carries: number | null; dropbacks: number | null }; season: { targets: number | null; carries: number | null; dropbacks: number | null } };
}

export interface World { rows: Row[]; pointInTimeViolations: string[]; counts: Record<string, number> }

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const splitOf = (w: number): Split | null => (SPLIT_WEEKS.DEV.includes(w) ? "DEV" : SPLIT_WEEKS.VAL.includes(w) ? "VAL" : SPLIT_WEEKS.FINAL.includes(w) ? "FINAL" : null);

/** Build the player-week table for the requested splits ONLY (a split not requested is never read into memory-resident rows). */
export function buildWorld(splits: readonly Split[]): World {
  const weeks = new Set(splits.flatMap((s) => SPLIT_WEEKS[s]));
  const observed = parseObservedCsv(read(`${D}observed_role_game_2025.csv`)).filter((o) => o.season === 2025);
  const profiles = parseProfileCsv(read(`${D}role_profile_asof_2025.csv`));
  const injuries: InjuryRow[] = loadInjuryReports();
  const stats = parseCsv(read(`${D}historical_player_game_stats_2025.csv`));
  const statByKey = new Map<string, Record<string, string>>();
  const history = new Map<string, Array<{ week: number; pts: Record<Scoring, number> }>>();
  for (const r of stats) {
    statByKey.set(`${r.week}|${r.player_id}`, r);
    const h = history.get(r.player_id!) ?? history.set(r.player_id!, []).get(r.player_id!)!;
    h.push({ week: Number(r.week), pts: { HALF: pointsOf(r, "HALF"), STD: pointsOf(r, "STD"), PPR: pointsOf(r, "PPR") } });
  }
  const obsByKey = new Map<string, ObservedRow>();
  const obsByPlayer = new Map<string, ObservedRow[]>();
  for (const o of observed) { obsByKey.set(`${o.week}|${o.gsis_id}`, o); (obsByPlayer.get(o.gsis_id) ?? obsByPlayer.set(o.gsis_id, []).get(o.gsis_id)!).push(o); }
  const practiceByKey = new Map<string, string>();
  for (const i of injuries) if (i.season === 2025) practiceByKey.set(`${i.week}|${i.gsis_id}`, i.practice_status ?? "");

  // the schedule is known pre-game: a team with no game that week (BYE) has no outcome to forecast; Wave 1's bye semantics owns that case
  const teamPlays = new Set(observed.map((o) => `${o.week}|${o.team}`));
  const wantProfiles = profiles.filter((p) => weeks.has(p.target_week) && (POSITIONS as readonly string[]).includes(p.position));
  const wk = [...weeks].sort((a, b) => a - b);
  const forecasts = buildHistoricalForecasts({ season: 2025, profiles: wantProfiles, observed, injuries, weeks: wk });
  const fKey = new Map(forecasts.map((f) => [`${f.week}|${f.gsis_id}`, f]));

  const rows: Row[] = [];
  const violations: string[] = [];
  const counts = { profiles: wantProfiles.length, bye_week: 0, no_b0: 0, below_floor: 0, eligible: 0 };
  for (const p of wantProfiles) {
    if (!teamPlays.has(`${p.target_week}|${p.team}`)) { counts.bye_week++; continue; }
    const f = fKey.get(`${p.target_week}|${p.gsis_id}`); if (!f) continue;
    const prior = (history.get(p.gsis_id) ?? []).filter((x) => x.week < p.target_week).sort((a, b) => a.week - b.week).slice(-4);
    if (!prior.length) { counts.no_b0++; continue; }
    const b0 = { HALF: mean(prior.map((x) => x.pts.HALF))!, STD: mean(prior.map((x) => x.pts.STD))!, PPR: mean(prior.map((x) => x.pts.PPR))! };
    if (b0.HALF < 3) { counts.below_floor++; continue; }
    const d = designationOf(injuries, 2025, p.target_week, p.gsis_id);
    const designation = (d === "UNKNOWN" ? "NONE" : d) as Row["designation"];
    const pr = practiceByKey.get(`${p.target_week}|${p.gsis_id}`) ?? "";
    const practice = pr.startsWith("Full") ? "FULL" : pr.startsWith("Limited") ? "LIMITED" : pr.startsWith("Did Not") ? "DNP" : null;
    const rawStatus = designation === "NONE" ? null : designation === "OUT" ? "Out" : designation === "DOUBTFUL" ? "Doubtful" : "Questionable";
    const target = obsByKey.get(`${p.target_week}|${p.gsis_id}`);
    const stat = statByKey.get(`${p.target_week}|${p.gsis_id}`);
    const actual = stat ? { HALF: pointsOf(stat, "HALF"), STD: pointsOf(stat, "STD"), PPR: pointsOf(stat, "PPR") } : { HALF: 0, STD: 0, PPR: 0 };
    const own = (obsByPlayer.get(p.gsis_id) ?? []).filter((o) => o.week < p.target_week && (o.offensive_snaps ?? 0) > 0).sort((a, b) => a.week - b.week);
    const cnt = (k: "targets" | "carries" | "dropbacks", rs: ObservedRow[]) => mean(rs.map((o) => o[k]).filter((v): v is number => v != null));
    const lastRow = own.at(-1);
    const o = f.opportunity;
    const m = (k: string) => f.metrics[k as keyof typeof f.metrics]?.value ?? null;
    const x: Row["x"] = { exp_carries: o.carries, exp_targets: o.targets, exp_rz_carries: o.rz_carries, exp_rz_targets: o.rz_targets, exp_dropbacks: o.dropbacks, exp_designed_rushes: o.designed_rushes, exp_scrambles: o.scrambles, snap_share: m("snap_share"), air_yards_share: m("air_yards_share") };
    const tOpp: Record<string, number | null> = target ? { exp_carries: target.carries, exp_targets: target.targets, exp_rz_carries: target.red_zone_carries, exp_rz_targets: target.red_zone_targets, exp_dropbacks: target.dropbacks, exp_designed_rushes: target.designed_rushes, exp_scrambles: target.qb_scrambles, snap_share: target.snap_share, air_yards_share: target.air_yards_share } : {};
    const row: Row = {
      split: splitOf(p.target_week)!, week: p.target_week, gsis: p.gsis_id, team: p.team, position: p.position as RolePosition, designation, raw_status: rawStatus, practice,
      played: (target?.offensive_snaps ?? 0) > 0, tier: TIER_OF(b0.HALF), b0, actual, forecast: f,
      covered: f.confidence !== "INSUFFICIENT_SAMPLE", conf: f.confidence, x, oracle: { ...x, ...tOpp },
      actual_opp: { targets: target?.targets ?? null, carries: target?.carries ?? null, dropbacks: target?.dropbacks ?? null },
      last_opp: {
        targets: lastRow?.targets ?? null, carries: lastRow?.carries ?? null, dropbacks: lastRow?.dropbacks ?? null,
        last3: { targets: cnt("targets", own.slice(-3)), carries: cnt("carries", own.slice(-3)), dropbacks: cnt("dropbacks", own.slice(-3)) },
        season: { targets: cnt("targets", own), carries: cnt("carries", own), dropbacks: cnt("dropbacks", own) },
      },
    };
    // structural point-in-time contract on every row
    const pit = f.provenance as { last_game?: { week: number } | null };
    if (pit.last_game && pit.last_game.week >= p.target_week) violations.push(`${p.gsis_id} wk${p.target_week}: input game wk${pit.last_game.week} not strictly earlier`);
    rows.push(row); counts.eligible++;
  }
  return { rows, pointInTimeViolations: violations, counts };
}

/* ------------------------------------------------------------------------------------------------ models */

export function injuryExpected(r: Row, sourcePoints: number): number {
  const ev = { source_status: r.raw_status, position: r.position, source_points: sourcePoints, practice: r.practice, source_semantics: "CONDITIONAL_ON_ACTIVE" as const };
  return evaluateInjuryModel(ev).injury_adjusted_expected_points ?? sourcePoints;
}
export const b1Of = (r: Row, s: Scoring): number => injuryExpected(r, r.b0[s]);

export const isFit = (r: Row): boolean => r.played && r.designation !== "OUT" && r.covered;
const featOf = (r: Row, list: readonly string[], scoring: Scoring, src: "x" | "oracle" = "x"): number[] | null => {
  const v = list.map((k) => (k === "b0" ? r.b0[scoring] : r[src][k] ?? null));
  return v.every((z) => z != null) ? (v as number[]) : null;
};

export interface RidgeModel { position: RolePosition; scoring: Scoring; lambda: number; mean: number[]; sd: number[]; coef: number[]; intercept: number; n_fit: number; features: readonly string[] }

function solve(A: number[][], b: number[]): number[] {
  const n = b.length; const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const d = M[c]![c]!; for (let k = c; k <= n; k++) M[c]![k]! /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r]![c]!; for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!; }
  }
  return M.map((row) => row[n]!);
}

/** Fit on the supplied rows ONLY (the caller passes DEV rows). Target: played points - B0p (conditional-on-active). */
export const ROLE_FREE: readonly string[] = ["b0"];
export function fitRidge(rows: readonly Row[], pos: RolePosition, scoring: Scoring, lambda: number, list: readonly string[] = FEATURES[pos], src: "x" | "oracle" = "x"): RidgeModel | null {
  const X: number[][] = []; const y: number[] = [];
  for (const r of rows) {
    if (r.position !== pos || !isFit(r)) continue;
    const f = featOf(r, list, scoring, src); if (!f) continue;
    X.push(f); y.push(r.actual[scoring] - r.b0[scoring]);
  }
  if (X.length < 40) return null;
  const k = list.length, n = X.length;
  const mu = Array.from({ length: k }, (_, j) => X.reduce((s, v) => s + v[j]!, 0) / n);
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(X.reduce((s, v) => s + (v[j]! - mu[j]!) ** 2, 0) / n) || 1);
  const Z = X.map((v) => v.map((z, j) => (z - mu[j]!) / sd[j]!));
  const ym = y.reduce((a, b) => a + b, 0) / n;
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => Z.reduce((s, v) => s + v[i]! * v[j]!, 0) + (i === j ? lambda : 0)));
  const bb = Array.from({ length: k }, (_, i) => Z.reduce((s, v, t) => s + v[i]! * (y[t]! - ym), 0));
  return { position: pos, scoring, lambda, mean: mu, sd, coef: solve(A, bb), intercept: ym, n_fit: n, features: list };
}
export const rawPredict = (m: RidgeModel, f: number[]): number => m.intercept + f.reduce((s, z, j) => s + ((z - m.mean[j]!) / m.sd[j]!) * m.coef[j]!, 0);

export interface C2Out { delta: number; raw: number; capped: boolean; applicable: boolean; expected: number }
export function c2Of(r: Row, model: RidgeModel | null, scoring: Scoring, src: "x" | "oracle" = "x", shuffled?: number[] | null): C2Out {
  const b0 = r.b0[scoring];
  const neutral = { delta: 0, raw: 0, capped: false, applicable: false, expected: b1Of(r, scoring) };
  if (!model || !r.covered || r.designation === "OUT") return neutral;
  const f = shuffled ?? featOf(r, model.features, scoring, src); if (!f) return neutral;
  const raw = rawPredict(model, f);
  const cap = Math.max(1, 0.25 * Math.abs(b0));
  const clamped = Math.max(-cap, Math.min(cap, raw));
  const delta = ROLE_SHADOW_CONF_WEIGHT[r.conf] * clamped + 0; // + 0 normalizes -0
  return { delta, raw, capped: Math.abs(raw) > cap, applicable: true, expected: injuryExpected(r, b0 + delta) };
}

/** C1 exactly as it exists: shadowCandidate on baseline B1p, xFP from the committed (same-season) yield table. */
export function c1Of(r: Row, scoring: Scoring): number | null {
  const y = loadPositionYields(2025); if (!y) return null;
  const xfp = expectedPoints(r.position, r.forecast.opportunity, y, RAW_SCORING[scoring]);
  const xfpNp = expectedPoints(r.position, r.forecast.opportunity_no_pressure, y, RAW_SCORING[scoring]);
  return shadowCandidate({ baseline: b1Of(r, scoring), xfp_forecast: xfp, xfp_no_pressure: xfpNp, p_absent: r.forecast.availability.p_absent, confidence: r.conf }).candidate_projection;
}

/* ------------------------------------------------------------------------------------------------ metrics */

export interface ErrStats { n: number; mae: number; rmse: number; bias: number }
export function errStats(errs: readonly number[]): ErrStats {
  const n = errs.length; if (!n) return { n: 0, mae: NaN, rmse: NaN, bias: NaN };
  return { n, mae: errs.reduce((s, e) => s + Math.abs(e), 0) / n, rmse: Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / n), bias: errs.reduce((s, e) => s + e, 0) / n };
}

/** deterministic PRNG so a reported CI is reproducible */
function lcg(seed: number): () => number { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

export interface Paired { n: number; champion: ErrStats; challenger: ErrStats; dMAE: number; dRMSE: number; dMAE_ci: [number, number]; weeks: Record<number, number> }
/** Paired comparison with a cluster bootstrap over team-weeks (players of one game share game script). dMAE > 0 means the challenger is better. */
export function paired(rows: readonly Row[], champion: (r: Row) => number, challenger: (r: Row) => number, scoring: Scoring, reps = 2000): Paired {
  const e1 = rows.map((r) => r.actual[scoring] - champion(r)), e2 = rows.map((r) => r.actual[scoring] - challenger(r));
  const c1 = errStats(e1), c2 = errStats(e2);
  const clusters = new Map<string, number[]>(); rows.forEach((r, i) => (clusters.get(`${r.team}|${r.week}`) ?? clusters.set(`${r.team}|${r.week}`, []).get(`${r.team}|${r.week}`)!).push(i));
  const keys = [...clusters.keys()], rnd = lcg(20250914), diffs: number[] = [];
  const abs = (a: number[], idx: number[]) => idx.reduce((s, i) => s + Math.abs(a[i]!), 0);
  const per = keys.map((k) => ({ n: clusters.get(k)!.length, d: abs(e1, clusters.get(k)!) - abs(e2, clusters.get(k)!) }));
  for (let b = 0; b < reps && keys.length; b++) { let n = 0, d = 0; for (let t = 0; t < keys.length; t++) { const c = per[Math.floor(rnd() * keys.length)]!; n += c.n; d += c.d; } diffs.push(n ? d / n : 0); }
  diffs.sort((a, b) => a - b);
  const weeks: Record<number, number> = {};
  for (const w of [...new Set(rows.map((r) => r.week))]) { const idx = rows.map((r, i) => (r.week === w ? i : -1)).filter((i) => i >= 0); weeks[w] = (abs(e1, idx) - abs(e2, idx)) / idx.length; }
  return { n: rows.length, champion: c1, challenger: c2, dMAE: c1.mae - c2.mae, dRMSE: c1.rmse - c2.rmse, dMAE_ci: [diffs[Math.floor(0.025 * diffs.length)] ?? NaN, diffs[Math.floor(0.975 * diffs.length)] ?? NaN], weeks };
}

export interface DecisionStats { pairs: number; disagreements: number; decided: number; challenger_wins: number; champion_wins: number; ambiguous: number; p_one_sided: number }
function binomUpper(k: number, n: number): number { // P(X >= k), X~Bin(n, 0.5)
  if (n === 0) return 1; let p = 0; let logC = 0;
  const lf = (x: number) => { let s = 0; for (let i = 2; i <= x; i++) s += Math.log(i); return s; };
  for (let i = k; i <= n; i++) { logC = lf(n) - lf(i) - lf(n - i); p += Math.exp(logC - n * Math.LN2); }
  return Math.min(1, p);
}
/** Start/sit-style pairs: same team, same position, same week; the better-ranked player is "started". */
export function decisions(rows: readonly Row[], champion: (r: Row) => number, challenger: (r: Row) => number, scoring: Scoring): DecisionStats {
  const g = new Map<string, Row[]>(); for (const r of rows) (g.get(`${r.team}|${r.week}|${r.position}`) ?? g.set(`${r.team}|${r.week}|${r.position}`, []).get(`${r.team}|${r.week}|${r.position}`)!).push(r);
  let pairs = 0, dis = 0, decided = 0, cw = 0, hw = 0, amb = 0;
  for (const grp of g.values()) for (let i = 0; i < grp.length; i++) for (let j = i + 1; j < grp.length; j++) {
    const a = grp[i]!, b = grp[j]!; pairs++;
    const ch = champion(a) - champion(b), cn = challenger(a) - challenger(b);
    if (Math.sign(ch) === Math.sign(cn) || ch === 0 || cn === 0) continue;
    dis++;
    const act = a.actual[scoring] - b.actual[scoring];
    if (Math.abs(act) < 1) { amb++; continue; }
    decided++; if (Math.sign(act) === Math.sign(cn)) cw++; else hw++;
  }
  return { pairs, disagreements: dis, decided, challenger_wins: cw, champion_wins: hw, ambiguous: amb, p_one_sided: binomUpper(cw, decided) };
}

export interface OppAccuracy { position: string; metric: string; n: number; role_mae: number; last_game_mae: number; last3_mae: number; season_mae: number }
export function opportunityAccuracy(rows: readonly Row[]): OppAccuracy[] {
  const spec: Array<[RolePosition, "targets" | "carries" | "dropbacks", string]> = [["RB", "carries", "exp_carries"], ["RB", "targets", "exp_targets"], ["WR", "targets", "exp_targets"], ["TE", "targets", "exp_targets"], ["QB", "dropbacks", "exp_dropbacks"]];
  return spec.map(([pos, m, fk]) => {
    const use = rows.filter((r) => r.position === pos && r.played && r.covered && r.actual_opp[m] != null && r.x[fk] != null && r.last_opp[m] != null && r.last_opp.last3[m] != null && r.last_opp.season[m] != null);
    const mae = (f: (r: Row) => number) => (use.length ? use.reduce((s, r) => s + Math.abs(r.actual_opp[m]! - f(r)), 0) / use.length : NaN);
    return { position: pos, metric: m, n: use.length, role_mae: mae((r) => r.x[fk]!), last_game_mae: mae((r) => r.last_opp[m]!), last3_mae: mae((r) => r.last_opp.last3[m]!), season_mae: mae((r) => r.last_opp.season[m]!) };
  });
}

export const featuresOf = (r: Row, list: readonly string[], scoring: Scoring): number[] | null => featOf(r, list, scoring);
