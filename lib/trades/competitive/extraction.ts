/**
 * Competitive Trade Intelligence — value extraction (Checkpoint E).
 *
 * Given a CERTIFIED base trade the counterparty would plausibly accept, this
 * module decides how much additional counterparty-PERCEIVED value we could ask
 * for, and ranks which of their assets are the best extraction targets:
 *
 *   valuable to US (private permanent value)  ÷  cheap to THEM (owner reservation
 *   price, not market value)  →  extraction efficiency.
 *
 * Everything here is computed from the counterparty's PERCEIVED economics (§3).
 * Our private valuation is never used as their acceptance valuation.
 */

import type { TradeAnalysisContext } from "../context";
import type { NegotiationConfig } from "./config";
import type { OwnerContext } from "./owner-context";
import { buildOwnerPerceivedValues } from "./owner-perception";
import { buildReservationPrice } from "./reservation";
import { resolveOwnerPerceptionConfig } from "./config";
import type { MarketEdge } from "./schema";
import type {
  AcceptanceLikelihood,
  CompetitiveClassification,
  ExtractionBand,
  HorizonClassification,
  NegotiationAggressiveness,
  NegotiationReasonCode,
  ThreatBand,
  ValueConfidence,
  ValueExtraction,
} from "./schema";

const CONF_LEVEL: Record<ValueConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };
const ACC_LEVEL: Record<AcceptanceLikelihood, number> = { VERY_LOW: 0, LOW: 1, MODERATE: 2, HIGH: 3 };

export interface BaseTradeSummary {
  our_permanent_utility: number | null;
  our_horizon_classification: HorizonClassification;
  counterparty_perceived_surplus: number | null;
  acceptance_likelihood: AcceptanceLikelihood | null;
  competitive_classification: CompetitiveClassification | null;
  confidence: ValueConfidence;
  /** aggregate market edge on the base deal (for OVERPAY detection) */
  base_market_edge: number | null;
}

export interface BuildExtractionInput {
  ctx: TradeAnalysisContext;
  base: BaseTradeSummary;
  counterparty: OwnerContext;
  /** ids already in the base trade (excluded from add-on search) */
  base_their_assets: string[];
  base_our_assets: string[];
  /** OUR owner context — for roster-fit checks */
  us: OwnerContext;
  /** dynamic market edges by player id (B.5) — for our private value of an asset */
  market_edges: Map<string, MarketEdge>;
  /** threat band by manager id (D) — SECONDARY_ASSET_WEAKENS_RIVAL */
  counterparty_threat_band: ThreatBand;
  config: NegotiationConfig;
  aggressiveness: NegotiationAggressiveness;
}

/** Is the base trade good enough to bother extracting on top of? (§14) */
export function baseTradeCertified(base: BaseTradeSummary, config: NegotiationConfig): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (base.our_permanent_utility == null || base.our_permanent_utility < config.minimum_private_gain) {
    reasons.push(`base permanent rest-of-season gain ${base.our_permanent_utility?.toFixed(2) ?? "n/a"} is below the minimum ${config.minimum_private_gain}`);
  }
  if (base.our_horizon_classification === "REVIEW_REQUIRED") {
    reasons.push("base trade horizon classification is REVIEW_REQUIRED (our private projections disagree on the acquisition)");
  }
  if (base.confidence === "VERY_LOW") reasons.push("base-trade confidence is VERY_LOW");
  if (base.competitive_classification === "REJECT" || base.competitive_classification === "AVOID_COMPETITIVE_COST") {
    reasons.push(`base competitive result is ${base.competitive_classification}`);
  }
  if ((base.acceptance_likelihood ? ACC_LEVEL[base.acceptance_likelihood] : 0) < ACC_LEVEL.LOW) {
    reasons.push("base acceptance likelihood is below LOW — the base trade itself is not plausibly acceptable");
  }
  return { ok: reasons.length === 0, reasons };
}

