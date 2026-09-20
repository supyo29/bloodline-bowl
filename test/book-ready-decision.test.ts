/** Phase 3.5C Checkpoint D — decision/management converters run over FROZEN real production responses. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { startSitShadowEvidence, matchupEvidence, rosterHealthEvidence, schedulePlanningEvidence, waiverEvidence, tradeCapabilityEvidence } from "@/lib/book-ready/families/decision";
import { validateEvidenceBlock } from "@/lib/book-ready/validate";

const fx = (n: string) => JSON.parse(readFileSync(`test/fixtures/book-ready/${n}.json`, "utf8"));
const m = { league_slug: "bloodline-bowl", manager_slug: "supyo29", season: 2026, week: 2 };
const bad = (bs: Parameters<typeof validateEvidenceBlock>[0][]) => bs.flatMap((b) => validateEvidenceBlock(b).map((e) => `${b.metric}: ${e}`));
const sha = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex");

test("Start/Sit shadow evidence: SHADOW, never predictive, never influences production, valid", () => {
  const i = fx("intelligence-w2"); if (!i.start_sit_shadow) return;
  const before = sha(i); const blocks = startSitShadowEvidence(i.start_sit_shadow, m);
  assert.ok(blocks.length > 0); assert.deepEqual(bad(blocks).slice(0, 5), []);
  for (const b of blocks) { assert.equal(b.deployment.may_influence_production, false); assert.ok(!String(b.predictive?.class ?? "").endsWith("_PREDICTIVE") || b.predictive!.class === "SHADOW_PREDICTIVE"); assert.notEqual(b.origin.analysis_class, "OBSERVED"); }
  assert.equal(sha(i), before, "converter did not mutate its input");
});
test("Matchup evidence is valid and non-mutating", () => {
  const i = fx("intelligence-w2"); const before = sha(i); const blocks = matchupEvidence(i.matchup_intelligence, m);
  assert.deepEqual(bad(blocks).slice(0, 5), []); assert.equal(sha(i), before);
  assert.ok(blocks.every((b) => b.deployment.may_influence_production === false || b.deployment.state === "PRODUCTION_ACTIVE"));
  assert.deepEqual(matchupEvidence(null, m).flatMap((b) => validateEvidenceBlock(b)), []);
});
test("Roster health: percentiles are 0-1 only when a population is known; valid blocks", () => {
  const i = fx("roster-health-w2"); const before = sha(i);
  const blocks = rosterHealthEvidence(i, m, { populationN: 12 }); assert.deepEqual(bad(blocks).slice(0, 5), []); assert.equal(sha(i), before);
  for (const b of blocks) for (const c of b.comparison ?? []) if (c.percentile) assert.ok(c.percentile.value >= 0 && c.percentile.value <= 1);
  const noPop = rosterHealthEvidence(i, m); assert.deepEqual(bad(noPop).slice(0, 5), []);
  for (const b of noPop) assert.ok(!b.comparison?.some((c) => c.percentile), "no fabricated percentile without a population");
});
test("Schedule planning evidence is valid, non-mutating, and not a recommendation", () => {
  const i = fx("schedule-planning-w2"); const before = sha(i); const blocks = schedulePlanningEvidence(i, m);
  assert.ok(blocks.length > 0); assert.deepEqual(bad(blocks).slice(0, 5), []); assert.equal(sha(i), before);
  assert.ok(blocks.every((b) => b.deployment.may_influence_production === false));
});
test("Waivers stay UNAVAILABLE per the readiness contract; trade evaluation is UNSUPPORTED via GET", () => {
  const w = waiverEvidence(fx("intelligence-w2").waivers, m);
  for (const b of w) { assert.notEqual(b.availability.state, "AVAILABLE"); assert.ok(b.value == null); assert.ok(b.availability.reason); }
  assert.deepEqual(bad(w), []);
  const t = tradeCapabilityEvidence(m); assert.deepEqual(bad(t), []);
  for (const b of t) { assert.equal(b.availability.state, "UNAVAILABLE"); assert.equal(b.origin.analysis_class, "UNSUPPORTED"); }
});
