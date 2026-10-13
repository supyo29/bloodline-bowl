/**
 * W2.P2 — statistics for the real-source G3 evaluation. Definitions and the PRNG seed are the frozen W2.P1 harness's
 * (`scripts/lib/role-qualification.ts`: errStats / paired / decisions / binomUpper); a parity test pins numeric equality against it.
 * Pure, deterministic: the same rows always give the same CI.
 */

export interface ErrStats { n: number; mae: number; rmse: number; bias: number }
export function errStats(errs: readonly number[]): ErrStats {
  const n = errs.length;
  if (!n) return { n: 0, mae: NaN, rmse: NaN, bias: NaN };
  return { n, mae: errs.reduce((s, e) => s + Math.abs(e), 0) / n, rmse: Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / n), bias: errs.reduce((s, e) => s + e, 0) / n };
}

/** deterministic PRNG so a reported CI is reproducible */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
export const BOOTSTRAP_SEED = 20250914;

export interface PairedRow { team: string; week: number; actual: number }
export interface Paired { n: number; first: ErrStats; second: ErrStats; dMAE: number; dRMSE: number; dMAE_ci: [number, number]; weeks: Record<number, number> }

/**
 * Paired comparison with a cluster bootstrap over team-weeks (players of one game share game script).
 * `dMAE = MAE(first) - MAE(second)`: positive means the SECOND is better.
 */
export function paired<R extends PairedRow>(rows: readonly R[], first: (r: R) => number, second: (r: R) => number, reps = 2000): Paired {
  const e1 = rows.map((r) => r.actual - first(r));
  const e2 = rows.map((r) => r.actual - second(r));
  const s1 = errStats(e1);
  const s2 = errStats(e2);
  const clusters = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = `${r.team}|${r.week}`;
    const c = clusters.get(k);
    if (c) c.push(i); else clusters.set(k, [i]);
  });
  const keys = [...clusters.keys()];
  const rnd = lcg(BOOTSTRAP_SEED);
  const abs = (a: number[], idx: number[]) => idx.reduce((s, i) => s + Math.abs(a[i]!), 0);
  const per = keys.map((k) => ({ n: clusters.get(k)!.length, d: abs(e1, clusters.get(k)!) - abs(e2, clusters.get(k)!) }));
  const diffs: number[] = [];
  for (let b = 0; b < reps && keys.length; b++) {
    let n = 0;
    let d = 0;
    for (let t = 0; t < keys.length; t++) {
      const c = per[Math.floor(rnd() * keys.length)]!;
      n += c.n;
      d += c.d;
    }
    diffs.push(n ? d / n : 0);
  }
  diffs.sort((a, b) => a - b);
  const weeks: Record<number, number> = {};
  for (const w of [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b)) {
    const idx = rows.map((r, i) => (r.week === w ? i : -1)).filter((i) => i >= 0);
    weeks[w] = (abs(e1, idx) - abs(e2, idx)) / idx.length;
  }
  return { n: rows.length, first: s1, second: s2, dMAE: s1.mae - s2.mae, dRMSE: s1.rmse - s2.rmse, dMAE_ci: [diffs[Math.floor(0.025 * diffs.length)] ?? NaN, diffs[Math.floor(0.975 * diffs.length)] ?? NaN], weeks };
}

/** P(X >= k) for X ~ Bin(n, 0.5) */
export function binomUpper(k: number, n: number): number {
  if (n === 0) return 1;
  const lf = (x: number) => { let s = 0; for (let i = 2; i <= x; i++) s += Math.log(i); return s; };
  let p = 0;
  for (let i = k; i <= n; i++) p += Math.exp(lf(n) - lf(i) - lf(n - i) - n * Math.LN2);
  return Math.min(1, p);
}

export interface DecisionStats { pairs: number; disagreements: number; decided: number; second_wins: number; first_wins: number; ambiguous: number; p_one_sided: number }
export interface DecisionRow extends PairedRow { position: string }
/** Start/sit-style pairs: same team, position and week; the better-ranked player is "started". "decided" = |actual difference| >= 1 point. */
export function decisions<R extends DecisionRow>(rows: readonly R[], first: (r: R) => number, second: (r: R) => number): DecisionStats {
  const g = new Map<string, R[]>();
  for (const r of rows) {
    const k = `${r.team}|${r.week}|${r.position}`;
    const c = g.get(k);
    if (c) c.push(r); else g.set(k, [r]);
  }
  let pairs = 0, dis = 0, decided = 0, sw = 0, fw = 0, amb = 0;
  for (const grp of g.values()) {
    for (let i = 0; i < grp.length; i++) {
      for (let j = i + 1; j < grp.length; j++) {
        const a = grp[i]!, b = grp[j]!;
        pairs++;
        const d1 = first(a) - first(b);
        const d2 = second(a) - second(b);
        if (Math.sign(d1) === Math.sign(d2) || d1 === 0 || d2 === 0) continue;
        dis++;
        const act = a.actual - b.actual;
        if (Math.abs(act) < 1) { amb++; continue; }
        decided++;
        if (Math.sign(act) === Math.sign(d2)) sw++; else fw++;
      }
    }
  }
  return { pairs, disagreements: dis, decided, second_wins: sw, first_wins: fw, ambiguous: amb, p_one_sided: binomUpper(sw, decided) };
}
