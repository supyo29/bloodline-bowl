/**
 * Phase 5 — Matchup Intelligence 2.0 evidence, Book-Ready BY CONSTRUCTION. Every interaction component and defensive-profile fact is a shared
 * EvidenceBlock: origin, evidence class (DESCRIPTIVE / MODELED / UNAVAILABLE), predictive status (never above UNVALIDATED), sample support,
 * uncertainty, lineage (context identity, source vintages), freshness, limitations. Unsupported items are explicit UNAVAILABLE blocks. The
 * composite adjustment is an explicit UNAVAILABLE block: it does not exist, and the reason is stated.
 */
import type { InteractionComponent, MatchupEvaluation } from "@/lib/matchup2/contract";
import { MATCHUP2_VERSION } from "@/lib/matchup2/contract";
import type { DefenseProfile, ProfileValue } from "@/lib/matchup2/defense";
import type { MatchupContext } from "@/lib/matchup2/context";
import { sampleSupportFor } from "../vocabulary";
import { unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { Component, EvidenceBlock, TemporalIdentity } from "../schema";
import { PHASE7, mk as mkRaw, notAvailable } from "../common";

export const MATCHUP2_SURFACE = "matchup-intelligence-2";
const BUILT_IN = phaseRef("INTELLIGENCE_MODERNIZATION_PHASE", "5");
const mk = (b: Omit<EvidenceBlock, "evidence_id" | "contract_version">, key: unknown[] = []): EvidenceBlock => {
  let x = b;
  if (x.availability.state !== "AVAILABLE") { const { predictive: _p, ...rest } = x; void _p; x = { ...rest, origin: { source_class: x.availability.state, analysis_class: x.origin.analysis_class === "UNSUPPORTED" ? "UNSUPPORTED" : "UNAVAILABLE" } }; }
  else if (x.origin.analysis_class === "DESCRIPTIVE") x = { ...x, predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" } };
  return mkRaw(x, key);
};
export type PlayerTopic = "coverage" | "pass_area" | "pressure" | "run" | "scoring" | "summary"; export type DefenseTopic = "coverage" | "front" | "pressure" | "explosive";
const vint = (ctx: { vintage: MatchupContext["vintage"] }, s: string) => ctx.vintage.find((v) => v.source === s);
function temporal(ctx: { vintage: MatchupContext["vintage"]; game: MatchupContext["game"] }): TemporalIdentity {
  const fi = vint(ctx, "football-intelligence"); const ps = vint(ctx, "player-scheme");
  return { season: ctx.game.season, week: ctx.game.week, through_week: fi?.through_week ?? null, as_of: null, generated_at: null, source_cutoff: { football_intelligence: fi?.through_week ?? -1, player_scheme: ps?.through_week ?? -1 } as never, point_kind: "CURRENT", as_of_kind: "CURRENT_SNAPSHOT", week_state: null, snapshot_id: null, player_team_temporal_identity: PHASE7 };
}
const lim = (ctx: { vintage: MatchupContext["vintage"] }): string[] => ["SHADOW_ONLY Matchup Intelligence 2.0: structured interaction evidence with NO numeric fantasy adjustment; never alters the production matchup, lineup or Start/Sit", ...ctx.vintage.filter((v) => v.availability === "PRIOR_ONLY").map((v) => `${v.source} is PRIOR_ONLY: data through ${v.season} w${v.through_week}, no ${ctx.vintage.find((x) => x.source === "football-intelligence")?.season ?? "current"} observation`), "mixed source vintages are shown, never blended"];
function base(ctx: MatchupContext | (Pick<MatchupContext, "vintage" | "game" | "identities"> & { context_identity: string }), topic: string, metric: string, subject: EvidenceBlock["subject"], extra: string[] = []) {
  return { surface: MATCHUP2_SURFACE, topic, metric, subject, deployment: { state: "SHADOW_ONLY" as const, may_influence_production: false as const }, temporal: temporal(ctx), freshness: { as_of: null, through_week: vint(ctx, "football-intelligence")?.through_week ?? null, generated_at: null },
    lineage: { surface_version: MATCHUP2_VERSION, content_identity: ctx.context_identity, canonical: { context_identity: ctx.context_identity, vintage: ctx.vintage, source_identities: ctx.identities }, depends_on: ctx.vintage.filter((v) => v.version).map((v) => ({ surface: v.source, version: v.version })) },
    source: { built_in: BUILT_IN, source_data: "Football Intelligence + Player-Scheme + Role & Opportunity (consumed, never recomputed)" }, limitations: [...lim(ctx), ...extra] };
}
const unitKey = (c: InteractionComponent): string => c.id.endsWith("coverage.man_zone") ? (c.id.startsWith("qb.") ? "matchup2.epa_play" : "matchup2.epa_target") : c.id === "coverage.game_expectation" ? "matchup2.rate" : c.id.includes(".area.pass") ? "matchup2.epa_target" : c.id.includes("explosive") ? "matchup2.rate_delta" : c.id.startsWith("qb.pressure") ? "matchup2.epa_play" : c.id === "team.pressure.line" ? "matchup2.rate_delta" : c.id.startsWith("rb.run") ? "matchup2.epa_rush" : c.id.includes("unit_coverage") ? "matchup2.epa_target" : c.id.includes("scoring") ? "matchup2.rate_delta" : "matchup2.index";
const analysisFor = (c: InteractionComponent) => (c.origin === "MODELED_GAME_EXPECTATION" ? "MODELED" as const : c.origin === "UNSUPPORTED" ? "UNSUPPORTED" as const : "DESCRIPTIVE" as const);
const pick = (id: string, topic: PlayerTopic): boolean => topic === "coverage" ? /coverage\.man_zone$|coverage\.game_expectation$|unit_coverage$/.test(id) : topic === "pass_area" ? /\.area\.pass$|explosive\.area$|route\.family$/.test(id) : topic === "pressure" ? /^qb\.pressure|^team\.pressure/.test(id) : topic === "run" ? /^rb\.run\./.test(id) : topic === "scoring" ? /scoring\.red_zone$/.test(id) : true;

function componentBlocks(e: MatchupEvaluation, c: InteractionComponent, topic: string): EvidenceBlock[] {
  const subject = e.offense_subject.kind === "PLAYER" ? { kind: "PLAYER" as const, id: e.offense_subject.id, team: e.offense_subject.team ?? undefined } : { kind: "TEAM" as const, id: e.game.offense_team, team: e.game.offense_team };
  const ctx = { vintage: e.vintage, game: e.game, identities: { player_scheme: e.lineage.player_scheme_identity, fi: e.lineage.fi_version, role: e.lineage.role_version, opp: e.lineage.opp_version }, context_identity: e.lineage.context_identity };
  const b = base(ctx, topic, c.id, { ...subject }, [...c.limitations, `opponent: ${e.game.defense_team}`]);
  const comps: Component[] = [{ key: "direction", label: "structural direction", value: c.direction, analysis_class: "DESCRIPTIVE" }, { key: "z_among_defenses", value: c.z, unit: unitFor("matchup2.z"), note: "this defense standardized against the other 31 for THIS player" }, { key: "rank_among_defenses", value: c.rank_among_defenses, unit: unitFor("matchup2.rank"), note: "1 = most favourable to the offense" }, ...Object.entries(c.inputs).map(([k, v]) => ({ key: `input.${k}`, value: v, ...(typeof v === "number" ? { unit: unitFor(/n_|count/.test(k) ? "matchup2.count" : /share|rate/.test(k) ? "matchup2.share" : "matchup2.epa") } : {}) })) as Component[],
    ...c.sensitivity.map((s) => ({ key: `scenario.${s.scenario}`, value: s.value, note: s.note })) as Component[], ...c.uncertainty.map((u) => ({ key: `uncertainty.${u.kind}`, value: u.level, note: u.note })) as Component[]];
  const ss = sampleSupportFor("matchup2.evidence_tier", c.evidence);
  if (c.value == null) {
    const state = c.evidence === "INSUFFICIENT" ? "INSUFFICIENT_SAMPLE" as const : "UNAVAILABLE" as const;
    if (c.id === "receiver.route.family" && Object.keys(c.inputs).length) return [mk({ ...b, availability: { state: "AVAILABLE" }, origin: { source_class: c.origin, analysis_class: "DESCRIPTIVE" }, sample_support: ss, components: comps, predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" }, history: { class: "CURRENT_ONLY", points: [], note: "prior-season aggregate" } }, [c.id, e.game.defense_team])];
    return [notAvailable({ ...b, sample_support: ss }, state, `${c.id}: ${c.limitations[0] ?? "evidence unavailable"}`)];
  }
  return [mk({ ...b, availability: { state: "AVAILABLE" }, value: c.value, unit: unitFor(unitKey(c)), origin: { source_class: c.origin, analysis_class: analysisFor(c) }, sample_support: ss, predictive: c.origin === "MODELED_GAME_EXPECTATION" ? { source_status: "BASELINE_ONLY", class: "UNVALIDATED" } : { source_status: c.predictive_class, class: "DESCRIPTIVE_ONLY" },
    uncertainty: { kind: "STRUCTURED_SOURCES", note: c.uncertainty.map((u) => `${u.kind}:${u.level}`).join(", ") }, components: comps, history: { class: "CURRENT_ONLY", points: [], note: `window ${c.window ?? "n/a"}; history class ${c.history_class}` },
    relationships: [{ type: "DERIVED_FROM", target: { surface: "player-scheme", note: "player profile × defense tendency" } }] }, [c.id, e.game.defense_team, c.direction])];
}
export function matchup2PlayerEvidence(topic: PlayerTopic, e: MatchupEvaluation): EvidenceBlock[] {
  const out: EvidenceBlock[] = (topic === "summary" ? [] : e.components.filter((c) => pick(c.id, topic))).flatMap((c) => componentBlocks(e, c, `matchup2.player.${topic}`));
  if (topic !== "summary") return out;
  const ctx = { vintage: e.vintage, game: e.game, identities: { player_scheme: e.lineage.player_scheme_identity, fi: e.lineage.fi_version, role: e.lineage.role_version, opp: e.lineage.opp_version }, context_identity: e.lineage.context_identity };
  const subject = { kind: "PLAYER" as const, id: e.offense_subject.id, team: e.offense_subject.team ?? undefined }; const t = "matchup2.player.summary"; const cat = (metric: string, v: string, extra: string[] = []) => mk({ ...base(ctx, t, metric, subject, extra), availability: { state: "AVAILABLE" }, value: v, unit: unitFor("category"), category: { raw: v, normalized: null, mapping_status: "VERIFIED" }, origin: { source_class: "DERIVED_FROM_COMPONENTS", analysis_class: "DESCRIPTIVE" }, sample_support: sampleSupportFor("matchup2.evidence_tier", e.overall_evidence), components: [{ key: "advantages", value: e.advantages.join(" ; ") || null }, { key: "disadvantages", value: e.disadvantages.join(" ; ") || null }, { key: "neutral", value: e.neutral_factors.join(" ; ") || null }, { key: "undetermined", value: e.undetermined.join(" ; ") || null }], history: { class: "CURRENT_ONLY", points: [], note: "current evaluation" } }, [metric, e.game.defense_team]);
  const blocks = [cat("structural_verdict", e.structural_verdict, ["a DESCRIPTIVE summary of component directions — not a score and not a prediction"]), cat("player_specific_vs_generic", e.player_specific_vs_generic, [`generic defense percentile (1 = best) ${e.generic_defense_context.overall_percentile}: ${e.generic_defense_context.note}`])];
  for (const u of e.uncertainty) blocks.push(cat(`uncertainty.${u.kind}`, u.level, [u.note]));
  for (const u of e.unsupported) blocks.push(mk({ ...base(ctx, t, `unsupported.${u.id}`, subject, [u.reason, `would need: ${u.would_need}`, ...(u.chapter_ids.length ? [`Analysis Book chapters that remain UNSUPPORTED: ${u.chapter_ids.join(", ")}`] : [])]), availability: { state: "UNAVAILABLE", reason: `${u.asked} — ${u.reason}` }, origin: { source_class: "UNSUPPORTED", analysis_class: "UNSUPPORTED" } }, [u.id]));
  blocks.push(mk({ ...base(ctx, t, "composite_adjustment", subject, [e.numeric_adjustment_reason]), availability: { state: "UNAVAILABLE", reason: "no validated numeric matchup adjustment exists (SHADOW_ONLY; " + e.numeric_adjustment_reason + ")" }, origin: { source_class: "NOT_VALIDATED", analysis_class: "UNAVAILABLE" } }, ["composite"]));
  return blocks;
}
const pvBlock = (ctx: MatchupContext, topic: string, team: string, group: string, v: ProfileValue, unit: string, note?: string[]): EvidenceBlock => {
  const subject = { kind: "TEAM" as const, id: team, team }; const b = base(ctx, topic, `${group}.${v.key}`, subject, note ?? []);
  if (v.value == null) return notAvailable({ ...b, sample_support: sampleSupportFor("matchup2.evidence_tier", v.evidence) }, "INSUFFICIENT_SAMPLE", `${group}.${v.key}: no value for ${team}`);
  return mk({ ...b, availability: { state: "AVAILABLE" }, value: v.value, unit: unitFor(unit), origin: { source_class: "OBSERVED_DEFENSIVE_TENDENCY", analysis_class: "DESCRIPTIVE" }, sample_support: sampleSupportFor("matchup2.evidence_tier", v.evidence, v.n), components: [{ key: "league_mean", value: v.league_mean, unit: unitFor(unit) }],
    comparison: v.rank_high_to_low != null ? [{ population: { id: "NFL_DEFENSES", season: ctx.game.season, through_week: vint(ctx, "player-scheme")?.through_week ?? null, n: v.of, definition: "all 32 NFL defenses" }, rank: { position: v.rank_high_to_low, of: v.of, order: "VALUE_DESCENDING" } }] : undefined, history: { class: "CURRENT_ONLY", points: [], note: "prior-season aggregate (PRIOR_ONLY)" } }, [group, v.key]);
};
export function matchup2DefenseEvidence(topic: DefenseTopic, ctx: MatchupContext, p: DefenseProfile | null): EvidenceBlock[] {
  const team = ctx.game.defense_team; const t = `matchup2.defense.${topic}`; const subject = { kind: "TEAM" as const, id: team, team };
  if (!p) return [notAvailable(base(ctx, t, "*", subject), "UNAVAILABLE", `no defensive evidence for ${team}`)];
  const out: EvidenceBlock[] = [];
  if (topic === "coverage") { for (const v of p.coverage.man_zone) out.push(pvBlock(ctx, t, team, "man_zone", v, "matchup2.rate", ["observed historical tendency; NOT this week's expected coverage (that is a separate MODELED, baseline-only component)"])); for (const v of p.coverage.shells_source_native) out.push(pvBlock(ctx, t, team, "shell_source_native", v, "matchup2.rate", ["source-native coverage bucket preserved; no cross-source blending"])); }
  if (topic === "front") { for (const v of p.box) out.push(pvBlock(ctx, t, team, "box", v, v.key === "mean_box_deployed" ? "matchup2.epa" : "matchup2.rate", ["box count is the only front evidence; front ALIGNMENT is unsupported"])); for (const r of p.run.direction) out.push(mk({ ...base(ctx, t, `run_direction.${r.field_third}`, subject, ["LEFT/MIDDLE/RIGHT from run_location — NOT inside/outside"]), availability: r.epa_per_rush == null ? { state: "INSUFFICIENT_SAMPLE", reason: "no evidence" } : { state: "AVAILABLE" }, ...(r.epa_per_rush == null ? {} : { value: r.epa_per_rush, unit: unitFor("matchup2.epa") }), origin: { source_class: "OBSERVED_DEFENSIVE_TENDENCY", analysis_class: "DESCRIPTIVE" }, sample_support: sampleSupportFor("matchup2.evidence_tier", r.evidence), components: [{ key: "vs_league_average_defense", value: r.vs_league, unit: unitFor("matchup2.epa_rush") }, { key: "stuff_rate", value: r.stuff_rate, unit: unitFor("matchup2.rate") }] }, ["dir", r.field_third]));
    for (const r of p.run.gap) out.push(mk({ ...base(ctx, t, `run_gap.${r.run_gap}`, subject, ["source gap labels are END/TACKLE/GUARD only; no zone/gap/power/counter scheme label"]), availability: r.epa_per_rush == null ? { state: "INSUFFICIENT_SAMPLE", reason: "no evidence" } : { state: "AVAILABLE" }, ...(r.epa_per_rush == null ? {} : { value: r.epa_per_rush, unit: unitFor("matchup2.epa") }), origin: { source_class: "OBSERVED_DEFENSIVE_TENDENCY", analysis_class: "DESCRIPTIVE" }, sample_support: sampleSupportFor("matchup2.evidence_tier", r.evidence), components: [{ key: "vs_league_average_defense", value: r.vs_league, unit: unitFor("matchup2.epa_rush") }] }, ["gap", r.run_gap]));
    out.push(mk({ ...base(ctx, t, "front_alignment", subject, ["4-3/3-4/odd/even fronts are not published by any source"]), availability: { state: "UNAVAILABLE", reason: "defensive front alignment is unsupported" }, origin: { source_class: "UNSUPPORTED", analysis_class: "UNSUPPORTED" } }, ["front_alignment"])); }
  if (topic === "pressure") for (const v of p.pressure) out.push(pvBlock(ctx, t, team, "pressure", v, "matchup2.rate", ["pressure rate reflects opposing QB behaviour as well as defensive quality; blitz proxy = 5+ rushers"]));
  if (topic === "explosive") { for (const v of p.explosive) out.push(pvBlock(ctx, t, team, "explosive_allowed", v, "matchup2.rate", ["explosive = pass gain >= 16 / rush >= 12 yards"])); for (const r of p.pass_concession_by_depth) out.push(mk({ ...base(ctx, t, `pass_concession.${r.depth_bin}`, subject, ["target-area concession by depth; target location, not alignment"]), availability: r.epa_per_target == null ? { state: "INSUFFICIENT_SAMPLE", reason: "no evidence" } : { state: "AVAILABLE" }, ...(r.epa_per_target == null ? {} : { value: r.epa_per_target, unit: unitFor("matchup2.epa") }), origin: { source_class: "OBSERVED_DEFENSIVE_TENDENCY", analysis_class: "DESCRIPTIVE" }, sample_support: sampleSupportFor("matchup2.evidence_tier", r.evidence), components: [{ key: "vs_league_average_defense", value: r.epa_vs_league, unit: unitFor("matchup2.epa_target") }, { key: "target_share", value: r.target_share, unit: unitFor("matchup2.share") }, { key: "explosive_rate", value: r.explosive_rate, unit: unitFor("matchup2.rate") }] }, ["depth", r.depth_bin])); }
  return out;
}
