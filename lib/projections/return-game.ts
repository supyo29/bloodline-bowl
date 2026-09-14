/**
 * Individual return-game projection — `ri-return-game-2026.1`.
 *
 * The frozen structural offensive model (`ri-structural-2026.3`,
 * `lib/projections/model.ts`) answers "what does this player project to do on
 * OFFENSE?" and has never modeled kickoff/punt returns. This module answers a
 * separate question — "what individual return-game ROLE and production does
 * this player project to have?" — as an isolated, additive enrichment. It does
 * NOT touch `projectTeamOffense`, `pprPoints`, or any structural-model
 * calibration.
 *
 * Design:
 *   - Scoring-neutral: the numbers this module produces feed `stats.kr_yd` /
 *     `stats.pr_yd` only. They never enter `pprPoints()` / `neutral_points`
 *     (the PPR-neutral proxy has no return-yardage component to begin with,
 *     so this is automatic, not a special case). League points come later,
 *     through the normal Layer 2 `calculateFantasyPoints` path.
 *   - Opportunity over efficiency: role (attempts) is the primary signal;
 *     yards-per-return is a secondary efficiency shrinkage, not the driver.
 *   - Role evidence, not raw fantasy totals: a player qualifies for a return
 *     projection because Sleeper's box score shows him actually returning
 *     kicks/punts, never because he is a good receiver who "should" return.
 *   - Recency-weighted with a hard role-continuity gate: a return role is one
 *     of the least stable jobs in football (beaten out in camp, replaced
 *     after a muff, a receiver "promoted" off returns once he breaks out at
 *     his primary position). A player whose MOST RECENT season on record
 *     shows materially reduced-or-no return work is not confidently
 *     extrapolated forward from an older season — confidence is downgraded
 *     and the projection is shrunk hard toward zero rather than continued at
 *     the old rate.
 *   - Bounded, not blindly per-17: per-game return-yard rate is clamped to
 *     sane bounds before scaling to a season, so one monster game (or a small
 *     sample) cannot produce an implausible season total.
 *   - `null`, not `0`: a player with no return-role evidence gets
 *     `kr_yd: null` / `pr_yd: null` ("not modeled"), never a fabricated zero
 *     that would look like a confident "he will return zero kicks".
 *
 * Only offense-eligible positions (WR/RB, occasionally TE/QB in real football
 * but never rostered as returners in practice) are considered; K/DEF are out
 * of scope for this module (DEF team-level return yards are handled by
 * `lib/projections/special-teams.ts` via `def_kr_yd`/`def_pr_yd`, a completely
 * separate stat namespace — no overlap, no double-count).
 */

import type { SeasonActuals } from "./actuals";
import type { FantasyPosition, PlayerProjection, ProjectionConfidence } from "./schema";

export const RETURN_GAME_MODEL_VERSION = "ri-return-game-2026.1";

/** A player needs at least this many attempts in a season for that season to
 *  count as role evidence (filters out mop-up / injury-emergency returns). */
const MIN_ATTEMPTS_FOR_ROLE = 3;

/** Recency weights, most-recent-season first. A 4th+ season back is ignored. */
const RECENCY_WEIGHTS = [1.0, 0.45, 0.18];

/** Sane per-game yard-rate bounds (season/17 will be clamped into this range
 *  before being scaled back up) — guards against small-sample outliers. */
const KR_YD_PER_GAME_MAX = 32;
const PR_YD_PER_GAME_MAX = 22;

const RETURN_ELIGIBLE: ReadonlySet<FantasyPosition> = new Set(["WR", "RB", "TE", "QB"]);

export interface ReturnGameProjection {
  player_id: string;
  /** Full 17-game pace, matching the Layer-1 convention for every other stat
   *  in `ProjectedFootballStats` (the availability haircut is applied later,
   *  downstream, exactly as it is for every other stat). `null` = no
   *  projected return role. */
  kr_yd: number | null;
  pr_yd: number | null;
  role_confidence: ProjectionConfidence;
  /** Seasons (descending) whose box score showed return-role evidence. */
  seasons_with_role: number[];
  notes: string[];
}

interface PlayerReturnRow {
  season: number;
  gp: number;
  kr: number;
  kr_yd: number;
  pr: number;
  pr_yd: number;
}

/**
 * Recency-weighted per-game rate for one return type, gated by whether the
 * MOST RECENT season on record shows role evidence. Returns `null` when there
 * is no usable evidence at all.
 */
function weightedRate(
  rows: PlayerReturnRow[], // descending by season, most recent first
  attempts: (r: PlayerReturnRow) => number,
  yards: (r: PlayerReturnRow) => number,
  perGameCap: number,
): { perGame: number; confidence: ProjectionConfidence; seasonsUsed: number[]; roleContinuity: boolean } | null {
  const withEvidence = rows.filter((r) => attempts(r) >= MIN_ATTEMPTS_FOR_ROLE && r.gp > 0);
  if (withEvidence.length === 0) return null;

  const mostRecent = rows[0]!;
  const roleContinuity = attempts(mostRecent) >= MIN_ATTEMPTS_FOR_ROLE;

  let wSum = 0;
  let wRateSum = 0;
  const seasonsUsed: number[] = [];
  withEvidence.slice(0, RECENCY_WEIGHTS.length).forEach((r, i) => {
    const w = RECENCY_WEIGHTS[i] ?? 0;
    const rate = clamp(yards(r) / Math.max(1, r.gp), 0, perGameCap);
    wSum += w;
    wRateSum += w * rate;
    seasonsUsed.push(r.season);
  });
  if (wSum === 0) return null;
  let perGame = wRateSum / wSum;

  // Role-continuity gate: the most recent season is NOT itself role evidence
  // (return job likely lost/handed off) -> shrink hard rather than keep
  // extrapolating an old rate at full strength.
  if (!roleContinuity) perGame *= 0.35;

  const sampleSeasons = withEvidence.length;
  let confidence: ProjectionConfidence;
  if (roleContinuity && sampleSeasons >= 2) confidence = "HIGH";
  else if (roleContinuity) confidence = "MEDIUM";
  else confidence = "LOW";

  return { perGame: clamp(perGame, 0, perGameCap), confidence, seasonsUsed, roleContinuity };
}

