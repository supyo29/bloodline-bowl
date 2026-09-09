/**
 * Competitive Trade Intelligence — TRADE LIQUIDITY (Checkpoint F, §5–§9).
 *
 * Liquidity = how broadly tradable a player is across the CURRENT league near
 * his current perceived price. It is NOT player popularity and NOT market
 * value. A high-liquidity player is one that many managers could realistically
 * absorb into a starting role and plausibly pay for.
 *
 * §9 — OWNER-INDEPENDENT AFTER ACQUISITION. This module never reuses the
 * current owner's reservation price. It estimates "if WE acquire this player,
 * how tradable is he FROM OUR ROSTER?" by scanning every OTHER manager as a
 * hypothetical future buyer. The player's current owner is excluded from the
 * buyer scan (we would BE the owner).
 *
 * Everything is a HEURISTIC — there is one real league trade on record.
 */

import type { CompetitiveTradeEvaluationContext } from "./eval-context";
import { lineupGainFromAdding } from "./owner-context";
import { resolveCompetitiveFConfig, type CompetitiveFConfig, type PartialCompetitiveFConfig } from "./config";
import type { LiquidityBuyer, LiquidityClassification, TradeLiquidity, ValueConfidence } from "./schema";

const NEED_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MODERATE: 2, LOW: 1, NONE: 0 };
const MODERATE_NEED = 2;
const CLASS_ORDER: LiquidityClassification[] = ["VERY_LOW", "LOW", "MODERATE", "HIGH", "VERY_HIGH"];

export interface BuildLiquidityInput {
  ec: CompetitiveTradeEvaluationContext;
  canonical_player_id: string;
  /** the player's current owner — excluded from the buyer scan (§9) */
  current_owner_manager_id: string | null;
  /** the manager doing the analysis — excluded (that's "us", the hypothetical owner) */
  my_manager_id: string;
  config?: PartialCompetitiveFConfig;
}

