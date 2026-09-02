/**
 * Path-based routing + generic manager context + league isolation —
 * deterministic (no network). Providers and crosswalk are injected.
 *
 * Proves:
 *  - bloodline-bowl / devoted-to-the-game resolve to the Sleeper provider
 *  - maclin-on-chicks-xvi resolves to the Yahoo provider (AUTH_REQUIRED, not fabricated)
 *  - an unknown league is a clear 404, never a fallback
 *  - supyo29, BijiMac, DarthMarker all resolve through ONE generic code path
 *  - a non-member manager is rejected, never swapped for another
 *  - no cross-league contamination
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCanonicalLeagueState } from "../lib/canonical/state";
import { buildManagerContext } from "../lib/canonical/manager-context";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalManager,
  type CanonicalFantasyTeam,
} from "../lib/canonical/schema";
import type {
  CanonicalLeagueStateBundle,
  FantasyProvider,
} from "../lib/providers/types";
import { ok } from "../lib/providers/types";

/** Every call below sets `reportPersistence: false` — persistence has its own suite. */
const BASE = { reportPersistence: false as const };

/* A fake provider returning a fixed 2-team league keyed to whatever slug asks. */
function fakeProvider(slug: string, managerSpecs: Array<{ slug: string; userId: string; username: string; team: number }>): FantasyProvider {
  const managers: CanonicalManager[] = managerSpecs.map((m) => ({
    canonical_manager_id: `manager:${slug}:${m.userId}`,
    manager_slug: m.slug,
    provider_username: m.username,
    display_name: m.username,
    provider_user_id: m.userId,
    is_commissioner: false,
    is_co_manager: false,
    provenance: { provider: "sleeper", provider_id: m.userId, provider_synced_at: null },
  }));
  const teams: CanonicalFantasyTeam[] = managerSpecs.map((m) => ({
    canonical_team_id: `team:${slug}:${m.team}`,
    canonical_league_id: `league:${slug}`,
    provider_team_id: String(m.team),
    team_name: `${m.username}'s team`,
    canonical_manager_ids: [`manager:${slug}:${m.userId}`],
    record: { wins: m.team, losses: 3 - m.team, ties: 0, points_for: 300 + m.team, points_against: 290 },
    faab_remaining: 90,
    waiver_priority: m.team,
    provenance: { provider: "sleeper", provider_id: String(m.team), provider_synced_at: null },
  }));
  const bundle: CanonicalLeagueStateBundle = {
    league: {
      canonical_league_id: `league:${slug}`,
      league_slug: slug,
      name: slug,
      season: 2026,
      status: "in_season",
      sport: "nfl",
      team_count: teams.length,
      current_week: 3,
      scoring_rules: [{ key: "rec", points: slug === "devoted-to-the-game" ? 1 : 0.5, category: "receiving" }],
      raw_scoring: { rec: slug === "devoted-to-the-game" ? 1 : 0.5 },
      roster_settings: { starting_slots: ["QB", "RB", "WR"], bench_slots: 5, ir_slots: 1, taxi_slots: 0, slot_requirements: { QB: 1, RB: 1, WR: 1 } },
      playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: slug, provider_synced_at: null },
    },
    managers,
    teams,
    rosters: teams.map((t) => ({
      canonical_roster_id: t.canonical_team_id.replace("team:", "roster:"),
      canonical_team_id: t.canonical_team_id,
      slots: [{ slot: "QB", slot_index: 0, canonical_player_id: `player:sleeper:${slug}-qb-${t.provider_team_id}`, is_empty: false }],
      starters: [`player:sleeper:${slug}-qb-${t.provider_team_id}`],
      bench: [],
      ir: [],
      taxi: [],
      all_players: [`player:sleeper:${slug}-qb-${t.provider_team_id}`],
      provenance: { provider: "sleeper", provider_id: t.provider_team_id, provider_synced_at: null },
    })),
    standings: teams.map((t, i) => ({
      canonical_team_id: t.canonical_team_id,
      rank: i + 1,
      wins: t.record.wins,
      losses: t.record.losses,
      ties: 0,
      win_percentage: t.record.wins / 3,
      points_for: t.record.points_for,
      points_against: t.record.points_against,
      games_played: 3,
      playoff_seed: i + 1,
    })),
    draft_picks: [],
    players: teams.map((t) => ({
      canonical_player_id: `player:sleeper:${slug}-qb-${t.provider_team_id}`,
      full_name: `${slug} QB ${t.provider_team_id}`,
      first_name: null,
      last_name: null,
      position: "QB" as const,
      eligible_positions: ["QB" as const],
      nfl_team: "KC",
      is_team_defense: false,
      status: null,
      injury_status: null,
      identifiers: { sleeper_id: `${slug}-qb-${t.provider_team_id}` },
      resolution: { method: "stable_id" as const, confidence: "high" as const, note: null },
    })),
    unresolved_players: [],
  };

  return {
    name: "sleeper",
    authentication: "NONE",
    capabilities: () => ({
      league: true, settings: true, managers: true, standings: true, rosters: true,
      matchups: true, transactions: true, players: true, free_agents: true, waivers: true,
      draft_results: true, live_authenticated_access: true,
    }),
    healthCheck: async () => ({ provider: "sleeper", status: "READY", authentication: "NONE", detail: "fake", checked_at: new Date().toISOString() }),
    getLeagueState: async () => ok(bundle),
    getLeague: async () => ok(bundle.league),
    getManagers: async () => ok(bundle.managers),
    getStandings: async () => ok(bundle.standings),
    getRosters: async () => ok(bundle.rosters),
    getMatchups: async () => ok([]),
    getTransactions: async () => ok([]),
    getDraftResults: async () => ok([]),
    getWaiverState: async () =>
      ok({ canonical_league_id: `league:${slug}`, league_slug: slug, players: [], provenance: { provider: "sleeper", provider_id: slug, provider_synced_at: null } }),
  } satisfies FantasyProvider;
}

