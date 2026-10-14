/**
 * W2.R1 EARLY SHADOW live reports (S1-S3 mechanics on real canonical league state). DIAGNOSTIC ONLY.
 * Nothing here is read by any production decision path; every report carries the label, layer availability and the production-influence statement.
 */
import { buildLineup } from "@/lib/weekly/intelligence";
import { buildWaiverRecommendations } from "@/lib/weekly/waivers";
import type { WeeklyTeamContext } from "@/lib/weekly/schema";
import { buildEarlyInputs, type EarlyInputs } from "./adapter";
import type { LeagueRules, MarketCandidate, Pos, RosterAsset } from "./evidence";
import { scenarioLineup, topCandidates, weekValue } from "./roster";
import type { DynamicVor } from "./vor";
import { computeDynamicVor } from "./generated/vor-fast"; // memoized per request; output identical to ./vor (test-enforced)
import { W2R1_MODE, W2R1_MODEL_VERSION } from "./version";
import { qualificationSummary, TACTICAL, W2R1_RESEARCH_VERDICT, UPSIDE_LABEL } from "./qualification";
import { applyQualifiedDst, dstForTeam, kForTeam, REGIMES, type KdstCapture } from "./dst-live";
import { upsideForPlayer, upsideListing, type UpsideCapture } from "./upside-live";

export const EARLY_LABEL = "W2.R1 EARLY SHADOW — DIAGNOSTIC" as const;
export const LAYER_STATUS = {
  S1_evidence_contract: "AVAILABLE",
  S2_roster_replacement_simulation: "AVAILABLE",
  S3_dynamic_vor_mechanics: "AVAILABLE",
  S4_k_dst_component_model: "D/ST: QUALIFIED_SHADOW (Devoted to the Game, Sporty's Alumni, Maclin on Chick's XVI); EXPLORATORY_POST_DEFECT (Rogers Park); DIAGNOSTIC_ONLY (Bloodline Bowl D/ST, all K)",
  S5_game_plan_intelligence: "NO_RELIABLE_INCREMENTAL_SIGNAL — not applied to any live forecast",
  S6_empirical_upside_model: "TE INSUFFICIENT_FINAL_SAMPLE (prospective evaluation only); QB/RB DIAGNOSTIC_ONLY; WR NO_RELIABLE_SIGNAL; no K/DST spike probability",
  S7_final_retrospective_qualification: "COMPLETE — final set spent",
} as const;
export const K_DST_NOTICE = "D/ST expected points are W2.R1-qualified for shadow use only in Devoted to the Game, Sporty's Alumni and Maclin on Chick's XVI; Rogers Park is EXPLORATORY (post-open defect PO-1); Bloodline Bowl D/ST is unqualified. Kicker forecasts are DIAGNOSTIC_ONLY. Anything else uses an inherited generic forecast and is labelled as such.";
export const BREAKOUT_NOTICE = `${UPSIDE_LABEL}: TE is INSUFFICIENT_FINAL_SAMPLE (prospective evaluation only); QB/RB DIAGNOSTIC_ONLY; WR NO_RELIABLE_SIGNAL; no K/DST spike probability is displayed. This is not a breakout probability.`;
export const TACTICAL_NOTICE = `TACTICAL_SIGNAL: ${TACTICAL.tactical_signal} — no tactical or matchup adjustment is applied to any forecast.`;
export const PRODUCTION_STATEMENT = "NONE — this response is a shadow diagnostic. It changes no production start/sit, waiver, drop, trade, VOR or fantasy transaction.";

