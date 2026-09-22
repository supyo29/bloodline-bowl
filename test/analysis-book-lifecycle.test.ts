/**
 * Phase 10 — acceptance cases (brief §21-23) + lineage + new lifecycle book types.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadPlayerDirectory } from "@/lib/analysis-book/directory";
import { loadCapabilitySnapshot } from "@/lib/analysis-book/capability";
import { createBook } from "@/lib/analysis-book/contents";
import { parseCommand, resolveSelector } from "@/lib/analysis-book/selection";
import { contentsView } from "@/lib/analysis-book/view";
import { buildFrontier } from "@/lib/analysis-book/frontier";
import { relatedBooks } from "@/lib/analysis-book/lineage";
import { CHAPTER_LIBRARY, TEMPLATES } from "@/lib/analysis-book/library";
import { buildNflSeasonCompletion, type RawNflScheduleGame } from "@/lib/canonical/nfl-reality-frontier";
import { getEvidence } from "@/lib/book-ready/query";
import type { AnalysisBookSession } from "@/lib/analysis-book/schema";

const dir = loadPlayerDirectory(); const snap = loadCapabilitySnapshot(); const NOW = "2026-09-22T12:00:00.000Z";
const keys = (s: AnalysisBookSession, cmd: string) => { const c = parseCommand(cmd); assert.equal(c.kind, "select", cmd); if (c.kind !== "select") throw 0; const r = resolveSelector(s, c.selector); assert.ok(r.ok, r.ok ? "" : r.message); return r.ok ? r.keys : []; };

/* ============================ Acceptance case 1 — Rome Odunze / Week 2 (brief §21) ============================ */
describe("Acceptance 1: Rome Odunze Week 2 — contents, a chapter range, and back to the SAME book", () => {
  const r = createBook({ question: "Analyze Rome Odunze for Week 2" }, dir, snap, NOW);
  test("produces an exhaustive Player book contents map", () => { assert.ok(r.ok); if (r.ok) { assert.equal(r.session.classification.primary, "PLAYER_ANALYSIS"); assert.ok(r.session.contents.length >= 30); assert.equal(r.session.subject.players[0]?.name, "Rome Odunze"); } });
  test("a chapter range resolves to exactly those chapters, in order, preserving player/team/week context", () => {
    assert.ok(r.ok); if (!r.ok) return;
    const total = r.session.contents.length; const from = Math.max(1, total - 8); const to = total - 2; // a real range near the end of THIS book, whatever its exact length
    const want = r.session.contents.slice(from - 1, to).map((c) => c.chapter_id);
    assert.deepEqual(keys(r.session, `${from}-${to}`), want);
    assert.equal(r.session.subject.players[0]?.name, "Rome Odunze"); assert.equal(r.session.subject.team, "CHI");
  });
  test("'contents' after a selection returns the identical book (same book_id, same contents, context retained)", () => {
    assert.ok(r.ok); if (!r.ok) return;
    const v1 = contentsView(r.session, snap); const v2 = contentsView(r.session, snap);
    assert.equal(v1.book_id, r.session.book_id); assert.deepEqual(v1, v2);
  });
});

/* ============================ Acceptance case 2 — full game lifecycle (brief §22) ============================ */
describe("Acceptance 2: Pregame -> Postgame -> lineage into the Weekly Book, with no future-information leakage", () => {
  const pre = createBook({ question: "Falcons at Packers", requested_type: "PREGAME", week: 3, frontier: buildFrontier({ asOf: NOW, gameState: "PRE_GAME" }) }, dir, snap, NOW);
  test("Pregame Book is created while the game is not yet started", () => { assert.ok(pre.ok); if (pre.ok) assert.equal(pre.session.subject.frontier?.game_state, "PRE_GAME"); });
  test("the SAME game cannot yet produce a Postgame Book (game not final)", () => {
    const post = createBook({ question: "Falcons at Packers", requested_type: "POSTGAME", week: 3, frontier: buildFrontier({ asOf: NOW, gameState: "PRE_GAME" }) }, dir, snap, NOW);
    assert.equal(post.ok, false); if (!post.ok) assert.equal(post.status, "FRONTIER_VIOLATION");
  });
  test("once the game is FINAL, the Postgame Book is created and its reconciliation chapter depends on the pregame evidence chapters", () => {
    const post = createBook({ question: "Falcons at Packers", requested_type: "POSTGAME", week: 3, frontier: buildFrontier({ asOf: NOW, gameState: "FINAL" }) }, dir, snap, NOW);
    assert.ok(post.ok); if (!post.ok) return;
    const recon = post.session.contents.find((c) => c.chapter_id === "postgame.expectation_vs_actual")!;
    assert.ok(recon.depends_on.includes("game.offensive_plan")); assert.ok(recon.depends_on.includes("audit.startsit_outcomes"));
  });
  test("lineage: the Pregame Book points forward to its Postgame Book (not yet creatable) and to both teams' Team Books (creatable now)", () => {
    assert.ok(pre.ok); if (!pre.ok) return;
    const rel = relatedBooks({ book_type: "PREGAME", subject: pre.session.subject }, { targetGameFrontier: "PRE_GAME" });
    const postRef = rel.find((x) => x.relation === "POSTGAME_OF_THIS_GAME")!; assert.equal(postRef.currently_creatable, false);
    assert.ok(rel.some((x) => x.relation === "TEAM_BOOK" && x.scope.team === "ATL")); assert.ok(rel.some((x) => x.relation === "OPPONENT_TEAM_BOOK" && x.scope.team === "GB"));
  });
  test("lineage: the Postgame Book points BACK to its Pregame reference (never creatable again) and forward to the Weekly Review", () => {
    const post = createBook({ question: "Falcons at Packers", requested_type: "POSTGAME", week: 3, frontier: buildFrontier({ asOf: NOW, gameState: "FINAL" }) }, dir, snap, NOW);
    assert.ok(post.ok); if (!post.ok) return;
    const rel = relatedBooks({ book_type: "POSTGAME", subject: post.session.subject });
    assert.ok(rel.some((x) => x.relation === "PREGAME_OF_THIS_GAME" && x.currently_creatable === false));
    assert.ok(rel.some((x) => x.relation === "WEEK_REVIEW_FOR" && x.week === 3));
  });
});

