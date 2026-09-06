/**
 * Phase 1C — deterministic certification (no network).
 *
 * Guards the harness logic itself, the field-completeness classification, the
 * roster-eligibility matrix, scoring equivalence, snapshot-identity semantics,
 * and request-scope isolation under concurrency.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  toCanonicalTeams,
} from "../lib/providers/sleeper/canonical";
import type { RawLeagueUser, RawRoster } from "../lib/sleeper/types";
import { buildCanonicalLeagueState } from "../lib/canonical/state";
import { runInLeagueStateScope } from "../lib/canonical/request-scope";
import { snapshotLineage } from "../lib/canonical/snapshot-lineage";
import { scoringFingerprint } from "../lib/canonical/scoring-fingerprint";
import { slotEligiblePositions } from "../lib/weekly/slots";
import { buildWeeklyTeamContext } from "../lib/weekly/context";
import { certify, factsFromCanonical, type LeagueFacts } from "../lib/canonical/certification/harness";
import { setPersistence, memoryPersistence } from "../lib/persistence";
import { ok, type CanonicalLeagueStateBundle, type FantasyProvider } from "../lib/providers/types";
import type { ProjectionProvider } from "../lib/weekly/projections/types";
import type { ScheduleProvider } from "../lib/weekly/schedule/types";
import type { WeeklyProjectionBatch } from "../lib/weekly/schema";

setPersistence(memoryPersistence());

/* ------------------------------------------------------- 1. harness self-test */

describe("harness: certify() detects a disagreement, ignores agreement", () => {
  const base: LeagueFacts = {
    source: "a",
    provider_league_id: "123",
    season: 2026,
    week: 3,
    status: "in_season",
    teams: new Map([[1, { roster_id: 1, owner_user_id: "u1", manager_display_name: "A", team_name: "T", wins: 2 }]]),
  };
  it("identical facts -> no discrepancies", () => {
    assert.deepEqual(certify(base, { ...base, source: "b" }), []);
  });
  it("a changed team_name IS flagged", () => {
    const b: LeagueFacts = {
      ...base,
      source: "b",
      teams: new Map([[1, { roster_id: 1, owner_user_id: "u1", manager_display_name: "A", team_name: "DIFFERENT", wins: 2 }]]),
    };
    const ds = certify(base, b);
    assert.equal(ds.length, 1);
    assert.equal(ds[0]!.field, "team_name");
    assert.equal(ds[0]!.scope, "team:1");
  });
  it("a changed scoring config IS flagged (via fingerprint, not byte identity)", () => {
    const a: LeagueFacts = { source: "a", raw_scoring: { rec: 1, pass_td: 4 } };
    const same: LeagueFacts = { source: "b", raw_scoring: { pass_td: 4, rec: 1 } }; // reordered
    const diff: LeagueFacts = { source: "c", raw_scoring: { rec: 0.5, pass_td: 4 } };
    assert.deepEqual(certify(a, same), []);
    assert.equal(certify(a, diff).length, 1);
  });
  it("an `allow`ed field disagreement is suppressed", () => {
    const b: LeagueFacts = { ...base, source: "b", status: "complete" };
    assert.deepEqual(certify(base, b, { allow: ["status"] }), []);
    assert.equal(certify(base, b).length, 1);
  });
  it("a partial (per-manager) surface never triggers a missing-team discrepancy", () => {
    const partial: LeagueFacts = { source: "weekly", partial: true, teams: new Map() };
    assert.deepEqual(certify(base, partial), []);
  });
});

/* ------------------------------- 2. field completeness — "wrong source object" */

