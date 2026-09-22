/**
 * Phase 10 — the temporal-integrity gate. This is the ONE place that decides whether a lifecycle Book type
 * (PREGAME / POSTGAME / WEEK_REVIEW / NEXT_WEEK_OUTLOOK) may be created for a given subject at a given moment.
 *
 * Pure and deterministic: given real, already-fetched game/week completion facts (never re-derived — reuses
 * `isCompleted`/`buildNflSeasonCompletion` from `lib/canonical/nfl-reality-frontier.ts`, the same predicate Phase 1
 * and Phase 9 use), it answers "is this book type allowed right now" and refuses otherwise. Refusal is not an error
 * — it is the honest answer when the requested lifecycle stage does not match reality:
 *   PREGAME  requires the target game to be verifiably NOT YET STARTED (PRE_GAME) — refused once it is IN_PROGRESS/FINAL.
 *   POSTGAME requires the target game to be verifiably FINAL — refused while PRE_GAME/IN_PROGRESS (no forecasting a recap).
 *   WEEK_REVIEW requires the target week to be WEEK_COMPLETE.
 *   NEXT_WEEK_OUTLOOK requires the PRIOR week to be WEEK_COMPLETE and the target (next) week to not itself be complete
 *     (an outlook is not a substitute for that week's own eventual Pregame/Weekly Books).
 * No caller may bypass this by asking a different way: `gateFrontier` is the single choke point `contents.ts` calls.
 */
import { isCompleted, type RawNflScheduleGame } from "@/lib/canonical/nfl-reality-frontier";
import type { BookFrontier, BookType, GameFrontierState } from "./schema";

/** Mirrors `lib/weekly-audit/week-closure.ts::WeekClosureStatus` by value (never imported — analysis-book stays isolated from lib/weekly*, see test/analysis-book-isolation.test.ts). Both sides are pinned to the same three literals by test/weekly-audit-week-closure.test.ts and test/analysis-book-frontier.test.ts. */
export type WeekClosureStatus = "WEEK_IN_PROGRESS" | "WEEK_COMPLETE" | "WEEK_INCOMPLETE_SOURCE_CONFLICT";

export const FRONTIER_SOURCE = "sleeper:/schedule/nfl/regular/{season}";

/** Pure. Determines one game's frontier state from its two sides' schedule rows (both sides always report the same game). */
export function determineGameFrontier(games: readonly RawNflScheduleGame[], team: string, opponent: string, week: number): GameFrontierState {
  const g = games.find((x) => x.week === week && ((x.home === team && x.away === opponent) || (x.home === opponent && x.away === team)));
  if (!g) return "UNKNOWN";
  if (isCompleted(g)) return "FINAL";
  const status = (g.status ?? "").trim().toLowerCase();
  if (!status || status === "pre_game" || status === "scheduled") return "PRE_GAME";
  return "IN_PROGRESS"; // anything with an in-progress-shaped status (in_game, halftime, etc.) that is not yet "complete"
}

export function buildFrontier(o: { asOf: string; gameState?: GameFrontierState | null; weekClosure?: WeekClosureStatus | null }): BookFrontier {
  return { as_of: o.asOf, game_state: o.gameState ?? null, week_closure: o.weekClosure ?? null, source: FRONTIER_SOURCE };
}

export interface FrontierGateResult { allowed: boolean; reason: string }

/** The single choke point. A book type with no lifecycle temporal claim (e.g. PLAYER_ANALYSIS) is always allowed — Phase 10 adds a gate, it does not narrow anything that already worked. */
export function gateFrontier(type: BookType, frontier: BookFrontier | null | undefined): FrontierGateResult {
  const lifecycle: ReadonlySet<BookType> = new Set(["PREGAME", "POSTGAME", "WEEK_REVIEW", "NEXT_WEEK_OUTLOOK"]);
  if (!lifecycle.has(type)) return { allowed: true, reason: "not a lifecycle book type; no temporal-frontier claim to gate" };
  if (!frontier) return { allowed: false, reason: `${type} requires a real, already-fetched temporal frontier (game/week completion) — none was supplied` };

  if (type === "PREGAME") {
    if (frontier.game_state == null) return { allowed: false, reason: "PREGAME requires a known game frontier state (schedule lookup failed or the game could not be identified)" };
    return frontier.game_state === "PRE_GAME"
      ? { allowed: true, reason: "the target game is verifiably not yet started" }
      : { allowed: false, reason: `PREGAME refused: the target game is ${frontier.game_state}, not PRE_GAME — a Pregame Book must never be created once kickoff evidence exists (no hindsight leakage)` };
  }
  if (type === "POSTGAME") {
    if (frontier.game_state == null) return { allowed: false, reason: "POSTGAME requires a known game frontier state (schedule lookup failed or the game could not be identified)" };
    return frontier.game_state === "FINAL"
      ? { allowed: true, reason: "the target game is verifiably final" }
      : { allowed: false, reason: `POSTGAME refused: the target game is ${frontier.game_state}, not FINAL — a Postgame Book must never forecast a result that has not happened` };
  }
  if (type === "WEEK_REVIEW") {
    return frontier.week_closure === "WEEK_COMPLETE"
      ? { allowed: true, reason: "the target week is verifiably complete" }
      : { allowed: false, reason: `WEEK_REVIEW refused: week closure is ${frontier.week_closure ?? "unknown"}, not WEEK_COMPLETE — a Weekly Review must never present an in-progress week as final` };
  }
  // NEXT_WEEK_OUTLOOK: the caller supplies week_closure for the PRIOR (completed) week that the outlook is built from.
  return frontier.week_closure === "WEEK_COMPLETE"
    ? { allowed: true, reason: "the prior week (the outlook's evidence base) is verifiably complete" }
    : { allowed: false, reason: `NEXT_WEEK_OUTLOOK refused: the prior week's closure is ${frontier.week_closure ?? "unknown"}, not WEEK_COMPLETE — an outlook must be built from a completed week, not a forecast of one` };
}
