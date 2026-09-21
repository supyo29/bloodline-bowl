/**
 * Phase 4 — Waiver Intelligence 2.0 evidence, Book-Ready BY CONSTRUCTION: the model's own outputs are expressed in the shared
 * EvidenceBlock contract (value, unit, evidence class, confidence, uncertainty, decomposition, comparison, lineage, content
 * identity, availability, chart hints). SHADOW_ONLY. Nothing here re-scores: it converts an already-computed WaiverEvaluation.
 * An uncertified free-agent pool yields UNAVAILABLE (never a ranking presented as actionable) unless the caller explicitly asks
 * for an ILLUSTRATIVE view, which is labelled on every block.
 */
import type { WaiverAction, WaiverEvaluation } from "@/lib/waiver2/types";
import { WAIVER2_ENGINE_VERSION } from "@/lib/waiver2/config";
import { marketRefOf } from "@/lib/waiver2/market-pool";
import { bookReadyDeploymentState, mayInfluenceProduction, WAIVER2_LIFECYCLE_STATE } from "@/lib/waiver2/lifecycle";
import { confidenceFor } from "../vocabulary";
import { unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { Component, EvidenceBlock, TemporalIdentity } from "../schema";
import { PHASE7, mk as mkRaw, notAvailable } from "../common";

const SURFACE = "waiver-intelligence-2";
/** Contract hygiene applied to EVERY block: a non-available block carries the UNAVAILABLE class; a DESCRIPTIVE block is never predictive. */
const mk = (b: Omit<EvidenceBlock, "evidence_id" | "contract_version">, key: unknown[] = []): EvidenceBlock => {
  let x = b;
  if (x.availability.state !== "AVAILABLE") { const { predictive: _p, ...rest } = x; void _p; x = { ...rest, origin: { source_class: x.availability.state, analysis_class: "UNAVAILABLE" } }; }
  else if (x.origin.analysis_class === "DESCRIPTIVE") x = { ...x, predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" } };
  return mkRaw(x, key);
};
const BUILT_IN = phaseRef("INTELLIGENCE_MODERNIZATION_PHASE", "4");
export interface Waiver2Meta { league_slug: string; manager_slug: string; season: number; illustrative: boolean }
const temporal = (season: number, week: number, at: string): TemporalIdentity => ({ season, week, through_week: null, as_of: at, generated_at: at, source_cutoff: null, point_kind: "CURRENT", as_of_kind: "CURRENT_SNAPSHOT", week_state: null, snapshot_id: null, player_team_temporal_identity: PHASE7 });
const pts = (key: string, value: number | null, label?: string, note?: string): Component => ({ key, ...(label ? { label } : {}), value, unit: unitFor("waiver2.points"), ...(note ? { note } : {}) });

function common(ev: WaiverEvaluation, m: Waiver2Meta, topic: string) {
  const lim = ["SHADOW_ONLY Waiver Intelligence 2.0: never alters the production waiver output (waiver-engine-2026.1) and never submits a claim", "component weights are PRIOR_UNVALIDATED: no waiver-pool history exists to validate them (docs Phase 4 §20)", ...(ev.availability.certification !== "CERTIFIED" ? ["ILLUSTRATIVE ONLY: the free-agent pool is NOT certified — unrostered in ownership data is not a certified free agent; nothing here is actionable"] : [])];
  return {
    surface: SURFACE, topic, deployment: { state: bookReadyDeploymentState(), may_influence_production: mayInfluenceProduction() }, temporal: temporal(m.season, ev.week, ev.generated_at),
    freshness: { as_of: ev.generated_at, through_week: null, generated_at: ev.generated_at },
    lineage: { surface_version: WAIVER2_ENGINE_VERSION, content_identity: ev.evaluation_hash, canonical: { actionable: ev.availability.status === "AVAILABLE", evidence_mode: ev.availability.status === "AVAILABLE" ? "LIVE_CERTIFIED_POOL" : m.illustrative ? "ILLUSTRATIVE_UNCERTIFIED_POOL" : "BLOCKED", lifecycle_state: WAIVER2_LIFECYCLE_STATE, snapshot: ev.lineage.snapshot, scoring_fingerprint: ev.scoring_fingerprint, pool_certification: ev.availability.certification, params_hash: ev.lineage.params_hash, projection_model: ev.lineage.projection_model, market: ((mr) => (mr ? { market_content_id: mr.market_content_id, pool_id: mr.pool_id, manager_acquisition_context_id: mr.acquisition_context_id, history_class: mr.history_class, readiness_status: mr.readiness_status, limitations: mr.limitations, coverage: mr.coverage } : null))(marketRefOf(ev)) }, depends_on: [...((mr) => (mr ? [{ surface: "league-market-state", version: mr.market_content_id }] : []))(marketRefOf(ev)), { surface: "role-opportunity", version: ev.lineage.role }, { surface: "football-intelligence", version: ev.lineage.fi }, { surface: "opportunity-propagation", version: ev.lineage.opp }] },
    source: { built_in: BUILT_IN, source_data: "canonical league snapshot + weekly projections + Role / OPP / FI (consumed, never recomputed)" },
    limitations: lim, predictive: { source_status: "SHADOW_ONLY_MODEL", class: "SHADOW_PREDICTIVE" as const },
    origin: { source_class: "SHADOW_MODEL_OUTPUT", analysis_class: "SHADOW" as const },
  };
}
const mgr = (m: Waiver2Meta, tail: string) => ({ kind: "MANAGER_TEAM" as const, id: `${m.league_slug}/${m.manager_slug}|${tail}`, league_slug: m.league_slug, manager_slug: m.manager_slug });

/** UNAVAILABLE gate shared by every waiver2 topic. */
function gate(ev: WaiverEvaluation, m: Waiver2Meta, topic: string): EvidenceBlock[] | null {
  const { origin: _o, predictive: _p, ...c0 } = common(ev, m, topic); void _o; void _p;
  const base = { ...c0, metric: "*", subject: mgr(m, "waiver2") };
  if (ev.availability.status === "UNAVAILABLE") return [notAvailable({ ...base, limitations: [...base.limitations, ...ev.availability.reasons] }, "UNAVAILABLE", `no candidate pool: ${ev.availability.reasons.join("; ") || "empty"}`)];
  if (ev.availability.status === "UNCERTIFIED_POOL" && !m.illustrative) return [notAvailable({ ...base, limitations: base.limitations.filter((l) => !l.startsWith("ILLUSTRATIVE")) }, "UNAVAILABLE", "FREE_AGENT_POOL_UNAVAILABLE: the canonical free-agent pool is not certified, so waiver actions are not actionable and are not claimed to be current (pass illustrative=1 for a labelled, non-actionable view)")];
  return null;
}

export function waiver2ActionsEvidence(ev: WaiverEvaluation, m: Waiver2Meta, limit = 6): EvidenceBlock[] {
  const g = gate(ev, m, "waiver2.actions"); if (g) return g;
  const out: EvidenceBlock[] = []; const n = ev.actions.length; const shown = ev.actions.slice(0, limit);
  const kindAvail = (ok: boolean) => (ok ? { state: "AVAILABLE" as const } : { state: "UNAVAILABLE" as const, reason: "evidence unavailable for this candidate" });
  for (const a of shown) {
    const c = common(ev, m, "waiver2.actions"); const subject = mgr(m, a.id); const rank = ev.actions.indexOf(a) + 1; const asset = a.candidate_asset;
    const conf = confidenceFor("WAIVER2", a.confidence);
    const dropComps: Component[] = a.components.filter((x) => x.key.startsWith("drop.")).map((x) => pts(x.key, x.value, x.label));
    out.push(mk({ ...c, metric: "net_action_value", subject, availability: { state: "AVAILABLE" }, value: a.net_action_value, unit: unitFor("waiver2.points"), model_confidence: conf, uncertainty: { kind: "NET_VALUE_INTERVAL", range: [a.net_low, a.net_high], note: "from the decomposed uncertainty of the candidate and the drop; not a calibrated interval" },
      comparison: [{ population: { id: "MANAGER_CANDIDATE_ACTIONS", season: m.season, through_week: null, n, definition: "the add/drop actions Waiver 2.0 evaluated for this manager this week" }, rank: { position: rank, of: n, order: "VALUE_DESCENDING" }, percentile: n > 1 ? { value: Math.round((1 - (rank - 1) / (n - 1)) * 1000) / 1000, scale: "FRACTION_0_1", source: "COMPUTED", orientation: "VALUE_ORIENTED" } : null }],
      components: [pts("gross.starter", a.value_by_kind.starter, "starter value (decision horizon)"), pts("gross.bench_option", a.value_by_kind.bench_option, "bench optionality"), pts("gross.contingency_counted", a.value_by_kind.contingency_counted, "established contingency value"), pts("gross_add_value", a.gross_add_value), pts("drop_cost", -a.drop_cost), pts("acquisition_cost", -a.acquisition_cost), pts("risk_penalty", -a.risk_penalty), ...a.components.filter((x) => x.key === "adjustment.lineup").map((x) => pts(x.key, x.value, x.label, x.note))],
      relationships: [{ type: "DEPENDS_ON", target: { surface: "role-opportunity", version: ev.lineage.role } }, { type: "DEPENDS_ON", target: { surface: "football-intelligence", version: ev.lineage.fi } }, { type: "COMPARABLE_TO", target: { surface: SURFACE, topic: "waiver2.actions", note: "other candidate actions for this manager" } }],
      chart: [{ form: "bar", x: "components.key", y: "components.value", unit: "points" }, { form: "uncertainty", y: "value" }],
      limitations: [...c.limitations, `tier ${a.tier}${a.alternatives.length ? `; near-equivalent alternatives: ${a.alternatives.map((x) => x.name).join(", ")}` : ""}`, ...a.reasons] }, [a.id]));
    out.push(mk({ ...c, metric: "drop_cost", subject, availability: a.drop ? { state: "AVAILABLE" } : { state: "NOT_APPLICABLE", reason: "open roster spot: no drop required" }, ...(a.drop ? { value: a.drop_cost, unit: unitFor("waiver2.points"), components: dropComps } : {}), limitations: [...c.limitations, a.drop ? `drop ${a.drop.name} (${a.drop.position})` : "no drop"], chart: [{ form: "bar", x: "components.key", y: "components.value", unit: "points" }] }, [a.id, "drop"]));
    for (const [k, v] of Object.entries(a.horizons) as Array<[string, number]>) out.push(mk({ ...c, metric: `horizon.${k}`, subject, availability: { state: "AVAILABLE" }, value: v, unit: unitFor("waiver2.points"), limitations: [...c.limitations, k === "stash" ? "bench option + established contingency value, not starter value" : "starter value over this horizon, discounted per week"], chart: [{ form: "bar", x: "metric", y: "value", unit: "points" }] }, [a.id, k]));
    out.push(mk({ ...c, metric: "lineup_delta_next_week", subject, availability: kindAvail(a.lineup_delta_next_week.status === "RESOLVED"), ...(a.lineup_delta_next_week.value != null ? { value: a.lineup_delta_next_week.value, unit: unitFor("waiver2.points") } : {}), limitations: [...c.limitations, "exact next-week optimal-lineup counterfactual from the shared lineup optimizer; UNRESOLVED (not zero) on a projection gap"] }, [a.id, "ld"]));
    out.push(mk({ ...c, metric: "uncertainty.total", subject, availability: { state: "AVAILABLE" }, value: a.uncertainty.total, unit: unitFor("waiver2.fraction"), components: a.uncertainty.components.map((u) => ({ key: `uncertainty.${u.source}`, label: u.reason, value: u.level, unit: unitFor("waiver2.fraction"), note: `weight ${u.weight}` })), limitations: [...c.limitations, "each component states its reason; the weights are PRIOR_UNVALIDATED"], chart: [{ form: "bar", x: "components.key", y: "components.value", domain: [0, 1] }] }, [a.id, "unc"]));
    if (asset) {
      const r = asset.role;
      out.push(mk({ ...c, metric: "role.persisted_points", subject, availability: r.status === "AVAILABLE" ? { state: "AVAILABLE" } : { state: "UNAVAILABLE", reason: "no Role Intelligence profile for this player" }, ...(r.status === "AVAILABLE" ? { value: r.persisted_points, unit: unitFor("waiver2.points_per_week") } : {}),
        components: r.components.map((x) => ({ key: x.key, label: x.label, value: x.value, unit: unitFor("waiver2.points_per_week"), ...(x.note ? { note: x.note } : {}) })), origin: { source_class: "CONSUMED_ROLE_EVIDENCE", analysis_class: "DESCRIPTIVE" as const },
        relationships: [{ type: "DERIVED_FROM", target: { surface: "role-opportunity", version: r.version, note: "consumed Role Intelligence (recent vs season, trend, confidence); its logic is not duplicated" } }],
        limitations: [...c.limitations, `role level ${r.level ?? "n/a"}, trend ${r.trend ?? "n/a"}, evidence ${r.evidence ?? "n/a"}${r.capped ? "; capped" : ""}`, "converted to points through the league's canonical scoring and PRIOR opportunity volumes"] }, [a.id, "role"]));
      const o = asset.opp;
      out.push(mk({ ...c, metric: "opp.conditional_payoff", subject, availability: o.status === "UNAVAILABLE" ? { state: "UNAVAILABLE", reason: "no Opportunity Propagation evaluator" } : { state: "AVAILABLE" }, ...(o.status === "UNAVAILABLE" ? {} : { value: o.conditional_payoff_points, unit: unitFor("waiver2.points") }),
        origin: { source_class: "CONDITIONAL_SCENARIO", analysis_class: "CONDITIONAL" as const }, components: [pts("counted_points", o.counted_points, "counted (an official designation establishes the condition)"), pts("conditional_payoff", o.conditional_payoff_points, "payoff if the condition occurred")],
        relationships: [{ type: "CONDITIONAL_ON", target: { surface: "opportunity-propagation", version: o.version, note: o.condition ?? "a teammate's unavailability" } }],
        limitations: [...c.limitations, o.status === "ESTABLISHED" ? `condition established: ${o.condition}` : `condition NOT established — the payoff carries zero weight in net value (${o.condition ?? "no teammate absence"})`, "Opportunity Propagation is conditional and is not an injury-probability model", ...(o.residual_note ? [o.residual_note] : [])] }, [a.id, "opp"]));
      out.push(mk({ ...c, metric: "archetype", subject, availability: { state: "AVAILABLE" }, value: asset.archetype, unit: unitFor("category"), category: { raw: asset.archetype, normalized: null, mapping_status: "NO_VERIFIED_MAPPING" }, limitations: [...c.limitations, "a descriptive label from the underlying evidence — never an unexplained score bonus", ...asset.archetype_evidence] }, [a.id, "arch"]));
      const rv = asset.realized_vs_opportunity;
      out.push(mk({ ...c, metric: "realized_vs_opportunity", subject, availability: rv.status === "AVAILABLE" ? { state: "AVAILABLE" } : { state: "UNAVAILABLE", reason: rv.note }, ...(rv.status === "AVAILABLE" ? { value: rv.signal, unit: unitFor("category"), category: { raw: rv.signal, normalized: null, mapping_status: "NO_VERIFIED_MAPPING" as const } } : {}), limitations: [...c.limitations, rv.note] }, [a.id, "rva"]));
    }
  }
  out.push(mk({ ...common(ev, m, "waiver2.actions"), metric: "pass.recommended", subject: mgr(m, "pass"), availability: { state: "AVAILABLE" }, value: ev.recommended ? "MAKE_A_CLAIM" : "MAKE_NO_CLAIM", unit: unitFor("category"), category: { raw: ev.recommended ? "MAKE_A_CLAIM" : "MAKE_NO_CLAIM", normalized: null, mapping_status: "NO_VERIFIED_MAPPING" }, limitations: [...common(ev, m, "waiver2.actions").limitations, ...ev.pass.reasons] }, ["pass"]));
  return out;
}

export function waiver2MarketEvidence(ev: WaiverEvaluation, m: Waiver2Meta, limit = 4): EvidenceBlock[] {
  const g = gate(ev, m, "waiver2.market"); if (g) return g;
  const out: EvidenceBlock[] = [];
  for (const a of ev.actions.slice(0, limit)) {
    const c = common(ev, m, "waiver2.market"); const subject = mgr(m, a.id); const f = a.market.faab;
    out.push(mk({ ...c, metric: "scarcity", subject, availability: { state: "AVAILABLE" }, value: a.market.scarcity, unit: unitFor("waiver2.fraction"), limitations: [...c.limitations, "1/(1+ number of free agents at or above my starter baseline at the position)"] }, [a.id, "scarcity"]));
    for (const [k, v] of [["min_useful", f.min_useful], ["expected_competitive", f.expected_competitive], ["aggressive", f.aggressive], ["walk_away", f.walk_away]] as Array<[string, number | null]>) {
      out.push(mk({ ...c, metric: `faab.${k}`, subject, availability: f.status === "AVAILABLE" ? { state: "AVAILABLE" } : { state: f.status === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : "UNAVAILABLE", reason: f.status === "NOT_APPLICABLE" ? "this league is not FAAB" : "budget not visible" }, ...(f.status === "AVAILABLE" && v != null ? { value: v, unit: unitFor("waiver2.faab_dollars") } : {}),
        limitations: [...c.limitations, `calibration: ${f.calibration}`, ...f.method, ...f.uncertainty], relationships: [{ type: "DEPENDS_ON", target: { surface: SURFACE, topic: "waiver2.actions", note: "my surplus value, alternatives and budget shadow price" } }] }, [a.id, k]));
    }
    out.push(mk({ ...c, metric: "priority.advice", subject, availability: a.market.priority.status === "NOT_APPLICABLE" ? { state: "NOT_APPLICABLE", reason: a.market.priority.reason } : { state: "AVAILABLE" }, ...(a.market.priority.status !== "NOT_APPLICABLE" ? { value: a.market.priority.status, unit: unitFor("category"), category: { raw: a.market.priority.status, normalized: null, mapping_status: "NO_VERIFIED_MAPPING" as const } } : {}), limitations: [...c.limitations, a.market.priority.reason] }, [a.id, "prio"]));
    for (const comp of a.market.competitors.slice(0, 5)) {
      out.push(mk({ ...c, metric: "competitor.need_strength", subject: { ...subject, id: `${subject.id}|competitor:${comp.team_id}` }, availability: { state: "AVAILABLE" }, value: comp.need_strength, unit: unitFor("waiver2.fraction"),
        components: [pts("marginal_starter_gap", comp.marginal_starter_gap, "candidate level minus their marginal starter"), { key: "budget_remaining", value: comp.budget_remaining, unit: unitFor("waiver2.faab_dollars"), note: comp.budget_context }], origin: { source_class: "DERIVED_FROM_STATE", analysis_class: "DESCRIPTIVE" as const },
        limitations: [...c.limitations, "STRUCTURAL need only (roster, weakness, injury/bye, budget): a competitor's intended bid is never inferred", `weakness: ${comp.positional_weakness}`, ...comp.evidence], chart: [{ form: "bar", x: "subject.id", y: "value", domain: [0, 1] }] }, [a.id, "comp", comp.team_id]));
    }
  }
  return out;
}

export function waiver2ReplacementEvidence(ev: WaiverEvaluation, m: Waiver2Meta): EvidenceBlock[] {
  const g = gate(ev, m, "waiver2.replacement"); if (g) return g;
  const out: EvidenceBlock[] = [];
  for (const r of ev.replacement) {
    const c = common(ev, m, "waiver2.replacement"); const subject = mgr(m, `replacement:${r.position}`);
    for (const [k, v, why] of [["free_agent_replacement", r.free_agent_replacement, "nth-best available free agent's weekly projection (consumed replacement framework)"], ["starter_baseline", r.starter_baseline, "my lowest current optimal starter at the position"], ["rostered_replacement", r.rostered_replacement, "my best bench player at the position"]] as Array<[string, number | null, string]>)
      out.push(mk({ ...c, metric: k, subject, availability: v == null ? { state: "UNAVAILABLE", reason: `no ${k.replace(/_/g, " ")} for ${r.position}` } : { state: "AVAILABLE" }, ...(v == null ? {} : { value: v, unit: unitFor("waiver2.points_per_week") }), origin: { source_class: "DERIVED_FROM_PROJECTIONS", analysis_class: "PROJECTED" as const }, limitations: [...c.limitations, why, r.basis] }, [r.position, k]));
    out.push(mk({ ...c, metric: "scarcity", subject, availability: { state: "AVAILABLE" }, value: r.scarcity, unit: unitFor("waiver2.fraction"), components: [{ key: "free_agent_depth", value: r.free_agent_depth, unit: unitFor("waiver2.count") }], origin: { source_class: "DERIVED_FROM_STATE", analysis_class: "DESCRIPTIVE" as const }, limitations: [...c.limitations, r.basis] }, [r.position, "scarcity"]));
  }
  return out;
}
export type { WaiverAction };
