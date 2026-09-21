export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const sd = (xs: number[]): number | null => { if (xs.length < 3) return null; const m = mean(xs)!; const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1); return Math.sqrt(v); };
export const round = (x: number | null, d = 4): number | null => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
/** z of `x` among `all` (all defenses' values for THE SAME player); null when the spread is degenerate or too few defenses. */
export function zAmong(x: number | null, all: number[]): number | null { if (x == null) return null; const s = sd(all); const m = mean(all); return s == null || s < 1e-9 || m == null ? null : (x - m) / s; }
/** rank among defenses, 1 = highest value (most favourable to the offense when value is oriented offense-positive). */
export function rankDesc(x: number | null, all: number[]): number | null { if (x == null || !all.length) return null; return 1 + all.filter((v) => v > x).length; }
import type { EvidenceTier } from "./contract";
const ORDER: EvidenceTier[] = ["INSUFFICIENT", "WEAK", "MODERATE", "STRONG"];
export const minTier = (...t: EvidenceTier[]): EvidenceTier => (t.length ? t.reduce((a, b) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b)) : "INSUFFICIENT");
export const tierAtLeast = (t: EvidenceTier, floor: EvidenceTier): boolean => ORDER.indexOf(t) >= ORDER.indexOf(floor);

/** Team-code aliases now live in the ONE canonical normalizer (Phase 7); behavior is byte-identical to the previous local table. */
export { normalizeTeamCode as normalizeTeam } from "@/lib/canonical/team-codes";
