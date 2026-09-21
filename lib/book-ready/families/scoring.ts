/**
 * Phase 6 — league SCORING CONTRACT evidence, Book-Ready BY CONSTRUCTION. For one league's actual scoring map it states, per active rule, what the league
 * pays for, and — the point of Phase 6 — whether that rule truly reaches valuation: weekly projection / season projection / completed games / waiver
 * role pricing, plus the final support class and an exact-vs-approximate flag. A rule that is PROVIDER_LIMITED, DECISION_LAYER_MISSING or UNSUPPORTED is
 * NEVER presented as modeled: the class and the limitation are on the block itself. Descriptive only; nothing here influences a decision.
 */
import { leagueScoringContract, type RuleSupport } from "@/lib/scoring/support-contract";
import { unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { Component, EvidenceBlock, TemporalIdentity } from "../schema";
import { PHASE7, mk as mkRaw } from "../common";
import materiality from "@/lib/scoring/data/kdst-fallback-materiality.json";

type Mat = { league_slug: string; season: number; week: number; DEF: { n: number; mean_abs_error: number; rank_correlation: number; materiality: string }; K: { n: number; mean_abs_error: number; rank_correlation: number; materiality: string } };
const matFor = (fp: string): string => { const m = (materiality.by_fingerprint as Record<string, Mat>)[fp]; return m ? `Measured bound (${m.season} wk ${m.week} provider feed, scoring ${fp}): applying THIS league's scoring to the components the provider supplies vs the standard-points fallback — D/ST mean |diff| ${m.DEF.mean_abs_error} pts, rank corr ${m.DEF.rank_correlation} (${m.DEF.materiality}); K mean |diff| ${m.K.mean_abs_error} pts, rank corr ${m.K.rank_correlation} (${m.K.materiality}). Partial components: a bound, not an exact value.` : `The size of the fallback divergence has NOT been measured for scoring ${fp}.`; };

export const SCORING_SURFACE = "league-scoring-contract"; export const SCORING_CONTRACT_VERSION = "scoring-contract-2026.1";
const BUILT_IN = phaseRef("INTELLIGENCE_MODERNIZATION_PHASE", "6");
const c = (key: string, value: string | number, note?: string): Component => ({ key, value, unit: typeof value === "number" ? unitFor("scoring.count") : unitFor("category"), ...(note ? { note } : {}) });

export function scoringContractEvidence(i: { league_slug: string; season: number; raw_scoring: Record<string, number> }): EvidenceBlock[] {
  const k = leagueScoringContract(i.raw_scoring); const fp = k.scoring_fingerprint;
  const temporal: TemporalIdentity = { season: i.season, week: null, through_week: null, as_of: null, generated_at: null, source_cutoff: null, point_kind: "CURRENT", as_of_kind: "CURRENT_SNAPSHOT", week_state: null, snapshot_id: null, player_team_temporal_identity: PHASE7 };
  const base = { surface: SCORING_SURFACE, topic: "scoring.league_contract", subject: { kind: "LEAGUE" as const, id: i.league_slug, league_slug: i.league_slug }, deployment: { state: "SHARED_DESCRIPTIVE" as const, may_influence_production: false }, temporal,
    freshness: { as_of: null, through_week: null, generated_at: null }, lineage: { surface_version: SCORING_CONTRACT_VERSION, content_identity: fp, canonical: { scoring_fingerprint: fp }, depends_on: [] as EvidenceBlock["lineage"]["depends_on"] },
    source: { built_in: BUILT_IN, source_data: "the league's provider scoring settings (canonical raw_scoring) classified against observed provider payloads (lib/scoring/data/observed-provider-keys.json)" },
    predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" as const }, origin: { source_class: "DERIVED_FROM_STATE", analysis_class: "DESCRIPTIVE" as const },
    limitations: ["Scoring-contract completeness is a CORRECTNESS statement about fantasy valuation under the league's declared rules — not a claim that any projected statistic is more accurate."] };
  const mk = (b: Omit<EvidenceBlock, "evidence_id" | "contract_version">, key: unknown[]) => mkRaw(b, key);
  const out: EvidenceBlock[] = [];
  out.push(mk({ ...base, metric: "contract.scoring_fingerprint", availability: { state: "AVAILABLE" }, value: fp, unit: unitFor("category"), category: { raw: fp, normalized: fp, mapping_status: "VERIFIED" }, components: [c("active_rules", k.active_rule_count), ...Object.entries(k.by_class).filter(([, n]) => n > 0).map(([cl, n]) => c(`class.${cl}`, n))] }, ["fp"]));
  out.push(mk({ ...base, metric: "contract.weekly_basis.offense", availability: { state: "AVAILABLE" }, value: k.weekly_basis.offense, unit: unitFor("category"), category: { raw: k.weekly_basis.offense, normalized: k.weekly_basis.offense, mapping_status: "VERIFIED" },
    limitations: [...base.limitations, "QB/RB/WR/TE weekly projections re-score the provider's component statistics with THIS league's scoring; provider precomputed pts_* totals are not used for offense.", ...(k.offense_rules_not_reaching_weekly_projection.length ? [`league scores offense rules the weekly provider does not supply (they add nothing to weekly projections): ${k.offense_rules_not_reaching_weekly_projection.join(", ")}`] : [])] }, ["offense"]));
  out.push(mk({ ...base, metric: "contract.weekly_basis.k_dst", availability: { state: "AVAILABLE" }, value: k.weekly_basis.k_dst, unit: unitFor("category"), category: { raw: k.weekly_basis.k_dst, normalized: k.weekly_basis.k_dst, mapping_status: "VERIFIED" },
    limitations: [...base.limitations, "Weekly K and D/ST values are Sleeper's STANDARD precomputed points: they do NOT reflect this league's K/D-ST scoring. The provider's K/D-ST components are partial and internally inconsistent, and its tier keys are plug-in point estimates, so exact league-specific reconstruction is not trustworthy.", `league K/D-ST rules NOT reflected in weekly values (${k.k_dst_rules_not_reflected_in_weekly_values.length}): ${k.k_dst_rules_not_reflected_in_weekly_values.join(", ") || "none"}`, matFor(fp), ...k.approximations] }, ["kdst"]));
  for (const r of k.rules) out.push(mk(ruleBlock(base, r, i.raw_scoring[r.key]!), ["rule", r.key]));
  return out;
}
function ruleBlock(base: Omit<EvidenceBlock, "evidence_id" | "contract_version" | "metric" | "availability">, r: RuleSupport, value: number): Omit<EvidenceBlock, "evidence_id" | "contract_version"> {
  return { ...(base as object), metric: `rule.${r.key}`, availability: { state: "AVAILABLE" }, value, unit: unitFor("scoring.points_per_unit"),
    components: [c("classification", r.classification), c("exact_vs_approximate", r.exact_vs_approximate), c("family", r.family), c("linearity", r.linearity), c("weekly_projection", r.weekly_projection), c("season_projection", r.season_projection), c("completed_games", r.historical), c("waiver_role_pricing", r.waiver_role_pricing)],
    limitations: [...base.limitations, ...(r.limitation ? [`${r.classification}: ${r.limitation}`] : [])] } as Omit<EvidenceBlock, "evidence_id" | "contract_version">;
}
