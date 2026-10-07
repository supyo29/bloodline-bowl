/** W1.R1 / P1-3: provider-neutral canonical TEAM DEFENSE identity (Yahoo DST == Sleeper DEF == one entity per NFL franchise). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NoCrosswalk, PlayerCrosswalk } from "../lib/canonical/players";
import { CANONICAL_TEAMS } from "../lib/canonical/team-codes";
import { isTeamDefenseId, resolveDefenseTeam, sleeperIdFromCanonicalId, teamDefenseId, teamFromDefenseId } from "../lib/canonical/team-defense";
import { listLeagueTargets } from "../lib/leagues/registry";
import { clearProjectionFeedCache } from "../lib/sleeper/client";
import { buildCanonicalForecastBatch } from "../lib/weekly/forecast";
import { SleeperWeeklyProjectionProvider } from "../lib/weekly/projections/sleeper-weekly";
import { proj } from "./fixtures/weekly";

/** a crosswalk with NO team-defense rows (nfl_players holds individuals only) — the production-expected state */
const noDefenseRows = () => new PlayerCrosswalk({ name: "x", load: async () => [{ gsis_id: "00-1", sleeper_id: "wr1", yahoo_id: "9001", full_name: "Jane Wideout", position: "WR", nfl_team: "KC" } as never] } as never);

const yahooDef = (cw: PlayerCrosswalk, name: string, key: string, abbr: string | null) =>
  cw.resolve({ provider: "yahoo", provider_player_id: `nfl.p.${key}`, full_name: name, position: "DEF", nfl_team: abbr, known_identifiers: { yahoo_id: key, yahoo_player_key: `nfl.p.${key}` } }).player;
const sleeperDef = (cw: PlayerCrosswalk, team: string, first = "", last = "") =>
  cw.resolve({ provider: "sleeper", provider_player_id: team, full_name: `${first} ${last}`.trim() || null, first_name: first || null, last_name: last || null, position: "DEF", nfl_team: team }).player;

