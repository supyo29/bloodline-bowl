/**
 * Phase 4 (Checkpoint C) — the ASSET VALUE model. One function values ANY player (a free-agent candidate or one of my
 * rostered players, for the drop side) against MY roster, in league-scoring points, decomposed by horizon and by kind
 * (starter / bench option / contingency). Every number is a sum of named components with its evidence.
 *
 * Boundaries honoured here:
 *  - Role Intelligence is CONSUMED (recent vs season vs prior, trend, confidence); its logic is not duplicated.
 *  - Opportunity Propagation is CONDITIONAL: it counts toward value only when an official availability designation of a
 *    teammate establishes the condition (weighted by the designation's play probability); otherwise the payoff is reported
 *    as `contingency_payoff` with ZERO weight in value. OPP is never used as an injury-probability model.
 *  - Football Intelligence opponent readings explain the schedule but carry NO numeric weight in this phase.
 *  - Recent fantasy points are never a value input; they are only compared with what the role implies (fluke detection).
 */
import { isEligible } from "@/lib/weekly/lineup";
import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { DimensionProfile, PlayerRoleProfile } from "@/lib/player-role-intelligence/schema";
import { PARAMS } from "./config";
import { round2, round3, type WaiverContext } from "./context";
import type { Archetype, AssetValue, Component, HorizonValues, OppAssessment, RoleAssessment, ScheduleAssessment, Uncertainty, UncertaintyComponent, ValueByKind } from "./types";

export const DECISION_HORIZON_WEEKS = 6;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const CONF_RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, INSUFFICIENT_SAMPLE: 0 };
const minConf = (a: string[]): string | null => (a.length ? a.reduce((m, c) => ((CONF_RANK[c] ?? 0) < (CONF_RANK[m] ?? 0) ? c : m)) : null);

type Dim = { key: string; label: string; kind: "target" | "carry"; get: (p: PlayerRoleProfile) => DimensionProfile | null };
const DIMS: Dim[] = [
  { key: "target_share", label: "Target share", kind: "target", get: (p) => p.receiving?.target_share ?? null },
  { key: "rush_share", label: "Rush share", kind: "carry", get: (p) => p.rushing?.rush_share ?? null },
];

/* ------------------------------------------------------------------------------------------------ role */
export function assessRole(ctx: WaiverContext, p: CanonicalPlayer): RoleAssessment {
  const prof = ctx.role(p); const ro = ctx.input.role;
  const empty: RoleAssessment = { status: "UNAVAILABLE", level: null, trend: null, evidence: null, confidence: null, role_delta_points: 0, persisted_points: 0, capped: false, components: [], through_week: ro?.through_week ?? null, version: ro?.version ?? null };
  if (!prof) return { ...empty, components: [{ key: "role", label: "Role Intelligence profile", value: null, unit: "n/a", status: "UNAVAILABLE", note: ro ? "no current Role Intelligence profile for this player (never backfilled from another season)" : "Role Intelligence is not published" }] };
  const vol = PARAMS.team_volume.value; const comps: Component[] = []; let raw = 0; const confs: string[] = []; let persisted = 0;
  for (const d of DIMS) {
    const dim = d.get(prof); if (!dim) continue;
    const ppo = d.kind === "target" ? ctx.ppo.target : ctx.ppo.carry; const v = d.kind === "target" ? vol.targets! : vol.carries!;
    if (dim.recent == null || dim.season == null) { comps.push({ key: `role.${d.key}`, label: `${d.label}: recent vs season`, value: null, unit: "points/week", status: "UNAVAILABLE", note: "recent or season value unavailable" }); continue; }
    const deltaShare = dim.recent - dim.season; const pts = deltaShare * v * ppo;
    const phi = PARAMS.role_persistence.value[dim.confidence] ?? 0.1; raw += pts; persisted += pts * phi; confs.push(dim.confidence);
    comps.push({ key: `role.${d.key}`, label: `${d.label}: recent ${round3(dim.recent)} vs season ${round3(dim.season)} (trend ${dim.trend_recent_vs_prior}/${dim.trend_latest_vs_season})`, value: round2(pts), unit: "points/week", weight: phi, contribution: round2(pts * phi), status: "AVAILABLE", note: `${dim.confidence} confidence, ${dim.n_games_season} games; persisted share ${phi}`, basis: "share delta x team volume prior x league-scoring points per opportunity" });
  }
  const cap = PARAMS.role_delta_cap_points.value; const capped = Math.abs(persisted) > cap; const pp = clamp(persisted, -cap, cap);
  return { status: "AVAILABLE", level: prof.role_state.role_level, trend: prof.role_state.role_trend, evidence: prof.role_state.evidence_state, confidence: minConf(confs) ?? "INSUFFICIENT_SAMPLE", role_delta_points: round2(raw), persisted_points: round2(pp), capped, components: comps, through_week: ro?.through_week ?? null, version: ro?.version ?? null };
}

