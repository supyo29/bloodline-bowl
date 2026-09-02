/**
 * Concise manager-facing weekly summary — generated from the structured
 * analytical outputs, never ad-hoc. Suitable for future ChatGPT consumption.
 */

import type { LineupResult } from "./lineup";
import type { MatchupResult } from "./matchup";
import type { WaiverResult } from "./waivers";
import type { WeeklyTeamContext } from "./schema";

export interface WeeklySummary {
  team_status: string;
  most_important_move: string | null;
  waiver_priority: string | null;
  biggest_weakness: string | null;
  watch: string[];
  headline_numbers: {
    projected_margin: number | null;
    win_probability: number | null;
    lineup_efficiency: number | null;
    points_left_on_bench: number | null;
  };
}

function name(ctx: WeeklyTeamContext, id: string | null): string {
  if (!id) return "(empty)";
  const p =
    ctx.all_rostered.find((x) => x.canonical_player_id === id) ??
    ctx.opponent?.all_rostered.find((x) => x.canonical_player_id === id) ??
    ctx.projections.resolved_players.get(id);
  return p?.full_name ?? id;
}

export function buildWeeklySummary(input: {
  ctx: WeeklyTeamContext;
  lineup: LineupResult;
  matchup: MatchupResult;
  waivers: WaiverResult;
}): WeeklySummary {
  const { ctx, lineup, matchup, waivers } = input;

  const team_status =
    matchup.has_opponent && matchup.projected_margin != null
      ? `Projected matchup: ${matchup.projected_margin >= 0 ? "+" : ""}${matchup.projected_margin.toFixed(1)}` +
        (matchup.win_probability != null ? ` (win prob ~${Math.round(matchup.win_probability * 100)}%, ${matchup.win_probability_confidence.toLowerCase()} confidence)` : "")
      : `No opponent this week — optimal projected total ${matchup.team_optimal_total?.toFixed(1) ?? "n/a"}.`;

  const topChange = lineup.changes_recommended[0] ?? null;
  const most_important_move = topChange
    ? `Start ${name(ctx, topChange.in)} over ${name(ctx, topChange.out)} (+${topChange.gain.toFixed(1)})`
    : lineup.illegal_situations.length > 0
      ? `Fix lineup: ${lineup.illegal_situations[0]}`
      : lineup.empty_slots.length > 0
        ? `Fill empty starter slot(s): ${lineup.empty_slots.join(", ")}`
        : "Lineup is already optimal.";

  const topAdd = waivers.recommendations[0] ?? null;
  const waiver_priority = topAdd
    ? `Add ${topAdd.add_name}${topAdd.drop_name ? `, drop ${topAdd.drop_name}` : ""} (${topAdd.priority}, net +${topAdd.net_roster_gain.toFixed(1)})`
    : waivers.considered > 0
      ? "No waiver add clears its drop cost — stand pat."
      : null;

  const weakness = ctx.positional_needs.find((n) => n.severity === "critical") ?? ctx.positional_needs.find((n) => n.severity === "weak") ?? null;
  const biggest_weakness = weakness
    ? `${weakness.position} depth (${weakness.severity}; best option ${weakness.current_best_points?.toFixed(1) ?? "n/a"} vs replacement ${(weakness.current_best_points != null && weakness.gap_vs_replacement != null ? weakness.current_best_points - weakness.gap_vs_replacement : null)?.toFixed(1) ?? "n/a"})`
    : null;

  const watch = [
    ...matchup.swing_players
      .filter((s) => s.side === "team")
      .map((s) => `${name(ctx, s.canonical_player_id)} (${s.position}): ${s.swing_note}`),
    ...ctx.byes.starters_on_bye_this_week.map((id) => `${name(ctx, id)} on bye and currently starting`),
  ].slice(0, 4);

  return {
    team_status,
    most_important_move,
    waiver_priority,
    biggest_weakness,
    watch,
    headline_numbers: {
      projected_margin: matchup.projected_margin,
      win_probability: matchup.win_probability,
      lineup_efficiency: lineup.lineup_efficiency,
      points_left_on_bench: lineup.points_left_on_bench,
    },
  };
}
