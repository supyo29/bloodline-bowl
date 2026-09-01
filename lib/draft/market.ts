/**
 * PHASE 5 — snake-draft market consensus (`market_consensus_version:
 * ri-snake-market-2026.1`).
 *
 * Turns the vendored 2026 ADP snapshot (`lib/draft/data/market-adp-2026.ts` —
 * Underdog ADP + Yahoo ADP + a published ADP consensus, all Half-PPR / 12-team,
 * plus Sleeper `search_rank` as a ranking proxy) into a per-player
 * `MarketConsensus`:
 *
 *   expected_pick      robust weighted median of source pick-equivalents
 *   dispersion         MAD of the source picks (source disagreement, §8)
 *   pick_range         [p10, p90] plausible overall-pick band
 *   source_count       number of usable sources
 *   confidence         HIGH / MEDIUM / LOW / NONE (§29 tiers)
 *   freshness          FRESH / AGING / STALE (§9)
 *   market_trend       RISING / FALLING / STABLE / UNKNOWN (§28)
 *
 * NO auction dollar values (§5). Everything is snake-usable ADP or a ranking
 * proxy. Robust aggregation (weighted median), not a mean of heterogeneous
 * ranks (§7).
 */

import { MARKET_ADP_2026, type MarketPlayerRow } from "./data/market-adp-2026";

export const MARKET_CONSENSUS_VERSION = MARKET_ADP_2026.market_consensus_version;

/** Source-type weights for the weighted median (§7 — direct ADP > proxy). */
const SOURCE_WEIGHT: Record<string, number> = {
  underdog_adp: 1.0,
  yahoo_adp: 1.0,
  // the published consensus is itself a merge of public ADP — real signal, but
  // partly correlated with the two direct feeds, so it carries less weight.
  published_adp_consensus: 0.6,
  sleeper_search_rank: 0.35,
};

/** Days after which an ADP snapshot is no longer FRESH / becomes STALE. */
const FRESH_DAYS = 4;
const STALE_DAYS = 10;

export type MarketConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";
export type MarketFreshness = "FRESH" | "AGING" | "STALE" | "UNKNOWN";
export type MarketTrend = "RISING" | "FALLING" | "STABLE" | "UNKNOWN";

export interface MarketConsensus {
  sleeper_id: string;
  name: string;
  position: string | null;
  team: string | null;
  /** robust weighted-median expected overall pick */
  expected_pick: number;
  /** plain median of source picks (for provenance) */
  median_pick: number;
  /** [p10, p90] plausible overall-pick band */
  pick_range: [number, number];
  /** MAD of source picks (0 when a single source) */
  dispersion: number;
  source_count: number;
  sources: Array<{ source: string; type: string; pick: number; date: string }>;
  direct_adp_count: number;
  confidence: MarketConfidence;
  freshness: MarketFreshness;
  market_trend: MarketTrend;
  /** ISO date of the newest source used */
  as_of: string | null;
}

export interface MarketConsensusTable {
  version: string;
  generated_at: string;
  as_of_reference: string;
  by_player: Map<string, MarketConsensus>;
  source_catalog: typeof MARKET_ADP_2026.source_catalog;
  excluded_sources: typeof MARKET_ADP_2026.excluded_sources;
  identity_audit: typeof MARKET_ADP_2026.identity_audit;
}

/* --------------------------------------------------------------- helpers */

