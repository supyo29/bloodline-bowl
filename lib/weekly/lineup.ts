/**
 * Weekly optimal-lineup engine.
 *
 * Solves the valid starting-lineup ASSIGNMENT problem for a league's actual
 * roster rules (base slots + FLEX/SUPERFLEX eligibility) — it does NOT just sort
 * players by projected points. Max-weight bipartite matching (Hungarian) over
 * `slots × rostered players`, weight = weekly projected points, ineligible pairs
 * excluded. Deterministic: ties broken by canonical id, then roster order.
 *
 * Three projection states are kept distinct and never conflated:
 *   - KNOWN         a numeric projection exists
 *   - VERIFIED_ZERO schedule-proven bye (a defensible real 0)
 *   - UNKNOWN       no projection — must NOT act as a numeric 0 in any decision
 *
 * A VERIFIED_ZERO player is eligible and scored 0 (a real 0 beats an empty
 * slot). An UNKNOWN player is eligible only as a last resort (sentinel weight
 * below every real option) so the optimizer never *prefers* an unknown, and:
 *   - the lineup is marked `optimality_status: "PROVISIONAL"` whenever an
 *     unknown could change the true optimum;
 *   - totals that an unknown starter would distort are returned `null`, not a
 *     silently-low number;
 *   - a start/sit or add/drop that hinges on an unknown value is surfaced as
 *     UNRESOLVED, never as a confident numeric gain.
 *
 * Actionable changes are derived from the STARTER-SET difference
 * (players entering vs leaving the starting lineup), never from per-slot
 * permutations — reshuffling the same starters among RB/WR/FLEX slots is not a
 * start/sit move and produces no projected gain.
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

import { NON_STARTING_SLOTS, slotEligiblePositions } from "./slots";

export { slotEligiblePositions };

export function isEligible(slot: string, player: CanonicalPlayer): boolean {
  const allowed = slotEligiblePositions(slot);
  if (allowed.includes(player.position)) return true;
  return player.eligible_positions.some((p) => allowed.includes(p));
}

export type ProjectionState = "KNOWN" | "VERIFIED_ZERO" | "UNKNOWN";

export interface SlotRecommendation {
  slot: string;
  slot_index: number;
  recommended_player_id: string | null;
  recommended_projected: number | null;
  recommended_floor: number | null;
  recommended_ceiling: number | null;
  recommended_projection_state: ProjectionState | null;
  current_player_id: string | null;
  current_projected: number | null;
  current_projection_state: ProjectionState | null;
  projection_difference: number | null;
  /** the slot's recommended player differs from its current occupant */
  is_change: boolean;
  /** the recommended player is genuinely ENTERING the starting lineup (not a
   *  reshuffle of an already-started player) */
  is_starter_set_change: boolean;
  confidence: Confidence;
  reason: string;
}

export interface LineupChange {
  slot: string;
  out: string | null;
  in: string;
  /** Always numeric — a change hinging on a missing projection is not a
   *  `LineupChange` at all; it goes to `unresolved_decisions`. */
  gain: number;
  /** True when this change is one leg of a multi-player reshuffle (>=2 entrants).
   *  Per-leg `gain` is an attribution; the whole reshuffle's value is the
   *  lineup-level `projected_points_gained`. */
  part_of_reshuffle: boolean;
}

export interface UnresolvedLineupDecision {
  slot: string;
  current_player_id: string | null;
  candidate_player_id: string;
  reason: string;
}

export interface LineupResult {
  week: number;
  slots: SlotRecommendation[];
  /** COMPLETE only when no UNKNOWN player could change the optimal answer. */
  optimality_status: "COMPLETE" | "PROVISIONAL";
  provisional_reason: string | null;
  /** null when an UNKNOWN starter would distort it (never a silently-low number). */
  optimal_total: number | null;
  current_total: number | null;
  /** always available — sum of the KNOWN + VERIFIED_ZERO starters only. */
  known_optimal_subtotal: number;
  known_current_subtotal: number;
  projection_coverage: {
    optimal_slots_total: number;
    optimal_slots_known: number;
    current_slots_filled: number;
    current_slots_known: number;
  };
  points_left_on_bench: number | null;
  lineup_efficiency: number | null;
  changes_recommended: LineupChange[];
  /** entering/leaving pairs blocked by a missing projection — NOT confident moves. */
  unresolved_decisions: UnresolvedLineupDecision[];
  /** null when a total it depends on is null. */
  projected_points_gained: number | null;
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
  const nameOf = (id: string): string => players.get(id)?.full_name ?? proj(id)?.canonical_player_id ?? id;

