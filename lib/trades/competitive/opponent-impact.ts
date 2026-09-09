/**
 * Competitive Trade Intelligence — opponent ACTUAL roster impact (Checkpoint D).
 *
 * The counterparty's real roster delta according to OUR private models — read
 * straight off the canonical `evaluateTrade` output for that participant. This
 * is NOT their perceived value (Checkpoint C) and NOT their acceptance. It is
 * "how much did this trade actually help (or hurt) them?".
 *
 * Starter improvement and bench/depth improvement are kept separate (§4) — a
 * trade that upgrades a rival's starting lineup costs us more than one that
 * only thickens their bench.
 */

import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { TradeEvaluationOutput } from "../evaluate";
import type { CompetitiveReasonCode, OpponentImpact, WeaknessRepair } from "./schema";

export interface BuildOpponentImpactInput {
  baseline: TradeEvaluationOutput;
  /** the counterparty's manager slug (evaluateTrade keys participants by slug) */
  counterparty_slug: string;
  counterparty_manager_id: string;
  /** ids the counterparty RECEIVES (our outgoing to them) */
  received_ids: string[];
  players_by_id: Map<string, CanonicalPlayer>;
}

export function buildOpponentImpact(input: BuildOpponentImpactInput): OpponentImpact {
  const { baseline, counterparty_slug, received_ids, players_by_id } = input;
  const r =
    baseline.participants[counterparty_slug] ??
    Object.values(baseline.participants).find((p) => p.manager_slug === counterparty_slug);

  const reasons: string[] = [];
  const codes = new Set<CompetitiveReasonCode>();

  if (!r) {
    return {
      owner_manager_id: input.counterparty_manager_id,
      private_delta: null,
      starter_delta: null,
      bench_delta: null,
      ros_delta: null,
      fragility_delta: null,
      needs_improved: [],
      needs_worsened: [],
      weakness_repair: "NONE",
      weakness_repair_positions: [],
      reason_codes: [],
      reasons: ["counterparty not found in the trade evaluation"],
    };
  }

  const privateDelta = r.phase2 ? r.phase2.contextual_utility_delta : r.roster_utility_delta;
  const starterDelta = r.starter_points_delta;
  const benchDelta = r.bench_value_delta;
  const rosDelta = r.phase2?.components.ros_usable_value ?? null;
  const fragilityDelta = r.phase2?.depth.fragility_delta ?? r.phase2?.components.roster_fragility ?? null;

  const needsImproved = r.positional_need_changes.filter((c) => c.kind === "IMPROVES_NEED").map((c) => c.position);
  const needsWorsened = r.positional_need_changes
    .filter((c) => c.kind === "WORSENS_POSITION" || c.kind === "CREATES_NEW_WEAKNESS")
    .map((c) => c.position);

  // ---- weakness repair: did we hand them a fix for a real hole? ----
  const receivedPositions = new Set<string>(
    received_ids.map((id) => (players_by_id.get(id)?.position ?? "") as string).filter(Boolean),
  );
  const enteredStarting = new Set(r.lineup_displacement.entered_starting_lineup);
  const receivedEnteredStarting = received_ids.some((id) => enteredStarting.has(id));

  let weaknessRepair: WeaknessRepair = "NONE";
  const repairPositions: string[] = [];

  // a need that improved AND was critical/weak before AND at a position we sent them
  for (const c of r.positional_need_changes) {
    if (c.kind !== "IMPROVES_NEED") continue;
    if (!receivedPositions.has(c.position)) continue;
    const beforeBad = c.before_severity === "critical" || c.before_severity === "weak";
    if (!beforeBad) continue;
    repairPositions.push(c.position);
    if (c.before_severity === "critical" && rankAbove(weaknessRepair, "CRITICAL_WEAKNESS_REPAIRED")) {
      weaknessRepair = "CRITICAL_WEAKNESS_REPAIRED";
    } else if (rankAbove(weaknessRepair, "HIGH_NEED_REPAIRED")) {
      weaknessRepair = "HIGH_NEED_REPAIRED";
    }
  }
  if (weaknessRepair === "NONE" && receivedEnteredStarting && (starterDelta ?? 0) > 1) {
    weaknessRepair = "STARTER_HOLE_FILLED";
    for (const id of received_ids) if (enteredStarting.has(id)) repairPositions.push(players_by_id.get(id)?.position ?? "?");
  }
  if (weaknessRepair === "NONE" && (benchDelta > 1 || (privateDelta > 0 && (starterDelta ?? 0) <= 1))) {
    // they got value but it went to depth, not a starting hole
    weaknessRepair = (starterDelta ?? 0) <= 0.5 ? "SURPLUS_REINFORCED" : "DEPTH_ADDED";
  }

  // ---- reason codes ----
  if (privateDelta < -0.25) {
    codes.add("OPPONENT_ACTUALLY_WEAKENED");
    reasons.push(`the trade actually WEAKENS ${counterparty_slug} by ${privateDelta.toFixed(2)} (our models) — favorable for us`);
  } else {
    if ((starterDelta ?? 0) > 0.5) {
      codes.add("OPPONENT_STARTER_GAIN");
      reasons.push(`${counterparty_slug}'s starting lineup improves by ${(starterDelta ?? 0).toFixed(1)} pts/wk`);
    }
    if (benchDelta > 0.5 && (starterDelta ?? 0) <= 0.5) {
      codes.add("OPPONENT_DEPTH_GAIN");
      reasons.push(`${counterparty_slug}'s gain is bench/depth, not starting lineup`);
    }
  }
  if (weaknessRepair === "CRITICAL_WEAKNESS_REPAIRED") { codes.add("CRITICAL_WEAKNESS_REPAIRED"); reasons.push(`fixes ${counterparty_slug}'s CRITICAL hole at ${[...new Set(repairPositions)].join("/")}`); }
  else if (weaknessRepair === "HIGH_NEED_REPAIRED") { codes.add("HIGH_NEED_REPAIRED"); reasons.push(`fixes ${counterparty_slug}'s weak spot at ${[...new Set(repairPositions)].join("/")}`); }
  else if (weaknessRepair === "STARTER_HOLE_FILLED") { codes.add("STARTER_HOLE_FILLED"); }
  else if (weaknessRepair === "SURPLUS_REINFORCED") { codes.add("SURPLUS_REINFORCED"); reasons.push(`the asset lands on a position ${counterparty_slug} is already deep at`); }

  return {
    owner_manager_id: input.counterparty_manager_id,
    private_delta: round4(privateDelta),
    starter_delta: starterDelta == null ? null : round4(starterDelta),
    bench_delta: round4(benchDelta),
    ros_delta: rosDelta == null ? null : round4(rosDelta),
    fragility_delta: fragilityDelta == null ? null : round4(fragilityDelta),
    needs_improved: needsImproved,
    needs_worsened: needsWorsened,
    weakness_repair: weaknessRepair,
    weakness_repair_positions: [...new Set(repairPositions)],
    reason_codes: [...codes],
    reasons,
  };
}

const REPAIR_RANK: Record<WeaknessRepair, number> = {
  CRITICAL_WEAKNESS_REPAIRED: 5,
  HIGH_NEED_REPAIRED: 4,
  STARTER_HOLE_FILLED: 3,
  DEPTH_ADDED: 2,
  SURPLUS_REINFORCED: 1,
  NONE: 0,
};
function rankAbove(current: WeaknessRepair, candidate: WeaknessRepair): boolean {
  return REPAIR_RANK[candidate] > REPAIR_RANK[current];
}

function round4(v: number): number {
  const x = Math.round(v * 10000) / 10000;
  return x === 0 ? 0 : x;
}