describe("W1.R1 P1-3: one canonical defense per NFL franchise", () => {
  it("a Yahoo Baltimore defense and the Sleeper BAL feed defense are the SAME canonical entity (no crosswalk row needed)", async () => {
    const cw = noDefenseRows();
    await cw.ensureLoaded();
    const y = yahooDef(cw, "Baltimore", "100022", "Bal");
    const s = sleeperDef(cw, "BAL", "Baltimore", "Ravens");
    assert.equal(y.canonical_player_id, "defense:nfl:bal");
    assert.equal(s.canonical_player_id, y.canonical_player_id);
    assert.equal(y.is_team_defense, true);
    assert.equal(y.position, "DEF");
    assert.equal(y.nfl_team, "BAL");
    assert.equal(y.identifiers.yahoo_player_key, "nfl.p.100022", "provider identifiers are kept as attributes, never as identity");
    assert.equal(s.identifiers.sleeper_id, "BAL");
    assert.equal(y.resolution.confidence, "exact");
  });

  it("identity does NOT depend on a person id, a provider numeric id, or a lucky crosswalk row", async () => {
    const withBogusRow = new PlayerCrosswalk({ name: "x", load: async () => [{ gsis_id: "00-9999999", sleeper_id: null, yahoo_id: "100022", full_name: "Baltimore", position: "DEF", nfl_team: "BAL" } as never] } as never);
    await withBogusRow.ensureLoaded();
    assert.equal(yahooDef(withBogusRow, "Baltimore", "100022", "BAL").canonical_player_id, "defense:nfl:bal");
    const bare = new PlayerCrosswalk(NoCrosswalk);
    await bare.ensureLoaded();
    assert.equal(yahooDef(bare, "Baltimore", "555", "BAL").canonical_player_id, "defense:nfl:bal");
    assert.equal(yahooDef(bare, "Baltimore", "777", "BAL").canonical_player_id, "defense:nfl:bal", "a different provider numeric id, same franchise");
  });

  it("every one of the 32 franchises gets a distinct id from Yahoo AND Sleeper evidence (no collisions)", async () => {
    const cw = noDefenseRows();
    await cw.ensureLoaded();
    const ids = new Set<string>();
    for (const t of CANONICAL_TEAMS) {
      const s = sleeperDef(cw, t);
      const y = yahooDef(cw, t, `id-${t}`, t);
      assert.equal(s.canonical_player_id, y.canonical_player_id, t);
      assert.equal(s.canonical_player_id, teamDefenseId(t));
      assert.equal(teamFromDefenseId(s.canonical_player_id), t);
      ids.add(s.canonical_player_id);
    }
    assert.equal(ids.size, 32);
  });

  it("repository team-code aliases are honoured (one normalizer, no second mapping): JAC/JAX, WSH/WAS, OAK/LV, LA/LAR", async () => {
    const cw = noDefenseRows();
    await cw.ensureLoaded();
    assert.equal(yahooDef(cw, "Jacksonville", "1", "Jac").canonical_player_id, sleeperDef(cw, "JAX").canonical_player_id);
    assert.equal(yahooDef(cw, "Washington", "2", "Wsh").canonical_player_id, sleeperDef(cw, "WAS").canonical_player_id);
    assert.equal(yahooDef(cw, "Las Vegas", "3", "Oak").canonical_player_id, sleeperDef(cw, "LV").canonical_player_id);
    assert.equal(yahooDef(cw, "Los Angeles Rams", "4", "LA").canonical_player_id, "defense:nfl:lar");
  });

  it("NYG/NYJ and LAR/LAC are different entities, including when only the NAME is available", async () => {
    const cw = noDefenseRows();
    await cw.ensureLoaded();
    assert.notEqual(yahooDef(cw, "New York Giants", "1", null).canonical_player_id, yahooDef(cw, "New York Jets", "2", null).canonical_player_id);
    assert.equal(yahooDef(cw, "New York Giants D/ST", "1", null).canonical_player_id, "defense:nfl:nyg");
    assert.equal(yahooDef(cw, "Los Angeles Chargers", "3", null).canonical_player_id, "defense:nfl:lac");
    assert.equal(yahooDef(cw, "Rams", "4", null).canonical_player_id, "defense:nfl:lar");
  });

  it("AMBIGUOUS evidence fails safe: it is never mapped to a franchise", async () => {
    const cw = noDefenseRows();
    await cw.ensureLoaded();
    for (const label of ["New York", "Los Angeles", "NY", "LA"]) {
      const p = yahooDef(cw, label, "900", null);
      assert.ok(!isTeamDefenseId(p.canonical_player_id), label);
      assert.equal(p.resolution.confidence, "low", label);
      assert.match(p.resolution.note ?? "", /team_defense_ambiguous/);
    }
    // evidence that DISAGREES (abbreviation says BAL, name says Packers)
    assert.equal(resolveDefenseTeam({ nfl_team: "BAL", full_name: "Green Bay Packers" }).status, "AMBIGUOUS");
    const dis = yahooDef(cw, "Green Bay Packers", "901", "BAL");
    assert.ok(!isTeamDefenseId(dis.canonical_player_id));
    // nothing usable at all
    assert.equal(resolveDefenseTeam({}).status, "UNRESOLVED");
    assert.equal(resolveDefenseTeam({ full_name: "Mystery Squad" }).status, "UNRESOLVED");
    assert.equal(resolveDefenseTeam({ nfl_team: "FA" }).status, "UNRESOLVED");
  });

  it("an individual player is untouched by the defense branch (a WR still resolves through the crosswalk)", async () => {
    const cw = noDefenseRows();
    await cw.ensureLoaded();
    const wr = cw.resolve({ provider: "yahoo", provider_player_id: "nfl.p.9001", full_name: "Jane Wideout", position: "WR", nfl_team: "KC", known_identifiers: { yahoo_id: "9001" } }).player;
    assert.equal(wr.canonical_player_id, "player:gsis:00-1");
    assert.equal(wr.is_team_defense, false);
  });

  it("sleeperIdFromCanonicalId: persons and defenses join Sleeper-keyed tables; anything else is never guessed", () => {
    assert.equal(sleeperIdFromCanonicalId("player:sleeper:4046"), "4046");
    assert.equal(sleeperIdFromCanonicalId("defense:nfl:bal"), "BAL");
    assert.equal(sleeperIdFromCanonicalId("player:gsis:00-1"), null);
    assert.equal(sleeperIdFromCanonicalId("defense:nfl:zzz"), null);
    assert.equal(sleeperIdFromCanonicalId(null), null);
  });
});

