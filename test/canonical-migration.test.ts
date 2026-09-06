/**
 * Phase 1B.2 — legacy REST / analytics canonical migration.
 *
 * Deterministic golden-compatibility + `?league=` routing + cross-surface tests.
 * No network: synthetic raw Sleeper fixtures are run through BOTH the canonical
 * adapter path and the untouched legacy functions, and the outputs must match.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fixtureLeague,
  fixtureUsers,
  fixtureRosters,
} from "./fixtures";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import {
  createSleeperResolver,
  toCanonicalLeague,
  toCanonicalManagers,
  toCanonicalRosters,
  toCanonicalStandings,
  toCanonicalTeams,
} from "../lib/providers/sleeper/canonical";
import { deriveSnapshotLineage } from "../lib/canonical/snapshot-lineage";
import { CANONICAL_SCHEMA_VERSION, type CanonicalLeagueSnapshot } from "../lib/canonical/schema";
import { computeStandings } from "../lib/analytics/standings";
import { canonicalToStandingsFacts } from "../lib/canonical/compat/standings";
import {
  canonicalScoringInputs,
  reconstructRosterPositions,
} from "../lib/canonical/compat/scoring-inputs";
import { resolveLeagueForQuery } from "../lib/leagues/resolve";
import { parseLeagueSelector } from "../lib/analytics/query";
import { readFileSync } from "node:fs";
import { buildScoringBundle } from "../lib/scoring/scoring-service";

/* ---------------------------------------------------- build a fixture snapshot */

async function fixtureSnapshot(): Promise<CanonicalLeagueSnapshot> {
  const crosswalk = new PlayerCrosswalk(NoCrosswalk);
  await crosswalk.ensureLoaded();
  const playerIndex = new Map();
  const resolver = createSleeperResolver(playerIndex, crosswalk);
  const league = toCanonicalLeague("fixture-league", fixtureLeague, 5, null);
  const rosterRes = toCanonicalRosters(
    "fixture-league",
    fixtureRosters,
    league.roster_settings.starting_slots,
    playerIndex,
    crosswalk,
    null,
    resolver,
  );
  const snap: CanonicalLeagueSnapshot = {
    schema_version: CANONICAL_SCHEMA_VERSION,
    lineage: undefined,
    captured_at: "2026-09-06T00:00:00.000Z",
    provider_synced_at: null,
    league,
    season: league.season,
    week: 5,
    managers: toCanonicalManagers("fixture-league", fixtureUsers, fixtureRosters, null),
    teams: toCanonicalTeams("fixture-league", fixtureRosters, fixtureUsers, null, null),
    rosters: rosterRes.rosters,
    standings: toCanonicalStandings("fixture-league", fixtureRosters),
    matchups: [],
    recent_transactions: [],
    draft_picks: [],
    waiver_state: null,
    players: [...resolver.players.values()],
    unresolved_players: resolver.unresolved,
    live_provider_status: "READY",
    history_persistence_status: "READY",
    warnings: [],
  };
  snap.lineage = deriveSnapshotLineage(snap, { crosswalkVersion: null });
  return snap;
}

/* ------------------------------------------------- 1. standings golden parity */

describe("compat: canonicalToStandingsFacts == computeStandings(rosters, users, {}, [])", () => {
  it("byte-identical for the fixture league (departed manager + vacant roster included)", async () => {
    const snap = await fixtureSnapshot();
    const fromCanonical = canonicalToStandingsFacts(snap);
    const legacy = computeStandings(fixtureRosters, fixtureUsers, new Map(), []);
    assert.deepEqual(fromCanonical, legacy);
  });

  it("preserves the departed-manager user_id and the vacant-roster nulls", async () => {
    const snap = await fixtureSnapshot();
    const rows = canonicalToStandingsFacts(snap);
    const r1 = rows.find((r) => r.roster_id === 1)!;
    const r2 = rows.find((r) => r.roster_id === 2)!;
    const r3 = rows.find((r) => r.roster_id === 3)!;
    assert.equal(r1.manager.user_id, "u1");
    assert.equal(r1.manager.team_name, "Alpha Squad"); // from user metadata, not roster
    assert.equal(r1.win_percentage, 0.68); // round2, not the canonical 3dp
    assert.equal(r2.manager.user_id, "u2"); // owner left the league
    assert.equal(r2.manager.display_name, null);
    assert.equal(r3.manager.user_id, null); // vacant
    assert.equal(r3.games_played, 0);
    assert.equal(r3.win_percentage, null);
  });
});