export function buildTradeLiquidity(input: BuildLiquidityInput): TradeLiquidity {
  const { ec, canonical_player_id: pid, my_manager_id } = input;
  const cfg: CompetitiveFConfig = resolveCompetitiveFConfig(input.config);
  const L = cfg.liquidity;

  const player = ec.ctx.players_by_id.get(pid);
  const edge = ec.dynamic_edges.get(pid) ?? ec.market_table.edges.by_player.get(pid) ?? null;
  const position = player?.position ?? edge?.position ?? "UNKNOWN";
  const name = player?.full_name ?? edge?.name ?? pid;
  const marketConf: ValueConfidence = edge?.confidence ?? "VERY_LOW";

  const excluded = new Set<string>([my_manager_id]);
  if (input.current_owner_manager_id) excluded.add(input.current_owner_manager_id);

  const reasons: string[] = [];
  const buyers: LiquidityBuyer[] = [];
  let partial = false;

  // ---- league positional scarcity: startable supply ÷ demand ----
  let startableSupply = 0;
  let demand = 0;
  for (const m of ec.ctx.snapshot.managers) {
    const oc = ec.owner_context(m.canonical_manager_id);
    if (!oc.available) continue;
    for (const pc of oc.by_player.values()) {
      if (pc.position !== position) continue;
      if (pc.starter_importance !== "BENCH_DEPTH" && pc.starter_importance !== "IR") startableSupply += 1;
    }
    const need = oc.profile.needs.find((n) => n.position === position);
    demand += 1 + (need ? NEED_RANK[need.severity] ?? 0 : 0) * 0.25;
  }
  const scarcityRatio = demand > 0 ? Math.round((startableSupply / demand) * 1000) / 1000 : null;

  // ---- buyer scan ----
  for (const m of ec.ctx.snapshot.managers) {
    const mid = m.canonical_manager_id;
    if (excluded.has(mid)) continue;
    const oc = ec.owner_context(mid);
    if (!oc.available || !oc.roster) {
      partial = true;
      continue;
    }
    const gain = lineupGainFromAdding(ec.ctx, oc.roster, pid);
    const need = oc.profile.needs.find((n) => n.position === position);
    const fillsNeed = !!need && (NEED_RANK[need.severity] ?? 0) >= MODERATE_NEED;

    // plausible acquisition economics: the manager has expendable / surplus
    // assets they could put in a package near the player's price, OR the lineup
    // gain is large enough that they would consolidate to get him.
    const hasExpendable = oc.profile.expendable_assets.length > 0;
    const hasSurplus = oc.profile.surpluses.some((s) => s.surplus_count > 0);
    const plausibleEconomics = hasExpendable || hasSurplus || (gain ?? 0) >= L.lineup_entry_points * 1.5;

    // roster-slot compatibility: the league starts this position (direct slot or FLEX)
    const slotCompatible = leagueStartsPosition(ec, position);

    const entersLineup = (gain ?? 0) >= L.lineup_entry_points;
    const marginalFit = (gain ?? 0) >= L.moderate_fit_points;

    if (!slotCompatible) continue;
    if (!entersLineup && !fillsNeed && !marginalFit) continue;

    const bReasons: string[] = [];
    if (entersLineup) bReasons.push(`would add ~${gain!.toFixed(1)} optimal-lineup pts/wk (enters the starting lineup)`);
    else if (marginalFit) bReasons.push(`would add ~${(gain ?? 0).toFixed(1)} optimal-lineup pts/wk (rotational value)`);
    if (fillsNeed) bReasons.push(`fills a ${need!.severity.toLowerCase()} ${position} need`);
    if (!plausibleEconomics) bReasons.push("thin on tradeable assets to pay near current price — economics marginal");

    // exclude weak-economics marginal fits with no need
    if (!plausibleEconomics && !fillsNeed && !entersLineup) continue;

    buyers.push({
      manager_id: mid,
      manager_slug: oc.manager_slug,
      fit: entersLineup && fillsNeed && plausibleEconomics ? "HIGH_FIT" : "MODERATE_FIT",
      lineup_gain: gain,
      fills_need: fillsNeed,
      plausible_economics: plausibleEconomics,
      reasons: bReasons,
    });
  }

  buyers.sort((a, b) => (b.lineup_gain ?? 0) - (a.lineup_gain ?? 0) || a.manager_id.localeCompare(b.manager_id));

  const highFit = buyers.filter((b) => b.fit === "HIGH_FIT").length;
  const modFit = buyers.filter((b) => b.fit === "MODERATE_FIT").length;
  const count = buyers.length;

  // ---- classification ----
  let idx: number;
  if (count >= L.bands.very_high) idx = 4;
  else if (count >= L.bands.high) idx = 3;
  else if (count >= L.bands.moderate) idx = 2;
  else if (count >= L.bands.low) idx = 1;
  else idx = 0;

  if (count > 0 && highFit / count >= L.high_fit_fraction_lift && idx < 4) {
    idx += 1;
    reasons.push(`${highFit}/${count} plausible buyers are high-fit → liquidity lifted one band`);
  }
  if (scarcityRatio != null && scarcityRatio < L.scarcity_lift_ratio && idx < 4) {
    idx += 1;
    reasons.push(`position is scarce across the league (startable supply/demand ${scarcityRatio.toFixed(2)}) → liquidity lifted one band`);
  }
  if (marketConf === "VERY_LOW" && idx > 0) {
    idx -= 1;
    reasons.push("current-market perception for this player is very low confidence → liquidity lowered one band");
  }

  const classification = CLASS_ORDER[Math.max(0, Math.min(4, idx))]!;

  reasons.unshift(
    `${count} plausible future buyer(s) if we owned ${name} (${highFit} high-fit, ${modFit} moderate-fit); liquidity ${classification}. This is owner-independent — the current owner's reservation price is NOT used (§9).`,
  );

  return {
    canonical_player_id: pid,
    name,
    position,
    hypothetical_owner: "US_POST_ACQUISITION",
    classification,
    potential_buyers: buyers,
    buyer_count: count,
    high_fit_buyers: highFit,
    moderate_fit_buyers: modFit,
    positional_scarcity_ratio: scarcityRatio,
    market_perception_confidence: marketConf,
    readiness: partial ? "PARTIAL_LIQUIDITY_CONTEXT" : "FULL_LIQUIDITY_CONTEXT",
    reasons,
  };
}

function leagueStartsPosition(ec: CompetitiveTradeEvaluationContext, position: string): boolean {
  const labels = ec.ctx.constraints?.starting_slots ?? [];
  if (labels.length === 0) return position !== "UNKNOWN";
  return labels.some((l) => {
    const u = l.toUpperCase();
    if (u.includes(position)) return true;
    if ((position === "RB" || position === "WR" || position === "TE") && (u.includes("FLEX") || u.includes("W/R") || u.includes("W/R/T"))) return true;
    return false;
  });
}

export function liquidityRank(c: LiquidityClassification): number {
  return CLASS_ORDER.indexOf(c);
}
