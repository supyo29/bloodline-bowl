/**
 * Phase 3.5C — the shared analytical vocabulary. Source systems keep their native states; this layer MAPS them
 * (never overwrites) and every mapped value keeps its `source_value`. The mappings are explicit tables so a
 * reviewer can audit them, and each axis is independent: confidence != sample support != freshness != deployment
 * != predictive status.
 */
import type { AnalysisClass, ConfidenceLevel, DeploymentState, PredictiveClass, SampleSupportLevel } from "./schema";

/** source_class -> analysis_class, per source system. An unknown source class THROWS (no silent default). */
const CLASS_MAP: Record<string, Record<string, AnalysisClass>> = {
  FI: { OBSERVED: "OBSERVED", MODELED: "MODELED", DESCRIPTIVE_ONLY: "DESCRIPTIVE" },
  // Role: `latest` is an observed value; recent/season/prior are EWMA/aggregate summaries of observations (descriptive,
  // not a projection).
  ROLE: { LATEST_OBSERVED: "OBSERVED", EWMA_HORIZON: "DESCRIPTIVE", OBSERVED_GAME: "OBSERVED" },
  SCHEME: { OBSERVED: "OBSERVED", DESCRIPTIVE_ONLY: "DESCRIPTIVE", PRIOR_ONLY: "DESCRIPTIVE", UNVERIFIED_SOURCE_CONFLICT: "SOURCE_CONFLICT" },
  OPP: { CONDITIONAL_SCENARIO: "CONDITIONAL", PHASE2_OBSERVED_PRE_ROLE: "OBSERVED" },
  STARTSIT: { SHADOW_ADJUSTMENT: "SHADOW", PRODUCTION_BASELINE_PROJECTION: "PROJECTED" },
  MATCHUP: { SHADOW_DISTRIBUTION: "SHADOW" },
  DERIVED: { DERIVED_FROM_PROJECTIONS: "PROJECTED", DERIVED_FROM_STATE: "DESCRIPTIVE" },
  ANY: { UNAVAILABLE: "UNAVAILABLE", UNSUPPORTED: "UNSUPPORTED", RECONSTRUCTED: "RECONSTRUCTED" },
};

export function analysisClassFor(system: keyof typeof CLASS_MAP, sourceClass: string): AnalysisClass {
  const hit = CLASS_MAP[system]?.[sourceClass] ?? CLASS_MAP.ANY![sourceClass];
  if (!hit) throw new Error(`unmapped source class ${system}:${sourceClass} — add an explicit mapping, do not default`);
  return hit;
}

/** Statistical/model confidence axis. Scheme `evidence_class` is NOT confidence (see sampleSupportFor). */
const CONFIDENCE_MAP: Record<string, ConfidenceLevel> = {
  HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW",
  INSUFFICIENT_SAMPLE: "INSUFFICIENT", INSUFFICIENT_EVIDENCE: "INSUFFICIENT", INSUFFICIENT: "INSUFFICIENT",
};
export function confidenceFor(source: string, sourceValue: string): { source_value: string; level: ConfidenceLevel; source: string } {
  const level = CONFIDENCE_MAP[sourceValue];
  if (!level) throw new Error(`unmapped confidence ${source}:${sourceValue}`);
  return { source_value: sourceValue, level, source };
}

/** Sample-support axis (how much relevant data backs a value). Player-Scheme `evidence_class` lives HERE. */
const SUPPORT_MAP: Record<string, SampleSupportLevel> = {
  STRONG: "STRONG", MODERATE: "MODERATE", WEAK: "WEAK", INSUFFICIENT: "INSUFFICIENT",
  // Role evidence_state describes support for the observation, not model confidence:
  OBSERVED: "MODERATE", TENTATIVE: "WEAK", INSUFFICIENT_SAMPLE: "INSUFFICIENT",
};
export function sampleSupportFor(basis: string, sourceValue: string | undefined, n?: number | null) {
  if (sourceValue === undefined) return { basis, ...(n !== undefined ? { n } : {}) };
  const level = SUPPORT_MAP[sourceValue];
  if (!level) throw new Error(`unmapped sample-support ${basis}:${sourceValue}`);
  return { source_value: sourceValue, level, basis, ...(n !== undefined ? { n } : {}) };
}

/** Strength order used ONLY to take the more conservative side of a compound status. */
const PREDICTIVE_ORDER: PredictiveClass[] = ["EXCLUDED", "UNVALIDATED", "DESCRIPTIVE_ONLY", "RESEARCH_ONLY", "WEAKLY_PREDICTIVE", "SHADOW_PREDICTIVE", "PRODUCTION_PREDICTIVE"];

/** Normalizes ONE source predictive status. Deployment decides whether a validated family is shadow or production. */
export function predictiveClassFor(sourceStatus: string, deployment: DeploymentState): PredictiveClass {
  switch (sourceStatus) {
    case "PREDICTIVE": return deployment === "PRODUCTION_ACTIVE" ? "PRODUCTION_PREDICTIVE" : "SHADOW_PREDICTIVE";
    case "WEAKLY_PREDICTIVE": return "WEAKLY_PREDICTIVE";
    case "NOT_PREDICTIVE": return "EXCLUDED";
    case "DESCRIPTIVE_ONLY": case "DESCRIPTIVE_TENDENCY": return "DESCRIPTIVE_ONLY";
    case "UNVALIDATED": case "NA": return "UNVALIDATED";
    case "RESEARCH": case "RESEARCH_ONLY": return "RESEARCH_ONLY";
    default: throw new Error(`unmapped predictive status ${sourceStatus}`);
  }
}

/** FI contextual features carry compound `off:X|def:Y`. The overall class is the MORE CONSERVATIVE side. */
export function compoundPredictive(source: string, deployment: DeploymentState): { source_status: string; class: PredictiveClass; parts?: { offense: PredictiveClass; defense: PredictiveClass } } {
  const m = /^off:([A-Z_]+)\|def:([A-Z_]+)$/.exec(source);
  if (!m) return { source_status: source, class: predictiveClassFor(source, deployment) };
  const offense = predictiveClassFor(m[1]!, deployment); const defense = predictiveClassFor(m[2]!, deployment);
  const weaker = PREDICTIVE_ORDER.indexOf(offense) <= PREDICTIVE_ORDER.indexOf(defense) ? offense : defense;
  return { source_status: source, class: weaker, parts: { offense, defense } };
}

/** Whether a predictive class may ever influence production. Only a PRODUCTION_ACTIVE deployment can. */
export const mayInfluenceProduction = (deployment: DeploymentState): boolean => deployment === "PRODUCTION_ACTIVE";

/** Source-native categories whose translation would lose information. No verified taxonomy exists → raw retained. */
export function categoryFor(raw: string, verifiedMap?: Record<string, string>) {
  const normalized = verifiedMap?.[raw] ?? null;
  return { raw, normalized, mapping_status: (normalized ? "VERIFIED" : "NO_VERIFIED_MAPPING") as "VERIFIED" | "NO_VERIFIED_MAPPING" };
}
