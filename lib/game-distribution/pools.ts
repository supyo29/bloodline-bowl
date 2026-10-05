/** Empirical play-outcome pools (prior season). No parametric assumption: a simulated carry/target/dropback is a resampled REAL play. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Rng } from "./rng";

export interface PoolRaw { n_total: number; yards: number[]; td: number[]; fum: number[]; cmp?: number[]; outcome?: string[]; int?: number[] }
export interface EmpiricalPoolsFile { source: string; prior_season: number; seed: number; pools: Record<string, PoolRaw> }
const DATA = join(process.cwd(), "lib", "game-distribution", "data");
const cache = new Map<number, EmpiricalPoolsFile | null>();
export function loadEmpiricalPools(priorSeason: number): EmpiricalPoolsFile | null {
  if (cache.has(priorSeason)) return cache.get(priorSeason)!;
  const p = join(DATA, `empirical_pools_${priorSeason}.json`);
  const v = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as EmpiricalPoolsFile) : null;
  if (v) for (const k of Object.keys(v.pools)) { const d = v.pools[k]!; for (const f of ["yards", "td", "fum", "cmp", "int", "outcome"] as const) if (d[f] != null && !Array.isArray(d[f])) (d as unknown as Record<string, unknown>)[f] = [d[f]]; } // a length-1 R vector serializes as a scalar
  cache.set(priorSeason, v);
  return v;
}
const idx = (n: number, rng: Rng): number => Math.min(n - 1, Math.floor(rng() * n));

export interface RushDraw { yards: number; td: number; fum: number }
export interface TargetDraw { cmp: number; yards: number; td: number; fum: number }
export interface DropbackDraw { outcome: "pass" | "sack" | "scramble"; cmp: number; yards: number; td: number; int: number; fum: number }

export class PoolSampler {
  constructor(readonly file: EmpiricalPoolsFile) {}
  #pool(key: string): PoolRaw { const p = this.file.pools[key]; if (!p) throw new Error(`empirical pool missing: ${key}`); return p; }
  rush(position: "RB" | "QB", kind: "rush" | "designed" | "scramble", zone: "rz" | "nonrz", rng: Rng): RushDraw {
    const p = this.#pool(`rush|${position}|${kind}|${zone}`); const i = idx(p.yards.length, rng);
    return { yards: p.yards[i]!, td: p.td[i]!, fum: p.fum[i]! };
  }
  target(position: "RB" | "WR" | "TE", zone: "rz" | "nonrz", rng: Rng): TargetDraw {
    const p = this.#pool(`target|${position}|${zone}`); const i = idx(p.yards.length, rng);
    return { cmp: p.cmp![i]!, yards: p.yards[i]!, td: p.td[i]!, fum: p.fum[i]! };
  }
  /** A QB dropback resolves to a pass attempt, a sack, or a SCRAMBLE (a QB run: yards/TD are rushing). Scrambles live here because the role substrate never counts them (they are pass plays attributed to the passer). */
  dropback(zone: "rz" | "nonrz", rng: Rng): DropbackDraw {
    const p = this.#pool(`dropback|${zone}`); const i = idx(p.yards.length, rng); const o = p.outcome![i];
    return { outcome: o === "sack" ? "sack" : o === "scramble" ? "scramble" : "pass", cmp: p.cmp![i]!, yards: p.yards[i]!, td: p.td[i]!, int: p.int![i]!, fum: p.fum[i]! };
  }
}