export function envelope(ctx: WeeklyTeamContext, inp: EarlyInputs, kind: string, data: unknown) {
  const mp = ctx.market_pool;
  return {
    label: EARLY_LABEL, mode: W2R1_MODE, model_version: W2R1_MODEL_VERSION, view: kind,
    research_verdict: W2R1_RESEARCH_VERDICT, qualification: "PER_COMPONENT" as const, qualification_states: qualificationSummary(ctx.league.slug),
    tactical_signal: TACTICAL.tactical_signal,
    layers: LAYER_STATUS,
    notices: { k_dst: K_DST_NOTICE, upside: BREAKOUT_NOTICE, tactical: TACTICAL_NOTICE },
    production_influence: PRODUCTION_STATEMENT,
    league: { slug: ctx.league.slug, provider: ctx.league.provider, week: ctx.league.week, season: ctx.league.season },
    manager: ctx.manager.manager_slug,
    scoring_fingerprint: inp.rules.scoring_fingerprint,
    league_rules: { slots: inp.rules.slots, bench_size: inp.rules.bench_size, ir_slots: inp.rules.ir_slots, last_week_considered: inp.rules.last_week },
    confidence: { current_week: "from Wave 1 forecast", future_weeks: "LOW (Wave-1 hold-rate proxy; no schedule/matchup/game-plan adjustment)", overall: "LOW-MEDIUM" },
    evidence: { context_generated_at: ctx.generated_at, projection_source: ctx.projections.source, projection_status: ctx.projections.status, context_status: ctx.status },
    market: { provider: inp.market.provider, basis: mp?.basis ?? null, verified: inp.market.verified, freshness: inp.market.freshness, observed_at: inp.market.observed_at, age_ms: mp?.age_ms ?? (inp.market.observed_at ? Math.max(0, Date.now() - Date.parse(inp.market.observed_at)) : null), market_content_id: mp?.market_content_id ?? null, candidates: inp.market.candidates.length, readiness_axes: mp?.axes ?? null, pool_actionable: ctx.free_agent_pool_readiness.actionable,
      rules: mp?.rules ?? null, manager_acquisition: mp?.manager ?? null, pending_claims: mp?.pending_claims ?? null, k_dst_scoring_note: mp?.scoring?.note ?? null, fa_bid_amounts: "UNKNOWN — FAAB bids/competition are not modeled; waiver claims carry no success probability" },
    notes: inp.notes,
    data,
  };
}

const round = (v: number | null | undefined, d = 2): number | null => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const comp = (c: DynamicVor["weekly_roster_vor"]) => ({ value: round(c.value), low: round(c.low), high: round(c.high), basis: c.basis, coverage: round(c.coverage), unknown_reason: c.unknown_reason });

export function simplify(v: DynamicVor, name: string, status: string) {
  return {
    player_id: v.player_id, name, roster_status: status,
    weekly_roster_vor: comp(v.weekly_roster_vor), ros_vor: comp(v.ros_vor), hold_vor: comp(v.hold_vor), streaming_adjusted_vor: comp(v.streaming_adjusted_vor),
    weekly_league_vor: comp(v.weekly_league_vor), league_vor: comp(v.league_vor), scarcity_vor: comp(v.scarcity_vor), market_value_input: comp(v.market_value_input),
    negative_value_reason: v.weekly_roster_vor.value != null && v.weekly_roster_vor.value < 0 && v.weekly_detail?.chosen_add ? `negative: losing him frees a roster spot that a verified add (${v.weekly_detail.chosen_add.player_id}) uses better` : null,
    flags: v.flags,
  };
}

export function findPlayer(inp: EarlyInputs, q: string): { ok: true; id: string; roster: boolean } | { ok: false; matches: Array<{ player_id: string; name: string }> } {
  const exact = inp.roster.find((a) => a.player_id === q) ?? inp.market.candidates.find((a) => a.player_id === q);
  if (exact) return { ok: true, id: exact.player_id, roster: inp.roster.some((a) => a.player_id === q) };
  const needle = q.toLowerCase();
  const all = [...inp.roster.map((a) => ({ a, r: true })), ...inp.market.candidates.map((a) => ({ a, r: false }))].filter((x) => x.a.name.toLowerCase().includes(needle));
  if (all.length === 1) return { ok: true, id: all[0]!.a.player_id, roster: all[0]!.r };
  return { ok: false, matches: all.slice(0, 10).map((x) => ({ player_id: x.a.player_id, name: x.a.name })) };
}

