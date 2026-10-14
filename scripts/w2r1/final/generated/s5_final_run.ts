/**
 * W2.R1 S5 ladder (FIT 2022-2024 -> VAL 2025 wk 3-17). Reads scripts/w2r1/cache/s5_rows.csv (built by s5_build.R: Tier-A as-of features; Tier-B only as prior-season carryover).
 * NEVER reads 2026. Writes scripts/w2r1/results/s5_val.json. Availability is applied exactly once: expected = evaluateInjuryModel(B0p + delta).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { evaluateInjuryModel } from "@/lib/weekly/forecast/injury-model";
import { confidenceWeight } from "@/lib/w2r1/gameplan";

type Row = Record<string, number | string | null>;
const lines = readFileSync("scripts/w2r1/cache/s5_rows_final.csv", "utf8").split("\n").filter(Boolean);
const head = lines[0]!.replace(/"/g, "").split(",");
const rows: Row[] = lines.slice(1).map((l) => { const c = l.split(","); const o: Row = {}; head.forEach((h, i) => { const v = (c[i] ?? "").replace(/"/g, ""); o[h] = v === "" || v === "NA" ? null : isNaN(Number(v)) ? v : Number(v); }); return o; });
if (rows.some((r) => (r.split === "FINAL") !== ((r.season as number) === 2026))) throw new Error("split / season inconsistency");
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
for (const r of rows) { r.b0f = (r.split === "FINAL" ? num(r, "p1_b0") : num(r, "b0")) ?? null; for (const m of MODES) enrich(r, m); }
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
  if (!m || r.desig === "OUT" || r.p1_covered !== 1 && r.split === "FINAL") return neutral;
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

/* ================= S7 FINAL section (new; written after the freeze, before any 2026 S5 score) ================= */
const FZ = JSON.parse(readFileSync("scripts/w2r1/FROZEN.json", "utf8")) as { candidates: Array<{ id: string; position?: string; step?: string; tactical_mode?: string; lambda?: number }> };
const VALR = JSON.parse(readFileSync("scripts/w2r1/results/s5_val.json", "utf8")) as { positions: Record<string, { candidates: Record<string, { vs_B1p: { dMAE: number }; cap_hit_rate: number }>; retained_chain: string[] }> };
const LEAK = JSON.parse(readFileSync("scripts/w2r1/results/final/s5_leak_final.json", "utf8")) as { player_asof_poison: { passed: number; total: number }; team_asof_poison: { passed: number; total: number } };
const fitRows = (pos: Pos) => rows.filter((r) => r.split === "FIT" && r.position === pos && r.desig !== "OUT" && num(r, "b0f") != null && (num(r, "b0f") as number) >= 3);
const finAll = (pos: Pos) => rows.filter((r) => r.split === "FINAL" && r.position === pos && r.p1_covered === 1 && r.desig !== "OUT" && (num(r, "b0f") as number) >= 3);
function binomUpper(k: number, n: number): number { if (n === 0) return 1; const lf = (x: number) => { let t = 0; for (let i = 2; i <= x; i++) t += Math.log(i); return t; }; let p = 0; for (let i = k; i <= n; i++) p += Math.exp(lf(n) - lf(i) - lf(n - i) - n * Math.LN2); return Math.min(1, p); }
const holm = (ps: Array<[string, number]>) => { const s = [...ps].sort((a, b) => a[1] - b[1]); const m = s.length; let run = 0; const adj: Record<string, number> = {}; s.forEach(([k, p], i) => { run = Math.max(run, Math.min(1, (m - i) * p)); adj[k] = run; }); return adj; };
const tierOf = (b0: number) => (b0 >= 12 ? "STARTER" : b0 >= 6 ? "FLEX" : "FRINGE");
const FIN: Record<string, unknown> = { spec: "w2r1-s7-final-s5", frozen_sha256_checked_by: "scripts/w2r1/s7_verify_frozen.ts (run before this script)", candidates: {} };
const PRED: Record<string, Record<string, number[]>> = {}; const PAIRS: Record<string, Row[]> = {};
for (const pos of POS) {
  const fit = fitRows(pos), fin = finAll(pos); PAIRS[pos] = fin; PRED[pos] = {};
  const B1 = fin.map((r) => inj(r, num(r, "b0f") as number)); const C2 = fin.map((r) => num(r, "p1_c2") as number); const act = fin.map((r) => r.actual as number);
  const st = (pred: number[], idx?: number[]) => { const ii = idx ?? fin.map((_, i) => i); const e = ii.map((i) => act[i]! - pred[i]!); return { n: ii.length, mae: mae(e), rmse: rmse(e), bias: bias(e) }; };
  const wk = [1, 2, 3, 4, 5];
  const oracleList = pos === "QB" ? ["o_dropbacks", "rl_snap", "b0f"] : pos === "RB" ? ["o_carries", "o_targets", "rl_snap", "b0f"] : ["o_targets", "rl_snap", "b0f"];
  const om = fitRidge(fit.filter((r) => num(r, "o_targets") != null), oracleList, 10);
  const op = fin.map((r) => { const z = om ? raw(om, r) : null; const b0 = num(r, "b0f") as number; return z == null || r.desig === "OUT" ? inj(r, b0) : inj(r, b0 + Math.max(-Math.max(1, .25 * b0) * 4, Math.min(Math.max(1, .25 * b0) * 4, z))); });
  const b1 = st(B1), c2s = st(C2), orc = st(op);
  (FIN.candidates as Record<string, unknown>)[`${pos}.B1p`] = { ...b1, role: "champion" }; (FIN.candidates as Record<string, unknown>)[`${pos}.B2p_C2`] = { ...c2s, role: "W2.P1 Role comparator (frozen)" }; (FIN.candidates as Record<string, unknown>)[`${pos}.ORACLE`] = { ...orc, role: "T9 harness-sensitivity control", relative_reduction_vs_B1p: 1 - orc.mae / b1.mae };
  for (const step of ["RL", "G1", "G2"]) {
    const fc = FZ.candidates.find((c) => c.id === `S5.${pos}.${step}`)!; const mode = (fc.tactical_mode ?? "CUR") as Mode; const lam = fc.lambda as number; const uses: "player" | "team" = step === "G2" ? "team" : "player";
    const m = fitRidge(fit, features(pos, step, mode), lam); const ps = fin.map((r) => predict(m, r, mode, uses)); const pred = ps.map((p) => p.expected); PRED[pos]![step] = pred;
    const app = ps.filter((p) => p.applicable); const cs = st(pred); const capHit = app.length ? app.filter((p) => p.capped).length / app.length : 0;
    const vsB1 = boot(fin, B1, pred), vsC2 = boot(fin, C2, pred);
    const wkB = Object.fromEntries(wk.map((w) => { const ii = fin.map((r, i) => (r.week === w ? i : -1)).filter((i) => i >= 0); const mm = (p: number[]) => mae(ii.map((i) => act[i]! - p[i]!)); return [w, ii.length ? { n: ii.length, dMAE_vs_B1p: mm(B1) - mm(pred), dMAE_vs_C2: mm(C2) - mm(pred) } : null]; }));
    const blk = (pred1: number[], pred0: number[], ii: number[]) => (ii.length ? mae(ii.map((i) => act[i]! - pred0[i]!)) - mae(ii.map((i) => act[i]! - pred1[i]!)) : null);
    const early = fin.map((r, i) => ((r.week as number) <= 2 ? i : -1)).filter((i) => i >= 0), late = fin.map((r, i) => ((r.week as number) >= 3 ? i : -1)).filter((i) => i >= 0);
    // T6 decisions vs the champion: same team / position / week pairs
    const grp = new Map<string, number[]>(); fin.forEach((r, i) => { const k = `${r.team}|${r.week}`; (grp.get(k) ?? grp.set(k, []).get(k)!).push(i); });
    let dis = 0, dec = 0, cw = 0, amb = 0; for (const g of grp.values()) for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) { const a = g[x]!, b = g[y]!; const ch = B1[a]! - B1[b]!, cn = pred[a]! - pred[b]!; if (ch === 0 || cn === 0 || Math.sign(ch) === Math.sign(cn)) continue; dis++; const d = act[a]! - act[b]!; if (Math.abs(d) < 1) { amb++; continue; } dec++; if (Math.sign(d) === Math.sign(cn)) cw++; }
    const t6p = binomUpper(cw, dec);
    const tiers = Object.fromEntries(["STARTER", "FLEX", "FRINGE"].map((t) => { const ii = fin.map((r, i) => (tierOf(num(r, "b0f") as number) === t ? i : -1)).filter((i) => i >= 0); return [t, { n: ii.length, dMAE_vs_B1p: blk(pred, B1, ii) }]; }));
    const qd = fin.map((r, i) => (r.desig === "QUESTIONABLE" || r.desig === "DOUBTFUL" ? i : -1)).filter((i) => i >= 0); const qdD = blk(pred, B1, qd);
    const valD = VALR.positions[pos]!.candidates[step === "G2" ? "G2" : step]!.vs_B1p.dMAE;
    const weeksPos = wk.filter((w) => { const x = wkB[w] as { dMAE_vs_B1p: number } | null; return x != null && x.dMAE_vs_B1p > 0; }).length;
    const gates: Record<string, string> = {
      T1: ps.length && app.length / fin.length >= 0.7 && app.length >= (pos === "QB" ? 100 : 250) ? "PASS" : "INSUFFICIENT_FINAL_SAMPLE",
      T2: b1.mae - cs.mae >= 0.05 && vsB1.lo > 0 ? "PASS" : "FAIL", T2b: c2s.mae - cs.mae >= 0.03 && vsC2.lo > 0 ? "PASS" : "FAIL",
      T3: cs.rmse <= b1.rmse + 0.02 ? "PASS" : "FAIL", T4: Math.abs(cs.bias) <= 0.5 && Math.abs(cs.bias) <= Math.abs(b1.bias) + 0.15 ? "PASS" : "FAIL",
      T5: weeksPos >= 3 && valD > 0 ? "PASS" : "FAIL", T6: dec < 100 ? "INSUFFICIENT" : cw >= dec - cw && t6p < 0.10 ? "PASS" : "FAIL",
      T7: Object.values(tiers).some((t) => t.n >= 100 && t.dMAE_vs_B1p != null && t.dMAE_vs_B1p < -0.10) ? "FAIL" : "PASS",
      T8: capHit <= 0.10 && (qdD == null || qdD >= -0.05) ? "PASS" : "FAIL",
      T9: LEAK.player_asof_poison.passed === LEAK.player_asof_poison.total && LEAK.team_asof_poison.passed === LEAK.team_asof_poison.total && (b1.mae - orc.mae) >= 0.25 * b1.mae && orc.mae <= cs.mae - 0.25 * b1.mae ? "PASS" : "FAIL",
      T10: "NOT_EVALUABLE (frozen S5 candidates are HALF-only; no STD/PPR fit) - blocks SHADOW_QUALIFIED",
    };
    // OUT rows contribute exactly 0 (neutral path): verify on all OUT designations in the world for the position
    const outRows = rows.filter((r) => r.split === "FINAL" && r.position === pos && r.desig === "OUT"); const outZero = outRows.every((r) => predict(m, r, mode, uses).expected === inj(r, num(r, "b0f") as number));
    const verdict = gates.T1 === "INSUFFICIENT_FINAL_SAMPLE" ? "INSUFFICIENT_FINAL_SAMPLE" : Object.values(gates).every((g) => g === "PASS") ? "ALL_PASS" : "GATE_FAILURE";
    (FIN.candidates as Record<string, unknown>)[fc.id] = { id: fc.id, position: pos, step, tactical_mode: mode, lambda: lam, frozen_ceiling: "DIAGNOSTIC_ONLY", n_rows: fin.length, n_applicable: app.length, coverage: app.length / fin.length, cap_hit_rate: capHit, val_cap_hit_rate: VALR.positions[pos]!.candidates[step]!.cap_hit_rate,
      ...cs, vs_B1p: { dMAE: b1.mae - cs.mae, lo95: vsB1.lo, hi95: vsB1.hi, p_one_sided: vsB1.p, dRMSE: b1.rmse - cs.rmse }, vs_C2: { dMAE: c2s.mae - cs.mae, lo95: vsC2.lo, hi95: vsC2.hi, p_one_sided: vsC2.p },
      by_week: wkB, weeks_1_2_dMAE_vs_B1p: blk(pred, B1, early), weeks_3_5_dMAE_vs_B1p: blk(pred, B1, late), tiers, questionable_doubtful_dMAE_vs_B1p: qdD, n_questionable_doubtful: qd.length, out_rows_contribution_exactly_zero: outZero, n_out_rows: outRows.length,
      decisions: { disagreements: dis, decided: dec, challenger_wins: cw, champion_wins: dec - cw, ambiguous: amb, p_one_sided: t6p }, val_dMAE_vs_B1p: valD, gates, gate_verdict: verdict, final_status: verdict === "INSUFFICIENT_FINAL_SAMPLE" ? "INSUFFICIENT_FINAL_SAMPLE" : "DIAGNOSTIC_ONLY (cap gate T8 failed; report-only candidate)" };
  }
  // does the tactical layer (G2) add over its predecessor on FINAL?
  const prev = PRED[pos]!["G1"]!; const g2 = PRED[pos]!["G2"]!; const bs = boot(fin, prev, g2); const mm = (p: number[]) => mae(act.map((a, i) => a - p[i]!));
  (FIN.candidates as Record<string, unknown>)[`${pos}.G2_vs_G1`] = { dMAE: mm(prev) - mm(g2), lo95: bs.lo, hi95: bs.hi, p_one_sided: bs.p };
  const rl = PRED[pos]!["RL"]!; const b2 = boot(fin, rl, g2); (FIN.candidates as Record<string, unknown>)[`${pos}.G2_vs_RL`] = { dMAE: mm(rl) - mm(g2), lo95: b2.lo, hi95: b2.hi, p_one_sided: b2.p };
}
// Holm across the 4 positions (family alpha 0.05) for the last VAL-retained layer and for G2, vs B1p and vs C2
const cand = FIN.candidates as Record<string, { vs_B1p: { p_one_sided: number }; vs_C2: { p_one_sided: number } }>;
const hol: Record<string, unknown> = {};
for (const [label, pick] of [["last_VAL_retained", (pos: Pos) => { const ch = VALR.positions[pos]!.retained_chain; return ch.at(-1) ?? "G2"; }], ["G2", () => "G2"]] as const) {
  hol[label] = { vs_B1p: holm(POS.map((p) => [p, cand[`S5.${p}.${pick(p)}`]!.vs_B1p.p_one_sided] as [string, number])), vs_C2: holm(POS.map((p) => [p, cand[`S5.${p}.${pick(p)}`]!.vs_C2.p_one_sided] as [string, number])), steps: Object.fromEntries(POS.map((p) => [p, pick(p)])) };
}
FIN.holm_adjusted = hol;
mkdirSync("scripts/w2r1/results/final", { recursive: true });
writeFileSync("scripts/w2r1/results/final/s5_final.json", JSON.stringify(FIN, (k, v) => (typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v), 1));
for (const [id, c] of Object.entries(FIN.candidates as Record<string, any>)) if (id.startsWith("S5.")) console.log(`${id.padEnd(8)} n=${c.n_rows} cov ${c.coverage.toFixed(2)} cap ${c.cap_hit_rate.toFixed(3)} MAE ${c.mae.toFixed(3)} RMSE ${c.rmse.toFixed(3)} bias ${c.bias.toFixed(3)} | vsB1p ${c.vs_B1p.dMAE.toFixed(3)} [${c.vs_B1p.lo95.toFixed(3)},${c.vs_B1p.hi95.toFixed(3)}] vsC2 ${c.vs_C2.dMAE.toFixed(3)} [${c.vs_C2.lo95.toFixed(3)}] | ${c.gate_verdict} | ${Object.entries(c.gates).map(([k, v]) => `${k}:${String(v).slice(0, 4)}`).join(" ")}`);
console.log("Holm", JSON.stringify(hol));