describe("field completeness: team_name is read from the correct provider object", () => {
  it("team_name on the USER object is picked up (the 1B.2 defect scenario)", () => {
    const users: RawLeagueUser[] = [
      { user_id: "u1", display_name: "Mgr One", avatar: null, is_owner: true, is_bot: false, league_id: "cert_league", metadata: { team_name: "User-Set Name" }, settings: null },
    ];
    const rosters: RawRoster[] = [
      { roster_id: 1, league_id: "cert_league", owner_id: "u1", co_owners: null, players: [], starters: [], reserve: [], taxi: [], keepers: [], settings: { wins: 1 }, metadata: null },
    ];
    const teams = toCanonicalTeams("cert", rosters, users, null, null);
    assert.equal(teams[0]!.team_name, "User-Set Name");
    assert.equal(teams[0]!.provider_owner_id, "u1");
  });

  it("team_name on the ROSTER object is the fallback", () => {
    const users: RawLeagueUser[] = [
      { user_id: "u1", display_name: "Mgr One", avatar: null, is_owner: true, is_bot: false, league_id: "cert_league", metadata: null, settings: null },
    ];
    const rosters: RawRoster[] = [
      { roster_id: 1, league_id: "cert_league", owner_id: "u1", co_owners: null, players: [], starters: [], reserve: [], taxi: [], keepers: [], settings: { wins: 1 }, metadata: { team_name: "Roster-Set Name" } },
    ];
    const teams = toCanonicalTeams("cert", rosters, users, null, null);
    assert.equal(teams[0]!.team_name, "Roster-Set Name");
  });

  it("a departed owner keeps a recoverable id; a vacant seat is fully null", () => {
    const users: RawLeagueUser[] = []; // nobody in /users
    const rosters: RawRoster[] = [
      { roster_id: 1, league_id: "cert_league", owner_id: "left-the-league", co_owners: null, players: [], starters: [], reserve: [], taxi: [], keepers: [], settings: {}, metadata: null },
      { roster_id: 2, league_id: "cert_league", owner_id: null, co_owners: null, players: [], starters: [], reserve: [], taxi: [], keepers: [], settings: {}, metadata: null },
    ];
    const teams = toCanonicalTeams("cert", rosters, users, null, null);
    assert.equal(teams[0]!.provider_owner_id, "left-the-league");
    assert.equal(teams[0]!.team_name, null);
    assert.equal(teams[1]!.provider_owner_id, null);
    assert.equal(teams[1]!.canonical_manager_ids.length, 0);
  });
});

/* -------------------------------------------- 3. roster / eligibility matrix */

function bundleWith(startingSlots: string[], rawScoring: Record<string, number>): CanonicalLeagueStateBundle {
  const slug = "bloodline-bowl";
  const p = (id: string, pos: string) => ({
    canonical_player_id: `player:sleeper:${id}`,
    full_name: id, first_name: null, last_name: null, position: pos as never,
    eligible_positions: [pos] as never, nfl_team: "KC", is_team_defense: pos === "DEF",
    status: null, injury_status: null, identifiers: { sleeper_id: id },
    resolution: { method: "stable_id" as const, confidence: "high" as const, note: null },
  });
  const ids = startingSlots.map((_, i) => `p${i}`);
  const roster = {
    canonical_roster_id: `roster:${slug}:1`, canonical_team_id: `team:${slug}:1`,
    slots: startingSlots.map((slot, i) => ({ slot, slot_index: i, canonical_player_id: ids[i]!, is_empty: false })),
    starters: ids, bench: [], ir: [], taxi: [], all_players: ids,
    provenance: { provider: "sleeper" as const, provider_id: "1", provider_synced_at: null },
  };
  const slotReq: Record<string, number> = {};
  for (const s of startingSlots) slotReq[s] = (slotReq[s] ?? 0) + 1;
  return {
    league: {
      canonical_league_id: `league:${slug}`, league_slug: slug, name: slug, season: 2026,
      status: "in_season", sport: "nfl", team_count: 12, current_week: 2,
      scoring_rules: [], raw_scoring: rawScoring,
      roster_settings: { starting_slots: startingSlots, bench_slots: 5, ir_slots: 1, taxi_slots: 0, slot_requirements: slotReq, roster_positions_raw: [...startingSlots, "BN", "IR"] },
      playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: slug, provider_synced_at: null },
    },
    managers: [{ canonical_manager_id: `manager:${slug}:u1`, manager_slug: "supyo29", provider_username: "supyo29", display_name: "supyo29", provider_user_id: "u1", is_commissioner: false, is_co_manager: false, provenance: { provider: "sleeper", provider_id: "u1", provider_synced_at: null } }],
    teams: [{ canonical_team_id: `team:${slug}:1`, canonical_league_id: `league:${slug}`, provider_team_id: "1", team_name: "T1", canonical_manager_ids: [`manager:${slug}:u1`], provider_owner_id: "u1", record: { wins: 1, losses: 0, ties: 0, points_for: 100, points_against: 90 }, faab_remaining: 100, waiver_priority: 1, provenance: { provider: "sleeper", provider_id: "1", provider_synced_at: null } }],
    rosters: [roster],
    standings: [{ canonical_team_id: `team:${slug}:1`, rank: 1, wins: 1, losses: 0, ties: 0, win_percentage: 1, points_for: 100, points_against: 90, games_played: 1, playoff_seed: 1 }],
    draft_picks: [], players: startingSlots.map((s, i) => p(`p${i}`, s === "SUPER_FLEX" ? "QB" : ["FLEX", "W/R/T"].includes(s) ? "RB" : s)),
    unresolved_players: [],
  };
}

