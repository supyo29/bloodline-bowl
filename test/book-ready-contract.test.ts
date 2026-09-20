/** Phase 3.5C Checkpoint A — the Book-Ready evidence contract: vocabulary, units, identity, validator. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_CONTRACT_VERSION, type EvidenceBlock } from "@/lib/book-ready/schema";
import { analysisClassFor, categoryFor, compoundPredictive, confidenceFor, mayInfluenceProduction, predictiveClassFor, sampleSupportFor } from "@/lib/book-ready/vocabulary";
import { assertConvertible, fiTeamUnit, registeredFiTeamMetrics, unitFor, violatesRange } from "@/lib/book-ready/units";
import { classifyIdentity } from "@/lib/book-ready/identity";
import { assertValid, validateEvidenceBlock } from "@/lib/book-ready/validate";
import { PHASE_NAMESPACES, formatPhaseRef, phaseRef } from "@/lib/book-ready/phase-namespaces";

const ROOT = process.cwd();

/* ------------------------------ vocabulary ------------------------------ */
test("source-native class is preserved and mapped truthfully; unknown classes throw (no silent default)", () => {
  assert.equal(analysisClassFor("FI", "OBSERVED"), "OBSERVED");
  assert.equal(analysisClassFor("FI", "MODELED"), "MODELED");
  assert.equal(analysisClassFor("FI", "DESCRIPTIVE_ONLY"), "DESCRIPTIVE");
  assert.equal(analysisClassFor("SCHEME", "UNVERIFIED_SOURCE_CONFLICT"), "SOURCE_CONFLICT");
  assert.equal(analysisClassFor("OPP", "CONDITIONAL_SCENARIO"), "CONDITIONAL");
  assert.equal(analysisClassFor("STARTSIT", "SHADOW_ADJUSTMENT"), "SHADOW");
  assert.equal(analysisClassFor("STARTSIT", "PRODUCTION_BASELINE_PROJECTION"), "PROJECTED");
  assert.equal(analysisClassFor("ROLE", "EWMA_HORIZON"), "DESCRIPTIVE"); // an aggregate of observations is not a projection
  assert.equal(analysisClassFor("ROLE", "LATEST_OBSERVED"), "OBSERVED");
  assert.throws(() => analysisClassFor("FI", "SOMETHING_NEW"), /unmapped/);
});

test("confidence, sample support, predictive status and deployment are INDEPENDENT axes", () => {
  // Scheme evidence_class is sample support, never model confidence
  assert.deepEqual(sampleSupportFor("scheme.evidence_class", "STRONG", 500), { source_value: "STRONG", level: "STRONG", basis: "scheme.evidence_class", n: 500 });
  assert.equal(confidenceFor("FI", "INSUFFICIENT_SAMPLE").level, "INSUFFICIENT");
  assert.equal(confidenceFor("FI", "HIGH").source_value, "HIGH");
  assert.throws(() => confidenceFor("SCHEME", "STRONG"), /unmapped confidence/, "evidence_class must NOT be accepted as confidence");
  // The analyst sentence: HIGH confidence, current data, but DESCRIPTIVE_ONLY family that cannot influence production.
  const conf = confidenceFor("FI", "HIGH"); const pred = predictiveClassFor("DESCRIPTIVE_TENDENCY", "SHARED_DESCRIPTIVE");
  assert.equal(conf.level, "HIGH"); assert.equal(pred, "DESCRIPTIVE_ONLY"); assert.equal(mayInfluenceProduction("SHARED_DESCRIPTIVE"), false);
});

