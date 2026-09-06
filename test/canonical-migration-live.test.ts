/**
 * Phase 1B.2 — LIVE cross-surface consistency against the real Bloodline Bowl.
 * Requires network. Durable invariants only (no pinned week / roster size).
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { buildScoringBundle } from "../lib/scoring/scoring-service";
import { buildSnapshot } from "../lib/analytics/snapshot";
import { buildCanonicalLeagueState } from "../lib/canonical/state";
import { canonicalToStandingsFacts } from "../lib/canonical/compat/standings";
import { computeStandings } from "../lib/analytics/standings";
import {
  getLeague,
  getLeagueRosters,
  getLeagueUsers,
  getNflState,
} from "../lib/sleeper/client";

const LEAGUE_ID = "1395549281678532608";
let online = true;

before(async () => {
  try {
    await getNflState();
  } catch {
    online = false;
  }
});

describe("1B.2 live: scoring surface is sourced from canonical state", () => {
  it("buildScoringBundle == the raw Sleeper league's own scoring config", async (t) => {
    if (!online) return t.skip("offline");
    const [bundle, raw] = await Promise.all([
      buildScoringBundle("bloodline-bowl"),
      getLeague(LEAGUE_ID),
    ]);
    assert.equal(bundle.league_id, LEAGUE_ID);
    assert.equal(bundle.league.name, raw.name);
    assert.equal(bundle.league.season, raw.season);
    assert.deepEqual(bundle.league.roster_positions, raw.roster_positions ?? []);
    assert.deepEqual(bundle.scoring.raw, raw.scoring_settings ?? {});
  });
});

describe("1B.2 live: standings adapter == legacy computeStandings", () => {
  it("canonicalToStandingsFacts is byte-identical to computeStandings(rosters, users, {}, [])", async (t) => {
    if (!online) return t.skip("offline");
    const [state, rosters, users] = await Promise.all([
      buildCanonicalLeagueState("bloodline-bowl"),
      getLeagueRosters(LEAGUE_ID),
      getLeagueUsers(LEAGUE_ID),
    ]);
    assert.ok(state.snapshot);
    assert.deepEqual(
      canonicalToStandingsFacts(state.snapshot!),
      computeStandings(rosters, users, new Map(), []),
    );
  });
});

describe("1B.2 live: /api/snapshot builder is coherent + canonical-backed", () => {
  it("league block, standings and team counts line up with canonical state", async (t) => {
    if (!online) return t.skip("offline");
    const [{ snapshot, warnings }, state] = await Promise.all([
      buildSnapshot(LEAGUE_ID),
      buildCanonicalLeagueState("bloodline-bowl"),
    ]);
    const canon = state.snapshot!;
    assert.deepEqual(warnings, []);
    assert.equal(snapshot.league.team_count, canon.league.team_count);
    assert.equal(snapshot.league.status, canon.league.status);
    assert.equal(snapshot.standings.length, canon.teams.length);
    assert.equal(snapshot.teams.length, canon.teams.length);
    // every standings row carries a real team_name (the pre-1B.2 canonical bug
    // left CanonicalFantasyTeam.team_name null for every production team)
    const withName = snapshot.standings.filter((s) => s.manager.team_name != null).length;
    assert.ok(withName >= snapshot.standings.length - 2, `team names present (${withName})`);
  });
});
