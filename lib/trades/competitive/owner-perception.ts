/**
 * Competitive Trade Intelligence — owner-perceived value (Checkpoint C).
 *
 *   owner_perceived_value = global_current_market
 *     + personal_draft_anchor_adjustment      (their pick vs ADP, decayed by games — HEURISTIC)
 *     + starter_importance_adjustment          (locked starter → +, deep bench → −)
 *     + recent_performance_salience            (market trajectory; ~0 at week 1)
 *     + name_salience_adjustment               (very high market rank → small +)
 *     + behavioral_adjustment                  (null — 1 real trade, insufficient history)
 *
 * Owner-perceived value is NOT the owner's reservation price (§4) and NOT our
 * private value. Every component is bounded and exposed.
 */

import { normalizeWithinPosition, type RawPoint } from "./normalize";
import type { OwnerPerceptionConfig } from "./config";
import type { OwnerContext } from "./owner-context";
import type {
  DraftAnchorInfo,
  DraftAnchorState,
  MarketTrajectory,
  OwnerContextReadiness,
  OwnerPerceivedValue,
  ValueConfidence,
} from "./schema";

const CONF_LEVEL: Record<ValueConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };
const LEVEL_CONF: ValueConfidence[] = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];

/** Personal-anchor weight: base(state) × exp(−λ·g). λ deliberately < season-maturity. */
export function draftAnchorWeight(state: DraftAnchorState, meaningfulGames: number, config: OwnerPerceptionConfig): number {
  const base = config.draft_anchor_base_weight[state] ?? 0;
  return round4(base * Math.exp(-config.draft_anchor_decay_lambda * Math.max(0, meaningfulGames)));
}

function anchorStateFromReach(reachDeltaZ: number | null, config: OwnerPerceptionConfig): DraftAnchorState {
  if (reachDeltaZ == null) return "UNKNOWN";
  const t = config.anchor_state_thresholds;
  if (reachDeltaZ >= t.strong) return "STRONG_ANCHOR";
  if (reachDeltaZ >= t.moderate) return "MODERATE_ANCHOR";
  if (reachDeltaZ >= t.weak) return "WEAK_ANCHOR";
  return "MINIMAL_ANCHOR";
}

export interface BuildOwnerPerceivedInput {
  owner: OwnerContext;
  /** the players to value (any subset of the owner's roster; ids not on the roster get GLOBAL_MARKET_ONLY) */
  player_ids: string[];
  /** global current-market value per player (B.5 dynamic proxy, z within position). */
  global_market_z: Map<string, number | null>;
  /** market trajectory per player (B.5) — for salience */
  market_trajectory: Map<string, MarketTrajectory>;
  /** ADP-implied preseason position rank per player (for draft reach) */
  adp_position_rank: Map<string, number | null>;
  /** meaningful games observed (drives anchor decay) */
  meaningful_games: number;
  config: OwnerPerceptionConfig;
}

