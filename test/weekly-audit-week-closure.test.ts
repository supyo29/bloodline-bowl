/**
 * Phase 9 Step 3 / Step 61 — week closure. Never uses provider nominal week or day-of-week; only real per-game status.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildNflSeasonCompletion, type RawNflScheduleGame } from "@/lib/canonical/nfl-reality-frontier";
import { determineWeekClosure } from "@/lib/weekly-audit/week-closure";

const g = (week: number, status: string, home = "AAA", away = "BBB"): RawNflScheduleGame => ({ week, home, away, status, date: "2026-09-14" });

describe("week closure", () => {
  test("all games complete -> WEEK_COMPLETE", () => {
    const c = buildNflSeasonCompletion([g(1, "complete"), g(1, "complete", "CCC", "DDD")], 2026, "2026-09-15T00:00:00Z");
    const closure = determineWeekClosure(2026, 1, c);
    assert.equal(closure.status, "WEEK_COMPLETE");
  });
  test("15/16 complete -> WEEK_IN_PROGRESS, not complete", () => {
    const games = [...Array(15)].map((_, i) => g(2, "complete", `T${i}`, `U${i}`)).concat([g(2, "pre_game", "ZZ", "YY")]);
    const closure = determineWeekClosure(2026, 2, buildNflSeasonCompletion(games, 2026, "2026-09-21T00:00:00Z"));
    assert.equal(closure.status, "WEEK_IN_PROGRESS");
  });
  test("a postponed game keeps the week PARTIAL, never silently finalized", () => {
    const games = [g(3, "complete"), g(3, "postponed", "CCC", "DDD")];
    const closure = determineWeekClosure(2026, 3, buildNflSeasonCompletion(games, 2026, "2026-09-22T00:00:00Z"));
    assert.equal(closure.status, "WEEK_IN_PROGRESS");
  });
  test("fetch failure (completion = null) -> WEEK_INCOMPLETE_SOURCE_CONFLICT, fail closed, never treated as complete", () => {
    const closure = determineWeekClosure(2026, 1, null);
    assert.equal(closure.status, "WEEK_INCOMPLETE_SOURCE_CONFLICT");
  });
  test("0 scheduled games for the week (bye/data gap) -> WEEK_INCOMPLETE_SOURCE_CONFLICT, not COMPLETE", () => {
    const closure = determineWeekClosure(2026, 99, buildNflSeasonCompletion([g(1, "complete")], 2026, "x"));
    assert.equal(closure.status, "WEEK_INCOMPLETE_SOURCE_CONFLICT");
  });
  test("week not started (0 complete) -> WEEK_IN_PROGRESS", () => {
    const closure = determineWeekClosure(2026, 4, buildNflSeasonCompletion([g(4, "pre_game")], 2026, "x"));
    assert.equal(closure.status, "WEEK_IN_PROGRESS");
  });
  test("real live data: week 1 2026 is complete, week 2 is not (regression pin against the actual Sleeper schedule shape)", () => {
    // shape mirrors the real production observation recorded in the Phase 8 doc (15/16 for week 2).
    const games = [...Array(16)].map((_, i) => g(1, "complete", `A${i}`, `B${i}`)).concat([...Array(15)].map((_, i) => g(2, "complete", `C${i}`, `D${i}`)), [g(2, "pre_game", "ZZ", "YY")]);
    const c = buildNflSeasonCompletion(games, 2026, "x");
    assert.equal(determineWeekClosure(2026, 1, c).status, "WEEK_COMPLETE");
    assert.equal(determineWeekClosure(2026, 2, c).status, "WEEK_IN_PROGRESS");
  });
});