export function buildValueExtraction(input: BuildExtractionInput): ValueExtraction {
  const { ctx, base, counterparty, config, aggressiveness } = input;
  const reasons: string[] = [];
  const codes = new Set<NegotiationReasonCode>();

  const cert = baseTradeCertified(base, config);
  if (!cert.ok) {
    codes.add("BASE_TRADE_FAILS_GATE");
    codes.add("EXTRACTION_GATED");
    return gated(base, aggressiveness, ["base trade does not clear our value / confidence gate — no extraction search", ...cert.reasons], [...codes]);
  }
  codes.add("BASE_TRADE_CERTIFIED");

  const surplus = base.counterparty_perceived_surplus ?? 0;

  // ---- rank the counterparty's expendable assets by extraction efficiency ----
  const opCfg = resolveOwnerPerceptionConfig();
  const excluded = new Set([...input.base_their_assets, ...input.base_our_assets]);
  const ourPositions = new Set(
    [...input.us.by_player.values()]
      .filter((p) => ["LOCKED_STARTER", "REGULAR_STARTER"].includes(p.starter_importance))
      .map((p) => p.position),
  );

  const ranked: ValueExtraction["ranked_secondary_assets"] = [];
  for (const pc of counterparty.by_player.values()) {
    if (excluded.has(pc.canonical_player_id)) continue;
    // only realistically extractable assets: bench / rotational / flex, or a positional surplus
    const expendable =
      pc.starter_importance === "BENCH_DEPTH" ||
      pc.starter_importance === "ROTATIONAL" ||
      (pc.starter_importance === "FLEX_STARTER" && pc.position_startable_without >= 2);
    if (!expendable) continue;

    // their reservation for this single asset (Checkpoint C, roster-context)
    const perceived = buildOwnerPerceivedValues({
      owner: counterparty,
      player_ids: [pc.canonical_player_id],
      global_market_z: new Map([[pc.canonical_player_id, input.market_edges.get(pc.canonical_player_id)?.market_value?.normalized_value ?? null]]),
      market_trajectory: new Map([[pc.canonical_player_id, input.market_edges.get(pc.canonical_player_id)?.market_trajectory ?? "UNKNOWN"]]),
      adp_position_rank: new Map(),
      meaningful_games: ctx.week <= 1 ? 0 : 0,
      config: opCfg,
    });
    const res = buildReservationPrice({ ctx, owner: counterparty, outgoing_ids: [pc.canonical_player_id], perceived, config: opCfg });
    const theirReservation = res.reservation_price;

    // our private value of the asset (B.5 private forward value z)
    const edge = input.market_edges.get(pc.canonical_player_id);
    const ourValue = edge?.private_value.normalized_value ?? null;

    const assetCodes: NegotiationReasonCode[] = [];
    if (theirReservation != null && theirReservation < 0.4) assetCodes.push("SECONDARY_ASSET_EXPENDABLE_TO_THEM");
    if (ourValue != null && ourValue > 0.5) assetCodes.push("SECONDARY_ASSET_HIGH_VALUE_TO_US");
    if (ourPositions.has(pc.position) && (input.us.by_player.size > 0)) {
      // redundant: we already have a locked/regular starter there and thin bench need
      const ourStartableAtPos = [...input.us.by_player.values()].filter((p) => p.position === pc.position && p.starter_importance !== "BENCH_DEPTH").length;
      if (ourStartableAtPos >= 3) assetCodes.push("SECONDARY_ASSET_POOR_ROSTER_FIT");
    }
    if ((input.counterparty_threat_band === "ELITE" || input.counterparty_threat_band === "HIGH") && pc.starter_importance !== "BENCH_DEPTH") {
      assetCodes.push("SECONDARY_ASSET_WEAKENS_RIVAL");
    }

    const efficiency =
      ourValue == null || theirReservation == null
        ? null
        : round4((ourValue + 1.5) / Math.max(0.2, theirReservation + 1.0)); // shift both onto a positive scale, ratio

    ranked.push({
      canonical_player_id: pc.canonical_player_id,
      name: pc.name,
      position: pc.position,
      our_private_value: ourValue == null ? null : round4(ourValue),
      their_reservation: theirReservation == null ? null : round4(theirReservation),
      their_starter_importance: pc.starter_importance,
      efficiency,
      reason_codes: assetCodes,
    });
  }

  ranked.sort((a, b) => (b.efficiency ?? -Infinity) - (a.efficiency ?? -Infinity) || a.canonical_player_id.localeCompare(b.canonical_player_id));
  const top = ranked.slice(0, config.max_secondary_assets_considered);

  // ---- band ----
  const accLevel = base.acceptance_likelihood ? ACC_LEVEL[base.acceptance_likelihood] : 0;
  const confLevel = CONF_LEVEL[base.confidence];
  let band: ExtractionBand;
  if (top.length === 0 || surplus <= 0.02) {
    band = "NO_EXTRACTION_ROOM";
    reasons.push(top.length === 0 ? "the counterparty has no realistically extractable assets" : "the counterparty perceives essentially no surplus in the base deal");
  } else if (surplus < config.limited_extraction_surplus || accLevel <= ACC_LEVEL.LOW) {
    band = "LIMITED_EXTRACTION";
    codes.add("LIMITED_EXTRACTION_PROTECT_BASE");
    reasons.push("base perceived surplus is thin or acceptance is only LOW/MODERATE — do not risk a strong base trade for a small squeeze");
  } else if (surplus >= config.high_extraction_surplus && accLevel >= ACC_LEVEL.HIGH && confLevel >= CONF_LEVEL.MEDIUM) {
    band = "HIGH_EXTRACTION";
    codes.add("STRAIGHT_SWAP_LEAVES_VALUE_UNCAPTURED");
    reasons.push("the counterparty perceives a large surplus and acceptance is HIGH — a straight swap leaves value on the table");
  } else {
    band = "MODERATE_EXTRACTION";
  }
  if (confLevel < CONF_LEVEL.MEDIUM && band === "HIGH_EXTRACTION") {
    band = "MODERATE_EXTRACTION";
    codes.add("CONFIDENCE_LIMITS_AGGRESSION");
  }

  const leave = config.surplus_left_with_counterparty[aggressiveness];
  const recommended = band === "NO_EXTRACTION_ROOM" ? 0 : round4(Math.max(0, surplus) * (1 - leave));
  const remaining = round4(Math.max(0, surplus) - recommended);

  if (band !== "NO_EXTRACTION_ROOM") {
    reasons.push(`recommended extraction ≈ ${recommended.toFixed(2)} of the counterparty's ${surplus.toFixed(2)} perceived surplus (leaving ${remaining.toFixed(2)} so the offer keeps a credible reason to accept)`);
  }

  return {
    base_perceived_surplus: base.counterparty_perceived_surplus,
    maximum_theoretical_extraction: base.counterparty_perceived_surplus == null ? null : round4(Math.max(0, surplus)),
    recommended_extraction: recommended,
    remaining_counterparty_surplus: remaining,
    band,
    aggressiveness,
    ranked_secondary_assets: top,
    reason_codes: [...codes],
    reasons,
  };
}

function gated(
  base: BaseTradeSummary,
  aggressiveness: NegotiationAggressiveness,
  reasons: string[],
  codes: NegotiationReasonCode[],
): ValueExtraction {
  return {
    base_perceived_surplus: base.counterparty_perceived_surplus,
    maximum_theoretical_extraction: null,
    recommended_extraction: null,
    remaining_counterparty_surplus: null,
    band: "EXTRACTION_GATED",
    aggressiveness,
    ranked_secondary_assets: [],
    reason_codes: codes,
    reasons,
  };
}

function round4(v: number): number {
  const x = Math.round(v * 10000) / 10000;
  return x === 0 ? 0 : x;
}