function provider(bundle: CanonicalLeagueStateBundle): FantasyProvider {
  return {
    name: "sleeper", authentication: "NONE",
    capabilities: () => ({ league: true, settings: true, managers: true, standings: true, rosters: true, matchups: true, transactions: true, players: true, free_agents: true, waivers: true, draft_results: true, live_authenticated_access: true }),
    healthCheck: async () => ({ provider: "sleeper", status: "READY", authentication: "NONE", detail: "", checked_at: new Date().toISOString() }),
    getLeagueState: async () => ok(bundle),
    getLeague: async () => ok(bundle.league),
    getManagers: async () => ok(bundle.managers),
    getStandings: async () => ok(bundle.standings),
    getRosters: async () => ok(bundle.rosters),
    getMatchups: async () => ok([]),
    getTransactions: async () => ok([]),
    getDraftResults: async () => ok([]),
    getWaiverState: async () => ok({ canonical_league_id: bundle.league.canonical_league_id, league_slug: bundle.league.league_slug, players: [], provenance: { provider: "sleeper", provider_id: null, provider_synced_at: null } }),
  };
}

const fakeProj: ProjectionProvider = {
  name: "f", model_version: "sleeper-weekly-rotowire",
  async getWeeklyProjections(req): Promise<WeeklyProjectionBatch> {
    const by_player: WeeklyProjectionBatch["by_player"] = new Map();
    for (const cid of req.canonical_player_ids) by_player.set(cid, { canonical_player_id: cid, week: req.week, season: 2026, position: "RB", nfl_team: "KC", opponent: "LV", is_home: null, projected_points: 10, floor_points: 6, ceiling_points: 14, std_dev: 4, projection_status: "projected", expected_availability: 1, is_bye: false, injury_status: null, rest_of_season_points: 100, ros: null, source: "f", model_version: "sleeper-weekly-rotowire", uncertainty_source: "position_volatility_heuristic", warnings: [] });
    return { league_slug: req.league.league_slug, season: 2026, week: req.week, status: "READY", by_player, resolved_players: new Map(), source: "f", model_version: "sleeper-weekly-rotowire", missing: [], teams_with_games: ["KC", "LV"], warnings: [] };
  },
};
const fakeSched: ScheduleProvider = { name: "f", async getWeekSchedule(s, w) { return { season: s, week: w, status: "UNAVAILABLE", source: "f", teams_with_games: new Set(), teams_on_bye: new Set(), opponent_by_team: {}, warnings: [] }; } };

describe("roster/eligibility: weekly slot machinery is the single reference", () => {
  for (const [label, slots, flex] of [
    ["standard FLEX", ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"], "FLEX"],
    ["SUPER_FLEX", ["QB", "RB", "RB", "WR", "WR", "TE", "SUPER_FLEX", "K", "DEF"], "SUPER_FLEX"],
    ["Yahoo W/R/T", ["QB", "RB", "RB", "WR", "WR", "TE", "W/R/T", "K", "DEF"], "W/R/T"],
  ] as [string, string[], string][]) {
    it(`${label}: weekly flex_positions == slotEligiblePositions("${flex}")`, async () => {
      const weekly = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
        providerOverride: provider(bundleWith(slots, { rec: 1, pass_td: 4 })),
        projectionProviderOverride: fakeProj,
        scheduleProviderOverride: fakeSched,
        riSeasonProviderOverride: null,
        skipRiSeasonSignal: true,
      });
      assert.ok(weekly.context);
      assert.deepEqual(
        [...weekly.context!.league.roster_constraints.flex_positions].sort(),
        [...slotEligiblePositions(flex)].sort(),
      );
    });
  }
});

/* --------------------------------------- 4. scoring equivalence certification */