/* ------------------------------------------------------------------------------------------------ OPP (conditional) */
const isMod = (s: string | null | undefined) => (s ?? "").toUpperCase();
function designation(ctx: WaiverContext, p: CanonicalPlayer): { label: string; play: number } | null {
  const s = isMod(ctx.proj(p.canonical_player_id)?.injury_status ?? p.injury_status);
  if (!s) return null; const t = PARAMS.designation_play_probability.value;
  const key = s.startsWith("OUT") || s === "O" ? "OUT" : s.startsWith("IR") || s.includes("RESERVE") ? "IR" : s.startsWith("DOUB") || s === "D" ? "DOUBTFUL" : s.startsWith("QUES") || s === "Q" ? "QUESTIONABLE" : s.startsWith("PROB") ? "PROBABLE" : null;
  return key ? { label: key, play: t[key]! } : null;
}
function oppPointsFor(ctx: WaiverContext, team: string, unavailable: string[], candidateGsis: string): { points: number; residual: string | null; version: string | null; support: string | null } | null {
  const res = ctx.opp(team, unavailable); if (!res || !res.beneficiaries) return null;
  const vol = PARAMS.team_volume.value; let pts = 0;
  for (const b of res.beneficiaries) {
    if (b.beneficiary_gsis_id !== candidateGsis || b.expected_delta == null) continue;
    if (b.dimension === "target_share") pts += b.expected_delta * vol.targets! * ctx.ppo.target;
    else if (b.dimension === "rush_share") pts += b.expected_delta * vol.carries! * ctx.ppo.carry;
  }
  const resid = res.residual?.reduce((s, r) => s + Math.max(0, r.structural_residual ?? 0), 0) ?? 0;
  return { points: round2(pts), residual: resid > 0 ? `${round3(resid)} unallocated opportunity share remains` : null, version: res.opportunity_propagation_version, support: res.scenario.support_level };
}

export function assessOpp(ctx: WaiverContext, p: CanonicalPlayer, role: RoleAssessment): OppAssessment {
  const base: OppAssessment = { status: "NOT_ESTABLISHED", condition: null, unavailable: [], conditional_payoff_points: 0, counted_points: 0, residual_note: null, version: null, support_level: null };
  const gsis = p.identifiers.gsis_id; if (!ctx.input.opp || !gsis || !p.nfl_team || !["RB", "WR", "TE"].includes(p.position)) return { ...base, status: ctx.input.opp ? "NOT_ESTABLISHED" : "UNAVAILABLE", condition: !gsis ? "no gsis identity" : null };
  const mates = [...ctx.players.values()].filter((m) => m.nfl_team === p.nfl_team && m.canonical_player_id !== p.canonical_player_id && ["RB", "WR", "TE"].includes(m.position) && m.identifiers.gsis_id);
  const est = mates.map((m) => ({ m, d: designation(ctx, m) })).filter((x): x is { m: CanonicalPlayer; d: { label: string; play: number } } => !!x.d && x.d.play < 0.9);
  let counted = 0; const unavail: OppAssessment["unavailable"] = []; let resid: string | null = null; let ver: string | null = null; let sup: string | null = null; let anyEst = false;
  for (const { m, d } of est) {
    const r = oppPointsFor(ctx, p.nfl_team, [m.identifiers.gsis_id!], gsis); if (!r) continue;
    anyEst = true; counted += r.points * (1 - d.play); unavail.push({ player: m.full_name, designation: d.label, play_probability: d.play }); resid = r.residual ?? resid; ver = r.version; sup = r.support;
  }
  // the unweighted "if the team's lead player missed" payoff: reported, NEVER counted
  const lead = mates.map((m) => ({ m, prof: ctx.role(m) })).filter((x) => x.prof).sort((a, b) => ((b.prof!.rushing?.rush_share.season ?? 0) + (b.prof!.receiving?.target_share.season ?? 0)) - ((a.prof!.rushing?.rush_share.season ?? 0) + (a.prof!.receiving?.target_share.season ?? 0)))[0];
  let cond = 0; if (lead && !est.some((e) => e.m === lead.m)) { const r = oppPointsFor(ctx, p.nfl_team, [lead.m.identifiers.gsis_id!], gsis); if (r) { cond = r.points; ver = ver ?? r.version; sup = sup ?? r.support; } }
  void role;
  return { status: anyEst ? "ESTABLISHED" : "NOT_ESTABLISHED", condition: anyEst ? unavail.map((u) => `${u.player} ${u.designation}`).join("; ") : lead ? `no teammate designation establishes an absence; payoff shown only as "if ${lead.m.full_name} missed"` : null, unavailable: unavail, conditional_payoff_points: round2(Math.max(cond, anyEst ? counted : 0)), counted_points: round2(counted), residual_note: resid, version: ver, support_level: sup };
}