export function rosterReport(ctx: WeeklyTeamContext, inp: EarlyInputs) {
  const t0 = Date.now();
  const rows = inp.roster.map((a) => simplify(computeDynamicVor({ rules: inp.rules, roster: inp.roster, playerId: a.player_id, week: ctx.league.week, market: inp.market }), a.name, a.status));
  const r1 = scenarioLineup({ rules: inp.rules, week: ctx.league.week, kind: "lineup", roster: inp.roster });
  const prod = buildLineup(ctx);
  const nm = (id: string | null) => (id ? inp.names.get(id) ?? id : null);
  const r1Starters = new Set(r1.slots.map((s) => s.player_id).filter(Boolean) as string[]);
  const prodStarters = new Set(prod.slots.map((s) => s.recommended_player_id).filter(Boolean) as string[]);
  return {
    players: rows,
    lineup_comparison: {
      "CURRENT PRODUCTION DECISION": { optimal_total: round(prod.optimal_total), starters: prod.slots.map((s) => ({ slot: s.slot, player: nm(s.recommended_player_id), projected: round(s.recommended_projected) })), optimality: prod.optimality_status },
      "W2.R1 SHADOW DECISION": { optimal_total: round(r1.total), starters: r1.slots.map((s) => ({ slot: s.slot, player: nm(s.player_id), value: round(s.value) })), unknown_excluded: r1.unknown_excluded.map(nm), activated_from_reserve: r1.activated_from_reserve.map(nm), empty_slots: r1.empty_slots },
      starter_set_differences: { only_production: [...prodStarters].filter((x) => !r1Starters.has(x)).map(nm), only_w2r1: [...r1Starters].filter((x) => !prodStarters.has(x)).map(nm) },
    },
    compute_ms: Date.now() - t0,
  };
}

export function playerReport(ctx: WeeklyTeamContext, inp: EarlyInputs, id: string) {
  const a = inp.roster.find((r) => r.player_id === id);
  if (!a) {
    const c = inp.market.candidates.find((m) => m.player_id === id)!;
    // a pool player: roster-independent components via a one-off roster-less VOR, plus what adding him would do
    return { on_roster: false, name: c.name, acquisition: c.acquisition, note: "Not on this roster: roster-specific VOR is not defined for a non-rostered player; see the add report for the marginal effect of adding him.", position: c.position, k_dst_notice: c.position === "K" || c.position === "DEF" ? K_DST_NOTICE : null };
  }
  const v = computeDynamicVor({ rules: inp.rules, roster: inp.roster, playerId: id, week: ctx.league.week, market: inp.market });
  const wk = ctx.league.week;
  const preview = (x: { weeks: Record<number, { state: string; lineup: number | null; underlying: number | null }> }) => Object.fromEntries(Array.from({ length: 6 }, (_, i) => wk + i).filter((w) => x.weeks[w]).map((w) => [w, { state: x.weeks[w]!.state, lineup: round(x.weeks[w]!.lineup), underlying: round(x.weeks[w]!.underlying) }]));
  const alt = inp.market.candidates.filter((c) => c.position === a.position && weekValue(c, wk, "lineup") != null).sort((x, y) => (weekValue(y, wk, "lineup") as number) - (weekValue(x, wk, "lineup") as number)).slice(0, 3);
  return { on_roster: true, ...simplify(v, a.name, a.status), evidence: { asset_weeks_preview: preview(a), confidence: a.confidence, provenance: a.provenance, best_verified_alternatives_same_position: alt.map((c) => ({ name: c.name, method: c.acquisition.method, success_probability: c.acquisition.success_probability, weeks_preview: preview(c) })) }, weekly_detail: v.weekly_detail, horizon: v.horizon, k_dst_notice: a.position === "K" || a.position === "DEF" ? K_DST_NOTICE : null, missing_evidence: a.missing_evidence };
}

