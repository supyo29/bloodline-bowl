/**
 * Matchup Intelligence + Matchup Leverage.
 *
 * Both teams are evaluated on their BEST LEGAL projected starting lineup (via
 * the same Hungarian optimizer), so a manager who is not yet optimal is still
 * measured at their ceiling, not their mistakes. Returns projected totals,
 * margin, positional advantages/disadvantages, high-leverage & swing players,
 * bench-depth comparison, and replacement vulnerability.
 *
 * Win probability: a seeded Monte-Carlo over per-player Normal(proj, sd) draws.
 * The SDs are the documented position-volatility heuristic and player outcomes
 * are drawn independently — so probability is returned with an explicit
 * `method` and LOW `confidence`, and is OMITTED when projection coverage is too
 * thin to simulate defensibly. It is NOT a spread-to-probability conversion.
 */

import { buildOptimalLineup, type LineupResult } from "./lineup";
import { mulberry32, sampleNormal } from "./uncertainty";
import type { WeeklyTeamContext, WeeklyWarning } from "./schema";
import type { CanonicalPlayer } from "@/lib/canonical/schema";

const SIM_TRIALS = 20000;
const MIN_COVERAGE_FOR_PROB = 0.7;

export interface PositionalEdge {
  position: string;
  team_points: number;
  opponent_points: number;
  edge: number;
}

export interface SwingPlayer {
  canonical_player_id: string;
  side: "team" | "opponent";
  position: string;
  projected: number | null;
  expected_availability: number;
  injury_status: string | null;
  swing_note: string;
}

export interface MatchupResult {
  week: number;
  team_id: string;
  opponent_team_id: string | null;
  has_opponent: boolean;

  team_optimal_total: number | null;
  opponent_optimal_total: number | null;
  /** Always-available known subtotals (UNKNOWN starters excluded). */
  team_known_subtotal: number;
  opponent_known_subtotal: number;
  projected_margin: number | null;
  projected_margin_status: "COMPLETE" | "PARTIAL_PROVISIONAL" | "UNAVAILABLE";
  margin_confidence: "HIGH" | "MEDIUM" | "LOW";

  win_probability: number | null;
  win_probability_method: string | null;
  win_probability_confidence: "LOW" | "UNAVAILABLE";

  positional_advantages: PositionalEdge[];
  positional_disadvantages: PositionalEdge[];
  high_leverage_players: Array<{ canonical_player_id: string; position: string; projected: number | null; note: string }>;
  swing_players: SwingPlayer[];
  bench_depth: { team_bench_projected_top3: number; opponent_bench_projected_top3: number; advantage: "team" | "opponent" | "even" };
  replacement_vulnerability: Array<{ position: string; note: string; gap: number | null }>;

  team_lineup: LineupResult;
  opponent_lineup: LineupResult | null;
  warnings: WeeklyWarning[];
}

