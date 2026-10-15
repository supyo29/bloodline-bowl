/**
 * W2.P1 feature-family ablation (NON-BINDING, descriptive). Fit on DEV, scored on VAL only: the FINAL split is never loaded.
 * For each position: Role-free control C0, the full C2, and C2 with one feature family removed. "increment" = MAE(C0) - MAE(model) on VAL (positive = Role information adds value over the Role-free control).
 * Run: node --import tsx scripts/w2p1/ablation.ts
 */
import { FEATURES, ROLE_FREE, b1Of, buildWorld, c2Of, fitRidge, paired, POSITIONS, type Row } from "../lib/role-qualification";

const world = buildWorld(["DEV", "VAL"]);
const dev = world.rows.filter((r) => r.split === "DEV"), val = world.rows.filter((r) => r.split === "VAL" && r.designation !== "OUT");
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const LAMBDA: Record<string, number> = { QB: 1, RB: 10, WR: 100, TE: 10 };
const FAMILIES: Record<string, string[]> = {
  "snap participation": ["snap_share"], "target opportunity": ["exp_targets"], "carry opportunity": ["exp_carries"], "red-zone opportunity": ["exp_rz_targets", "exp_rz_carries"],
  "air-yards depth": ["air_yards_share"], "QB volume (dropbacks/designed/scrambles)": ["exp_dropbacks", "exp_designed_rushes", "exp_scrambles"],
};
for (const pos of POSITIONS) {
  const rows = val.filter((r: Row) => r.position === pos);
  const c0 = fitRidge(dev, pos, "HALF", LAMBDA[pos]!, ROLE_FREE)!;
  const full = fitRidge(dev, pos, "HALF", LAMBDA[pos]!)!;
  const inc = (m: typeof full) => paired(rows, (r) => c2Of(r, c0, "HALF").expected, (r) => c2Of(r, m, "HALF").expected, "HALF", 300);
  const out: Record<string, unknown> = { position: pos, n_val: rows.length, full: { increment_over_C0: r3(inc(full).dMAE), ci95: inc(full).dMAE_ci.map(r3) } };
  for (const [name, drop] of Object.entries(FAMILIES)) {
    const list = FEATURES[pos].filter((f) => !drop.includes(f)); if (list.length === FEATURES[pos].length) continue;
    const m = fitRidge(dev, pos, "HALF", LAMBDA[pos]!, list); if (!m) continue;
    const i = inc(m); out[`without ${name}`] = { increment_over_C0: r3(i.dMAE), ci95: i.dMAE_ci.map(r3), family_contribution: r3(inc(full).dMAE - i.dMAE) };
  }
  console.log(JSON.stringify(out));
}