test("predictive normalization: descriptive never becomes predictive; compound takes the conservative side; deployment decides shadow vs production", () => {
  assert.equal(predictiveClassFor("PREDICTIVE", "SHARED_DESCRIPTIVE"), "SHADOW_PREDICTIVE");
  assert.equal(predictiveClassFor("PREDICTIVE", "SHADOW_ONLY"), "SHADOW_PREDICTIVE");
  assert.equal(predictiveClassFor("PREDICTIVE", "PRODUCTION_ACTIVE"), "PRODUCTION_PREDICTIVE");
  assert.equal(predictiveClassFor("NOT_PREDICTIVE", "SHADOW_ONLY"), "EXCLUDED");
  assert.equal(predictiveClassFor("UNVALIDATED", "SHADOW_ONLY"), "UNVALIDATED");
  for (const d of ["DESCRIPTIVE_ONLY", "DESCRIPTIVE_TENDENCY"]) for (const dep of ["SHADOW_ONLY", "SHARED_CONTEXT", "SHARED_DESCRIPTIVE", "ADVISORY_ONLY", "PRODUCTION_ACTIVE"] as const)
    assert.ok(!predictiveClassFor(d, dep).endsWith("_PREDICTIVE"), `${d}@${dep}`);
  assert.equal(compoundPredictive("off:PREDICTIVE|def:NOT_PREDICTIVE", "SHADOW_ONLY").class, "EXCLUDED");
  assert.equal(compoundPredictive("off:PREDICTIVE|def:WEAKLY_PREDICTIVE", "SHADOW_ONLY").class, "WEAKLY_PREDICTIVE");
  assert.equal(compoundPredictive("off:NA|def:UNVALIDATED", "SHADOW_ONLY").class, "UNVALIDATED");
  assert.equal(compoundPredictive("off:PREDICTIVE|def:PREDICTIVE", "SHADOW_ONLY").class, "SHADOW_PREDICTIVE");
  assert.equal(compoundPredictive("off:PREDICTIVE|def:NOT_PREDICTIVE", "SHADOW_ONLY").source_status, "off:PREDICTIVE|def:NOT_PREDICTIVE"); // native preserved
  assert.throws(() => predictiveClassFor("MYSTERY", "SHADOW_ONLY"));
});

test("source-native categories are retained; no verified mapping => raw kept, normalized null", () => {
  assert.deepEqual(categoryFor("UNDER CENTER"), { raw: "UNDER CENTER", normalized: null, mapping_status: "NO_VERIFIED_MAPPING" });
  assert.deepEqual(categoryFor("SHOTGUN", { SHOTGUN: "SHOTGUN" }), { raw: "SHOTGUN", normalized: "SHOTGUN", mapping_status: "VERIFIED" });
});

/* ------------------------------ units ------------------------------ */
test("units: fraction / percentage / count / percentile are never implicitly converted", () => {
  assert.throws(() => assertConvertible(unitFor("role.target_share"), unitFor("fi.team.off_proe" as never) as never), /./);
  assert.throws(() => assertConvertible(unitFor("role.opportunity_total"), unitFor("role.target_share")), /refusing implicit conversion/);
  assert.throws(() => assertConvertible(fiTeamUnit("off_proe"), unitFor("scheme.fraction")), /refusing/);
  assert.equal(unitFor("role.opportunity_total").kind, "count");
  assert.equal(fiTeamUnit("off_proe").kind, "percentage"); // pp, not a 0-1 fraction
});

test("units: legitimate values above 1 are preserved; the same value is INVALID where >1 is not legitimate", () => {
  assert.equal(violatesRange(1.0625, unitFor("role.snap_share")), false, "QB snap share may exceed 1.0 (kneel exclusion)");
  assert.equal(violatesRange(1.0625, unitFor("fi.usage.snap_share")), true, "the same number in a strict fraction IS invalid");
  assert.equal(violatesRange(1.484, unitFor("opp.inheritance_rate")), false, "inheritance ratio may exceed 1");
  assert.equal(unitFor("opp.inheritance_rate").kind, "ratio");
  assert.equal(violatesRange(-0.39, unitFor("role.air_yards_share")), false, "air-yards share may be negative");
  assert.equal(violatesRange(0.5, unitFor("fi.percentile")), false); assert.equal(violatesRange(1.2, unitFor("fi.percentile")), true);
  assert.equal(violatesRange(-16.59, fiTeamUnit("off_proe")), false); assert.equal(violatesRange(150, fiTeamUnit("off_proe")), true);
  assert.equal(violatesRange(3.2, unitFor("matchup.probability")), true);
});

