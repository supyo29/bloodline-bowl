/**
 * Phase 4 (Checkpoint D) — MARKET / FAAB intelligence. Structural competition only: which managers have a *reason* to want a
 * player (need, weakness, injury/bye, budget) — never their intended bid. FAAB is a range derived from my surplus value, my
 * budget's shadow price, the scarcity of alternatives, structural demand and (when visible) real winning bids.
 */
import { isEligible } from "@/lib/weekly/lineup";
import type { CanonicalPlayer } from "@/lib/canonical/schema";
import { PARAMS } from "./config";
import { round2, round3, type WaiverContext } from "./context";
import type { CompetitorView, FaabRange, PriorityAdvice, TeamView } from "./types";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** For one competitor: how far below `level` is their marginal starter at the position (unfilled slot = full need). */
export function competitorView(ctx: WaiverContext, team: TeamView, cand: CanonicalPlayer, level: number): CompetitorView {
  const c = ctx.input.weekly.league.roster_constraints; const pos = cand.position;
  const need = c.slot_requirements[pos] ?? 0; const flex = c.flex_positions.includes(pos) ? c.flex_slots : 0;
  const k = Math.max(1, need + (flex > 0 ? 1 : 0));
  const mine = team.active_player_ids.map((id) => ({ id, p: ctx.players.get(id), pts: ctx.proj(id)?.projected_points ?? null })).filter((x) => x.p && isEligible(pos === "QB" ? "QB" : pos, x.p) && x.p.position === pos && x.pts != null).sort((a, b) => (b.pts as number) - (a.pts as number));
  const kth = mine[k - 1]?.pts ?? null; const evidence: string[] = [];
  const gap = kth == null ? level : level - kth;
  if (kth == null) evidence.push(`only ${mine.length} projected ${pos} for ${k} starting slot(s)`); else evidence.push(`marginal ${pos} starter ${round2(kth)} vs candidate ${round2(level)}`);
  let strength = gap >= PARAMS.competitor_need_min_gap.value ? clamp(gap / Math.max(3, level), 0, 1) : 0;
  const sched = ctx.input.schedule;
  const stress = mine.slice(0, k).filter((x) => { const dz = (ctx.proj(x.id)?.injury_status ?? "").toUpperCase(); const bw = x.p && sched ? ctx.byeWeek(x.p) : null; return /^(O|OUT|IR|D|DOUBTFUL|Q|QUESTIONABLE)/.test(dz) || (bw != null && bw >= ctx.week && bw <= ctx.week + 1); });
  if (stress.length) { strength = clamp(strength + 0.2, 0, 1); evidence.push(`${stress.length} starter(s) at ${pos} with an injury designation or a bye within 2 weeks`); }
  const budget = team.faab_remaining; const bctx = budget == null ? "budget not visible" : budget < 3 ? `only $${budget} remaining` : `$${budget} remaining`;
  return { team_id: team.team_id, manager: team.manager_ids[0] ?? null, need_strength: round3(strength), marginal_starter_gap: round2(gap), positional_weakness: kth == null ? "UNFILLED_SLOT" : gap >= 3 ? "MATERIAL_GAP" : gap >= PARAMS.competitor_need_min_gap.value ? "MODEST_GAP" : "NO_STRUCTURAL_NEED", budget_remaining: budget, budget_context: bctx, evidence };
}

export interface BidHistory { bids: number[]; calibration: FaabRange["calibration"] }
export function visibleWinningBids(ctx: WaiverContext): BidHistory {
  const bids = ctx.input.transactions.map((t) => t.faab_spent).filter((x): x is number => typeof x === "number" && x > 0).sort((a, b) => a - b);
  return { bids, calibration: bids.length ? "VISIBLE_WINNING_BIDS" : "UNCALIBRATED_PRIOR" };
}
const pctile = (a: number[], q: number) => a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)))]!;