describe("W1.R1 P1-3: team-defense semantics", () => {
  it("DST never goes through the individual-player injury model, even with a stray injury string", () => {
    const row = proj("defense:nfl:bal", "DEF", 8, { injury_status: "Questionable", expected_availability: 0.78 });
    const batch = {
      league_slug: "l", season: 2026, week: 5, status: "READY" as const, by_player: new Map([["defense:nfl:bal", row]]),
      resolved_players: new Map([["defense:nfl:bal", { canonical_player_id: "defense:nfl:bal", full_name: "BAL D/ST", first_name: null, last_name: null, position: "DEF" as const, eligible_positions: ["DEF" as const], nfl_team: "BAL", is_team_defense: true, status: null, injury_status: "Questionable", identifiers: {}, resolution: { method: "stable_id" as const, confidence: "exact" as const, note: null } }]]),
      source: "sleeper_weekly", model_version: "v", missing: [], teams_with_games: ["BAL"], warnings: [],
    };
    const f = buildCanonicalForecastBatch({ batch, requested_player_ids: ["defense:nfl:bal"], players: batch.resolved_players }).by_player.get("defense:nfl:bal")!;
    assert.equal(f.injury_model.normalized_state, "NOT_APPLICABLE");
    assert.equal(f.injury_model.probability_active, null);
    assert.equal(f.projection.expected_points, 8, "no injury discount on a defense");
  });
});

describe("W1.R1 P1-3: both registered Yahoo leagues consume the same canonical defense projection (real weekly provider, no Sleeper id)", () => {
  const FEED = (position: string) => [
    { player_id: "BAL", team: "BAL", opponent: "LV", season: "2026", season_type: "regular", week: 5, category: "proj", company: "rotowire", last_modified: 1, updated_at: 1, stats: { pts_std: 8 }, player: { first_name: "Baltimore", last_name: "Ravens", position: "DEF", team: "BAL", injury_status: null, fantasy_positions: ["DEF"] } },
    { player_id: "wr1", team: "KC", opponent: "LV", season: "2026", season_type: "regular", week: 5, category: "proj", company: "rotowire", last_modified: 1, updated_at: 1, stats: { rec: 6, rec_yd: 80, rec_td: 0.5 }, player: { first_name: "Jane", last_name: "Wideout", position: "WR", team: "KC", injury_status: null, fantasy_positions: ["WR"] } },
  ].filter((r) => r.player.position === position);

  it("registry-discovered Yahoo leagues each join the defense and keep their own scoring (WR differs, shared DEF source value is flagged standard)", async () => {
    clearProjectionFeedCache();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      const want = u.searchParams.getAll("position[]");
      return new Response(JSON.stringify(want.flatMap((p) => FEED(p))), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const yahoo = listLeagueTargets().filter((t) => t.provider === "yahoo");
      assert.equal(yahoo.length, 2, "registry (discovered dynamically) has the two Yahoo leagues");
      const cw = noDefenseRows();
      await cw.ensureLoaded();
      const scorings = [{ rec: 1, rec_yd: 0.1, rec_td: 6 }, { rec: 0, rec_yd: 0.1, rec_td: 6 }];
      const wrPts: Array<number | null> = [];
      for (const [i, lg] of yahoo.entries()) {
        const def = yahooDef(cw, "Baltimore", `${100022 + i}`, "Bal"); // each league's own Yahoo numeric id for the same defense
        const wr = cw.resolve({ provider: "yahoo", provider_player_id: "nfl.p.9001", full_name: "Jane Wideout", position: "WR", nfl_team: "KC", known_identifiers: { yahoo_id: "9001" } }).player;
        const b = await new SleeperWeeklyProjectionProvider().getWeeklyProjections({
          league: { league_slug: lg.key, season: 2026, raw_scoring: scorings[i]!, scoring_rules: [] }, week: 5, crosswalk: cw,
          canonical_player_ids: [def.canonical_player_id, wr.canonical_player_id], want_rest_of_season: false,
        });
        assert.equal(def.canonical_player_id, "defense:nfl:bal", lg.key);
        assert.equal(b.by_player.get(def.canonical_player_id)?.projected_points, 8, `${lg.key}: defense joined its projection`);
        assert.ok(!b.missing.includes(def.canonical_player_id));
        wrPts.push(b.by_player.get(wr.canonical_player_id)?.projected_points ?? null);
      }
      assert.notEqual(wrPts[0], wrPts[1], "league scoring stays isolated: the same WR scores differently per league");
    } finally {
      globalThis.fetch = realFetch;
      clearProjectionFeedCache();
    }
  });
});