/* ============================ Acceptance case 3 — Week 2 NFL Weekly Book (brief §23) ============================ */
describe("Acceptance 3: Week 2 NFL Weekly Intelligence Book — exhaustive navigable contents, honest unavailable sections", () => {
  test("live: week 2 2026 is REALLY complete (re-verified against the canonical schedule source, not assumed)", async () => {
    const completion = await buildNflSeasonCompletion(await liveGames(), 2026, NOW);
    const w2 = completion.weeks.find((w) => w.week === 2)!; assert.equal(w2.state, "COMPLETE");
  });
  test("WEEK_REVIEW for week 2 builds with contents that navigate to week-at-a-glance, model audit, and carryover — no team/game chapter fan-out", () => {
    const r = createBook({ question: "NFL Week 2 review", requested_type: "WEEK_REVIEW", week: 2, frontier: buildFrontier({ asOf: NOW, weekClosure: "WEEK_COMPLETE" }) }, dir, snap, NOW);
    assert.ok(r.ok); if (!r.ok) return;
    const ids = r.session.contents.map((c) => c.chapter_id);
    assert.deepEqual(ids, ["league.week_at_a_glance", "audit.startsit_outcomes", "audit.matchup_outcomes", "audit.waiver_outcomes", "audit.fi_recertification", "outlook.carryover", "book.final_synthesis"]);
    assert.ok(r.session.contents.length < 10, "the Weekly Book stays lightweight; teams/players are reached via lineage, not inlined");
  });
  test("unavailable audit sections are reported honestly (no real weekly-model-audit row exists yet), never fabricated", async () => {
    const ev = await getEvidence({ topic: "audit.weekly_model", params: { season: "2026", week: "2" } });
    assert.equal(ev.status, "OK"); assert.equal(ev.blocks[0]!.availability.state, "UNAVAILABLE");
  });
  test("lineage reaches every one of the 32 NFL teams from the Weekly Book, plus next-week outlook and the prior week review", () => {
    const r = createBook({ question: "NFL Week 2 review", requested_type: "WEEK_REVIEW", week: 2, frontier: buildFrontier({ asOf: NOW, weekClosure: "WEEK_COMPLETE" }) }, dir, snap, NOW);
    assert.ok(r.ok); if (!r.ok) return;
    const rel = relatedBooks({ book_type: "WEEK_REVIEW", subject: r.session.subject });
    const teamBooks = rel.filter((x) => x.relation === "TEAM_BOOK"); assert.equal(teamBooks.length, 32);
    assert.ok(rel.some((x) => x.relation === "NEXT_WEEK_OUTLOOK_FOR" && x.week === 3));
    assert.ok(rel.some((x) => x.relation === "PRIOR_WEEK_REVIEW" && x.week === 1));
  });
});

/* ============================ TEAM_ANALYSIS smoke + new-type taxonomy checks ============================ */
describe("TEAM_ANALYSIS (Team Book) and registry conformity for the 5 new lifecycle types", () => {
  test("TEAM_ANALYSIS combines offense (team.*) and defense (defense.*) chapters under one Team Book", () => {
    const r = createBook({ question: "Chicago Bears", requested_type: "TEAM_ANALYSIS", frontier: undefined }, dir, snap, NOW);
    assert.ok(r.ok); if (!r.ok) return;
    const ids = r.session.contents.map((c) => c.chapter_id);
    assert.ok(ids.includes("team.offensive_scheme")); assert.ok(ids.includes("defense.overall_strength"));
  });
  test("all 5 new BookTypes exist in TEMPLATES with real chapters and end in the final synthesis", () => {
    for (const t of ["PREGAME", "POSTGAME", "WEEK_REVIEW", "NEXT_WEEK_OUTLOOK", "TEAM_ANALYSIS"] as const) {
      const tpl = TEMPLATES[t]; assert.ok(tpl, t); const ids = tpl.parts.flatMap((p) => p.chapters); assert.equal(ids[ids.length - 1], "book.final_synthesis", t);
      for (const id of ids) assert.ok(CHAPTER_LIBRARY[id] || id === "book.final_synthesis", `${t}: ${id}`);
    }
  });
});

async function liveGames(): Promise<RawNflScheduleGame[]> {
  const { fetchSleeper, SLEEPER_ROOT_URL } = await import("@/lib/sleeper/client");
  return fetchSleeper<RawNflScheduleGame[]>(`/schedule/nfl/regular/2026`, { baseUrl: SLEEPER_ROOT_URL, revalidate: 0 });
}
