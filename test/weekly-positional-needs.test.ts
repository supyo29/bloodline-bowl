/**
 * computePositionalNeeds (Codex round 10):
 *  - IR / taxi players do not count toward a position's depth
 *  - an aggregate FLEX need is emitted when RB/WR/TE depth can't fill the FLEX slot(s)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computePositionalNeeds } from "../lib/weekly/context";
import { computeWeeklyReplacement } from "../lib/weekly/replacement";
import { buildLeagueAvailability } from "../lib/weekly/availability";
import { player, proj, roster, batch, STD_CONSTRAINTS, CANONICAL_SCHEMA_VERSION } from "./fixtures/weekly";
import type { CanonicalLeagueSnapshot, CanonicalPlayer } from "../lib/canonical/schema";

function setup(opts: {
  starters: string[];
  bench?: string[];
  ir?: string[];
  players: CanonicalPlayer[];
  projections: ReturnType<typeof proj>[];
  constraints?: typeof STD_CONSTRAINTS;
}) {
  const constraints = opts.constraints ?? STD_CONSTRAINTS;
  const R = roster("team:test-league:1", opts.starters, opts.bench ?? [], { ir: opts.ir ?? [], startingSlots: constraints.starting_slots });
  const projBatch = batch(opts.projections, opts.players);
  const lookupMap = new Map(opts.players.map((p) => [p.canonical_player_id, p]));
  const lookup = (ids: string[]) => ids.map((id) => lookupMap.get(id)).filter((p): p is CanonicalPlayer => Boolean(p));
  const snapshot = {
    schema_version: CANONICAL_SCHEMA_VERSION, captured_at: "", provider_synced_at: null,
    league: { canonical_league_id: "league:t", league_slug: "test-league", name: "t", season: 2026, status: "in_season", sport: "nfl", team_count: 12, current_week: 1, scoring_rules: [], raw_scoring: {}, roster_settings: { starting_slots: constraints.starting_slots, bench_slots: constraints.bench_slots, ir_slots: constraints.ir_slots, taxi_slots: 0, slot_requirements: constraints.slot_requirements }, playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 }, waiver_settings: { type: "faab" as const, faab_budget: 100, waiver_day: null }, provenance: { provider: "sleeper" as const, provider_id: "t", provider_synced_at: null } },
    season: 2026, week: 1, managers: [], teams: [], rosters: [R], standings: [], matchups: [], recent_transactions: [], draft_picks: [], waiver_state: null, players: opts.players, unresolved_players: [], live_provider_status: "READY" as const, history_persistence_status: "READY" as const, warnings: [],
  } as unknown as CanonicalLeagueSnapshot;
  const availability = buildLeagueAvailability({ snapshot, manager_team_id: "team:test-league:1", week: 1, candidates: opts.players, startable_positions: new Set(["QB", "RB", "WR", "TE", "K", "DEF"]) });
  const replacement = computeWeeklyReplacement({ league_slug: "test-league", week: 1, team_count: 12, constraints, projections: projBatch, availability });
  return computePositionalNeeds({ roster: R, constraints, teamCount: 12, projections: projBatch, replacement, lookup });
}

describe("computePositionalNeeds — reserve players excluded", () => {
  it("an RB on IR does not make RB depth look adequate", () => {
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("wr3", "WR"),
      player("te1", "TE"), player("k1", "K"), player("def1", "DEF"),
      player("rbIR", "RB", { name: "Hurt RB" }),
    ];
    const P = [
      proj("qb1", "QB", 18), proj("rb1", "RB", 12), proj("wr1", "WR", 14), proj("wr2", "WR", 12), proj("wr3", "WR", 11),
      proj("te1", "TE", 10), proj("k1", "K", 8), proj("def1", "DEF", 7),
      proj("rbIR", "RB", 15, { projection_status: "out" }),
    ];
    // starters: only 1 real RB (rb1) + wr3 covering a slot; rbIR is on IR.
    const needs = setup({
      starters: ["qb1", "rb1", "wr1", "wr2", "te1", "wr3", "wr3", "k1", "def1"].map((x, i) => (i === 6 ? "wr3" : x)),
      ir: ["rbIR"], players, projections: P,
    });
    const rb = needs.find((n) => n.position === "RB")!;
    assert.notEqual(rb.severity, "adequate", "RB is critical/weak — the only RB depth is on IR");
    assert.ok(rb.have_startable <= 1);
  });
});

describe("computePositionalNeeds — aggregate FLEX demand", () => {
  it("exactly 2 RB / 2 WR / 1 TE + 2 QB fills every base slot but the FLEX slot is unfillable -> critical FLEX need", () => {
    const players = [
      player("qb1", "QB"), player("qb2", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"),
      player("wr2", "WR"), player("te1", "TE"), player("k1", "K"), player("def1", "DEF"),
    ];
    const P = [
      proj("qb1", "QB", 18), proj("qb2", "QB", 15), proj("rb1", "RB", 14), proj("rb2", "RB", 12), proj("wr1", "WR", 13),
      proj("wr2", "WR", 11), proj("te1", "TE", 10), proj("k1", "K", 8), proj("def1", "DEF", 7),
    ];
    // 5 flex-eligible players (2RB,2WR,1TE) cover the base RB/RB/WR/WR/TE; nothing
    // left for FLEX, and the spare QB cannot fill it.
    const needs = setup({
      starters: ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "qb2", "k1", "def1"],
      players, projections: P,
    });
    const flex = needs.find((n) => n.position === "FLEX")!;
    assert.ok(flex, "a FLEX need is emitted per flex slot label");
    assert.equal(flex.need, 1, "STD has 1 FLEX slot");
    assert.deepEqual(flex.eligible_positions.sort(), ["RB", "TE", "WR"]);
    assert.equal(flex.severity, "critical", "the FLEX slot cannot be fielded");
  });

  it("FLEX + SUPER_FLEX: 3 QB + exactly base RB/WR/TE -> ordinary FLEX still short, SUPER_FLEX ok", () => {
    const constraints = {
      ...STD_CONSTRAINTS,
      starting_slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF"],
      slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER_FLEX: 1, K: 1, DEF: 1 },
      flex_positions: ["QB", "RB", "WR", "TE"],
      flex_slots: 2,
    };
    const players = [
      player("qb1", "QB"), player("qb2", "QB"), player("qb3", "QB"), player("rb1", "RB"), player("rb2", "RB"),
      player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"), player("k1", "K"), player("def1", "DEF"),
    ];
    const P = players.map((p, i) => proj(p.canonical_player_id, p.position, 18 - i));
    const needs = setup({ starters: ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "qb2", "qb3", "k1", "def1"], players, projections: P, constraints });
    const flex = needs.find((n) => n.position === "FLEX")!;
    const sf = needs.find((n) => n.position === "SUPER_FLEX")!;
    assert.deepEqual(flex.eligible_positions.sort(), ["RB", "TE", "WR"]);
    assert.deepEqual(sf.eligible_positions.sort(), ["QB", "RB", "TE", "WR"]);
    assert.equal(flex.severity, "critical", "ordinary FLEX cannot be filled — only QBs are spare");
    assert.notEqual(sf.severity, "critical", "SUPER_FLEX takes the spare QB");
  });

  it("Yahoo W/R/T + Q/W/R/T eligibility is preserved", () => {
    const constraints = {
      ...STD_CONSTRAINTS,
      starting_slots: ["QB", "RB", "RB", "WR", "WR", "TE", "W/R/T", "Q/W/R/T", "K", "DEF"],
      slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, "Q/W/R/T": 1, K: 1, DEF: 1 },
      flex_positions: ["QB", "RB", "WR", "TE"],
      flex_slots: 2,
    };
    const players = [
      player("qb1", "QB"), player("qb2", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("rb3", "RB"),
      player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"), player("k1", "K"), player("def1", "DEF"),
    ];
    const P = players.map((p) => proj(p.canonical_player_id, p.position, 12));
    const needs = setup({ starters: ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "qb2", "k1", "def1"], players, projections: P, constraints });
    const wrt = needs.find((n) => n.position === "W/R/T")!;
    const qwrt = needs.find((n) => n.position === "Q/W/R/T")!;
    assert.deepEqual(wrt.eligible_positions.sort(), ["RB", "TE", "WR"]);
    assert.deepEqual(qwrt.eligible_positions.sort(), ["QB", "RB", "TE", "WR"]);
  });

  it("deep RB/WR/TE rosters do not raise a false FLEX need", () => {
    const ids = ["qb1", "rb1", "rb2", "rb3", "wr1", "wr2", "wr3", "wr4", "te1", "te2", "k1", "def1"];
    const players = ids.map((id) => player(id, id.startsWith("rb") ? "RB" : id.startsWith("wr") ? "WR" : id.startsWith("te") ? "TE" : id.startsWith("qb") ? "QB" : id.startsWith("k") ? "K" : "DEF"));
    const P = players.map((p, i) => proj(p.canonical_player_id, p.position, 14 - i * 0.5));
    const needs = setup({ starters: ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "wr3", "k1", "def1"], bench: ["rb3", "wr4", "te2"], players, projections: P });
    const flex = needs.find((n) => n.position === "FLEX");
    assert.ok(!flex || flex.severity !== "critical");
  });
});
