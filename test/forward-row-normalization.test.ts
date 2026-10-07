/**
 * W1.R1: a row derived from a CURRENT-WEEK row for another horizon (ROS, future week, per-week basis) must not retain current-week game state.
 * Audit: mutations E1 (rewritten schedule-planning row kept `is_bye`) and E2 (synthesized trade-ROS row carried `is_bye`) survived the Wave 1 suite.
 * These tests pin the contract at the helper AND at each production rewriter/synthesizer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isVerifiedBye, deriveForwardRow, verifiedByeRow } from "../lib/weekly/forecast/bye";
import { horizonBatch } from "../lib/roster-health/contingency";
import { synthBatch } from "../lib/schedule-planning/evaluate";
import { evaluateRosParticipant } from "../lib/trades/ros";
import type { WeeklyProjection, WeeklyProjectionBatch } from "../lib/weekly/schema";
import { tradeFixture, stdTeam, xfer } from "./fixtures/trades";
import { proj } from "./fixtures/weekly";

const byeRow = (over: Partial<WeeklyProjection> = {}): WeeklyProjection =>
  ({ ...verifiedByeRow({ canonical_player_id: "A", week: 5, season: 2026, position: "WR", nfl_team: "BUF", injury_status: "Questionable", rest_of_season_points: 200, ros: null, source: "s", model_version: "m", warnings: ["bye_verified_by_schedule", "keep_me"], band: "ZERO" }), opponent: "LV", ...over });
const batchOf = (rows: WeeklyProjection[]): WeeklyProjectionBatch => ({
  league_slug: "l", season: 2026, week: 5, status: "READY", by_player: new Map(rows.map((r) => [r.canonical_player_id, r])), resolved_players: new Map(),
  source: "s", model_version: "m", missing: [], teams_with_games: [], warnings: [],
});

describe("W1.R1 deriveForwardRow: the one place current-week game state is cleared", () => {
  it("bye row + a value for the other horizon -> an ordinary projected row (no bye flag, no bye status, availability restored, no opponent)", () => {
    const r = deriveForwardRow(byeRow(), 11);
    assert.equal(r.is_bye, false);
    assert.equal(isVerifiedBye(r), false);
    assert.equal(r.projection_status, "projected");
    assert.equal(r.projected_points, 11);
    assert.equal(r.expected_availability, 1, "a bye's 0 availability means 'not playing THIS week'");
    assert.equal(r.opponent, null);
    assert.deepEqual(r.warnings, ["keep_me"], "this-week bye warnings are dropped, others kept");
    assert.equal(r.injury_status, "Questionable", "player-level facts are kept");
    assert.equal(r.rest_of_season_points, 200);
    assert.ok(Math.abs(r.floor_points! - 7.7) < 1e-9 && Math.abs(r.ceiling_points! - 14.3) < 1e-9);
  });

  it("bye row + NO value for the other horizon -> UNKNOWN (unavailable), never a verified bye zero", () => {
    const r = deriveForwardRow(byeRow(), null);
    assert.equal(r.is_bye, false);
    assert.equal(isVerifiedBye(r), false, "a current-week bye is not evidence about another horizon");
    assert.equal(r.projection_status, "unavailable");
    assert.equal(r.projected_points, null);
    assert.equal(r.floor_points, null);
  });

  it("a non-bye row keeps its availability and status semantics (only the projected value and horizon fields change)", () => {
    const base = proj("B", "WR", 9, { expected_availability: 0.78, injury_status: "Questionable" });
    const r = deriveForwardRow(base, 12);
    assert.equal(r.expected_availability, 0.78);
    assert.equal(r.is_bye, false);
    assert.equal(r.projected_points, 12);
  });
});

describe("W1.R1 production rewriters route through it (E1: roster-health + schedule-planning)", () => {
  const base = () => batchOf([byeRow(), proj("B", "WR", 9)]);

  it("roster-health horizonBatch: a bye player with a ROS value is NOT a bye in the ROS horizon", () => {
    const out = horizonBatch(base(), new Map([["A", 8.5], ["B", 7]]));
    const a = out.by_player.get("A")!;
    assert.equal(a.is_bye, false);
    assert.equal(isVerifiedBye(a), false);
    assert.equal(a.projected_points, 8.5);
  });

  it("roster-health horizonBatch: a bye player with NO ROS value is UNKNOWN in the ROS horizon (not a verified zero)", () => {
    const out = horizonBatch(base(), new Map([["B", 7]]));
    const a = out.by_player.get("A")!;
    assert.equal(isVerifiedBye(a), false);
    assert.equal(a.projected_points, null);
    assert.equal(a.projection_status, "unavailable");
  });

  it("schedule-planning synthBatch: same contract for a per-week basis row", () => {
    const withVal = synthBatch(base(), ["A", "B"], (id) => (id === "A" ? 10 : 6)).by_player.get("A")!;
    assert.equal(withVal.is_bye, false);
    assert.equal(withVal.projection_status, "projected");
    assert.equal(withVal.expected_availability, 1);
    const noVal = synthBatch(base(), ["A", "B"], () => null).by_player.get("A")!;
    assert.equal(isVerifiedBye(noVal), false);
    assert.equal(noVal.projection_status, "unavailable");
  });
});

describe("W1.R1 trade ROS synthesized weekly rows (E2): a covered, non-bye player is a normal projected asset", () => {
  it("incoming player's ROS value is positive: the synthesized per-week rows are not bye zeros", () => {
    const built = [stdTeam({ slug: "X", flex: { id: "X_flex", pos: "WR", pts: 8 } }), stdTeam({ slug: "Y", flex: { id: "Y_flex", pos: "WR", pts: 10 }, bench: [{ id: "WRa", pos: "WR", pts: 20 }] })];
    const f = tradeFixture({
      teams: built.map((b) => b.team), players: built.flatMap((b) => b.players), projections: built.flatMap((b) => b.projections),
      transfers: [xfer("X", "Y", "X_flex"), xfer("Y", "X", "WRa")], rosFlatHorizon: 6,
    });
    const r = f.rosters.get("manager:test-league:X")!;
    const ros = evaluateRosParticipant({
      ctx: f.context({ rosWeeks: 6 }), manager_id: "manager:test-league:X", before: r,
      after: { ...r, all_players: [...r.all_players.filter((id) => id !== "X_flex"), "WRa"], bench: [...r.bench, "WRa"], starters: r.starters.filter((id) => id !== "X_flex") },
      incoming_ids: ["WRa"], outgoing_ids: ["X_flex"],
    });
    assert.ok(ros.ros_usable_value_delta > 0, `adding a 20-pt WR for an 8-pt flex must raise ROS usable value (got ${ros.ros_usable_value_delta})`);
    assert.ok(ros.marginal_player_utility.every((m) => m.marginal_ros_delta != null));
  });
});
