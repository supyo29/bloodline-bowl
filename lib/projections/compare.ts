/**
 * Roster Intel vs Sleeper — disagreement, made visible.
 *
 * Sleeper is a BENCHMARK, never a model input (see `sleeper.ts`). This module
 * quantifies where and WHY RI_STANDALONE differs from Sleeper's RotoWire-sourced
 * projection, by comparing the underlying football stats (targets, carries,
 * yards, TDs) rather than only the fantasy-point totals. The `primary_driver`
 * is chosen by deterministic rules — no ML, no tuning.
 *
 * "Closer to Sleeper" is explicitly NOT treated as "better". Divergence is a
 * signal surfaced to the draft engine, not a correction applied to RI.
 */

import type { SleeperNormalizedProjection } from "./sleeper";
import type { PlayerProjection } from "./schema";

export interface StatComparison {
  stat: string;
  ri: number | null;
  sleeper: number | null;
  delta: number | null;
  delta_pct: number | null;
}

export interface PlayerComparison {
  player_id: string;
  full_name: string;
  position: string;
  team: string | null;
  has_benchmark: boolean;

  ri_neutral_points: number;
  sleeper_ppr_points: number | null;
  neutral_delta: number | null;
  neutral_delta_pct: number | null;

  stat_deltas: StatComparison[];
  primary_driver: string;
  direction: "RI_ABOVE" | "RI_BELOW" | "AGREES" | "NO_BENCHMARK";
  /** 0..1 normalized disagreement magnitude, for confidence adjustment. */
  disagreement: number;
}

const AGREE_PCT = 8; // within 8% of Sleeper PPR = "agrees"

function cmp(stat: string, ri: number | null, sl: number | null): StatComparison {
  const delta = ri != null && sl != null ? round2(ri - sl) : null;
  const delta_pct = delta != null && sl ? round1((delta / sl) * 100) : null;
  return { stat, ri, sleeper: sl, delta, delta_pct };
}

export function comparePlayer(
  proj: PlayerProjection,
  bench: SleeperNormalizedProjection | undefined,
): PlayerComparison {
  const s = proj.stats;
  if (!bench) {
    return {
      player_id: proj.player_id,
      full_name: proj.full_name,
      position: proj.position,
      team: proj.team,
      has_benchmark: false,
      ri_neutral_points: proj.neutral_points,
      sleeper_ppr_points: null,
      neutral_delta: null,
      neutral_delta_pct: null,
      stat_deltas: [],
      primary_driver: "no Sleeper benchmark for this player",
      direction: "NO_BENCHMARK",
      disagreement: 0,
    };
  }

  const b = bench.stats;
  const deltas: StatComparison[] = [
    cmp("pass_att", s.pass_att, b.pass_att),
    cmp("pass_yd", s.pass_yd, b.pass_yd),
    cmp("pass_td", s.pass_td, b.pass_td),
    cmp("rush_att", s.rush_att, b.rush_att),
    cmp("rush_yd", s.rush_yd, b.rush_yd),
    cmp("rush_td", s.rush_td, b.rush_td),
    cmp("targets", s.targets, b.targets),
    cmp("rec", s.rec, b.rec),
    cmp("rec_yd", s.rec_yd, b.rec_yd),
    cmp("rec_td", s.rec_td, b.rec_td),
  ].filter((d) => d.ri != null || d.sleeper != null);

  const slPpr = bench.sleeper_points.ppr;
  // Compare on the same basis: RI full-pace (17g) points vs Sleeper's ~17g
  // points. proj.neutral_ppg is full-health per game; proj.neutral_points is the
  // availability-discounted season total.
  const riFullPace = round2(proj.neutral_ppg * 17);
  const neutralDelta = slPpr != null ? round2(riFullPace - slPpr) : null;
  const neutralDeltaPct = neutralDelta != null && slPpr ? round1((neutralDelta / slPpr) * 100) : null;

  const { driver, disagreement } = pickPrimaryDriver(proj.position, deltas, neutralDeltaPct);

  let direction: PlayerComparison["direction"] = "AGREES";
  if (neutralDeltaPct != null) {
    if (neutralDeltaPct > AGREE_PCT) direction = "RI_ABOVE";
    else if (neutralDeltaPct < -AGREE_PCT) direction = "RI_BELOW";
  }

  return {
    player_id: proj.player_id,
    full_name: proj.full_name,
    position: proj.position,
    team: proj.team,
    has_benchmark: true,
    ri_neutral_points: riFullPace,
    sleeper_ppr_points: slPpr,
    neutral_delta: neutralDelta,
    neutral_delta_pct: neutralDeltaPct,
    stat_deltas: deltas,
    primary_driver: driver,
    direction,
    disagreement,
  };
}

