/**
 * Phase 10 — temporal-integrity gate. Adversarial: create a Pregame Book at T1 (game not started), advance the
 * game to FINAL at T2, and prove a T1-shaped request can no longer produce a book claiming to be Pregame for that
 * game; prove a Postgame Book cannot be created before the game is final; prove Week Review/Outlook require real
 * week closure. This is the single most safety-critical Phase 10 invariant (brief §4, §26 adversarial pattern).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { determineGameFrontier, buildFrontier, gateFrontier, FRONTIER_SOURCE } from "@/lib/analysis-book/frontier";
import { createBook } from "@/lib/analysis-book/contents";
import { loadPlayerDirectory } from "@/lib/analysis-book/directory";
import { loadCapabilitySnapshot } from "@/lib/analysis-book/capability";
import type { RawNflScheduleGame } from "@/lib/canonical/nfl-reality-frontier";

const dir = loadPlayerDirectory(); const snap = loadCapabilitySnapshot(); const NOW = "2026-09-22T12:00:00.000Z";

const preGameSlate: RawNflScheduleGame[] = [{ week: 3, home: "ATL", away: "GB", status: "pre_game", date: "2026-09-28" }];
const finalSlate: RawNflScheduleGame[] = [{ week: 3, home: "ATL", away: "GB", status: "complete", date: "2026-09-28" }];
const inProgressSlate: RawNflScheduleGame[] = [{ week: 3, home: "ATL", away: "GB", status: "in_game", date: "2026-09-28" }];

describe("determineGameFrontier — pure, deterministic, uses the SAME isCompleted predicate as the canonical frontier", () => {
  test("pre_game -> PRE_GAME", () => assert.equal(determineGameFrontier(preGameSlate, "ATL", "GB", 3), "PRE_GAME"));
  test("complete -> FINAL", () => assert.equal(determineGameFrontier(finalSlate, "ATL", "GB", 3), "FINAL"));
  test("in_game -> IN_PROGRESS", () => assert.equal(determineGameFrontier(inProgressSlate, "ATL", "GB", 3), "IN_PROGRESS"));
  test("unknown teams/week -> UNKNOWN, never guessed", () => assert.equal(determineGameFrontier(preGameSlate, "DAL", "NYG", 3), "UNKNOWN"));
  test("side order does not matter (home/away symmetric lookup)", () => assert.equal(determineGameFrontier(preGameSlate, "GB", "ATL", 3), "PRE_GAME"));
});

describe("gateFrontier — the single choke point", () => {
  test("PREGAME allowed only when PRE_GAME", () => {
    assert.equal(gateFrontier("PREGAME", buildFrontier({ asOf: NOW, gameState: "PRE_GAME" })).allowed, true);
    assert.equal(gateFrontier("PREGAME", buildFrontier({ asOf: NOW, gameState: "IN_PROGRESS" })).allowed, false);
    assert.equal(gateFrontier("PREGAME", buildFrontier({ asOf: NOW, gameState: "FINAL" })).allowed, false);
    assert.equal(gateFrontier("PREGAME", buildFrontier({ asOf: NOW, gameState: "UNKNOWN" })).allowed, false);
    assert.equal(gateFrontier("PREGAME", null).allowed, false, "no frontier supplied -> refused, never assumed PRE_GAME");
  });
  test("POSTGAME allowed only when FINAL", () => {
    assert.equal(gateFrontier("POSTGAME", buildFrontier({ asOf: NOW, gameState: "FINAL" })).allowed, true);
    assert.equal(gateFrontier("POSTGAME", buildFrontier({ asOf: NOW, gameState: "PRE_GAME" })).allowed, false);
    assert.equal(gateFrontier("POSTGAME", buildFrontier({ asOf: NOW, gameState: "IN_PROGRESS" })).allowed, false, "a Postgame Book must never forecast a result that has not happened");
  });
  test("WEEK_REVIEW allowed only when WEEK_COMPLETE", () => {
    assert.equal(gateFrontier("WEEK_REVIEW", buildFrontier({ asOf: NOW, weekClosure: "WEEK_COMPLETE" })).allowed, true);
    assert.equal(gateFrontier("WEEK_REVIEW", buildFrontier({ asOf: NOW, weekClosure: "WEEK_IN_PROGRESS" })).allowed, false);
    assert.equal(gateFrontier("WEEK_REVIEW", buildFrontier({ asOf: NOW, weekClosure: "WEEK_INCOMPLETE_SOURCE_CONFLICT" })).allowed, false);
  });
  test("NEXT_WEEK_OUTLOOK requires the PRIOR week's closure to be WEEK_COMPLETE", () => {
    assert.equal(gateFrontier("NEXT_WEEK_OUTLOOK", buildFrontier({ asOf: NOW, weekClosure: "WEEK_COMPLETE" })).allowed, true);
    assert.equal(gateFrontier("NEXT_WEEK_OUTLOOK", buildFrontier({ asOf: NOW, weekClosure: "WEEK_IN_PROGRESS" })).allowed, false);
  });
  test("non-lifecycle book types (e.g. PLAYER_ANALYSIS) are never gated — Phase 10 adds a gate, it narrows nothing that already worked", () => {
    assert.equal(gateFrontier("PLAYER_ANALYSIS", null).allowed, true);
    assert.equal(gateFrontier("PLAYER_ANALYSIS", buildFrontier({ asOf: NOW, gameState: "FINAL" })).allowed, true);
  });
  test("FRONTIER_SOURCE is a real, named source string — never silently empty", () => assert.match(FRONTIER_SOURCE, /sleeper/));
});

describe("adversarial: end-to-end createBook cannot leak hindsight (brief §26 T1/T2/T3 pattern)", () => {
  const req = (type: "PREGAME" | "POSTGAME", gameState: "PRE_GAME" | "IN_PROGRESS" | "FINAL" | "UNKNOWN") =>
    createBook({ question: "Falcons at Packers", requested_type: type, frontier: buildFrontier({ asOf: NOW, gameState }) }, dir, snap, NOW);

  test("T1: PREGAME created while the game is genuinely PRE_GAME succeeds", () => {
    const r = req("PREGAME", "PRE_GAME"); assert.ok(r.ok, r.ok ? "" : r.status);
  });
  test("T2: the SAME request, once the game is FINAL, is REFUSED — a Pregame Book can never be created once kickoff/result evidence exists", () => {
    const r = req("PREGAME", "FINAL"); assert.equal(r.ok, false); if (!r.ok) { assert.equal(r.status, "FRONTIER_VIOLATION"); assert.match(r.note, /hindsight|FINAL/); }
  });
  test("T2 symmetric: POSTGAME while still PRE_GAME is refused — no forecasting a recap", () => {
    const r = req("POSTGAME", "PRE_GAME"); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.status, "FRONTIER_VIOLATION");
  });
  test("T3: POSTGAME once the game is FINAL succeeds and its subject records the frontier it was created against", () => {
    const r = req("POSTGAME", "FINAL"); assert.ok(r.ok); if (r.ok) { assert.equal(r.session.subject.frontier?.game_state, "FINAL"); assert.equal(r.session.classification.primary, "POSTGAME"); }
  });
  test("a PREGAME and a POSTGAME book for the identical game+week have DIFFERENT book_id — a frontier change is a materially different Book, never a silent mutation", () => {
    const a = req("PREGAME", "PRE_GAME"); const b = req("POSTGAME", "FINAL");
    assert.ok(a.ok && b.ok); if (a.ok && b.ok) assert.notEqual(a.session.book_id, b.session.book_id);
  });
  test("WEEK_REVIEW for an in-progress week is refused; for a complete week it succeeds and exposes the model-audit + week-at-a-glance chapters", () => {
    const blocked = createBook({ question: "NFL Week 3 review", requested_type: "WEEK_REVIEW", week: 3, frontier: buildFrontier({ asOf: NOW, weekClosure: "WEEK_IN_PROGRESS" }) }, dir, snap, NOW);
    assert.equal(blocked.ok, false); if (!blocked.ok) assert.equal(blocked.status, "FRONTIER_VIOLATION");
    const ok = createBook({ question: "NFL Week 3 review", requested_type: "WEEK_REVIEW", week: 3, frontier: buildFrontier({ asOf: NOW, weekClosure: "WEEK_COMPLETE" }) }, dir, snap, NOW);
    assert.ok(ok.ok); if (ok.ok) { const ids = ok.session.contents.map((c) => c.chapter_id); assert.ok(ids.includes("league.week_at_a_glance")); assert.ok(ids.includes("audit.startsit_outcomes")); }
  });
  test("NEXT_WEEK_OUTLOOK never masquerades as a late-week Pregame Book: its chapters never include game.*/why.* content", () => {
    const r = createBook({ question: "What does Week 3 mean for Week 4", requested_type: "NEXT_WEEK_OUTLOOK", week: 4, frontier: buildFrontier({ asOf: NOW, weekClosure: "WEEK_COMPLETE" }) }, dir, snap, NOW);
    assert.ok(r.ok); if (r.ok) for (const c of r.session.contents) assert.ok(!c.chapter_id.startsWith("game.") && !c.chapter_id.startsWith("why."), c.chapter_id);
  });
});