  /** KNOWN | VERIFIED_ZERO (schedule-proven bye) | UNKNOWN (no projection). */
  const projState = (id: string): ProjectionState => {
    const p = proj(id);
    if (p && p.projection_status === "bye") return "VERIFIED_ZERO";
    if (p && p.projected_points != null) return "KNOWN";
    return "UNKNOWN";
  };
  /** Points for TOTALS: KNOWN -> number, VERIFIED_ZERO -> 0, UNKNOWN -> null. */
  const knownPoints = (id: string): number | null => {
    const st = projState(id);
    if (st === "UNKNOWN") return null;
    if (st === "VERIFIED_ZERO") return 0;
    return proj(id)!.projected_points!;
  };

  // Stable candidate order for deterministic tie-breaking.
  const orderIndex = new Map(candidateIds.map((id, i) => [id, i]));
  const cand = [...candidateIds].sort((a, b) => (orderIndex.get(a)! - orderIndex.get(b)!));

  // Weight matrix: rows = slots, cols = candidates. -Inf when ineligible.
  // An UNKNOWN player gets a sentinel weight far below every real projection, so
  // the optimizer never *prefers* an unknown. It is solved over KNOWN +
  // VERIFIED_ZERO players only; a slot the knowns cannot fill is then
  // PROVISIONALLY assigned to an eligible UNKNOWN (deterministically) and the
  // lineup is marked non-`COMPLETE`.
  const NEG = Number.NEGATIVE_INFINITY;
  const knownCand = cand.filter((id) => projState(id) !== "UNKNOWN");
  const unknownCand = cand.filter((id) => projState(id) === "UNKNOWN");
  const weight: number[][] = slots.map((slot) =>
    knownCand.map((id) => {
      const pl = players.get(id);
      if (!pl || !isEligible(slot, pl)) return NEG;
      return knownPoints(id)!; // known/verified-zero -> always a real number
    }),
  );

  const assignment = hungarianMaxWeight(weight);

  // Current lineup from the canonical roster's starting slots. Aligned to
  // `constraints.starting_slots` by LABEL + occurrence, not by sequential index:
  // a provider (Yahoo) that omits placeholder entries for unfilled starter slots
  // would otherwise shift every later starter forward (a DEF read as an RB).
  const startingRosterSlots = roster.slots.filter((s) => !NON_STARTING_SLOTS.has(s.slot));
  const slotQueueByLabel = new Map<string, Array<string | null>>();
  for (const s of startingRosterSlots) {
    const q = slotQueueByLabel.get(s.slot) ?? [];
    q.push(s.is_empty ? null : s.canonical_player_id);
    slotQueueByLabel.set(s.slot, q);
  }
  const leftoverStarters: Array<string | null> = [];
  const curBySlot: Array<string | null> = slots.map((label) => {
    const q = slotQueueByLabel.get(label);
    if (q && q.length > 0) return q.shift() ?? null;
    return undefined as unknown as string | null; // fill from leftovers below
  });
  // Roster starters whose slot label matched nothing in `starting_slots`
  // (label vocabulary mismatch) still get placed, in order, into remaining holes.
  for (const [, q] of slotQueueByLabel) for (const id of q) leftoverStarters.push(id);
  for (let i = 0; i < curBySlot.length; i += 1) {
    if (curBySlot[i] === undefined) curBySlot[i] = leftoverStarters.shift() ?? null;
  }