export function buildMatchup(ctx: WeeklyTeamContext): MatchupResult {
  const warnings: WeeklyWarning[] = [];
  const players = new Map<string, CanonicalPlayer>(ctx.all_rostered.map((p) => [p.canonical_player_id, p]));
  for (const p of ctx.opponent?.all_rostered ?? []) players.set(p.canonical_player_id, p);

  const teamLineup = buildOptimalLineup({
    week: ctx.league.week,
    roster: ctx.roster,
    constraints: ctx.league.roster_constraints,
    players,
    projections: ctx.projections,
  });

  if (!ctx.opponent || !ctx.opponent.roster) {
    return {
      week: ctx.league.week,
      team_id: ctx.fantasy_team.canonical_team_id,
      opponent_team_id: ctx.opponent?.fantasy_team.canonical_team_id ?? null,
      has_opponent: false,
      team_optimal_total: teamLineup.optimal_total,
      opponent_optimal_total: null,
      team_known_subtotal: teamLineup.known_optimal_subtotal,
      opponent_known_subtotal: 0,
      projected_margin: null,
      projected_margin_status: "UNAVAILABLE",
      margin_confidence: "LOW",
      win_probability: null,
      win_probability_method: null,
      win_probability_confidence: "UNAVAILABLE",
      positional_advantages: [],
      positional_disadvantages: [],
      high_leverage_players: [],
      swing_players: [],
      bench_depth: { team_bench_projected_top3: benchTop3(ctx, ctx.roster.bench), opponent_bench_projected_top3: 0, advantage: "even" },
      replacement_vulnerability: [],
      team_lineup: teamLineup,
      opponent_lineup: null,
      warnings: [{ code: "no_opponent", message: `No opponent for week ${ctx.league.week}.`, severity: "info" }],
    };
  }

  const oppLineup = buildOptimalLineup({
    week: ctx.league.week,
    roster: ctx.opponent.roster,
    constraints: ctx.league.roster_constraints,
    players,
    projections: ctx.projections,
  });

  // Projected margin is only honest when BOTH optimal totals are fully supported
  // (no UNKNOWN starter silently contributing 0). Otherwise it is null and
  // flagged — never a silently-low number.
  const margin =
    teamLineup.optimal_total != null && oppLineup.optimal_total != null
      ? round2(teamLineup.optimal_total - oppLineup.optimal_total)
      : null;
  const margin_status: MatchupResult["projected_margin_status"] =
    margin == null
      ? "UNAVAILABLE"
      : teamLineup.optimality_status === "PROVISIONAL" || oppLineup.optimality_status === "PROVISIONAL"
        ? "PARTIAL_PROVISIONAL"
        : "COMPLETE";
  if (margin == null) {
    warnings.push({
      code: "projected_margin_unavailable",
      message:
        "Projected margin is unavailable — an UNKNOWN projected starter on one side would distort the total. Known subtotals are exposed on each team_lineup.",
      severity: "warning",
    });
  }

  // Positional edges from the OPTIMAL lineups.
  const teamBySlot = groupBySlotBase(teamLineup);
  const oppBySlot = groupBySlotBase(oppLineup);
  const allBases = uniq([...Object.keys(teamBySlot), ...Object.keys(oppBySlot)]);
  const edges: PositionalEdge[] = allBases
    .map((pos) => {
      const tp = teamBySlot[pos] ?? 0;
      const op = oppBySlot[pos] ?? 0;
      return { position: pos, team_points: round2(tp), opponent_points: round2(op), edge: round2(tp - op) };
    })
    .sort((a, b) => b.edge - a.edge);

  // Coverage for probability. Simulating requires BOTH optimal lineups to be
  // COMPLETE and fully projected — an UNKNOWN starter fed in as 0 (or an ignored
  // unknown bench player that could change the optimum) would produce a
  // confident-looking number off incomplete inputs.
  const coverage = lineupCoverage(teamLineup) * lineupCoverage(oppLineup);
  const bothComplete =
    teamLineup.optimality_status === "COMPLETE" &&
    oppLineup.optimality_status === "COMPLETE" &&
    teamLineup.optimal_total != null &&
    oppLineup.optimal_total != null;
  let win_probability: number | null = null;
  let win_probability_method: string | null = null;
  let win_probability_confidence: MatchupResult["win_probability_confidence"] = "UNAVAILABLE";
  if (coverage >= MIN_COVERAGE_FOR_PROB && bothComplete) {
    const rng = mulberry32(hashSeed(ctx.league.slug, ctx.fantasy_team.canonical_team_id, ctx.league.week));
    let wins = 0;
    const teamDraw = drawSpec(teamLineup, ctx);
    const oppDraw = drawSpec(oppLineup, ctx);
    for (let i = 0; i < SIM_TRIALS; i += 1) {
      let t = 0;
      let o = 0;
      for (const d of teamDraw) t += Math.max(0, sampleNormal(rng, d.mean, d.sd));
      for (const d of oppDraw) o += Math.max(0, sampleNormal(rng, d.mean, d.sd));
      if (t > o) wins += 1;
      else if (t === o) wins += 0.5;
    }
    win_probability = Math.round((wins / SIM_TRIALS) * 1000) / 1000;
    win_probability_method = "independent_normal_monte_carlo(position_volatility_heuristic_sd)";
    win_probability_confidence = "LOW";
    warnings.push({
      code: "win_probability_heuristic",
      message:
        "Win probability is a seeded Monte-Carlo over per-player Normal draws with heuristic SDs and independent outcomes — directional only, LOW confidence.",
      severity: "info",
    });
  } else {
    warnings.push({
      code: "win_probability_unavailable",
      message: !bothComplete
        ? "Win probability is not simulated — at least one optimal lineup is PROVISIONAL / not fully projected. An UNKNOWN starter must not be simulated as a numeric 0."
        : `Projection coverage ${(coverage * 100).toFixed(0)}% of starters is below the ${(MIN_COVERAGE_FOR_PROB * 100).toFixed(0)}% needed to simulate a defensible win probability.`,
      severity: "warning",
    });
  }

  const margin_confidence: MatchupResult["margin_confidence"] =
    margin == null || coverage < 0.6
      ? "LOW"
      : Math.abs(margin) >= 12
        ? "HIGH"
        : Math.abs(margin) >= 5
          ? "MEDIUM"
          : "LOW";

  // High-leverage: biggest contributors to my optimal total that also carry risk.
  const high_leverage_players = teamLineup.slots
    .filter((s) => s.recommended_player_id && (s.recommended_projected ?? 0) >= 12)
    .map((s) => ({
      canonical_player_id: s.recommended_player_id!,
      position: s.slot,
      projected: s.recommended_projected,
      note: `${(s.recommended_projected ?? 0).toFixed(1)} projected in ${s.slot} — a large share of the team total.`,
    }))
    .sort((a, b) => (b.projected ?? 0) - (a.projected ?? 0))
    .slice(0, 4);

  // Swing players: injury/availability risk on either optimal lineup.
  const swing_players: SwingPlayer[] = [];
  for (const [side, lineup] of [["team", teamLineup] as const, ["opponent", oppLineup] as const]) {
    for (const s of lineup.slots) {
      if (!s.recommended_player_id) continue;
      const wp = ctx.projections.by_player.get(s.recommended_player_id);
      if (wp && (wp.expected_availability < 0.9 || (wp.injury_status && wp.injury_status.toLowerCase() !== "active"))) {
        swing_players.push({
          canonical_player_id: s.recommended_player_id,
          side,
          position: s.slot,
          projected: wp.projected_points,
          expected_availability: wp.expected_availability,
          injury_status: wp.injury_status,
          swing_note: `${wp.injury_status ?? "questionable"} — ${((1 - wp.expected_availability) * 100).toFixed(0)}% chance of missing; ~${(wp.projected_points ?? 0).toFixed(1)} pts at stake.`,
        });
      }
    }
  }

  const teamBenchTop3 = benchTop3(ctx, ctx.roster.bench);
  const oppBenchTop3 = benchTop3(ctx, ctx.opponent.roster.bench);

  const replacement_vulnerability = teamLineup.slots
    .filter((s) => {
      const wp = s.recommended_player_id ? ctx.projections.by_player.get(s.recommended_player_id) : null;
      const rep = ctx.replacement.by_position[baseOf(s.slot)]?.replacement_points ?? null;
      return wp && rep != null && (wp.projected_points ?? 0) - rep < 2 && (wp.expected_availability < 0.9 || (wp.projected_points ?? 0) < 8);
    })
    .map((s) => {
      const wp = ctx.projections.by_player.get(s.recommended_player_id!);
      const rep = ctx.replacement.by_position[baseOf(s.slot)]?.replacement_points ?? null;
      return {
        position: s.slot,
        note: `${s.slot} starter is barely above the waiver line — a drop-off here is not easily replaced.`,
        gap: wp?.projected_points != null && rep != null ? round2(wp.projected_points - rep) : null,
      };
    });

  return {
    week: ctx.league.week,
    team_id: ctx.fantasy_team.canonical_team_id,
    opponent_team_id: ctx.opponent.fantasy_team.canonical_team_id,
    has_opponent: true,
    team_optimal_total: teamLineup.optimal_total,
    opponent_optimal_total: oppLineup.optimal_total,
    team_known_subtotal: teamLineup.known_optimal_subtotal,
    opponent_known_subtotal: oppLineup.known_optimal_subtotal,
    projected_margin: margin,
    projected_margin_status: margin_status,
    margin_confidence,
    win_probability,
    win_probability_method,
    win_probability_confidence,
    positional_advantages: edges.filter((e) => e.edge > 1),
    positional_disadvantages: edges.filter((e) => e.edge < -1).reverse(),
    high_leverage_players,
    swing_players,
    bench_depth: {
      team_bench_projected_top3: teamBenchTop3,
      opponent_bench_projected_top3: oppBenchTop3,
      advantage: teamBenchTop3 - oppBenchTop3 > 4 ? "team" : oppBenchTop3 - teamBenchTop3 > 4 ? "opponent" : "even",
    },
    replacement_vulnerability,
    team_lineup: teamLineup,
    opponent_lineup: oppLineup,
    warnings,
  };
}

