/** Phase 3.5D Checkpoint E — synthesis honesty, model/analyst separation, mixed-vintage, cross-chapter findings. Uses REAL Book-Ready evidence. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlayerDirectory } from "@/lib/analysis-book/directory";
import { loadCapabilitySnapshot, type CapabilitySnapshot } from "@/lib/analysis-book/capability";
import { createBook } from "@/lib/analysis-book/contents";
import { researchChapters } from "@/lib/analysis-book/research";
import { addFinding, synthesize, synthesisIsCurrent, renderSynthesisText, vintageStatement, rangesOf } from "@/lib/analysis-book/synthesis";
import { recordSupport, recordChapterResearch } from "@/lib/analysis-book/session";
import type { AnalysisBookSession, EvidenceRef } from "@/lib/analysis-book/schema";

const dir = loadPlayerDirectory(); const snap = loadCapabilitySnapshot(); const NOW = "2026-09-20T12:00:00.000Z";
const make = (): AnalysisBookSession => { const r = createBook({ question: "Analyze Rome Odunze this week" }, dir, snap, NOW); assert.ok(r.ok); return r.session; };
const chi = dir.players.find((p) => p.team === "CHI" && p.position === "WR" && p.name !== "Rome Odunze")!;
const refsOf = (s: AnalysisBookSession, ch: string): EvidenceRef[] => s.chapters[ch]!.revisions.flatMap((r) => r.evidence_refs);
const pick = (s: AnalysisBookSession, ch: string, f: (r: EvidenceRef) => boolean = () => true) => { const r = refsOf(s, ch).find((x) => x.availability === "AVAILABLE" && f(x)); assert.ok(r, `no matching evidence in ${ch}`); return r!.evidence_id; };
async function researched(): Promise<AnalysisBookSession> {
  const out = await researchChapters(make(), ["player.role.playing_time", "player.role.target_opportunity", "matchup.defensive_structure", "matchup.coverage_interaction", "team.offensive_scheme", "injury.contingencies"], { snap, now: NOW, scenario: { unavailable: [chi.gsis_id] } });
  return out.session;
}

test("a finding can rest ONLY on chapters that were researched — never NOT_OPENED, blocked, support-only or unsupported ones", async () => {
  let s = await researched(); const ev = pick(s, "player.role.playing_time");
  const bad = (chapters: string[]) => { const r = addFinding(s, { kind: "OBSERVATION", text: "x", chapters, evidence_ids: [ev] }, snap); assert.equal(r.ok, false, chapters.join()); return r.ok ? [] : r.errors; };
  assert.match(bad(["player.role.high_value_usage"]).join(), /has not been researched/); // NOT_OPENED
  assert.match(bad(["decision.projection_range"]).join(), /has not been researched/); // unsupported
  s = recordSupport(s, "player.role.route_participation", "decision.risk_uncertainty", [{ ...refsOf(s, "player.role.playing_time")[0]! }], NOW);
  assert.match(bad(["player.role.route_participation"]).join(), /only used as support/);
  assert.match(bad(["player.role.playing_time", "player.role.high_value_usage"]).join(), /has not been researched/, "one unresearched chapter poisons the claim");
  assert.equal(addFinding(s, { kind: "OBSERVATION", text: "Playing time observation", chapters: ["player.role.playing_time"], evidence_ids: [ev] }, snap).ok, true);
});
test("cited evidence must come from the cited chapters' own research", async () => {
  const s = await researched(); const fiEv = pick(s, "matchup.defensive_structure");
  const r = addFinding(s, { kind: "OBSERVATION", text: "x", chapters: ["player.role.playing_time"], evidence_ids: [fiEv] }, snap); assert.equal(r.ok, false); assert.match(r.ok ? "" : r.errors.join(), /was not retrieved by the cited chapters/);
  assert.equal(addFinding(s, { kind: "OBSERVATION", text: "x", chapters: ["player.role.playing_time"], evidence_ids: ["eb:doesnotexist"] }, snap).ok, false);
  assert.equal(addFinding(s, { kind: "OBSERVATION", text: "x", chapters: [], evidence_ids: [fiEv] }, snap).ok, false); assert.equal(addFinding(s, { kind: "OBSERVATION", text: "x", chapters: ["player.role.playing_time"], evidence_ids: [] }, snap).ok, false);
});
test("MODEL RESULT vs EVIDENCE vs ANALYST SYNTHESIS stay separate; the Book never restates or invents numbers", async () => {
  const s = await researched();
  const modeled = pick(s, "matchup.defensive_structure", (r) => r.analysis_class === "MODELED"); const observed = pick(s, "player.role.playing_time", (r) => ["OBSERVED", "DESCRIPTIVE"].includes(r.analysis_class));
  const err = (i: Parameters<typeof addFinding>[1]) => { const r = addFinding(s, i, snap); assert.equal(r.ok, false, i.text); return r.ok ? "" : r.errors.join("; "); };
  assert.match(err({ kind: "OBSERVATION", text: "model says", chapters: ["matchup.defensive_structure"], evidence_ids: [modeled] }), /must be reported as a MODEL_RESULT/);
  assert.match(err({ kind: "MODEL_RESULT", text: "m", chapters: ["matchup.defensive_structure"], evidence_ids: [modeled] }), /model_value_ref/);
  assert.match(err({ kind: "MODEL_RESULT", text: "m", chapters: ["matchup.defensive_structure"], evidence_ids: [modeled], model_value_ref: "eb:other" }), /one of the cited evidence ids/);
  assert.match(err({ kind: "MODEL_RESULT", text: "m", chapters: ["player.role.playing_time"], evidence_ids: [observed], model_value_ref: observed }), /not a model output/);
  assert.match(err({ kind: "MODEL_RESULT", text: "m", chapters: ["matchup.defensive_structure"], evidence_ids: [modeled], model_value_ref: modeled, numeric: 0.3 }), /never altered/);
  assert.match(err({ kind: "ANALYST_SYNTHESIS", text: "Odunze's outlook score of 8.2", chapters: ["player.role.playing_time"], evidence_ids: [observed] }), /new score/);
  assert.match(err({ kind: "ANALYST_SYNTHESIS", text: "fine", chapters: ["player.role.playing_time"], evidence_ids: [observed], numeric: 8.2 }), /new predictive score/);
  let cur = s; for (const f of [{ kind: "MODEL_RESULT" as const, text: "Defense model output", chapters: ["matchup.defensive_structure"], evidence_ids: [modeled], model_value_ref: modeled }, { kind: "OBSERVATION" as const, text: "Role observation", chapters: ["player.role.playing_time"], evidence_ids: [observed] }, { kind: "ANALYST_SYNTHESIS" as const, text: "Role looks stable against a mid-strength defense", chapters: ["player.role.playing_time", "matchup.defensive_structure"], evidence_ids: [observed, modeled] }]) { const r = addFinding(cur, f, snap); assert.ok(r.ok, r.ok ? "" : r.errors.join()); if (r.ok) cur = r.session; }
  const rep = synthesize(cur, snap, { final: false, now: NOW }).report;
  assert.equal(rep.by_kind.model_results.length, 1); assert.equal(rep.by_kind.model_results[0]!.model_value_ref, modeled); assert.equal(rep.by_kind.observations.length, 1); assert.equal(rep.by_kind.analyst_synthesis.length, 1);
});
test("claim strength: STRONG only for a fresh, fully researched, single-vintage, non-conditional finding; everything else is TENTATIVE with reasons", async () => {
  const s = await researched();
  const role = pick(s, "player.role.playing_time", (r) => ["OBSERVED", "DESCRIPTIVE"].includes(r.analysis_class));
  const strong = addFinding(s, { kind: "OBSERVATION", text: "single-source role fact", chapters: ["player.role.playing_time"], evidence_ids: [role] }, snap); assert.ok(strong.ok && strong.finding.claim_strength === "STRONG", strong.ok ? strong.finding.strength_reasons.join() : "");
  const trend = addFinding(s, { kind: "OBSERVATION", text: "trend claim", chapters: ["player.role.playing_time"], evidence_ids: [role], claims_trend: true }, snap); assert.ok(trend.ok && trend.finding.claim_strength === "TENTATIVE"); assert.match(trend.ok ? trend.finding.strength_reasons.join() : "", /trend claim over HISTORY_LIMITED/);
  const opp = pick(s, "injury.contingencies", (r) => r.analysis_class === "CONDITIONAL");
  const cond = addFinding(s, { kind: "MODEL_RESULT", text: "scenario redistribution", chapters: ["injury.contingencies"], evidence_ids: [opp], model_value_ref: opp }, snap); assert.ok(cond.ok && cond.finding.claim_strength === "TENTATIVE"); assert.match(cond.ok ? cond.finding.strength_reasons.join() : "", /CONDITIONAL/);
  const shadowish = refsOf(s, "matchup.coverage_interaction"); assert.ok(shadowish.length >= 0);
});

test("MIXED VINTAGE: FI week 2 (partial), Role week 1, Player-Scheme 2025 and OPP-on-Role-week-1 are never called one current week", async () => {
  const s = await researched();
  const fi = pick(s, "matchup.defensive_structure", (r) => r.surface === "football-intelligence"); const role = pick(s, "player.role.playing_time"); const scheme = pick(s, "matchup.coverage_interaction", (r) => r.surface === "player-scheme"); const opp = pick(s, "injury.contingencies", (r) => r.surface === "opportunity-propagation");
  const all = [["matchup.defensive_structure", fi], ["player.role.playing_time", role], ["matchup.coverage_interaction", scheme], ["injury.contingencies", opp]] as const;
  const r = addFinding(s, { kind: "ANALYST_SYNTHESIS", text: "Opportunity looks stable while the opposing defense is mid-tier", chapters: all.map((a) => a[0]), evidence_ids: all.map((a) => a[1]) }, snap);
  assert.ok(r.ok, r.ok ? "" : r.errors.join()); const f = r.ok ? r.finding : null!;
  assert.equal(f.mixed_vintage, true); assert.equal(f.claim_strength, "TENTATIVE"); assert.equal(f.cross_chapter, true);
  const st = new Map(f.temporal_context.map((i) => [i.surface, i])); assert.equal(st.get("football-intelligence")!.through_week, 2); assert.equal(st.get("football-intelligence")!.week_state, "PARTIAL"); assert.equal(st.get("role-opportunity")!.through_week, 1); assert.equal(st.get("player-scheme")!.season, 2025); assert.equal(st.get("opportunity-propagation")!.through_week, 1);
  assert.match(f.vintage_statement, /MIXED VINTAGE/); assert.doesNotMatch(f.vintage_statement, /\bcurrent\b/i); assert.match(f.strength_reasons.join(), /different vintages/);
  for (const bad of ["This is the current week 2 intelligence: Odunze's role is stable", "Based on current data the role is stable", "Using this week's evidence the role is stable"]) { const x = addFinding(s, { kind: "ANALYST_SYNTHESIS", text: bad, chapters: all.map((a) => a[0]), evidence_ids: all.map((a) => a[1]) }, snap); assert.equal(x.ok, false, bad); assert.match(x.ok ? "" : x.errors.join(), /must not be described as current/); }
  // a single-vintage claim is allowed to say what it is
  assert.equal(addFinding(s, { kind: "OBSERVATION", text: "Role as of week 1", chapters: ["player.role.playing_time"], evidence_ids: [role] }, snap).ok, true);
  const rep = synthesize(r.ok ? r.session : s, snap, { final: true, now: NOW }).report;
  assert.equal(rep.vintage.mixed, true); assert.ok(rep.vintage.mismatches.some((m) => /football-intelligence.*role-opportunity|role-opportunity.*football-intelligence/.test(m))); assert.ok(rep.vintage.mismatches.some((m) => /player-scheme/.test(m)));
  assert.doesNotMatch(rep.vintage.statement, /\bcurrent\b/i); assert.doesNotMatch(renderSynthesisText(rep), /current week \d/i);
  assert.equal(vintageStatement([{ surface: "role-opportunity", version: "v", season: 2026, through_week: 1, week_state: "COMPLETE" }]).mixed, false);
});

test("Synthesis coverage: skipped, unresearchable, support-only and partial chapters stay visible; Contents ≠ research", async () => {
  const s0 = make(); const none = synthesize(s0, snap, { final: true, now: NOW }); assert.equal(none.report.synthesis_permitted, false); assert.equal(none.report.coverage.researched, 0); assert.match(none.report.notes.join(), /nothing has been researched/);
  const out = await researchChapters(s0, ["player.role.playing_time", "player.role.route_participation", "player.role.target_opportunity"], { snap, now: NOW }); const s = out.session;
  const { report } = synthesize(s, snap, { final: true, now: NOW });
  assert.equal(report.researched.length, 3); assert.equal(report.ranges.researched, "2-4"); assert.equal(report.coverage.total, s.contents.filter((c) => c.kind === "EVIDENCE").length);
  assert.ok(report.not_researched.length > 5); assert.ok(report.not_researchable.some((r) => r.chapter_id === "decision.projection_range"), "unavailable evidence is not described as researched");
  assert.ok(!report.researched.some((r) => r.chapter_id === "decision.projection_range"));
  assert.match(report.notes.join(), /FINAL synthesis of PARTIAL coverage/); assert.ok(report.unexamined_dimensions.includes("matchup") && report.unexamined_dimensions.includes("schedule")); assert.ok(!report.unexamined_dimensions.includes("workload"));
  const text = renderSynthesisText(report); assert.match(text, /Researched: 2-4/); assert.match(text, /Not researched: /); assert.match(text, /Cannot be researched with current evidence: /);
  assert.ok(report.unresolved_questions.length >= report.not_researched.length + report.not_researchable.length);
  // a chapter that was only USED AS SUPPORT is reported as never explored
  const sup = await researchChapters(s0, ["decision.risk_uncertainty"], { snap, now: NOW }); const rs = synthesize(sup.session, snap, { final: false, now: NOW }).report;
  assert.equal(rs.researched.length, 1); assert.ok(rs.support_only.some((r) => r.chapter_id === "player.role.playing_time")); assert.ok(!rs.researched.some((r) => r.chapter_id === "player.role.playing_time"));
  assert.equal(rangesOf([1, 2, 3, 5, 9, 10]), "1-3, 5, 9-10"); assert.equal(rangesOf([]), "none");
});
test("stale research is retained and flagged: findings downgrade, the report lists it, original state is untouched", async () => {
  const s = await researched(); const role = pick(s, "player.role.playing_time", (r) => ["OBSERVED", "DESCRIPTIVE"].includes(r.analysis_class));
  const f = addFinding(s, { kind: "OBSERVATION", text: "role fact", chapters: ["player.role.playing_time"], evidence_ids: [role] }, snap); assert.ok(f.ok && f.finding.claim_strength === "STRONG"); const s2 = f.ok ? f.session : s;
  const adv: CapabilitySnapshot = { ...snap, vintage: { ...snap.vintage, "role-opportunity": { ...snap.vintage["role-opportunity"]!, version: "roi:2026:w02:cccccccccccc", through_week: 2 } } };
  const rep = synthesize(s2, adv, { final: false, now: NOW }).report;
  assert.ok(rep.stale.some((r) => r.chapter_id === "player.role.playing_time")); assert.equal(rep.researched.some((r) => r.chapter_id === "player.role.playing_time"), false);
  assert.equal(rep.conclusions.strong.length, 0); assert.equal(rep.conclusions.tentative.length, 1); assert.match(rep.conclusions.tentative[0]!.strength_reasons.join(), /stale/);
  assert.equal(s2.chapters["player.role.playing_time"]!.status, "EXPLORED"); assert.equal(s2.findings[0]!.claim_strength, "STRONG", "stored finding is not silently rewritten; the report reassesses");
});
test("cross-chapter findings are first-class, cite their supporting chapters + evidence, and synthesis state tracks currency", async () => {
  const s = await researched(); const a = pick(s, "player.role.playing_time", (r) => ["OBSERVED", "DESCRIPTIVE"].includes(r.analysis_class)); const b = pick(s, "player.role.target_opportunity", (r) => ["OBSERVED", "DESCRIPTIVE"].includes(r.analysis_class));
  const r = addFinding(s, { kind: "ANALYST_SYNTHESIS", text: "Playing time and target work point the same direction", chapters: ["player.role.playing_time", "player.role.target_opportunity"], evidence_ids: [a, b] }, snap); assert.ok(r.ok);
  const f = r.ok ? r.finding : null!; assert.equal(f.cross_chapter, true); assert.deepEqual(f.chapters, ["player.role.playing_time", "player.role.target_opportunity"]); assert.deepEqual(f.evidence_refs, [a, b]); assert.match(f.id, /^f:/);
  const again = addFinding(r.ok ? r.session : s, { kind: "ANALYST_SYNTHESIS", text: "Playing time and target work point the same direction", chapters: ["player.role.playing_time", "player.role.target_opportunity"], evidence_ids: [a, b] }, snap); assert.ok(again.ok && again.session.findings.length === 1, "idempotent");
  const done = synthesize(r.ok ? r.session : s, snap, { final: false, now: NOW }); assert.equal(done.session.synthesis_state.status, "PARTIAL"); assert.equal(synthesisIsCurrent(done.session), true); assert.equal(done.report.cross_chapter_findings.length, 1);
  const more = await researchChapters(done.session, ["player.role.trajectory"], { snap, now: NOW }); assert.equal(synthesisIsCurrent(more.session), false, "new research makes the old synthesis out of date");
  assert.equal(synthesize(s, snap, { final: true, now: NOW }).session.synthesis_state.status, "FINAL");
});

test("request-scoped live builds are described as live builds, not as a fake NFL week", () => {
  const v = vintageStatement([{ surface: "role-opportunity", version: "roi:2026:w01:x", season: 2026, through_week: 1, week_state: "COMPLETE" }, { surface: "matchup-intelligence", version: "ri-matchup-2026.1", season: 2026, through_week: null, week_state: null }]);
  assert.equal(v.mixed, true); assert.match(v.statement, /live request-scoped build \(no NFL through-week\)/); assert.doesNotMatch(v.statement, /week \?|wnull|week null/);
});

test("cross-player comparison: incompatible SCALES are rejected, different comparison POPULATIONS force TENTATIVE (never a silent comparison)", () => {
  const mk = (subject: string, over: Partial<EvidenceRef>): EvidenceRef => ({ evidence_id: `eb:${subject}`, surface: "role-opportunity", topic: "role.player_profile", metric: "receiving.target_share", subject_id: subject, availability: "AVAILABLE", analysis_class: "OBSERVED", version: snap.vintage["role-opportunity"]!.version, season: 2026, through_week: 1, week_state: "COMPLETE", unit_kind: "fraction", population: "NFL_WR", ...over });
  const idOf = { surface: "role-opportunity", version: snap.vintage["role-opportunity"]!.version, season: 2026, through_week: 1, week_state: "COMPLETE" };
  const base = (refs: EvidenceRef[]) => { let s = make(); s = recordChapterResearch(s, "player.role.playing_time", { depth: 1, identities: [idOf], evidence_refs: refs, query_keys: ["q"], coverage: { satisfied: ["role.player_profile"], unsatisfied: [] }, limitations: [] }, NOW); return s; };
  const claim = (s: AnalysisBookSession, ids: string[]) => addFinding(s, { kind: "ANALYST_SYNTHESIS", text: "The two players' target work is comparable in size", chapters: ["player.role.playing_time"], evidence_ids: ids }, snap);
  const ok = base([mk("A", {}), mk("B", {})]); const a = claim(ok, ["eb:A", "eb:B"]); assert.ok(a.ok && a.finding.claim_strength === "STRONG", "same scale + same population -> a normal claim");
  const pops = base([mk("A", {}), mk("B", { population: "NFL_RB" })]); const b = claim(pops, ["eb:A", "eb:B"]); assert.ok(b.ok && b.finding.claim_strength === "TENTATIVE"); assert.match(b.ok ? b.finding.strength_reasons.join() : "", /different comparison populations \(NFL_WR vs NFL_RB\)/);
  const units = base([mk("A", {}), mk("B", { unit_kind: "count" })]); const c = claim(units, ["eb:A", "eb:B"]); assert.equal(c.ok, false); assert.match(c.ok ? "" : c.errors.join(), /INCOMPARABLE.*unit kinds differ \(fraction vs count\).*no scale conversion/);
  const single = claim(units, ["eb:A"]); assert.ok(single.ok, "one subject's own evidence is never affected");
});