export function faabRange(ctx: WaiverContext, o: { surplus: number; lambda: number; competitors: CompetitorView[]; hist: BidHistory; valuePct: number }): FaabRange {
  const ws = ctx.input.weekly.league.waiver_settings; const mine = ctx.myTeam.faab_remaining;
  if (ws.type !== "faab") return { status: "NOT_APPLICABLE", unit: "dollars", min_useful: null, expected_competitive: null, aggressive: null, walk_away: null, uncertainty: [], calibration: "NONE", method: [`league waiver type is ${ws.type}`] };
  if (mine == null) return { status: "UNAVAILABLE", unit: "dollars", min_useful: null, expected_competitive: null, aggressive: null, walk_away: null, uncertainty: ["my remaining FAAB budget is not visible"], calibration: o.hist.calibration, method: [] };
  const method: string[] = []; const unc: string[] = [];
  const demand = o.competitors.filter((c) => c.need_strength >= 0.3 && (c.budget_remaining == null || c.budget_remaining >= 1)).length;
  const others = o.competitors.map((c) => c.budget_remaining).filter((x): x is number => x != null);
  if (others.length < o.competitors.length) unc.push("some competitors' budgets are not visible (not inferred)");
  const cap = PARAMS.faab_max_fraction_of_remaining.value * mine;
  const valueBid = o.lambda > 0 ? o.surplus / o.lambda : 0;
  let anchor: number;
  // more desirable players clear at higher prices: the anchor scales with where the candidate ranks among MY plausible targets
  if (o.hist.bids.length) { const q = clamp(0.3 + 0.55 * o.valuePct + (demand >= 2 ? 0.1 : 0), 0, 1); anchor = pctile(o.hist.bids, q); method.push(`market anchor: ${Math.round(q * 100)}th percentile of ${o.hist.bids.length} visible winning bid(s) (higher for more desirable candidates)`); }
  else { const avg = others.length ? others.reduce((s, x) => s + x, 0) / others.length : mine; anchor = PARAMS.market_prior_bid_fraction.value * avg * (0.5 + 1.5 * o.valuePct); method.push("market anchor: UNCALIBRATED prior fraction of competitor budgets, scaled by candidate desirability (no winning bids are visible)"); unc.push("no winning bids visible: the competitive bid is an uncalibrated prior"); }
  const expected = demand === 0 ? 0 : clamp(anchor * (1 + 0.15 * Math.max(0, demand - 1)), 0, cap); method.push(`structural demand: ${demand} competitor(s) with a real need`);
  const walk = clamp(valueBid * PARAMS.faab_surplus_share.value.walk_away, 0, cap); method.push(`walk-away = ${PARAMS.faab_surplus_share.value.walk_away} x my surplus value / budget shadow price ($${round2(o.lambda)} pts per $1)`);
  const agg = Math.min(walk, Math.max(clamp(valueBid * PARAMS.faab_surplus_share.value.aggressive, 0, cap), expected));
  const minU = demand === 0 ? 0 : Math.max(1, Math.round(expected * 0.4));
  const exp2 = Math.max(minU, Math.round(expected)); const aggR = Math.max(exp2, Math.round(agg)); const walkR = Math.max(aggR, Math.round(walk));
  if (valueBid < expected) unc.push("the expected competitive price exceeds the value this roster gets: a claim is unlikely to be worth winning");
  return { status: "AVAILABLE", unit: "dollars", min_useful: minU, expected_competitive: exp2, aggressive: aggR, walk_away: Math.min(walkR, Math.floor(mine)), uncertainty: unc, calibration: o.hist.calibration, method };
}

/** Rolling / reverse-standings leagues: claim priority is a scarce resource with option value. */
export function priorityAdvice(ctx: WaiverContext, o: { surplus: number; bestAlternativeSurplus: number }): PriorityAdvice {
  const ws = ctx.input.weekly.league.waiver_settings; const cur = ctx.myTeam.waiver_priority;
  if (ws.type !== "rolling" && ws.type !== "reverse_standings") return { status: "NOT_APPLICABLE", current: cur, reason: `waiver type ${ws.type}: no independent claim priority to spend` };
  const need = PARAMS.priority_hold_ratio.value * o.bestAlternativeSurplus + 1.5;
  return o.surplus >= need ? { status: "SPEND", current: cur, reason: `surplus ${round2(o.surplus)} clears the priority option value (${round2(need)}) implied by the best alternative ${round2(o.bestAlternativeSurplus)}` } : { status: "HOLD", current: cur, reason: `surplus ${round2(o.surplus)} does not clear the priority option value (${round2(need)}); a better claim may come later` };
}
