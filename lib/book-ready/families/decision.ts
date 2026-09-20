/**
 * Phase 3.5C — evidence for the decision / management surfaces (Start/Sit shadow, Matchup, roster health, schedule
 * planning, waiver/trade foundations). These are CONVERTERS over the existing responses: no new scoring logic, no
 * ranking of fantasy decisions, and the source objects are never mutated.
 */
import type { StartSitShadowComparison } from "@/lib/weekly/start-sit-fi/schema";
import { analysisClassFor, confidenceFor, predictiveClassFor } from "../vocabulary";
import { unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { AvailabilityState, Component, EvidenceBlock, TemporalIdentity } from "../schema";
import { PHASE7, mk, notAvailable } from "../common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;
const temporal = (season: number | null, week: number | null, asOf: string | null, kind: TemporalIdentity["point_kind"] = "CURRENT", snapshot: string | null = null): TemporalIdentity =>
  ({ season, week, through_week: null, as_of: asOf, generated_at: asOf, source_cutoff: null, point_kind: kind, as_of_kind: kind === "CURRENT" ? "CURRENT_SNAPSHOT" : "PUBLISHED_STATE", week_state: null, snapshot_id: snapshot, player_team_temporal_identity: PHASE7 });

export interface DecisionMeta { league_slug: string; manager_slug: string; season: number; week: number }
const mgr = (m: DecisionMeta) => ({ kind: "MANAGER_TEAM" as const, id: `${m.league_slug}/${m.manager_slug}`, league_slug: m.league_slug, manager_slug: m.manager_slug });

/* ------------------------------------------------------------------------------------------- Start/Sit shadow */
export function startSitShadowEvidence(cmp: StartSitShadowComparison, m: DecisionMeta, capture?: { capture_kind: string; capture_id: string }): EvidenceBlock[] {
  const lin = cmp.lineage; const at = lin.decision_generated_at;
  const lineage = { surface_version: lin.start_sit_model_version, canonical: { shadow: lin, football_intelligence: cmp.shadow_football_intelligence?.lineage ?? null, production_recommendation_lineage: cmp.production_recommendation_lineage }, depends_on: [{ surface: "football-intelligence", version: lin.football_intelligence_version }] };
  const validLive = capture?.capture_kind === "LIVE_CAPTURED";
  const tmp = temporal(m.season, m.week, at, capture ? (validLive ? "POINT_IN_TIME_STATE" : "CURRENT") : "CURRENT", capture?.capture_id ?? null);
  const common = { surface: "start-sit-fi", subject: mgr(m), deployment: { state: "SHADOW_ONLY" as const, may_influence_production: false }, freshness: { as_of: at, through_week: lin.football_intel_data_cutoff ? Math.max(...Object.values(lin.football_intel_data_cutoff)) : null, generated_at: at }, temporal: tmp, lineage, source: { artifact: "lib/weekly/data/start_sit_model.json", built_in: phaseRef("TEAM_MANAGEMENT_PHASE", "4") } };
  const lims = ["SHADOW_ONLY model ri-startsit-2026.1: never influences a production recommendation", "historical backtest: a net loser against a production-like baseline at every position (Phase 3.5A); it is not validated", ...(capture ? [`capture class ${capture.capture_kind}${validLive ? "" : " — NOT valid pre-kickoff evidence"}`] : [])];
  const out: EvidenceBlock[] = [];
  for (const a of cmp.adjustments) {
    const comps: Component[] = [
      { key: "baseline_projection", label: "production baseline projection", value: a.baseline_projection, unit: unitFor("startsit.points"), analysis_class: analysisClassFor("STARTSIT", "PRODUCTION_BASELINE_PROJECTION"), source_class: lin.baseline_projection_version },
      { key: "adjusted_projection", value: a.adjusted_projection, unit: unitFor("startsit.points"), analysis_class: "SHADOW" },
      ...a.contributions.map((c): Component => ({ key: `family:${c.family}`, label: c.family, value: c.points_contribution, unit: unitFor("startsit.contribution_points"), analysis_class: "SHADOW", source_class: c.routing, note: `routing=${c.routing} → ${predictiveClassFor(c.routing === "NOT_PREDICTIVE" ? "NOT_PREDICTIVE" : c.routing, "SHADOW_ONLY")}; fi_value=${c.fi_value}; fi_confidence=${c.fi_confidence}` })),
      { key: "raw_expected_adjustment", value: a.raw_expected_adjustment, unit: unitFor("startsit.contribution_points"), note: "before the 25% cap" },
    ];
    out.push(mk({ ...common, topic: "startsit.shadow_adjustment", metric: "expected_adjustment", subject: { kind: "PLAYER", id: a.canonical_player_id }, availability: { state: "AVAILABLE" }, value: a.expected_adjustment, unit: unitFor("startsit.contribution_points"),
      origin: { source_class: "SHADOW_ADJUSTMENT", analysis_class: "SHADOW" }, model_confidence: confidenceFor("FI", a.decision_confidence),
      predictive: { source_status: "SHADOW_ONLY_MODEL", class: "SHADOW_PREDICTIVE" }, components: comps,
      limitations: [...lims, ...(a.fi_prior_season_only ? ["FI signal is prior-season only for this week"] : []), ...(a.baseline_projection === null ? ["no baseline projection: adjustment is 0"] : [])],
      relationships: [{ type: "DEPENDS_ON", target: { surface: "football-intelligence", version: lin.football_intelligence_version } }, { type: "COMPARABLE_TO", target: { surface: "role-opportunity", topic: "role.player_profile", note: "usage families feed this model" } }],
      chart: [{ form: "bar", x: "components.label", y: "components.value" }] }, [a.canonical_player_id, m.week]));
  }
  for (const d of cmp.start_sit_deltas) {
    out.push(mk({ ...common, topic: "startsit.close_call", metric: "baseline_edge", subject: { kind: "MANAGER_TEAM", id: `${m.league_slug}/${m.manager_slug}|${d.slot ?? "slot"}|${d.baseline_start}` }, availability: d.baseline_edge === null ? { state: "UNAVAILABLE", reason: "no baseline edge" } : { state: "AVAILABLE" }, ...(d.baseline_edge === null ? {} : { value: d.baseline_edge, unit: unitFor("startsit.points") }),
      origin: { source_class: "PRODUCTION_BASELINE_PROJECTION", analysis_class: "PROJECTED" }, predictive: { source_status: "SHADOW_ONLY_MODEL", class: "SHADOW_PREDICTIVE" },
      components: [{ key: "fi_edge", value: d.fi_edge, unit: unitFor("startsit.points"), analysis_class: "SHADOW" }, { key: "inside_tie_break_gate", value: String(d.inside_tie_break_gate) }, { key: "reversal", value: String(d.changed) }, { key: "slot", value: d.slot }, ...d.reason_codes.map((rc): Component => ({ key: `reason:${rc}`, value: rc }))],
      change: d.changed ? [{ comparison_period: "BASELINE_PICK_TO_SHADOW_PICK", prior_value: d.baseline_start, current_value: d.fi_start, absolute_delta: null, relative_delta: null, transition: { from: d.baseline_start, to: d.fi_start }, significance: null }] : [],
      limitations: lims }, [d.slot, d.baseline_start, d.fi_start]));
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- Matchup */
export function matchupEvidence(x: J | null | undefined, m: DecisionMeta): EvidenceBlock[] {
  if (!x) return [notAvailable({ surface: "matchup-intelligence", topic: "matchup.shadow", metric: "*", subject: mgr(m), deployment: { state: "SHADOW_ONLY", may_influence_production: false }, freshness: { as_of: null, through_week: null, generated_at: null }, temporal: temporal(m.season, m.week, null), lineage: { surface_version: null }, source: { built_in: phaseRef("TEAM_MANAGEMENT_PHASE", "5") }, limitations: [] }, "UNAVAILABLE", "matchup intelligence not available for this request")];
  const lin = x.lineage ?? {}; const at = lin.generated_at ?? null;
  const common = { surface: "matchup-intelligence", topic: "matchup.shadow", subject: { ...mgr(m), id: `${m.league_slug}/${m.manager_slug}|${x.team_id}|${x.opponent_team_id ?? "bye"}` }, deployment: { state: "SHADOW_ONLY" as const, may_influence_production: false }, freshness: { as_of: at, through_week: null, generated_at: at }, temporal: temporal(m.season, m.week, at), lineage: { surface_version: lin.matchup_model_version ?? null, canonical: { matchup: lin, shadow_football_intelligence: x.shadow_football_intelligence ?? null }, depends_on: [{ surface: "football-intelligence", version: lin.football_intelligence_version ?? null }] }, source: { built_in: phaseRef("TEAM_MANAGEMENT_PHASE", "5") }, origin: { source_class: "SHADOW_DISTRIBUTION", analysis_class: "SHADOW" as const }, predictive: { source_status: "SHADOW_ONLY_MODEL", class: "SHADOW_PREDICTIVE" as const } };
  const conf = x.confidence?.overall as string | undefined; const lims = ["SHADOW_ONLY: never alters the production matchup or lineup", ...((x.confidence?.reasons as string[] | undefined) ?? []).map((r) => `degradation: ${r}`)];
  const model_confidence = conf ? confidenceFor("MATCHUP", conf) : undefined;
  if (!x.has_opponent) return [notAvailable({ ...common, metric: "*", limitations: lims }, "NOT_APPLICABLE", "no opponent this week (bye)", "UNAVAILABLE")];
  const out: EvidenceBlock[] = [];
  if (x.win_probability != null) out.push(mk({ ...common, metric: "win_probability", availability: { state: "AVAILABLE" }, value: x.win_probability, unit: unitFor("matchup.probability"), ...(model_confidence ? { model_confidence } : {}),
    uncertainty: x.win_probability_interval ? { kind: "MONTE_CARLO_STANDARD_ERROR_INTERVAL", range: [x.win_probability_interval.low, x.win_probability_interval.high], note: "± simulation standard error only — NOT a calibrated predictive interval" } : { kind: "NONE" },
    components: [{ key: "tie_probability", value: x.tie_probability, unit: unitFor("matchup.probability") }, { key: "upset_probability", value: x.upset_probability, unit: unitFor("matchup.probability"), note: "P(win | expected_margin < 0)" }, { key: "blowout_probability", value: x.blowout_probability, unit: unitFor("matchup.probability") }, { key: "win_probability_pct", value: x.win_probability_pct, unit: unitFor("matchup.percentage"), note: "whole-percent display of the same probability" }, { key: "sim_count", value: lin.sim_count ?? null }],
    limitations: lims, chart: [{ form: "uncertainty", y: "value", domain: [0, 1] }] }, ["wp"]));
  for (const k of ["team_score", "opponent_score", "margin"] as const) {
    const d = x[k]; if (!d) continue;
    out.push(mk({ ...common, metric: `${k}.expected`, availability: { state: "AVAILABLE" }, value: d.expected, unit: unitFor("matchup.points"), ...(model_confidence ? { model_confidence } : {}), uncertainty: { kind: "DISTRIBUTION_QUANTILES", range: [d.p10, d.p90], note: "p10-p90 of the simulated distribution" },
      components: [{ key: "sd", value: d.sd, unit: unitFor("matchup.points") }, { key: "p10", value: d.p10, unit: unitFor("matchup.points") }, { key: "p25", value: d.p25, unit: unitFor("matchup.points") }, { key: "median", value: d.median, unit: unitFor("matchup.points") }, { key: "p75", value: d.p75, unit: unitFor("matchup.points") }, { key: "p90", value: d.p90, unit: unitFor("matchup.points") }],
      limitations: lims, chart: [{ form: "uncertainty", y: "components.value", x: "components.key", unit: "points" }] }, [k]));
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- Roster health */
export function rosterHealthEvidence(x: J, m: DecisionMeta, opts: { populationN?: number } = {}): EvidenceBlock[] {
  const t = x?.team; const lin = x?.lineage ?? {};
  const common = { surface: "roster-health", topic: "roster_health.team", subject: mgr(m), deployment: { state: "SHARED_CONTEXT" as const, may_influence_production: false }, freshness: { as_of: lin.generated_at ?? null, through_week: null, generated_at: lin.generated_at ?? null }, temporal: temporal(m.season, m.week, lin.generated_at ?? null), lineage: { surface_version: x?.roster_health_version ?? null, canonical: lin, depends_on: [{ surface: "canonical-spine", version: lin.league_snapshot_id ?? null }] }, source: { built_in: phaseRef("TEAM_MANAGEMENT_PHASE", "6") } };
  if (!t) return [notAvailable({ ...common, metric: "*", limitations: [] }, "UNAVAILABLE", "no roster-health team payload")];
  const out: EvidenceBlock[] = [];
  for (const horizon of ["weekly", "rest_of_season"] as const) {
    const h = t[horizon]; if (!h) continue;
    const deg = h.degradation ?? {}; const lims = ["SHARED_CONTEXT conditions: informs, not a recommendation", ...((deg.reasons as string[] | undefined) ?? []).map((r) => `degradation: ${r}`)];
    const origin = { source_class: "DERIVED_FROM_PROJECTIONS", analysis_class: analysisClassFor("DERIVED", "DERIVED_FROM_PROJECTIONS") };
    const fr = h.fragility ?? {};
    const comps: Component[] = [
      { key: "baseline_lineup_value", value: h.baseline_lineup_value, unit: unitFor("health.vor_points") },
      { key: "worst_starter_dependency", value: fr.worst_starter_dependency, unit: unitFor("health.vor_points") }, { key: "expected_one_loss_damage", value: fr.expected_one_loss_damage, unit: unitFor("health.vor_points") },
      { key: "top3_weighted_dependency", value: fr.top3_weighted_dependency, unit: unitFor("health.vor_points") }, { key: "tail_dependency_p90", value: fr.tail_dependency_p90, unit: unitFor("health.vor_points") },
      { key: "min_slot_value_retained_after_any_one_loss", value: fr.min_slot_value_retained_after_any_one_loss, unit: unitFor("health.vor_points") },
      { key: "fragility_profile", value: fr.profile ?? null, note: "source-native label" }, { key: "single_points_of_failure_count", value: (fr.single_points_of_failure ?? []).length, unit: unitFor("health.count") },
      ...(h.depth_quality ?? []).map((d: J): Component => ({ key: `depth:${d.slot_key}`, value: d.starter_quality_vor, unit: unitFor("health.vor_points"), note: `grade=${d.depth_quality_grade}, usable_backups=${d.usable_backup_count}` })),
    ];
    const b = mk({ ...common, metric: `${horizon}.starter_quality_vor_total`, availability: { state: "AVAILABLE" }, value: h.starter_quality_vor_total, unit: unitFor("health.vor_points"), origin, predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" }, components: comps, limitations: lims, chart: [{ form: "bar", x: "components.key", y: "components.value" }] }, [horizon]);
    const lr = t.league_relative?.[horizon];
    if (lr && opts.populationN && opts.populationN > 0) b.comparison = Object.entries(lr as Record<string, number>).map(([k, v]) => ({ population: { id: `${m.league_slug}_TEAMS`, season: m.season, through_week: null, n: opts.populationN!, definition: `all teams in league ${m.league_slug}, ${k} (${horizon})` }, percentile: { value: v / 100, scale: "FRACTION_0_1" as const, source: "SOURCE_NATIVE" as const, orientation: "VALUE_ORIENTED" as const }, baseline: { kind: `SOURCE_WHOLE_PERCENT:${k}`, value: v } }));
    else if (lr) b.limitations.push("league-relative percentiles omitted: the league population size was not supplied, and a comparison without an explicit population is not allowed");
    out.push(b);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- Schedule planning */
export function schedulePlanningEvidence(x: J, m: DecisionMeta): EvidenceBlock[] {
  const t = x?.team; const lin = x?.lineage ?? {};
  const common = { surface: "schedule-planning", topic: "schedule_planning.week", subject: mgr(m), deployment: { state: "SHARED_CONTEXT" as const, may_influence_production: false }, freshness: { as_of: lin.generated_at ?? null, through_week: null, generated_at: lin.generated_at ?? null }, lineage: { surface_version: x?.planning_model_version ?? null, canonical: lin, depends_on: [{ surface: "roster-health", version: lin.roster_health_version ?? null }] }, source: { built_in: phaseRef("TEAM_MANAGEMENT_PHASE", "7") } };
  if (!t) return [notAvailable({ ...common, metric: "*", temporal: temporal(m.season, m.week, null), limitations: [] }, "UNAVAILABLE", "no schedule-planning team payload")];
  const deg = t.degradation ?? {}; const degLims = ((deg.reasons as string[] | undefined) ?? []).map((r) => `degradation: ${r}`);
  const out: EvidenceBlock[] = [];
  for (const w of t.week_timeline ?? []) {
    const conf = w.value_confidence as string | undefined;
    out.push(mk({ ...common, metric: "projected_lineup_value", temporal: temporal(m.season, w.week, lin.generated_at ?? null), availability: w.projected_lineup_value == null ? { state: "UNAVAILABLE", reason: "no projected lineup value for this week" } : { state: "AVAILABLE" }, ...(w.projected_lineup_value == null ? {} : { value: w.projected_lineup_value, unit: unitFor("schedule.points") }),
      origin: { source_class: "DERIVED_FROM_PROJECTIONS", analysis_class: "PROJECTED" }, ...(conf && conf !== "ROS_CONTEXT_ONLY" ? { model_confidence: confidenceFor("SCHEDULE", conf) } : {}), predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" },
      components: [{ key: "no_bye_lineup_value", value: w.no_bye_lineup_value, unit: unitFor("schedule.points") }, { key: "estimated_bye_loss", value: w.estimated_bye_loss, unit: unitFor("schedule.points") }, { key: "projection_basis", value: w.projection_basis }, { key: "nfl_schedule_state", value: w.nfl_schedule_state }, { key: "is_playoff_week", value: String(w.is_playoff_week) }, { key: "uncovered_slot_count", value: (w.uncovered_slot_labels ?? []).length, unit: unitFor("health.count") }, { key: "bye_player_count", value: w.bye_player_count, unit: unitFor("health.count") }, { key: "structure_confidence", value: w.structure_confidence }],
      limitations: ["SHARED_CONTEXT planning: roster assumed static across the horizon", ...degLims, ...(conf === "ROS_CONTEXT_ONLY" ? ["source value_confidence=ROS_CONTEXT_ONLY: rest-of-season context only; carries no confidence grade, so none is asserted"] : []), ...(w.projection_basis === "ROS_PROJECTION" ? ["value from a rest-of-season projection, not a weekly projection"] : [])], chart: [{ form: "line", x: "temporal.week", y: "value", unit: "points" }] }, [w.week]));
  }
  const s = t.summary ?? {};
  if (s.next_bye_week != null) out.push(mk({ ...common, metric: "next_bye_week", temporal: temporal(m.season, s.next_bye_week, lin.generated_at ?? null), availability: { state: "AVAILABLE" }, value: s.next_bye_week, unit: unitFor("schedule.week"), origin: { source_class: "DERIVED_FROM_STATE", analysis_class: "DESCRIPTIVE" }, predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" }, components: [{ key: "playoff_weeks", value: (s.playoff_weeks ?? []).join(",") }, { key: "weeks_with_uncovered_slots", value: (s.weeks_with_uncovered_slots ?? []).join(",") }], limitations: degLims }, ["next_bye"]));
  return out;
}

/* ------------------------------------------------------------------------------------------- Waiver / Trade foundations */
export function waiverEvidence(x: J, m: DecisionMeta): EvidenceBlock[] {
  const intel = x?.intelligence ?? {};
  const common = { surface: "waiver-foundations", topic: "waiver.status", metric: "availability", subject: mgr(m), deployment: { state: "PRODUCTION_ACTIVE" as const, may_influence_production: true }, freshness: { as_of: intel.generated_at ?? null, through_week: null, generated_at: intel.generated_at ?? null }, temporal: temporal(m.season, m.week, intel.generated_at ?? null), lineage: { surface_version: intel.engine_version ?? null, canonical: { lineage: intel.lineage ?? null, readiness: intel.readiness ?? null } }, source: { built_in: phaseRef("TEAM_MANAGEMENT_PHASE", "2") } };
  if (x?.availability_status && x.availability_status !== "AVAILABLE") {
    return [notAvailable({ ...common, limitations: [`football_intelligence_used_for_numeric_ranking=${String(intel.football_intelligence_used_for_numeric_ranking)}`] }, "UNAVAILABLE", `${x.unavailable_reason_code ?? x.availability_status}: ${(x.unavailable_detail?.reasons ?? []).join("; ")}`)];
  }
  return [mk({ ...common, availability: { state: "AVAILABLE" }, value: "AVAILABLE", unit: unitFor("category"), category: { raw: "AVAILABLE", normalized: null, mapping_status: "NO_VERIFIED_MAPPING" }, origin: { source_class: "PRODUCTION_BASELINE_PROJECTION", analysis_class: "PROJECTED" }, components: [{ key: "recommendation_count", value: (x.recommendations ?? []).length, unit: unitFor("health.count") }, { key: "considered", value: x.considered ?? null, unit: unitFor("health.count") }, { key: "football_intelligence_used_for_numeric_ranking", value: String(intel.football_intelligence_used_for_numeric_ranking) }], limitations: ["component scores of individual recommendations are exposed by the waiver route itself; this layer does not re-rank"] })];
}

/** Trade foundations: evaluation needs a POST request body, so nothing is served through the GET query layer. */
export function tradeCapabilityEvidence(m: DecisionMeta): EvidenceBlock[] {
  return [notAvailable({ surface: "trade-foundations", topic: "trade.evaluation", metric: "*", subject: mgr(m), deployment: { state: "ADVISORY_ONLY", may_influence_production: false }, freshness: { as_of: null, through_week: null, generated_at: null }, temporal: temporal(m.season, m.week, null), lineage: { surface_version: null }, source: { built_in: phaseRef("TRADE_ENGINE_PHASE", "6") }, limitations: ["trade evaluation requires a proposal (POST body); its components are exposed inside the existing /api/trades/* responses"] }, "UNAVAILABLE", "trade evidence is request-body driven and is not retrievable through the GET query layer", "UNSUPPORTED")];
}
export const __availabilityStates: AvailabilityState[] = [];