  // First pass — resolve each slot's recommended + current player.
  const usedUnknown = new Set<string>();
  const recBySlot: Array<string | null> = slots.map((slot, i) => {
    const recIdx = assignment[i];
    const known = recIdx != null && recIdx >= 0 && weight[i]![recIdx] !== NEG ? knownCand[recIdx]! : null;
    if (known) return known;
    // No known player fills this slot -> provisionally an eligible UNKNOWN.
    const u = unknownCand.find((id) => {
      if (usedUnknown.has(id)) return false;
      const pl = players.get(id);
      return pl != null && isEligible(slot, pl);
    });
    if (u) {
      usedUnknown.add(u);
      return u;
    }
    return null;
  });

  // ---- STARTER-SET difference (not slot permutations). Reshuffling the same
  // starters among RB/WR/FLEX/duplicate slots is NOT an actionable move.
  const currentStarterIds = curBySlot.filter((x): x is string => x != null);
  const optimalStarterIds = recBySlot.filter((x): x is string => x != null);
  const currentSet = new Set(currentStarterIds);
  const optimalSet = new Set(optimalStarterIds);
  const entering = [...new Set(optimalStarterIds.filter((id) => !currentSet.has(id)))];
  const leaving = [...new Set(currentStarterIds.filter((id) => !optimalSet.has(id)))];

  const slotRecs: SlotRecommendation[] = slots.map((slot, i) => {
    const recId = recBySlot[i] ?? null;
    const curId = curBySlot[i] ?? null;

    const recP = recId ? proj(recId) : null;
    const curP = curId ? proj(curId) : null;
    const recState = recId ? projState(recId) : null;
    const curState = curId ? projState(curId) : null;
    const recPts = recId && recState !== "UNKNOWN" ? knownPoints(recId) : null;
    const curPts = curId && curState !== "UNKNOWN" ? knownPoints(curId) : null;

    // Per-slot diff is only meaningful when BOTH sides have a usable value.
    const diff = recPts != null && curPts != null ? round2(recPts - curPts) : null;
    const isChange = Boolean(recId && recId !== curId);
    const isStarterSetChange = Boolean(recId && entering.includes(recId));

    const confidence = decisionConfidence({
      edge: diff ?? 0,
      std_dev_a: recP?.std_dev ?? null,
      std_dev_b: curP?.std_dev ?? null,
      incomplete: recState === "UNKNOWN" || curState === "UNKNOWN",
      uncertainty_is_heuristic:
        recP?.uncertainty_source === "position_volatility_heuristic" ||
        curP?.uncertainty_source === "position_volatility_heuristic",
    });

    return {
      slot,
      slot_index: i,
      recommended_player_id: recId,
      recommended_projected: recState === "UNKNOWN" ? null : recP?.projected_points ?? null,
      recommended_floor: recP?.floor_points ?? null,
      recommended_ceiling: recP?.ceiling_points ?? null,
      recommended_projection_state: recState,
      current_player_id: curId,
      current_projected: curState === "UNKNOWN" ? null : curP?.projected_points ?? null,
      current_projection_state: curState,
      projection_difference: diff,
      is_change: isChange,
      is_starter_set_change: isStarterSetChange,
      confidence,
      reason: lineupReason({ slot, recId, curId, recP, curP, diff, isChange, isStarterSetChange, recState, curState }),
    };
  });

  // ---- Totals. An UNKNOWN starter is NOT silently a 0: the affected total is
  // returned null, with a separate always-available known subtotal + coverage.
  const optimalHasUnknown = slotRecs.some((r) => r.recommended_projection_state === "UNKNOWN");
  const currentHasUnknown = slotRecs.some((r) => r.current_projection_state === "UNKNOWN");
  const known_optimal_subtotal = round2(
    slotRecs.reduce((s, r) => s + (r.recommended_projection_state === "UNKNOWN" ? 0 : r.recommended_projected ?? 0), 0),
  );
  const known_current_subtotal = round2(
    slotRecs.reduce((s, r) => s + (r.current_projection_state === "UNKNOWN" ? 0 : r.current_projected ?? 0), 0),
  );
  const optimal_total = optimalHasUnknown ? null : known_optimal_subtotal;
  const current_total = currentHasUnknown ? null : known_current_subtotal;
  const bothTotals = optimal_total != null && current_total != null;
  const points_left_on_bench = bothTotals ? round2(Math.max(0, optimal_total! - current_total!)) : null;
  const projected_points_gained = bothTotals ? round2(Math.max(0, optimal_total! - current_total!)) : null;
  const lineup_efficiency =
    bothTotals && optimal_total! > 0 ? Math.round((current_total! / optimal_total!) * 1000) / 1000 : null;

