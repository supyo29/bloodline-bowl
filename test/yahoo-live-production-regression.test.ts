import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessCapabilities } from "../lib/canonical/capabilities";
import { canonicalScoringInputs } from "../lib/canonical/compat/scoring-inputs";
import type { CanonicalLeagueSnapshot } from "../lib/canonical/schema";

function emptyRosterSnapshot(): CanonicalLeagueSnapshot {
  return {
    schema_version: 3,
    lineage: undefined,
    captured_at: "2026-09-24T00:00:00.000Z",
    provider_synced_at: "2026-09-24T00:00:00.000Z",
    league: {
      canonical_league_id: "league:rogers-park",
      league_slug: "rogers-park",
      name: "Rogers Park",
      season: 2026,
      status: "in_season",
      sport: "nfl",
      team_count: 1,
      current_week: 3,
      scoring_rules: [],
      raw_scoring: {},
      roster_settings: {
        starting_slots: ["QB"],
        bench_slots: 1,
        ir_slots: 0,
        taxi_slots: 0,
        slot_requirements: { QB: 1 },
        roster_positions_raw: ["QB", "BN"],
      },
      playoff_settings: {
        playoff_team_count: 6,
        playoff_start_week: 15,
        championship_week: 17,
      },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: {
        provider: "yahoo",
        provider_id: "470.l.287140",
        provider_synced_at: "2026-09-24T00:00:00.000Z",
      },
    },
    season: 2026,
    week: 3,
    managers: [],
    teams: [{
      canonical_team_id: "team:rogers-park:1",
      canonical_league_id: "league:rogers-park",
      provider_team_id: "470.l.287140.t.1",
      team_name: "Test Team",
      canonical_manager_ids: [],
      record: { wins: 1, losses: 1, ties: 0, points_for: 200, points_against: 200 },
      faab_remaining: 100,
      waiver_priority: 1,
      provenance: {
        provider: "yahoo",
        provider_id: "470.l.287140.t.1",
        provider_synced_at: "2026-09-24T00:00:00.000Z",
      },
    }],
    rosters: [{
      canonical_roster_id: "roster:rogers-park:1",
      canonical_team_id: "team:rogers-park:1",
      slots: [],
      starters: [],
      bench: [],
      ir: [],
      taxi: [],
      all_players: [],
      provenance: {
        provider: "yahoo",
        provider_id: "470.l.287140.t.1",
        provider_synced_at: "2026-09-24T00:00:00.000Z",
      },
    }],
    standings: [{
      canonical_team_id: "team:rogers-park:1",
      rank: 1,
      wins: 1,
      losses: 1,
      ties: 0,
      win_percentage: 0.5,
      points_for: 200,
      points_against: 200,
      games_played: 2,
      playoff_seed: 1,
    }],
    matchups: [],
    recent_transactions: [],
    draft_picks: [],
    waiver_state: null,
    players: [],
    unresolved_players: [],
    live_provider_status: "READY",
    history_persistence_status: "READY",
    warnings: [],
  };
}

describe("Yahoo live-production regression guards", () => {
  it("never certifies empty in-season roster shells as healthy ownership", () => {
    const report = assessCapabilities(emptyRosterSnapshot());
    assert.equal(report.snapshot_integrity, "REJECTED");
    assert.equal(report.capabilities.roster_state.status, "DEGRADED");
    assert.equal(report.capabilities.ownership.status, "DEGRADED");
    assert.ok(report.integrity_failures.some((x) => x.includes("no rostered players")));
  });

  it("carries Yahoo provider attribution into the provider-independent scoring surface", () => {
    const facts = canonicalScoringInputs(emptyRosterSnapshot());
    assert.equal(facts.provider, "yahoo");
    assert.equal(facts.league_id, "470.l.287140");
  });
});
