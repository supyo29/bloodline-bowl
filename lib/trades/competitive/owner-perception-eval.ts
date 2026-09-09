/**
 * Competitive Trade Intelligence — Checkpoint C orchestrator.
 *
 * Ties owner-context → owner-perceived value → reservation price → acceptance
 * for ONE counterparty of a proposed trade. Consumed additively by
 * `evaluateCompetitiveTrade`.
 */

import { buildMarketConsensus } from "@/lib/draft/market";
import type { TradeAnalysisContext } from "../context";
import type { LeagueMarketEdgeTable } from "./evaluate";
import type { MarketEdge } from "./schema";
import { makeOwnerContextCache, type OwnerContext } from "./owner-context";
import { buildOwnerPerceivedValues } from "./owner-perception";
import { buildReservationPrice } from "./reservation";
import { buildAcceptanceEstimate } from "./acceptance";
import {
  resolveOwnerPerceptionConfig,
  type OwnerPerceptionConfig,
  type PartialOwnerPerceptionConfig,
} from "./config";
import type {
  AcceptanceEstimate,
  MarketTrajectory,
  OwnerPerceivedValue,
  OwnerPerceptionBlock,
  ValueConfidence,
} from "./schema";

const CONF_LEVEL: Record<ValueConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };
const LEVEL_CONF: ValueConfidence[] = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];

export interface CounterpartySpec {
  manager_id: string;
  /** ids the counterparty RECEIVES (our outgoing to them) */
  receives: string[];
  /** ids the counterparty GIVES UP (our incoming from them) */
  gives: string[];
}

export interface OwnerPerceptionEvalInput {
  ctx: TradeAnalysisContext;
  table: LeagueMarketEdgeTable;
  /** dynamic (B.5) edges keyed by player id — for global market value + trajectory */
  dynamic_edges: Map<string, MarketEdge>;
  counterparty: CounterpartySpec;
  config?: PartialOwnerPerceptionConfig;
  owner_context_cache?: (managerId: string) => OwnerContext;
}

export interface OwnerPerceptionEvalResult {
  owner_perception: OwnerPerceptionBlock;
  acceptance: AcceptanceEstimate;
}

