/**
 * Competitive Trade Intelligence — within-position normalization (Checkpoint B).
 *
 * Pure. No I/O, no repo types beyond primitives. Turns a raw value-basis
 * (weekly points over replacement, ROS weekly VOR, …) into a scarcity-aware
 * continuous scale so that equal positional-rank gaps at different points of
 * the position curve do NOT produce equal edges.
 *
 *   normalized_value = (raw − positionMean) / positionStdDev      (z-score)
 *   percentile       = fraction of the position group at or below raw
 *   position_rank    = 1-based rank within the position group (best = 1)
 *
 * Method (documented per Checkpoint B §9): a plain within-position z-score of a
 * value-over-replacement basis. VOR is chosen over raw projected points because
 * it already subtracts the league's replacement frontier, so the zero point is
 * economically meaningful and the same for the private and market sides. The
 * z-score then makes the two sides directly comparable ("how many position
 * standard deviations apart") without ensembling incompatible absolute scales.
 */

export interface RawPoint {
  canonical_player_id: string;
  position: string;
  raw: number | null;
}

export interface NormalizedPoint {
  canonical_player_id: string;
  position: string;
  raw: number | null;
  normalized_value: number | null;
  percentile: number | null;
  position_rank: number | null;
}

export interface PositionDistribution {
  position: string;
  n: number;
  mean: number;
  std_dev: number;
  min: number;
  max: number;
}

export interface NormalizationResult {
  by_player: Map<string, NormalizedPoint>;
  by_position: Map<string, PositionDistribution>;
}

const MIN_GROUP = 3;

export function normalizeWithinPosition(points: RawPoint[]): NormalizationResult {
  const groups = new Map<string, RawPoint[]>();
  for (const p of points) {
    if (!groups.has(p.position)) groups.set(p.position, []);
    groups.get(p.position)!.push(p);
  }

  const byPlayer = new Map<string, NormalizedPoint>();
  const byPosition = new Map<string, PositionDistribution>();

  for (const [position, group] of groups) {
    const withValue = group.filter((g): g is RawPoint & { raw: number } => g.raw != null && Number.isFinite(g.raw));
    const values = withValue.map((g) => g.raw).sort((a, b) => a - b);
    const n = values.length;

    let mean = 0;
    let std = 0;
    if (n > 0) {
      mean = values.reduce((s, v) => s + v, 0) / n;
      const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
      std = Math.sqrt(variance);
    }

    byPosition.set(position, {
      position,
      n,
      mean: round4(mean),
      std_dev: round4(std),
      min: n > 0 ? values[0]! : 0,
      max: n > 0 ? values[n - 1]! : 0,
    });

    // rank: descending by raw (best = rank 1); missing raw ⇒ null rank
    const ranked = [...group].sort((a, b) => {
      if (a.raw == null && b.raw == null) return a.canonical_player_id.localeCompare(b.canonical_player_id);
      if (a.raw == null) return 1;
      if (b.raw == null) return -1;
      return b.raw - a.raw || a.canonical_player_id.localeCompare(b.canonical_player_id);
    });
    const rankOf = new Map<string, number>();
    let r = 0;
    for (const g of ranked) {
      if (g.raw == null) continue;
      r += 1;
      rankOf.set(g.canonical_player_id, r);
    }

    for (const g of group) {
      let normalized: number | null = null;
      let percentile: number | null = null;
      if (g.raw != null && Number.isFinite(g.raw)) {
        if (n >= MIN_GROUP && std > 1e-9) {
          normalized = round4((g.raw - mean) / std);
        } else if (n >= MIN_GROUP) {
          normalized = 0; // degenerate group (all equal) — no dispersion signal
        }
        // percentile: fraction of the group's valued players at or below g.raw
        const atOrBelow = values.filter((v) => v <= g.raw!).length;
        percentile = n > 0 ? round4(atOrBelow / n) : null;
      }
      byPlayer.set(g.canonical_player_id, {
        canonical_player_id: g.canonical_player_id,
        position: g.position,
        raw: g.raw,
        normalized_value: normalized,
        percentile,
        position_rank: rankOf.get(g.canonical_player_id) ?? null,
      });
    }
  }

  return { by_player: byPlayer, by_position: byPosition };
}

/** Median absolute deviation from the median — robust dispersion, matches lib/draft/market.ts. */
export function medianAbsoluteDeviation(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = median(xs);
  return round4(median(xs.map((x) => Math.abs(x - m))));
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
