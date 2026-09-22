/**
 * Waiver-readiness-contract fix — production waiver pipeline now consumes the
 * certified Phase 4.5 Market State free-agent pool instead of failing on
 * `snapshot.waiver_state === null`.
 *
 * Two tiers:
 *  - pure unit tests of `lib/weekly/market-pool-adapter.ts::certifyFreeAgentPool`
 *    (the ONE place the legacy engine turns a Market State snapshot into an
 *    updated readiness + candidate list — mirrors `lib/waiver2/market-pool.ts`);
 *  - end-to-end tests through `buildWeeklyTeamContext` + `buildWaiverRecommendations`
 *    / `buildWeeklyIntelligence`, proving the real regression is fixed: a
 *    healthy Market State snapshot makes the production waiver route actionable
 *    even though the canonical `snapshot.waiver_state` is (as in production
 *    today) always `null`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { certifyFreeAgentPool, LEGACY_WAIVER_MARKET_POLICY } from "../lib/weekly/market-pool-adapter";
import { WAIVER2_MARKET_POLICY } from "../lib/waiver2/market-policy";
import { buildFreeAgentPool } from "../lib/market-state/pool";
import { buildMarketSnapshot } from "../lib/market-state/build";
import { assessFreeAgentPoolReadiness } from "../lib/canonical/capabilities";
import { buildWeeklyTeamContext } from "../lib/weekly/context";
import { buildWaiverRecommendations } from "../lib/weekly/waivers";
import { buildWeeklyIntelligence } from "../lib/weekly/intelligence";
import { setPersistence, memoryPersistence } from "../lib/persistence";
import { makeCanonicalSnapshot, testPlayer } from "./helpers/canonical-snapshot";
import { agoMs, marketInput, okSrc, badSrc, up } from "./fixtures/market";
import type { AvailablePlayer, LeagueAvailability, WeeklyProjectionBatch } from "../lib/weekly/schema";
import type { ScheduleProvider } from "../lib/weekly/schedule/types";
import type { ProjectionProvider } from "../lib/weekly/projections/types";
import type { CanonicalPlayer } from "../lib/canonical/schema";
import type { MarketSnapshot } from "../lib/market-state/contract";

setPersistence(memoryPersistence());

/* ------------------------------------------------------------------------ */
/* helpers                                                                   */
/* ------------------------------------------------------------------------ */

const pid = (sleeperId: string) => `player:sleeper:${sleeperId}`;

function availablePlayer(sleeperId: string, position: string, ownership: AvailablePlayer["ownership"] = "free_agent"): AvailablePlayer {
  return {
    canonical_player_id: pid(sleeperId),
    player: testPlayer(sleeperId, { position }),
    ownership,
    owned_by_team_id: null,
    unresolved_note: null,
  };
}

const availability = (free_agents: AvailablePlayer[]): Pick<LeagueAvailability, "free_agents"> => ({ free_agents });

/* ------------------------------------------------------------------------ */
/* Tier 1 — pure unit tests of certifyFreeAgentPool                          */
/* ------------------------------------------------------------------------ */