export function buildOwnerPerceivedValues(input: BuildOwnerPerceivedInput): Map<string, OwnerPerceivedValue> {
  const { owner, config } = input;
  const out = new Map<string, OwnerPerceivedValue>();

  // draft-cost z within position, across THIS owner's drafted players
  const draftPoints: RawPoint[] = [];
  for (const [id, pc] of owner.by_player) {
    draftPoints.push({ canonical_player_id: id, position: pc.position, raw: pc.draft_pick == null ? null : -pc.draft_pick });
  }
  const draftZ = normalizeWithinPosition(draftPoints).by_player;

  // ADP-implied rank z within position (for the reach delta), across the same players
  const adpPoints: RawPoint[] = [];
  for (const [id, pc] of owner.by_player) {
    const r = input.adp_position_rank.get(id) ?? null;
    adpPoints.push({ canonical_player_id: id, position: pc.position, raw: r == null ? null : -r });
  }
  const adpZ = normalizeWithinPosition(adpPoints).by_player;

  // per-position "startable" replacement z on the owner's roster (weakest startable)
  const weakestStartableZ = new Map<string, number>();
  for (const pc of owner.by_player.values()) {
    if (["ROTATIONAL", "FLEX_STARTER", "REGULAR_STARTER", "LOCKED_STARTER"].includes(pc.starter_importance)) {
      const cur = weakestStartableZ.get(pc.position);
      const gm = input.global_market_z.get(pc.canonical_player_id) ?? null;
      if (gm != null && (cur == null || gm < cur)) weakestStartableZ.set(pc.position, gm);
    }
  }

  for (const id of input.player_ids) {
    const pc = owner.by_player.get(id);
    const gm = input.global_market_z.get(id) ?? null;
    const position = pc?.position ?? "UNKNOWN";
    const reasons: string[] = [];

    // ---- owner context entirely unavailable ⇒ GLOBAL_MARKET_ONLY (§30/§31) ----
    if (!owner.available) {
      out.set(id, {
        canonical_player_id: id,
        owner_manager_id: owner.manager_id,
        global_market_value: gm,
        owner_perceived_value: gm,
        components: emptyComponents(gm ?? 0),
        starter_importance: "UNKNOWN",
        draft_anchor: unknownAnchor(),
        readiness: "UNAVAILABLE",
        confidence: "VERY_LOW",
        reasons: ["owner context unavailable — no owner-specific valuation"],
      });
      continue;
    }

    // ---- PROSPECTIVE asset (they'd RECEIVE it — not on their roster) ----
    if (!pc) {
      const caps = config.perceived_component_caps;
      const posRepl = weakestStartableZ.get(position) ?? null;
      // would-he-start bump: a player the market rates well above their weakest
      // startable at the position gets a modest "he'd help us" premium
      let prospBump = 0;
      if (gm != null && posRepl != null) prospBump = clamp((gm - posRepl) * 0.18, 0, caps.starter_importance);
      else if (gm != null && gm >= 0.6) prospBump = clamp((gm - 0.6) * 0.12, 0, caps.starter_importance * 0.5);
      const traj = input.market_trajectory.get(id) ?? "UNKNOWN";
      const salBump = traj === "RISING_FAST" ? caps.recent_salience : traj === "RISING" ? caps.recent_salience * 0.5 : 0;
      const perceived = gm == null ? null : round4(gm + prospBump + salBump);
      if (prospBump > 0.05) reasons.push(`incoming asset the owner would likely start — perceived-value bump +${prospBump.toFixed(2)}`);
      out.set(id, {
        canonical_player_id: id,
        owner_manager_id: owner.manager_id,
        global_market_value: gm,
        owner_perceived_value: perceived,
        components: {
          global_market_baseline: gm ?? 0,
          personal_draft_anchor_adjustment: 0, // they didn't draft him — no anchor
          starter_importance_adjustment: round4(prospBump),
          recent_performance_salience: round4(salBump),
          name_salience_adjustment: 0,
          behavioral_adjustment: null,
        },
        starter_importance: prospBump > 0.2 ? "REGULAR_STARTER" : "ROTATIONAL",
        draft_anchor: unknownAnchor(),
        readiness: "PARTIAL_OWNER_CONTEXT",
        confidence: gm == null ? "VERY_LOW" : "LOW",
        reasons: [
          "prospective incoming asset — owner-perceived value = global market + would-he-start premium (no personal draft anchor; they don't own him)",
          ...reasons,
        ],
      });
      continue;
    }

    const readiness: OwnerContextReadiness =
      pc.draft_round == null && owner.readiness_notes.some((n) => n.includes("draft"))
        ? "PARTIAL_OWNER_CONTEXT"
        : "FULL_OWNER_CONTEXT";

    const caps = config.perceived_component_caps;

    // ---- draft anchor ----
    const draftPosZ = draftZ.get(id)?.normalized_value ?? null;
    const adpPosZ = adpZ.get(id)?.normalized_value ?? null;
    const reachDelta = draftPosZ != null && adpPosZ != null ? round4(draftPosZ - adpPosZ) : null;
    const anchorState = anchorStateFromReach(reachDelta, config);
    const anchorWeight = draftAnchorWeight(anchorState, input.meaningful_games, config);
    // attachment only ADDS value for a reach; a bargain (negative reach) contributes ~0
    let anchorAdj = 0;
    if (reachDelta != null) {
      anchorAdj = clamp(config.draft_reach_gain * Math.max(-0.3, reachDelta) * anchorWeight, -caps.draft_anchor * 0.5, caps.draft_anchor);
    }
    const anchor: DraftAnchorInfo = {
      league_draft_round: pc.draft_round,
      league_draft_pick: pc.draft_pick,
      draft_position_z: draftPosZ,
      market_adp_position_rank_at_draft: input.adp_position_rank.get(id) ?? null,
      draft_reach_delta: reachDelta,
      anchor_state: anchorState,
      anchor_weight: anchorWeight,
      calibration_status: "HEURISTIC",
    };
    if (Math.abs(anchorAdj) > 0.05) {
      reasons.push(
        anchorAdj > 0
          ? `drafted ${roundLabel(pc.draft_round)} — ${anchorState.replace("_", " ").toLowerCase()} (reach ${reachDelta?.toFixed(2)} z, weight ${anchorWeight.toFixed(2)}) adds +${anchorAdj.toFixed(2)}`
          : `drafted late relative to market — minimal sunk-cost attachment (${anchorAdj.toFixed(2)})`,
      );
    }

    // ---- starter importance ----
    const impMap: Record<string, number> = {
      LOCKED_STARTER: caps.starter_importance,
      REGULAR_STARTER: caps.starter_importance * 0.6,
      FLEX_STARTER: caps.starter_importance * 0.3,
      ROTATIONAL: 0.05,
      BENCH_DEPTH: -caps.starter_importance * 0.3,
      IR: -caps.starter_importance * 0.5,
      UNKNOWN: 0,
    };
    const starterAdj = clamp(impMap[pc.starter_importance] ?? 0, -caps.starter_importance, caps.starter_importance);
    if (Math.abs(starterAdj) > 0.05) {
      reasons.push(`${pc.starter_importance.replace("_", " ").toLowerCase()} for this owner (${starterAdj > 0 ? "+" : ""}${starterAdj.toFixed(2)})`);
    }

    // ---- recent performance salience (market trajectory) ----
    const traj = input.market_trajectory.get(id) ?? "UNKNOWN";
    const salMap: Record<MarketTrajectory, number> = {
      RISING_FAST: caps.recent_salience,
      RISING: caps.recent_salience * 0.5,
      STABLE: 0,
      FALLING: -caps.recent_salience * 0.5,
      FALLING_FAST: -caps.recent_salience,
      UNKNOWN: 0,
    };
    const salienceAdj = clamp(salMap[traj], -caps.recent_salience, caps.recent_salience);
    if (Math.abs(salienceAdj) > 0.05) reasons.push(`market trajectory ${traj} — owner salience ${salienceAdj > 0 ? "+" : ""}${salienceAdj.toFixed(2)}`);

    // ---- name salience (a top-of-position player carries extra perceived value) ----
    const nameAdj = gm != null && gm >= 1.2 ? clamp((gm - 1.2) * 0.15, 0, caps.name_salience) : 0;

    const components = {
      global_market_baseline: gm ?? 0,
      personal_draft_anchor_adjustment: round4(anchorAdj),
      starter_importance_adjustment: round4(starterAdj),
      recent_performance_salience: round4(salienceAdj),
      name_salience_adjustment: round4(nameAdj),
      behavioral_adjustment: null, // insufficient transaction history (1 real trade)
    };

    const perceived =
      gm == null ? null : round4(gm + anchorAdj + starterAdj + salienceAdj + nameAdj);

    // ---- confidence ----
    const ceiling = config.readiness_confidence_ceiling[readiness] ?? "LOW";
    let level = CONF_LEVEL[ceiling as ValueConfidence];
    if (gm == null) level = 0;
    if (anchorState === "UNKNOWN") level = Math.max(0, level - 1);
    if (input.meaningful_games === 0) reasons.push("week-1 owner perception is still materially anchored to draft price — current-performance salience minimal");

    out.set(id, {
      canonical_player_id: id,
      owner_manager_id: owner.manager_id,
      global_market_value: gm,
      owner_perceived_value: perceived,
      components,
      starter_importance: pc.starter_importance,
      draft_anchor: anchor,
      readiness,
      confidence: LEVEL_CONF[Math.max(0, Math.min(3, level))]!,
      reasons,
    });
  }

  return out;
}

function emptyComponents(baseline: number) {
  return {
    global_market_baseline: baseline,
    personal_draft_anchor_adjustment: 0,
    starter_importance_adjustment: 0,
    recent_performance_salience: 0,
    name_salience_adjustment: 0,
    behavioral_adjustment: null,
  };
}
function unknownAnchor(): DraftAnchorInfo {
  return {
    league_draft_round: null,
    league_draft_pick: null,
    draft_position_z: null,
    market_adp_position_rank_at_draft: null,
    draft_reach_delta: null,
    anchor_state: "UNKNOWN",
    anchor_weight: 0,
    calibration_status: "DEFAULT_PRIOR",
  };
}
function roundLabel(r: number | null): string {
  return r == null ? "(pick unknown)" : `round ${r}`;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
}
function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