/* --------------------------------------------------------------- leverage */

export interface LeverageItem {
  decision: string;
  slot: string;
  leverage: "HIGH" | "MEDIUM" | "LOW";
  projected_gain: number;
  message: string;
}

/**
 * Which of the manager's OWN lineup decisions matter most this week — measured
 * by projected points gained, scaled by how close the matchup is.
 */
export function buildLeverage(matchup: MatchupResult): LeverageItem[] {
  const lu = matchup.team_lineup;
  const closeness = matchup.projected_margin == null ? 1 : Math.max(0.4, 1 - Math.abs(matchup.projected_margin) / 25);
  const grade = (g: number): LeverageItem["leverage"] => {
    const e = g * closeness;
    return e >= 3 ? "HIGH" : e >= 1.25 ? "MEDIUM" : "LOW";
  };
  const flip = (g: number) =>
    matchup.projected_margin != null && Math.abs(matchup.projected_margin) < g ? " — this alone can flip the matchup" : "";

  const items: LeverageItem[] = [];

  // A multi-player reshuffle is ONE decision valued at the lineup-level gain —
  // its individual legs carry arbitrary per-pair attribution and are not
  // separately actionable.
  const reshuffleLegs = lu.changes_recommended.filter((c) => c.part_of_reshuffle);
  if (reshuffleLegs.length > 0 && lu.projected_points_gained != null && lu.projected_points_gained > 0) {
    const g = lu.projected_points_gained;
    items.push({
      decision: "lineup reshuffle",
      slot: "MULTI",
      leverage: grade(g),
      projected_gain: round2(g),
      message: `Reshuffle ${reshuffleLegs.length} starters for +${g.toFixed(1)} projected${flip(g)}.`,
    });
  }

  for (const c of lu.changes_recommended.filter((x) => !x.part_of_reshuffle && x.gain > 0)) {
    items.push({
      decision: `${c.slot} decision`,
      slot: c.slot,
      leverage: grade(c.gain),
      projected_gain: round2(c.gain),
      message: `${c.slot}: start the optimal player for +${c.gain.toFixed(1)} projected${flip(c.gain)}.`,
    });
  }

  return items.sort((a, b) => b.projected_gain - a.projected_gain);
}