describe("certifyFreeAgentPool — pure adapter (no duplicated market-eligibility logic)", () => {
  it("uses the SAME 'only the snapshot's own BLOCKING set' posture as Waiver 2.0's policy — a distinct consumer label, identical also_blocking", () => {
    assert.deepEqual(LEGACY_WAIVER_MARKET_POLICY.also_blocking, []);
    assert.deepEqual(WAIVER2_MARKET_POLICY.also_blocking, []);
    assert.notEqual(LEGACY_WAIVER_MARKET_POLICY.consumer, WAIVER2_MARKET_POLICY.consumer);
  });

  it("1) healthy market ⇒ actionable, and the candidate is exactly the certified pool member (not everything unrostered)", () => {
    const market = buildMarketSnapshot(marketInput({
      rosters: { source: okSrc(), teams: [{ team_id: "team:x:1", roster_id: 1, players: ["r1"], reserve: [], taxi: [], faab_used: 0, waiver_position: 1 }] },
      universe: { source: okSrc(), players: [up("r1", { position: "QB" }), up("fa1", { position: "RB" })] },
      transactions: { source: okSrc(), entries: [] },
    }));
    const av = availability([availablePlayer("fa1", "RB")]);
    const out = certifyFreeAgentPool(market, av);
    assert.equal(out.free_agent_pool_readiness.actionable, true);
    assert.equal(out.free_agent_pool_readiness.status, "HEALTHY");
    assert.equal(out.free_agent_pool_readiness.reason_code, null);
    assert.deepEqual(out.free_agents.map((f) => f.canonical_player_id), [pid("fa1")]);
  });

  it("2) a rostered player can never appear as a certified candidate, even if a caller mistakenly hands it in as an availability free agent", () => {
    const market = buildMarketSnapshot(marketInput({
      rosters: { source: okSrc(), teams: [{ team_id: "team:x:1", roster_id: 1, players: ["r1"], reserve: [], taxi: [], faab_used: 0, waiver_position: 1 }] },
      universe: { source: okSrc(), players: [up("r1", { position: "QB" })] },
      transactions: { source: okSrc(), entries: [] },
    }));
    // r1 IS rostered in the market (status ROSTERED, not AVAILABLE_FREE_AGENT) — even
    // presented as an "availability free agent" input it must not survive certification.
    const out = certifyFreeAgentPool(market, availability([availablePlayer("r1", "QB")]));
    assert.equal(out.free_agent_pool_readiness.actionable, true);
    assert.deepEqual(out.free_agents, [], "a market-rostered player is never a certified candidate");
  });

  it("3) a recently-dropped / on-waivers player is excluded from the certified pool, not mislabeled as an immediately available free agent", () => {
    const market = buildMarketSnapshot(marketInput({
      rosters: { source: okSrc(), teams: [{ team_id: "team:x:1", roster_id: 1, players: [], reserve: [], taxi: [], faab_used: 0, waiver_position: 1 }] },
      universe: { source: okSrc(), players: [up("fa1", { position: "RB" }), up("fa2", { position: "RB" })] },
      // fa2 was dropped 1 day ago; the default FAAB fixture's waiver_clear_days is 2 -> still ON_WAIVERS.
      transactions: { source: okSrc(), entries: [{ type: "free_agent", status: "complete", status_updated: agoMs(1), adds: [], drops: ["fa2"] }] },
    }));
    // Canonical (naive) ownership sees BOTH as unrostered free agents — this is the
    // exact UNROSTERED-does-not-imply-CERTIFIED situation the readiness contract guards.
    const av = availability([availablePlayer("fa1", "RB"), availablePlayer("fa2", "RB")]);
    const out = certifyFreeAgentPool(market, av);
    assert.equal(out.free_agent_pool_readiness.actionable, true);
    assert.deepEqual(out.free_agents.map((f) => f.canonical_player_id), [pid("fa1")], "fa2 (on waivers) must not be certified");
  });

  it("4) Market State NOT_READY (rosters source down) ⇒ fails closed, FREE_AGENT_POOL_UNAVAILABLE, never all_players-minus-rostered", () => {
    const market = buildMarketSnapshot(marketInput({ rosters: { source: badSrc(), teams: [] } }));
    assert.equal(market.readiness.status, "NOT_READY");
    const out = certifyFreeAgentPool(market, availability([availablePlayer("fa1", "RB")]));
    assert.equal(out.free_agent_pool_readiness.actionable, false);
    assert.equal(out.free_agent_pool_readiness.status, "UNAVAILABLE");
    assert.equal(out.free_agent_pool_readiness.reason_code, "FREE_AGENT_POOL_UNAVAILABLE");
    assert.ok(out.free_agent_pool_readiness.missing_inputs.length > 0);
    // Not-actionable: the raw canonical list passes through unchanged (harmless — the
    // readiness gate downstream refuses to use it either way).
    assert.deepEqual(out.free_agents.map((f) => f.canonical_player_id), [pid("fa1")]);
  });

  it("5) a distinct provider/source failure (universe unavailable) also fails closed with FREE_AGENT_POOL_UNAVAILABLE", () => {
    const market = buildMarketSnapshot(marketInput({ universe: { source: badSrc("PROVIDER_ERROR: sleeper player db unreachable"), players: [] } }));
    const out = certifyFreeAgentPool(market, availability([availablePlayer("fa1", "RB")]));
    assert.equal(out.free_agent_pool_readiness.actionable, false);
    assert.equal(out.free_agent_pool_readiness.reason_code, "FREE_AGENT_POOL_UNAVAILABLE");
    assert.ok(out.free_agent_pool_readiness.reasons.some((r) => r.includes("PLAYER_UNIVERSE_UNAVAILABLE") || r.toLowerCase().includes("universe")));
  });

  it("9) no duplicated readiness logic: the legacy adapter and Waiver 2.0's own adapter agree on pool membership for the SAME market snapshot", () => {
    const market = buildMarketSnapshot(marketInput({
      rosters: { source: okSrc(), teams: [{ team_id: "team:l:1", roster_id: 1, players: [], reserve: [], taxi: [], faab_used: 0, waiver_position: 1 }] },
      universe: { source: okSrc(), players: [up("fa1", { position: "RB" }), up("fa2", { position: "WR" })] },
      transactions: { source: okSrc(), entries: [] },
    }));
    const legacyOut = certifyFreeAgentPool(market, availability([availablePlayer("fa1", "RB"), availablePlayer("fa2", "WR")]));
    const w2Pool = buildFreeAgentPool(market);
    assert.deepEqual(
      legacyOut.free_agents.map((f) => f.canonical_player_id).sort(),
      w2Pool.members.map((m) => pid(m.provider_player_id)).sort(),
      "both engines certify the identical member set from the SAME buildFreeAgentPool reduction",
    );
    // Both engines' pool_id is derived from the exact same market_content_id + member set.
    assert.equal(legacyOut.pool_id, w2Pool.pool_id);
    assert.equal(legacyOut.market_content_id, w2Pool.market_content_id);
  });
});

