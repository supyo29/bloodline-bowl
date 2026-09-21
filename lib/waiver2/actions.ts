/**
 * Phase 4 (Checkpoint E) — the ACTION ENGINE. Combines `candidate + drop + acquisition cost` into manager-specific
 * WaiverActions, ranks them by net action value, tiers them, surfaces cheaper near-equivalents, and treats PASS
 * ("make no claim") as a first-class outcome. Recommends nothing when the pool is uncertified. Never submits anything.
 */
import type { CanonicalPlayer } from "@/lib/canonical/schema";
import { PARAMS, PARAM_SNAPSHOT, WAIVER2_CONTRACT, WAIVER2_ENGINE_VERSION } from "./config";
import { buildWaiverContext, round2, round3, type WaiverContext } from "./context";
import { hashOf } from "./hash";
import { WAIVER2_LIFECYCLE_STATE } from "./lifecycle";
import { faabRange, competitorView, priorityAdvice, visibleWinningBids } from "./market";
import { dropCost, lineupDelta, type DropCost } from "./roster";
import { assetValue, DECISION_HORIZON_WEEKS } from "./value";
import type { AssetValue, Component, RetrievalCounters, Tier, WaiverAction, WaiverEvaluation, WaiverInput } from "./types";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const BASE = ["QB", "RB", "WR", "TE", "K", "DEF"];
const gross = (a: AssetValue) => round2(a.by_kind.starter + a.by_kind.bench_option + a.by_kind.contingency_counted);

interface Draft {
  cand: CanonicalPlayer; asset: AssetValue; drop: DropCost | null; gross: number; dropCost: number; adjustment: number; adjNote: string | null;
  lineup: { value: number | null; status: "RESOLVED" | "UNRESOLVED" }; risk: number; pairNet: number;
}