test("units are explicit: an unregistered metric throws instead of being inferred from its name", () => {
  assert.throws(() => unitFor("role.some_new_share"), /never inferred/);
  assert.throws(() => fiTeamUnit("off_new_rate"), /no explicit FI team unit/);
});

function spearmanSign(xs: Array<[number, number]>): number {
  const rk = (v: number[]) => { const s = [...new Set(v)].sort((a, b) => a - b); return new Map(s.map((x, i) => [x, i])); };
  const a = xs.map(([x]) => x), b = xs.map(([, y]) => y); const ra = rk(a), rb = rk(b);
  const ma = a.reduce((s, x) => s + ra.get(x)!, 0) / a.length, mb = b.reduce((s, y) => s + rb.get(y)!, 0) / b.length;
  const num = xs.reduce((s, [x, y]) => s + (ra.get(x)! - ma) * (rb.get(y)! - mb), 0);
  return Math.sign(num);
}
test("units: every FI team metric's declared percentile orientation matches the served data", () => {
  const lines = readFileSync(join(ROOT, "lib/football-intel/data/team_profile.csv"), "utf8").split("\n").filter(Boolean);
  const head = lines[0]!.split(","); const mi = head.indexOf("metric"), vi = head.indexOf("modeled"), pi = head.indexOf("league_percentile");
  const by = new Map<string, Array<[number, number]>>();
  for (const l of lines.slice(1)) { const c = l.split(","); if (c.length !== head.length || c[vi] === "" || c[pi] === "") continue; (by.get(c[mi]!) ?? by.set(c[mi]!, []).get(c[mi]!)!).push([Number(c[vi]), Number(c[pi])]); }
  const unregistered = [...by.keys()].filter((m) => !registeredFiTeamMetrics().includes(m));
  assert.deepEqual(unregistered, [], "every served FI team metric must have an explicit unit + orientation");
  assert.ok(by.size >= 15, "expected the served metrics");
  for (const [m, xs] of by) assert.equal(spearmanSign(xs), fiTeamUnit(m).percentile_orientation === "VALUE_ORIENTED" ? 1 : -1, `${m} orientation`);
});

/* ------------------------------ identity ------------------------------ */
test("identity quality is explicit; placeholders/blanks are kept with limitations and never repaired", () => {
  const ok = classifyIdentity({ canonical_player_id: "player:gsis:1", name: "A B", position: "WR", team: "KC" });
  assert.equal(ok.resolution, "RESOLVED"); assert.deepEqual(ok.limitations, []);
  const xx = classifyIdentity({ source_player_id: "00-0036936", name: "Rondale Moore", position: "XX", team: "MIN" });
  assert.equal(xx.resolution, "PLACEHOLDER"); assert.equal(xx.position, "XX"); assert.equal(xx.name, "Rondale Moore"); assert.match(xx.limitations.join(), /placeholder/);
  const blank = classifyIdentity({ source_player_id: "00-0023968", name: "", position: "", team: "" });
  assert.equal(blank.resolution, "PLACEHOLDER"); assert.equal(blank.name, null); assert.equal(blank.position, null); assert.ok(blank.limitations.length);
  assert.equal(classifyIdentity({ source_player_id: "x", name: "N", position: "WR", team: null }).resolution, "PARTIAL");
  assert.equal(classifyIdentity({}).resolution, "UNRESOLVED");
  assert.equal(xx.source_player_id, "00-0036936"); // id preserved, nothing invented
});

/* ------------------------------ validator ------------------------------ */
const base = (): EvidenceBlock => ({
  evidence_id: "eb:test", contract_version: EVIDENCE_CONTRACT_VERSION, surface: "football-intelligence", topic: "fi.team_metric", metric: "off_pass_epa",
  subject: { kind: "TEAM", id: "KC" }, availability: { state: "AVAILABLE" }, value: 0.05, unit: fiTeamUnit("off_pass_epa"),
  origin: { source_class: "MODELED", analysis_class: "MODELED" },
  model_confidence: confidenceFor("FI", "MEDIUM"), sample_support: sampleSupportFor("fi.n_obs_effective", undefined, 33.9),
  predictive: { source_status: "PREDICTIVE", class: "SHADOW_PREDICTIVE" }, deployment: { state: "SHARED_DESCRIPTIVE", may_influence_production: false },
  freshness: { as_of: "t", through_week: 2, generated_at: "t" },
  temporal: { season: 2026, week: null, through_week: 2, as_of: "t", generated_at: "t", point_kind: "CURRENT", as_of_kind: "CURRENT_SNAPSHOT", player_team_temporal_identity: "NOT_MODELED_UNTIL_INTELLIGENCE_MODERNIZATION_PHASE_7" },
  lineage: { surface_version: "fi:2026:w02:x" }, source: { built_in: phaseRef("FOOTBALL_INTELLIGENCE_PHASE", "3") }, limitations: [],
});