export function dropReport(ctx: WeeklyTeamContext, inp: EarlyInputs, id: string) {
  const a = inp.roster.find((r) => r.player_id === id);
  if (!a) return { error: "PLAYER_NOT_ON_ROSTER" };
  const v = computeDynamicVor({ rules: inp.rules, roster: inp.roster, playerId: id, week: ctx.league.week, market: inp.market });
  const nm = (x: string | null) => (x ? inp.names.get(x) ?? x : null);
  const d = v.weekly_detail;
  return {
    player: { id, name: a.name, position: a.position, status: a.status },
    cost_of_losing: { weekly_roster_vor: comp(v.weekly_roster_vor), ros_vor: comp(v.ros_vor), hold_vor: comp(v.hold_vor) },
    legal_lineup_effect_this_week: d ? { with_total: round(d.with_total), without_total: round(d.without_roster_only), chain: d.chain.map((c) => ({ slot: c.slot, before: nm(c.before), after: nm(c.after) })), empty_slots: d.empty_slots_without, activated_from_reserve: d.activated_from_reserve.map(nm), provisional: d.provisional, unknown_excluded: d.unknown_excluded.map(nm) } : null,
    replacement: {
      bench_and_roster: "see chain: replacements come from the re-optimized roster first (bench, FLEX-eligible players, IR returns)",
      verified_market_entering_with_known_probability: d?.chosen_add ? { ...d.chosen_add, name: nm(d.chosen_add.player_id) } : null,
      best_market_candidate_with_UNKNOWN_probability: d?.optimistic_unverified_add ? { ...d.optimistic_unverified_add, name: nm(d.optimistic_unverified_add.player_id), chain: d.optimistic_unverified_add.chain.map((c) => ({ slot: c.slot, before: nm(c.before), after: nm(c.after) })), vor_if_acquired: round(d.optimistic_unverified_add.vor_if_acquired) } : null,
      acquisition_probability_note: "A candidate whose acquisition probability is unknown is shown for transparency but never counted in the expected VOR.",
    },
    bye_note: a.weeks[ctx.league.week]?.state === "BYE" ? "On a bye this week: weekly lineup value is 0, but Hold and ROS values are preserved (the asset is not worth less because of the bye)." : null,
    k_dst_notice: a.position === "K" || a.position === "DEF" ? K_DST_NOTICE : null,
    recommendation: "NONE — diagnostic only; W2.R1 makes no drop recommendation in this stage.",
  };
}

export function addReport(ctx: WeeklyTeamContext, inp: EarlyInputs, limit = 10) {
  const week = ctx.league.week;
  const { rules, roster, market } = inp;
  const horizon = Array.from({ length: Math.max(0, rules.last_week - week + 1) }, (_, i) => week + i);
  const tops = topCandidates(market.candidates, week, 3);
  const droppable = roster.filter((r) => r.status === "STARTER" || r.status === "BENCH");
  const base = horizon.map((w) => scenarioLineup({ rules, week: w, kind: "lineup", roster }).total);
  const nm = (x: string) => inp.names.get(x) ?? x;
  const out: Array<Record<string, unknown>> = [];
  for (const c of tops) {
    let best: { d: RosterAsset | null; net: number; weekly: number } | null = null;
    const options: Array<RosterAsset | null> = [...droppable, ...(roster.filter((r) => r.status === "STARTER" || r.status === "BENCH").length < rules.slots.length + rules.bench_size ? [null] : [])];
    for (const d of options) {
      const r2 = d ? roster.filter((x) => x.player_id !== d.player_id) : roster;
      const totals = horizon.map((w) => scenarioLineup({ rules, week: w, kind: "lineup", roster: r2, adds: [c] }).total);
      const net = totals.reduce((s, t, i) => s + (t - base[i]!), 0);
      if (!best || net > best.net) best = { d, net, weekly: totals[0]! - base[0]! };
    }
    out.push({
      add: { player_id: c.player_id, name: c.name, position: c.position }, acquisition: c.acquisition,
      best_drop: best?.d ? { player_id: best.d.player_id, name: nm(best.d.player_id), position: best.d.position } : "NONE_NEEDED_OPEN_SPOT",
      weekly_lineup_delta: round(best?.weekly), ros_lineup_delta_over_horizon: round(best?.net),
      acquisition_probability_known: c.acquisition.success_probability != null,
      note: c.acquisition.success_probability == null ? "Acquisition probability UNKNOWN: delta shown as if acquired; not an expected value." : "Verified addable now.",
    });
  }
  out.sort((a, b) => ((b.ros_lineup_delta_over_horizon as number) ?? -1e9) - ((a.ros_lineup_delta_over_horizon as number) ?? -1e9));
  return { candidates_evaluated: tops.length, top: out.slice(0, limit) };
}