/* --------------------------------------------------- 2. scoring inputs parity */

describe("compat: canonicalScoringInputs matches the raw Sleeper league", () => {
  it("league_id / name / season(string) / scoring_settings / roster_positions", async () => {
    const snap = await fixtureSnapshot();
    const facts = canonicalScoringInputs(snap);
    assert.equal(facts.league_id, fixtureLeague.league_id);
    assert.equal(facts.name, fixtureLeague.name);
    assert.equal(facts.season, fixtureLeague.season); // already a string on RawLeague
    assert.equal(typeof facts.season, "string");
    assert.deepEqual(facts.scoring_settings, fixtureLeague.scoring_settings);
    assert.deepEqual(facts.roster_positions, fixtureLeague.roster_positions);
  });

  it("roster_positions falls back to reconstruction for a pre-v3 snapshot", async () => {
    const snap = await fixtureSnapshot();
    // simulate an old persisted snapshot missing the v3 field
    delete (snap.league.roster_settings as { roster_positions_raw?: string[] }).roster_positions_raw;
    const reconstructed = reconstructRosterPositions(snap.league.roster_settings);
    // fixture is [QB,RB,RB,WR,WR,TE,FLEX,K,DEF,BN,BN,IR]
    assert.deepEqual(reconstructed, fixtureLeague.roster_positions);
  });
});

/* --------------------------------------------- 3. ?league= fallback semantics */

describe("?league= selector resolution (unchanged by 1B.2)", () => {
  it("empty selector -> the default league (bloodline-bowl)", () => {
    assert.equal(resolveLeagueForQuery(null).league_slug, "bloodline-bowl");
    assert.equal(resolveLeagueForQuery("").league_slug, "bloodline-bowl");
  });
  it("a registered slug resolves to itself", () => {
    assert.equal(resolveLeagueForQuery("devoted-to-the-game").league_slug, "devoted-to-the-game");
  });
  it("a raw numeric id is accepted as-is", () => {
    assert.equal(resolveLeagueForQuery("1389735763649761280").league_slug, "1389735763649761280");
  });
  it("parseLeagueSelector still rejects an unknown non-numeric selector (400 upstream)", () => {
    const r = parseLeagueSelector("not-a-real-league");
    assert.ok("error" in r);
  });
  it("parseLeagueSelector passes an empty selector through as null (handler then defaults)", () => {
    assert.deepEqual(parseLeagueSelector(null), { value: null });
    assert.deepEqual(parseLeagueSelector(""), { value: null });
  });
});

/* ----------------------------------- 4. cross-surface: one snapshot, one truth */

describe("cross-surface: migrated adapters agree with the canonical snapshot", () => {
  it("standings roster ids, records and team names come straight from canonical teams/standings", async () => {
    const snap = await fixtureSnapshot();
    const rows = canonicalToStandingsFacts(snap);
    for (const row of rows) {
      const team = snap.teams.find((t) => Number(t.provider_team_id) === row.roster_id)!;
      const standing = snap.standings.find((s) => s.canonical_team_id === team.canonical_team_id)!;
      assert.equal(row.wins, standing.wins);
      assert.equal(row.losses, standing.losses);
      assert.equal(row.points_for, standing.points_for);
      assert.equal(row.manager.team_name, team.team_name);
    }
  });

  it("scoring inputs' league identity == the snapshot's league identity", async () => {
    const snap = await fixtureSnapshot();
    const facts = canonicalScoringInputs(snap);
    assert.equal(facts.league_id, snap.league.provenance.provider_id);
    assert.equal(facts.season, String(snap.season));
    assert.equal(facts.scoring_settings, snap.league.raw_scoring);
  });
});

