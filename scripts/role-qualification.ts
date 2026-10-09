/**
 * W2.P1 Role qualification driver. Stages (see scripts/w2p1/prereg.json):
 *   dev    DEV weeks only: data audit, point-in-time contract, opportunity accuracy, fits (no VAL/FINAL rows are ever loaded)
 *   val    fit on DEV, choose the ridge lambda on VAL, write scripts/w2p1/FROZEN.json
 *   final  load FROZEN.json, evaluate FINAL exactly once, apply the pre-declared thresholds, append to the run log
 * Run: node --import tsx scripts/role-qualification.ts <dev|val|final>
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RIDGE_GRID, SCORINGS, POSITIONS, ROLE_FREE, FEATURES, SPLIT_WEEKS, b1Of, buildWorld, c1Of, c2Of, decisions, errStats, fitRidge, opportunityAccuracy, paired, preregSha, featuresOf, type Row, type RidgeModel, type Scoring,
} from "./lib/role-qualification";
import type { RolePosition } from "../lib/role-calibration/types";

const FROZEN = "scripts/w2p1/FROZEN.json", RUNLOG = "scripts/w2p1/final-run-log.jsonl", OUT = "scripts/w2p1/results";
const sha = (rel: string) => createHash("sha256").update(readFileSync(rel)).digest("hex");
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const headline = (rows: readonly Row[]) => rows.filter((r) => r.designation !== "OUT");

const fitAll = (dev: readonly Row[], lambdas: Record<string, number>): Record<string, RidgeModel | null> => {
  const m: Record<string, RidgeModel | null> = {};
  for (const pos of POSITIONS) for (const s of SCORINGS) { m[`C2|${pos}|${s}`] = fitRidge(dev, pos, s, lambdas[`C2|${pos}`] ?? 100); m[`C0|${pos}|${s}`] = fitRidge(dev, pos, s, lambdas[`C0|${pos}`] ?? 100, ROLE_FREE); }
  return m;
};

function stageDev(): void {
  const w = buildWorld(["DEV"]);
  console.log(JSON.stringify({ stage: "dev", counts: w.counts, pit_violations: w.pointInTimeViolations.length, weeks: SPLIT_WEEKS.DEV }));
  const byPos = Object.fromEntries(POSITIONS.map((p) => [p, { rows: w.rows.filter((r) => r.position === p).length, covered: w.rows.filter((r) => r.position === p && r.covered).length }]));
  console.log("eligible rows by position (DEV)", JSON.stringify(byPos));
  console.log("opportunity accuracy (DEV)", JSON.stringify(opportunityAccuracy(w.rows).map((o) => ({ ...o, role_mae: r3(o.role_mae), last_game_mae: r3(o.last_game_mae), last3_mae: r3(o.last3_mae), season_mae: r3(o.season_mae) }))));
  for (const pos of POSITIONS) for (const lam of RIDGE_GRID) {
    const m = fitRidge(w.rows, pos, "HALF", lam); if (!m) { console.log(pos, lam, "no model"); continue; }
    const rows = headline(w.rows).filter((r) => r.position === pos);
    const c2 = (r: Row) => c2Of(r, m, "HALF").expected;
    const p = paired(rows, (r) => b1Of(r, "HALF"), c2, "HALF", 300);
    console.log(pos, `lambda=${lam}`, `n_fit=${m.n_fit}`, `DEV in-sample dMAE=${r3(p.dMAE)}`, "coef", m.features.map((f, i) => `${f}:${r3(m.coef[i]!)}`).join(" "));
  }
}

function stageVal(): void {
  const w = buildWorld(["DEV", "VAL"]);
  const dev = w.rows.filter((r) => r.split === "DEV"), val = w.rows.filter((r) => r.split === "VAL");
  console.log(JSON.stringify({ stage: "val", counts: w.counts, pit_violations: w.pointInTimeViolations.length, dev: dev.length, val: val.length }));
  const chosen: Record<string, number> = {};
  const grid: Record<string, Record<number, number>> = {};
  for (const cand of ["C2", "C0"] as const) for (const pos of POSITIONS) {
    let best: { lam: number; mae: number } | null = null; grid[`${cand}|${pos}`] = {};
    for (const lam of RIDGE_GRID) {
      const m = cand === "C2" ? fitRidge(dev, pos, "HALF", lam) : fitRidge(dev, pos, "HALF", lam, ROLE_FREE); if (!m) continue;
      const rows = headline(val).filter((r) => r.position === pos);
      const mae = errStats(rows.map((r) => r.actual.HALF - c2Of(r, m, "HALF").expected)).mae; grid[`${cand}|${pos}`]![lam] = r3(mae);
      if (!best || mae <= best.mae + 1e-12) best = { lam, mae }; // ties -> larger lambda (grid ascending)
    }
    chosen[`${cand}|${pos}`] = best?.lam ?? 100;
  }
  const models = fitAll(dev, chosen);
  const valResults: Record<string, unknown> = {};
  for (const pos of POSITIONS) {
    const rows = headline(val).filter((r) => r.position === pos); const m = models[`C2|${pos}|HALF`]; const m0 = models[`C0|${pos}|HALF`];
    const p = paired(rows, (r) => b1Of(r, "HALF"), (r) => c2Of(r, m!, "HALF").expected, "HALF", 1000);
    const p0 = paired(rows, (r) => b1Of(r, "HALF"), (r) => c2Of(r, m0!, "HALF").expected, "HALF", 1000);
    const pi = paired(rows, (r) => c2Of(r, m0!, "HALF").expected, (r) => c2Of(r, m!, "HALF").expected, "HALF", 1000);
    valResults[pos] = { n: p.n, champion_B1p: p.champion, C2: p.challenger, C0: p0.challenger, dMAE_C2_vs_B1p: r3(p.dMAE), dMAE_C2_ci: p.dMAE_ci.map(r3), dMAE_C0_vs_B1p: r3(p0.dMAE), dMAE_C2_vs_C0_role_increment: r3(pi.dMAE), increment_ci: pi.dMAE_ci.map(r3), dRMSE_C2: r3(p.dRMSE), by_week_C2_vs_B1p: p.weeks, lambda_grid_val_mae: { C2: grid[`C2|${pos}`], C0: grid[`C0|${pos}`] } };
    console.log(pos, JSON.stringify(valResults[pos]));
  }
  const frozen = {
    frozen_at_stage: "VAL", prereg_sha256: preregSha(), harness_sha256: sha("scripts/lib/role-qualification.ts"), driver_sha256: sha("scripts/role-qualification.ts"),
    lambda: chosen, models: Object.fromEntries(Object.entries(models).map(([k, m]) => [k, m])), val_results: valResults,
  };
  writeFileSync(join(process.cwd(), FROZEN), JSON.stringify(frozen, null, 1));
  console.log("wrote", FROZEN, "lambda", JSON.stringify(chosen));
}

function stageFinal(): void {
  if (!existsSync(FROZEN)) throw new Error("FROZEN.json missing: run the val stage first");
  const fz = JSON.parse(readFileSync(FROZEN, "utf8")) as { prereg_sha256: string; harness_sha256: string; models: Record<string, RidgeModel | null>; lambda: Record<string, number>; val_results: Record<string, { dMAE_C2_vs_B1p: number }> };
  if (fz.prereg_sha256 !== preregSha()) throw new Error("prereg.json changed after the candidate was frozen: refusing to evaluate FINAL");
  if (fz.harness_sha256 !== sha("scripts/lib/role-qualification.ts")) throw new Error("harness changed after the candidate was frozen: refresh the freeze (val stage) before FINAL");
  if (existsSync(RUNLOG) && readFileSync(RUNLOG, "utf8").trim()) throw new Error("FINAL was already evaluated once; a second look is forbidden by the pre-registration");
  const w = buildWorld(["FINAL"]);
  const fin = w.rows;
  const results: Record<string, unknown> = { stage: "final", pit_violations: w.pointInTimeViolations.length, counts: w.counts };
  const gates: Record<string, Record<string, unknown>> = {};
  for (const pos of POSITIONS) {
    const m = (s: Scoring) => fz.models[`C2|${pos}|${s}`] ?? null; const m0 = (s: Scoring) => fz.models[`C0|${pos}|${s}`] ?? null;
    const eligible = headline(fin).filter((r) => r.position === pos), covered = eligible.filter((r) => r.covered);
    const c2 = (s: Scoring) => (r: Row) => c2Of(r, m(s), s).expected; const c0 = (s: Scoring) => (r: Row) => c2Of(r, m0(s), s).expected;
    const p = paired(eligible, (r) => b1Of(r, "HALF"), c2("HALF"), "HALF", 2000);
    const dec = decisions(eligible, (r) => b1Of(r, "HALF"), c2("HALF"), "HALF");
    const tiers = Object.fromEntries((["STARTER", "FLEX", "FRINGE"] as const).map((t) => { const rows = eligible.filter((r) => r.tier === t); return [t, { n: rows.length, dMAE: rows.length ? r3(paired(rows, (r) => b1Of(r, "HALF"), c2("HALF"), "HALF", 50).dMAE) : null }]; }));
    const qd = eligible.filter((r) => r.designation === "QUESTIONABLE" || r.designation === "DOUBTFUL");
    const qdD = qd.length ? paired(qd, (r) => b1Of(r, "HALF"), c2("HALF"), "HALF", 50).dMAE : 0;
    const out = fin.filter((r) => r.position === pos && r.designation === "OUT");
    const outNonZero = out.filter((r) => c2Of(r, m("HALF"), "HALF").delta !== 0).length;
    const capHit = covered.length ? covered.filter((r) => c2Of(r, m("HALF"), "HALF").capped).length / covered.length : 0;
    const robust = (["STD", "PPR"] as const).flatMap((s) => [paired(eligible, (r) => b1Of(r, s), c2(s), s, 50).dMAE, paired(eligible, c0(s), c2(s), s, 50).dMAE]);
    const inc = paired(eligible, c0("HALF"), c2("HALF"), "HALF", 2000);
    const c0vsB1 = paired(eligible, (r) => b1Of(r, "HALF"), c0("HALF"), "HALF", 500);
    // controls (T9): oracle features (target-game actual opportunity) and a within-week permutation of the real features
    const mH = m("HALF");
    const oracle = paired(eligible, (r) => b1Of(r, "HALF"), (r) => c2Of(r, mH, "HALF", "oracle").expected, "HALF", 50).dMAE;
    const byWeek = new Map<number, Row[]>(); for (const r of eligible) (byWeek.get(r.week) ?? byWeek.set(r.week, []).get(r.week)!).push(r);
    const perm = new Map<Row, number[]>(); let seed = 7;
    for (const rs of byWeek.values()) { const feats = rs.map((r) => featuresOf(r, FEATURES[pos], "HALF")); const idx = rs.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; const j = seed % (i + 1); [idx[i], idx[j]] = [idx[j]!, idx[i]!]; } rs.forEach((r, i) => { const f = feats[idx[i]!]; if (f) perm.set(r, f); }); }
    const permD = paired(eligible, (r) => b1Of(r, "HALF"), (r) => c2Of(r, mH, "HALF", "x", perm.get(r) ?? null).expected, "HALF", 50).dMAE;
    const c1 = eligible.map((r) => c1Of(r, "HALF")); const c1Rows = eligible.filter((_, i) => c1[i] != null); const c1Map = new Map(eligible.map((r, i) => [r, c1[i]]));
    const c1P = c1Rows.length ? paired(c1Rows, (r) => b1Of(r, "HALF"), (r) => c1Map.get(r)!, "HALF", 500) : null;
    const wk = Object.values(p.weeks);
    const T = {
      T1: covered.length / Math.max(1, eligible.length) >= 0.7 && covered.length >= (pos === "QB" ? 120 : 300),
      T2: p.dMAE >= 0.05 && p.dMAE_ci[0] > 0,
      T2b: inc.dMAE >= 0.03 && inc.dMAE_ci[0] > 0,
      T3: p.challenger.rmse <= p.champion.rmse + 0.02,
      T4: Math.abs(p.challenger.bias) <= 0.5 && Math.abs(p.challenger.bias) <= Math.abs(p.champion.bias) + 0.15,
      T5: wk.filter((d) => d > 0).length >= 3 && (fz.val_results[pos]?.dMAE_C2_vs_B1p ?? -1) > 0,
      T6: dec.decided >= 100 && dec.challenger_wins >= dec.champion_wins && dec.p_one_sided < 0.1,
      T7: Object.values(tiers).every((t) => !(t.n >= 100 && t.dMAE != null && t.dMAE < -0.1)),
      T8: qdD >= -0.05 && outNonZero === 0 && capHit <= 0.1,
      T9: w.pointInTimeViolations.length === 0 && oracle > p.dMAE + 0.3 && permD <= 0.02,
      T10: robust.every((d) => d > 0),
    };
    gates[pos] = { n_eligible: eligible.length, n_covered: covered.length, coverage: r3(covered.length / Math.max(1, eligible.length)), champion: p.champion, challenger: p.challenger, dMAE: r3(p.dMAE), dMAE_ci95: p.dMAE_ci.map(r3), C0_role_free_vs_B1p_dMAE: r3(c0vsB1.dMAE), role_increment_C2_vs_C0: { dMAE: r3(inc.dMAE), ci95: inc.dMAE_ci.map(r3), dRMSE: r3(inc.dRMSE) }, dRMSE: r3(p.dRMSE), by_week_dMAE: Object.fromEntries(Object.entries(p.weeks).map(([k, v]) => [k, r3(v)])), decisions: dec, tiers, questionable_doubtful_dMAE: r3(qdD), out_rows: out.length, out_nonzero_delta: outNonZero, cap_hit_rate: r3(capHit), robustness_dMAE_STD_vsB1p_STD_vsC0_PPR_vsB1p_PPR_vsC0: robust.map(r3), controls: { oracle_dMAE: r3(oracle), permutation_dMAE: r3(permD) }, C1_existing_shadow_vs_B1p: c1P ? { n: c1P.n, dMAE: r3(c1P.dMAE), dRMSE: r3(c1P.dRMSE), dMAE_ci95: c1P.dMAE_ci.map(r3) } : null, thresholds: T, promotion_candidate: Object.values(T).every(Boolean) };
  }
  const g1 = opportunityAccuracy(fin).map((o) => ({ ...o, role_mae: r3(o.role_mae), last_game_mae: r3(o.last_game_mae), last3_mae: r3(o.last3_mae), season_mae: r3(o.season_mae), pass: o.n >= (o.position === "QB" ? 60 : 200) && o.role_mae < o.last_game_mae * 0.97 && o.role_mae <= o.season_mae * 1.02 && o.role_mae <= o.last3_mae * 1.02 }));
  results.G1_opportunity = g1; results.G2_positions = gates;
  const cands = Object.entries(gates).filter(([, v]) => v.promotion_candidate).map(([k]) => k);
  results.verdict = cands.length ? `OFFLINE CERTIFIED — PROMOTION CANDIDATE (${cands.join(", ")}), LIVE/STAGING GATE PENDING` : "SHADOW_ONLY";
  mkdirSync(join(process.cwd(), OUT), { recursive: true });
  writeFileSync(join(process.cwd(), OUT, "final.json"), JSON.stringify(results, null, 1));
  appendFileSync(join(process.cwd(), RUNLOG), JSON.stringify({ at: new Date().toISOString(), prereg_sha256: preregSha(), harness_sha256: sha("scripts/lib/role-qualification.ts"), verdict: results.verdict }) + "\n");
  console.log(JSON.stringify(results, null, 1));
}

const stage = process.argv[2];
if (stage === "dev") stageDev(); else if (stage === "val") stageVal(); else if (stage === "final") stageFinal(); else { console.error("usage: role-qualification <dev|val|final>"); process.exit(2); }
