/**
 * W2.R1 S5 ladder (FIT 2022-2024 -> VAL 2025 wk 3-17). Reads scripts/w2r1/cache/s5_rows.csv (built by s5_build.R: Tier-A as-of features; Tier-B only as prior-season carryover).
 * NEVER reads 2026. Writes scripts/w2r1/results/s5_val.json. Availability is applied exactly once: expected = evaluateInjuryModel(B0p + delta).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { evaluateInjuryModel } from "@/lib/weekly/forecast/injury-model";
import { confidenceWeight, retainLayer } from "@/lib/w2r1/gameplan";

if (existsSync("scripts/w2r1/FROZEN.json")) console.log("note: FROZEN.json exists (S7); S5 still touches VAL only");
type Row = Record<string, number | string | null>;
const lines = readFileSync("scripts/w2r1/cache/s5_rows.csv", "utf8").split("\n").filter(Boolean);
const head = lines[0]!.replace(/"/g, "").split(",");
const rows: Row[] = lines.slice(1).map((l) => { const c = l.split(","); const o: Row = {}; head.forEach((h, i) => { const v = (c[i] ?? "").replace(/"/g, ""); o[h] = v === "" || v === "NA" ? null : isNaN(Number(v)) ? v : Number(v); }); return o; });
if (rows.some((r) => (r.season as number) >= 2026)) throw new Error("2026 rows present: S5 must not load FINAL data");
const num = (r: Row, k: string): number | null => (typeof r[k] === "number" ? (r[k] as number) : null);
const POS = ["QB", "RB", "WR", "TE"] as const; type Pos = (typeof POS)[number];
const MODES = ["CUR", "MULTI", "CONT"] as const; type Mode = (typeof MODES)[number];

/* ---------------- features ---------------- */
const RL: Record<Pos, string[]> = { QB: ["rl_dropbacks", "rl_designed", "rl_scrambles", "rl_snap", "b0f"], RB: ["rl_carries", "rl_targets", "rl_rz_carries", "rl_rz_targets", "rl_snap", "b0f"], WR: ["rl_targets", "rl_rz_targets", "rl_snap", "rl_air_share", "b0f"], TE: ["rl_targets", "rl_rz_targets", "rl_snap", "rl_air_share", "b0f"] };
const CTX = ["implied_team_total", "team_spread", "opp_implied_total", "team_pace_asof", "dome"];
const OFF = ["t_neutral_pass_rate", "t_early_down_pass_rate", "t_play_action_rate", "t_screen_rate", "t_deep_attempt_rate", "t_rb_target_share", "t_rz_pass_rate", "t_goal_line_run_rate", "t_sack_rate_suffered"];
const DEF = ["d_sack_rate", "d_blitz_rate", "d_pass_epa_allowed", "d_rush_epa_allowed", "d_explosive_pass_allowed", "d_deep_target_concession", "d_rb_target_share_allowed", "d_rz_td_rate_allowed", "d_ppg_allowed"];
const FPR: Record<Pos, string[]> = { QB: ["s_sack", "s_scr", "s_qadot", "s_pa", "s_qdeep"], RB: ["s_tgt", "s_gl", "s_expl", "s_screen", "s_rz_c"], WR: ["s_adot", "s_deep", "s_rz_t", "s_yac"], TE: ["s_adot", "s_rz_t", "s_yac", "s_under"] };
const TIERB = ["tbB_off11", "tbB_man", "tbB_2high"];
const SO = ["so_missing_target_share", "so_missing_rush_share", "so_ol_out", "so_front_out"];
/** the five declared interactions (spec) as [name, player feature, opponent feature]; the mode suffix is applied to the opponent feature */
const INTER: Record<Pos, Array<[string, string, string]>> = {
  QB: [["x_press", "s_sack", "d_sack_rate"], ["x_pa_blitz", "s_pa", "d_blitz_rate"]],
  RB: [["x_rb_press", "s_tgt", "d_blitz_rate"], ["x_gl", "s_gl", "d_rz_td_rate_allowed"], ["x_rz", "s_rz_c", "d_rz_td_rate_allowed"]],
  WR: [["x_deep", "s_deep", "d_deep_target_concession"], ["x_rz", "s_rz_t", "d_rz_td_rate_allowed"]],
  TE: [["x_deep", "s_adot", "d_deep_target_concession"], ["x_rz", "s_rz_t", "d_rz_td_rate_allowed"]],
};
const withMode = (list: string[], m: Mode): string[] => list.map((f) => `${f}_${m}`);
function enrich(r: Row, m: Mode): void { for (const pos of POS) if (r.position === pos) for (const [n, p, o] of INTER[pos]) { const a = num(r, p), b = num(r, `${o}_${m}`); r[`${n}_${m}`] = a != null && b != null ? a * b : null; } }
for (const r of rows) { r.b0f = (r.split === "VAL" ? num(r, "p1_b0") : num(r, "b0")) ?? null; for (const m of MODES) enrich(r, m); }
const features = (pos: Pos, step: string, m: Mode): string[] => {
  const g1 = [...RL[pos], ...CTX];
  const g2 = [...g1, ...withMode(OFF, m), ...withMode(DEF, m), ...FPR[pos]];
  const g3 = [...g2, ...INTER[pos].map(([n]) => `${n}_${m}`)];
  switch (step) { case "RL": return RL[pos]; case "G1": return g1; case "G2": return g2; case "G2b": return [...g2, ...TIERB]; case "G3": return g3; case "G4": return [...g3, ...SO]; default: throw new Error(step); }
};