/**
 * Deterministic driver selection: the biggest opportunity gap wins over the
 * biggest efficiency gap wins over the biggest TD gap (opportunity-first
 * philosophy). Availability is checked first because it dominates season totals.
 */
function pickPrimaryDriver(
  position: string,
  deltas: StatComparison[],
  neutralDeltaPct: number | null,
): { driver: string; disagreement: number } {
  if (neutralDeltaPct == null) {
    return { driver: "Sleeper reports no PPR total", disagreement: 0 };
  }
  const mag = Math.min(1, Math.abs(neutralDeltaPct) / 40);
  if (Math.abs(neutralDeltaPct) <= AGREE_PCT) {
    return { driver: "agrees with Sleeper within 8%", disagreement: mag };
  }

  const get = (stat: string) => deltas.find((d) => d.stat === stat);
  const sign = neutralDeltaPct > 0 ? "higher" : "lower";

  // opportunity metrics by position
  const oppStats = position === "QB"
    ? ["pass_att", "rush_att"]
    : position === "RB"
      ? ["rush_att", "targets"]
      : ["targets", "rush_att"];

  // Minimum absolute gap for a stat to count as a real driver (ignores e.g. a
  // WR projected 0 rush att vs Sleeper's 1.5).
  const MIN_ABS: Record<string, number> = { pass_att: 25, rush_att: 18, targets: 15, pass_yd: 250, rush_yd: 90, rec_yd: 90, pass_td: 3, rush_td: 1.5, rec_td: 1.5 };

  let bestOpp: StatComparison | undefined;
  for (const st of oppStats) {
    const d = get(st);
    if (d?.delta_pct == null || d.delta == null) continue;
    if (Math.abs(d.delta) < (MIN_ABS[st] ?? 0)) continue;
    if (!bestOpp || Math.abs(d.delta_pct) > Math.abs(bestOpp.delta_pct ?? 0)) bestOpp = d;
  }
  if (bestOpp && Math.abs(bestOpp.delta_pct ?? 0) >= 12) {
    return {
      driver: `RI ${sign}: ${bestOpp.stat} ${fmtPct(bestOpp.delta_pct)} vs Sleeper (opportunity)`,
      disagreement: mag,
    };
  }

  // efficiency: yards per opportunity
  const yd = get(position === "QB" ? "pass_yd" : position === "RB" ? "rush_yd" : "rec_yd");
  if (yd && Math.abs(yd.delta_pct ?? 0) >= 12) {
    return { driver: `RI ${sign}: ${yd.stat} ${fmtPct(yd.delta_pct)} vs Sleeper (efficiency)`, disagreement: mag };
  }

  // TDs
  const td = get(position === "QB" ? "pass_td" : position === "RB" ? "rush_td" : "rec_td");
  if (td && Math.abs(td.delta ?? 0) >= 1.5) {
    return { driver: `RI ${sign}: ${td.stat} ${fmtDelta(td.delta)} vs Sleeper (touchdowns)`, disagreement: mag };
  }

  return { driver: `RI ${sign} than Sleeper by ${Math.abs(neutralDeltaPct).toFixed(0)}% (mixed)`, disagreement: mag };
}

/* ---------------------------------------------------------- aggregate report */

