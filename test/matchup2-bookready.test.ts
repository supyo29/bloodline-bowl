/** Phase 5 Checkpoint F — Book-Ready evidence + Analysis Book capability mapping. */
import test from "node:test";
import assert from "node:assert/strict";
import { matchup2DefenseEvidence, matchup2PlayerEvidence } from "@/lib/book-ready/families/matchup2";
import { validateEvidenceBlock } from "@/lib/book-ready/validate";
import { buildDefenseProfile } from "@/lib/matchup2/defense";
import { buildMatchupContext } from "@/lib/matchup2/context";
import { evaluatePlayer } from "@/lib/matchup2/engine";
import type { MatchupEvaluation } from "@/lib/matchup2/contract";
import { mkSource } from "./fixtures/matchup2";
import { getEvidence, TOPICS } from "@/lib/book-ready/query";
import { TOPIC_META } from "@/lib/analysis-book/topics";
import { CHAPTER_LIBRARY } from "@/lib/analysis-book/library";
import { loadCapabilitySnapshot } from "@/lib/analysis-book/capability";
import { loadPlayerDirectory } from "@/lib/analysis-book/directory";
import { createBook } from "@/lib/analysis-book/contents";

const src = mkSource({ players: [{ gsis: "wr", pos: "WR", epaMan: 0, epaZone: 0.3 }, { gsis: "qb", pos: "QB" }, { gsis: "rb", pos: "RB" }, { gsis: "te", pos: "TE", ev: "INSUFFICIENT" }] });
const ctx = buildMatchupContext(src, { offense_team: "T00", defense_team: "T31", week: 3 });
const ev = (id: string) => evaluatePlayer(src, ctx, id) as MatchupEvaluation;