export function evaluateOwnerPerception(input: OwnerPerceptionEvalInput): OwnerPerceptionEvalResult {
  const { ctx, counterparty } = input;
  const config: OwnerPerceptionConfig = resolveOwnerPerceptionConfig(input.config);
  const ownerCache = input.owner_context_cache ?? makeOwnerContextCache(ctx);
  const owner = ownerCache(counterparty.manager_id);

  const meaningfulGames = ctx.week <= 1 ? 0 : 0; // no 2026 in-season data live — B.5 established PRESEASON_ONLY

  // ---- global market value (B.5 dynamic proxy) + trajectory + ADP rank ----
  const globalMarketZ = new Map<string, number | null>();
  const trajectory = new Map<string, MarketTrajectory>();
  const adpRank = new Map<string, number | null>();
  const consensus = buildMarketConsensus({ referenceDate: ctx.snapshot.captured_at });

  const allIds = [...new Set([...counterparty.receives, ...counterparty.gives])];
  // include the whole counterparty roster so within-position normalization of
  // draft cost / ADP rank has a real distribution
  const normIds = new Set<string>([...allIds, ...owner.by_player.keys()]);
  for (const id of normIds) {
    const dyn = input.dynamic_edges.get(id) ?? input.table.edges.by_player.get(id);
    const gm = dyn?.edge_score != null && dyn.market_value?.normalized_value != null
      ? dyn.market_value.normalized_value // fall back to the B market z
      : (dyn?.market_value?.normalized_value ?? null);
    // prefer the B.5 dynamic current-market proxy expressed as the market side of the edge
    globalMarketZ.set(id, dyn?.market_value?.normalized_value ?? gm);
    trajectory.set(id, dyn?.market_trajectory ?? "UNKNOWN");
    const p = ctx.players_by_id.get(id);
    const sleeperId = p?.identifiers.sleeper_id ?? null;
    const cRow = sleeperId ? consensus.by_player.get(sleeperId) ?? null : null;
    if (cRow?.position) {
      const rank = [...consensus.by_player.values()]
        .filter((r) => r.position === cRow.position)
        .sort((a, b) => a.expected_pick - b.expected_pick)
        .findIndex((r) => r.sleeper_id === sleeperId);
      adpRank.set(id, rank >= 0 ? rank + 1 : null);
    } else {
      adpRank.set(id, null);
    }
  }

  // ---- owner-perceived value for every player in the trade ----
  const perceived: Map<string, OwnerPerceivedValue> = buildOwnerPerceivedValues({
    owner,
    player_ids: allIds,
    global_market_z: globalMarketZ,
    market_trajectory: trajectory,
    adp_position_rank: adpRank,
    meaningful_games: meaningfulGames,
    config,
  });

  const receivesPerceived = counterparty.receives.map((id) => perceived.get(id)!).filter(Boolean);
  // ---- reservation for what the counterparty gives up (one bundle) ----
  const reservation = buildReservationPrice({
    ctx,
    owner,
    outgoing_ids: counterparty.gives,
    perceived,
    config,
  });

  // ---- trade-level acceptance ----
  const needPositions = new Set(
    owner.profile.needs.filter((n) => n.severity === "CRITICAL" || n.severity === "HIGH").map((n) => n.position),
  );
  const filledPositions = [
    ...new Set(
      counterparty.receives
        .map((id) => ctx.players_by_id.get(id)?.position ?? "")
        .filter((pos) => needPositions.has(pos)),
    ),
  ];
  const risingIncoming = counterparty.receives.filter((id) => {
    const t = trajectory.get(id);
    return t === "RISING" || t === "RISING_FAST";
  }).length;

  const netAssetDelta = counterparty.receives.length - counterparty.gives.length;
  const rosterSize = owner.roster?.all_players.length ?? 0;
  const capacity = ctx.constraints.active_roster_capacity ?? ctx.constraints.roster_size_limit ?? rosterSize;
  const rosterAtCapacity = rosterSize >= capacity;
  // forced drops = net gain; of those, how many would be startable-quality is
  // estimated as the number of the owner's current bench players at startable VOR
  const forcedDropsStartable = Math.max(
    0,
    Math.min(
      netAssetDelta,
      [...owner.by_player.values()].filter((pc) => pc.starter_importance === "ROTATIONAL").length,
    ),
  );

  const acceptance = buildAcceptanceEstimate({
    owner,
    incoming_to_owner: receivesPerceived,
    outgoing_from_owner_reservation: reservation,
    name_of: (id) => ctx.players_by_id.get(id)?.full_name ?? id,
    need_positions_filled: filledPositions,
    incoming_trajectory_rising: risingIncoming,
    net_asset_delta: netAssetDelta,
    roster_at_capacity: rosterAtCapacity,
    forced_drops_startable: forcedDropsStartable,
    config,
  });

  // ---- assemble the block ----
  const perceivedIncoming = sumOrNull(receivesPerceived.map((p) => p.owner_perceived_value));
  const perceivedOutgoingReservation = reservation.reservation_price;
  const perceivedSurplus =
    perceivedIncoming != null && perceivedOutgoingReservation != null
      ? round4(perceivedIncoming - perceivedOutgoingReservation)
      : null;

  const readiness = worstReadiness([
    ...receivesPerceived.map((p) => p.readiness),
    reservation.readiness,
  ]);

  const blockConf = LEVEL_CONF[
    Math.max(
      0,
      Math.min(
        CONF_LEVEL[reservation.confidence],
        ...receivesPerceived.map((p) => CONF_LEVEL[p.confidence]),
      ),
    )
  ]!;

  const owner_perception: OwnerPerceptionBlock = {
    counterparty_id: counterparty.manager_id,
    readiness,
    perceived_asset_values: [...perceived.values()],
    reservation: [reservation],
    perceived_incoming_value: perceivedIncoming,
    perceived_outgoing_reservation: perceivedOutgoingReservation,
    perceived_surplus: perceivedSurplus,
    confidence: blockConf,
    reasons: [
      `owner-perceived value = global market + this manager's draft anchor / starter importance / salience modifiers — NOT their reservation price and NOT our private value`,
      ...(readiness === "GLOBAL_MARKET_ONLY" ? ["owner roster/draft context missing — values are NOT owner-specific"] : []),
    ],
  };

  return { owner_perception, acceptance };
}

function sumOrNull(xs: Array<number | null>): number | null {
  if (xs.length === 0 || xs.some((x) => x == null)) return null;
  return round4((xs as number[]).reduce((s, x) => s + x, 0));
}
function worstReadiness(rs: OwnerPerceptionBlock["readiness"][]): OwnerPerceptionBlock["readiness"] {
  const order = ["FULL_OWNER_CONTEXT", "PARTIAL_OWNER_CONTEXT", "GLOBAL_MARKET_ONLY", "STALE", "UNAVAILABLE"];
  return rs.reduce((worst, r) => (order.indexOf(r) > order.indexOf(worst) ? r : worst), "FULL_OWNER_CONTEXT" as OwnerPerceptionBlock["readiness"]);
}
function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
