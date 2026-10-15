/**
 * W1.R2 / P1-D repro: the REAL evaluateTradeHorizons. The manager GIVES star "S" (ROS 216 over a 12-week horizon = 18/wk) and RECEIVES an equal
 * healthy player "H" (ROS 216). Neutral lineup math (immediate 0, ROS usable delta 0) isolates the availability term. S's CURRENT week is
 * healthy / Questionable / Out / on a verified bye / IR. Prints availability_delta and permanent utility per week.
 * Run: node --import tsx scripts/w1r2-repros/p1-d-trade-horizon.ts
 */
import { evaluateTradeHorizons } from "../../lib/trades/competitive/horizon";

const WEEKS = 12;
const part = () => ({
  manager_slug: "us", roster_utility_delta: 0, starter_points_delta: 0, bench_value_delta: 0,
  roster_utility_components: { starter_points: 0, starter_vor: 0, bench_value: 0, positional_need: 0 },
  phase2: {
    ros: { ros_usable_value_delta: 0, before: { stranded_ros_points: 0 }, after: { stranded_ros_points: 0 }, standalone_ros_swing: 0 },
    components: { playoff_window: null, bye_coverage: 0 },
  },
});

export type StarState = "healthy" | "questionable" | "out" | "bye" | "ir" | "ir_season_ending";
export function row(id: string, state: StarState, ros: number) {
  const base = { canonical_player_id: id, week: 6, season: 2026, position: "WR", nfl_team: "KC", projected_points: 18, expected_availability: 1, is_bye: false, projection_status: "projected", injury_status: null as string | null, rest_of_season_points: ros, ros: { points: ros }, warnings: [] as string[] };
  if (state === "questionable") return { ...base, injury_status: "Questionable", expected_availability: 0.78 };
  if (state === "out") return { ...base, injury_status: "Out", expected_availability: 0, projected_points: 0 };
  if (state === "bye") return { ...base, is_bye: true, projection_status: "bye", expected_availability: 0, projected_points: 0 };
  if (state === "ir") return { ...base, injury_status: "IR", expected_availability: 0, projected_points: 0 };
  if (state === "ir_season_ending") return { ...base, injury_status: "IR", expected_availability: 0, projected_points: 0, rest_of_season_points: 0, ros: { points: 0 } };
  return base;
}

export function giveStar(state: StarState, extra: { incoming?: string[]; outgoing?: string[]; rows?: Record<string, unknown> } = {}) {
  const by = new Map<string, unknown>([["S", row("S", state, 216)], ["H", row("H", "healthy", 216)], ...Object.entries(extra.rows ?? {})]);
  const ctx = { week: 6, ros: { weeks: Array.from({ length: WEEKS }, (_, i) => 6 + i), schedule_status: "READY", championship_week: 17 }, projections: { by_player: by }, players_by_id: new Map() } as never;
  const h = evaluateTradeHorizons({ baseline: { participants: { us: part() } } as never, ctx, manager_slug: "us", incoming_ids: extra.incoming ?? ["H"], outgoing_ids: extra.outgoing ?? ["S"] });
  return { availability_delta: h.ros.availability_delta, ros_total: h.ros.total_delta, permanent: h.permanent_trade_utility, reason: h.reasons.find((r) => /availability/.test(r)) ?? null };
}

if (process.argv[1]?.endsWith("p1-d-trade-horizon.ts")) {
  for (const s of ["healthy", "questionable", "out", "bye", "ir", "ir_season_ending"] as const) console.log(JSON.stringify({ give_star_state: s, ...giveStar(s) }));
}