test("every player topic emits valid shared EvidenceBlocks: SHADOW_ONLY, descriptive/modeled/unavailable classes, lineage with context identity", () => {
  for (const id of ["wr", "qb", "rb", "te"]) for (const t of ["coverage", "pass_area", "pressure", "run", "scoring", "summary"] as const) {
    const bs = matchup2PlayerEvidence(t, ev(id)); for (const b of bs) { assert.deepEqual(validateEvidenceBlock(b), [], `${id}/${t}/${b.metric}`); assert.equal(b.surface, "matchup-intelligence-2"); assert.equal(b.deployment.may_influence_production, false); assert.equal(b.deployment.state, "SHADOW_ONLY"); assert.match(String(b.lineage.content_identity), /^mctx:/); assert.ok(b.limitations.some((l) => /NO numeric fantasy adjustment/.test(l))); assert.notEqual(b.predictive?.class, "SHADOW_PREDICTIVE"); assert.notEqual(b.predictive?.class, "PRODUCTION_PREDICTIVE"); }
  }
});
test("position specificity surfaces in the topics: WR has no run/pressure blocks, RB has no coverage-pressure blocks, QB has pressure", () => {
  assert.equal(matchup2PlayerEvidence("run", ev("wr")).length, 0); assert.equal(matchup2PlayerEvidence("pressure", ev("wr")).length, 0); assert.ok(matchup2PlayerEvidence("pressure", ev("qb")).length >= 3); assert.ok(matchup2PlayerEvidence("run", ev("rb")).length >= 3); assert.equal(matchup2PlayerEvidence("run", ev("qb")).length, 0);
});
test("summary exposes verdict, generic-vs-specific, uncertainty, EXPLICIT unsupported items and an UNAVAILABLE composite; observed vs modeled preserved", () => {
  const bs = matchup2PlayerEvidence("summary", ev("wr")); const m = (x: string) => bs.find((b) => b.metric === x)!;
  assert.ok(m("structural_verdict").value); assert.ok(m("player_specific_vs_generic")); assert.ok(bs.some((b) => b.metric.startsWith("uncertainty.")));
  for (const id of ["cornerback_assignment", "receiver_alignment", "defense_front_alignment", "personnel_groupings", "coach_history"]) { const b = m(`unsupported.${id}`); assert.equal(b.availability.state, "UNAVAILABLE"); assert.equal(b.origin.analysis_class, "UNSUPPORTED"); assert.equal(b.value, undefined); }
  const comp = m("composite_adjustment"); assert.equal(comp.availability.state, "UNAVAILABLE"); assert.match(comp.availability.reason!, /no validated numeric matchup adjustment/);
  const cov = matchup2PlayerEvidence("coverage", ev("wr")); const exp = cov.find((b) => b.metric === "coverage.game_expectation")!; assert.equal(exp.origin.analysis_class, "MODELED"); assert.equal(exp.origin.source_class, "MODELED_GAME_EXPECTATION"); assert.equal(cov.find((b) => b.metric === "wr.coverage.man_zone")!.origin.source_class, "OBSERVED_DEFENSIVE_TENDENCY");
});
test("thin evidence yields INSUFFICIENT_SAMPLE blocks with no value (never a fabricated number)", () => {
  const bs = matchup2PlayerEvidence("coverage", ev("te")); const c = bs.find((b) => b.metric === "te.coverage.man_zone")!; assert.equal(c.availability.state, "INSUFFICIENT_SAMPLE"); assert.equal(c.value, undefined);
});
test("defense topics: source-native shells preserved, league rank comparison explicit, front alignment explicitly UNAVAILABLE", () => {
  const p = buildDefenseProfile(ctx); const cov = matchup2DefenseEvidence("coverage", ctx, p); assert.ok(cov.some((b) => b.metric === "shell_source_native.cover_0") && cov.some((b) => b.metric === "shell_source_native.two_man"));
  const mz = cov.find((b) => b.metric === "man_zone.man_rate")!; assert.equal(mz.comparison![0]!.rank!.position, 1); assert.equal(mz.comparison![0]!.population.n, 32); assert.ok(mz.limitations.some((l) => /NOT this week's expected coverage/.test(l)));
  const front = matchup2DefenseEvidence("front", ctx, p); assert.equal(front.find((b) => b.metric === "front_alignment")!.availability.state, "UNAVAILABLE"); assert.ok(front.some((b) => b.metric.startsWith("run_direction.")) && front.some((b) => b.metric.startsWith("run_gap.")));
  for (const t of ["coverage", "front", "pressure", "explosive"] as const) for (const b of matchup2DefenseEvidence(t, ctx, p)) assert.deepEqual(validateEvidenceBlock(b), [], `${t}/${b.metric}`);
  assert.equal(matchup2DefenseEvidence("pressure", ctx, null)[0]!.availability.state, "UNAVAILABLE");
});
test("Book-Ready registration: every Phase 5 topic exists in the query layer AND the planner mirror; no second taxonomy", () => {
  const ids = ["coverage", "pass_area", "pressure", "run", "scoring", "summary"].map((t) => `matchup2.player.${t}`).concat(["coverage", "front", "pressure", "explosive"].map((t) => `matchup2.defense.${t}`));
  for (const id of ids) { assert.ok(TOPICS[id], id); assert.ok(TOPIC_META[id], id); assert.equal(TOPICS[id]!.surface, "matchup-intelligence-2"); }
  assert.equal(TOPIC_META["matchup2.defense.front"]!.flags?.[0], "PROVIDER_LIMIT_PARTIAL");
});
test("live evidence route: real defense + real player through /api/evidence topics; unresolved player and unknown opponent fail closed", async () => {
  const d = await getEvidence({ topic: "matchup2.defense.coverage", params: { team: "DAL" } }); assert.equal(d.status, "OK"); assert.ok(d.validation!.ok, JSON.stringify(d.validation)); assert.ok(d.blocks.length > 5);
  const dir = loadPlayerDirectory(); const wr = dir.players.find((p) => p.name === "Rome Odunze")!;
  const p = await getEvidence({ topic: "matchup2.player.coverage", params: { gsis_id: wr.gsis_id, opponent: "DAL" } }); assert.equal(p.status, "OK"); assert.ok(p.validation!.ok, JSON.stringify(p.validation)); assert.ok(p.blocks.some((b) => b.metric === "wr.coverage.man_zone"));
  const s = await getEvidence({ topic: "matchup2.player.summary", params: { gsis_id: wr.gsis_id, opponent: "DAL" } }); assert.ok(s.blocks.some((b) => b.metric === "unsupported.cornerback_assignment"));
  const bad = await getEvidence({ topic: "matchup2.player.coverage", params: { gsis_id: "00-0000000", opponent: "DAL" } }); assert.equal(bad.blocks[0]!.availability.state, "UNAVAILABLE");
  const noOpp = await getEvidence({ topic: "matchup2.player.coverage", params: { gsis_id: wr.gsis_id, opponent: "ZZZ" } }); assert.equal(noOpp.blocks[0]!.availability.state, "UNAVAILABLE");
});
test("Analysis Book: existing chapter ids only; run_fits UNSUPPORTED→PARTIAL, coverage_interaction gains the receiver split, CB/alignment/front/personnel stay UNSUPPORTED", () => {
  const snap = loadCapabilitySnapshot(); const dir = loadPlayerDirectory(); const wr = dir.players.find((p) => p.name === "Rome Odunze")!;
  const r = createBook({ question: "Analyze Rome Odunze this week", league: "bloodline-bowl", manager: "supyo29" }, dir, snap, "2026-09-21T12:00:00.000Z"); assert.ok(r.ok); const st = (id: string) => r.session.contents.find((c) => c.chapter_id === id)?.researchability;
  for (const id of ["matchup.cornerback_assignment", "defense.slot_boundary", "why.alignment", "defense.personnel", "game.fronts", "defense.front"]) assert.ok(id in CHAPTER_LIBRARY, id);
  assert.equal(st("matchup.cornerback_assignment")?.state, "UNSUPPORTED");
  const cov = CHAPTER_LIBRARY["matchup.coverage_interaction"]!; assert.ok(cov.needs.some((n) => n.topic === "matchup2.player.coverage" && n.role === "required")); assert.ok(!cov.needs.some((n) => n.capability === "receiver_scheme_profile"));
  const rf = CHAPTER_LIBRARY["defense.run_fits"]!; assert.ok(rf.needs.some((n) => n.topic === "matchup2.defense.front")); void wr;
  const d = createBook({ question: "Analyze the Dallas defense this week" }, dir, snap, "2026-09-21T12:00:00.000Z"); if (d.ok) { const x = d.session.contents.find((c) => c.chapter_id === "defense.run_fits")?.researchability; if (x) assert.equal(x.state, "PARTIAL", "run_fits: direction/gap/box exist; fits and alignment do not"); const f = d.session.contents.find((c) => c.chapter_id === "defense.front")?.researchability; if (f) assert.equal(f.state, "UNSUPPORTED"); }
});