export interface PositionDisagreement {
  position: string;
  n: number;
  n_with_benchmark: number;
  /** over ALL benchmarked players (inflated by deep players Sleeper scores ~0) */
  mean_abs_delta_pct: number;
  mean_signed_delta_pct: number;
  /** over players Sleeper projects >= 60 PPR pts — the fantasy-relevant set */
  material_n: number;
  material_mean_abs_delta_pct: number;
  material_mean_signed_delta_pct: number;
  material_median_abs_delta_pct: number;
  ri_above: number;
  ri_below: number;
  agrees: number;
  biggest_gaps: Array<{ full_name: string; delta_pct: number; primary_driver: string }>;
}

const MATERIAL_MIN_SLEEPER_PTS = 60;

export function aggregateDisagreement(comparisons: PlayerComparison[]): PositionDisagreement[] {
  const byPos = new Map<string, PlayerComparison[]>();
  for (const c of comparisons) {
    if (!byPos.has(c.position)) byPos.set(c.position, []);
    byPos.get(c.position)!.push(c);
  }
  const out: PositionDisagreement[] = [];
  for (const [position, list] of byPos) {
    const withB = list.filter((c) => c.has_benchmark && c.neutral_delta_pct != null);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const median = (xs: number[]) => {
      if (!xs.length) return 0;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)]!;
    };
    const allAbs = withB.map((c) => Math.abs(c.neutral_delta_pct!));
    const allSigned = withB.map((c) => c.neutral_delta_pct!);
    const material = withB.filter((c) => (c.sleeper_ppr_points ?? 0) >= MATERIAL_MIN_SLEEPER_PTS);
    const matAbs = material.map((c) => Math.abs(c.neutral_delta_pct!));
    const matSigned = material.map((c) => c.neutral_delta_pct!);
    out.push({
      position,
      n: list.length,
      n_with_benchmark: withB.length,
      mean_abs_delta_pct: round1(mean(allAbs)),
      mean_signed_delta_pct: round1(mean(allSigned)),
      material_n: material.length,
      material_mean_abs_delta_pct: round1(mean(matAbs)),
      material_mean_signed_delta_pct: round1(mean(matSigned)),
      material_median_abs_delta_pct: round1(median(matAbs)),
      ri_above: list.filter((c) => c.direction === "RI_ABOVE").length,
      ri_below: list.filter((c) => c.direction === "RI_BELOW").length,
      agrees: list.filter((c) => c.direction === "AGREES").length,
      biggest_gaps: material
        .slice()
        .sort((a, b) => Math.abs(b.neutral_delta_pct!) - Math.abs(a.neutral_delta_pct!))
        .slice(0, 10)
        .map((c) => ({
          full_name: c.full_name,
          delta_pct: c.neutral_delta_pct!,
          primary_driver: c.primary_driver,
        })),
    });
  }
  return out.sort((a, b) => b.material_mean_abs_delta_pct - a.material_mean_abs_delta_pct);
}

/**
 * Attach the disagreement magnitude back onto each projection's confidence
 * (large disagreement -> lower confidence) and record the driver as a warning.
 * Recomputes only the confidence bucket string; the outcome band is untouched.
 */
export function foldDisagreementIntoConfidence(
  projections: PlayerProjection[],
  comparisons: Map<string, PlayerComparison>,
): void {
  for (const p of projections) {
    const c = comparisons.get(p.player_id);
    if (!c || !c.has_benchmark) continue;
    if (c.disagreement >= 0.35) {
      p.confidence.score = round2(Math.max(0.02, p.confidence.score - 0.12));
      p.confidence.reasons.push(`large disagreement with Sleeper (${fmtPct(c.neutral_delta_pct)}): ${c.primary_driver}`);
      p.confidence.bucket =
        p.confidence.score >= 0.72 ? "HIGH" : p.confidence.score >= 0.5 ? "MEDIUM" : p.confidence.score >= 0.3 ? "LOW" : "VERY_LOW";
    }
  }
}

function fmtPct(v: number | null): string {
  return v == null ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(0)}%`;
}
function fmtDelta(v: number | null): string {
  return v == null ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}
function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
