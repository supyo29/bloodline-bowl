/**
 * Phase 5 Checkpoint E — the PLAYER-SPECIFIC INTERACTION ENGINE. Combines position-appropriate families into structured evidence:
 * advantages / disadvantages / neutral factors / undetermined, scenario sensitivity, uncertainty, and a DESCRIPTIVE structural verdict.
 * It produces no score and no numeric fantasy adjustment. Deterministic: same context + same player evidence ⇒ same content identity.
 */
import { hashOf } from "./hash";
import { MATCHUP2_CONTRACT, MATCHUP2_LIFECYCLE, MATCHUP2_VERSION, NUMERIC_ADJUSTMENT_REASON, type EvidenceTier, type InteractionComponent, type MatchupEvaluation, type Position, type StructuralVerdict, type UncertaintySource } from "./contract";
import { buildMatchupContext, type MatchupContext } from "./context";
import { areaEpa, coverageExpectation, coverageInteraction, explosiveEnvironment, pressureLine, pressureQbResponse, routeFamilyProfile, runBox, runDirection, runGap, rusherCountResponse, scoringOpportunity, unitCoverage } from "./families";
import type { MatchupSource, PlayerEvidence } from "./source";
import { minTier, round } from "./stats";
import { unsupportedFor } from "./unsupported";
import { buildDefenseProfile, type DefenseProfile } from "./defense";