export function evaluateWaiver2(input: WaiverInput, opts: { limit?: number } = {}): WaiverEvaluation {
  const ctx = buildWaiverContext(input); const limit = opts.limit ?? 12; const w = input.weekly;
  const warnings: string[] = [];
  const cert = input.pool.certification;
  const reasons: string[] = [];
  if (!input.pool.candidates.length) reasons.push("the candidate pool is empty");
  if (cert !== "CERTIFIED") reasons.push("the free-agent pool is NOT certified: unrostered in ownership data is not a certified free agent — nothing here is actionable");
  const status: WaiverEvaluation["availability"]["status"] = !input.pool.candidates.length ? "UNAVAILABLE" : cert === "CERTIFIED" ? "AVAILABLE" : "UNCERTIFIED_POOL";
  const base = (): Omit<WaiverEvaluation, "actions" | "recommended" | "pass" | "counters" | "evaluation_hash"> => ({
    engine_version: WAIVER2_ENGINE_VERSION, contract: WAIVER2_CONTRACT, generated_at: ctx.now, deployment: "SHADOW_ONLY", lifecycle_state: WAIVER2_LIFECYCLE_STATE, availability: { status, certification: cert, reasons },
    manager_team_id: ctx.myTeam.team_id, week: ctx.week, scoring_fingerprint: ctx.scoring_fingerprint,
    replacement: BASE.map((p) => ctx.replacement[p]!), market_summary: { budgets: input.teams.map((t) => ({ team_id: t.team_id, faab_remaining: t.faab_remaining })), visible_winning_bids: visibleWinningBids(ctx).bids.length, calibration: visibleWinningBids(ctx).calibration },
    lineage: { snapshot: w.lineage?.snapshot?.league_snapshot_id ?? null, role: input.role?.version ?? null, fi: input.fi?.version ?? null, opp: null, projection_model: w.projections.model_version ?? null, params_hash: hashOf(PARAM_SNAPSHOT) }, warnings,
  });
  const passAction = (why: string[]): WaiverAction => finalize({ id: "pass", kind: "PASS", manager_team_id: ctx.myTeam.team_id, candidate: null, drop: null, gross_add_value: 0, drop_cost: 0, acquisition_cost: 0, risk_penalty: 0, net_action_value: 0, net_low: 0, net_high: 0, horizons: { next_week: 0, next_3: 0, ros: 0, playoffs: 0, stash: 0 }, value_by_kind: { starter: 0, bench_option: 0, contingency_payoff: 0, contingency_counted: 0 }, lineup_delta_next_week: { value: 0, status: "RESOLVED" }, candidate_asset: null, drop_asset: null, market: { scarcity: 0, competitors: [], faab: { status: "NOT_APPLICABLE", unit: "dollars", min_useful: 0, expected_competitive: 0, aggressive: 0, walk_away: 0, uncertainty: [], calibration: "NONE", method: [] }, priority: { status: "NOT_APPLICABLE", current: ctx.myTeam.waiver_priority, reason: "no claim" } }, uncertainty: { total: 0, components: [], value_low: 0, value_high: 0 }, confidence: "HIGH", tier: "PASS", reasons: why, alternatives: [], components: [], content_id: "" });
  if (status === "UNAVAILABLE") { const p = passAction(["No candidate pool to evaluate."]); return { ...base(), actions: [], recommended: null, pass: p, counters: ctx.counters, evaluation_hash: hashOf({ s: status, p: p.content_id }) }; }

  // ---- my droppable assets (each valued ONCE)
  const dropCache = new Map<string, DropCost>();
  const droppable = ctx.activeIds.map((id) => ctx.players.get(id)).filter((p): p is CanonicalPlayer => !!p).map((p) => dropCost(ctx, p, dropCache));
  ctx.counters.droppables = droppable.length;
  const cap = w.league.roster_constraints.active_roster_capacity; const openSpot = cap > 0 && ctx.activeIds.length < cap;

  // ---- candidate prefilter (cheap, deterministic), then full asset valuation
  const scored = input.pool.candidates.map((a) => ({ a, wp: ctx.proj(a.canonical_player_id) })).filter((x) => x.wp && (x.wp.projected_points != null || x.wp.rest_of_season_points != null)).map(({ a, wp }) => {
    const rep = ctx.replacement[a.player.position]; const lvl = wp!.projected_points ?? (wp!.rest_of_season_points != null ? wp!.rest_of_season_points / ctx.weeksRemaining : 0);
    const roleHint = ctx.role(a.player)?.receiving?.target_share.recent != null || ctx.role(a.player)?.rushing?.rush_share.recent != null ? 1 : 0;
    return { a, cheap: lvl - (rep?.free_agent_replacement ?? 0) + (rep?.scarcity ?? 0) * 3 + roleHint * 0.5 };
  }).sort((x, y) => y.cheap - x.cheap || x.a.canonical_player_id.localeCompare(y.a.canonical_player_id));
  const shortlist = scored.slice(0, 90).map((x) => x.a); ctx.counters.candidates = shortlist.length;

  const drafts: Draft[] = [];
  for (const cand of shortlist) {
    const asset = assetValue(ctx, cand.player, { role: "CANDIDATE" }); const g = gross(asset); const risk = round2(PARAMS.risk_penalty_per_uncertainty_point.value * asset.uncertainty.total * Math.max(0, g));
    const options: Array<{ d: DropCost | null; pre: number }> = [];
    if (openSpot) options.push({ d: null, pre: g });
    for (const d of droppable) if (d.player_id !== cand.canonical_player_id) options.push({ d, pre: g - d.cost });
    options.sort((x, y) => y.pre - x.pre || (x.d?.player_id ?? "").localeCompare(y.d?.player_id ?? ""));
    let best: Draft | null = null;
    for (const o of options.slice(0, 5)) {
      const ld = lineupDelta(ctx, cand.player, o.d?.player_id ?? null); if (!ld.legal) continue;
      const assetNext = asset.horizons.next_week - (o.d ? o.d.asset.horizons.next_week : 0);
      let adj = 0; let adjNote: string | null = null;
      if (ld.gain != null && Math.abs(ld.gain - assetNext) > 1) { adj = round2(ld.gain - assetNext); adjNote = `exact optimal-lineup delta ${ld.gain} replaces the asset-model next-week estimate ${round2(assetNext)}`; }
      const dc = o.d ? o.d.cost : 0; const pairNet = round2(g - dc + adj - risk);
      const d: Draft = { cand: cand.player, asset, drop: o.d, gross: g, dropCost: dc, adjustment: adj, adjNote, lineup: { value: ld.gain, status: ld.gain == null ? "UNRESOLVED" : "RESOLVED" }, risk, pairNet };
      if (!best || d.pairNet > best.pairNet || (d.pairNet === best.pairNet && (d.drop?.player_id ?? "") < (best.drop?.player_id ?? ""))) best = d;
    }
    if (best) drafts.push(best); else warnings.push(`no legal drop preserves a fieldable lineup for ${asset.name}; not evaluated as an action`);
  }
  if (!drafts.length) { const p = passAction(["No legal add/drop transaction exists for any candidate."]); return { ...base(), actions: [], recommended: null, pass: p, counters: ctx.counters, evaluation_hash: hashOf({ s: status, p: p.content_id }) }; }

  // ---- market: shadow price of my budget from my best alternatives (distinct candidates)
  const sortedNet = [...drafts].sort((a, b) => b.pairNet - a.pairNet);
  const mine = ctx.myTeam.faab_remaining ?? 0;
  const top3 = sortedNet.slice(0, 3).reduce((s, d) => s + Math.max(0, d.pairNet), 0);
  const lambda = mine > 0 ? top3 / mine : 0; const hist = visibleWinningBids(ctx);
  const competitorsTeams = input.teams.filter((t) => t.team_id !== ctx.myTeam.team_id);
  const actions: WaiverAction[] = [];
  for (const d of drafts) {
    const lvl = d.asset.weekly_level ?? (d.cand ? 0 : 0);
    const comps = competitorsTeams.map((t) => competitorView(ctx, t, d.cand, lvl)).sort((a, b) => b.need_strength - a.need_strength || a.team_id.localeCompare(b.team_id));
    const surplus = Math.max(0, d.pairNet);
    const bestAlt = Math.max(0, ...sortedNet.filter((x) => x.cand.canonical_player_id !== d.cand.canonical_player_id).slice(0, 1).map((x) => x.pairNet));
    const rank = sortedNet.findIndex((x) => x.cand.canonical_player_id === d.cand.canonical_player_id); const valuePct = sortedNet.length > 1 ? 1 - rank / (sortedNet.length - 1) : 1;
    const faab = faabRange(ctx, { surplus, lambda, competitors: comps, hist, valuePct });
    const priority = priorityAdvice(ctx, { surplus, bestAlternativeSurplus: bestAlt });
    const ws = w.league.waiver_settings;
    const acq = faab.status === "AVAILABLE" ? round2((faab.expected_competitive ?? 0) * lambda) : priority.status === "SPEND" || priority.status === "HOLD" ? round2(Math.max(0, (ctx.myTeam.waiver_priority != null ? (input.teams.length - ctx.myTeam.waiver_priority + 1) / input.teams.length : 0.25) * bestAlt * 0.5)) : 0;
    void ws;
    const net = round2(d.gross - d.dropCost + d.adjustment - acq - d.risk);
    const u = d.asset.uncertainty.total; const ud = d.drop ? d.drop.asset.uncertainty.total : 0;
    const netLow = round2(d.gross * (1 - u) - d.dropCost * (1 + ud) + d.adjustment - acq - d.risk); const netHigh = round2(d.gross * (1 + u) - d.dropCost * (1 - ud) + d.adjustment - acq);
    const tier: Tier = net >= PARAMS.tier_a_min_net.value && netLow > 0 ? "A" : net >= PARAMS.tier_b_min_net.value ? "B" : net >= PARAMS.pass_margin_points.value ? "C" : "PASS";
    const conf: WaiverAction["confidence"] = u < 0.35 && netLow > 0 ? "HIGH" : u < 0.55 ? "MEDIUM" : "LOW";
    const rs: string[] = []; const a = d.asset;
    rs.push(`${a.name} (${a.archetype.replace(/_/g, " ").toLowerCase()}): gross ${d.gross} = starter ${a.by_kind.starter} + bench option ${a.by_kind.bench_option} + established contingency ${a.by_kind.contingency_counted} over ${DECISION_HORIZON_WEEKS} weeks.`);
    rs.push(d.drop ? `Requires dropping ${d.drop.asset.name}: drop cost ${d.dropCost}.` : "Open active roster spot: no drop required.");
    if (d.adjNote) rs.push(d.adjNote + ".");
    if (a.by_kind.contingency_payoff > 0 && a.by_kind.contingency_counted === 0) rs.push(`Conditional payoff ${a.by_kind.contingency_payoff} (if a teammate were unavailable) is NOT counted: no availability designation establishes it.`);
    if (a.role.status === "AVAILABLE" && Math.abs(a.role.persisted_points) >= 0.25) rs.push(`Role trajectory ${a.role.persisted_points >= 0 ? "adds" : "removes"} ${Math.abs(a.role.persisted_points)} pts/week (${a.role.trend}, ${a.role.confidence} confidence).`);
    if (net < PARAMS.pass_margin_points.value) rs.push(`Net ${net} does not clear the ${PARAMS.pass_margin_points.value}-point action floor after drop, cost and risk.`);
    const components: Component[] = [
      { key: "gross.starter", label: "Starter value (decision horizon)", value: a.by_kind.starter, unit: "points", status: "AVAILABLE" }, { key: "gross.bench_option", label: "Bench optionality", value: a.by_kind.bench_option, unit: "points", status: "AVAILABLE" }, { key: "gross.contingency", label: "Established contingency value", value: a.by_kind.contingency_counted, unit: "points", status: "AVAILABLE" },
      ...(d.drop ? d.drop.components.map((c) => ({ ...c, contribution: c.value == null ? null : -c.value })) : []),
      { key: "adjustment.lineup", label: "Exact next-week lineup adjustment", value: d.adjustment, unit: "points", status: d.lineup.status === "RESOLVED" ? "AVAILABLE" : "UNAVAILABLE", note: d.adjNote ?? (d.lineup.status === "UNRESOLVED" ? "counterfactual lineup unresolved (projection gap)" : undefined) },
      { key: "cost.acquisition", label: faab.status === "AVAILABLE" ? "Acquisition cost (expected competitive bid x budget shadow price)" : "Acquisition cost", value: -acq, unit: "points", status: "AVAILABLE", note: faab.status === "AVAILABLE" ? `expected $${faab.expected_competitive} x ${round3(lambda)} pts/$` : undefined },
      { key: "cost.risk", label: "Risk penalty (uncertainty x gross)", value: -d.risk, unit: "points", status: "AVAILABLE", note: `uncertainty ${a.uncertainty.total}` },
    ];
    actions.push({
      id: `add:${d.cand.canonical_player_id}${d.drop ? `|drop:${d.drop.player_id}` : "|open"}`, kind: d.drop ? "ADD_DROP" : "ADD_OPEN_SPOT", manager_team_id: ctx.myTeam.team_id,
      candidate: { player_id: d.cand.canonical_player_id, name: a.name, position: d.cand.position, nfl_team: d.cand.nfl_team }, drop: d.drop ? { player_id: d.drop.player_id, name: d.drop.asset.name, position: d.drop.asset.position } : null,
      gross_add_value: d.gross, drop_cost: d.dropCost, acquisition_cost: acq, risk_penalty: d.risk, net_action_value: net, net_low: netLow, net_high: netHigh,
      horizons: a.horizons, value_by_kind: a.by_kind, lineup_delta_next_week: d.lineup, candidate_asset: a, drop_asset: d.drop ? d.drop.asset : null,
      market: { scarcity: ctx.replacement[d.cand.position]?.scarcity ?? 0, competitors: comps, faab, priority }, uncertainty: a.uncertainty, confidence: conf, tier, reasons: rs, alternatives: [], components, content_id: "",
    } as WaiverAction);
  }
  // ---- rank deterministically, then alternatives
  actions.sort((x, y) => y.net_action_value - x.net_action_value || x.acquisition_cost - y.acquisition_cost || x.uncertainty.total - y.uncertainty.total || x.id.localeCompare(y.id));
  for (const a of actions) {
    a.alternatives = actions.filter((b) => b.candidate!.player_id !== a.candidate!.player_id && (Math.abs(b.net_action_value - a.net_action_value) <= PARAMS.alternative_margin_points.value || (b.acquisition_cost < a.acquisition_cost && b.net_action_value >= 0.8 * a.net_action_value && a.net_action_value > 0))).slice(0, 3)
      .map((b) => ({ candidate_id: b.candidate!.player_id, name: b.candidate!.name, net_action_value: b.net_action_value, acquisition_cost: b.acquisition_cost, why: Math.abs(b.net_action_value - a.net_action_value) <= PARAMS.alternative_margin_points.value ? `within ${PARAMS.alternative_margin_points.value} points of net value${b.acquisition_cost < a.acquisition_cost ? ` and cheaper to acquire (${b.acquisition_cost} vs ${a.acquisition_cost} points)` : ""}` : `cheaper to acquire (${b.acquisition_cost} vs ${a.acquisition_cost} points) for at least 80% of the net value` }));
  }
  const finals = actions.slice(0, limit).map((a) => finalize(a));
  const actionable = status === "AVAILABLE";
  const rec = actionable ? (finals.find((a) => a.tier !== "PASS" && a.tier !== "C") ?? null) : null;
  const pass = passAction(rec ? [`A claim (${rec.candidate!.name}) beats making no claim.`] : actionable ? ["No action clears the action floor after drop cost, acquisition cost and risk: make no waiver claim."] : ["The pool is uncertified: nothing is actionable; make no claim on this evidence."]);
  const oppV = finals.map((a) => a.candidate_asset?.opp.version).find((x) => !!x) ?? null;
  const b = base(); b.lineage.opp = oppV ?? null;
  return { ...b, actions: finals, recommended: rec, pass, counters: ctx.counters as RetrievalCounters, evaluation_hash: hashOf({ a: finals.map((f) => [f.id, f.net_action_value, f.tier]), r: rec?.id ?? null, s: status, l: b.lineage, p: pass.content_id }) };
}

function finalize(a: WaiverAction): WaiverAction {
  const stable = { id: a.id, k: a.kind, g: a.gross_add_value, d: a.drop_cost, c: a.acquisition_cost, r: a.risk_penalty, n: a.net_action_value, t: a.tier, u: a.uncertainty.total, f: [a.market.faab.min_useful, a.market.faab.expected_competitive, a.market.faab.aggressive, a.market.faab.walk_away] };
  return { ...a, content_id: `wa2:${hashOf(stable)}` };
}
export type { WaiverContext };
export { clamp as __clamp };
