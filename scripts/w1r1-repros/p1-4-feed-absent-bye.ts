/**
 * W1.R1 P1-4 reproduction: valuable player on a schedule-verified bye, ABSENT from the weekly feed, full roster, solid bench, useful free agent.
 * Runs unchanged on 65a04f4 (false drop) and on the fixed tree.
 * Run:  node --import tsx scripts/w1r1-repros/p1-4-feed-absent-bye.ts
 */
import { buildWaiverRecommendations } from "../../lib/weekly/waivers";
import { feedAbsentByeContext } from "../../test/fixtures/feed-absent-bye";

(async () => {
  const out: Record<string, unknown> = { p1: "P1-4" };
  for (const [label, o] of [["ri_evidence", { riSeasonPoints: 300 }], ["no_evidence_at_all", {}]] as const) {
    const ctx = await feedAbsentByeContext(o);
    const rec = buildWaiverRecommendations(ctx) as unknown as { recommendations: Array<{ add_player_id: string; drop_player_id: string | null; drop_cost: number; bye_diagnostics?: Array<{ player_id: string; hold_basis: string; bye_guardrail_applied: boolean }> }> };
    const x = rec.recommendations[0];
    const a = ctx.projections.by_player.get("A");
    out[label] = {
      A_row: a ? { status: a.projection_status, is_bye: a.is_bye, ros: a.rest_of_season_points } : null,
      recommendations: rec.recommendations.length,
      preferred_drop: x?.drop_player_id ?? null,
      valuable_bye_player_is_preferred_drop: x?.drop_player_id === "A",
      A_hold_basis: ctx.forecasts?.by_player.get("A")?.weekly_value?.underlying_basis ?? null,
    };
  }
  console.log(JSON.stringify(out));
})();
