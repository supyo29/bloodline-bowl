/** Deterministic randomness: every simulation is reproducible from (model version, season, week, game id). No Math.random anywhere in this module. */
import { createHash } from "node:crypto";
export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const seedFrom = (...parts: Array<string | number>): number => createHash("sha256").update(parts.join("|")).digest().readUInt32BE(0);
export function makeNormal(rng: Rng): () => number {
  let spare: number | null = null;
  return () => { if (spare != null) { const s = spare; spare = null; return s; } let u = 0, v = 0; while (u === 0) u = rng(); v = rng(); const r = Math.sqrt(-2 * Math.log(u)); spare = r * Math.sin(2 * Math.PI * v); return r * Math.cos(2 * Math.PI * v); };
}
/** Mean-preserving log-normal multiplier: E[exp(sigma z - sigma^2/2)] = 1. */
export const lognormalMultiplier = (sigma: number, z: number): number => (sigma > 0 ? Math.exp(sigma * z - (sigma * sigma) / 2) : 1);
/** Stochastic rounding: floor(x) + Bernoulli(frac) — preserves the mean of a non-integer expected count. */
export const stochasticRound = (x: number, rng: Rng): number => { if (!(x > 0)) return 0; const f = Math.floor(x); return f + (rng() < x - f ? 1 : 0); };
export const pick = <T>(arr: readonly T[], rng: Rng): T => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))]!;

/**
 * Integer allocation of `total` opportunities across players with shares summing to <= 1: each player gets floor(share*total), then the expected
 * remainder is handed out by lottery proportional to the fractional parts. GUARANTEES sum(counts) <= total and counts[i] <= total (a player can never
 * hold more targets/carries than the team had), while preserving each player's expected count.
 */
export function allocateCounts(shares: readonly number[], total: number, rng: Rng): number[] {
  const T = Math.max(0, Math.floor(total)); const raw = shares.map((s) => Math.max(0, s) * T); const base = raw.map(Math.floor);
  const frac = raw.map((r, i) => r - base[i]!); const room = T - base.reduce((a, b) => a + b, 0);
  let units = Math.min(room, stochasticRound(frac.reduce((a, b) => a + b, 0), rng)); const out = [...base]; const f = [...frac];
  while (units > 0) { const tot = f.reduce((a, b) => a + b, 0); if (!(tot > 0)) break; let u = rng() * tot, k = 0; for (; k < f.length - 1; k++) { u -= f[k]!; if (u <= 0) break; } out[k]!++; f[k] = 0; units--; }
  return out;
}
