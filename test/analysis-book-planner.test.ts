/** Phase 3.5D Checkpoint B — classification, exhaustive Contents, capability-aware researchability, laziness. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPlayerDirectory } from "@/lib/analysis-book/directory";
import { loadCapabilitySnapshot } from "@/lib/analysis-book/capability";
import { createBook } from "@/lib/analysis-book/contents";
import { CHAPTER_LIBRARY, TEMPLATES } from "@/lib/analysis-book/library";
import type { AnalysisBookSession, BookType } from "@/lib/analysis-book/schema";
import { getCapabilities } from "@/lib/book-ready/query";

const dir = loadPlayerDirectory(); const snap = loadCapabilitySnapshot(); const NOW = "2026-09-20T12:00:00.000Z";
const book = (question: string, ctx: { league?: string; manager?: string } = {}): AnalysisBookSession => { const r = createBook({ question, ...ctx }, dir, snap, NOW); assert.ok(r.ok, `${question}: ${r.ok ? "" : r.note}`); return r.session; };
const ch = (s: AnalysisBookSession, id: string) => s.contents.find((c) => c.chapter_id === id)!;
const CTX = { league: "bloodline-bowl", manager: "supyo29" };

test("classification: explicit typed rules map the specified questions to the specified books", () => {
  const cases: Array<[string, BookType]> = [
    ["Analyze Rome Odunze this week", "PLAYER_ANALYSIS"], ["Analyze Rome", "PLAYER_ANALYSIS"], ["Rome or Deebo?", "START_SIT_COMPARISON"],
    ["What happened to Mark's team?", "MANAGER_REVIEW"], ["How did Miami stop Deebo?", "PLAYER_VS_DEFENSE_GAME_ANALYSIS"], ["Who should I target on waivers?", "WAIVER_ANALYSIS"],
    ["Should I trade for Tuten?", "TRADE_ANALYSIS"], ["Bears vs Panthers game breakdown", "GAME_ANALYSIS"], ["How good is the Miami defense?", "DEFENSE_ANALYSIS"],
    ["Why did Rome Odunze have such a big game?", "WHY_ANALYSIS"], ["Rome vs Deebo vs Bhayshul Tuten", "START_SIT_COMPARISON"], ["How is my team doing?", "MANAGER_REVIEW"],
  ];
  for (const [q, t] of cases) { const s = book(q); assert.equal(s.classification.primary, t, q); assert.ok(s.classification.matched_rules.length, q); }
});
test("classification is not keyword-fragile: the same words route differently with different entities; hybrids are explicit", () => {
  assert.equal(book("Should I start Rome?").classification.primary, "START_SIT_COMPARISON"); assert.deepEqual(book("Should I start Rome?").classification.secondary, ["PLAYER_ANALYSIS"]);
  assert.equal(book("Rome Odunze").classification.primary, "PLAYER_ANALYSIS");
  assert.deepEqual(book("What happened to Mark's team?").classification.secondary, ["WHY_ANALYSIS"]);
  assert.equal(book("Why did Rome Odunze struggle against Carolina?").classification.primary, "PLAYER_VS_DEFENSE_GAME_ANALYSIS");
});
test("unclassifiable / ambiguous questions ask for clarification instead of guessing", () => {
  for (const q of ["Analyze that guy", "hello", "Analyze Jennings"]) { const r = createBook({ question: q }, dir, snap, NOW); assert.equal(r.ok, false, q); if (!r.ok) assert.equal(r.status, "NEEDS_CLARIFICATION"); }
  const amb = createBook({ question: "Analyze Jennings" }, dir, snap, NOW); if (!amb.ok) assert.ok(amb.ambiguous.some((a) => a.startsWith("jennings")));
});

test("PLAYER book (WR): exhaustive breadth across role, opportunity, scheme, matchup, schedule, projection, roster", () => {
  const s = book("Analyze Rome Odunze this week"); assert.equal(s.subject.players[0]!.name, "Rome Odunze"); assert.equal(s.subject.team, "CHI");
  assert.ok(s.contents.length >= 30, `exhaustive breadth (${s.contents.length})`); assert.ok(s.parts.length >= 5);
  const tags = new Set(s.contents.flatMap((c) => c.tags));
  for (const t of ["role", "workload", "targets", "routes", "scheme", "coverage", "matchup", "pressure", "schedule", "projection", "roster", "touchdowns", "uncertainty", "injury", "efficiency"]) assert.ok(tags.has(t), `WR book omits ${t}`);
  assert.equal(s.contents.some((c) => c.chapter_id.startsWith("player.qb.")), false, "QB-only chapters are not asked of a WR (relevance, not availability)");
  assert.ok(s.contents.some((c) => c.chapter_id === "player.role.route_participation"));
  const s2 = book("Analyze Patrick Mahomes"); if (s2.subject.players[0]) { assert.equal(s2.contents.some((c) => c.chapter_id === "player.role.target_opportunity"), false); assert.ok(s2.contents.some((c) => c.chapter_id === "player.qb.progression")); }
});
test("chapter numbers are display only: identity is the stable id, numbering is contiguous within the book", () => {
  const s = book("Analyze Rome Odunze"); assert.deepEqual(s.contents.map((c) => c.display_number), s.contents.map((_, i) => i + 1));
  const r = book("Rome or Deebo?"); assert.notEqual(ch(s, "matchup.defensive_structure").display_number, ch(r, "matchup.defensive_structure").display_number, "same chapter id, different number in a different book");
});
test("START/SIT comparison: one shared book with per-player evidence needs, not disconnected books", () => {
  const s = book("Rome or Deebo or Bhayshul Tuten?"); assert.equal(s.subject.players.length, 3); assert.equal(s.subject.kind, "PLAYERS");
  const tags = new Set(s.contents.flatMap((c) => c.tags)); for (const t of ["role", "matchup", "coverage", "pressure", "scoring", "uncertainty", "startsit", "comparison"]) assert.ok(tags.has(t), t);
  assert.ok(s.contents.length < 60); assert.equal(new Set(s.contents.map((c) => c.chapter_id)).size, s.contents.length);
  const be = ch(s, "player.role.playing_time"); assert.equal(be.needs[0]!.bind, "self", "a self need expands across every player at plan time");
});
test("GAME / DEFENSE / WAIVER / TRADE / MANAGER / WHY books contain their required analytical dimensions", () => {
  const want: Array<[string, string[]]> = [
    ["Bears vs Panthers game breakdown", ["offense", "defense", "personnel", "fronts", "pressure", "coverage", "matchup", "adjustments", "line", "scoring", "repeatability", "fantasy"]],
    ["How good is the Miami defense?", ["fronts", "pressure", "blitz", "coverage", "man_zone", "shell", "slot_boundary", "run_defense", "personnel", "explosiveness", "fantasy"]],
    ["Who should I target on waivers?", ["role", "opportunity", "schedule", "replacement", "roster", "faab", "uncertainty", "competition", "drop"]],
    ["Should I trade for Tuten?", ["market", "role", "schedule", "roster", "replacement", "managers", "scarcity", "risk"]],
    ["What happened to Mark's team?", ["roster", "positions", "performance", "startsit", "bench", "injury", "waiver", "trade", "schedule", "outlook"]],
    ["Why did Rome Odunze have such a big game?", ["role", "alignment", "matchup", "coverage", "pressure", "play_design", "game_script", "execution", "history", "repeatability"]],
  ];
  for (const [q, dims] of want) { const tags = new Set(book(q).contents.flatMap((c) => [...c.tags, ...c.subchapters.flatMap((x) => CHAPTER_LIBRARY[c.chapter_id]!.subchapters!.find((y) => y.id === x.id)?.tags ?? [])])); for (const d of dims) assert.ok(tags.has(d), `${q} omits ${d}`); }
});
test("trade book keeps BOTH player value and manager/roster incentives; manager review keeps roster+decisions+future", () => {
  const t = book("Should I trade for Tuten?"); assert.ok(ch(t, "trade.player_value") && ch(t, "trade.manager_incentives") && ch(t, "trade.roster_impact"));
  const m = book("What happened to Mark's team?"); for (const id of ["manager.roster_strength", "manager.startsit_decisions", "manager.bench_decisions", "manager.waivers", "manager.trades", "manager.future_outlook"]) assert.ok(ch(m, id), id);
});
test("player-vs-defense hybrid binds the DEFENSE chapters to the opponent, not the player's own team", () => {
  const s = book("How did Miami stop Deebo?"); assert.equal(s.subject.opponent_team, "MIA"); assert.equal(s.subject.team, "SF");
  for (const n of ch(s, "defense.pressure").needs) if (n.topic) assert.equal(n.bind, "opponent");
});

test("researchability reflects the REAL 3.5C capability limits (never advertises what does not exist)", () => {
  const s = book("Analyze Rome Odunze this week"); const st = (id: string) => ch(s, id).researchability;
  assert.equal(st("player.role.playing_time").state, "HISTORY_LIMITED"); assert.match(st("player.role.playing_time").reasons.join(), /preserved complete-week/);
  assert.equal(st("decision.projection_range").state, "UNSUPPORTED"); assert.equal(st("decision.floor_median_ceiling").state, "UNSUPPORTED");
  assert.equal(st("decision.market_value").state, "UNSUPPORTED", "trade foundations are UNSUPPORTED in the registry");
  assert.equal(st("player.scheme.usage_profile").state, "UNSUPPORTED"); assert.match(st("player.scheme.usage_profile").unsupported.join(), /receiver_scheme_profile/);
  assert.equal(st("matchup.cornerback_assignment").state, "UNSUPPORTED");
  assert.equal(st("injury.contingencies").state, "CONDITIONAL"); assert.match(st("injury.contingencies").reasons.join(), /never an unconditional projection/);
  assert.equal(st("matchup.coverage_interaction").state, "PARTIAL"); // scheme coverage exists; receiver-side split does not
  assert.equal(st("matchup.fantasy_view").state, "UNAVAILABLE"); assert.match(st("matchup.fantasy_view").missing_context.join(), /league \+ manager/);
  assert.equal(st("book.final_synthesis").state, "READY");
});
test("with manager context, request-scoped chapters become researchable and carry their true cost class", () => {
  const s = book("Rome or Deebo?", CTX); const st = (id: string) => ch(s, id).researchability;
  assert.notEqual(st("startsit.shadow_view").state, "UNAVAILABLE"); assert.equal(st("startsit.shadow_view").cost, "EXPENSIVE");
  assert.equal(st("startsit.historical_accuracy").state, "CURRENT_ONLY", "3.5C: Start/Sit history is not served by /api/evidence — must NOT be READY");
  assert.equal(st("decision.roster_fit").cost, "MODERATE"); assert.equal(st("player.role.trajectory").cost, "FAST");
});
test("a chapter is READY only if every applicable required need is supported, and no chapter drops out for lack of evidence", () => {
  for (const q of ["Analyze Rome Odunze this week", "Rome or Deebo?", "Who should I target on waivers?", "Should I trade for Tuten?", "What happened to Mark's team?", "Bears vs Panthers game breakdown", "How good is the Miami defense?"]) {
    const s = book(q, CTX);
    const expected = [...new Set(TEMPLATES[s.classification.primary].parts.flatMap((p) => p.chapters))].filter((id) => { const d = CHAPTER_LIBRARY[id]!; return !d.applies_to || !s.subject.players.some((p) => p.position) || s.subject.players.some((p) => d.applies_to!.includes(p.position!)); });
    for (const id of expected) assert.ok(ch(s, id), `${q}: ${id} was dropped from Contents`);
    for (const c of s.contents) if (c.researchability.state === "READY" && c.kind === "EVIDENCE") assert.deepEqual(c.researchability.unsupported.filter((u) => c.needs.some((n) => n.role === "required" && n.capability && u.startsWith(n.capability))), [], `${c.chapter_id} READY with an unsupported required capability`);
  }
});
test("capability snapshot agrees with the live Book-Ready capabilities endpoint", () => {
  const caps = getCapabilities() as { registry_version: string; refresh_status: Array<{ surface: string; through_week: number; refresh_lag_weeks: number }> };
  assert.equal(snap.registry_version, caps.registry_version);
  for (const r of caps.refresh_status) { assert.equal(snap.vintage[r.surface]!.through_week, r.through_week, r.surface); assert.equal(snap.vintage[r.surface]!.lag_weeks, r.refresh_lag_weeks, r.surface); }
  assert.ok(snap.vintage["player-scheme"]!.season! < snap.season, "Player-Scheme is a prior-season source");
});

test("Contents is LIGHTWEIGHT and lazy: no network, no Book-Ready query layer, metadata only", () => {
  const realFetch = globalThis.fetch; let calls = 0; globalThis.fetch = (() => { calls += 1; throw new Error("network during Contents"); }) as typeof fetch;
  try { const t = performance.now(); const s = book("Analyze Rome Odunze this week"); const ms = performance.now() - t; assert.equal(calls, 0); assert.ok(s.contents.length >= 30); assert.ok(ms < 250, `Contents took ${ms.toFixed(1)} ms`); } finally { globalThis.fetch = realFetch; }
  for (const f of ["contents", "capability", "classify", "entities", "library", "topics", "schema"]) assert.doesNotMatch(readFileSync(`lib/analysis-book/${f}.ts`, "utf8"), /book-ready|getEvidence|buildWeeklyIntelligence|fetch\(/, `${f}.ts must not retrieve evidence`);
});
test("book creation is deterministic: same inputs -> identical session and book_id", () => {
  const a = book("Analyze Rome Odunze this week"); const b = book("  analyze   rome odunze THIS week "); assert.equal(a.book_id, b.book_id); assert.deepEqual(a.contents, book("Analyze Rome Odunze this week").contents);
});
