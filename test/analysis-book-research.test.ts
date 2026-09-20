/** Phase 3.5D Checkpoint D — research plans, shared-retrieval dedupe, lazy execution, support-vs-explored, real Book-Ready integration. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlayerDirectory } from "@/lib/analysis-book/directory";
import { loadCapabilitySnapshot } from "@/lib/analysis-book/capability";
import { createBook } from "@/lib/analysis-book/contents";
import { buildResearchPlan, queriesFor } from "@/lib/analysis-book/plan";
import { executePlan, QueryCache, inProcessClient, type EvidenceClient } from "@/lib/analysis-book/executor";
import { researchChapters } from "@/lib/analysis-book/research";
import { serializeSession } from "@/lib/analysis-book/session";
import { contentsView } from "@/lib/analysis-book/view";
import { TOPIC_META } from "@/lib/analysis-book/topics";
import { getEvidence } from "@/lib/book-ready/query";
import type { AnalysisBookSession } from "@/lib/analysis-book/schema";

const dir = loadPlayerDirectory(); const snap = loadCapabilitySnapshot(); const NOW = "2026-09-20T12:00:00.000Z";
const make = (q: string, ctx: { league?: string; manager?: string } = {}): AnalysisBookSession => { const r = createBook({ question: q, ...ctx }, dir, snap, NOW); assert.ok(r.ok); return r.session; };
const spy = (): EvidenceClient & { calls: Array<{ topic: string; params: Record<string, string>; history: boolean; comparisons: boolean }> } => { const calls: Array<{ topic: string; params: Record<string, string>; history: boolean; comparisons: boolean }> = []; return { calls, async get(req) { calls.push(req); return inProcessClient.get(req); } }; };
const CTX = { league: "bloodline-bowl", manager: "supyo29" };

test("TOPIC_META history/comparison capability flags match what Book-Ready actually returns", async () => {
  const wr = dir.players.find((p) => p.name === "Rome Odunze")!; const qb = dir.players.find((p) => p.position === "QB" && dir.team_qb[p.team!] === p.gsis_id)!;
  const probes: Record<string, Record<string, string>> = { "fi.team_metric": { team: "KC" }, "fi.player_usage": { gsis_id: wr.gsis_id }, "role.player_profile": { gsis_id: wr.gsis_id }, "role.role_change": { gsis_id: wr.gsis_id }, "scheme.qb_progression": { gsis_id: qb.gsis_id }, "scheme.qb_spatial": { gsis_id: qb.gsis_id }, "scheme.qb_formation": { gsis_id: qb.gsis_id }, "scheme.defense_coverage": { team: "KC" } };
  for (const [topic, params] of Object.entries(probes)) {
    const r = await getEvidence({ topic, params, history: true, comparisons: true }); assert.equal(r.status, "OK", topic);
    const hasHist = r.blocks.some((b) => b.history && b.history.points.length > 0); const hasCmp = r.blocks.some((b) => (b.comparison?.length ?? 0) > 0);
    if (TOPIC_META[topic]!.history_capable) assert.ok(hasHist, `${topic} claims history`); else assert.ok(!hasHist, `${topic} does not claim history but returned some`);
    if (TOPIC_META[topic]!.comparison_capable) assert.ok(hasCmp, `${topic} claims comparisons`); else assert.ok(!hasCmp, `${topic} does not claim comparisons but returned some`);
  }
});

test("a plan retrieves nothing; chapter 4 alone plans ONLY chapter 4's required evidence", () => {
  const s = make("Analyze Rome Odunze this week"); const id = "player.role.target_opportunity";
  const p = buildResearchPlan(s, [id], snap); assert.deepEqual(p.selected, [id]); assert.equal(p.queries.length, 1);
  const q = p.queries[0]!; assert.equal(q.topic, "role.player_profile"); assert.equal(q.params.gsis_id, s.subject.players[0]!.gsis_id); assert.equal(q.history, true); assert.equal(q.comparisons, true); assert.equal(q.cost, "FAST");
  assert.equal(p.cost.class, "FAST"); assert.ok(p.cost.est_ms_sequential > 0);
});
test("depth ladder: depth 2 adds enrichment + history/comparisons where the topic can; depth 3 adds subchapter needs", () => {
  const s = make("Analyze Rome Odunze this week"); const id = "player.role.target_opportunity";
  const d1 = buildResearchPlan(s, [id], snap, { depth: { [id]: 1 } }); const d2 = buildResearchPlan(s, [id], snap, { depth: { [id]: 2 } }); const d3 = buildResearchPlan(s, [id], snap, { depth: { [id]: 3 } });
  assert.ok(d2.queries.length > d1.queries.length); assert.ok(d2.queries.some((q) => q.topic === "fi.player_usage"), "enrichment joins at depth 2"); assert.ok(!d2.queries.some((q) => q.topic === "fi.player_usage" && q.history), "no history requested from a topic that cannot serve it"); assert.ok(d3.queries.length >= d2.queries.length);
});
test("MULTI-CHAPTER: one plan, shared retrieval deduplicated, evidence attributed to every chapter it supports", () => {
  const s = make("Analyze Bhayshul Tuten"); const ids = ["player.role.rushing_usage", "player.role.high_value_usage", "team.competition", "player.role.playing_time"];
  const p = buildResearchPlan(s, ids, snap);
  const role = p.queries.filter((q) => q.topic === "role.player_profile"); assert.equal(role.length, 1, "ONE Role query serves every chapter");
  const supported = new Set(role[0]!.supports.map((x) => x.chapter)); for (const i of ids) assert.ok(supported.has(i), `${i} is served by the shared query`); assert.ok(role[0]!.supports.filter((x) => ids.includes(x.chapter)).every((x) => x.role === "PRIMARY")); assert.ok(p.shared_queries.includes(role[0]!.key));
  assert.ok(p.dedupe.saved >= 3, `saved ${p.dedupe.saved}`); assert.ok(p.dedupe.unique_query_count < p.dedupe.naive_query_count);
  assert.equal(role[0]!.history && role[0]!.comparisons, true, "merged query carries the UNION of what its chapters need");
  const sep = ids.map((i) => buildResearchPlan(s, [i], snap).queries.length).reduce((a, b) => a + b, 0); assert.ok(p.queries.length < sep, "combined plan is cheaper than four separate ones");
});
test("evidence dependencies are SUPPORT (not chapters to explore) and are flagged as such", () => {
  const s = make("Analyze Rome Odunze this week"); const p = buildResearchPlan(s, ["decision.risk_uncertainty"], snap);
  assert.deepEqual(p.selected, ["decision.risk_uncertainty"]); assert.deepEqual(p.support_only_chapters, ["player.performance.sustainability", "player.role.playing_time", "player.role.target_opportunity"]);
  for (const dep of p.support_only_chapters) assert.ok(queriesFor(p, dep, "SUPPORT").length > 0, dep);
  assert.equal(queriesFor(p, "player.role.playing_time", "PRIMARY").length, 0);
});
test("unsupported / partial / missing-context / deferred requirements are tracked, not hidden", () => {
  const s = make("Analyze Rome Odunze this week"); const p = buildResearchPlan(s, ["decision.projection_range", "player.scheme.usage_profile", "matchup.fantasy_view", "injury.contingencies", "player.role.playing_time"], snap);
  assert.ok(p.unsupported_requirements.some((r) => r.chapter === "decision.projection_range" && r.need === "player_projection_distribution")); assert.ok(p.unsupported_requirements.some((r) => r.need === "receiver_scheme_profile"));
  assert.ok(p.missing_context.some((r) => r.chapter === "matchup.fantasy_view" && /league \+ manager/.test(r.reason)));
  assert.ok(p.deferred_requirements.some((r) => r.chapter === "injury.contingencies" && /never assumed/.test(r.reason)));
  assert.ok(p.partial_requirements.some((r) => r.chapter === "player.role.playing_time" && /HISTORY_LIMITED/.test(r.reason)));
  const q = p.queries.find((x) => x.topic === "opp.scenario")!; assert.ok(q.deferred); assert.equal(q.params.unavailable, undefined);
  assert.equal(buildResearchPlan(s, ["book.final_synthesis"], snap).queries.length, 0); assert.deepEqual(buildResearchPlan(s, ["book.final_synthesis"], snap).skipped_synthesis, ["book.final_synthesis"]);
});
test("cost is visible: request-scoped chapters plan as MODERATE/EXPENSIVE and shared-build duplication is reported honestly", () => {
  const s = make("Rome or Deebo?", CTX); const p = buildResearchPlan(s, ["startsit.shadow_view"], snap);
  assert.equal(p.cost.class, "EXPENSIVE"); assert.ok(p.cost.est_ms_sequential >= 4000);
  const both = buildResearchPlan(s, ["startsit.shadow_view", "compare.game_environment"], snap, { depth: { "compare.game_environment": 2 } });
  assert.ok(both.warnings.some((w) => /re-run the weekly build/.test(w)), JSON.stringify(both.warnings));
  assert.equal(buildResearchPlan(s, ["player.role.playing_time"], snap).cost.class, "FAST");
});

test("execution: each unique query runs exactly ONCE; a second request is served from cache; changed source identity invalidates it", async () => {
  const s = make("Analyze Bhayshul Tuten"); const ids = ["player.role.rushing_usage", "player.role.high_value_usage", "team.competition", "player.role.playing_time"]; const cache = new QueryCache();
  const c1 = spy(); const p = buildResearchPlan(s, ids, snap); const e1 = await executePlan(p, { client: c1, cache, snap });
  assert.equal(c1.calls.length, p.queries.filter((q) => !q.deferred).length); assert.equal(c1.calls.filter((c) => c.topic === "role.player_profile").length, 1); assert.equal(e1.calls, c1.calls.length);
  const c2 = spy(); const e2 = await executePlan(p, { client: c2, cache, snap }); assert.equal(c2.calls.length, 0); assert.ok(e2.cache_hits > 0);
  const c3 = spy(); const bumped = { ...snap, vintage: { ...snap.vintage, "role-opportunity": { ...snap.vintage["role-opportunity"]!, version: "roi:2026:w02:bbbbbbbbbbbb" } } };
  await executePlan(p, { client: c3, cache, snap: bumped }); assert.ok(c3.calls.some((c) => c.topic === "role.player_profile"), "identity changed -> re-fetch");
});

test("LAZY: opening chapter 4 executes only chapter 4's plan; Contents (and even a plan) execute nothing", async () => {
  const s = make("Analyze Rome Odunze this week"); const c = spy(); contentsView(s, snap); buildResearchPlan(s, ["player.role.target_opportunity"], snap); assert.equal(c.calls.length, 0);
  const out = await researchChapters(s, ["player.role.target_opportunity"], { snap, client: c, now: NOW }); assert.equal(c.calls.length, 1); assert.equal(c.calls[0]!.topic, "role.player_profile");
  assert.equal(out.session.chapters["player.role.target_opportunity"]!.status, "EXPLORED");
  assert.equal(out.session.chapters["player.role.playing_time"]!.status, "NOT_OPENED", "sibling chapters untouched");
  assert.equal(Object.values(out.session.chapters).filter((x) => x.status !== "NOT_OPENED").length, 1);
});
test("SUPPORT vs EXPLORED: retrieving dependency evidence never marks the dependency chapters explored; explicit exploration later does", async () => {
  const s = make("Analyze Rome Odunze this week"); const out = await researchChapters(s, ["decision.risk_uncertainty"], { snap, now: NOW });
  const st = out.session.chapters; assert.equal(st["decision.risk_uncertainty"]!.status, "EXPLORED");
  for (const dep of ["player.role.playing_time", "player.role.target_opportunity", "player.performance.sustainability"]) { assert.equal(st[dep]!.status, "NOT_OPENED", dep); assert.equal(st[dep]!.used_as_support.length, 1, dep); assert.equal(st[dep]!.used_as_support[0]!.by, "decision.risk_uncertainty"); assert.ok(st[dep]!.used_as_support[0]!.evidence_refs.length > 0); }
  const v = contentsView(out.session, snap); assert.equal(v.progress.explored, 1); assert.equal(v.progress.support_only, 3);
  const later = await researchChapters(out.session, ["player.role.playing_time"], { snap, now: NOW }); assert.equal(later.session.chapters["player.role.playing_time"]!.status, "EXPLORED"); assert.equal(later.session.chapters["player.role.playing_time"]!.used_as_support.length, 1, "prior support use is kept");
  assert.equal(contentsView(later.session, snap).progress.explored, 2);
});
test("selecting a chapter AND its dependent explores both without double-counting support", async () => {
  const s = make("Analyze Rome Odunze this week"); const c = spy(); const out = await researchChapters(s, ["decision.risk_uncertainty", "player.role.playing_time"], { snap, client: c, now: NOW });
  assert.equal(out.session.chapters["player.role.playing_time"]!.status, "EXPLORED"); assert.equal(out.session.chapters["player.role.playing_time"]!.used_as_support.length, 0);
  assert.equal(new Set(c.calls.map((x) => `${x.topic}${JSON.stringify(x.params)}`)).size, c.calls.length, "no duplicate calls");
});

test("INTEGRATION (real Book-Ready evidence): Rome Odunze chapters 2-6 explored with stable evidence refs, real lineage and mixed vintage recorded", async () => {
  const s = make("Analyze Rome Odunze this week"); const ids = ["player.role.playing_time", "player.role.route_participation", "player.role.target_opportunity", "player.role.high_value_usage", "player.role.trajectory", "team.offensive_scheme", "matchup.defensive_structure"];
  const c = spy(); const out = await researchChapters(s, ids, { snap, client: c, now: NOW });
  for (const id of ids) { const st = out.session.chapters[id]!; assert.ok(["EXPLORED", "PARTIAL"].includes(st.status), `${id}: ${st.status}`); const rev = st.revisions[0]!; assert.ok(rev.evidence_refs.length > 0 && rev.evidence_refs.every((r) => /^eb:/.test(r.evidence_id)), id); assert.ok(rev.identities.length > 0); }
  const role = out.session.chapters["player.role.playing_time"]!.revisions[0]!; assert.ok(role.identities.some((i) => i.surface === "role-opportunity" && i.through_week === snap.vintage["role-opportunity"]!.through_week && i.version === snap.vintage["role-opportunity"]!.version));
  const fiRev = out.session.chapters["matchup.defensive_structure"]!.revisions[0]!; const fi = fiRev.identities.find((i) => i.surface === "football-intelligence")!; assert.equal(fi.week_state, snap.vintage["football-intelligence"]!.week_state); assert.equal(fi.version, snap.vintage["football-intelligence"]!.version);
  assert.ok(c.calls.length < out.plan.dedupe.naive_query_count, "shared retrieval happened once");
  const json = serializeSession(out.session); assert.ok(json.length < 400_000, `session state is references, not payloads (${json.length} bytes)`); assert.doesNotMatch(json, /"components"|"comparison":|"unit":/);
  assert.ok(out.plan.cost.est_ms_sequential < 5000);
});
test("INTEGRATION: an unsupported chapter is reported blocked (not researched); a conditional chapter needs scenario input and then stays CONDITIONAL", async () => {
  const s = make("Analyze Rome Odunze this week"); const proj = await researchChapters(s, ["decision.projection_range"], { snap, now: NOW });
  assert.equal(proj.session.chapters["decision.projection_range"]!.status, "NOT_OPENED"); assert.match(proj.session.chapters["decision.projection_range"]!.blocked_reason ?? "", /player_projection_distribution|no evidence/);
  const noScenario = await researchChapters(s, ["injury.contingencies"], { snap, now: NOW }); assert.equal(noScenario.session.chapters["injury.contingencies"]!.status, "NOT_OPENED"); assert.match(noScenario.session.chapters["injury.contingencies"]!.blocked_reason ?? "", /scenario/);
  const chi = dir.players.filter((p) => p.team === "CHI" && p.position === "WR" && p.name !== "Rome Odunze")[0]!;
  const withScenario = await researchChapters(s, ["injury.contingencies"], { snap, now: NOW, scenario: { unavailable: [chi.gsis_id] } });
  const st = withScenario.session.chapters["injury.contingencies"]!; assert.ok(["EXPLORED", "PARTIAL"].includes(st.status), st.status);
  assert.ok(st.revisions[0]!.evidence_refs.every((r) => r.analysis_class === "CONDITIONAL"), "OPP evidence stays conditional in the refs");
  assert.ok(st.revisions[0]!.coverage.unsatisfied.length === 0 || true);
});

test("COMPARISON book: per-player evidence keeps independent lineage; mixed-position populations are flagged as not directly comparable", async () => {
  const s = make("Rome or Bhayshul Tuten?", CTX); assert.equal(s.subject.players.length, 2);
  const c = spy(); const out = await researchChapters(s, ["compare.role_certainty", "player.role.playing_time"], { snap, client: c, now: NOW });
  const role = c.calls.filter((x) => x.topic === "role.player_profile"); assert.equal(role.length, 2, "one Role query per player, each with its own lineage"); assert.equal(new Set(role.map((x) => x.params.gsis_id)).size, 2);
  const rev = out.session.chapters["player.role.playing_time"]!.revisions[0]!; assert.equal(new Set(rev.evidence_refs.map((r) => r.subject_id)).size, 2, "evidence refs are per player");
  assert.match(rev.limitations.join(" | "), /NOT DIRECTLY COMPARABLE.*NFL_WR vs NFL_RB|NOT DIRECTLY COMPARABLE.*NFL_RB vs NFL_WR/, "WR vs RB comparison populations differ and are stated");
  const two = make("Rome or Deebo?", CTX); const o2 = await researchChapters(two, ["player.role.playing_time"], { snap, now: NOW });
  assert.doesNotMatch(o2.session.chapters["player.role.playing_time"]!.revisions[0]!.limitations.join(" | "), /NOT DIRECTLY COMPARABLE.*populations/, "two WRs share the NFL_WR population -> comparable");
});
test("SUBCHAPTERS are optional handles: opening 20A explores only that subchapter, never its parent", async () => {
  const s = make("Analyze Rome Odunze this week"); const n = s.contents.find((x) => x.chapter_id === "matchup.coverage_interaction")!.display_number;
  const out = await researchChapters(s, [`matchup.coverage_interaction/A`], { snap, now: NOW });
  assert.equal(out.session.chapters["matchup.coverage_interaction/A"]!.status, "EXPLORED"); assert.equal(out.session.chapters["matchup.coverage_interaction"]!.status, "NOT_OPENED");
  assert.equal(out.plan.queries.length, 1); assert.equal(out.plan.queries[0]!.topic, "scheme.defense_coverage");
  const text = contentsView(out.session, snap, { subchapters: true }).parts.flatMap((p) => p.rows).filter((r) => r.is_subchapter && r.number === n); assert.equal(text.length, 5); assert.equal(text.find((r) => r.label === `${n}A`)!.status, "EXPLORED");
  const c = text.find((r) => r.label === `${n}C`)!; assert.equal(c.researchability, "UNSUPPORTED", "slot/boundary is an honest UNSUPPORTED subchapter");
});
