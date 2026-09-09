/**
 * Competitive Trade Intelligence — the Market Edge classifier (Checkpoint B).
 *
 * For every player in the league universe: normalize our private valuation and
 * the outside-market valuation onto the same within-position z-scale, then
 * classify the discrepancy — with a CONFIDENCE GATE so a large gap at VERY_LOW
 * confidence is never treated like a large gap at HIGH confidence.
 *
 *   edge_score      = (private_z − market_z) × position_scarcity_weight
 *   actionable_edge = edge_score × confidence_actionability[confidence]   ← rank key
 *
 * direction:
 *   |edge_score| < fair_band                     → FAIR
 *   |edge_score| ≥ strong_band  & conf ≥ MEDIUM  → STRONG_BUY / STRONG_SELL
 *   |edge_score| ≥ directional_band              → BUY / SELL   (speculative at LOW/VERY_LOW)
 *   private or market value missing              → INSUFFICIENT_DATA (edge_score = null)
 *
 * NOTHING here asserts a player is obtainable, an acquisition price, or that an
 * owner would accept. `analytical_only` is always `true`.
 */

import type { CanonicalPlayer } from "@/lib/canonical/schema";
import { normalizeWithinPosition, type RawPoint } from "./normalize";
import type { PlayerPrivateValue } from "./private-value";
import type { PlayerMarketSnapshot } from "./market/snapshot";
import type { CompetitiveTradeConfig } from "./config";
import type {
  MarketEdge,
  MarketEdgeDirection,
  MarketEdgeReasonCode,
  NormalizedValue,
  ValueConfidence,
} from "./schema";

const CONF_LEVEL: Record<ValueConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };
const LEVEL_CONF: ValueConfidence[] = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];
const levelToConf = (n: number): ValueConfidence => LEVEL_CONF[Math.max(0, Math.min(3, Math.round(n)))]!;

export interface MarketEdgeTable {
  by_player: Map<string, MarketEdge>;
  position_coverage: Map<string, number>;
}

export interface BuildMarketEdgesInput {
  private_values: Map<string, PlayerPrivateValue>;
  market_snapshots: Map<string, PlayerMarketSnapshot>;
  players_by_id: Map<string, CanonicalPlayer>;
  universe: string[];
  config: CompetitiveTradeConfig;
}

