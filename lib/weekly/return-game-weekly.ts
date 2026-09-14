/**
 * Weekly kickoff-return projection enrichment — `ri-return-game-weekly-2026.1`.
 *
 * The gap this closes: Sleeper's weekly projection feed (`SleeperWeeklyProjectionProvider`)
 * omits individual `kr`/`kr_yd` ENTIRELY (live-verified — see the return-game
 * repair checkpoints), so a real kickoff returner projects as if he never
 * touches the ball on special teams, week after week, even though the SEASON
 * return-game model (`lib/projections/return-game.ts`) already knows he has a
 * role. Punt returns are NOT affected — Sleeper's weekly feed DOES supply
 * individual `pr`/`pr_yd`/`pr_td`, so `SleeperWeeklyProjectionProvider`
 * already scores them correctly with no enrichment (provider-first).
 *
 * Architecture (Phase 2 of the certification spec):
 *   Sleeper weekly football projection
 *     -> return-game weekly enrichment (THIS FILE — adds `kr_yd` only)
 *     -> combined football stat line
 *     -> existing scoreWeeklyLine() -> calculateFantasyPoints()
 *     -> weekly/start-sit outputs
 *
 * This module does NOT touch `calculateFantasyPoints()` and does NOT add a
 * fantasy-point bonus anywhere — it adds one football stat (`kr_yd`, Sleeper's
 * own scoring-key namespace) to the stat line the existing scorer already
 * knows how to price.
 *
 * Provider-first merge policy (Phase 7): if the raw weekly entry ALREADY
 * carries a `kr_yd` key (any value, including a real 0 — Sleeper starting to
 * publish this, or a future schema change), it is trusted as-is and this
 * module changes nothing. Enrichment only fires when the key is ABSENT.
 * `pr_yd` is never touched here at all — Sleeper supplies it and no
 * second source should stack on top of a real provider number.
 *
 * Weekly translation, NOT a blind season/17 (Phase 4/5): the season baseline
 * consumed here (`ReturnGameSeasonSignal.kr_yd`) is already the OUTPUT of
 * `projectReturnGame()` — recency-weighted across seasons, role-continuity
 * gated, and bounded (see `lib/projections/return-game.ts`), never a naive
 * historical total. This module adds a SECOND, in-season gate on top: the
 * player's most recent 1-3 COMPLETED games this season. Two consecutive
 * recent games with zero KR attempts suppress the projection entirely (role
 * almost certainly lost/handed to a teammate) — never a single zero-attempt
 * game, per spec. One zero-attempt game with no corroboration damps the
 * estimate instead of suppressing it outright, preferring a false negative
 * over confidently extrapolating a stale role.
 */

import { getWeeklyStats } from "@/lib/sleeper/client";
import { buildBaseProjections } from "@/lib/projections/build";
import { KR_YD_PER_GAME_MAX } from "@/lib/projections/return-game";

export const RETURN_GAME_WEEKLY_MODEL_VERSION = "ri-return-game-weekly-2026.1";

/** Per-player season-model return signal, keyed by Sleeper player_id (matches
 *  `PlayerProjection.player_id`, which IS the Sleeper id in this codebase). */
export interface ReturnGameSeasonSignal {
  kr_yd: number | null;
  pr_yd: number | null;
}

export interface RiReturnGameSeasonResult {
  status: "READY" | "UNAVAILABLE";
  by_sleeper_id: Map<string, ReturnGameSeasonSignal>;
  warning: string | null;
}

/**
 * Best-effort accessor for the season return-game signal, mirroring
 * `RosterIntelSeasonSignalProvider` (`lib/weekly/projections-ri.ts`): failure
 * here NEVER blocks weekly projections — the caller just gets an empty map
 * and weekly KR enrichment is skipped for that request. Cheap on repeat calls
 * within the same process: `buildBaseProjections` caches its result in module
 * scope per (season, calibration).
 */
export class RosterIntelReturnGameSeasonProvider {
  readonly name = "roster_intel_return_game_season";

