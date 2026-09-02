/**
 * Weekly optimal-lineup engine.
 *
 * Solves the valid starting-lineup ASSIGNMENT problem for a league's actual
 * roster rules (base slots + FLEX/SUPERFLEX eligibility) — it does NOT just sort
 * players by projected points. Max-weight bipartite matching (Hungarian) over
 * `slots × rostered players`, weight = weekly projected points, ineligible pairs
 * excluded. Deterministic: ties broken by canonical id, then roster order.
 *
 * A player on bye / ruled out is still *eligible* for a slot (a real 0 beats an
 * empty slot), but the optimizer avoids them whenever a projected option exists.
 */

import type { CanonicalPlayer, CanonicalRoster } from "@/lib/canonical/schema";
import { decisionConfidence } from "./uncertainty";
import type {
  Confidence,
  RosterConstraints,
  WeeklyProjection,
  WeeklyProjectionBatch,
  WeeklyWarning,
} from "./schema";

const FLEX_ELIGIBILITY: Record<string, string[]> = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  WRRB_WRT: ["RB", "WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  SUPERFLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
};

export function slotEligiblePositions(slot: string): string[] {
  if (FLEX_ELIGIBILITY[slot]) return FLEX_ELIGIBILITY[slot]!;
  return [slot];
}

export function isEligible(slot: string, player: CanonicalPlayer): boolean {
  const allowed = slotEligiblePositions(slot);
  if (allowed.includes(player.position)) return true;
  return player.eligible_positions.some((p) => allowed.includes(p));
}

export interface SlotRecommendation {
  slot: string;
  slot_index: number;
  recommended_player_id: string | null;
  recommended_projected: number | null;
  recommended_floor: number | null;
  recommended_ceiling: number | null;
  current_player_id: string | null;
  current_projected: number | null;
  projection_difference: number | null;
  is_change: boolean;
  confidence: Confidence;
  reason: string;
}

export interface LineupResult {
  week: number;
  slots: SlotRecommendation[];
  optimal_total: number;
  current_total: number;
  points_left_on_bench: number;
  lineup_efficiency: number | null;
  changes_recommended: Array<{ slot: string; out: string | null; in: string; gain: number }>;
  projected_points_gained: number;
  injury_risks: Array<{ canonical_player_id: string; slot: string | null; injury_status: string; expected_availability: number }>;
  bye_problems: Array<{ canonical_player_id: string; slot: string }>;
  empty_slots: string[];
  illegal_situations: string[];
  unprojected_starters: string[];
  warnings: WeeklyWarning[];
}

interface BuildInput {
  week: number;
  roster: CanonicalRoster;
  constraints: RosterConstraints;
  players: Map<string, CanonicalPlayer>;
  projections: WeeklyProjectionBatch;
}