export function kdstReport(ctx: WeeklyTeamContext, inp: EarlyInputs, cap: KdstCapture | null = null) {
  const week = ctx.league.week;
  const mine = inp.roster.filter((a) => a.position === "K" || a.position === "DEF");
  const pool = (pos: Pos) => inp.market.candidates.filter((c) => c.position === pos).map((c) => ({ c, v: weekValue(c, week, "lineup") })).filter((x) => x.v != null).sort((a, b) => (b.v as number) - (a.v as number)).slice(0, 6);
  const rows = mine.map((a) => ({ ...simplify(computeDynamicVor({ rules: inp.rules, roster: inp.roster, playerId: a.player_id, week, market: inp.market }), a.name, a.status), this_week_value: round(weekValue(a, week, "lineup")) }));
  return {
    notice: K_DST_NOTICE,
    mine: rows,
    best_verified_available: { K: pool("K").map((x) => ({ player_id: x.c.player_id, name: x.c.name, this_week_value: round(x.v), method: x.c.acquisition.method, success_probability: x.c.acquisition.success_probability })), DEF: pool("DEF").map((x) => ({ player_id: x.c.player_id, name: x.c.name, this_week_value: round(x.v), method: x.c.acquisition.method, success_probability: x.c.acquisition.success_probability })) },
    forecast_quality: "see dst_live / k_live: only labelled W2.R1 values come from the frozen component models; everything else is INHERITED_GENERIC_FORECAST and not W2.R1-qualified",
    ...kdstLive(ctx, inp, cap),
  };
}

export function compareReport(ctx: WeeklyTeamContext, inp: EarlyInputs) {
  const roster = rosterReport(ctx, inp);
  const prodWaivers = buildWaiverRecommendations(ctx, { limit: 8 });
  const add = addReport(ctx, inp, 8);
  return {
    "CURRENT PRODUCTION DECISION": {
      lineup: roster.lineup_comparison["CURRENT PRODUCTION DECISION"],
      waiver_recommendations: (prodWaivers.recommendations ?? []).slice(0, 8).map((r) => ({ add: r.add_name, position: r.position, drop: r.drop_name, net_roster_gain: round(r.net_roster_gain), starter_impact: round(r.starter_impact), priority: r.priority })),
      waiver_availability_status: prodWaivers.availability_status,
    },
    "W2.R1 SHADOW DECISION": { lineup: roster.lineup_comparison["W2.R1 SHADOW DECISION"], best_add_drop_pairs_by_ros_lineup_delta: add.top, starter_set_differences: roster.lineup_comparison.starter_set_differences },
    agreement: (() => {
      const prodAdds = new Set((prodWaivers.recommendations ?? []).map((r) => r.add_name));
      const r1Adds = new Set(add.top.map((t) => (t.add as { name: string }).name));
      return { production_adds_also_in_w2r1_top: [...prodAdds].filter((n) => r1Adds.has(n)), only_production: [...prodAdds].filter((n) => !r1Adds.has(n)), only_w2r1: [...r1Adds].filter((n) => !prodAdds.has(n)) };
    })(),
    interpretation: "Diagnostic comparison only. Differences are expected to be small at this stage: W2.R1 shares the Wave 1 forecasts; what differs is the roster-cascade value (bench, IR, FLEX, market) not the player forecasts.",
  };
}

export async function buildInputsFromContext(ctx: WeeklyTeamContext): Promise<EarlyInputs> { return buildEarlyInputs(ctx); }
export type { LeagueRules, MarketCandidate };

