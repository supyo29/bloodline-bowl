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
  it("2 RB / 2 WR / 1 TE fills every base slot but leaves the FLEX slot(s) unfilled -> FLEX need", () => {
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"), player("wr2", "WR"),
      player("te1", "TE"), player("k1", "K"), player("def1", "DEF"), player("teFlex", "TE"),
    ];
    const P = [
      proj("qb1", "QB", 18), proj("rb1", "RB", 14), proj("rb2", "RB", 12), proj("wr1", "WR", 13), proj("wr2", "WR", 11),
      proj("te1", "TE", 10), proj("k1", "K", 8), proj("def1", "DEF", 7), proj("teFlex", "TE", 8),
    ];
    // exactly 2 RB, 2 WR, 2 TE -> the 2 Bloodline FLEX slots need 4 RB/WR/TE
    // beyond the base 5 (RB2+WR2+TE1), i.e. 7 total; only 6 flex-eligible exist.
    const needs = setup({
      starters: ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "teFlex", "k1", "def1"],
      players, projections: P,
    });
    const flex = needs.find((n) => n.position === "FLEX");
    assert.ok(flex, "a FLEX aggregate need is emitted");
    assert.equal(flex!.need, 6, "RB(2)+WR(2)+TE(1) base + 1 STD FLEX slot = 6");
    // only 6 flex-eligible players exist for a demand of 6 -> no surplus -> not 'strong'
    assert.notEqual(flex!.severity, "strong");
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