  const projection_coverage = {
    optimal_slots_total: slotRecs.filter((r) => r.recommended_player_id).length,
    optimal_slots_known: slotRecs.filter((r) => r.recommended_player_id && r.recommended_projection_state !== "UNKNOWN").length,
    current_slots_filled: slotRecs.filter((r) => r.current_player_id).length,
    current_slots_known: slotRecs.filter((r) => r.current_player_id && r.current_projection_state !== "UNKNOWN").length,
  };

  // ---- Actionable changes: derived from the entering/leaving SET difference,
  // paired for display. Pairing prefers a same-base-position leaver, then a
  // slot-eligible leaver, then the highest-value remaining leaver; an entrant
  // left unpaired is filling a freed/empty slot (`out: null`). Every genuine
  // entrant is reported — a move is never dropped because an arbitrary
  // cross-position pair happened to have a non-positive delta. The authoritative
  // aggregate gain is `optimal_total - current_total`, not a sum of these.
  const basePos = (id: string): string => players.get(id)?.position ?? "";
  const enteringSorted = [...entering].sort((a, b) => (knownPoints(b) ?? -1e9) - (knownPoints(a) ?? -1e9));

  // Pair the WHOLE entering/leaving set at once (max-weight matching) so a
  // greedy first-match cannot steal the only same-position leaver a later
  // entrant needs — which would emit a misleading cross-position negative swap.
  const optimalSlotOf = (id: string): string => slotRecs.find((r) => r.recommended_player_id === id)?.slot ?? "";
  const currentSlotByPlayer = new Map<string, string>();
  curBySlot.forEach((id, i) => {
    if (id) currentSlotByPlayer.set(id, slots[i]!);
  });
  const compat = (inId: string, outId: string): number => {
    if (basePos(inId) === basePos(outId)) return 100;
    const outPl = players.get(outId);
    const inPl = players.get(inId);
    // Can the leaver play the slot the entrant is taking, and can the entrant
    // play the slot the leaver currently holds? (leaver's slot comes from the
    // CURRENT lineup — a leaver is by definition absent from the optimal one.)
    const outFitsInSlot = outPl != null && isEligible(optimalSlotOf(inId), outPl);
    const inFitsOutSlot = inPl != null && isEligible(currentSlotByPlayer.get(outId) ?? "", inPl);
    if (outFitsInSlot && inFitsOutSlot) return 60;
    if (outFitsInSlot || inFitsOutSlot) return 20;
    return 1;
  };
  const pairOut = new Map<string, string | null>();
  if (enteringSorted.length > 0 && leaving.length > 0) {
    const w: number[][] = enteringSorted.map((inId) => leaving.map((outId) => compat(inId, outId)));
    const asg = hungarianMaxWeight(w);
    enteringSorted.forEach((inId, i) => {
      const j = asg[i];
      pairOut.set(inId, j != null && j >= 0 && j < leaving.length ? leaving[j]! : null);
    });
  } else {
    for (const inId of enteringSorted) pairOut.set(inId, null);
  }

  const changes: LineupChange[] = [];
  const unresolved_decisions: UnresolvedLineupDecision[] = [];
  const reshuffle = enteringSorted.length >= 2;
  for (const inId of enteringSorted) {
    const slotRec = slotRecs.find((r) => r.recommended_player_id === inId)!;
    const outId: string | null = pairOut.get(inId) ?? null;
    const inState = projState(inId);
    const outState: ProjectionState = outId ? projState(outId) : "KNOWN"; // freed slot -> 0 baseline

    if (inState === "UNKNOWN" || outState === "UNKNOWN") {
      unresolved_decisions.push({
        slot: slotRec.slot,
        current_player_id: outId,
        candidate_player_id: inId,
        reason:
          inState === "UNKNOWN"
            ? `${nameOf(inId)} has no weekly projection — this move cannot be quantified or confidently recommended.`
            : `current starter ${outId ? nameOf(outId) : "(slot)"} has no weekly projection — cannot confirm ${nameOf(inId)} is an upgrade or quantify the gain.`,
      });
      continue;
    }

    const inPts = inState === "VERIFIED_ZERO" ? 0 : proj(inId)!.projected_points!;
    const outPts = outId ? (outState === "VERIFIED_ZERO" ? 0 : proj(outId)!.projected_points!) : 0;
    changes.push({ slot: slotRec.slot, out: outId, in: inId, gain: round2(inPts - outPts), part_of_reshuffle: reshuffle });
  }
  changes.sort((a, b) => b.gain - a.gain);

