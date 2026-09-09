/**
 * Competitive Trade Intelligence — acceptance-likelihood model (Checkpoint C).
 *
 * Replaces the competitive path's misuse of `classifyAcceptance(ourPrivateDelta)`
 * with a COUNTERPARTY-facing model built from THEIR perceived economics:
 *
 *   perceived_incoming_value  = Σ owner_perceived_value of what they receive
 *   perceived_outgoing_reserv. = bundle reservation of what they give up
 *   perceived_surplus         = incoming − outgoing_reservation
 *
 *   internal_score = w1·perceived_surplus + w2·need_relief
 *                  − w3·roster_slot_pressure + w4·structure_fit
 *                  + w5·market_trajectory_adjustment
 *
 *   → likelihood band VERY_LOW | LOW | MODERATE | HIGH   (NOT a probability, no %)
 *
 * Does NOT consume our private edge. Does NOT require opponent actual gain > 0.
 * Explicitly heuristic — `calibration_status: INSUFFICIENT_TRADE_HISTORY`.
 */

import type { OwnerContext } from "./owner-context";
import type { OwnerPerceptionConfig } from "./config";
import type {
  AcceptanceEstimate,
  AcceptanceLikelihood,
  CounterpartyPerceivedLedger,
  OwnerContextReadiness,
  OwnerPerceivedValue,
  ReservationPrice,
  ValueConfidence,
} from "./schema";

const CONF_LEVEL: Record<ValueConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };
const LEVEL_CONF: ValueConfidence[] = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];

function approxPoints(z: number | null): number | null {
  return z == null ? null : Math.round(Math.max(0, Math.min(100, 50 + 15 * z)));
}

export interface BuildAcceptanceInput {
  owner: OwnerContext;
  /** what the owner RECEIVES (our outgoing) — owner-perceived values */
  incoming_to_owner: OwnerPerceivedValue[];
  /** what the owner GIVES UP (our incoming) — one bundled reservation for their side */
  outgoing_from_owner_reservation: ReservationPrice;
  /** name lookup */
  name_of: (id: string) => string;
  /** positions the incoming assets could start for the owner (fills a gap) */
  need_positions_filled: string[];
  /** market trajectory of the incoming assets (rising ⇒ owner more eager) */
  incoming_trajectory_rising: number; // count rising_fast/rising among incoming
  /** net asset count change for the owner (received − surrendered) */
  net_asset_delta: number;
  /** roster is at capacity (a positive net_asset_delta forces drops) */
  roster_at_capacity: boolean;
  /** startable-quality players the owner would be forced to drop */
  forced_drops_startable: number;
  config: OwnerPerceptionConfig;
}

