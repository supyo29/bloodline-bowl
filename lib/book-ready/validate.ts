/**
 * Phase 3.5C — structural validation of an EvidenceBlock. Fails on: silent null-filled availability, a value
 * outside its true range, an axis collapsed into another, descriptive/shadow data presented as predictive,
 * conditional evidence without its condition, unresolved-identity rows without their limitations, and history
 * points without temporal identity.
 */
import { EVIDENCE_CONTRACT_VERSION, type EvidenceBlock, type PredictiveClass } from "./schema";
import { violatesRange } from "./units";

const PREDICTIVE_OK_FOR: Record<string, PredictiveClass[]> = {
  DESCRIPTIVE: ["DESCRIPTIVE_ONLY", "EXCLUDED", "UNVALIDATED", "RESEARCH_ONLY"],
  SHADOW: ["SHADOW_PREDICTIVE", "WEAKLY_PREDICTIVE", "RESEARCH_ONLY", "EXCLUDED", "UNVALIDATED", "DESCRIPTIVE_ONLY"],
};

export function validateEvidenceBlock(b: EvidenceBlock): string[] {
  const bad: string[] = [];
  const add = (m: string) => bad.push(m);
  if (b.contract_version !== EVIDENCE_CONTRACT_VERSION) add("contract_version mismatch");
  if (!b.evidence_id.startsWith("eb:")) add("evidence_id must be deterministic (eb:…)");
  if (!b.origin?.source_class || !b.origin?.analysis_class) add("origin must carry BOTH source_class and analysis_class");

  const avail = b.availability.state;
  if (avail !== "AVAILABLE") {
    if (b.value !== undefined && b.value !== null) add(`value present although availability is ${avail}`);
    if (!b.availability.reason) add(`availability ${avail} requires a reason`);
    if (b.origin.analysis_class !== "UNAVAILABLE" && b.origin.analysis_class !== "UNSUPPORTED" && b.origin.analysis_class !== "SOURCE_CONFLICT" && avail !== "CURRENT_ONLY" && avail !== "EXPECTED_SOURCE_LAG" && avail !== "INSUFFICIENT_SAMPLE" && avail !== "NOT_YET_REFRESHED" && avail !== "HISTORY_NOT_SUPPORTED") add("non-available block must not claim an available analysis class");
  } else if (b.value !== undefined && b.value !== null && typeof b.value === "number") {
    if (!b.unit) add("numeric value requires an explicit unit");
    else if (violatesRange(b.value, b.unit)) add(`value ${b.value} violates the metric's true range (${b.unit.kind})`);
  }
  if (typeof b.value === "number" && b.unit?.kind === "categorical") add("categorical unit with a numeric value");

  // independent axes: the four must not be collapsed
  if (b.model_confidence && b.sample_support && b.model_confidence.source === b.sample_support.basis) add("confidence and sample support must be distinct axes");
  const ac = b.origin.analysis_class;
  if (b.predictive) {
    const allowed = PREDICTIVE_OK_FOR[ac];
    if (allowed && !allowed.includes(b.predictive.class)) add(`${ac} evidence cannot carry predictive class ${b.predictive.class}`);
    if (b.predictive.class === "PRODUCTION_PREDICTIVE" && !b.deployment.may_influence_production) add("PRODUCTION_PREDICTIVE without production deployment");
  }
  if (b.deployment.may_influence_production && b.deployment.state !== "PRODUCTION_ACTIVE") add("may_influence_production requires PRODUCTION_ACTIVE");
  if (ac === "CONDITIONAL" && !b.relationships?.some((r) => r.type === "CONDITIONAL_ON") && !b.components?.length) add("CONDITIONAL evidence must declare what it is conditional on");
  if (ac === "SOURCE_CONFLICT" && !b.limitations.length) add("SOURCE_CONFLICT must state the conflict in limitations");

  // identity honesty
  const id = b.subject.identity;
  if (id && id.resolution !== "RESOLVED" && id.limitations.length === 0) add("non-RESOLVED identity must list its limitations");

  // temporal honesty
  const t = b.temporal;
  if (t.player_team_temporal_identity !== "NOT_MODELED_UNTIL_INTELLIGENCE_MODERNIZATION_PHASE_7") add("player-team temporal identity claim is not allowed before Phase 7");
  if (t.point_kind === "CURRENT" && t.as_of_kind === "PUBLISHED_STATE") add("a CURRENT snapshot must not be labelled a historical PUBLISHED_STATE");
  if (b.history) {
    if (b.history.class === "CURRENT_ONLY" && b.history.points.length > 1) add("CURRENT_ONLY history cannot have multiple points");
    if (b.history.class === "UNSUPPORTED" && b.history.points.length > 0) add("UNSUPPORTED history cannot carry points");
    const seen = new Set<string>();
    for (const p of b.history.points) {
      if (!p.temporal || p.temporal.as_of === undefined) add("history point without temporal identity");
      if (p.temporal.point_kind === "POINT_IN_TIME_STATE" && !p.temporal.snapshot_id) add("POINT_IN_TIME_STATE point must reference its immutable snapshot");
      if (p.temporal.as_of_kind === "RETROSPECTIVE_RECONSTRUCTION" && b.history.class !== "RETROSPECTIVE_ONLY" && b.history.class !== "RECONSTRUCTABLE_AS_OF") add("retrospective point in a non-retrospective series");
      const k = `${p.temporal.snapshot_id ?? "cur"}|${p.temporal.season}|${p.temporal.through_week}|${p.temporal.week}`;
      if (seen.has(k)) add(`duplicate history point ${k}`); seen.add(k);
      if (typeof p.value === "number" && b.unit && violatesRange(p.value, b.unit)) add(`history value ${p.value} violates the metric range`);
    }
  }
  // comparison honesty: population always explicit
  for (const c of b.comparison ?? []) {
    if (!c.population?.id || !(c.population.n > 0)) add("comparison without an explicit population");
    if (c.percentile && (c.percentile.value < 0 || c.percentile.value > 1)) add("percentile outside 0-1");
    if (c.rank && (c.rank.position < 1 || c.rank.position > c.rank.of)) add("rank outside population");
  }
  for (const ch of b.change ?? []) {
    if (ch.transition && ch.absolute_delta !== null) add("categorical transition must not carry a numeric delta");
    if (ch.significance && ch.significance.source !== "MODEL_SUPPLIED") add("significance must be model-supplied, never manufactured");
    if (ch.relative_delta !== null && (ch.prior_value === 0 || typeof ch.prior_value !== "number")) add("relative delta requires a non-zero numeric prior");
  }
  if (!b.lineage) add("lineage missing");
  if (!b.source?.built_in?.namespace) add("built_in phase must be namespaced");
  return bad;
}

export function assertValid(b: EvidenceBlock): EvidenceBlock {
  const bad = validateEvidenceBlock(b);
  if (bad.length) throw new Error(`invalid EvidenceBlock ${b.evidence_id}: ${bad.join("; ")}`);
  return b;
}