test("validator accepts a well-formed block and rejects each violation class", () => {
  assert.deepEqual(validateEvidenceBlock(base()), []);
  const m = (f: (b: EvidenceBlock) => void) => { const b = base(); f(b); return validateEvidenceBlock(b).join(" | "); };
  assert.match(m((b) => { b.availability = { state: "UNAVAILABLE" }; }), /value present although availability|requires a reason/);
  assert.match(m((b) => { b.value = 5; b.unit = unitFor("fi.percentile"); }), /violates the metric's true range/);
  assert.match(m((b) => { delete b.unit; }), /requires an explicit unit/);
  assert.match(m((b) => { b.origin = { source_class: "DESCRIPTIVE_ONLY", analysis_class: "DESCRIPTIVE" }; b.predictive = { source_status: "PREDICTIVE", class: "SHADOW_PREDICTIVE" }; }), /cannot carry predictive class/);
  assert.match(m((b) => { b.predictive = { source_status: "PREDICTIVE", class: "PRODUCTION_PREDICTIVE" }; }), /without production deployment/);
  assert.match(m((b) => { b.deployment = { state: "SHADOW_ONLY", may_influence_production: true }; }), /requires PRODUCTION_ACTIVE/);
  assert.match(m((b) => { b.origin = { source_class: "CONDITIONAL_SCENARIO", analysis_class: "CONDITIONAL" }; }), /conditional/i);
  assert.match(m((b) => { b.origin = { source_class: "UNVERIFIED_SOURCE_CONFLICT", analysis_class: "SOURCE_CONFLICT" }; }), /SOURCE_CONFLICT must state/);
  assert.match(m((b) => { b.subject.identity = classifyIdentity({ source_player_id: "x", name: "N", position: "XX", team: "T" }); b.subject.identity.limitations = []; }), /non-RESOLVED identity/);
  assert.match(m((b) => { b.temporal.player_team_temporal_identity = "FULL" as never; }), /Phase 7/);
  assert.match(m((b) => { b.temporal.as_of_kind = "PUBLISHED_STATE"; }), /CURRENT snapshot must not be labelled/);
  assert.match(m((b) => { b.comparison = [{ population: { id: "", season: 2026, through_week: 2, n: 0, definition: "" } }]; }), /explicit population/);
  assert.match(m((b) => { b.change = [{ comparison_period: "P", prior_value: "A", current_value: "B", absolute_delta: 1, relative_delta: null, transition: { from: "A", to: "B" }, significance: null }]; }), /transition must not carry a numeric delta/);
  assert.match(m((b) => { b.change = [{ comparison_period: "P", prior_value: 1, current_value: 2, absolute_delta: 1, relative_delta: 1, significance: { status: "x", source: "COMPUTED" as never } }]; }), /never manufactured/);
  assert.throws(() => assertValid({ ...base(), evidence_id: "bad" }));
});

test("phase namespaces are explicit; a bare phase number cannot be rendered", () => {
  assert.equal(formatPhaseRef(phaseRef("TEAM_MANAGEMENT_PHASE", "4")), "TEAM_MANAGEMENT_PHASE:4");
  assert.notEqual(formatPhaseRef(phaseRef("INTELLIGENCE_MODERNIZATION_PHASE", "4")), formatPhaseRef(phaseRef("TEAM_MANAGEMENT_PHASE", "4")));
  assert.ok(Object.keys(PHASE_NAMESPACES).length >= 4);
});