/* ------------------------------------------------------------------------------------------------ schedule */
export function assessSchedule(ctx: WaiverContext, p: CanonicalPlayer): ScheduleAssessment {
  const s = ctx.input.schedule; const notes: string[] = [];
  const bye = ctx.byeWeek(p);
  if (!s) return { status: "UNAVAILABLE", bye_week: bye, games_remaining: null, next_opponents: [], fi_adjustment_points: 0, fi_numeric: false, notes: ["no NFL schedule evidence"], playoff_opponents_known: 0 };
  const next = [0, 1, 2].map((i) => ({ week: ctx.week + i, opponent: p.nfl_team ? s.opponent(p.nfl_team, ctx.week + i) : null })).filter((x) => x.week <= ctx.lastWeek);
  const remaining = ctx.lastWeek - ctx.week + 1 - (bye != null && bye >= ctx.week ? 1 : 0);
  const playoffs = PARAMS.fantasy_playoff_weeks.value.filter((w) => w >= ctx.week);
  const known = p.nfl_team ? playoffs.filter((w) => s.opponent(p.nfl_team!, w) != null).length : 0;
  const fi = 0; const fiEv = ctx.input.fi;
  if (fiEv && p.nfl_team) {
    const opps = next.map((n) => n.opponent).filter((x): x is string => !!x);
    for (const t of opps) { ctx.counters.fi_calls += 1; const rd = fiEv.defense(t); const pass = rd.find((x) => /pass_epa_allowed/.test(x.metric)); const rush = rd.find((x) => /rush_epa_allowed/.test(x.metric)); const r = p.position === "RB" ? rush : pass; if (r) notes.push(`${t} defense ${r.metric}: league percentile ${r.league_percentile == null ? "n/a" : round2(r.league_percentile)} (${r.predictive_status}) — explanatory only`); }
    notes.push(`FI opponent readings are EXPLANATORY: no numeric weight in Waiver 2.0 (${fiEv.week_state ?? "week state unknown"}, through week ${fiEv.through_week ?? "?"}); deep player-specific matchup value is Phase 5.`);
  } else notes.push("no Football Intelligence opponent evidence for this player");
  if (bye != null) notes.push(`bye week ${bye}`);
  return { status: "AVAILABLE", bye_week: bye, games_remaining: remaining, next_opponents: next, fi_adjustment_points: fi, fi_numeric: false, notes, playoff_opponents_known: known };
}