const emptyCrosswalk = () => new PlayerCrosswalk(NoCrosswalk);

const BLOODLINE = () =>
  fakeProvider("bloodline-bowl", [
    { slug: "supyo29", userId: "1308955807408230400", username: "Supyo29", team: 1 },
    { slug: "bijimac", userId: "1395574107612942336", username: "BijiMac", team: 2 },
  ]);
const DEVOTED = () =>
  fakeProvider("devoted-to-the-game", [
    { slug: "darthmarker", userId: "1265419589680910336", username: "DarthMarker", team: 1 },
    { slug: "someoneelse", userId: "999", username: "SomeoneElse", team: 2 },
  ]);

/* ------------------------------------------------------------- league routing */

describe("path routing: slug -> provider", () => {
  it("bloodline-bowl resolves to the Sleeper provider and returns canonical state", async () => {
    const r = await buildCanonicalLeagueState("bloodline-bowl", {
      ...BASE,
      providerOverride: BLOODLINE(),
      crosswalkOverride: emptyCrosswalk(),
    });
    assert.equal(r.ok, true);
    assert.equal(r.snapshot!.schema_version, CANONICAL_SCHEMA_VERSION);
    assert.equal(r.snapshot!.league.league_slug, "bloodline-bowl");
    assert.equal(r.snapshot!.league.provenance.provider, "sleeper");
  });

  it("devoted-to-the-game resolves independently (different scoring, no shared state)", async () => {
    const bb = await buildCanonicalLeagueState("bloodline-bowl", { ...BASE, providerOverride: BLOODLINE(), crosswalkOverride: emptyCrosswalk() });
    const dv = await buildCanonicalLeagueState("devoted-to-the-game", { ...BASE, providerOverride: DEVOTED(), crosswalkOverride: emptyCrosswalk() });
    assert.notEqual(
      bb.snapshot!.league.raw_scoring.rec,
      dv.snapshot!.league.raw_scoring.rec,
    );
    // No Bloodline team ids leak into Devoted.
    const dvTeamIds = dv.snapshot!.teams.map((t) => t.canonical_team_id);
    assert.ok(dvTeamIds.every((id) => id.startsWith("team:devoted-to-the-game:")));
  });

  for (const slug of ["maclin-on-chicks-xvi", "rogers-park"] as const) {
    it(`${slug} resolves to the Yahoo provider — AUTH_REQUIRED/NOT_CONFIGURED, not fabricated`, async () => {
      // No providerOverride -> real registry factory -> real YahooProvider (no env).
      const r = await buildCanonicalLeagueState(slug, { ...BASE, crosswalkOverride: emptyCrosswalk() });
      assert.ok(["NOT_CONFIGURED", "AUTH_REQUIRED"].includes(r.snapshot!.live_provider_status));
      assert.equal(r.snapshot!.teams.length, 0, "no fabricated teams");
      assert.equal(r.snapshot!.league.canonical_league_id, `league:${slug}`);
    });
  }

  it("an unknown league is a clear 404 — never a fallback to Bloodline", async () => {
    const r = await buildCanonicalLeagueState("not-a-real-league", { ...BASE, crosswalkOverride: emptyCrosswalk() });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.code, "league_not_found");
  });
});

/* ------------------------------------------------------- generic manager context */

describe("manager context is generic (no per-manager branches)", () => {
  for (const [league, manager, provider] of [
    ["bloodline-bowl", "supyo29", BLOODLINE],
    ["bloodline-bowl", "BijiMac", BLOODLINE],
    ["devoted-to-the-game", "DarthMarker", DEVOTED],
    ["devoted-to-the-game", "darthmarker", DEVOTED],
  ] as const) {
    it(`${manager} resolves in ${league} through the same path`, async () => {
      const r = await buildManagerContext(league, manager, {
        providerOverride: provider(),
        crosswalkOverride: emptyCrosswalk(),
        reportPersistence: false,
      });
      assert.equal(r.ok, true, r.detail);
      assert.equal(r.context!.league.league_slug, league);
      assert.equal(r.context!.manager.manager_slug.toLowerCase(), manager.toLowerCase());
      assert.ok(r.context!.team.canonical_team_id.startsWith(`team:${league}:`));
      assert.ok(r.context!.roster.starters.length >= 0);
      assert.ok(Array.isArray(r.context!.league.scoring_rules));
    });
  }

  it("a non-member manager is rejected, never swapped for another", async () => {
    const r = await buildManagerContext("bloodline-bowl", "darthmarker", {
      providerOverride: BLOODLINE(),
      crosswalkOverride: emptyCrosswalk(),
      reportPersistence: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.code, "manager_not_in_league");
  });

  it("supyo29 and BijiMac get DIFFERENT team contexts in the same league", async () => {
    const a = await buildManagerContext("bloodline-bowl", "supyo29", { providerOverride: BLOODLINE(), crosswalkOverride: emptyCrosswalk(), reportPersistence: false });
    const b = await buildManagerContext("bloodline-bowl", "bijimac", { providerOverride: BLOODLINE(), crosswalkOverride: emptyCrosswalk(), reportPersistence: false });
    assert.notEqual(a.context!.team.canonical_team_id, b.context!.team.canonical_team_id);
  });
});