const POS = new Set(["QB", "RB", "WR", "TE"]);
export function componentsFor(ctx: MatchupContext, p: PlayerEvidence, pos: Position): InteractionComponent[] {
  const out: Array<InteractionComponent | null> = [];
  if (pos === "QB") out.push(coverageInteraction(ctx, p, pos), coverageExpectation(ctx, p), areaEpa(ctx, p, pos), explosiveEnvironment(ctx, p, pos), pressureQbResponse(ctx, p), rusherCountResponse(ctx, p), pressureLine(ctx), scoringOpportunity(ctx, p, pos));
  else if (pos === "RB") { out.push(runDirection(ctx, p), runGap(ctx, p), runBox(ctx, p)); if (p.receiver_cells.length) out.push(areaEpa(ctx, p, pos)); if (p.receiver_coverage.length) out.push(coverageInteraction(ctx, p, pos)); out.push(unitCoverage(ctx, p, pos), scoringOpportunity(ctx, p, pos)); }
  else out.push(coverageInteraction(ctx, p, pos), coverageExpectation(ctx, p), areaEpa(ctx, p, pos), explosiveEnvironment(ctx, p, pos), routeFamilyProfile(ctx, p), unitCoverage(ctx, p, pos), scoringOpportunity(ctx, p, pos));
  return out.filter((c): c is InteractionComponent => c != null);
}
export function mergeUncertainty(cs: InteractionComponent[]): UncertaintySource[] {
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const; const m = new Map<string, UncertaintySource>();
  for (const c of cs) for (const u of c.uncertainty) { const cur = m.get(u.kind); if (!cur || rank[u.level] > rank[cur.level]) m.set(u.kind, u); }
  return [...m.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1));
}
const label = (c: InteractionComponent): string => `${c.title}${c.z != null ? ` (z ${c.z >= 0 ? "+" : ""}${c.z}, rank ${c.rank_among_defenses}/32 most favourable)` : ""}`;
export function verdictOf(cs: InteractionComponent[]): { verdict: StructuralVerdict; evidence: EvidenceTier } {
  const decided = cs.filter((c) => c.origin !== "MODELED_GAME_EXPECTATION" && c.predictive_class !== "UNSUPPORTED" && (c.direction === "ADVANTAGE" || c.direction === "DISADVANTAGE" || c.direction === "NEUTRAL"));
  if (!decided.length) return { verdict: "INSUFFICIENT_EVIDENCE", evidence: "INSUFFICIENT" };
  const adv = decided.filter((c) => c.direction === "ADVANTAGE").length; const dis = decided.filter((c) => c.direction === "DISADVANTAGE").length;
  return { verdict: adv && dis ? "MIXED" : adv ? "FAVORABLE" : dis ? "UNFAVORABLE" : "NEUTRAL", evidence: minTier(...decided.map((c) => c.evidence)) };
}
function genericContext(ctx: MatchupContext) {
  const d = ctx.defense?.fi_defense ?? {}; const pass = d.def_pass_epa_allowed; const rush = d.def_rush_epa_allowed; const all = d.def_epa_play_allowed;
  return { pass_percentile: round(pass?.league_percentile ?? null), rush_percentile: round(rush?.league_percentile ?? null), overall_percentile: round(all?.league_percentile ?? null), predictive_status: all?.predictive_status ?? pass?.predictive_status ?? null, note: "Football Intelligence opponent-adjusted defensive quality; percentile 1 = best defense. Reported ONLY to be compared with the player-specific structural reading, never combined with it." };
}
function comparison(verdict: StructuralVerdict, overall: number | null): MatchupEvaluation["player_specific_vs_generic"] {
  if (overall == null || (verdict !== "FAVORABLE" && verdict !== "UNFAVORABLE")) return "NOT_COMPARABLE";
  const generic = overall >= 0.67 ? "UNFAVORABLE" : overall <= 0.33 ? "FAVORABLE" : null; if (!generic) return "NOT_COMPARABLE";
  return generic === verdict ? "AGREE" : "DISAGREE";
}
export function evaluatePlayer(src: MatchupSource, ctx: MatchupContext, playerId: string): MatchupEvaluation | { error: "PLAYER_UNRESOLVED" | "POSITION_UNSUPPORTED" | "DEFENSE_UNAVAILABLE"; detail: string } {
  const p = src.resolvePlayer(playerId); if (!p) return { error: "PLAYER_UNRESOLVED", detail: `no player evidence for '${playerId}'` };
  const pos = (p.position ?? "").toUpperCase(); if (!POS.has(pos)) return { error: "POSITION_UNSUPPORTED", detail: `position '${p.position}' has no Matchup 2.0 family (QB/RB/WR/TE only; K and DEF are not modeled)` };
  if (!ctx.defense) return { error: "DEFENSE_UNAVAILABLE", detail: `no defensive evidence for ${ctx.game.defense_team}` };
  const cs = componentsFor(ctx, p, pos as Position); const v = verdictOf(cs); const g = genericContext(ctx);
  const body = { advantages: cs.filter((c) => c.direction === "ADVANTAGE").map(label), disadvantages: cs.filter((c) => c.direction === "DISADVANTAGE").map(label), neutral_factors: cs.filter((c) => c.direction === "NEUTRAL").map((c) => c.title), undetermined: cs.filter((c) => c.direction === "UNDETERMINED").map((c) => c.title) };
  const ident = { fp: ctx.scoring_fingerprint, ps: ctx.identities.player_scheme, fi: ctx.identities.fi, role: ctx.identities.role, opp: ctx.identities.opp };
  const evalObj: Omit<MatchupEvaluation, "content_identity"> = { contract: MATCHUP2_CONTRACT, model_version: MATCHUP2_VERSION, lifecycle_state: MATCHUP2_LIFECYCLE, may_influence_production: false,
    offense_subject: { kind: "PLAYER", id: p.gsis_id, name: p.name, team: ctx.game.offense_team, position: pos as Position }, defense_subject: { team: ctx.game.defense_team }, game: ctx.game, components: cs, ...body,
    structural_verdict: v.verdict, generic_defense_context: g, player_specific_vs_generic: comparison(v.verdict, g.overall_percentile), numeric_adjustment: null, numeric_adjustment_reason: NUMERIC_ADJUSTMENT_REASON, unsupported: unsupportedFor(pos as Position), uncertainty: mergeUncertainty(cs), overall_evidence: v.evidence, vintage: ctx.vintage,
    lineage: { context_identity: ctx.context_identity, player_scheme_identity: ident.ps, fi_version: ident.fi, role_version: ident.role, opp_version: ident.opp, scoring_fingerprint: ctx.scoring_fingerprint } };
  return { ...evalObj, content_identity: `m2:${hashOf({ ctx: ctx.context_identity, player: p.gsis_id, comps: cs.map((c) => [c.id, c.direction, c.value, c.z, c.evidence, c.window]) }, 16)}` };
}
/** Team-level structural evidence + the canonical defensive profile. Team and player evidence are never collapsed into one score. */
export function evaluateTeam(src: MatchupSource, ctx: MatchupContext): { evaluation: MatchupEvaluation; defense_profile: DefenseProfile | null } | { error: "DEFENSE_UNAVAILABLE"; detail: string } {
  if (!ctx.defense) return { error: "DEFENSE_UNAVAILABLE", detail: `no defensive evidence for ${ctx.game.defense_team}` };
  const line = pressureLine(ctx); const pairs = ["pass_epa_vs_pass_defense", "rush_epa_vs_rush_defense", "pressure_allowed_vs_pressure_generated", "explosive_pass_vs_explosive_prevention", "proe_pace_vs_pass_funnel", "rz_offense_vs_rz_defense"];
  const fiComps: InteractionComponent[] = pairs.flatMap((f) => { const r = src.contextual(f, ctx.game.offense_team, ctx.game.defense_team); if (!r) return []; return [{ id: `team.fi.${f}`, family: "team.pass_vs_pass_defense", position: "TEAM" as const, title: `Football Intelligence pair: ${f}`, origin: "DESCRIPTIVE_CONTEXT" as const, history_class: "RECONSTRUCTABLE_AS_OF" as const, predictive_class: "DESCRIPTIVE_CONTEXT" as const, direction: "UNDETERMINED" as const, value: round(r.interaction_signal), unit: "FI interaction signal (semantics owned by Football Intelligence)", z: null, rank_among_defenses: null, evidence: (r.confidence === "HIGH" ? "STRONG" : r.confidence === "MEDIUM" ? "MODERATE" : r.confidence === "LOW" ? "WEAK" : "INSUFFICIENT") as EvidenceTier, window: null, inputs: { offense_rating: round(r.offense_rating), defense_rating: round(r.defense_rating), fi_predictive_status: r.predictive_status, fi_confidence: r.confidence }, sensitivity: [], uncertainty: [], limitations: ["consumed unmodified from Football Intelligence; its routed predictive status governs any use"] }]; });
  const cs = [line, ...fiComps]; const v = verdictOf(cs); const g = genericContext(ctx);
  const body = { advantages: cs.filter((c) => c.direction === "ADVANTAGE").map(label), disadvantages: cs.filter((c) => c.direction === "DISADVANTAGE").map(label), neutral_factors: cs.filter((c) => c.direction === "NEUTRAL").map((c) => c.title), undetermined: cs.filter((c) => c.direction === "UNDETERMINED").map((c) => c.title) };
  const e: Omit<MatchupEvaluation, "content_identity"> = { contract: MATCHUP2_CONTRACT, model_version: MATCHUP2_VERSION, lifecycle_state: MATCHUP2_LIFECYCLE, may_influence_production: false, offense_subject: { kind: "TEAM", id: ctx.game.offense_team, name: null, team: ctx.game.offense_team, position: null }, defense_subject: { team: ctx.game.defense_team }, game: ctx.game, components: cs, ...body, structural_verdict: v.verdict, generic_defense_context: g, player_specific_vs_generic: "NOT_COMPARABLE", numeric_adjustment: null, numeric_adjustment_reason: NUMERIC_ADJUSTMENT_REASON, unsupported: unsupportedFor("TEAM"), uncertainty: mergeUncertainty(cs), overall_evidence: v.evidence, vintage: ctx.vintage, lineage: { context_identity: ctx.context_identity, player_scheme_identity: ctx.identities.player_scheme, fi_version: ctx.identities.fi, role_version: ctx.identities.role, opp_version: ctx.identities.opp, scoring_fingerprint: ctx.scoring_fingerprint } };
  return { evaluation: { ...e, content_identity: `m2:${hashOf({ ctx: ctx.context_identity, team: ctx.game.offense_team, comps: cs.map((c) => [c.id, c.direction, c.value]) }, 16)}` }, defense_profile: buildDefenseProfile(ctx) };
}
/** Multi-player: the defense context is built ONCE and reused (no per-player rebuild). */
export function evaluatePlayers(src: MatchupSource, g: Parameters<typeof buildMatchupContext>[1], playerIds: string[]) { const ctx = buildMatchupContext(src, g); return { context_identity: ctx.context_identity, results: playerIds.map((id) => ({ id, result: evaluatePlayer(src, ctx, id) })) }; }