/* ---------------- model ---------------- */
function solve(A: number[][], b: number[]): number[] { const n = b.length; const M = A.map((r, i) => [...r, b[i]!]); for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r; [M[c], M[p]] = [M[p]!, M[c]!]; const d = M[c]![c]!; for (let j = c; j <= n; j++) M[c]![j]! /= d; for (let r = 0; r < n; r++) if (r !== c) { const f = M[r]![c]!; for (let j = c; j <= n; j++) M[r]![j]! -= f * M[c]![j]!; } } return M.map((r) => r[n]!); }
interface Ridge { mean: number[]; sd: number[]; coef: number[]; icpt: number; list: string[]; lambda: number; n: number }
function fitRidge(fit: Row[], list: string[], lambda: number): Ridge | null {
  const X: number[][] = []; const y: number[] = [];
  for (const r of fit) { const f = list.map((k) => num(r, k)); if (f.some((v) => v == null)) continue; X.push(f as number[]); y.push((num(r, "actual") as number) - (num(r, "b0f") as number)); }
  if (X.length < list.length + 20) return null;
  const p = list.length, n = X.length; const mean = Array.from({ length: p }, (_, j) => X.reduce((s, r) => s + r[j]!, 0) / n); const sd = Array.from({ length: p }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j]! - mean[j]!) ** 2, 0) / n) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]!) / sd[j]!)); const ym = y.reduce((a, b) => a + b, 0) / n; const yc = y.map((v) => v - ym);
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => Z.reduce((s, r) => s + r[i]! * r[j]!, 0) + (i === j ? lambda : 0))); const bb = Array.from({ length: p }, (_, j) => Z.reduce((s, r, i) => s + r[j]! * yc[i]!, 0));
  return { mean, sd, coef: solve(A, bb), icpt: ym, list, lambda, n };
}
const raw = (m: Ridge, r: Row): number | null => { let s = m.icpt; for (let j = 0; j < m.list.length; j++) { const v = num(r, m.list[j]!); if (v == null) return null; s += ((v - m.mean[j]!) / m.sd[j]!) * m.coef[j]!; } return s; };
const inj = (r: Row, source: number): number => evaluateInjuryModel({ source_status: (r.raw as string | null) ?? null, position: r.position as string, source_points: source, practice: ((r.pract as string | null) ?? null) as never, source_semantics: "CONDITIONAL_ON_ACTIVE" }).injury_adjusted_expected_points ?? source;
const rawStatus = (d: string): string | null => (d === "NONE" ? null : d === "OUT" ? "Out" : d === "DOUBTFUL" ? "Doubtful" : "Questionable");
for (const r of rows) { r.raw = rawStatus(r.desig as string); r.pract = r.pract === "" ? null : (r.pract as string | null); }
const confW = (r: Row, m: Mode, uses: "player" | "team"): number => {
  const pn = (num(r, "n") ?? 0); const tn = Math.min((num(r, `n_off_cur_${m}`) ?? 0), (num(r, `n_def_cur_${m}`) ?? 0)) + ((r.season as number) > 2022 && m !== "CUR" ? 10 : 0);
  return confidenceWeight(pn, uses === "player" ? pn : tn);
};
interface Pred { expected: number; delta: number; applicable: boolean; capped: boolean; cw: number }
function predict(m: Ridge | null, r: Row, mode: Mode, uses: "player" | "team"): Pred {
  const b0 = num(r, "b0f") as number; const neutral: Pred = { expected: inj(r, b0), delta: 0, applicable: false, capped: false, cw: 0 };
  if (!m || r.desig === "OUT" || r.p1_covered !== 1 && r.split === "VAL") return neutral;
  const z = raw(m, r); if (z == null) return neutral; const cw = confW(r, mode, uses); if (cw === 0) return { ...neutral, cw };
  const cap = Math.max(1, 0.25 * Math.abs(b0)); const cl = Math.max(-cap, Math.min(cap, z)); const delta = cw * cl + 0;
  return { expected: inj(r, b0 + delta), delta, applicable: true, capped: Math.abs(z) > cap, cw };
}
/* ---------------- stats ---------------- */
const mae = (e: number[]) => e.reduce((s, v) => s + Math.abs(v), 0) / e.length; const rmse = (e: number[]) => Math.sqrt(e.reduce((s, v) => s + v * v, 0) / e.length); const bias = (e: number[]) => e.reduce((s, v) => s + v, 0) / e.length;
function lcg(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function boot(rows: Row[], a: number[], b: number[], B = 2000): { d: number; lo: number; hi: number; p: number } { // a, b = prediction arrays for champion/challenger; d = MAE(a) - MAE(b); cluster by team-week
  const idx = new Map<string, number[]>(); rows.forEach((r, i) => { const k = `${r.team}|${r.week}`; (idx.get(k) ?? idx.set(k, []).get(k)!).push(i); }); const keys = [...idx.keys()]; const rnd = lcg(20261014);
  const ea = rows.map((r, i) => Math.abs((r.actual as number) - a[i]!)), eb = rows.map((r, i) => Math.abs((r.actual as number) - b[i]!)); const d0 = ea.reduce((s, v) => s + v, 0) / rows.length - eb.reduce((s, v) => s + v, 0) / rows.length; const ds: number[] = [];
  for (let t = 0; t < B; t++) { let sa = 0, sb = 0, n = 0; for (let k = 0; k < keys.length; k++) { for (const i of idx.get(keys[Math.floor(rnd() * keys.length)]!)!) { sa += ea[i]!; sb += eb[i]!; n++; } } ds.push((sa - sb) / n); }
  ds.sort((x, y) => x - y); return { d: d0, lo: ds[Math.floor(0.025 * B)]!, hi: ds[Math.floor(0.975 * B)]!, p: ds.filter((v) => v <= 0).length / B };
}
/* ---------------- ladder ---------------- */
const LAMBDAS = [1, 10, 100, 1000] as const;
const AUDIT: Record<string, unknown> = {};
const out: Record<string, unknown> = { spec: "w2r1-s5-spec-1", splits: { FIT: "2022-2024 wk>=3 played non-OUT rows", VAL: "2025 wk 3-17 (W2.P1 world rows)" }, positions: {} };
const fitRows = (pos: Pos) => rows.filter((r) => r.split === "FIT" && r.position === pos && r.desig !== "OUT" && num(r, "b0f") != null && (num(r, "b0f") as number) >= 3);
const valAll = (pos: Pos) => rows.filter((r) => r.split === "VAL" && r.position === pos && r.p1_covered === 1 && r.desig !== "OUT" && (num(r, "b0f") as number) >= 3);
for (const pos of POS) {
  const fit = fitRows(pos), val = valAll(pos); const valA = val.filter((r) => (r.week as number) <= 9), valB = val.filter((r) => (r.week as number) >= 10);
  const B1 = val.map((r) => inj(r, num(r, "b0f") as number)); const C2 = val.map((r) => num(r, "p1_c2") as number);
  const stats = (pred: number[], rs: Row[]) => { const e = rs.map((r, i) => (r.actual as number) - pred[i]!); return { n: rs.length, mae: mae(e), rmse: rmse(e), bias: bias(e) }; };
  const P: Record<string, unknown> = { n_fit: fit.length, n_val: val.length, B1p: stats(B1, val), C2_W2P1_Role: stats(C2, val) };
  const trial = (step: string, mode: Mode, lam: number, train: Row[]) => fitRidge(train, features(pos, step, mode), lam);
  const evalSet = (m: Ridge | null, rs: Row[], mode: Mode, uses: "player" | "team") => rs.map((r) => predict(m, r, mode, uses));
  const maeOf = (ps: Pred[], rs: Row[]) => mae(rs.map((r, i) => (r.actual as number) - ps[i]!.expected));
  const choose = (step: string, mode: Mode, uses: "player" | "team", valSel: Row[], train: Row[]) => { let best: { lam: number; m: Ridge | null; mae: number } | null = null; for (const lam of LAMBDAS) { const m = trial(step, mode, lam, train); const v = maeOf(evalSet(m, valSel, mode, uses), valSel); if (!best || v < best.mae - 1e-12 || (Math.abs(v - best.mae) <= 1e-12 && lam > best.lam)) best = { lam, m, mae: v }; } return best!; };
  const report = (step: string, mode: Mode, uses: "player" | "team") => {
    const sel = choose(step, mode, uses, val, fit); const ps = evalSet(sel.m, val, mode, uses); const pred = ps.map((p) => p.expected);
    // VAL-LATE: lambda chosen on weeks 3-9 only, scored on 10-17
    const selE = choose(step, mode, uses, valA, fit); const late = evalSet(selE.m, valB, mode, uses); const b1late = valB.map((r) => inj(r, num(r, "b0f") as number));
    const app = ps.filter((p) => p.applicable); const lateStats = { lambda: selE.lam, mae: maeOf(late, valB), b1p_mae: mae(valB.map((r, i) => (r.actual as number) - b1late[i]!)), dMAE_vs_B1p: mae(valB.map((r, i) => (r.actual as number) - b1late[i]!)) - maeOf(late, valB) };
    return { step, mode, lambda: sel.lam, ...stats(pred, val), coverage: app.length / val.length, cap_hit_rate: app.length ? app.filter((p) => p.capped).length / app.length : 0, pred, val_late: lateStats, model: sel.m };
  };
  const cmp = (cand: number[], ctl: number[]) => { const b = boot(val, ctl, cand); return { dMAE: b.d, lo95: b.lo, hi95: b.hi, p_one_sided: b.p }; };
  const steps: Array<{ name: string; mode: Mode }> = []; const results: Record<string, ReturnType<typeof report>> = {};
  const run = (name: string, step: string, mode: Mode, uses: "player" | "team") => { const r = report(step, mode, uses); results[name] = r; return r; };
  run("RL", "RL", "CUR", "player"); run("G1", "G1", "CUR", "player");
  const g2 = MODES.map((m) => run(`G2_${m}`, "G2", m, "team")); g2.sort((a, b) => a.mae - b.mae || MODES.indexOf(a.mode) - MODES.indexOf(b.mode)); const bestMode = g2[0]!.mode; results.G2 = results[`G2_${bestMode}`]!;
  run("G2b", "G2b", bestMode, "team"); run("G3", "G3", bestMode, "team"); run("G4", "G4", bestMode, "team");
  const chain = ["RL", "G1", "G2", "G3", "G4"]; let prevName = "B1p"; let prevPred = B1; const retained: string[] = []; const ladder: Record<string, unknown> = {};
  for (const nme of chain) { const r = results[nme]!; const c = cmp(r.pred, prevPred); const keep = retainLayer(c.dMAE, c.lo95); ladder[nme] = { vs_previous_retained: prevName, ...c, retained: keep }; if (keep) { retained.push(nme); prevName = nme; prevPred = r.pred; } }
  const summary: Record<string, unknown> = {};
  for (const k of Object.keys(results)) { const r = results[k]!; const vsB1 = cmp(r.pred, B1); const vsC2 = cmp(r.pred, C2); summary[k] = { mode: r.mode, lambda: r.lambda, n: r.n, mae: r.mae, rmse: r.rmse, bias: r.bias, coverage: r.coverage, cap_hit_rate: r.cap_hit_rate, vs_B1p: vsB1, vs_C2: vsC2, val_late: r.val_late }; }
  // ---- S7 adjudication audit (READ-ONLY on the S5 results above; VAL/FIT only; writes a SEPARATE file) ----
  { const cands: Record<string, unknown> = {}; const rowsFit = fit; const dnp = (r: Row) => (r.actual as number) === 0; const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const popStats = (rs: Row[]) => ({ n: rs.length, share_actual_zero: rs.filter(dnp).length / (rs.length || 1), mean_b0: mean(rs.map((r) => num(r, "b0f") as number)), mean_actual: mean(rs.map((r) => r.actual as number)), mean_actual_minus_b0: mean(rs.map((r) => (r.actual as number) - (num(r, "b0f") as number))), mean_actual_minus_b0_played: mean(rs.filter((r) => !dnp(r)).map((r) => (r.actual as number) - (num(r, "b0f") as number))) });
    for (const nme of ["RL", "G1", "G2", "G2b", "G3", "G4"]) { const res = results[nme]!; const m = res.model as Ridge | null; if (!m) continue;
      const mode = res.mode; const uses: "player" | "team" = nme === "RL" || nme === "G1" ? "player" : "team"; const recs: Array<{ r: Row; z: number; cap: number; cw: number; p: Pred }> = [];
      for (const r of val) { const p = predict(m, r, mode, uses); if (!p.applicable) continue; const z = raw(m, r) as number; recs.push({ r, z, cap: Math.max(1, 0.25 * Math.abs(num(r, "b0f") as number)), cw: p.cw, p }); }
      const hit = (x: typeof recs) => (x.length ? x.filter((q) => Math.abs(q.z) > q.cap).length / x.length : 0);
      const noIcpt = recs.map((q) => ({ ...q, z: q.z - m.icpt })); const played = recs.filter((q) => !dnp(q.r)); const zero = recs.filter((q) => dnp(q.r));
      const bucket = (lo: number, hi: number) => recs.filter((q) => (num(q.r, "b0f") as number) >= lo && (num(q.r, "b0f") as number) < hi);
      // end-to-end (the evaluated pipeline) vs conditional-on-play diagnostics
      const e2e = val.map((r) => predict(m, r, mode, uses).expected); const err = val.map((r, i) => (r.actual as number) - e2e[i]!); const pl = val.map((r, i) => ({ r, i })).filter((o) => !dnp(o.r));
      const b1 = val.map((r) => inj(r, num(r, "b0f") as number));
      cands[nme] = { cap_hit_rate: hit(recs), n_applicable: recs.length, hit_high: recs.filter((q) => q.z > q.cap).length / (recs.length || 1), hit_low: recs.filter((q) => q.z < -q.cap).length / (recs.length || 1),
        intercept: m.icpt, cap_hit_if_intercept_removed: hit(noIcpt as never), cap_hit_among_played: hit(played), cap_hit_among_actual_zero: hit(zero), n_actual_zero_among_applicable: zero.length,
        cap_hit_by_b0: { lt6: hit(bucket(0, 6)), b6_10: hit(bucket(6, 10)), ge10: hit(bucket(10, 1e9)) }, mean_abs_z_over_cap: mean(recs.map((q) => Math.abs(q.z) / q.cap)), mean_z: mean(recs.map((q) => q.z)), mean_cw: mean(recs.map((q) => q.cw)),
        share_of_raw_z_explained_by_intercept: recs.length ? Math.abs(m.icpt) / mean(recs.map((q) => Math.abs(q.z))) : 0,
        bias_end_to_end_all_val: bias(err), bias_conditional_on_play: bias(pl.map((o) => err[o.i]!)), bias_b1p_all_val: bias(val.map((r, i) => (r.actual as number) - b1[i]!)), bias_b1p_conditional_on_play: bias(pl.map((o) => (o.r.actual as number) - b1[o.i]!)),
        mae_end_to_end_all_val: mae(err), mae_conditional_on_play: mae(pl.map((o) => err[o.i]!)), mae_b1p_conditional_on_play: mae(pl.map((o) => (o.r.actual as number) - b1[o.i]!)), availability_once_proof: (() => { const none = recs.filter((q) => q.r.desig === "NONE"); const once = recs.map((q) => Math.abs(q.p.expected - inj(q.r, (num(q.r, "b0f") as number) + q.p.delta))); const noneDev = none.map((q) => Math.abs(q.p.expected - ((num(q.r, "b0f") as number) + q.p.delta)));
          const twice = recs.filter((q) => q.r.desig !== "NONE").map((q) => Math.abs(q.p.expected - inj(q.r, inj(q.r, (num(q.r, "b0f") as number) + q.p.delta)))); return { n_rows: recs.length, max_abs_dev_expected_vs_single_application: Math.max(0, ...once), n_designation_NONE_rows: none.length, max_abs_dev_NONE_rows_vs_undiscounted: Math.max(0, ...noneDev), n_discounted_rows: twice.length, min_abs_dev_vs_double_application_on_discounted_rows: twice.length ? Math.min(...twice) : null }; })(), mean_pred_on_actual_zero_rows: mean(val.filter(dnp).map((r) => e2e[val.indexOf(r)]!)) };
    }
    AUDIT[pos] = { fit_population: popStats(rowsFit), val_population: popStats(val), val_population_played_only: popStats(val.filter((r) => !dnp(r))), candidates: cands, spec_note: "FIT rows = non-OUT rows with b0f>=3 INCLUDING actual==0 rows (see fit_population.share_actual_zero); VAL identical filter." }; }
  P.candidates = summary; P.ladder = ladder; P.retained_chain = retained; P.chosen_tactical_mode = bestMode; P.g2_modes = Object.fromEntries(g2.map((g) => [g.mode, { mae: g.mae }]));
  // ORACLE control: target-game actual usage as features (harness sensitivity)
  const oracleList = pos === "QB" ? ["o_dropbacks", "rl_snap", "b0f"] : pos === "RB" ? ["o_carries", "o_targets", "rl_snap", "b0f"] : ["o_targets", "rl_snap", "b0f"];
  const om = fitRidge(fit.filter((r) => num(r, "o_targets") != null), oracleList, 10); const op = val.map((r) => { const z = om ? raw(om, r) : null; const b0 = num(r, "b0f") as number; return z == null || r.desig === "OUT" ? inj(r, b0) : inj(r, b0 + Math.max(-Math.max(1, .25 * b0) * 4, Math.min(Math.max(1, .25 * b0) * 4, z))); });
  P.oracle = { mae: stats(op, val).mae, b1p_mae: (P.B1p as { mae: number }).mae, relative_reduction: 1 - stats(op, val).mae / (P.B1p as { mae: number }).mae, note: "uncapped-ish oracle (cap x4) uses the TARGET GAME's actual usage: harness must be able to see a large gain (prereg T9: >= 25%)" };
  (out.positions as Record<string, unknown>)[pos] = P;
}
// Holm across the 4 positions for the best retained candidate (or G2 if none retained) vs B1p and vs C2 (one-sided bootstrap p)
const holm = (ps: Array<[string, number]>) => { const s = [...ps].sort((a, b) => a[1] - b[1]); const m = s.length; let run = 0; const adj: Record<string, number> = {}; s.forEach(([k, p], i) => { run = Math.max(run, Math.min(1, (m - i) * p)); adj[k] = run; }); return adj; };
const pB: Array<[string, number]> = [], pC: Array<[string, number]> = [];
for (const pos of POS) { const P = (out.positions as Record<string, { retained_chain: string[]; candidates: Record<string, { vs_B1p: { p_one_sided: number }; vs_C2: { p_one_sided: number } }> }>)[pos]!; const best = P.retained_chain.at(-1) ?? "G2"; pB.push([pos, P.candidates[best]!.vs_B1p.p_one_sided]); pC.push([pos, P.candidates[best]!.vs_C2.p_one_sided]); }
out.holm_adjusted = { vs_B1p: holm(pB), vs_C2: holm(pC), note: "family alpha 0.05, positions reported independently; p = one-sided cluster-bootstrap p for dMAE > 0 of the last retained step (G2 if none)" };
mkdirSync("scripts/w2r1/results", { recursive: true });
const slim = JSON.stringify(out, (k, v) => (k === "pred" || k === "model" ? undefined : typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v), 1);
writeFileSync("scripts/w2r1/results/s5_val.json", slim);
writeFileSync("scripts/w2r1/results/s7_cap_bias_audit.json", JSON.stringify(AUDIT, (k, v) => (typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v), 1));
for (const pos of POS) { const P = (out.positions as Record<string, any>)[pos]; console.log(`\n== ${pos}  fit ${P.n_fit}  val ${P.n_val}  B1p MAE ${P.B1p.mae.toFixed(3)}  C2 MAE ${P.C2_W2P1_Role.mae.toFixed(3)}  mode ${P.chosen_tactical_mode}  retained ${JSON.stringify(P.retained_chain)}`);
  for (const k of ["RL", "G1", "G2", "G2b", "G3", "G4"]) { const c = P.candidates[k]; console.log(`${k.padEnd(4)} λ${String(c.lambda).padEnd(4)} cov ${c.coverage.toFixed(2)} cap ${c.cap_hit_rate.toFixed(3)} MAE ${c.mae.toFixed(3)} | vsB1p ${c.vs_B1p.dMAE >= 0 ? "+" : ""}${c.vs_B1p.dMAE.toFixed(3)} [${c.vs_B1p.lo95.toFixed(3)}] | vsC2 ${c.vs_C2.dMAE >= 0 ? "+" : ""}${c.vs_C2.dMAE.toFixed(3)} [${c.vs_C2.lo95.toFixed(3)}] | late dMAE vsB1p ${c.val_late.dMAE_vs_B1p >= 0 ? "+" : ""}${c.val_late.dMAE_vs_B1p.toFixed(3)} | bias ${c.bias.toFixed(2)}`); }
  console.log(`ladder ${JSON.stringify(Object.fromEntries(Object.entries(P.ladder).map(([k, v]: [string, any]) => [k, `${v.dMAE.toFixed(3)}[${v.lo95.toFixed(3)}]${v.retained ? "*" : ""}`])))}  oracle ${(100 * P.oracle.relative_reduction).toFixed(0)}% below B1p`); }
console.log("\nHolm vs B1p", JSON.stringify(out.holm_adjusted));