/* ------------------------------------------------------------------------ */
/* Tier 2 — end-to-end: buildWeeklyTeamContext -> buildWaiverRecommendations */
/* ------------------------------------------------------------------------ */

const WEEK = 3;

function ctxSnapshot() {
  return makeCanonicalSnapshot({
    week: WEEK,
    teams: [{ roster_id: "1", wins: 1, losses: 0 }],
    players: [
      testPlayer("r1", { position: "QB" }),
      testPlayer("r2", { position: "RB" }),
      testPlayer("fa1", { position: "RB" }), // a real startable RB, not on any roster
      testPlayer("fa2", { position: "RB" }), // recently dropped, still ON_WAIVERS per the market fixture below
    ],
    rosterPlayerIdsByTeam: { "1": [pid("r1"), pid("r2")] },
  });
  // NOTE: makeCanonicalSnapshot always sets `waiver_state: null` — exactly the
  // production condition this fix addresses.
}

const fakeSchedule: ScheduleProvider = {
  name: "fake-schedule",
  async getWeekSchedule(season, week) {
    return { season, week, status: "UNAVAILABLE", source: "fake-schedule", teams_with_games: new Set(), teams_on_bye: new Set(), opponent_by_team: {}, warnings: [] };
  },
};

/** Projects every rostered id (as requested) PLUS the two known free agents (fa1, fa2) — a
 * real projection provider is asked only for rostered ids; this fixture also stands in for
 * "a free agent has a usable weekly projection", which `buildLeagueAvailability`'s candidate
 * universe requires to surface a player at all. */
