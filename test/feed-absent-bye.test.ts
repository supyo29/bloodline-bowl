/**
 * W1.R1 / P1-4: a bye zeroes current-week UTILITY but may not erase known asset value — including when the weekly feed omits the bye player.
 * Audit finding: the bye override built the row with `rest_of_season_points: projected?.rest_of_season_points ?? null`, so a feed-absent bye
 * player carried no ROS, hold value became UNAVAILABLE, and the waiver engine fell back to a cheap-drop value. Real context builder + waiver engine.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { holdWeeklyValue, isVerifiedBye } from "../lib/weekly/forecast/bye";
import { rosFromSeasonPoints } from "../lib/weekly/ros";
import { buildWaiverRecommendations } from "../lib/weekly/waivers";
import type { WeeklyTeamContext } from "../lib/weekly/schema";
import { feedAbsentByeContext, type FeedAbsentByeOptions } from "./fixtures/feed-absent-bye";

interface Rec { add_player_id: string; drop_player_id: string | null; drop_cost: number; bye_diagnostics?: Array<{ player_id: string; hold_basis: string; hold_value_weekly: number | null; bye_guardrail_applied: boolean; is_recommended_drop: boolean; reason: string }> }
const run = (ctx: WeeklyTeamContext): Rec[] => (buildWaiverRecommendations(ctx) as unknown as { recommendations: Rec[] }).recommendations;
const drop = async (o: FeedAbsentByeOptions) => {
  const ctx = await feedAbsentByeContext(o);
  const recs = run(ctx);
  return { ctx, recs, drop: recs[0]?.drop_player_id ?? null, a: ctx.projections.by_player.get("A") };
};

describe("W1.R1 P1-4: verified bye + feed-absent player keeps his asset value", () => {
  it("(control) valuable bye player WITH a source projection and ROS is still protected (W1.P3 behavior preserved)", async () => {
    const r = await drop({ subjectInFeed: true, subjectPts: 15, subjectRos: 230 });
    assert.equal(isVerifiedBye(r.a), true);
    assert.notEqual(r.drop, "A");
  });

  it("valuable bye player ABSENT from the feed, RI season evidence exists -> protected via the ROS proxy (the audit's false drop is gone)", async () => {
    const r = await drop({ riSeasonPoints: 300 });
    assert.equal(r.a?.is_bye, true);
    assert.equal(r.a?.projected_points, 0, "current-week utility is still a known zero");
    assert.equal(r.a?.rest_of_season_points, rosFromSeasonPoints(300, 5), "same formula assembleRosSignals uses");
    assert.ok(r.a?.warnings.includes("bye_player_absent_from_weekly_feed"));
    assert.ok(r.a?.warnings.includes("bye_hold_ros_from_ri_season_benchmark"));
    assert.equal(r.ctx.forecasts?.by_player.get("A")?.weekly_value.underlying_basis, "ROS_PER_WEEK_PROXY");
    assert.notEqual(r.drop, "A");
  });

  it("valuable bye player in the feed with ROS but no weekly points -> protected using that ROS", async () => {
    const r = await drop({ subjectInFeed: true, subjectPts: null, subjectRos: 230 });
    assert.equal(isVerifiedBye(r.a), true);
    assert.notEqual(r.drop, "A");
  });

  it("feed-absent bye player with NO usable evidence: hold value is UNKNOWN (not low) and he is not offered as the preferred drop", async () => {
    const r = await drop({});
    assert.equal(r.a?.is_bye, true);
    assert.equal(r.a?.rest_of_season_points, null, "no number is invented");
    assert.equal(r.ctx.forecasts?.by_player.get("A")?.weekly_value.underlying_basis, "UNAVAILABLE");
    assert.equal(holdWeeklyValue({ row: r.a, week: 5 }).points, null);
    assert.notEqual(r.drop, "A");
    assert.equal(r.recs.length, 1, "the engine still produces a recommendation (drop is another, assessable player)");
    const d = r.recs[0]!.bye_diagnostics?.find((x) => x.player_id === "A");
    assert.ok(d, "the exclusion is REPORTED, not silent");
    assert.equal(d!.hold_value_weekly, null);
    assert.equal(d!.bye_guardrail_applied, true);
    assert.equal(d!.is_recommended_drop, false);
    assert.match(d!.reason, /UNKNOWN/);
  });

  it("marginal bye player (independent evidence of LOW value) is still droppable", async () => {
    const r = await drop({ riSeasonPoints: 40, bench: "solid" }); // ROS ~ 30 over the remaining weeks
    assert.equal(r.drop, "A");
    const a = r.recs[0]!.bye_diagnostics?.find((x) => x.player_id === "A");
    assert.ok(a && a.hold_value_weekly != null && a.hold_value_weekly < 4, `hold ${a?.hold_value_weekly}`);
  });

  it("bye + injury designation: same protection, no extra penalty and no extra protection (the bye owns the current week)", async () => {
    const plain = await drop({ riSeasonPoints: 300 });
    const inj = await drop({ riSeasonPoints: 300, subjectInjury: "Questionable" });
    assert.equal(inj.drop, plain.drop);
    const f = inj.ctx.forecasts?.by_player.get("A");
    assert.equal(f?.injury_model.mode === "PRODUCTION" && f.injury_model.probability_active != null, false, "no injury discount on a bye");
    assert.equal(f?.projection.expected_points, plain.ctx.forecasts?.by_player.get("A")?.projection.expected_points);
    assert.equal(f?.weekly_value.underlying_basis, plain.ctx.forecasts?.by_player.get("A")?.weekly_value.underlying_basis);
  });

  it("a player missing from the feed whose team is NOT on a bye gets NO bye protection and no bye row (unknown stays unknown)", async () => {
    const r = await drop({ subjectOnBye: false, riSeasonPoints: 300 });
    assert.equal(isVerifiedBye(r.a), false);
    assert.equal(r.a?.is_bye ?? false, false);
    assert.ok(!(r.a?.warnings ?? []).some((w) => w.startsWith("bye_")));
    assert.equal(r.ctx.forecasts?.by_player.get("A")?.weekly_value.current_week_state === "BYE", false);
    assert.notEqual(r.drop, "A", "unknown (not low) is not droppable under the existing unknown-player rule");
  });

  it("context still reports the bye as current-week zero for lineup/matchup (utility unchanged)", async () => {
    const r = await drop({ riSeasonPoints: 300 });
    assert.equal(r.a?.projection_status, "bye");
    assert.equal(r.a?.expected_availability, 0);
    assert.ok(r.ctx.byes.starters_on_bye_this_week.includes("A"));
  });
});