describe("scoring: equivalence, not byte identity", () => {
  it("reordered keys + an explicit zero rule -> same fingerprint", () => {
    assert.equal(
      scoringFingerprint({ rec: 1, pass_td: 4, fum_lost: 0 }),
      scoringFingerprint({ pass_td: 4, rec: 1 }),
    );
  });
  it("a real value change -> different fingerprint", () => {
    assert.notEqual(scoringFingerprint({ rec: 1 }), scoringFingerprint({ rec: 0.5 }));
  });
});

/* --------------------------------- 5. snapshot identity semantics (contract) */

describe("snapshot identity: the documented content-hash contract", () => {
  const base = () => bundleWith(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"], { rec: 1, pass_td: 4 });
  const idOf = async (b: CanonicalLeagueStateBundle) =>
    snapshotLineage((await buildCanonicalLeagueState("bloodline-bowl", { providerOverride: provider(b), reportPersistence: false })).snapshot!).league_snapshot_id;

  it("unchanged material state -> same id", async () => {
    assert.equal(await idOf(base()), await idOf(base()));
  });
  it("ownership change -> new id", async () => {
    const b = base();
    b.rosters[0]!.starters = [...b.rosters[0]!.starters].reverse();
    b.rosters[0]!.all_players = [...b.rosters[0]!.all_players].reverse();
    assert.notEqual(await idOf(base()), await idOf(b));
  });
  it("scoring change -> new fingerprint AND new id", async () => {
    const b = base();
    b.league.raw_scoring = { rec: 0.5, pass_td: 4 };
    assert.notEqual(await idOf(base()), await idOf(b));
  });
  it("team-name metadata change -> new id (team_name IS in the hashed body)", async () => {
    const b = base();
    b.teams[0]!.team_name = "Renamed";
    assert.notEqual(await idOf(base()), await idOf(b));
  });
  it("a provider-timestamp-only difference -> SAME id (nested provider_synced_at is stripped)", async () => {
    const b1 = base();
    const b2 = base();
    b2.league.provenance.provider_synced_at = "2099-01-01T00:00:00.000Z";
    for (const t of b2.teams) t.provenance.provider_synced_at = "2099-01-01T00:00:00.000Z";
    for (const r of b2.rosters) r.provenance.provider_synced_at = "2099-01-01T00:00:00.000Z";
    assert.equal(await idOf(b1), await idOf(b2));
  });
});

/* -------------------------------- 6. request-scope isolation under concurrency */

describe("request-scope: isolation + concurrency", () => {
  it("two concurrent scopes for the same slug do not share state or leak", async () => {
    let calls = 0;
    const mk = () => {
      calls += 1;
      const b = bundleWith(["QB", "RB", "WR", "K", "DEF"], { rec: calls });
      return provider(b);
    };
    const [idA, idB] = await Promise.all([
      runInLeagueStateScope(async () => {
        const p = mk();
        const s1 = await buildCanonicalLeagueState("bloodline-bowl", { providerOverride: p, reportPersistence: false });
        const s2 = await buildCanonicalLeagueState("bloodline-bowl", { providerOverride: p, reportPersistence: false });
        // one read within the scope
        assert.equal(s1.snapshot!.lineage!.league_snapshot_id, s2.snapshot!.lineage!.league_snapshot_id);
        return factsFromCanonical(s1.snapshot!).snapshot_id;
      }),
      runInLeagueStateScope(async () => {
        const p = mk();
        const s = await buildCanonicalLeagueState("bloodline-bowl", { providerOverride: p, reportPersistence: false });
        return factsFromCanonical(s.snapshot!).snapshot_id;
      }),
    ]);
    // The two scopes used different provider data (different `rec`), so different ids.
    assert.notEqual(idA, idB);
  });

  it("an error inside one scope does not poison a later scope", async () => {
    await assert.rejects(
      runInLeagueStateScope(async () => {
        throw new Error("boom");
      }),
    );
    const id = await runInLeagueStateScope(async () => {
      const s = await buildCanonicalLeagueState("bloodline-bowl", {
        providerOverride: provider(bundleWith(["QB", "RB", "WR", "K", "DEF"], { rec: 1 })),
        reportPersistence: false,
      });
      return snapshotLineage(s.snapshot!).league_snapshot_id;
    });
    assert.ok(id.startsWith("snap:bloodline-bowl:"));
  });
});