const fakeProjections: ProjectionProvider = {
  name: "fake-weekly",
  model_version: "fake-weekly-v1",
  async getWeeklyProjections(req): Promise<WeeklyProjectionBatch> {
    const by_player: WeeklyProjectionBatch["by_player"] = new Map();
    const resolved_players: WeeklyProjectionBatch["resolved_players"] = new Map();
    const ids = new Set([...req.canonical_player_ids, pid("fa1"), pid("fa2")]);
    for (const cid of ids) {
      by_player.set(cid, {
        canonical_player_id: cid, week: req.week, season: 2026, position: "RB", nfl_team: "KC",
        opponent: "LV", is_home: null, projected_points: cid === pid("fa1") ? 14 : 8, floor_points: 6, ceiling_points: 18, std_dev: 4,
        projection_status: "projected", expected_availability: 1, is_bye: false, injury_status: null,
        rest_of_season_points: cid === pid("fa1") ? 170 : 60, ros: null, source: "fake-weekly", model_version: "fake-weekly-v1",
        uncertainty_source: "position_volatility_heuristic", warnings: [],
      });
      if (cid === pid("fa1") || cid === pid("fa2")) resolved_players.set(cid, testPlayer(cid.split(":").pop()!, { position: "RB" }) as CanonicalPlayer);
    }
    return {
      league_slug: req.league.league_slug, season: 2026, week: req.week, status: "READY",
      by_player, resolved_players, source: "fake-weekly", model_version: "fake-weekly-v1",
      missing: [], teams_with_games: ["KC", "LV"], warnings: [],
    };
  },
};

const baseOpts = () => ({
  projectionProviderOverride: fakeProjections,
  scheduleProviderOverride: fakeSchedule,
  riSeasonProviderOverride: null as null,
  skipRiSeasonSignal: true,
});

function marketForCtx(): MarketSnapshot {
  return buildMarketSnapshot(marketInput({
    week: WEEK,
    rosters: { source: okSrc(), teams: [{ team_id: "team:bloodline-bowl:1", roster_id: 1, players: ["r1", "r2"], reserve: [], taxi: [], faab_used: 0, waiver_position: 1 }] },
    universe: { source: okSrc(), players: [up("r1", { position: "QB" }), up("r2", { position: "RB" }), up("fa1", { position: "RB" }), up("fa2", { position: "RB" })] },
    transactions: { source: okSrc(), entries: [{ type: "free_agent", status: "complete", status_updated: agoMs(1), adds: [], drops: ["fa2"] }] },
  }));
}

