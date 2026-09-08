/**
 * Capability + materiality model.
 *
 * Both directions of the rule the user asked for:
 *   1. a non-material warning still permits publication (integrity CERTIFIED),
 *      but the affected capability is DEGRADED / UNAVAILABLE — never HEALTHY;
 *   2. the SAME warning becomes integrity-blocking when the thing it degrades
 *      touches current actionable state.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessCapabilities } from "../lib/canonical/capabilities";
import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalLeagueSnapshot,
  type CanonicalPlayer,
  type CanonicalWarning,
} from "../lib/canonical/schema";

const L = "bloodline-bowl";

function player(id: string, unresolved: boolean): CanonicalPlayer {
  return {
    canonical_player_id: id,
    full_name: unresolved ? `Unknown (${id})` : `Player ${id}`,
    first_name: null,
    last_name: null,
    position: "WR",
    eligible_positions: ["WR"],
    nfl_team: unresolved ? null : "KC",
    is_team_defense: false,
    status: null,
    injury_status: null,
    identifiers: { sleeper_id: id.replace("player:sleeper:", "") },
    resolution: unresolved
      ? { method: "unresolved", confidence: "none", note: "no crosswalk hit" }
      : { method: "stable_id", confidence: "exact", note: null },
  };
}

function baseSnapshot(opts: {
  players?: CanonicalPlayer[];
  rosterPlayerIds?: string[];
  warnings?: CanonicalWarning[];
  live_provider_status?: CanonicalLeagueSnapshot["live_provider_status"];
  waiver_state?: CanonicalLeagueSnapshot["waiver_state"];
  recent_transactions?: CanonicalLeagueSnapshot["recent_transactions"];
}): CanonicalLeagueSnapshot {
  const teams = [1, 2].map((rid) => ({
    canonical_team_id: `team:${L}:${rid}`,
    canonical_league_id: `league:${L}`,
    provider_team_id: String(rid),
    team_name: `Team ${rid}`,
    canonical_manager_ids: [`manager:${L}:u${rid}`],
    provider_owner_id: `u${rid}`,
    record: { wins: 1, losses: 1, ties: 0, points_for: 0, points_against: 0 },
    faab_remaining: 100,
    waiver_priority: rid,
    provenance: { provider: "sleeper" as const, provider_id: "x", provider_synced_at: null },
  }));
  const rosterIds = opts.rosterPlayerIds ?? [];
  return {
    schema_version: CANONICAL_SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    provider_synced_at: new Date().toISOString(),
    league: {
      canonical_league_id: `league:${L}`,
      league_slug: L,
      name: "Bloodline Bowl",
      season: 2026,
      status: "in_season",
      sport: "nfl",
      team_count: 2,
      current_week: 3,
      scoring_rules: [],
      raw_scoring: {},
      roster_settings: { starting_slots: ["WR"], bench_slots: 4, ir_slots: 1, taxi_slots: 0, slot_requirements: {} },
      playoff_settings: { playoff_team_count: null, playoff_start_week: null, championship_week: null },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: "x", provider_synced_at: null },
    },
    season: 2026,
    week: 3,
    managers: [1, 2].map((rid) => ({
      canonical_manager_id: `manager:${L}:u${rid}`,
      canonical_league_id: `league:${L}`,
      manager_slug: `u${rid}`,
      display_name: `M${rid}`,
      provider_user_id: `u${rid}`,
      provider_username: `u${rid}`,
      is_commissioner: false,
      is_co_manager: false,
      provenance: { provider: "sleeper" as const, provider_id: "x", provider_synced_at: null },
    })),
    teams,
    rosters: [
      {
        canonical_roster_id: `roster:${L}:1`,
        canonical_team_id: `team:${L}:1`,
        slots: [],
        starters: rosterIds.slice(0, 1),
        bench: rosterIds.slice(1),
        ir: [],
        taxi: [],
        all_players: rosterIds,
        provenance: { provider: "sleeper", provider_id: "x", provider_synced_at: null },
      },
    ],
    standings: teams.map((t, i) => ({
      canonical_team_id: t.canonical_team_id,
      rank: i + 1,
      wins: 1,
      losses: 1,
      ties: 0,
      win_percentage: 0.5,
      points_for: 0,
      points_against: 0,
      games_played: 2,
      playoff_seed: null,
    })),
    matchups: [],
    recent_transactions: opts.recent_transactions ?? [],
    draft_picks: [],
    waiver_state: opts.waiver_state ?? null,
    players: opts.players ?? [],
    unresolved_players: [],
    live_provider_status: opts.live_provider_status ?? "READY",
    history_persistence_status: "READY",
    warnings: opts.warnings ?? [],
  };
}

describe("assessCapabilities: unresolved-identity materiality", () => {
  it("unresolved id NOT on any surface -> benign, integrity CERTIFIED, player_identity DEGRADED", () => {
    const ghost = player("player:sleeper:99999", true);
    const r = assessCapabilities(
      baseSnapshot({ players: [ghost], rosterPlayerIds: [] }),
    );
    assert.equal(r.snapshot_integrity, "CERTIFIED");
    assert.equal(r.material_unresolved.length, 0);
    assert.equal(r.benign_unresolved_count, 1);
    assert.equal(r.capabilities.player_identity.status, "DEGRADED");
    assert.equal(r.capabilities.roster_state.status, "HEALTHY");
  });

  it("SAME unresolved id ON a current roster -> material, integrity REJECTED", () => {
    const onRoster = player("player:sleeper:99999", true);
    const r = assessCapabilities(
      baseSnapshot({ players: [onRoster], rosterPlayerIds: ["player:sleeper:99999"] }),
    );
    assert.equal(r.snapshot_integrity, "REJECTED");
    assert.equal(r.material_unresolved.length, 1);
    assert.ok(r.material_unresolved[0]!.surfaces.includes("starting_lineup"));
    assert.equal(r.capabilities.player_identity.status, "UNAVAILABLE");
    assert.equal(r.capabilities.roster_state.status, "DEGRADED");
    assert.equal(r.capabilities.ownership.status, "DEGRADED");
  });

  it("unresolved id referenced only by a recent transaction -> material", () => {
    const traded = player("player:sleeper:88888", true);
    const r = assessCapabilities(
      baseSnapshot({
        players: [traded],
        recent_transactions: [
          {
            canonical_transaction_id: "t1",
            canonical_league_id: `league:${L}`,
            league_slug: L,
            season: 2026,
            type: "waiver_add",
            status: "complete",
            provider_timestamp: null,
            fantasy_week: 3,
            canonical_team_ids: [`team:${L}:1`],
            players_added: [{ canonical_player_id: "player:sleeper:88888", canonical_team_id: `team:${L}:1` }],
            players_dropped: [],
            trade_legs: [],
            faab_spent: null,
            provenance: { provider: "sleeper", provider_id: "tx1", provider_synced_at: null },
            source_metadata: {},
          },
        ],
      }),
    );
    assert.equal(r.snapshot_integrity, "REJECTED");
    assert.equal(r.capabilities.transactions.status, "DEGRADED");
  });
});

describe("assessCapabilities: capability degradation without integrity loss", () => {
  it("HISTORY_PERSISTENCE_UNAVAILABLE -> CERTIFIED, history DEGRADED only", () => {
    const r = assessCapabilities(
      baseSnapshot({ warnings: [{ code: "HISTORY_PERSISTENCE_UNAVAILABLE", message: "down" }] }),
    );
    assert.equal(r.snapshot_integrity, "CERTIFIED");
    assert.equal(r.capabilities.history_persistence.status, "DEGRADED");
    assert.equal(r.capabilities.roster_state.status, "HEALTHY");
    assert.equal(r.capabilities.standings.status, "HEALTHY");
  });

  it("free_agent_pool_not_materialized -> CERTIFIED, free_agent_pool UNAVAILABLE (never HEALTHY)", () => {
    const r = assessCapabilities(
      baseSnapshot({ warnings: [{ code: "free_agent_pool_not_materialized", message: "n/a" }] }),
    );
    assert.equal(r.snapshot_integrity, "CERTIFIED");
    assert.equal(r.capabilities.free_agent_pool.status, "UNAVAILABLE");
    assert.ok(r.capabilities.free_agent_pool.reasons[0]!.includes("MUST NOT claim CURRENT/FRESH"));
  });

  it("week_transactions_unavailable -> CERTIFIED, transactions DEGRADED, does not imply []", () => {
    const r = assessCapabilities(
      baseSnapshot({ warnings: [{ code: "week_transactions_unavailable", message: "wk 3 failed" }] }),
    );
    assert.equal(r.snapshot_integrity, "CERTIFIED");
    assert.equal(r.capabilities.transactions.status, "DEGRADED");
    assert.ok(r.capabilities.transactions.reasons[0]!.includes("does NOT imply no transactions"));
    assert.equal(r.capabilities.roster_state.status, "HEALTHY");
  });

  it("player_database_unavailable is a CORE outage -> integrity REJECTED", () => {
    const r = assessCapabilities(
      baseSnapshot({
        live_provider_status: "PARTIAL",
        warnings: [{ code: "player_database_unavailable", message: "down" }],
      }),
    );
    assert.equal(r.snapshot_integrity, "REJECTED");
    assert.equal(r.capabilities.player_identity.status, "UNAVAILABLE");
  });

  it("an unknown warning fails closed -> integrity REJECTED", () => {
    const r = assessCapabilities(
      baseSnapshot({ warnings: [{ code: "some_new_warning_we_dont_model", message: "?" }] }),
    );
    assert.equal(r.snapshot_integrity, "REJECTED");
  });

  it("a clean snapshot -> CERTIFIED, every capability HEALTHY except pool (needs materialization)", () => {
    const r = assessCapabilities(baseSnapshot({}));
    assert.equal(r.snapshot_integrity, "CERTIFIED");
    assert.equal(r.capabilities.roster_state.status, "HEALTHY");
    assert.equal(r.capabilities.ownership.status, "HEALTHY");
    assert.equal(r.capabilities.standings.status, "HEALTHY");
    assert.equal(r.capabilities.transactions.status, "HEALTHY");
    assert.equal(r.capabilities.history_persistence.status, "HEALTHY");
    assert.equal(r.capabilities.player_identity.status, "HEALTHY");
    // free_agent_pool + matchups + draft_availability are genuinely absent here.
    assert.equal(r.capabilities.free_agent_pool.status, "UNAVAILABLE");
  });
});