/**
 * Build return-game projections for every player with return-role evidence in
 * `seasons` (most-recent-season-first order is NOT required — this function
 * sorts by season itself).
 */
export function projectReturnGame(seasons: SeasonActuals[]): Map<string, ReturnGameProjection> {
  const byPlayer = new Map<string, PlayerReturnRow[]>();
  for (const sa of seasons) {
    for (const [pid, row] of sa.players) {
      if (row.position != null && !RETURN_ELIGIBLE.has(row.position)) continue;
      // Every season row is kept here, including all-zero ones: a season with
      // NO return work is itself the signal that matters for the
      // role-continuity gate below (a player who returned kicks two years ago
      // but zero last season should NOT be confidently extrapolated forward).
      // `weightedRate` below is what actually decides whether a player has any
      // return-role evidence at all.
      if (!byPlayer.has(pid)) byPlayer.set(pid, []);
      byPlayer.get(pid)!.push({
        season: sa.season,
        gp: row.gp,
        kr: row.kr,
        kr_yd: row.kr_yd,
        pr: row.pr,
        pr_yd: row.pr_yd,
      });
    }
  }

  const out = new Map<string, ReturnGameProjection>();
  for (const [pid, rowsUnsorted] of byPlayer) {
    const rows = [...rowsUnsorted].sort((a, b) => b.season - a.season);

    const kr = weightedRate(rows, (r) => r.kr, (r) => r.kr_yd, KR_YD_PER_GAME_MAX);
    const pr = weightedRate(rows, (r) => r.pr, (r) => r.pr_yd, PR_YD_PER_GAME_MAX);
    if (!kr && !pr) continue;

    const notes: string[] = [];
    const seasonsWithRole = new Set<number>();
    let krYd: number | null = null;
    let prYd: number | null = null;
    let confidence: ProjectionConfidence = "VERY_LOW";

    if (kr) {
      krYd = round1(kr.perGame * 17);
      kr.seasonsUsed.forEach((s) => seasonsWithRole.add(s));
      if (!kr.roleContinuity) notes.push("KR: most recent season shows minimal/no kickoff-return work — shrunk toward zero, not extrapolated at the old rate");
      confidence = betterConfidence(confidence, kr.confidence);
    }
    if (pr) {
      prYd = round1(pr.perGame * 17);
      pr.seasonsUsed.forEach((s) => seasonsWithRole.add(s));
      if (!pr.roleContinuity) notes.push("PR: most recent season shows minimal/no punt-return work — shrunk toward zero, not extrapolated at the old rate");
      confidence = betterConfidence(confidence, pr.confidence);
    }

    out.set(pid, {
      player_id: pid,
      kr_yd: krYd,
      pr_yd: prYd,
      role_confidence: confidence,
      seasons_with_role: [...seasonsWithRole].sort((a, b) => b - a),
      notes,
    });
  }
  return out;
}

/**
 * Merge return-game projections into an already-built offensive projection
 * pool. Additive only: sets `stats.kr_yd` / `stats.pr_yd` on the matching
 * player, appends a provenance warning, and touches NOTHING else on the
 * record — `neutral_points`, `outcome`, `components`, and `confidence.bucket`
 * (the player's overall projection confidence) are left exactly as the
 * structural model produced them. `sources` gets an entry so lineage/audit
 * tooling can see the return-game model contributed to this player.
 */
export function applyReturnGameProjections(
  projections: Map<string, PlayerProjection>,
  returnGame: Map<string, ReturnGameProjection>,
): number {
  let applied = 0;
  for (const [pid, rg] of returnGame) {
    const p = projections.get(pid);
    if (!p) continue; // not on an active roster this build cares about
    if (rg.kr_yd == null && rg.pr_yd == null) continue;
    p.stats.kr_yd = rg.kr_yd;
    p.stats.pr_yd = rg.pr_yd;
    p.sources[RETURN_GAME_MODEL_VERSION] = { role: "MODEL_INPUT", used: true };
    p.warnings.push(
      `return-game (${RETURN_GAME_MODEL_VERSION}, ${rg.role_confidence} confidence): ` +
        `kr_yd=${rg.kr_yd ?? "n/a"} pr_yd=${rg.pr_yd ?? "n/a"} from seasons ${rg.seasons_with_role.join(",") || "n/a"}` +
        (rg.notes.length ? ` — ${rg.notes.join("; ")}` : ""),
    );
    applied += 1;
  }
  return applied;
}

const CONF_RANK: Record<ProjectionConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };
function betterConfidence(a: ProjectionConfidence, b: ProjectionConfidence): ProjectionConfidence {
  return CONF_RANK[b] > CONF_RANK[a] ? b : a;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