/** D/ST + K live outputs from the frozen pregame capture for this league / week. Never substitutes a generic forecast under a W2.R1 label. */
export function kdstLive(ctx: WeeklyTeamContext, inp: EarlyInputs, cap: KdstCapture | null) {
  const league = ctx.league.slug; const week = ctx.league.week; const q = qualificationSummary(league);
  if (!cap || cap.meta.target_week !== week) return { dst_live: { state: "UNAVAILABLE", reason: `no frozen pregame capture for week ${week}`, qualification: q.dst_expected_points }, k_live: { state: "UNAVAILABLE", reason: `no frozen pregame capture for week ${week}`, qualification: q.k_forecast } };
  const teamsOf = (xs: Array<{ position: string; team: string | null; name: string }>) => xs.filter((a) => a.position === "DEF" && a.team);
  const mineDst = teamsOf(inp.roster).map((a) => ({ asset: a.name, ...(dstForTeam(cap, league, a.team as string)) }));
  const poolDst = teamsOf(inp.market.candidates).map((a) => ({ asset: a.name, ...(dstForTeam(cap, league, a.team as string)) })).filter((x) => !("unavailable" in x)).sort((x, y) => ((y as { expected_points: number }).expected_points) - ((x as { expected_points: number }).expected_points)).slice(0, 8);
  const kk = (xs: Array<{ position: string; team: string | null; name: string }>) => xs.filter((a) => a.position === "K" && a.team).map((a) => ({ asset: a.name, ...(kForTeam(cap, league, a.team as string)) }));
  return {
    dst_live: { qualification: q.dst_expected_points, regime: REGIMES[league] ? { provider: REGIMES[league]!.provider } : null, evidence_timestamp: cap.meta.generated_at, data_through_week: cap.meta.data_through_week, mine: mineDst, best_verified_available: poolDst,
      vor_integration: q.dst_expected_points.state === "QUALIFIED_SHADOW" ? "current-week D/ST values in Dynamic VOR come from this component model (future weeks inherited generic, labelled)" : "NOT integrated into Dynamic VOR: this league's D/ST state is not QUALIFIED_SHADOW (inherited generic values remain, labelled)" },
    k_live: { qualification: q.k_forecast, mine: kk(inp.roster), best_verified_available: kk(inp.market.candidates).filter((x) => !("unavailable" in x)).sort((x, y) => ((y as { expected_points: number }).expected_points) - ((x as { expected_points: number }).expected_points)).slice(0, 6) },
  };
}

/** Apply the qualified D/ST component values (current week only) to roster + market. Non-qualified leagues are returned unchanged. */
export function withQualifiedDst(inp: EarlyInputs, cap: KdstCapture | null, league: string, week: number): { inp: EarlyInputs; replaced: Array<{ player_id: string; team: string; value: number }> } {
  if (!cap) return { inp, replaced: [] };
  const r = applyQualifiedDst(inp.roster, cap, league, week); const m = applyQualifiedDst(inp.market.candidates, cap, league, week);
  if (!r.replaced.length && !m.replaced.length) return { inp, replaced: [] };
  return { inp: { ...inp, roster: r.assets, market: { ...inp.market, candidates: m.assets }, notes: [...inp.notes, `W2.R1 qualified D/ST component values applied to ${r.replaced.length + m.replaced.length} D/ST assets (current week only)`] }, replaced: [...r.replaced, ...m.replaced] };
}

export function upsideReport(ctx: WeeklyTeamContext, inp: EarlyInputs, cap: UpsideCapture | null, pos: string | null, limit: number) {
  if (!cap || cap.meta.target_week !== ctx.league.week) return { label: UPSIDE_LABEL, state: "UNAVAILABLE", reason: `no frozen pregame capture for week ${ctx.league.week}` };
  const mine = inp.roster.filter((a) => ["QB", "RB", "WR", "TE"].includes(a.position)).map((a) => ({ player: a.name, ...upsideForPlayer(cap, a.position, a.name, a.team) }));
  return { label: UPSIDE_LABEL, not_breakout_probability: true, mine, ...(pos ? { listing: upsideListing(cap, pos, limit) } : {}) };
}
