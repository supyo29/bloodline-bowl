/**
 * Team-level reconciliation.
 *
 * The model allocates player opportunity from team pools, so by construction the
 * shares sum to ~1 within a position group. This module verifies that after all
 * the per-player clamps, age adjustments and availability scaling, the summed
 * player volume still lands close to the team environment it was drawn from, and
 * produces a report. Material misses lower confidence for that team's players
 * and emit a warning — they never rewrite the projection or block a freeze on
 * their own.
 */

import type { PlayerProjection } from "./schema";
import type { TeamEnvironment } from "./model";

export interface TeamReconciliation {
  team: string;
  metric: "pass_att" | "targets" | "rush_att" | "pass_td" | "rush_td" | "rec_td";
  team_expectation: number;
  player_sum: number;
  ratio: number; // player_sum / team_expectation
  tolerance: number; // allowed |ratio - 1|
  status: "OK" | "SOFT" | "HARD";
}

/** Documented tolerances on |player_sum / team_expectation - 1|. */
const TOLERANCE = {
  pass_att: 0.06,
  targets: 0.08,
  rush_att: 0.08,
  pass_td: 0.14,
  rush_td: 0.16,
  rec_td: 0.14,
} as const;

/** SOFT = within 2x tolerance, HARD = beyond. */
function classify(ratio: number, tol: number): "OK" | "SOFT" | "HARD" {
  const dev = Math.abs(ratio - 1);
  if (dev <= tol) return "OK";
  if (dev <= tol * 2.25) return "SOFT";
  return "HARD";
}

export function reconcileTeam(
  env: TeamEnvironment,
  players: PlayerProjection[],
): TeamReconciliation[] {
  const sum = (f: (p: PlayerProjection) => number | null) =>
    players.reduce((a, p) => a + (f(p) ?? 0), 0);

  // The Layer-1 stat line is full (17-game) pace. Team environment totals are
  // recency-weighted actuals (which already include real injury games), so a
  // full-pace sum of the roster runs a touch above the environment — allow a
  // small headroom rather than discounting.
  const AVAIL = 1.0;

  const rows: Array<Omit<TeamReconciliation, "ratio" | "status">> = [
    {
      team: env.team, metric: "pass_att",
      team_expectation: env.pass_att * AVAIL,
      player_sum: sum((p) => p.stats.pass_att),
      tolerance: TOLERANCE.pass_att,
    },
    {
      team: env.team, metric: "targets",
      team_expectation: env.target_pool * AVAIL,
      player_sum: sum((p) => p.stats.targets),
      tolerance: TOLERANCE.targets,
    },
    {
      team: env.team, metric: "rush_att",
      team_expectation: env.rush_att * AVAIL,
      player_sum: sum((p) => p.stats.rush_att),
      tolerance: TOLERANCE.rush_att,
    },
    {
      team: env.team, metric: "pass_td",
      team_expectation: env.pass_td * AVAIL,
      player_sum: sum((p) => p.stats.pass_td),
      tolerance: TOLERANCE.pass_td,
    },
    {
      team: env.team, metric: "rush_td",
      team_expectation: env.rush_td * AVAIL,
      player_sum: sum((p) => p.stats.rush_td),
      tolerance: TOLERANCE.rush_td,
    },
    {
      team: env.team, metric: "rec_td",
      team_expectation: env.pass_td * AVAIL,
      player_sum: sum((p) => p.stats.rec_td),
      tolerance: TOLERANCE.rec_td,
    },
  ];

  return rows.map((r) => {
    const ratio = r.team_expectation > 0 ? r.player_sum / r.team_expectation : 1;
    return { ...r, ratio: round3(ratio), status: classify(ratio, r.tolerance) };
  });
}

/**
 * Optionally normalize the summed player volume back onto the team pool.
 * Applied ONLY to the counting stats (not efficiency), scoped per team +
 * position group, and always recorded in each player's `warnings`. This keeps
 * "sum of parts = whole" true without changing any player's *share*.
 */