/* ------------------------------------------------------------------------------------------------ uncertainty */
function uncertaintyFor(ctx: WaiverContext, p: CanonicalPlayer, value: number, role: RoleAssessment, opp: OppAssessment): Uncertainty {
  const wt = PARAMS.uncertainty_weights.value; const wp = ctx.proj(p.canonical_player_id); const comps: UncertaintyComponent[] = [];
  const add = (source: keyof typeof wt, level: number, reason: string) => comps.push({ source, level: round3(clamp(level, 0, 1)), weight: wt[source], reason });
  const conf = role.confidence; add("role", role.status === "UNAVAILABLE" ? 0.75 : 1 - (CONF_RANK[conf ?? "INSUFFICIENT_SAMPLE"] ?? 0) / 3, role.status === "UNAVAILABLE" ? "no Role Intelligence evidence for this player" : `Role confidence ${conf}`);
  const prof = ctx.role(p); const n = Math.min(prof?.receiving?.target_share.n_games_season ?? 99, prof?.rushing?.rush_share.n_games_season ?? 99);
  add("sample", prof ? (n < 3 ? 0.8 : n < 6 ? 0.5 : 0.2) : 0.7, prof ? `${n === 99 ? "n/a" : n} games in the season sample` : "no sample");
  const stat = wp?.projection_status; const rel = wp?.std_dev && wp.projected_points ? Math.min(1, wp.std_dev / Math.max(1, wp.projected_points)) : 0.5;
  add("projection", wp == null || (stat !== "projected" && stat !== "bye") || wp.projected_points == null ? 0.85 : clamp(rel * 0.8, 0.1, 0.8), wp == null ? "no projection" : wp.uncertainty_source === "position_volatility_heuristic" ? "projection spread is a position-volatility heuristic, not a source distribution" : "projection spread from the source distribution");
  const lag = ctx.input.role?.through_week != null ? Math.max(0, ctx.week - 1 - ctx.input.role.through_week) : 0; const fiPartial = ctx.input.fi?.week_state === "PARTIAL";
  add("source_lag", Math.min(1, lag / 3 + (fiPartial ? 0.2 : 0)), `Role through week ${ctx.input.role?.through_week ?? "?"} vs week ${ctx.week}${fiPartial ? "; FI is a PARTIAL week" : ""}`);
  add("pool", ctx.input.pool.certification === "CERTIFIED" ? 0 : 1, ctx.input.pool.certification === "CERTIFIED" ? "certified free-agent pool" : "pool is UNCERTIFIED: unrostered in ownership data is not a certified free agent");
  const des = designation(ctx, p); add("injury_contingency", opp.counted_points > 0 ? 0.6 : des && des.play < 0.9 ? 0.45 : 0.1, opp.counted_points > 0 ? `value partly rests on an established teammate absence (${opp.condition})` : des ? `own designation ${des.label}` : "no availability dependence");
  const dis = wp?.ros?.disagreement_pct; add("ros_disagreement", dis == null ? 0.2 : Math.min(1, Math.abs(dis) / 0.5), dis == null ? "single ROS source" : `RI vs external season projection differ by ${Math.round(Math.abs(dis) * 100)}%`);
  add("depth_chart", role.evidence === "OBSERVED" && role.trend !== "UNCERTAIN" ? 0.15 : role.status === "AVAILABLE" ? 0.6 : 0.5, `role evidence ${role.evidence ?? "n/a"}, trend ${role.trend ?? "n/a"}`);
  const sw = comps.reduce((s, c) => s + c.weight, 0); const total = round3(comps.reduce((s, c) => s + c.weight * c.level, 0) / sw);
  return { total, components: comps, value_low: round2(value * (1 - total)), value_high: round2(value * (1 + total)) };
}

/* ------------------------------------------------------------------------------------------------ asset value */
export interface AssetOptions { role: "CANDIDATE" | "ROSTERED" }