function weightedMedian(pairs: Array<{ v: number; w: number }>): number {
  if (pairs.length === 0) return NaN;
  const s = [...pairs].sort((a, b) => a.v - b.v);
  const total = s.reduce((acc, p) => acc + p.w, 0);
  let run = 0;
  for (const p of s) {
    run += p.w;
    if (run >= total / 2) return p.v;
  }
  return s[s.length - 1]!.v;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** Median absolute deviation from the median — robust dispersion. */
function mad(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

function daysBetween(aIso: string, bIso: string): number {
  return Math.abs(new Date(aIso).getTime() - new Date(bIso).getTime()) / 86_400_000;
}

/**
 * search_rank → an implied overall pick. In a 12-team league the top ~180
 * `search_rank` values map almost 1:1 to draft position; beyond that Sleeper's
 * ordering is noisy, so we stretch mildly.
 */
export function searchRankToPick(rank: number): number {
  if (rank <= 0) return 1;
  return rank <= 180 ? rank : 180 + (rank - 180) * 1.15;
}

/* --------------------------------------------------------------- build */

function consensusFor(row: MarketPlayerRow, referenceIso: string): MarketConsensus {
  const src: MarketConsensus["sources"] = row.sources.map((s) => ({
    source: s.source,
    type: s.type,
    pick: s.pick,
    date: s.date,
  }));
  if (row.search_rank != null) {
    src.push({
      source: "sleeper_search_rank",
      type: "RANKING_PROXY",
      pick: Math.round(searchRankToPick(row.search_rank)),
      date: referenceIso.slice(0, 10),
    });
  }

  const directAdp = src.filter((s) => s.type === "DIRECT_ADP");
  const picks = src.map((s) => s.pick);
  const weighted = src.map((s) => ({ v: s.pick, w: SOURCE_WEIGHT[s.source] ?? 0.3 }));

  const expected = round1(weightedMedian(weighted));
  const med = round1(median(picks));
  const disp = round1(mad(directAdp.length >= 2 ? directAdp.map((s) => s.pick) : picks));

  // pick_range: MAD-scaled band, widened by a per-round base uncertainty
  const roundBase = 1.5 + 0.06 * expected; // later picks are inherently looser
  const spread = Math.max(roundBase, 1.4826 * disp * 1.28 + roundBase * 0.5);
  const pick_range: [number, number] = [
    Math.max(1, Math.round(expected - 1.28 * spread)),
    Math.round(expected + 1.28 * spread),
  ];

  // freshness is judged on the DATED ADP feeds only — the search_rank proxy row
  // is stamped with the build time and would otherwise mask staleness.
  const datedFeedIsos = src
    .filter((s) => s.source !== "sleeper_search_rank")
    .map((s) => s.date)
    .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort();
  const newestIso = datedFeedIsos.at(-1) ?? null;
  const ageDays = newestIso ? daysBetween(newestIso, referenceIso) : Infinity;
  const freshness: MarketFreshness =
    !newestIso ? "UNKNOWN" : ageDays <= FRESH_DAYS ? "FRESH" : ageDays <= STALE_DAYS ? "AGING" : "STALE";

  // trend: only claimable if sources of clearly different vintage disagree in
  // one direction. Our snapshots are within ~a week → almost always STABLE.
  let trend: MarketTrend = "UNKNOWN";
  const dated = src.filter((s) => s.date.length >= 8 && s.type === "DIRECT_ADP");
  if (dated.length >= 2) {
    const byDate = [...dated].sort((a, b) => a.date.localeCompare(b.date));
    const oldest = byDate[0]!;
    const newest = byDate[byDate.length - 1]!;
    if (daysBetween(normDate(newest.date), normDate(oldest.date)) >= 3) {
      const delta = newest.pick - oldest.pick;
      trend = Math.abs(delta) < 3 ? "STABLE" : delta < 0 ? "RISING" : "FALLING";
    } else {
      trend = "STABLE";
    }
  } else if (directAdp.length >= 1) {
    trend = "STABLE";
  }

  // §29 confidence tiers
  let confidence: MarketConfidence;
  if (directAdp.length >= 2 && freshness !== "STALE" && disp <= 12) confidence = "HIGH";
  else if (directAdp.length >= 1 && freshness !== "STALE") confidence = "MEDIUM";
  else if (src.length >= 1) confidence = "LOW";
  else confidence = "NONE";
  // stale data can never be HIGH (§9, §39)
  if (freshness === "STALE" && confidence === "HIGH") confidence = "MEDIUM";
  // very high disagreement can never be HIGH (§8, §39)
  if (disp > 12 && confidence === "HIGH") confidence = "MEDIUM";

  return {
    sleeper_id: row.sleeper_id,
    name: row.name,
    position: row.position,
    team: row.team,
    expected_pick: expected,
    median_pick: med,
    pick_range,
    dispersion: disp,
    source_count: src.length,
    sources: src,
    direct_adp_count: directAdp.length,
    confidence,
    freshness,
    market_trend: trend,
    as_of: newestIso,
  };
}

function normDate(d: string): string {
  // "26-08-24" -> "2026-08-24"; passthrough for already-ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d;
  const m = d.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : d;
}

let cache: MarketConsensusTable | null = null;

export function buildMarketConsensus(
  opts: { referenceDate?: string } = {},
): MarketConsensusTable {
  const referenceIso = opts.referenceDate ?? new Date().toISOString();
  if (!opts.referenceDate && cache) return cache;

  const by_player = new Map<string, MarketConsensus>();
  for (const row of MARKET_ADP_2026.players) {
    const rowNorm: MarketPlayerRow = {
      ...row,
      sources: row.sources.map((s) => ({ ...s, date: normDate(s.date) })),
    };
    by_player.set(row.sleeper_id, consensusFor(rowNorm, referenceIso));
  }

  const table: MarketConsensusTable = {
    version: MARKET_ADP_2026.market_consensus_version,
    generated_at: MARKET_ADP_2026.generated_at,
    as_of_reference: referenceIso,
    by_player,
    source_catalog: MARKET_ADP_2026.source_catalog,
    excluded_sources: MARKET_ADP_2026.excluded_sources,
    identity_audit: MARKET_ADP_2026.identity_audit,
  };
  if (!opts.referenceDate) cache = table;
  return table;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
