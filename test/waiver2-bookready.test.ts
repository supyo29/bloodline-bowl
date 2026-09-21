/** Phase 4 — Waiver 2.0 is Book-Ready by construction: native EvidenceBlocks, validated, decomposed, with honest availability. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateWaiver2 } from "@/lib/waiver2";
import { waiver2ActionsEvidence, waiver2MarketEvidence, waiver2ReplacementEvidence } from "@/lib/book-ready/families/waiver2";
import { validateEvidenceBlock } from "@/lib/book-ready/validate";
import { TOPICS } from "@/lib/book-ready/query";
import { mkWaiverInput, stdMine, oppStub } from "./fixtures/waiver2";

const M = { league_slug: "bloodline-bowl", manager_slug: "supyo29", season: 2026, illustrative: false };
const OTHERS = [{ id: "3", players: [{ id: "o1", pos: "WR" as const, pts: 9, team: "GB" }, { id: "o3", pos: "RB" as const, pts: 12, team: "GB" }] }, { id: "4", players: [{ id: "p1", pos: "WR" as const, pts: 5, team: "NE" }, { id: "p2", pos: "WR" as const, pts: 4, team: "NE" }, { id: "star", pos: "WR" as const, pts: 15, team: "CHI", injury: "Out", gsis: "00-star" }] }];
const inp = () => mkWaiverInput({ mine: stdMine(), others: OTHERS, freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }, { id: "fa3", pos: "RB", pts: 9, team: "NO", ros: 110 }], roles: { fa1: { tRecent: 0.27, tSeason: 0.2, conf: "HIGH", trend: "EXPANDING" }, fa3: { rRecent: 0.3, rSeason: 0.2 }, star: { tRecent: 0.3, tSeason: 0.3 } }, opp: oppStub({ team: "CHI", absent: "00-star", beneficiary: "00-fa1", delta: 0.1 }) });
const bad = (bs: ReturnType<typeof waiver2ActionsEvidence>) => bs.flatMap((b) => validateEvidenceBlock(b).map((e) => `${b.metric}: ${e}`));

test("actions evidence: every block validates against the shared contract, SHADOW_ONLY, with decomposition, comparison, lineage and content identity", () => {
  const ev = evaluateWaiver2(inp()); const bs = waiver2ActionsEvidence(ev, { ...M, illustrative: false });
  assert.equal(ev.availability.status, "AVAILABLE"); assert.ok(bs.length > 20); assert.deepEqual(bad(bs).slice(0, 5), []);
  assert.ok(bs.every((b) => b.deployment.state === "SHADOW_ONLY" && b.deployment.may_influence_production === false && b.surface === "waiver-intelligence-2"));
  const net = bs.find((b) => b.metric === "net_action_value")!;
  assert.equal(net.origin.analysis_class, "SHADOW"); assert.equal(net.predictive!.class, "SHADOW_PREDICTIVE"); assert.equal(net.model_confidence!.source, "WAIVER2");
  assert.ok(net.components!.some((c) => c.key === "gross.starter") && net.components!.some((c) => c.key === "drop_cost") && net.components!.some((c) => c.key === "acquisition_cost") && net.components!.some((c) => c.key === "risk_penalty"));
  assert.equal(net.comparison![0]!.population.id, "MANAGER_CANDIDATE_ACTIONS"); assert.ok(net.uncertainty!.range![0]! <= net.uncertainty!.range![1]!);
  assert.match(net.lineage.content_identity!, /^[0-9a-f]{12}$/); assert.equal(net.lineage.surface_version, "waiver-2.0-shadow-2026.1"); assert.ok((net.lineage.canonical as { scoring_fingerprint: string }).scoring_fingerprint);
  assert.ok(net.lineage.depends_on!.some((d) => d.surface === "role-opportunity" && d.version === "roi:test"));
  assert.equal(net.unit!.kind, "points"); assert.ok(net.limitations.some((l) => /PRIOR_UNVALIDATED/.test(l)));
});
test("all metric families are exposed: horizons, drop cost, uncertainty (with reasons), role, conditional OPP, archetype, lineup delta, pass", () => {
  const bs = waiver2ActionsEvidence(evaluateWaiver2(inp()), M); const metrics = new Set(bs.map((b) => b.metric));
  for (const k of ["net_action_value", "drop_cost", "horizon.next_week", "horizon.next_3", "horizon.ros", "horizon.playoffs", "horizon.stash", "lineup_delta_next_week", "uncertainty.total", "role.persisted_points", "opp.conditional_payoff", "archetype", "realized_vs_opportunity", "pass.recommended"]) assert.ok(metrics.has(k), k);
  const unc = bs.find((b) => b.metric === "uncertainty.total")!; assert.equal(unc.components!.length, 8); assert.ok(unc.components!.every((c) => (c.label ?? "").length > 3 && c.unit!.kind === "fraction"));
  const rva = bs.find((b) => b.metric === "realized_vs_opportunity")!; assert.equal(rva.availability.state, "UNAVAILABLE", "no realized-points evidence supplied: no claim");
  assert.equal(bs.find((b) => b.metric === "pass.recommended")!.category!.raw, "MAKE_A_CLAIM");
});
test("conditional OPP stays CONDITIONAL in evidence: relationship CONDITIONAL_ON, its condition stated, zero weight unless established", () => {
  const bs = waiver2ActionsEvidence(evaluateWaiver2(inp()), M); const opp = bs.filter((b) => b.metric === "opp.conditional_payoff").find((b) => b.origin.analysis_class === "CONDITIONAL" && /condition established/.test(b.limitations.join()))!;
  assert.ok(opp, "the CHI teammate's Out designation establishes the condition for fa1"); assert.ok(opp.relationships!.some((r) => r.type === "CONDITIONAL_ON")); assert.ok(opp.components!.some((c) => c.key === "counted_points" && (c.value as number) > 0));
  const other = bs.filter((b) => b.metric === "opp.conditional_payoff").find((b) => /NOT established|zero weight/.test(b.limitations.join()) || b.availability.state === "UNAVAILABLE"); assert.ok(other);
  assert.match(opp.limitations.join(), /not an injury-probability model/);
});
test("market evidence: FAAB range rungs are FAAB dollars (a currency, never a fraction), competitors are structural, calibration is stated", () => {
  const bs = waiver2MarketEvidence(evaluateWaiver2(inp()), M); assert.deepEqual(bad(bs).slice(0, 5), []);
  const rungs = ["faab.min_useful", "faab.expected_competitive", "faab.aggressive", "faab.walk_away"].map((k) => bs.find((b) => b.metric === k)!); assert.ok(rungs.every((r) => r.unit!.kind === "currency" && r.availability.state === "AVAILABLE"));
  assert.ok(rungs[0]!.value! <= rungs[1]!.value! && rungs[1]!.value! <= rungs[2]!.value! && rungs[2]!.value! <= rungs[3]!.value!); assert.match(rungs[1]!.limitations.join(), /UNCALIBRATED_PRIOR/);
  const comp = bs.find((b) => b.metric === "competitor.need_strength")!; assert.equal(comp.unit!.kind, "fraction"); assert.match(comp.limitations.join(), /intended bid is never inferred/);
  assert.ok(bs.some((b) => b.metric === "scarcity") && bs.some((b) => b.metric === "priority.advice"));
});
test("replacement evidence exposes free-agent replacement, starter baseline, rostered replacement and scarcity per position", () => {
  const bs = waiver2ReplacementEvidence(evaluateWaiver2(inp()), M); assert.deepEqual(bad(bs).slice(0, 5), []);
  for (const pos of ["WR", "RB"]) for (const k of ["free_agent_replacement", "starter_baseline", "rostered_replacement", "scarcity"]) assert.ok(bs.some((b) => b.metric === k && b.subject.id.endsWith(`replacement:${pos}`)), `${pos} ${k}`);
});
test("AVAILABILITY honesty: an uncertified pool is UNAVAILABLE (FREE_AGENT_POOL_UNAVAILABLE) unless an ILLUSTRATIVE view is requested and labelled on every block", () => {
  const unc = evaluateWaiver2(mkWaiverInput({ mine: stdMine(), others: OTHERS, freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }], cert: "UNCERTIFIED_UNROSTERED" }));
  for (const f of [waiver2ActionsEvidence, waiver2MarketEvidence, waiver2ReplacementEvidence]) { const bs = f(unc, M); assert.equal(bs.length, 1); assert.equal(bs[0]!.availability.state, "UNAVAILABLE"); assert.match(bs[0]!.availability.reason!, /FREE_AGENT_POOL_UNAVAILABLE/); assert.equal(bs[0]!.value, undefined); assert.deepEqual(validateEvidenceBlock(bs[0]!), []); }
  const ill = waiver2ActionsEvidence(unc, { ...M, illustrative: true }); assert.ok(ill.length > 5); assert.deepEqual(bad(ill).slice(0, 5), []); assert.ok(ill.every((b) => b.limitations.some((l) => /ILLUSTRATIVE ONLY/.test(l))), "every illustrative block says so");
  const empty = evaluateWaiver2(mkWaiverInput({ mine: stdMine(), others: OTHERS, freeAgents: [] })); assert.equal(waiver2ActionsEvidence(empty, M)[0]!.availability.state, "UNAVAILABLE");
});
test("registered topics: the three waiver2 topics exist in the query layer and the registry declares them (both directions)", () => {
  for (const t of ["waiver2.actions", "waiver2.market", "waiver2.replacement"]) { assert.ok(TOPICS[t], t); assert.equal(TOPICS[t]!.surface, "waiver-intelligence-2"); assert.equal(TOPICS[t]!.cost, "REQUEST_SCOPED_BUILD"); }
  const reg = JSON.parse(readFileSync("docs/intelligence-surface-registry.json", "utf8")); const s = reg.surfaces.find((x: { id: string }) => x.id === "waiver-intelligence-2");
  assert.deepEqual(s.book_ready.query_topics.sort(), ["waiver2.actions", "waiver2.market", "waiver2.replacement"]); assert.equal(s.book_ready.capability_state, "AVAILABLE", "Phase 4.5: the pool is certified by the canonical market state"); assert.match(s.deployment, /SHADOW_ONLY/);
});