export function assetValue(ctx: WaiverContext, p: CanonicalPlayer, opts: AssetOptions): AssetValue {
  ctx.counters.assets_built += 1;
  const id = p.canonical_player_id; const wp = ctx.proj(id); const pos = p.position;
  const role = assessRole(ctx, p); const opp = assessOpp(ctx, p, role); const sched = assessSchedule(ctx, p);
  const rep = ctx.replacement[pos]; const comps: Component[] = [];
  const lNow = wp?.projected_points ?? null; const ros = wp?.rest_of_season_points ?? null; const rosPerWeek = ros != null ? ros / ctx.weeksRemaining : null;
  const level_basis = lNow != null ? "current weekly projection" : rosPerWeek != null ? "rest-of-season projection per week (no weekly projection)" : "no projection";
  const seed = lNow ?? rosPerWeek; const fut = rosPerWeek ?? seed;
  const rva = realizedVsOpportunity(ctx, p, role);
  const haircut = rva.signal === "POINTS_ABOVE_ROLE" ? 0.25 : 0;
  // margin: what this player must beat on THIS roster. A candidate or a rostered BENCH player must beat the marginal starter he could displace;
  // a rostered STARTER's replacement is the best bench alternative (a starter is only worth what he adds over his cover).
  const benchAt = (excl: string | null) => Math.max(0, ...ctx.activeIds.filter((x) => x !== excl && ctx.players.get(x)?.position === pos && !ctx.startersByPlayer.has(x)).map((x) => ctx.proj(x)?.projected_points ?? 0));
  const isMyStarter = opts.role === "ROSTERED" && ctx.startersByPlayer.has(id);
  const margin = isMyStarter ? benchAt(id) : (ctx.marginalStarter(p) ?? rep?.starter_baseline ?? rep?.free_agent_replacement ?? 0);
  const avail0 = wp?.expected_availability ?? 1; const bye = sched.bye_week; const d = PARAMS.horizon_discount_per_week.value;
  const weeks: Array<{ week: number; level: number; sv: number }> = [];
  for (let w = ctx.week; w <= ctx.lastWeek; w++) {
    const k = w - ctx.week; const mix = Math.min(1, k / 4);
    let lvl = seed == null ? 0 : (1 - mix) * (lNow ?? seed) + mix * (fut ?? seed);
    if (k > 0 && haircut) lvl *= 1 - haircut;
    lvl += role.persisted_points; if (k === 0) lvl += opp.counted_points;
    const isBye = bye != null && w === bye; if (isBye) lvl = 0;
    const av = k === 0 ? avail0 : 1; const sv = Math.max(0, lvl - margin) * av * Math.pow(1 - d, k);
    weeks.push({ week: w, level: lvl, sv: isBye ? 0 : sv });
  }
  const sum = (from: number, to: number) => round2(weeks.filter((x) => x.week >= from && x.week <= to).reduce((s, x) => s + x.sv, 0));
  const playoffs = PARAMS.fantasy_playoff_weeks.value; const decisionEnd = Math.min(ctx.lastWeek, ctx.week + DECISION_HORIZON_WEEKS - 1);
  const starter = sum(ctx.week, decisionEnd);
  // optionality (bench value): role growth, variance upside, depth-chart uncertainty — components exposed
  const ow = PARAMS.option_weights.value; const H = PARAMS.option_horizon_weeks.value;
  const sd = wp?.std_dev ?? (lNow != null ? Math.max(3, lNow * 0.4) : 4); const ceil = wp?.ceiling_points ?? (lNow != null ? lNow + sd : null);
  const pStart = clamp(0.5 + ((lNow ?? seed ?? 0) - margin) / (2 * Math.max(sd, 3)), 0, 1);
  const growth = Math.max(0, role.persisted_points) * ow.role_growth; const variance = ceil != null && lNow != null ? Math.max(0, ceil - lNow) * pStart * ow.variance_upside : 0;
  const dcu = role.evidence && role.evidence !== "OBSERVED" && role.trend !== "STABLE" && (lNow ?? 0) > 0 ? (lNow ?? 0) * 0.15 * ow.depth_chart_uncertainty : 0;
  // positional DEPTH: the price of insurance — chance a bench player is needed x how much better he is than the cover already on hand (or the free-agent level)
  const obtainable = rep?.fa_basis === "available_pool_marginal" ? (rep.free_agent_replacement ?? 0) : 0; // a fallback replacement level is not something a manager can actually add
  const coverAlt = Math.max(benchAt(opts.role === "ROSTERED" ? id : null), obtainable);
  const depth = isMyStarter ? 0 : DECISION_HORIZON_WEEKS * (PARAMS.depth_need_probability.value[pos] ?? 0.1) * Math.max(0, (lNow ?? seed ?? 0) - coverAlt);
  const bench_option = round2(H * (growth + variance + dcu) + depth);
  // own-roster injury insurance: counted only from OFFICIAL designations of my starters at eligible slots; unweighted payoff reported
  let insuranceCounted = 0; let insurancePayoff = 0;
  if (opts.role === "CANDIDATE") {
    const altBench = Math.max(0, ...ctx.activeIds.filter((x) => !ctx.startersByPlayer.has(x) && ctx.players.get(x)?.position === pos).map((x) => ctx.proj(x)?.projected_points ?? 0));
    const gain = Math.max(0, (lNow ?? seed ?? 0) - altBench); insurancePayoff = gain * 0.25;
    for (const sid of ctx.startersByPlayer.keys()) { const sp = ctx.players.get(sid); if (!sp || !isEligible(ctx.startersByPlayer.get(sid)!.slot, p)) continue; const dz = designation(ctx, sp); if (dz && dz.play < 0.9) insuranceCounted += (1 - dz.play) * gain; }
  }
  const contingency_counted = round2(opp.counted_points + insuranceCounted);
  const contingency_payoff = round2(Math.max(opp.conditional_payoff_points, 0) + insurancePayoff);
  const horizons: HorizonValues = { next_week: sum(ctx.week, ctx.week), next_3: sum(ctx.week, ctx.week + 2), ros: sum(ctx.week, ctx.lastWeek), playoffs: sum(Math.max(ctx.week, playoffs[0]!), playoffs[playoffs.length - 1]!), stash: round2(bench_option + contingency_counted) };
  const by_kind: ValueByKind = { starter, bench_option, contingency_payoff, contingency_counted };
  comps.push({ key: "level", label: "Weekly level (league-scoring points)", value: lNow == null ? null : round2(lNow), unit: "points/week", status: lNow == null ? "UNAVAILABLE" : "AVAILABLE", note: level_basis });
  comps.push({ key: "margin", label: `Level to beat on this roster at ${pos}`, value: round2(margin), unit: "points/week", status: "AVAILABLE", note: opts.role === "CANDIDATE" ? "lowest current optimal starter this player is eligible to displace (else starter baseline / FA replacement)" : "best bench alternative at the position if this player is dropped" });
  comps.push({ key: "starter_value", label: `Starter value over the ${DECISION_HORIZON_WEEKS}-week decision horizon`, value: starter, unit: "points", status: "AVAILABLE" });
  comps.push({ key: "role_persisted", label: "Role trajectory (persisted, capped)", value: role.persisted_points, unit: "points/week", status: role.status, note: role.capped ? "capped" : undefined });
  comps.push({ key: "bench_option", label: "Bench optionality", value: bench_option, unit: "points", status: "AVAILABLE", note: `growth ${round2(growth)}, variance ${round2(variance)}, depth-chart ${round2(dcu)} per week x ${H} weeks; positional depth (insurance) ${round2(depth)}` });
  comps.push({ key: "opp_counted", label: "Opportunity Propagation (counted: established teammate absence only)", value: opp.counted_points, unit: "points (next week)", status: opp.status === "UNAVAILABLE" ? "UNAVAILABLE" : "AVAILABLE", note: opp.condition ?? undefined });
  comps.push({ key: "contingency_payoff", label: "Contingent payoff if the condition occurred (NOT counted)", value: contingency_payoff, unit: "points", status: "AVAILABLE", note: "conditional; carries zero weight unless an official designation establishes the condition" });
  const total = round2(starter + bench_option + contingency_counted);
  const uncertainty = uncertaintyFor(ctx, p, total, role, opp);
  const upsideOnly = round2(H * (growth + variance + dcu));
  const { archetype, evidence } = classify(ctx, p, { role, opp, sched, starter, bench_option: upsideOnly, contingency_payoff, contingency_counted, rva, lNow, margin, rep });
  return { player_id: id, name: p.full_name || id, position: pos, weekly_level: lNow == null ? null : round2(lNow), level_basis, horizons, by_kind, role, opp, schedule: sched, components: comps, uncertainty, archetype, archetype_evidence: evidence, realized_vs_opportunity: rva };
}