  async getSeasonSignal(season: number): Promise<RiReturnGameSeasonResult> {
    try {
      const base = await buildBaseProjections({ season });
      const map = new Map<string, ReturnGameSeasonSignal>();
      for (const [pid, p] of base.projections) {
        if (p.stats.kr_yd == null && p.stats.pr_yd == null) continue;
        map.set(pid, { kr_yd: p.stats.kr_yd, pr_yd: p.stats.pr_yd });
      }
      return { status: "READY", by_sleeper_id: map, warning: null };
    } catch (error) {
      return {
        status: "UNAVAILABLE",
        by_sleeper_id: new Map(),
        warning: `Roster Intel return-game season signal unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

/**
 * Recent completed-week kickoff-return ATTEMPTS for every player, most-recent
 * week first. `uptoWeekExclusive` is the week being projected (its own game
 * hasn't happened yet) — this looks at `[uptoWeekExclusive-1 .. -lookbackWeeks]`,
 * clamped to real weeks (>=1). Best-effort per week: a failed fetch for one
 * week just shortens the window rather than failing the whole call, since a
 * shorter window degrades gracefully (see `weeklyKrYdEnrichment`).
 */
export async function fetchRecentReturnAttempts(
  season: number,
  uptoWeekExclusive: number,
  lookbackWeeks = 3,
): Promise<Map<string, number[]>> {
  const weeks: number[] = [];
  for (let w = uptoWeekExclusive - 1; w >= Math.max(1, uptoWeekExclusive - lookbackWeeks); w--) weeks.push(w);

  const perWeek = await Promise.all(
    weeks.map((w) =>
      getWeeklyStats(String(season), w).catch(() => null as Record<string, Record<string, number>> | null),
    ),
  );

  const out = new Map<string, number[]>();
  for (const raw of perWeek) {
    if (!raw) continue; // that week's fetch failed — window is simply shorter
    for (const [pid, st] of Object.entries(raw)) {
      if (pid.startsWith("TEAM_")) continue;
      const attempts = typeof st.kr === "number" && Number.isFinite(st.kr) ? st.kr : 0;
      if (!out.has(pid)) out.set(pid, []);
      out.get(pid)!.push(attempts);
    }
  }
  return out;
}

export interface WeeklyKrYdEnrichment {
  /** Full-precision weekly kr_yd estimate, or `null` when nothing should be added. */
  kr_yd: number | null;
  role_confidence: "HIGH" | "MEDIUM" | "LOW";
  notes: string[];
}

/**
 * Pure, deterministic weekly translation + role-continuity gate. See file
 * header for the documented rule. `recentAttemptsMostRecentFirst` covers as
 * many of the last 3 completed weeks as were fetchable (0..3 entries) — an
 * empty array means "no in-season data yet" (e.g. week 1, or the fetch
 * failed), which trusts the season model without further gating.
 */
export function weeklyKrYdEnrichment(
  seasonKrYdFullPace: number | null,
  recentAttemptsMostRecentFirst: number[] = [],
): WeeklyKrYdEnrichment {
  if (seasonKrYdFullPace == null || seasonKrYdFullPace <= 0) {
    return { kr_yd: null, role_confidence: "LOW", notes: ["no season-model KR role evidence"] };
  }
  const baseWeekly = clamp(seasonKrYdFullPace / 17, 0, KR_YD_PER_GAME_MAX);

  const recent = recentAttemptsMostRecentFirst;
  if (recent.length >= 2 && recent.slice(0, 2).every((a) => a === 0)) {
    return {
      kr_yd: null,
      role_confidence: "LOW",
      notes: [
        `role continuity: 0 KR attempts in each of the last ${recent.length >= 3 ? 3 : 2} completed games — ` +
          "suppressed rather than extrapolated from the season baseline (2+ consecutive zero-attempt games required to suppress; a single zero-attempt game never triggers this)",
      ],
    };
  }
  if (recent.length >= 1 && recent[0] === 0) {
    return {
      kr_yd: round1(baseWeekly * 0.5),
      role_confidence: "LOW",
      notes: ["single recent zero-attempt game — not enough to confirm role loss, damped 50% pending another game's evidence"],
    };
  }
  if (recent.length >= 1 && (recent[0] ?? 0) > 0) {
    return { kr_yd: round1(baseWeekly), role_confidence: "HIGH", notes: ["role confirmed by KR attempts in the most recent completed game"] };
  }
  // No in-season data yet (week 1, or all recent-week fetches failed) — trust
  // the already role-gated season model without further adjustment.
  return { kr_yd: round1(baseWeekly), role_confidence: "MEDIUM", notes: ["no in-season game data yet to corroborate/refute the season role — using the season-model baseline as-is"] };
}

/**
 * Merge KR enrichment into ONE player's raw weekly stat line. Provider-first
 * (Phase 7): if `rawStats` already has a `kr_yd` key — any value — this
 * returns `rawStats` completely unchanged. `pr_yd` is never added or altered
 * here under any circumstance (Sleeper's own weekly `pr_yd` is authoritative
 * when present; this module has no opinion when it's absent, by design, to
 * avoid inventing a punt-return number the certification spec did not ask
 * for and real data shows is rarely if ever missing).
 */
export function enrichWeeklyStatsWithReturnGame(
  rawStats: Record<string, number>,
  sleeperPlayerId: string,
  seasonSignal: ReadonlyMap<string, ReturnGameSeasonSignal> | undefined,
  recentAttempts: ReadonlyMap<string, number[]> | undefined,
): { stats: Record<string, number>; warnings: string[] } {
  if ("kr_yd" in rawStats) return { stats: rawStats, warnings: [] };
  const season = seasonSignal?.get(sleeperPlayerId);
  if (!season || season.kr_yd == null) return { stats: rawStats, warnings: [] };

  const enrichment = weeklyKrYdEnrichment(season.kr_yd, [...(recentAttempts?.get(sleeperPlayerId) ?? [])]);
  if (enrichment.kr_yd == null || enrichment.kr_yd <= 0) return { stats: rawStats, warnings: [] };

  return {
    stats: { ...rawStats, kr_yd: enrichment.kr_yd },
    warnings: [
      `weekly_kr_yd_enrichment (${RETURN_GAME_WEEKLY_MODEL_VERSION}, ${enrichment.role_confidence} confidence): ` +
        `kr_yd=${enrichment.kr_yd} — Sleeper's weekly feed does not publish individual kickoff-return projections; ` +
        `${enrichment.notes.join("; ")}`,
    ],
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