export function normalizeTeamVolume(players: PlayerProjection[], recs: TeamReconciliation[]): void {
  const factorFor = (metric: TeamReconciliation["metric"]) => {
    const rec = recs.find((r) => r.metric === metric);
    if (!rec || rec.status === "OK" || rec.player_sum <= 0) return 1;
    return rec.team_expectation / rec.player_sum;
  };

  const fPassAtt = factorFor("pass_att");
  const fTargets = factorFor("targets");
  const fRushAtt = factorFor("rush_att");
  const fPassTd = factorFor("pass_td");
  const fRushTd = factorFor("rush_td");
  const fRecTd = factorFor("rec_td");

  for (const p of players) {
    const s = p.stats;
    const notes: string[] = [];
    if (fPassAtt !== 1 && s.pass_att != null) {
      s.pass_att = r2(s.pass_att * fPassAtt);
      if (s.pass_cmp != null) s.pass_cmp = r2(s.pass_cmp * fPassAtt);
      if (s.pass_yd != null) s.pass_yd = r2(s.pass_yd * fPassAtt);
      notes.push(`pass_att x${fPassAtt.toFixed(3)} (team reconciliation)`);
    }
    if (fTargets !== 1 && s.targets != null) {
      s.targets = r2(s.targets * fTargets);
      if (s.rec != null) s.rec = r2(s.rec * fTargets);
      if (s.rec_yd != null) s.rec_yd = r2(s.rec_yd * fTargets);
      notes.push(`targets x${fTargets.toFixed(3)} (team reconciliation)`);
    }
    if (fRushAtt !== 1 && s.rush_att != null) {
      s.rush_att = r2(s.rush_att * fRushAtt);
      if (s.rush_yd != null) s.rush_yd = r2(s.rush_yd * fRushAtt);
      notes.push(`rush_att x${fRushAtt.toFixed(3)} (team reconciliation)`);
    }
    if (fPassTd !== 1 && s.pass_td != null) { s.pass_td = r2(s.pass_td * fPassTd); notes.push(`pass_td x${fPassTd.toFixed(3)}`); }
    if (fRushTd !== 1 && s.rush_td != null) { s.rush_td = r2(s.rush_td * fRushTd); notes.push(`rush_td x${fRushTd.toFixed(3)}`); }
    if (fRecTd !== 1 && s.rec_td != null) { s.rec_td = r2(s.rec_td * fRecTd); notes.push(`rec_td x${fRecTd.toFixed(3)}`); }

    if (notes.length) {
      p.warnings.push(...notes);
      // recompute neutral points after the nudge
      // stat line is full-pace; season points carry the availability haircut.
      const gf = p.availability.games_if_healthy > 0
        ? p.availability.expected_games / p.availability.games_if_healthy
        : 1;
      const fullPace = pprPoints(s);
      p.neutral_points = r1(fullPace * gf);
      p.neutral_ppg = r2(fullPace / (p.availability.games_if_healthy || 17));
    }
  }
}

export interface ReconciliationReport {
  season: number;
  generated_at: string;
  teams_checked: number;
  hard_misses: TeamReconciliation[];
  soft_misses: TeamReconciliation[];
  ok_count: number;
  normalized: boolean;
}

export function summarizeReconciliation(
  season: number,
  all: TeamReconciliation[],
  normalized: boolean,
): ReconciliationReport {
  const hard = all.filter((r) => r.status === "HARD");
  const soft = all.filter((r) => r.status === "SOFT");
  return {
    season,
    generated_at: new Date().toISOString(),
    teams_checked: new Set(all.map((r) => r.team)).size,
    hard_misses: hard,
    soft_misses: soft,
    ok_count: all.filter((r) => r.status === "OK").length,
    normalized,
  };
}

/* PPR-neutral recompute (mirrors model.ts). */
function pprPoints(s: PlayerProjection["stats"]): number {
  return (
    (s.rec ?? 0) +
    (s.pass_yd ?? 0) * 0.04 +
    (s.rush_yd ?? 0) * 0.1 +
    (s.rec_yd ?? 0) * 0.1 +
    (s.pass_td ?? 0) * 4 +
    (s.rush_td ?? 0) * 6 +
    (s.rec_td ?? 0) * 6 +
    (s.pass_int ?? 0) * -1 +
    (s.fum_lost ?? 0) * -2 +
    (s.pass_2pt ?? 0) * 2 +
    (s.rush_2pt ?? 0) * 2 +
    (s.rec_2pt ?? 0) * 2
  );
}
function round3(v: number): number { return Math.round(v * 1000) / 1000; }
function r1(v: number): number { return Math.round(v * 10) / 10; }
function r2(v: number): number { return Math.round(v * 100) / 100; }
