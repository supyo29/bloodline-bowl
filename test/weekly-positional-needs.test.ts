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
  return computePositionalNeeds({ roster: R, constraints, teamCount: 12, week: 1, projections: projBatch, replacement, lookup });
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

  it("STRUCTURAL need credits QB when a QB fills SUPER_FLEX and frees a WR for FLEX (Codex round 12)", () => {
    const constraints = {
      ...STD_CONSTRAINTS,
      starting_slots: ["QB", "RB", "RB", "WR", "WR", "TE", "SUPER_FLEX", "FLEX", "K", "DEF"],
      slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, SUPER_FLEX: 1, FLEX: 1, K: 1, DEF: 1 },
      flex_positions: ["QB", "RB", "WR", "TE"],
      flex_slots: 2,
    };
    // base RB/RB/WR/WR/TE + exactly ONE spare flex body (wr3). SUPER_FLEX or FLEX
    // takes wr3; the other is short. A QB, RB, WR or TE addition all resolve it.
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"), player("wr2", "WR"),
      player("wr3", "WR"), player("te1", "TE"), player("k1", "K"), player("def1", "DEF"),
    ];
    const P = players.map((p, i) => proj(p.canonical_player_id, p.position, 14 - i));
    const needs = setup({ starters: ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "wr3", "wr3", "k1", "def1"].map((x, i) => (i === 7 ? "wr3" : x)), players, projections: P, constraints });
    const structural = needs.find((n) => n.position === "STRUCTURAL");
    assert.ok(structural, "a STRUCTURAL need is emitted");
    assert.equal(structural!.severity, "critical");
    for (const p of ["QB", "RB", "WR", "TE"]) assert.ok(structural!.eligible_positions.includes(p), `${p} resolves the hole`);
    assert.ok(!structural!.eligible_positions.includes("K"), "a K cannot fill a flex hole");
  });

  it("marginal FLEX starter comes from the PROJECTION-AWARE lineup, not roster order (Codex round 12)", () => {
    const constraints = { ...STD_CONSTRAINTS, starting_slots: ["RB", "FLEX"], slot_requirements: { RB: 1, FLEX: 1 } };
    // roster order RB(20), WR(5), WR(15): structural matching by order would leave
    // WR(5) in FLEX; the optimal lineup starts WR(15).
    const players = [player("bigRB", "RB"), player("lowWR", "WR"), player("goodWR", "WR")];
    const P = [proj("bigRB", "RB", 20), proj("lowWR", "WR", 5), proj("goodWR", "WR", 15)];
    const needs = setup({ starters: ["bigRB", "lowWR"], bench: ["goodWR"], players, projections: P, constraints });
    const flex = needs.find((n) => n.position === "FLEX")!;
    assert.equal(flex.current_best_points, 15, "the marginal FLEX starter is the 15-pt WR, not the 5-pt one");
  });

  it("base position uses the MARGINAL required starter, not the best (Codex round 12)", () => {
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"), player("wr2", "WR"),
      player("wr3", "WR"), player("te1", "TE"), player("k1", "K"), player("def1", "DEF"),
    ];
    // RB1 20, RB2 10.5 vs a ~10-pt replacement -> RB2 is barely above replacement.
    const P = [
      proj("qb1", "QB", 18), proj("rb1", "RB", 20), proj("rb2", "RB", 10.5), proj("wr1", "WR", 14), proj("wr2", "WR", 13),
      proj("wr3", "WR", 12), proj("te1", "TE", 10), proj("k1", "K", 8), proj("def1", "DEF", 7),
    ];
    const needs = setup({ starters: ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "wr3", "k1", "def1"], players, projections: P });
    const rb = needs.find((n) => n.position === "RB")!;
    assert.equal(rb.current_best_points, 10.5, "current_best_points is RB2 (the marginal required starter)");
    assert.notEqual(rb.severity, "strong", "a marginal RB2 barely above replacement is not 'strong'");
  });

  it("each flex label's replacement is the frontier of the UNION of its eligible FAs (Codex round 13)", () => {
    const constraints = {
      ...STD_CONSTRAINTS,
      starting_slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF"],
      slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER_FLEX: 1, K: 1, DEF: 1 },
      flex_positions: ["QB", "RB", "WR", "TE"],
      flex_slots: 2,
    };
    // rostered base; FREE-AGENT RBs 20/1, WRs 19/18. Combined FLEX (RB/WR/TE) pool
    // sorted = [20,19,18,1] -> 2nd best = 19. max(2nd-best RB=1, 2nd-best WR=18)
    // would wrongly give 18.
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"), player("wr2", "WR"),
      player("te1", "TE"), player("wr3", "WR"), player("qb2", "QB"), player("k1", "K"), player("def1", "DEF"),
      player("faRBa", "RB"), player("faRBb", "RB"), player("faWRa", "WR"), player("faWRb", "WR"),
    ];
    const P = [
      proj("qb1", "QB", 20), proj("rb1", "RB", 16), proj("rb2", "RB", 15), proj("wr1", "WR", 14), proj("wr2", "WR", 13),
      proj("te1", "TE", 12), proj("wr3", "WR", 11), proj("qb2", "QB", 10), proj("k1", "K", 8), proj("def1", "DEF", 7),
      proj("faRBa", "RB", 20), proj("faRBb", "RB", 1), proj("faWRa", "WR", 19), proj("faWRb", "WR", 18),
    ];
    const R = roster("team:test-league:1", ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "wr3", "qb2", "k1", "def1"], [], { startingSlots: constraints.starting_slots });
    const pb = batch(P, players);
    const snap = {
      schema_version: CANONICAL_SCHEMA_VERSION, captured_at: "", provider_synced_at: null,
      league: { canonical_league_id: "league:t", league_slug: "test-league", name: "t", season: 2026, status: "in_season", sport: "nfl", team_count: 12, current_week: 1, scoring_rules: [], raw_scoring: {}, roster_settings: { starting_slots: constraints.starting_slots, bench_slots: 5, ir_slots: 1, taxi_slots: 0, slot_requirements: constraints.slot_requirements }, playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 }, waiver_settings: { type: "faab" as const, faab_budget: 100, waiver_day: null }, provenance: { provider: "sleeper" as const, provider_id: "t", provider_synced_at: null } },
      season: 2026, week: 1, managers: [], teams: [], rosters: [R], standings: [], matchups: [], recent_transactions: [], draft_picks: [], waiver_state: null, players, unresolved_players: [], live_provider_status: "READY" as const, history_persistence_status: "READY" as const, warnings: [],
    } as unknown as CanonicalLeagueSnapshot;
    const av = buildLeagueAvailability({ snapshot: snap, manager_team_id: "team:test-league:1", week: 1, candidates: players, startable_positions: new Set(["QB", "RB", "WR", "TE", "K", "DEF"]) });
    const rep = computeWeeklyReplacement({ league_slug: "test-league", week: 1, team_count: 12, constraints, projections: pb, availability: av });
    assert.equal(rep.by_position.FLEX?.replacement_points, 19, "FLEX bar = 2nd-best of the combined RB/WR/TE FA pool");

    // marginal_starter frontier must apply to the FLEX label too (not stay on
    // the available-pool branch) — Codex round 14.
    const repMS = computeWeeklyReplacement({
      league_slug: "test-league", week: 1, team_count: 12, constraints, projections: pb, availability: av,
      frontier: { mode: "marginal_starter" },
    });
    assert.equal(repMS.by_position.FLEX?.basis, "position_rank_fallback", "FLEX honours the marginal_starter (last-true-starter) frontier");
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

  it("flex marginal pairing preserves eligibility — a QB is never paired to an ordinary FLEX (Codex round 14)", () => {
    const constraints = {
      ...STD_CONSTRAINTS,
      starting_slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF"],
      slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER_FLEX: 1, K: 1, DEF: 1 },
      flex_positions: ["QB", "RB", "WR", "TE"],
      flex_slots: 2,
    };
    // spare RB(20) -> FLEX, spare QB(12) -> SUPER_FLEX. Two spare-QB FAs raise the
    // SUPER_FLEX bar (~18) well above the ordinary FLEX bar (~7). The only LEGAL
    // pairing is RB->FLEX / QB->SUPER_FLEX -> SUPER_FLEX gap -6 (weak).
    const players = [
      player("qb1", "QB"), player("qb2", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"),
      player("wr2", "WR"), player("te1", "TE"), player("sp1", "RB"), player("k1", "K"), player("def1", "DEF"),
      player("faQBa", "QB"), player("faQBb", "QB"), player("faRB", "RB"), player("faWR", "WR"), player("faTE", "TE"),
    ];
    const P = [
      proj("qb1", "QB", 22), proj("qb2", "QB", 12), proj("rb1", "RB", 25), proj("rb2", "RB", 24), proj("wr1", "WR", 16),
      proj("wr2", "WR", 15), proj("te1", "TE", 14), proj("sp1", "RB", 20), proj("k1", "K", 8), proj("def1", "DEF", 7),
      proj("faQBa", "QB", 20), proj("faQBb", "QB", 18), proj("faRB", "RB", 8), proj("faWR", "WR", 7), proj("faTE", "TE", 6),
    ];
    const needs = setup({ starters: ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "sp1", "qb2", "k1", "def1"], players, projections: P, constraints });
    const flex = needs.find((n) => n.position === "FLEX")!;
    const sf = needs.find((n) => n.position === "SUPER_FLEX")!;
    assert.equal(flex.current_best_points, 20, "the RB is the FLEX marginal (the QB is ineligible for FLEX)");
    assert.equal(sf.current_best_points, 12, "the QB is the SUPER_FLEX marginal");
    assert.equal(sf.severity, "weak", "SUPER_FLEX gap is 12 - ~18 -> weak");
    assert.ok(sf.eligible_positions.includes("QB"));
  });

  it("flex marginals are deterministic and label-aware, not read from one arbitrary assignment (Codex round 13)", () => {
    const constraints = {
      ...STD_CONSTRAINTS,
      starting_slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF"],
      slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER_FLEX: 1, K: 1, DEF: 1 },
      flex_positions: ["QB", "RB", "WR", "TE"],
      flex_slots: 2,
    };
    // 2 interchangeable spare WRs (20 and 12) land in the two flex slots; a spare
    // QB FA raises the SUPER_FLEX replacement bar above the ordinary FLEX bar.
    const base = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"), player("wr2", "WR"),
      player("te1", "TE"), player("sp1", "WR"), player("sp2", "WR"), player("k1", "K"), player("def1", "DEF"),
      player("faQB", "QB"), player("faRB", "RB"), player("faWR", "WR"),
    ];
    const P = [
      proj("qb1", "QB", 22), proj("rb1", "RB", 18), proj("rb2", "RB", 17), proj("wr1", "WR", 16), proj("wr2", "WR", 15),
      proj("te1", "TE", 14), proj("sp1", "WR", 20), proj("sp2", "WR", 12), proj("k1", "K", 8), proj("def1", "DEF", 7),
      proj("faQB", "QB", 13), proj("faRB", "RB", 10), proj("faWR", "WR", 9),
    ];
    const run = (players: typeof base) =>
      setup({ starters: ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "sp1", "sp2", "k1", "def1"], players, projections: P, constraints });
    const a = run(base);
    const b = run([...base].reverse()); // different roster order -> must be identical
    const flexA = a.find((n) => n.position === "FLEX")!;
    const sfA = a.find((n) => n.position === "SUPER_FLEX")!;
    const flexB = b.find((n) => n.position === "FLEX")!;
    const sfB = b.find((n) => n.position === "SUPER_FLEX")!;
    assert.equal(flexA.current_best_points, flexB.current_best_points, "FLEX marginal is order-invariant");
    assert.equal(sfA.current_best_points, sfB.current_best_points, "SUPER_FLEX marginal is order-invariant");
    // favourable pairing: the higher flex starter goes to the higher-bar label.
    assert.ok((sfA.current_best_points ?? 0) >= (flexA.current_best_points ?? 0), "20-pt WR -> SUPER_FLEX (higher replacement bar), 12-pt -> FLEX");
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
