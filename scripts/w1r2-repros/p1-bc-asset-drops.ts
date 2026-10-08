/**
 * W1.R2 / P1-B + P1-C repro: a full roster through the REAL buildWeeklyTeamContext + buildWaiverRecommendations. Subject "A" is a high-value
 * WR (ROS 230) whose CURRENT week is depressed: injured (Out / Doubtful / IR / Questionable) or on a verified bye with a literal source 0.
 * Bench "B"/"f2..f6" are fringe WRs (9 pts, ROS 110). The free agent projects 11 (ROS 130). Prints the recommended drop for the FA.
 * Run: node --import tsx scripts/w1r2-repros/p1-bc-asset-drops.ts
 */
import { buildWaiverRecommendations } from "../../lib/weekly/waivers";
import { feedAbsentByeContext, type FeedAbsentByeOptions } from "../../test/fixtures/feed-absent-bye";

export async function dropFor(o: FeedAbsentByeOptions) {
  const ctx = await feedAbsentByeContext(o);
  const out = buildWaiverRecommendations(ctx) as unknown as { recommendations: Array<{ add_player_id: string; drop_player_id: string | null; priority: string; net_value: number; drop_cost?: number }> };
  const r = out.recommendations.find((x) => x.add_player_id === "faWR") ?? null;
  const f = ctx.forecasts?.by_player.get("A");
  return {
    drop: r?.drop_player_id ?? null, priority: r?.priority ?? null, net: r?.net_value ?? null,
    A_current_week: f?.weekly_value.current_week_points ?? null, A_underlying: f?.weekly_value.underlying_points_if_game_played ?? null, A_basis: f?.weekly_value.underlying_basis ?? null,
    A_asset: (f as unknown as { asset_value?: { hold_points_per_week: number | null; basis: string } } | undefined)?.asset_value ?? "(none)",
  };
}

export const CASES: Array<[string, FeedAbsentByeOptions]> = [
  ["P1-B Out, source 0, ROS 230", { subjectOnBye: false, subjectInFeed: true, subjectPts: 0, subjectRos: 230, subjectInjury: "Out" }],
  ["P1-B Doubtful, source 1.2, ROS 230", { subjectOnBye: false, subjectInFeed: true, subjectPts: 1.2, subjectRos: 230, subjectInjury: "Doubtful" }],
  ["P1-B IR, source 0, ROS 230", { subjectOnBye: false, subjectInFeed: true, subjectPts: 0, subjectRos: 230, subjectInjury: "IR" }],
  ["P1-B Questionable star, source 15, ROS 230", { subjectOnBye: false, subjectInFeed: true, subjectPts: 15, subjectRos: 230, subjectInjury: "Questionable" }],
  ["control: Questionable but the provider projects only 4 (treated exactly like a healthy player projected 4)", { subjectOnBye: false, subjectInFeed: true, subjectPts: 4, subjectRos: 230, subjectInjury: "Questionable" }],
  ["control: healthy, projected 4, ROS 230 (same decision as the Questionable-4 control)", { subjectOnBye: false, subjectInFeed: true, subjectPts: 4, subjectRos: 230 }],
  ["P1-C verified bye, source row 0, ROS 230", { subjectOnBye: true, subjectInFeed: true, subjectPts: 0, subjectRos: 230 }],
  ["P1-C verified bye, source row 0, no ROS, RI 300", { subjectOnBye: true, subjectInFeed: true, subjectPts: 0, subjectRos: null, riSeasonPoints: 300 }],
  ["control: healthy star 18, ROS 230", { subjectOnBye: false, subjectInFeed: true, subjectPts: 18, subjectRos: 230 }],
  ["control: Out, ROS 20 (season-ending shape)", { subjectOnBye: false, subjectInFeed: true, subjectPts: 0, subjectRos: 20, subjectInjury: "Out" }],
];

if (process.argv[1]?.endsWith("p1-bc-asset-drops.ts")) {
  (async () => { for (const [name, o] of CASES) console.log(JSON.stringify({ case: name, ...(await dropFor(o)) })); })();
}
