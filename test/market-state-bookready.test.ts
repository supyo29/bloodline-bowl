/** Phase 4.5 Checkpoint F — Book-Ready market evidence + Analysis Book capability. */
import test from "node:test";
import assert from "node:assert/strict";
import { marketStateEvidence } from "@/lib/book-ready/families/market-state";
import { validateEvidenceBlock } from "@/lib/book-ready/validate";
import { buildMarketSnapshot } from "@/lib/market-state/build";
import { badSrc, marketInput, PRIORITY_SETTINGS, POSITIONS, okSrc } from "./fixtures/market";

const ok = () => buildMarketSnapshot(marketInput());
const metric = (bs: ReturnType<typeof marketStateEvidence>, m: string) => bs.find((b) => b.metric === m)!;

test("market evidence: every block satisfies the Book-Ready contract and carries the content identity", () => {
  const bs = marketStateEvidence(ok()); assert.ok(bs.length >= 8);
  for (const b of bs) { assert.deepEqual(validateEvidenceBlock(b), [], `${b.metric}`); assert.equal(b.surface, "league-market-state"); assert.equal(b.deployment.may_influence_production, false); assert.match(String(b.lineage.content_identity), /^mkt:/); assert.ok(b.limitations.some((l) => /pending waiver claims/.test(l))); }
  const avail = metric(bs, "pool.available_count"); assert.equal(avail.unit!.kind, "count"); assert.ok(avail.components!.length > 0); assert.equal(avail.value, ok().counts.AVAILABLE_FREE_AGENT);
  assert.equal(metric(bs, "rules.faab_budget").value, 100); assert.equal(metric(bs, "readiness.status").value, "READY");
});
test("stable evidence ids and content identity across reads of an unchanged market", () => {
  const a = marketStateEvidence(ok()); const b = marketStateEvidence(buildMarketSnapshot(marketInput({ request_id: "req:9", source_snapshot_id: "s9" })));
  assert.deepEqual(a.map((x) => x.lineage.content_identity), b.map((x) => x.lineage.content_identity));
});
test("a blocked market yields UNAVAILABLE pool blocks with the precise codes — never a count presented as current", () => {
  const bs = marketStateEvidence(buildMarketSnapshot(marketInput({ transactions: { source: badSrc(), entries: [] } })));
  for (const m of ["pool.available_count", "pool.on_waivers_count", "pool.rostered_count"]) { const b = metric(bs, m); assert.equal(b.availability.state, "UNAVAILABLE"); assert.match(b.availability.reason!, /FREE_AGENT_POOL_UNAVAILABLE.*WAIVER_STATE_UNVERIFIABLE/); assert.equal(b.value, undefined); }
  assert.equal(metric(bs, "readiness.status").value, "NOT_READY"); for (const b of bs) assert.deepEqual(validateEvidenceBlock(b), []);
});
test("a priority league's stray budget is NOT_APPLICABLE, not a currency", () => {
  const bs = marketStateEvidence(buildMarketSnapshot(marketInput({ rules: { source: okSrc(), settings: PRIORITY_SETTINGS, roster_positions: POSITIONS } })));
  assert.equal(metric(bs, "rules.faab_budget").availability.state, "NOT_APPLICABLE"); assert.equal(metric(bs, "rules.acquisition_system").value, "PRIORITY");
});
