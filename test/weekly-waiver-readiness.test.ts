/**
 * Readiness-contract gate for every waiver / free-agent / pickup surface.
 *
 * Core invariant: a player being unrostered in ownership data is NOT enough to
 * call them a current free agent / waiver claim. `ownership = HEALTHY` does not
 * imply `free_agent_pool = HEALTHY`. Any ACTIONABLE waiver output requires the
 * canonical `free_agent_pool` capability to be HEALTHY.
 *
 *   UNROSTERED != CERTIFIED_FREE_AGENT
 *   HTTP_200   != ACTIONABLE_DATA
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWaiverRecommendations } from "../lib/weekly/waivers";
import { buildWeeklySummary } from "../lib/weekly/summary";
import { buildLineup, buildCloseCalls } from "../lib/weekly/intelligence";
import { buildMatchup, buildLeverage } from "../lib/weekly/matchup";
import { assessFreeAgentPoolReadiness } from "../lib/canonical/capabilities";
import { player, proj, roster, weeklyContext } from "./fixtures/weekly";

const ME = [
  player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"),
  player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
  player("k1", "K"), player("def1", "DEF"),
  player("rbBench", "RB", { name: "Weak Bench RB" }),
];
const MY_ROSTER = roster("team:test-league:1",
  ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rbBench", "k1", "def1"],
  ["rbBench"]);
const MY_PROJS = [
  proj("qb1", "QB", 20), proj("rb1", "RB", 16), proj("rb2", "RB", 12),
  proj("wr1", "WR", 15), proj("wr2", "WR", 13), proj("te1", "TE", 10),
  proj("k1", "K", 8), proj("def1", "DEF", 7), proj("rbBench", "RB", 4),
];
// A wire RB that WOULD be a clear, recommended add if the pool were certified.
const FA = [player("faRb", "RB", { name: "Startable FA RB" })];
const FA_PROJS = [proj("faRb", "RB", 14, { rest_of_season_points: 170 })];

function ctxWith(freeAgentPool: "HEALTHY" | "UNAVAILABLE") {
  return weeklyContext({
    myRoster: MY_ROSTER, players: ME, projections: MY_PROJS,
    oppRoster: roster("team:test-league:2", ["qb1o"], []),
    freeAgents: FA, faProjections: FA_PROJS,
    freeAgentPool,
  });
}

describe("free-agent pool readiness gate — direct waiver engine", () => {
  it("ownership HEALTHY but free_agent_pool UNAVAILABLE -> no actionable recommendations", () => {
    const ctx = ctxWith("UNAVAILABLE");
    // ownership data itself is fine — the unrostered FA is visible in availability.
    assert.ok(ctx.availability.free_agents.some((f) => f.canonical_player_id === "faRb"));
    assert.equal(ctx.free_agent_pool_readiness.actionable, false);

    const res = buildWaiverRecommendations(ctx);
    assert.equal(res.availability_status, "UNAVAILABLE");
    assert.equal(res.unavailable_reason_code, "FREE_AGENT_POOL_UNAVAILABLE");
    assert.deepEqual(res.recommendations, []);
    assert.deepEqual(res.do_not_add, []);
    assert.equal(res.considered, 0);
    assert.equal(res.waiver_priority, null);
    assert.equal(res.faab, null);
    // canonical capability reason + missing input are surfaced
    assert.ok(res.unavailable_detail);
    assert.deepEqual(res.unavailable_detail!.missing_inputs, ["free_agent_pool"]);
    assert.ok(res.unavailable_detail!.reasons.join(" ").includes("not materialized"));
  });

  it("free_agent_pool HEALTHY -> existing recommendation behaviour is unchanged", () => {
    const ctx = ctxWith("HEALTHY");
    assert.equal(ctx.free_agent_pool_readiness.actionable, true);
    const res = buildWaiverRecommendations(ctx);
    assert.equal(res.availability_status, "AVAILABLE");
    assert.equal(res.unavailable_reason_code, null);
    assert.equal(res.unavailable_detail, null);
    const rec = res.recommendations.find((r) => r.add_name === "Startable FA RB");
    assert.ok(rec, "the clear wire upgrade is still recommended on the healthy path");
    assert.ok(rec!.net_roster_gain > 0);
  });

  it('"available, nothing clears the bar" is a DIFFERENT state from "availability unavailable"', () => {
    // Healthy pool, but the only FA is a scrub -> AVAILABLE + empty recommendations.
    const ctx = weeklyContext({
      myRoster: MY_ROSTER, players: ME, projections: MY_PROJS,
      freeAgents: [player("faScrub", "WR", { name: "Wire Scrub" })],
      faProjections: [proj("faScrub", "WR", 2, { rest_of_season_points: 10 })],
      freeAgentPool: "HEALTHY",
    });
    const available = buildWaiverRecommendations(ctx);
    assert.equal(available.availability_status, "AVAILABLE");
    assert.ok(available.considered > 0, "candidates were actually evaluated");
    assert.equal(available.recommendations.length, 0);

    const unavailable = buildWaiverRecommendations(ctxWith("UNAVAILABLE"));
    assert.equal(unavailable.availability_status, "UNAVAILABLE");
    assert.equal(unavailable.considered, 0);

    // Must not serialize to the same semantic state.
    assert.notEqual(available.availability_status, unavailable.availability_status);
    assert.notEqual(
      JSON.stringify({ s: available.availability_status, c: available.unavailable_reason_code }),
      JSON.stringify({ s: unavailable.availability_status, c: unavailable.unavailable_reason_code }),
    );
  });

  it("an unrostered player never becomes actionable solely because ownership data is healthy", () => {
    const ctx = ctxWith("UNAVAILABLE");
    const res = buildWaiverRecommendations(ctx);
    const mentionsFa = JSON.stringify(res).includes("faRb") || JSON.stringify(res).includes("Startable FA RB");
    assert.equal(mentionsFa, false, "the unrostered FA must not appear anywhere in the actionable surface");
  });
});

describe("free-agent pool readiness gate — combined weekly intelligence", () => {
  function assembleIntel(freeAgentPool: "HEALTHY" | "UNAVAILABLE") {
    const ctx = ctxWith(freeAgentPool);
    const lineup = buildLineup(ctx);
    const matchup = buildMatchup(ctx);
    const matchup_leverage = buildLeverage(matchup);
    const waivers = buildWaiverRecommendations(ctx);
    const start_sit = buildCloseCalls(ctx, lineup);
    const summary = buildWeeklySummary({ ctx, lineup, matchup, waivers });
    return { ctx, lineup, matchup, matchup_leverage, waivers, start_sit, summary };
  }

  it("waivers unavailable -> nested waivers mirrors it, summary is explicit, other surfaces intact", () => {
    const i = assembleIntel("UNAVAILABLE");
    assert.equal(i.waivers.availability_status, "UNAVAILABLE");
    assert.match(i.summary.waiver_priority ?? "", /unavailable: current free-agent pool is not materialized/i);

    // lineup / start-sit / matchup remain available and untouched.
    assert.ok(i.lineup.slots.length > 0);
    assert.ok(Array.isArray(i.start_sit));
    assert.equal(typeof i.matchup.has_opponent, "boolean");
    assert.ok(i.summary.team_status.length > 0);
  });

  it("healthy path -> summary still produces an add/drop priority line", () => {
    const i = assembleIntel("HEALTHY");
    assert.equal(i.waivers.availability_status, "AVAILABLE");
    assert.match(i.summary.waiver_priority ?? "", /^Add /);
  });
});

describe("assessFreeAgentPoolReadiness — the one authoritative helper", () => {
  it("HTTP success / ownership health cannot override capability readiness", () => {
    const ctx = ctxWith("UNAVAILABLE");
    // ownership capability would be HEALTHY here, free_agent_pool is not.
    const r = ctx.free_agent_pool_readiness;
    assert.equal(r.actionable, false);
    assert.equal(r.status, "UNAVAILABLE");
    assert.equal(r.reason_code, "FREE_AGENT_POOL_UNAVAILABLE");
  });

  it("is the shared helper consumed by the weekly context", () => {
    const ctx = ctxWith("HEALTHY");
    assert.equal(ctx.free_agent_pool_readiness.actionable, true);
    assert.equal(typeof assessFreeAgentPoolReadiness, "function");
  });
});