export function buildOptimalLineup(input: BuildInput): LineupResult {
  const { week, roster, constraints, players, projections } = input;
  const warnings: WeeklyWarning[] = [];

  const slots = constraints.starting_slots;
  // Lineup candidates: everything rostered that is NOT on IR/taxi.
  const irSet = new Set(roster.ir);
  const taxiSet = new Set(roster.taxi);
  const candidateIds = roster.all_players.filter((id) => !irSet.has(id) && !taxiSet.has(id));

  const proj = (id: string): WeeklyProjection | null => projections.by_player.get(id) ?? null;
  const points = (id: string): number => {
    const p = proj(id);
    if (!p) return 0;
    if (p.projection_status === "bye") return 0;
    return p.projected_points ?? 0;
  };

  // Stable candidate order for deterministic tie-breaking.
  const orderIndex = new Map(candidateIds.map((id, i) => [id, i]));
  const cand = [...candidateIds].sort((a, b) => (orderIndex.get(a)! - orderIndex.get(b)!));

  // Weight matrix: rows = slots, cols = candidates. -Inf when ineligible.
  const NEG = Number.NEGATIVE_INFINITY;
  const weight: number[][] = slots.map((slot) =>
    cand.map((id) => {
      const pl = players.get(id);
      if (!pl || !isEligible(slot, pl)) return NEG;
      return points(id);
    }),
  );

  const assignment = hungarianMaxWeight(weight);

  // Current lineup from the canonical roster's starting slots.
  const currentBySlotIndex = new Map<number, string | null>();
  let si = 0;
  for (const s of roster.slots) {
    if (["BN", "IR", "TAXI"].includes(s.slot)) continue;
    currentBySlotIndex.set(si, s.is_empty ? null : s.canonical_player_id);
    si += 1;
  }

  const usedRecommended = new Set<string>();
  const slotRecs: SlotRecommendation[] = slots.map((slot, i) => {
    const recIdx = assignment[i];
    const recId = recIdx != null && recIdx >= 0 && weight[i]![recIdx] !== NEG ? cand[recIdx]! : null;
    if (recId) usedRecommended.add(recId);
    const curId = currentBySlotIndex.get(i) ?? null;

    const recP = recId ? proj(recId) : null;
    const curP = curId ? proj(curId) : null;
    const recPts = recId ? points(recId) : null;
    const curPts = curId ? points(curId) : null;

    const diff = recPts != null && curPts != null ? round2(recPts - curPts) : null;
    const isChange = Boolean(recId && recId !== curId);

    const confidence = decisionConfidence({
      edge: diff ?? 0,
      std_dev_a: recP?.std_dev ?? null,
      std_dev_b: curP?.std_dev ?? null,
      incomplete: (recId != null && recP?.projected_points == null) || (curId != null && curP?.projected_points == null),
      uncertainty_is_heuristic:
        recP?.uncertainty_source === "position_volatility_heuristic" ||
        curP?.uncertainty_source === "position_volatility_heuristic",
    });

    return {
      slot,
      slot_index: i,
      recommended_player_id: recId,
      recommended_projected: recP?.projected_points ?? null,
      recommended_floor: recP?.floor_points ?? null,
      recommended_ceiling: recP?.ceiling_points ?? null,
      current_player_id: curId,
      current_projected: curP?.projected_points ?? null,
      projection_difference: diff,
      is_change: isChange,
      confidence,
      reason: lineupReason({ slot, recId, curId, recP, curP, diff, isChange }),
    };
  });

  const optimal_total = round2(slotRecs.reduce((s, r) => s + (r.recommended_projected ?? 0), 0));
  const current_total = round2(slotRecs.reduce((s, r) => s + (r.current_projected ?? 0), 0));
  const points_left_on_bench = round2(Math.max(0, optimal_total - current_total));

  const changes = slotRecs
    .filter((r) => r.is_change && (r.projection_difference ?? 0) > 0)
    .map((r) => ({
      slot: r.slot,
      out: r.current_player_id,
      in: r.recommended_player_id!,
      gain: r.projection_difference ?? 0,
    }))
    .sort((a, b) => b.gain - a.gain);

  const injury_risks = slotRecs
    .filter((r) => r.recommended_player_id)
    .map((r) => ({ id: r.recommended_player_id!, slot: r.slot, p: proj(r.recommended_player_id!) }))
    .filter((x) => x.p && (x.p.expected_availability < 0.95 || (x.p.injury_status && x.p.injury_status.toLowerCase() !== "active")))
    .map((x) => ({
      canonical_player_id: x.id,
      slot: x.slot,
      injury_status: x.p!.injury_status ?? "questionable",
      expected_availability: x.p!.expected_availability,
    }));

  const bye_problems = slotRecs
    .filter((r) => r.recommended_player_id && proj(r.recommended_player_id!)?.projection_status === "bye")
    .map((r) => ({ canonical_player_id: r.recommended_player_id!, slot: r.slot }));

  const empty_slots = slotRecs.filter((r) => !r.recommended_player_id).map((r) => r.slot);

  // Legality of the CURRENT lineup.
  const illegal: string[] = [];
  const seenCurrent = new Map<string, number>();
  slotRecs.forEach((r, i) => {
    if (!r.current_player_id) return;
    seenCurrent.set(r.current_player_id, (seenCurrent.get(r.current_player_id) ?? 0) + 1);
    const pl = players.get(r.current_player_id);
    if (pl && !isEligible(r.slot, pl)) {
      illegal.push(`current starter ${pl.full_name} is not eligible for slot ${r.slot} (#${i + 1}).`);
    }
    const cp = proj(r.current_player_id);
    if (cp?.projection_status === "bye") illegal.push(`current starter in slot ${r.slot} is on bye this week.`);
  });
  for (const [id, n] of seenCurrent) {
    if (n > 1) illegal.push(`player ${id} is started in ${n} slots simultaneously.`);
  }

  const unprojected_starters = slotRecs
    .filter((r) => r.current_player_id && proj(r.current_player_id!)?.projected_points == null)
    .map((r) => r.current_player_id!);
  if (unprojected_starters.length > 0) {
    warnings.push({
      code: "starter_projection_missing",
      message: `${unprojected_starters.length} current starter(s) have no weekly projection (treated as 0 for the optimizer, flagged not zeroed in outputs).`,
      severity: "warning",
    });
  }

  return {
    week,
    slots: slotRecs,
    optimal_total,
    current_total,
    points_left_on_bench,
    lineup_efficiency: optimal_total > 0 ? Math.round((current_total / optimal_total) * 1000) / 1000 : null,
    changes_recommended: changes,
    projected_points_gained: round2(changes.reduce((s, c) => s + c.gain, 0)),
    injury_risks,
    bye_problems,
    empty_slots,
    illegal_situations: illegal,
    unprojected_starters,
    warnings,
  };
}