export function buildAcceptanceEstimate(input: BuildAcceptanceInput): AcceptanceEstimate {
  const { owner, incoming_to_owner, outgoing_from_owner_reservation: outRes, config } = input;
  const w = config.acceptance_weights;
  const reasons: string[] = [];

  // ---- perceived ledger ----
  const received = incoming_to_owner.map((p) => ({
    canonical_player_id: p.canonical_player_id,
    name: input.name_of(p.canonical_player_id),
    value: p.owner_perceived_value,
    approx_points: approxPoints(p.owner_perceived_value),
  }));
  const receivedTotal = sumOrNull(received.map((r) => r.value));

  const surrendered = outRes.canonical_player_ids.map((id) => ({
    canonical_player_id: id,
    name: input.name_of(id),
    value: null as number | null, // per-asset reservation not decomposed for the bundle
    approx_points: null as number | null,
  }));
  const surrenderedTotal = outRes.reservation_price;

  const perceivedSurplus =
    receivedTotal != null && surrenderedTotal != null ? round4(receivedTotal - surrenderedTotal) : null;

  const ledger: CounterpartyPerceivedLedger = {
    owner_manager_id: owner.manager_id,
    received: { entries: received, total: receivedTotal },
    surrendered: { entries: surrendered, total: surrenderedTotal },
    perceived_surplus: perceivedSurplus,
  };

  // ---- trade-level adjustments ----
  // need relief: incoming fills a startable gap → they want it more
  const needRelief = round4(Math.min(2, input.need_positions_filled.length) * 0.6);
  if (input.need_positions_filled.length > 0) {
    reasons.push(`incoming assets address the owner's ${input.need_positions_filled.join("/")} gap → need relief +${needRelief.toFixed(2)}`);
  }

  // roster-slot pressure: forced drops of useful players lower acceptance
  let slotPressure = 0;
  if (input.roster_at_capacity && input.net_asset_delta > 0) {
    slotPressure = round4(input.forced_drops_startable * config.slot_pressure_per_forced_drop + Math.max(0, input.net_asset_delta - input.forced_drops_startable) * (config.slot_pressure_per_forced_drop / 2));
    if (slotPressure < -0.05) reasons.push(`owner must drop ${input.net_asset_delta} player(s) to fit the incoming side (${input.forced_drops_startable} startable) → slot pressure ${slotPressure.toFixed(2)}`);
  }

  // structure fit: consolidation vs fragmentation given the owner's depth
  const consolidationCandidate = owner.profile.consolidation_candidate;
  const fragilitySensitive = owner.profile.fragility_sensitive;
  let structureFit = 0;
  if (input.net_asset_delta < 0 && consolidationCandidate) {
    structureFit = 0.3; // they have depth, want fewer-better
    reasons.push("owner has startable depth and would consolidate assets — structure fit favorable");
  } else if (input.net_asset_delta > 0 && fragilitySensitive) {
    structureFit = 0.25; // thin owner wants more bodies
    reasons.push("owner is depth-fragile and would take more usable bodies — structure fit favorable");
  } else if (input.net_asset_delta > 0 && consolidationCandidate) {
    structureFit = -0.2; // deep owner does not want more bench clutter
    reasons.push("owner already has depth — taking more assets is unattractive");
  }

  // market trajectory: rising incoming → more eager
  const trajAdj = round4(Math.min(2, input.incoming_trajectory_rising) * 0.15);

  const internalScore = round4(
    w.perceived_surplus * (perceivedSurplus ?? -0.5) +
      w.need_relief * needRelief +
      w.roster_slot_pressure * slotPressure +
      w.structure_fit * structureFit +
      w.market_trajectory * trajAdj,
  );

  // ---- band ----
  const b = config.acceptance_bands;
  let likelihood: AcceptanceLikelihood;
  if (perceivedSurplus == null && receivedTotal == null) likelihood = "VERY_LOW";
  else if (internalScore >= b.high) likelihood = "HIGH";
  else if (internalScore >= b.moderate) likelihood = "MODERATE";
  else if (internalScore >= b.low) likelihood = "LOW";
  else likelihood = "VERY_LOW";

  // ---- readiness / confidence (distinct from likelihood, §33) ----
  const readiness: OwnerContextReadiness = outRes.readiness;
  const ceiling = config.readiness_confidence_ceiling[readiness] ?? "LOW";
  let level = CONF_LEVEL[ceiling as ValueConfidence];
  if (perceivedSurplus == null) level = Math.max(0, level - 1);
  if (incoming_to_owner.some((p) => p.readiness === "GLOBAL_MARKET_ONLY")) level = Math.max(0, level - 1);
  const anyBehavioral = incoming_to_owner.some((p) => p.components.behavioral_adjustment != null);
  if (!anyBehavioral) reasons.push("no usable transaction history for this owner — behavioral tendencies not modeled (confidence limited)");

  reasons.unshift(
    `their perceived ledger: receive ${fmt(receivedTotal)} · give up ${fmt(surrenderedTotal)} (reservation) · perceived surplus ${fmt(perceivedSurplus)}`,
  );

  return {
    owner_manager_id: owner.manager_id,
    perceived_ledger: ledger,
    likelihood,
    internal_score: internalScore,
    components: {
      perceived_surplus: perceivedSurplus ?? 0,
      need_relief: needRelief,
      roster_slot_pressure: slotPressure,
      structure_fit: structureFit,
      market_trajectory_adjustment: trajAdj,
    },
    confidence: LEVEL_CONF[Math.max(0, Math.min(3, level))]!,
    readiness,
    calibration_status: "INSUFFICIENT_TRADE_HISTORY",
    reasons,
  };
}

function sumOrNull(xs: Array<number | null>): number | null {
  if (xs.some((x) => x == null)) return null;
  return round4((xs as number[]).reduce((s, x) => s + x, 0));
}
function fmt(v: number | null): string {
  return v == null ? "n/a" : v.toFixed(2);
}
function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