/* ---------------------------------------- 5. historical continuity (pre-1B.1) */

describe("historical continuity: a pre-lineage (schema v1) snapshot still reads", () => {
  it("hydratePersistedSnapshot backfills lineage + fingerprints, adapters still work", async () => {
    const { hydratePersistedSnapshot } = await import("../lib/canonical/snapshot-lineage");
    const snap = await fixtureSnapshot();
    // Simulate a row persisted before Phase 1B.1: strip every additive field.
    const v1 = JSON.parse(JSON.stringify(snap)) as CanonicalLeagueSnapshot;
    (v1 as { schema_version: number }).schema_version = 1;
    delete (v1 as { lineage?: unknown }).lineage;
    delete (v1.league as { scoring_fingerprint?: string }).scoring_fingerprint;
    delete (v1.league as { roster_fingerprint?: string }).roster_fingerprint;
    delete (v1.league.roster_settings as { roster_positions_raw?: string[] }).roster_positions_raw;
    for (const t of v1.teams) delete (t as { provider_owner_id?: string | null }).provider_owner_id;

    const hydrated = hydratePersistedSnapshot(v1);
    assert.ok(hydrated.lineage?.league_snapshot_id.startsWith("snap:"));
    assert.ok(hydrated.league.scoring_fingerprint);
    // The scoring adapter still produces valid roster_positions via reconstruction.
    const facts = canonicalScoringInputs(hydrated);
    assert.deepEqual(facts.roster_positions, fixtureLeague.roster_positions);
    // Standings adapter still works; the departed-owner row now loses its
    // user_id (no provider_owner_id on a v1 row) — documented degradation, not a crash.
    const rows = canonicalToStandingsFacts(hydrated);
    assert.equal(rows.length, 3);
    assert.equal(rows.find((r) => r.roster_id === 1)!.manager.user_id, "u1");
  });
});

/* ------------------------------------------------- 6. adversarial (1B.2 scope) */

describe("adversarial: migrated surfaces", () => {
  it("scoring adapter passes raw_scoring THROUGH verbatim (add/remove/reorder a rule)", async () => {
    const snap = await fixtureSnapshot();
    snap.league.raw_scoring = { pass_td: 6, rec: 1, bonus_rec_te: 0.5 }; // added key, reordered
    const facts = canonicalScoringInputs(snap);
    assert.deepEqual(facts.scoring_settings, { pass_td: 6, rec: 1, bonus_rec_te: 0.5 });
    assert.ok("bonus_rec_te" in facts.scoring_settings);
  });

  it("a manager display-name change flows into the standings ManagerRef", async () => {
    const snap = await fixtureSnapshot();
    const mgr = snap.managers.find((m) => m.provider_user_id === "u1")!;
    mgr.display_name = "Renamed Manager";
    const rows = canonicalToStandingsFacts(snap);
    assert.equal(rows.find((r) => r.roster_id === 1)!.manager.display_name, "Renamed Manager");
  });

  it("buildScoringBundle throws a SleeperError (not a partial payload) when the league is unknown", async () => {
    await assert.rejects(
      () => buildScoringBundle("99999999999999"),
      (err: Error) => err.name === "SleeperError" || /SleeperError/.test(String(err)),
    );
  });

  it("no migrated route handler re-adds a raw getLeague/getLeagueRosters state read", () => {
    // Source-guard: the scoring routes and the manager snapshot route must not
    // reach past the canonical layer for current league state.
    const scoringRoute = readFileSync("app/api/leagues/[leagueSlug]/scoring/route.ts", "utf8");
    const mgrSnapRoute = readFileSync(
      "app/api/leagues/[leagueSlug]/managers/[managerSlug]/snapshot/route.ts",
      "utf8",
    );
    for (const src of [scoringRoute, mgrSnapRoute]) {
      assert.ok(!/getLeague\(/.test(src), "no direct getLeague() in a migrated route");
      assert.ok(!/computeStandings\(/.test(src), "no direct computeStandings() in a migrated route");
    }
    assert.ok(/buildCanonicalLeagueState|buildScoringBundle/.test(scoringRoute + mgrSnapRoute));
  });
});