export function buildMarketEdges(input: BuildMarketEdgesInput): MarketEdgeTable {
  const { private_values, market_snapshots, players_by_id, universe, config } = input;

  const privatePoints: RawPoint[] = [];
  const marketPoints: RawPoint[] = [];
  for (const cid of universe) {
    const pv = private_values.get(cid);
    const ms = market_snapshots.get(cid);
    const position = pv?.position ?? ms?.position ?? players_by_id.get(cid)?.position ?? "UNKNOWN";
    privatePoints.push({ canonical_player_id: cid, position, raw: pv?.raw ?? null });
    marketPoints.push({ canonical_player_id: cid, position, raw: ms?.primary_raw ?? null });
  }

  const privNorm = normalizeWithinPosition(privatePoints);
  const mktNorm = normalizeWithinPosition(marketPoints);

  // per-position coverage: fraction of that position's universe with BOTH sides
  const posTotals = new Map<string, number>();
  const posBoth = new Map<string, number>();
  for (const cid of universe) {
    const pos = privNorm.by_player.get(cid)?.position ?? "UNKNOWN";
    posTotals.set(pos, (posTotals.get(pos) ?? 0) + 1);
    const hasBoth =
      privNorm.by_player.get(cid)?.normalized_value != null && mktNorm.by_player.get(cid)?.normalized_value != null;
    if (hasBoth) posBoth.set(pos, (posBoth.get(pos) ?? 0) + 1);
  }
  const position_coverage = new Map<string, number>();
  for (const [pos, total] of posTotals) position_coverage.set(pos, total > 0 ? (posBoth.get(pos) ?? 0) / total : 0);

  const by_player = new Map<string, MarketEdge>();

  for (const cid of universe) {
    const pv = private_values.get(cid);
    const ms = market_snapshots.get(cid);
    const player = players_by_id.get(cid);
    const pn = privNorm.by_player.get(cid);
    const mn = mktNorm.by_player.get(cid);
    const position = pv?.position ?? ms?.position ?? player?.position ?? "UNKNOWN";
    const coverage = position_coverage.get(position) ?? 0;

    const privateValue: NormalizedValue = {
      basis: pv?.basis ?? "unavailable",
      raw: pv?.raw ?? null,
      normalized_value: pn?.normalized_value ?? null,
      percentile: pn?.percentile ?? null,
      position_rank: pn?.position_rank ?? pv?.ri_position_rank ?? null,
      confidence: pv?.confidence ?? "VERY_LOW",
      as_of: pv?.as_of ?? null,
      model_version: pv?.model_version ?? null,
    };

    const reasons: string[] = [];
    const codes: MarketEdgeReasonCode[] = [];

    // ---- INSUFFICIENT_DATA branches ---------------------------------------
    const marketAvailable = ms != null && ms.primary_basis !== "unavailable" && mn?.normalized_value != null;
    const privateAvailable = privateValue.normalized_value != null;

    if (!marketAvailable || !privateAvailable) {
      if (!marketAvailable) {
        codes.push("MARKET_DATA_UNAVAILABLE");
        reasons.push("No usable outside-market value — market edge cannot be computed (missing is not zero).");
      }
      if (!privateAvailable) {
        codes.push("PRIVATE_VALUE_UNAVAILABLE");
        reasons.push("No usable private projection for this player.");
      }
      codes.push("ANALYTICAL_ONLY_NO_ACQUISITION_MODEL");
      by_player.set(cid, {
        canonical_player_id: cid,
        name: player?.full_name ?? cid,
        position,
        nfl_team: player?.nfl_team ?? null,
        private_value: privateValue,
        // market_value is null whenever market data is unavailable — never a
        // partial object, never a fabricated zero.
        market_value: marketAvailable ? buildMarketNormalizedValue(ms!, mn!, "ros_weekly_vor") : null,
        direction: "INSUFFICIENT_DATA",
        edge_score: null,
        actionable_edge: null,
        confidence: "VERY_LOW",
        reason_codes: codes,
        reasons,
        lineage: ms?.lineage ?? emptyLineage(),
        analytical_only: true,
      });
      continue;
    }

    const marketValue = buildMarketNormalizedValue(ms!, mn!, "ros_weekly_vor");

    // ---- edge -----------------------------------------------------------
    const scarcity = config.position_scarcity_weight[position] ?? config.default_scarcity_weight;
    const rawEdge = (pn!.normalized_value as number) - (mn!.normalized_value as number);
    const edge_score = round4(rawEdge * scarcity);
    const buySide = edge_score > 0;

    if (scarcity > 1.001) codes.push("POSITION_SCARCITY_AMPLIFIES");
    else if (scarcity < 0.999) codes.push("POSITION_DEPTH_DAMPENS");

    // ---- confidence: worst of the two sides, then adjust ---------------
    // readiness is authoritative in the classifier too — a STALE market can
    // never be MEDIUM+ here even if the snapshot passed a higher ceiling.
    const readinessCeiling = config.readiness_confidence_ceiling[ms!.readiness];
    const marketConf = capConf(capConf(marketValue.confidence, ms!.confidence_ceiling), readinessCeiling);
    let level = Math.min(CONF_LEVEL[privateValue.confidence], CONF_LEVEL[marketConf]);

    if (privateValue.confidence === "LOW" || privateValue.confidence === "VERY_LOW") {
      codes.push("PRIVATE_VALUE_LOW_CONFIDENCE");
    }
    if (ms!.readiness === "STALE") { codes.push("MARKET_DATA_STALE"); }
    if (ms!.readiness === "PARTIAL") { codes.push("MARKET_DATA_PARTIAL"); }
    if (ms!.lineage.dispersion >= config.market_dispersion_downgrade_at) {
      codes.push("MARKET_SOURCE_DISAGREEMENT");
      reasons.push(`Market sources disagree (implied-rank MAD ${round1(ms!.lineage.dispersion)}) — market confidence reduced.`);
    }

    // corroboration: RI↔Sleeper stat-level disagreement pointing the SAME way as our edge
    const corr = ms!.corroborating_disagreement;
    if (corr && Math.abs(corr.pct) >= config.corroborating_disagreement_pct) {
      const corrBuy = corr.direction === "RI_ABOVE";
      const corrSell = corr.direction === "RI_BELOW";
      if ((buySide && corrBuy) || (!buySide && corrSell)) {
        level = Math.min(3, level + 1);
        codes.push("RI_SLEEPER_DISAGREEMENT_CORROBORATES");
        reasons.push(`Independent RI↔Sleeper stat disagreement (${fmtPct(corr.pct)}) corroborates the direction of this edge.`);
      }
    }

    // coverage: thin position normalization is less trustworthy
    if (coverage < config.min_position_coverage) {
      level = Math.max(0, level - 1);
      reasons.push(`Only ${(coverage * 100).toFixed(0)}% of ${position} have both private and market values — normalization confidence reduced.`);
    }

    const confidence = levelToConf(level);

    // ---- direction with confidence cap --------------------------------
    const mag = Math.abs(edge_score);
    let direction: MarketEdgeDirection;
    if (mag < config.edge_bands.fair_band) {
      direction = "FAIR";
      codes.push("VALUES_ALIGN");
    } else {
      const strong = mag >= config.edge_bands.strong_band;
      const directional = mag >= config.edge_bands.directional_band;
      const cap = config.max_direction_by_confidence[confidence];
      const wantStrong = strong && cap === "STRONG";
      if (wantStrong) direction = buySide ? "STRONG_BUY" : "STRONG_SELL";
      else if (directional || strong) direction = buySide ? "BUY" : "SELL";
      else direction = "FAIR";

      if (strong && cap !== "STRONG") {
        codes.push("CONFIDENCE_GATE_APPLIED");
        reasons.push(`Raw discrepancy reaches STRONG magnitude but ${confidence} confidence caps it at ${direction}.`);
      }
      if (confidence === "LOW" || confidence === "VERY_LOW") {
        if (direction === "BUY" || direction === "SELL") {
          codes.push("SPECULATIVE_LOW_CONFIDENCE");
          reasons.push("Speculative — acted on a low-confidence discrepancy; needs corroboration before an aggressive move.");
        }
      }
    }

    codes.push(buySide ? "PRIVATE_ABOVE_MARKET" : "MARKET_ABOVE_PRIVATE");
    reasons.unshift(
      buySide
        ? `We value ${player?.full_name ?? cid} ${round2(edge_score)} position-SD above outside-market pricing (private ${fmtRank(privateValue.position_rank, position)} vs market ${fmtRank(marketValue.position_rank, position)}).`
        : `Outside-market prices ${player?.full_name ?? cid} ${round2(-edge_score)} position-SD above our valuation (market ${fmtRank(marketValue.position_rank, position)} vs private ${fmtRank(privateValue.position_rank, position)}).`,
    );
    codes.push("ANALYTICAL_ONLY_NO_ACQUISITION_MODEL");

    const actionable_edge = round4(edge_score * config.confidence_actionability[confidence]);

    by_player.set(cid, {
      canonical_player_id: cid,
      name: player?.full_name ?? cid,
      position,
      nfl_team: player?.nfl_team ?? null,
      private_value: privateValue,
      market_value: marketValue,
      direction,
      edge_score,
      actionable_edge,
      confidence,
      reason_codes: dedupe(codes),
      reasons,
      lineage: ms!.lineage,
      analytical_only: true,
    });
  }

  return { by_player, position_coverage };
}