  // ---- Optimality status. The known players form a legal lineup, but we CANNOT
  // prove it is the true optimum while any rosterable, slot-eligible player has
  // no projection (their real value could beat a started player).
  const eligibleUnknownCandidates = cand.filter((id) => {
    if (projState(id) !== "UNKNOWN") return false;
    const pl = players.get(id);
    return pl != null && slots.some((sl) => isEligible(sl, pl));
  });
  const startsUnknown = slotRecs.some((r) => r.recommended_projection_state === "UNKNOWN");
  const currentStarterUnknown = slotRecs.some((r) => r.current_projection_state === "UNKNOWN");
  const optimality_status: LineupResult["optimality_status"] =
    eligibleUnknownCandidates.length > 0 ? "PROVISIONAL" : "COMPLETE";
  const provisional_reason =
    optimality_status === "COMPLETE"
      ? null
      : startsUnknown
        ? "the provisional optimal lineup includes a player with no weekly projection."
        : currentStarterUnknown
          ? "a current starter has no weekly projection, so the current total and any gain cannot be quantified."
          : `${eligibleUnknownCandidates.length} rostered, slot-eligible player(s) have no weekly projection — a breakout there is not modeled, so the assignment is not provably optimal.`;

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

  // Current starters with NO usable projection — UNKNOWN, never a numeric 0.
  const unprojected_starters = slotRecs
    .filter((r) => r.current_projection_state === "UNKNOWN")
    .map((r) => r.current_player_id!);
  if (unprojected_starters.length > 0) {
    warnings.push({
      code: "starter_projection_missing",
      message: `${unprojected_starters.length} current starter(s) have no weekly projection — kept UNKNOWN (not zeroed); the current total and any lineup gain that depends on them is returned null.`,
      severity: "warning",
    });
  }
  if (optimality_status === "PROVISIONAL") {
    warnings.push({
      code: "lineup_optimality_provisional",
      message: `Optimal lineup is PROVISIONAL: ${provisional_reason}`,
      severity: startsUnknown || currentStarterUnknown ? "warning" : "info",
    });
  }
  if (optimal_total == null) {
    warnings.push({
      code: "optimal_total_unavailable",
      message: "Optimal projected total is unavailable — an UNKNOWN player is in the optimal lineup. Known subtotal is exposed separately.",
      severity: "warning",
    });
  }
  for (const u of unresolved_decisions) {
    warnings.push({ code: "lineup_decision_unresolved", message: `${u.slot}: ${u.reason}`, severity: "warning" });
  }

  return {
    week,
    slots: slotRecs,
    optimality_status,
    provisional_reason,
    optimal_total,
    current_total,
    known_optimal_subtotal,
    known_current_subtotal,
    projection_coverage,
    points_left_on_bench,
    lineup_efficiency,
    changes_recommended: changes,
    unresolved_decisions,
    projected_points_gained,
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
  isStarterSetChange: boolean;
  recState: ProjectionState | null;
  curState: ProjectionState | null;
}): string {
  if (!x.recId) return `no rostered player is eligible for ${x.slot} — empty slot.`;
  if (!x.isChange) return `keep current ${x.slot} (${fmt(x.recP?.projected_points)} projected).`;
  if (!x.isStarterSetChange) return `same starters — ${x.slot} is a slot reshuffle only, no action needed.`;
  if (x.recState === "UNKNOWN" || x.curState === "UNKNOWN") {
    return `unresolved ${x.slot}: a projection is missing — cannot quantify or confidently recommend this change.`;
  }
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
