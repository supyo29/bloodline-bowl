import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composeWeeklyReadiness } from "@/lib/weekly/readiness";
import { buildWaiverRecommendations } from "@/lib/weekly/waivers";
import { player, proj, roster, weeklyContext } from "./fixtures/weekly";

const ownershipReady = { status: "HEALTHY" as const, reasons: [], missing_inputs: [] };
const marketReady = {
  status: "READY" as const,
  actionable: true,
  source: "market_state" as const,
  reasons: [],
  blocking_reasons: [],
  limitations: [],
};

describe("Phase 4 orthogonal readiness contract", () => {
  it("market READY + weekly projections PARTIAL stays actionable", () => {
    const r = composeWeeklyReadiness({
      live_provider_status: "READY",
      ownership: ownershipReady,
      market: marketReady,
      projection_status: "PROJECTIONS_PARTIAL",
      roster_players_projected: 12,
      roster_players_total: 14,
      missing_roster_players: 2,
      want_rest_of_season: true,
      external_ros_players_available: 10,
      season_segment_degraded: true,
      ri_status: "READY",
    });

    assert.equal(r.market.status, "READY");
    assert.equal(r.market.actionable, true);
    assert.equal(r.weekly_projections.status, "PARTIAL");
    assert.equal(r.waiver_recommendations.status, "READY_WITH_LIMITATIONS");
    assert.equal(r.waiver_recommendations.actionable, true);
    assert.deepEqual(r.waiver_recommendations.blocked_by, []);
    assert.ok(r.waiver_recommendations.limitations.includes("weekly_projections_partial"));
    assert.ok(r.waiver_recommendations.limitations.includes("rest_of_season_partial"));
  });

  it("market PARTIAL can still be actionable; PARTIAL is not NOT_READY", () => {
    const r = composeWeeklyReadiness({
      live_provider_status: "READY",
      ownership: ownershipReady,
      market: {
        ...marketReady,
        status: "PARTIAL",
        limitations: ["PENDING_CLAIMS_NOT_EXPOSED"],
      },
      projection_status: "READY",
      roster_players_projected: 14,
      roster_players_total: 14,
      missing_roster_players: 0,
      want_rest_of_season: true,
      external_ros_players_available: 14,
      season_segment_degraded: false,
      ri_status: "READY",
    });

    assert.equal(r.market.actionable, true);
    assert.equal(r.waiver_recommendations.actionable, true);
    assert.equal(r.waiver_recommendations.status, "READY_WITH_LIMITATIONS");
    assert.ok(r.waiver_recommendations.limitations.includes("market_partial"));
  });

  it("market NOT_READY blocks waiver recommendations even with perfect projections", () => {
    const r = composeWeeklyReadiness({
      live_provider_status: "READY",
      ownership: ownershipReady,
      market: {
        status: "NOT_READY",
        actionable: false,
        source: "canonical_snapshot",
        reasons: ["free-agent pool not materialized"],
        blocking_reasons: ["free_agent_pool"],
        limitations: [],
      },
      projection_status: "READY",
      roster_players_projected: 14,
      roster_players_total: 14,
      missing_roster_players: 0,
      want_rest_of_season: true,
      external_ros_players_available: 14,
      season_segment_degraded: false,
      ri_status: "READY",
    });

    assert.equal(r.weekly_projections.status, "READY");
    assert.equal(r.waiver_recommendations.status, "NOT_READY");
    assert.equal(r.waiver_recommendations.actionable, false);
    assert.deepEqual(r.waiver_recommendations.blocked_by, ["market_not_actionable"]);
  });

  it("weekly projection outage blocks recommendations without changing market status", () => {
    const r = composeWeeklyReadiness({
      live_provider_status: "READY",
      ownership: ownershipReady,
      market: marketReady,
      projection_status: "PROJECTIONS_UNAVAILABLE",
      roster_players_projected: 0,
      roster_players_total: 14,
      missing_roster_players: 14,
      want_rest_of_season: true,
      external_ros_players_available: 0,
      season_segment_degraded: true,
      ri_status: "UNAVAILABLE",
    });

    assert.equal(r.market.status, "READY");
    assert.equal(r.market.actionable, true);
    assert.equal(r.weekly_projections.status, "UNAVAILABLE");
    assert.equal(r.waiver_recommendations.status, "NOT_READY");
    assert.ok(r.waiver_recommendations.blocked_by.includes("weekly_projections_unavailable"));
  });

  it("waiver engine keeps an actionable market AVAILABLE when projections are partial", () => {
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"),
      player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
      player("fx1", "RB"), player("k1", "K"), player("def1", "DEF"),
      player("bench1", "WR"),
    ];
    const projections = [
      proj("qb1", "QB", 20), proj("rb1", "RB", 16), proj("rb2", "RB", 12),
      proj("wr1", "WR", 14), proj("wr2", "WR", 11), proj("te1", "TE", 9),
      proj("fx1", "RB", 8), proj("k1", "K", 7), proj("def1", "DEF", 6),
      proj("bench1", "WR", null),
    ];
    const ctx = weeklyContext({
      myRoster: roster(
        "team:test-league:1",
        ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "fx1", "k1", "def1"],
        ["bench1"],
      ),
      players,
      projections,
      freeAgents: [player("fa1", "WR", { name: "Useful FA" })],
      faProjections: [proj("fa1", "WR", 10, { rest_of_season_points: 120 })],
      freeAgentPool: "HEALTHY",
    });

    ctx.projections.status = "PROJECTIONS_PARTIAL";
    ctx.readiness = composeWeeklyReadiness({
      live_provider_status: "READY",
      ownership: ownershipReady,
      market: marketReady,
      projection_status: "PROJECTIONS_PARTIAL",
      roster_players_projected: 9,
      roster_players_total: 10,
      missing_roster_players: 1,
      want_rest_of_season: true,
      external_ros_players_available: 9,
      season_segment_degraded: false,
      ri_status: "UNAVAILABLE",
    });

    const result = buildWaiverRecommendations(ctx);
    assert.equal(result.availability_status, "AVAILABLE");
    assert.equal(result.readiness.market.status, "READY");
    assert.equal(result.readiness.weekly_projections.status, "PARTIAL");
    assert.equal(result.readiness.waiver_recommendations.status, "READY_WITH_LIMITATIONS");
    assert.equal(result.readiness.waiver_recommendations.actionable, true);
    assert.equal(result.unavailable_reason_code, null);
  });
});