function buildMarketNormalizedValue(
  ms: PlayerMarketSnapshot,
  mn: { normalized_value: number | null; percentile: number | null; position_rank: number | null } | null,
  basis: "ros_weekly_vor" | "unavailable",
): NormalizedValue {
  const worstSourceAsOf =
    ms.lineage.sources.find((s) => s.source_type === "provider_benchmark")?.as_of ?? null;
  return {
    basis,
    raw: ms.primary_raw,
    normalized_value: mn?.normalized_value ?? null,
    percentile: mn?.percentile ?? null,
    position_rank: mn?.position_rank ?? null,
    confidence: ms.confidence_ceiling,
    as_of: worstSourceAsOf,
    model_version: null,
  };
}

function capConf(c: ValueConfidence, ceiling: ValueConfidence): ValueConfidence {
  return CONF_LEVEL[c] <= CONF_LEVEL[ceiling] ? c : ceiling;
}

function emptyLineage() {
  return {
    sources: [],
    primary_source_type: null,
    usable_source_count: 0,
    dispersion: 0,
    worst_readiness: "UNAVAILABLE" as const,
    scoring_normalization: "no market sources available",
  };
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
function fmtRank(rank: number | null, pos: string): string {
  return rank == null ? `${pos}?` : `${pos}${rank}`;
}
function fmtPct(v: number): string {
  return `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