function lineupReason(x: {
  slot: string;
  recId: string | null;
  curId: string | null;
  recP: WeeklyProjection | null;
  curP: WeeklyProjection | null;
  diff: number | null;
  isChange: boolean;
}): string {
  if (!x.recId) return `no rostered player is eligible for ${x.slot} — empty slot.`;
  if (!x.isChange) return `keep current ${x.slot} (${fmt(x.recP?.projected_points)} projected).`;
  const gain = x.diff != null ? `+${x.diff.toFixed(1)}` : "?";
  const byeNote = x.curP?.projection_status === "bye" ? " current starter is on bye." : "";
  const injNote =
    x.curP && x.curP.expected_availability < 0.8 ? ` current starter is ${x.curP.injury_status ?? "questionable"}.` : "";
  return `start over current ${x.slot}: ${gain} projected${byeNote}${injNote}`.trim();
}

const fmt = (v: number | null | undefined) => (v == null ? "n/a" : v.toFixed(1));
const round2 = (v: number) => Math.round(v * 100) / 100;

/* -------------------------------------------------------------------------- */
/* Hungarian algorithm — max-weight assignment on a rectangular matrix.        */
/* rows = slots, cols = candidates. Returns col index per row (-1 if none).    */
/* -------------------------------------------------------------------------- */

export function hungarianMaxWeight(weight: number[][]): number[] {
  const R = weight.length;
  if (R === 0) return [];
  const C = weight[0]!.length;
  const n = Math.max(R, C);
  const NEG = Number.NEGATIVE_INFINITY;

  // Square cost matrix (minimisation). Missing edges -> large finite cost so the
  // solver still runs; we filter them out after.
  let maxFinite = 1;
  for (const row of weight) for (const w of row) if (w !== NEG && Number.isFinite(w)) maxFinite = Math.max(maxFinite, w);
  const BIG = maxFinite * n + 1000;
  const cost: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      const w = i < R && j < C ? weight[i]![j]! : 0;
      if (i < R && j < C) return w === NEG ? BIG : -w;
      return 0; // dummy row/col
    }),
  );

  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const result: number[] = new Array(R).fill(-1);
  for (let j = 1; j <= n; j++) {
    const i = p[j];
    if (i >= 1 && i <= R && j <= C) {
      result[i - 1] = weight[i - 1]![j - 1] === NEG ? -1 : j - 1;
    }
  }
  return result;
}