/* ------------------------------------------------------------------------------------------------ expected vs realized */
export function realizedVsOpportunity(ctx: WaiverContext, p: CanonicalPlayer, role: RoleAssessment): AssetValue["realized_vs_opportunity"] {
  const pts = ctx.input.recent_points?.[p.canonical_player_id]; const prof = ctx.role(p);
  if (!pts || !pts.length) return { status: "UNAVAILABLE", signal: "UNKNOWN", note: "no realized fantasy-point history was supplied; no expected-vs-realized claim is made (no expected-points model exists)" };
  if (!prof) return { status: "UNAVAILABLE", signal: "UNKNOWN", note: "no Role Intelligence profile to compare realized points against" };
  const vol = PARAMS.team_volume.value; let implied = 0; let any = false;
  for (const d of DIMS) { const dim = d.get(prof); if (!dim || dim.season == null) continue; any = true; implied += dim.season * (d.kind === "target" ? vol.targets! * ctx.ppo.target : vol.carries! * ctx.ppo.carry); }
  if (!any) return { status: "UNAVAILABLE", signal: "UNKNOWN", note: "no opportunity dimension to compare against" };
  const recent = pts.slice(-2).reduce((s, x) => s + x, 0) / Math.min(2, pts.length);
  if (recent > implied * 1.5 && role.persisted_points <= 0.25) return { status: "AVAILABLE", signal: "POINTS_ABOVE_ROLE", note: `recent ${round2(recent)} pts/g vs ~${round2(implied)} implied by season opportunity, with no role growth: a possible fluke` };
  if (recent < implied * 0.6) return { status: "AVAILABLE", signal: "POINTS_BELOW_ROLE", note: `recent ${round2(recent)} pts/g vs ~${round2(implied)} implied by season opportunity: production lags the role` };
  return { status: "AVAILABLE", signal: "SUPPORTED_BY_ROLE", note: `recent ${round2(recent)} pts/g is consistent with the ~${round2(implied)} the role implies` };
}