/* ------------------------------------------------------------------ helpers */

function drawSpec(lineup: LineupResult, ctx: WeeklyTeamContext): Array<{ mean: number; sd: number }> {
  return lineup.slots
    .filter((s) => s.recommended_player_id)
    .map((s) => {
      const wp = ctx.projections.by_player.get(s.recommended_player_id!);
      const mean = wp?.projected_points ?? 0;
      const sd = wp?.std_dev ?? Math.max(2, mean * 0.4);
      return { mean, sd };
    });
}

function lineupCoverage(lineup: LineupResult): number {
  const total = lineup.slots.length || 1;
  const projected = lineup.slots.filter((s) => s.recommended_projected != null).length;
  return projected / total;
}

function groupBySlotBase(lineup: LineupResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of lineup.slots) {
    const base = baseOf(s.slot);
    out[base] = (out[base] ?? 0) + (s.recommended_projected ?? 0);
  }
  return out;
}

function baseOf(slot: string): string {
  if (["QB", "RB", "WR", "TE", "K", "DEF"].includes(slot)) return slot;
  return "FLEX";
}

function benchTop3(ctx: WeeklyTeamContext, bench: string[]): number {
  const pts = bench
    .map((id) => ctx.projections.by_player.get(id)?.projected_points ?? 0)
    .sort((a, b) => b - a)
    .slice(0, 3);
  return round2(pts.reduce((s, p) => s + p, 0));
}

function hashSeed(...parts: Array<string | number>): number {
  let h = 2166136261;
  for (const p of parts.join("|")) h = (Math.imul(h ^ p.charCodeAt(0), 16777619) >>> 0);
  return h >>> 0;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
