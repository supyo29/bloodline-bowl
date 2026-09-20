/** Phase 3.5D Checkpoint C — navigation grammar, deterministic selection, session state, stale detection, serialization. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlayerDirectory } from "@/lib/analysis-book/directory";
import { loadCapabilitySnapshot, type CapabilitySnapshot } from "@/lib/analysis-book/capability";
import { createBook } from "@/lib/analysis-book/contents";
import { parseCommand, resolveSelector, nextChapters, isResearchable } from "@/lib/analysis-book/selection";
import { interpret } from "@/lib/analysis-book/commands";
import { beginResearch, recordChapterResearch, recordSupport, goDeeper, staleness, serializeSession, deserializeSession, type ChapterResearchResult } from "@/lib/analysis-book/session";
import { contentsView, renderContentsText } from "@/lib/analysis-book/view";
import type { AnalysisBookSession, EvidenceRef } from "@/lib/analysis-book/schema";

const dir = loadPlayerDirectory(); const snap = loadCapabilitySnapshot(); const NOW = "2026-09-20T12:00:00.000Z";
const make = (q = "Analyze Rome Odunze this week"): AnalysisBookSession => { const r = createBook({ question: q, league: "bloodline-bowl", manager: "supyo29" }, dir, snap, NOW); assert.ok(r.ok); return r.session; };
const num = (s: AnalysisBookSession, id: string) => s.contents.find((c) => c.chapter_id === id)!.display_number;
const keys = (s: AnalysisBookSession, cmd: string) => { const c = parseCommand(cmd); assert.equal(c.kind, "select", cmd); if (c.kind !== "select") throw 0; const r = resolveSelector(s, c.selector); assert.ok(r.ok, `${cmd}: ${r.ok ? "" : r.message}`); return r.ok ? r.keys : []; };
const ref = (surface: string, w = 1, over: Partial<EvidenceRef> = {}): EvidenceRef => ({ evidence_id: `eb:${surface}${w}`, surface, topic: "t", metric: "m", subject_id: "s", availability: "AVAILABLE", analysis_class: "OBSERVED", version: `v-${surface}-w${w}`, season: 2026, through_week: w, week_state: "COMPLETE", ...over });
const idOf = (surface: string) => { const v = snap.vintage[surface] ?? { version: `v-${surface}`, season: 2026, through_week: 1, week_state: "COMPLETE" }; return { surface, version: v.version, season: v.season, through_week: v.through_week, week_state: v.week_state }; };
const result = (surface: string, w = 1, over: Partial<ChapterResearchResult> = {}): ChapterResearchResult => ({ depth: 1, identities: [w === (snap.vintage[surface]?.through_week ?? 1) || w === 1 ? idOf(surface) : { ...idOf(surface), through_week: w }], evidence_refs: [ref(surface, w)], query_keys: [`q:${surface}`], coverage: { satisfied: ["role.player_profile"], unsatisfied: [] }, limitations: [], ...over });

test("parseCommand: every specified navigation form parses to the right typed command", () => {
  const k = (t: string) => parseCommand(t).kind;
  assert.equal(k("Contents"), "contents"); assert.equal(k("go deeper"), "go_deeper"); assert.equal(k("Final synthesis"), "synthesize"); assert.equal(k("synthesize what we've covered"), "synthesize");
  assert.deepEqual(parseCommand("next"), { kind: "next", count: 1 }); assert.deepEqual(parseCommand("Next chapter"), { kind: "next", count: 1 }); assert.deepEqual(parseCommand("next 3"), { kind: "next", count: 3 }); assert.deepEqual(parseCommand("next three"), { kind: "next", count: 3 });
  assert.deepEqual(parseCommand("final synthesis"), { kind: "synthesize", final: true }); assert.deepEqual(parseCommand("synthesize what we've covered"), { kind: "synthesize", final: false });
  const sel = (t: string) => { const c = parseCommand(t); return c.kind === "select" ? c.selector : c; };
  assert.deepEqual(sel("4"), { kind: "numbers", items: [{ from: 4, to: 4 }] }); assert.deepEqual(sel("4, 7, 12"), { kind: "numbers", items: [{ from: 4, to: 4 }, { from: 7, to: 7 }, { from: 12, to: 12 }] });
  assert.deepEqual(sel("4-9"), { kind: "numbers", items: [{ from: 4, to: 9 }] }); assert.deepEqual(sel("4 to 9"), sel("4-9")); assert.deepEqual(sel("Part II"), { kind: "parts", refs: ["ii"] }); assert.deepEqual(sel("Parts I and IV"), { kind: "parts", refs: ["i", "iv"] });
  assert.deepEqual(sel("the workload chapters"), { kind: "semantic", phrase: "workload" }); assert.deepEqual(sel("everything about touchdowns"), { kind: "semantic", phrase: "touchdowns" });
  assert.deepEqual(sel("everything remaining"), { kind: "remaining" }); assert.deepEqual(sel("18A"), { kind: "numbers", items: [{ label: "18A" }] });
  const r = parseCommand("refresh Part II"); assert.equal(r.kind, "refresh"); assert.equal(parseCommand("refresh what we've covered").kind, "refresh");
  assert.equal(parseCommand("go deeper on 4").kind, "go_deeper");
  assert.equal(parseCommand("").kind, "invalid"); assert.equal(parseCommand("purple monkey").kind, "invalid");
});

test("selection resolves numbers, lists, ranges, Parts and semantic groups deterministically to the same chapter set", () => {
  const s = make();
  assert.deepEqual(keys(s, "4"), [s.contents[3]!.chapter_id]); assert.deepEqual(keys(s, "4, 7, 12"), [3, 6, 11].map((i) => s.contents[i]!.chapter_id));
  assert.deepEqual(keys(s, "4-9"), s.contents.slice(3, 9).map((c) => c.chapter_id));
  const p2 = s.contents.filter((c) => c.part_id === s.parts[1]!.id).map((c) => c.chapter_id); assert.deepEqual(keys(s, "Part II"), p2);
  assert.deepEqual(keys(s, "Parts I and IV"), [...s.contents.filter((c) => c.part_id === s.parts[0]!.id), ...s.contents.filter((c) => c.part_id === s.parts[3]!.id)].map((c) => c.chapter_id));
  const workload = keys(s, "the workload chapters"); assert.deepEqual(workload, s.contents.filter((c) => c.tags.includes("workload")).map((c) => c.chapter_id)); for (const id of ["player.role.playing_time", "player.role.target_opportunity", "player.role.high_value_usage"]) assert.ok(workload.includes(id), id);
  const td = keys(s, "everything about touchdowns"); for (const id of ["player.role.high_value_usage", "team.red_zone_offense", "matchup.red_zone_defense"]) assert.ok(td.includes(id), id);
  for (const cmd of ["4-9", "Part II", "the workload chapters"]) assert.deepEqual(keys(s, cmd), keys(make(), cmd), `${cmd} is deterministic`);
  assert.deepEqual(keys(s, `${num(s, "matchup.coverage_interaction")}A`), ["matchup.coverage_interaction/A"]);
});
test("invalid selections fail helpfully (say what IS valid)", () => {
  const s = make(); const bad = (cmd: string) => { const c = parseCommand(cmd); if (c.kind === "invalid") return c.message; if (c.kind !== "select") throw new Error(cmd); const r = resolveSelector(s, c.selector); assert.equal(r.ok, false, cmd); return r.ok ? "" : r.message; };
  assert.match(bad("99"), new RegExp(`1–${s.contents.length}`)); assert.match(bad("9-4"), /backwards/); assert.match(bad("Part IX"), /no Part.*this book has Part I/); assert.match(bad("the banana chapters"), /Groups in this book/); assert.match(bad("3Z"), /no subchapter/); assert.match(bad("purple monkey"), /not a chapter number/);
  const r = interpret(s, "99", snap); assert.equal(r.action.kind, "ERROR");
});

test("Next / Next N follow book order from the current chapter, skip opened and unresearchable chapters, and do not assume linear reading", () => {
  let s = make();
  const n1 = nextChapters(s, 3); assert.ok(n1.ok); assert.deepEqual(n1.ok && n1.keys, s.contents.filter((c) => isResearchable(s, c.chapter_id) && c.kind === "EVIDENCE").slice(0, 3).map((c) => c.chapter_id));
  s = recordChapterResearch(beginResearch(s, ["team.competition"]), "team.competition", result("role-opportunity"), NOW);
  assert.equal(s.current_chapter, "team.competition"); const n2 = nextChapters(s, 2); assert.ok(n2.ok);
  const after = s.contents.slice(num(s, "team.competition")).filter((c) => isResearchable(s, c.chapter_id) && c.kind === "EVIDENCE").slice(0, 2).map((c) => c.chapter_id); assert.deepEqual(n2.ok && n2.keys, after, "continues AFTER the chapter the user jumped to");
  for (const k of n2.ok ? n2.keys : []) assert.notEqual(k, "team.competition");
  for (const k of nextChapters(s, 40).ok ? (nextChapters(s, 40) as { keys: string[] }).keys : []) assert.ok(isResearchable(s, k), "never proposes an UNSUPPORTED/UNAVAILABLE chapter");
  const rem = resolveSelector(s, { kind: "remaining" }); assert.ok(rem.ok && rem.notes.some((n) => /not researchable/.test(n)) && !rem.keys.includes("team.competition"));
});

test("state: EXPLORED only via research; support use NEVER marks a chapter explored; blocked research is not 'researched'", () => {
  let s = make();
  s = recordSupport(s, "player.role.playing_time", "decision.risk_uncertainty", [ref("role-opportunity")], NOW);
  assert.equal(s.chapters["player.role.playing_time"]!.status, "NOT_OPENED"); assert.equal(s.chapters["player.role.playing_time"]!.used_as_support.length, 1);
  const v = contentsView(s, snap); const row = v.parts.flatMap((p) => p.rows).find((r) => r.chapter_id === "player.role.playing_time")!; assert.equal(row.used_as_support, true); assert.equal(row.status, "NOT_OPENED"); assert.equal(v.progress.explored, 0); assert.equal(v.progress.support_only, 1);
  assert.match(renderContentsText(v), /◦\s+2\. Playing time/);
  const blocked = recordChapterResearch(beginResearch(s, ["decision.projection_range"]), "decision.projection_range", { ...result("start-sit-fi"), evidence_refs: [ref("start-sit-fi", 1, { availability: "UNAVAILABLE" })] }, NOW);
  assert.equal(blocked.chapters["decision.projection_range"]!.status, "NOT_OPENED"); assert.ok(blocked.chapters["decision.projection_range"]!.blocked_reason);
  const ok = recordChapterResearch(s, "player.role.playing_time", result("role-opportunity"), NOW); assert.equal(ok.chapters["player.role.playing_time"]!.status, "EXPLORED");
  const partial = recordChapterResearch(s, "player.role.playing_time", result("role-opportunity", 1, { coverage: { satisfied: ["a"], unsatisfied: ["b"] } }), NOW); assert.equal(partial.chapters["player.role.playing_time"]!.status, "PARTIAL");
  assert.equal(s.chapters["player.role.playing_time"]!.status, "NOT_OPENED", "functions never mutate their input");
});

test("Go deeper stays in the chapter, raises depth on the SAME chapter, appends a revision, and stops at max depth", () => {
  let s = recordChapterResearch(make(), "player.role.playing_time", result("role-opportunity"), NOW);
  const d1 = goDeeper(s, null); assert.ok(d1.ok && d1.key === "player.role.playing_time" && d1.nextDepth === 2);
  s = recordChapterResearch(s, "player.role.playing_time", result("role-opportunity", 1, { depth: 2 }), "2026-09-20T13:00:00.000Z");
  const st = s.chapters["player.role.playing_time"]!; assert.equal(st.depth, 2); assert.equal(st.revisions.length, 2); assert.equal(st.revisions[0]!.depth, 1, "the earlier research is preserved");
  s = recordChapterResearch(s, "player.role.playing_time", result("role-opportunity", 1, { depth: 3 }), NOW); assert.equal(goDeeper(s, null).ok, false);
  assert.equal(goDeeper(make(), null).ok, false, "nothing to go deeper on before a chapter is opened");
  const r = interpret(recordChapterResearch(make(), "player.role.playing_time", result("role-opportunity"), NOW), "go deeper", snap); assert.equal(r.action.kind, "GO_DEEPER");
});

test("stale detection compares STORED evidence identity with CURRENT source identity — never wall-clock time", () => {
  let s = recordChapterResearch(make(), "player.role.trajectory", result("role-opportunity", 1), NOW);
  s = recordChapterResearch(s, "player.performance.sustainability", result("football-intelligence", 2, { identities: [{ surface: "football-intelligence", version: snap.vintage["football-intelligence"]!.version, season: 2026, through_week: 2, week_state: "PARTIAL" }] }), NOW);
  assert.equal(staleness(s, snap).filter((r) => r.stale && r.key === "player.role.trajectory").length, 0, "same identity -> not stale, however much time passes");
  const later = { ...snap, vintage: { ...snap.vintage } }; // time passing alone changes nothing
  assert.equal(staleness(s, later).find((r) => r.key === "player.role.trajectory")!.stale, false);
  const advanced: CapabilitySnapshot = { ...snap, vintage: { ...snap.vintage, "role-opportunity": { ...snap.vintage["role-opportunity"]!, version: "roi:2026:w02:aaaaaaaaaaaa", through_week: 2 } } };
  const rep = staleness(s, advanced).find((r) => r.key === "player.role.trajectory")!; assert.equal(rep.stale, true); assert.equal(rep.reasons[0]!.kind, "NEW_THROUGH_WEEK"); assert.deepEqual([rep.reasons[0]!.from, rep.reasons[0]!.to], ["w1", "w2"]);
  const wc: CapabilitySnapshot = { ...snap, vintage: { ...snap.vintage, "football-intelligence": { ...snap.vintage["football-intelligence"]!, week_state: "COMPLETE" } } };
  assert.equal(staleness(s, wc).find((r) => r.key === "player.performance.sustainability")!.reasons[0]!.kind, "WEEK_COMPLETED");
  const v = contentsView(s, advanced); const row = v.parts.flatMap((p) => p.rows).find((r) => r.chapter_id === "player.role.trajectory")!;
  assert.equal(row.status, "STALE"); assert.equal(row.update_available, true); assert.match(renderContentsText(v), /↻\s+\d+\. Role trajectory\s+STALE — update available/);
  assert.equal(s.chapters["player.role.trajectory"]!.status, "EXPLORED", "stored research is untouched; STALE is derived");
  assert.equal(s.chapters["player.role.trajectory"]!.revisions.length, 1);
  // refreshing appends a revision and keeps the old one
  const r = interpret(s, `refresh ${num(s, "player.role.trajectory")}`, advanced); assert.equal(r.action.kind, "REFRESH"); assert.equal(r.session.chapters["player.role.trajectory"]!.status, "NEEDS_REFRESH");
  const done = recordChapterResearch(r.session, "player.role.trajectory", result("role-opportunity", 2, { identities: [{ surface: "role-opportunity", version: "roi:2026:w02:aaaaaaaaaaaa", season: 2026, through_week: 2, week_state: "COMPLETE" }] }), NOW); assert.equal(done.chapters["player.role.trajectory"]!.revisions.length, 2); assert.equal(done.chapters["player.role.trajectory"]!.status, "EXPLORED");
  assert.equal(contentsView(done, advanced).parts.flatMap((p) => p.rows).find((x) => x.chapter_id === "player.role.trajectory")!.status, "EXPLORED", "refreshed chapter is current again");
});

test("Refresh command: refresh N / Part / what we've covered only touch researched chapters and explain the rest", () => {
  let s = recordChapterResearch(make(), "player.role.playing_time", result("role-opportunity"), NOW); s = recordChapterResearch(s, "player.role.trajectory", result("role-opportunity"), NOW);
  const cov = interpret(s, "refresh what we've covered", snap); assert.ok(cov.action.kind === "REFRESH" && cov.action.keys.length === 2);
  const part = interpret(s, "refresh Part I", snap); assert.ok(part.action.kind === "REFRESH" && part.action.keys.length === 2 && part.action.skipped.length > 0);
  const unopened = interpret(s, `refresh ${num(s, "team.competition")}`, snap); assert.equal(unopened.action.kind, "ERROR"); assert.match(unopened.action.kind === "ERROR" ? unopened.action.message : "", /not been researched/);
  assert.equal(interpret(make(), "refresh what we've covered", snap).action.kind, "ERROR");
});

test("Contents redisplay is pure: it never changes state or re-runs research; re-selecting a researched chapter RECALLS it", () => {
  const s = recordChapterResearch(make(), "player.role.playing_time", result("role-opportunity"), NOW); const before = JSON.stringify(s);
  const c = interpret(s, "contents", snap); assert.equal(c.action.kind, "SHOW_CONTENTS"); assert.equal(JSON.stringify(c.session), before);
  const again = interpret(s, String(num(s, "player.role.playing_time")), snap); assert.ok(again.action.kind === "OPEN" && again.action.research.length === 0 && again.action.recall.length === 1);
  const text = renderContentsText(contentsView(s, snap)); assert.match(text, /PART I — PLAYER & ROLE/); assert.match(text, /→\s+2\. Playing time\s+EXPLORED/); assert.match(text, /Progress: 1 explored/);
  assert.match(renderContentsText(contentsView(make(), snap)), /HISTORY_LIMITED/);
});

test("serialization is canonical and deterministic; round-trips; detects tampering; reports (never applies) taxonomy drift", () => {
  const s = recordChapterResearch(make(), "player.role.playing_time", result("role-opportunity"), NOW);
  const a = serializeSession(s); const b = serializeSession(JSON.parse(JSON.stringify(s))); assert.equal(a, b);
  const { session, drift } = deserializeSession(a); assert.deepEqual(session, s); assert.equal(drift.drifted, false); assert.equal(serializeSession(session), a);
  assert.throws(() => deserializeSession(a.replace("EXPLORED", "NOT_OPENED")), /hash mismatch/); assert.throws(() => deserializeSession('{"format":"x"}'), /not a/);
  const old = JSON.parse(a) as { session: AnalysisBookSession; hash: string }; old.session.taxonomy_version = "analysis-taxonomy-2025.9"; const reser = serializeSession(old.session);
  const d2 = deserializeSession(reser); assert.equal(d2.drift.drifted, true); assert.equal(d2.drift.stored_taxonomy, "analysis-taxonomy-2025.9"); assert.equal(d2.session.taxonomy_version, "analysis-taxonomy-2025.9", "interpretation is not silently rewritten");
  assert.equal(d2.session.contents.length, s.contents.length);
});