/* ------------------------------------------------------------------------------------------------ archetypes (descriptive) */
function classify(ctx: WaiverContext, p: CanonicalPlayer, x: { role: RoleAssessment; opp: OppAssessment; sched: ScheduleAssessment; starter: number; bench_option: number; contingency_payoff: number; contingency_counted: number; rva: AssetValue["realized_vs_opportunity"]; lNow: number | null; margin: number; rep?: { free_agent_replacement: number | null } }): { archetype: Archetype; evidence: string[] } {
  const ev: string[] = []; const prof = ctx.role(p);
  const ret = prof ? Math.max(prof.returns.kick_return_role.recent ?? 0, prof.returns.punt_return_role.recent ?? 0) : 0;
  const offRole = (prof?.participation?.recent ?? 0);
  const c: Array<[Archetype, boolean, string]> = [
    ["FLUKE_RISK", x.rva.signal === "POINTS_ABOVE_ROLE", x.rva.note],
    ["DECLINING_TRAP", x.role.trend === "CONTRACTING" && (x.lNow ?? 0) > (x.rep?.free_agent_replacement ?? 0), `Role trend CONTRACTING while the weekly level still looks playable`],
    ["SHORT_TERM_INJURY_REPLACEMENT", x.opp.status === "ESTABLISHED" && x.opp.counted_points > 0.5, `teammate absence established (${x.opp.condition}); conditional payoff counted for next week only`],
    ["IMMEDIATE_STARTER", x.starter >= 6 && (x.lNow ?? 0) > x.margin + 1, `starter value ${x.starter} over the decision horizon`],
    ["ROLE_GROWTH_BREAKOUT", x.role.persisted_points >= 1 && x.role.trend === "EXPANDING" && (CONF_RANK[x.role.confidence ?? ""] ?? 0) >= 2, `persisted role growth ${x.role.persisted_points} pts/week, trend EXPANDING, ${x.role.confidence}`],
    ["SPECULATIVE_ROOKIE", prof?.receiving?.target_share.discontinuity === "ROOKIE_OR_NO_PRIOR_SEASON" || prof?.rushing?.rush_share.discontinuity === "ROOKIE_OR_NO_PRIOR_SEASON", "no prior-season role evidence (rookie/new)"],
    ["CONTINGENT_HANDCUFF", x.opp.conditional_payoff_points >= 1.5 && x.opp.counted_points === 0, `conditional Opportunity Propagation payoff ${x.opp.conditional_payoff_points} if the team's lead player were unavailable (no designation establishes it: not counted)`],
    ["RETURN_SPECIALIST_VALUE", ret >= 0.5 && offRole < 0.3, `return role share ${round2(ret)} with little offensive participation`],
    ["UPSIDE_BENCH_STASH", x.bench_option >= 1, `bench optionality ${x.bench_option}`],
    ["SCHEDULE_STREAMER", ["K", "DEF"].includes(p.position) && x.starter > 0, "streamable position with starter value this horizon"],
    ["FLOOR_DEPTH", (x.lNow ?? 0) > (x.rep?.free_agent_replacement ?? Infinity) && x.starter < 6, "playable depth: above replacement level without displacing a starter for long"],
  ];
  for (const [a, ok, e] of c) if (ok) { ev.push(`${a}: ${e}`); }
  const first = c.find(([, ok]) => ok);
  return { archetype: first ? first[0] : "NO_CLEAR_ROLE", evidence: ev.length ? ev : ["no archetype's evidence threshold is met"] };
}