describe("end-to-end: buildWeeklyTeamContext + buildWaiverRecommendations", () => {
  it("regression case: snapshot.waiver_state === null (as in production) but Market State is healthy ⇒ AVAILABLE, considered > 0, no FREE_AGENT_POOL_UNAVAILABLE", async () => {
    const snap = ctxSnapshot();
    assert.equal(snap.waiver_state, null, "sanity: reproduces the exact production condition");
    // The canonical capability model alone (unchanged) still says UNAVAILABLE for this snapshot.
    assert.equal(assessFreeAgentPoolReadiness(snap).actionable, false);

    const res = await buildWeeklyTeamContext("bloodline-bowl", "u1", {
      ...baseOpts(),
      snapshotOverride: snap,
      enableMarketStatePool: true,
      marketSnapshotOverride: marketForCtx(),
    });
    assert.ok(res.context, res.detail);
    const ctx = res.context!;
    assert.equal(ctx.free_agent_pool_readiness.actionable, true, "Market State certification overrides the always-null canonical gate");

    const waivers = buildWaiverRecommendations(ctx);
    assert.equal(waivers.availability_status, "AVAILABLE");
    assert.equal(waivers.unavailable_reason_code, null);
    assert.ok(waivers.considered > 0, "the certified pool produced real candidates");
    // 2) a rostered player never appears, even on the certified/healthy path.
    for (const fa of ctx.availability.free_agents) assert.ok(!["r1", "r2"].map(pid).includes(fa.canonical_player_id));
    for (const rec of waivers.recommendations) assert.ok(!["r1", "r2"].map(pid).includes(rec.add_player_id));
    // 3) the on-waivers player never reaches the certified candidate set.
    assert.ok(!ctx.availability.free_agents.some((fa) => fa.canonical_player_id === pid("fa2")));
  });

  it("default (enableMarketStatePool unset) is completely unaffected by a healthy Market State override — existing behavior preserved", async () => {
    const snap = ctxSnapshot();
    const res = await buildWeeklyTeamContext("bloodline-bowl", "u1", {
      ...baseOpts(),
      snapshotOverride: snap,
      // enableMarketStatePool intentionally omitted
      marketSnapshotOverride: marketForCtx(),
    });
    assert.ok(res.context);
    assert.equal(res.context!.free_agent_pool_readiness.actionable, false, "opting in is required — no call site is silently upgraded");
    const waivers = buildWaiverRecommendations(res.context!);
    assert.equal(waivers.availability_status, "UNAVAILABLE");
    assert.equal(waivers.unavailable_reason_code, "FREE_AGENT_POOL_UNAVAILABLE");
  });

  it("Market State NOT_READY (even with enableMarketStatePool) still fails closed", async () => {
    const snap = ctxSnapshot();
    const notReady = buildMarketSnapshot(marketInput({ rosters: { source: badSrc(), teams: [] } }));
    const res = await buildWeeklyTeamContext("bloodline-bowl", "u1", {
      ...baseOpts(), snapshotOverride: snap, enableMarketStatePool: true, marketSnapshotOverride: notReady,
    });
    assert.ok(res.context);
    assert.equal(res.context!.free_agent_pool_readiness.actionable, false);
    const waivers = buildWaiverRecommendations(res.context!);
    assert.equal(waivers.availability_status, "UNAVAILABLE");
    assert.equal(waivers.unavailable_reason_code, "FREE_AGENT_POOL_UNAVAILABLE");
  });

  it("a genuine Market State read failure (thrown, not just NOT_READY) fails closed and is surfaced as a warning, never crashes weekly context", async () => {
    const snap = ctxSnapshot();
    const res = await buildWeeklyTeamContext("bloodline-bowl", "u1", {
      ...baseOpts(),
      snapshotOverride: snap,
      enableMarketStatePool: true,
      marketSnapshotLoader: async () => { throw new Error("simulated Sleeper outage"); },
    });
    assert.ok(res.context, res.detail);
    const ctx = res.context!;
    assert.equal(ctx.free_agent_pool_readiness.actionable, false);
    assert.equal(ctx.free_agent_pool_readiness.reason_code, "FREE_AGENT_POOL_UNAVAILABLE");
    assert.ok(ctx.warnings.some((w) => w.code === "MARKET_STATE_READ_FAILED"));
    // Unrelated engines are unaffected by the failure.
    assert.ok(ctx.starters.length > 0 || ctx.bench.length > 0 || ctx.all_rostered.length > 0);
  });

  it("orchestrator-equivalent path (buildWeeklyIntelligence with enableMarketStatePool) surfaces the same certified waiver truth", async () => {
    const snap = ctxSnapshot();
    const result = await buildWeeklyIntelligence("bloodline-bowl", "u1", {
      ...baseOpts(), snapshotOverride: snap, enableMarketStatePool: true, marketSnapshotOverride: marketForCtx(),
    });
    assert.ok(result.intelligence, result.detail);
    assert.equal(result.intelligence!.waivers.availability_status, "AVAILABLE");
    assert.ok(result.intelligence!.waivers.considered > 0);
  });

  it("no duplicated readiness logic end-to-end: the certified pool_id matches the pure buildFreeAgentPool reduction of the same market", async () => {
    const snap = ctxSnapshot();
    const market = marketForCtx();
    const res = await buildWeeklyTeamContext("bloodline-bowl", "u1", {
      ...baseOpts(), snapshotOverride: snap, enableMarketStatePool: true, marketSnapshotOverride: market,
    });
    assert.ok(res.context);
    const direct = buildFreeAgentPool(market);
    // The certified free_agents (intersected with THIS manager's candidate universe) must all
    // be members of the SAME pure pool reduction — never a parallel/looser interpretation.
    const memberIds = new Set(direct.members.map((m) => pid(m.provider_player_id)));
    for (const fa of res.context!.availability.free_agents) assert.ok(memberIds.has(fa.canonical_player_id));
  });
});
