import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDynamicVor } from "@/lib/w2r1/vor";
import { optimizeLineup } from "@/lib/w2r1/roster";
import { validateAsset, validateFeature, validateMarket } from "@/lib/w2r1/evidence";
import { FP, PROV, RULES, asset, fa, market, onRoster, standardRoster, waiver } from "./fixtures/w2r1";

const vor = (roster = standardRoster(), id = "rb1", mk: ReturnType<typeof market> | null = null, week = 6, rules = RULES) => computeDynamicVor({ rules, roster, playerId: id, week, market: mk });
const close = (a: number | null, b: number, eps = 1e-9) => { assert.ok(a != null && Math.abs(a - b) <= eps, `expected ${b}, got ${a}`); };

describe("W2.R1 roster cascade (weekly roster VOR)", () => {
  it("healthy starter: full legal-lineup re-optimization, FLEX cascade included", () => {
    // remove rb1(16): rb3(8) becomes RB2? RB slots = rb2(12)+rb3(8); WR3(10) stays FLEX... total delta is computed by the optimizer, not a rank cutoff
    const r = vor(standardRoster(), "rb1");
    // with: QB20 RB16 RB12 WR15 WR11 TE9 FLEX10 K8 D7 = 108 ; without: RB12 RB8 -> 20+12+8+15+11+9+10+8+7=100 (wr3 still FLEX) => 8
    close(r.weekly_roster_vor.value, 8);
    assert.ok(r.weekly_detail!.chain.length >= 1);
    assert.ok(r.weekly_detail!.chain.some((c) => c.before === "rb1"), "the removed player's slot appears in the chain");
  });
  it("FLEX cascade: removing RB1 moves a WR into FLEX when no RB is left", () => {
    const roster = [onRoster(asset("qb", "QB", 20), "STARTER"), onRoster(asset("rbA", "RB", 16), "STARTER"), onRoster(asset("rbB", "RB", 12), "STARTER"), onRoster(asset("wr1", "WR", 15), "STARTER"), onRoster(asset("wr2", "WR", 11), "STARTER"), onRoster(asset("te", "TE", 9), "STARTER"), onRoster(asset("wr3", "WR", 10), "STARTER"), onRoster(asset("k", "K", 8), "STARTER"), onRoster(asset("d", "DEF", 7), "STARTER"), onRoster(asset("wr4", "WR", 6), "BENCH")];
    const r = vor(roster, "rbA");
    // without rbA: RB slots = rbB + (no RB) -> empty RB slot unless FLEX-eligible... only one RB left so RB2 is EMPTY; wr3 stays flex; the empty slot is reported
    assert.ok(r.weekly_detail!.empty_slots_without.includes("RB"));
    close(r.weekly_roster_vor.value, 16);
  });
  it("bench-aware: a deep bench makes the player cheaper to lose than a shallow one", () => {
    const deep = vor(standardRoster(), "rb1").weekly_roster_vor.value!;
    const shallow = vor(standardRoster().filter((a) => a.player_id !== "rb3"), "rb1").weekly_roster_vor.value!;
    assert.ok(shallow > deep, `shallow ${shallow} should exceed deep ${deep}`);
  });
  it("no replacement at all: VOR = the player's full value and the empty slot is reported", () => {
    const roster = [onRoster(asset("only", "K", 9), "STARTER")];
    const r = computeDynamicVor({ rules: { ...RULES, slots: ["K"] }, roster, playerId: "only", week: 6, market: null });
    close(r.weekly_roster_vor.value, 9);
    assert.deepEqual(r.weekly_detail!.empty_slots_without, ["K"]);
  });
  it("IR replacement: a returnable IR player fills the spot when it is open; an unreturnable one does not", () => {
    const base = standardRoster().filter((a) => !["rb3"].includes(a.player_id));
    const withIr = [...base, onRoster(asset("irRB", "RB", 14), "IR", 6)];
    const withoutIr = [...base, onRoster(asset("irRB", "RB", 14), "IR", null)];
    const a = vor(withIr, "rb1").weekly_roster_vor.value!; const b = vor(withoutIr, "rb1").weekly_roster_vor.value!;
    assert.ok(a < b, "IR return makes losing rb1 cheaper");
    assert.deepEqual(vor(withIr, "rb1").weekly_detail!.activated_from_reserve, ["irRB"]);
  });
  it("IR return needs an open ACTIVE spot: a full roster cannot activate him, but dropping any active player frees the spot (so a bench player can have NEGATIVE VOR)", () => {
    const padded = [...standardRoster(), onRoster(asset("p1", "WR", 1), "BENCH"), onRoster(asset("p2", "WR", 1), "BENCH"), onRoster(asset("irRB", "RB", 14), "IR", 1)];
    // active = 15 = slots 9 + bench 6 -> full. Losing wr4 frees a spot: irRB activates and the lineup IMPROVES.
    const r = computeDynamicVor({ rules: RULES, roster: padded, playerId: "wr4", week: 6, market: null });
    assert.deepEqual(r.weekly_detail!.activated_from_reserve, ["irRB"]);
    assert.ok(r.weekly_roster_vor.value! < 0, "dropping a dead bench spot to activate the IR returnee improves the lineup");
    // an open spot BEFORE any removal also activates him in the WITH scenario (no negative VOR then)
    const roomy = [...standardRoster(), onRoster(asset("irRB", "RB", 14), "IR", 1)];
    assert.ok(computeDynamicVor({ rules: RULES, roster: roomy, playerId: "wr4", week: 6, market: null }).weekly_roster_vor.value! >= 0);
  });
  it("unknown is not zero: an unknown-valued teammate is excluded and flagged provisional, never counted as 0", () => {
    const roster = [...standardRoster(), onRoster(asset("mystery", "RB", 30, { unknown: [6] }), "BENCH")];
    const r = vor(roster, "rb1");
    assert.deepEqual(r.weekly_detail!.unknown_excluded, ["mystery"]);
    assert.equal(r.weekly_detail!.provisional, true);
    close(r.weekly_roster_vor.value, 8); // mystery's 30 never enters
  });
  it("the focal player's own unknown week yields null with a reason, never 0", () => {
    const roster = standardRoster().map((a) => (a.player_id === "rb1" ? onRoster(asset("rb1", "RB", 16, { unknown: [6] }), "STARTER") : a));
    const r = vor(roster, "rb1");
    assert.equal(r.weekly_roster_vor.value, null);
    assert.match(String(r.weekly_roster_vor.unknown_reason), /UNKNOWN/);
  });
});

describe("W2.R1 acquisition needs an open ACTIVE spot (live defect)", () => {
  it("removing an IR player frees no active spot: a verified FA cannot enter a full active roster", () => {
    const full = [...standardRoster(), onRoster(asset("p1", "WR", 1), "BENCH"), onRoster(asset("p2", "WR", 1), "BENCH"), onRoster(asset("irX", "RB", 14), "IR", null)]; // active = 15 = limit
    const m = market([fa(asset("faK", "K", 30))]);
    const r = computeDynamicVor({ rules: RULES, roster: full, playerId: "irX", week: 6, market: m });
    assert.equal(r.weekly_detail!.chosen_add, null, "no active spot opened");
    close(r.weekly_roster_vor.value, 0);
  });
  it("removing a bench player DOES free a spot, so the FA enters (negative VOR = a better use of the spot)", () => {
    const full = [...standardRoster(), onRoster(asset("p1", "WR", 1), "BENCH"), onRoster(asset("p2", "WR", 1), "BENCH")]; // active = 15
    const r = computeDynamicVor({ rules: RULES, roster: full, playerId: "p1", week: 6, market: market([fa(asset("faK", "K", 30))]) });
    assert.equal(r.weekly_detail!.chosen_add!.player_id, "faK");
    assert.ok(r.weekly_roster_vor.value! < 0);
  });
});

describe("W2.R1 FLEX cascade and league-level bye behaviour", () => {
  it("FLEX cascade is numeric: removing RB1 lets the RB3 take RB2 and the WR3 take the FLEX the RB3 vacated", () => {
    const roster = [onRoster(asset("rbA", "RB", 16), "STARTER"), onRoster(asset("rbB", "RB", 12), "STARTER"), onRoster(asset("rbC", "RB", 11), "BENCH"), onRoster(asset("wr3", "WR", 10), "STARTER")];
    const r = computeDynamicVor({ rules: { ...RULES, slots: ["RB", "RB", "FLEX"] }, roster, playerId: "rbA", week: 6, market: null });
    // with: RB16 RB12 FLEX11 = 39 ; without: RB12 RB11 FLEX10 = 33 -> 6 (a no-FLEX model would say 5)
    close(r.weekly_roster_vor.value, 6);
    assert.ok(r.weekly_detail!.chain.some((c) => c.slot === "FLEX" && c.after === "wr3"));
  });
  it("league / scarcity VOR: a bye week contributes exactly 0 (no negative replacement penalty); the sum equals the non-bye weeks", () => {
    const pool = market([fa(asset("a", "TE", 5)), fa(asset("b", "TE", 4)), fa(asset("c", "TE", 3)), fa(asset("d", "TE", 3)), fa(asset("e", "TE", 2))]);
    const rules = { ...RULES, slots: ["TE"] };
    const noBye = computeDynamicVor({ rules, roster: [onRoster(asset("te", "TE", 10), "STARTER")], playerId: "te", week: 6, market: pool });
    const bye = computeDynamicVor({ rules, roster: [onRoster(asset("te", "TE", 10, { bye: 9 }), "STARTER")], playerId: "te", week: 6, market: pool });
    close(noBye.league_vor.value! - bye.league_vor.value!, 5); // exactly the week-9 contribution (10 - best 5), not 10 - 5 + (0 - 5)
  });
});

describe("W2.R1 bye / injury semantics (asset value is preserved)", () => {
  for (const [pos, id, val, slots] of [["QB", "qb", 20, ["QB"]], ["RB", "rb", 16, ["RB"]], ["WR", "wr", 15, ["WR"]], ["TE", "te", 9, ["TE"]], ["K", "k", 8, ["K"]], ["DEF", "d", 7, ["DEF"]]] as const) {
    it(`${pos} on bye: weekly lineup VOR = 0, but Hold VOR and ROS VOR stay positive`, () => {
      const roster = [onRoster(asset(id, pos, val, { bye: 6 }), "STARTER")];
      const r = computeDynamicVor({ rules: { ...RULES, slots: [...slots] }, roster, playerId: id, week: 6, market: null });
      close(r.weekly_roster_vor.value, 0);
      assert.ok(r.hold_vor.value! > 0, "hold VOR must survive the bye");
      assert.ok(r.ros_vor.value! > 0, "ROS VOR must survive the bye");
      // one week (the bye) fewer than a never-bye twin
      const twin = computeDynamicVor({ rules: { ...RULES, slots: [...slots] }, roster: [onRoster(asset(id, pos, val), "STARTER")], playerId: id, week: 6, market: null });
      close(twin.ros_vor.value! - r.ros_vor.value!, val);
    });
  }
  it("a bye on a FUTURE week removes only that week from ROS (no collapse of asset value)", () => {
    const withBye = vor([onRoster(asset("rb1", "RB", 16, { bye: 9 }), "STARTER"), ...standardRoster().filter((a) => a.player_id !== "rb1")], "rb1");
    const noBye = vor();
    assert.ok(withBye.ros_vor.value! < noBye.ros_vor.value! && withBye.ros_vor.value! > 0.8 * noBye.ros_vor.value!);
  });
  it("an OUT star: lineup VOR 0 this week, hold VOR > 0 (underlying), no drop signal from the missed week alone", () => {
    const roster = standardRoster().map((a) => (a.player_id === "rb1" ? onRoster(asset("rb1", "RB", 16, { out: [6] }), "STARTER") : a));
    const r = vor(roster, "rb1");
    close(r.weekly_roster_vor.value, 0);
    assert.ok(r.hold_vor.value! > r.weekly_roster_vor.value!);
  });
  it("NO DOUBLE INJURY DISCOUNT: the simulator uses the Wave-1 availability-aware lineup value verbatim; hold uses the underlying value", () => {
    // W1 already discounted a questionable RB to 8 (underlying 10). Weekly VOR must be built from 8, hold from 10, never 8*availability.
    const q = onRoster(asset("rbQ", "RB", 10, { lineupOverride: { 6: 8 } }), "STARTER");
    const roster = [onRoster(asset("qb", "QB", 20), "STARTER"), q, onRoster(asset("rbB", "RB", 9), "STARTER")];
    const r = computeDynamicVor({ rules: { ...RULES, slots: ["QB", "RB", "RB"] }, roster, playerId: "rbQ", week: 6, market: null });
    close(r.weekly_roster_vor.value, 8);
    assert.ok(r.hold_vor.value! > r.weekly_roster_vor.value!, "hold (underlying 10) exceeds the availability-aware weekly 8");
  });
});

describe("W2.R1 hold vs ROS are numerically distinct", () => {
  it("a questionable starter: ROS counts this week at the availability-aware 8, Hold counts the underlying 10 (exact values)", () => {
    const q = onRoster(asset("rbQ", "RB", 10, { lineupOverride: { 6: 8 } }), "STARTER");
    const roster = [q, onRoster(asset("rbB", "RB", 9), "BENCH")];
    const r = computeDynamicVor({ rules: { ...RULES, slots: ["RB"] }, roster, playerId: "rbQ", week: 6, market: null });
    close(r.weekly_roster_vor.value, 0);        // week 6: 8 < rbB 9 -> he adds nothing this week
    close(r.ros_vor.value, 11);                 // weeks 7..17: 10-9 = 1 each
    close(r.hold_vor.value, 12);                // hold values him at 10 in week 6 too: 1 + 11
  });
});

describe("W2.R1 acquisition realism and the verified market", () => {
  it("a verified FREE AGENT replacement reduces the VOR and is named in the chain", () => {
    const m = market([fa(asset("faRB", "RB", 11))]);
    const r = vor(standardRoster(), "rb1", m);
    assert.ok(r.weekly_roster_vor.value! < vor(standardRoster(), "rb1", null).weekly_roster_vor.value!);
    assert.equal(r.weekly_detail!.chosen_add!.player_id, "faRB");
    assert.equal(r.weekly_detail!.chosen_add!.method, "FREE_AGENT_ADD");
  });
  it("a WAIVER claim with UNKNOWN competition is never assumed guaranteed: excluded from `value`, included only in the optimistic bound", () => {
    const m = market([waiver(asset("wvRB", "RB", 15), null, 12)]);
    const r = vor(standardRoster(), "rb1", m);
    const roster_only = vor(standardRoster(), "rb1", null).weekly_roster_vor.value!;
    close(r.weekly_roster_vor.value, roster_only);          // not counted
    assert.ok(r.weekly_roster_vor.low! < roster_only);      // optimistic bound sees it
    close(r.weekly_roster_vor.high, roster_only);
    assert.equal(r.weekly_detail!.chosen_add, null);
  });
  it("a waiver claim with a KNOWN probability is blended with the no-acquisition outcome and reports its FAAB cost", () => {
    const m = market([waiver(asset("wvRB", "RB", 15), 0.5, 12)]);
    const r = vor(standardRoster(), "rb1", m);
    const only = vor(standardRoster(), "rb1", null).weekly_roster_vor.value!;
    const ifAcquired = vor(standardRoster(), "rb1", market([fa(asset("wvRB", "RB", 15))])).weekly_roster_vor.value!;
    close(r.weekly_roster_vor.value, 0.5 * ifAcquired + 0.5 * only);
    assert.equal(r.weekly_detail!.chosen_add!.faab_cost, 12);
  });
  it("an UNVERIFIED market never supplies replacement: flagged, roster-only, league components unknown", () => {
    const m = market([fa(asset("faRB", "RB", 30))], false);
    const r = vor(standardRoster(), "rb1", m);
    assert.ok(r.flags.includes("REPLACEMENT_MARKET_UNVERIFIED"));
    close(r.weekly_roster_vor.value, vor(standardRoster(), "rb1", null).weekly_roster_vor.value!);
    assert.equal(r.league_vor.value, null);
  });
  it("a verified candidate with NO projection stays in the market but cannot be valued (not zero, not deleted)", () => {
    const m = market([fa(asset("noProj", "RB", 99, { unknown: Array.from({ length: 17 }, (_, i) => i + 1) }))]);
    const r = vor(standardRoster(), "rb1", m);
    close(r.weekly_roster_vor.value, vor(standardRoster(), "rb1", null).weekly_roster_vor.value!);
    assert.equal(r.market.candidates_considered, 1);
  });
  it("game-lock aware: a candidate not acquirable until a later week is ignored this week", () => {
    const m = market([fa(asset("later", "RB", 14), 9)]);
    close(vor(standardRoster(), "rb1", m, 6).weekly_roster_vor.value, vor(standardRoster(), "rb1", null, 6).weekly_roster_vor.value!);
    assert.ok(vor(standardRoster(), "rb1", m, 9).weekly_roster_vor.value! < vor(standardRoster(), "rb1", null, 9).weekly_roster_vor.value!);
  });
  it("stale market is surfaced", () => {
    assert.ok(vor(standardRoster(), "rb1", market([], true, "STALE")).flags.includes("MARKET_STALE"));
  });
});

describe("W2.R1 K / D-ST streaming, scarcity, private vs market", () => {
  it("K streaming: a comparable verified K makes a K cheap to lose; streaming-adjusted VOR <= ROS VOR sum of roster-only", () => {
    const m = market([fa(asset("kS", "K", 7.5))]);
    const r = vor(standardRoster(), "k1", m);
    close(r.weekly_roster_vor.value, 0.5);
    assert.ok(r.streaming_adjusted_vor.value! < vor(standardRoster(), "k1", null).streaming_adjusted_vor.value!);
  });
  it("D/ST streaming: same behaviour for DEF", () => {
    const m = market([fa(asset("dS", "DEF", 6.5))]);
    close(vor(standardRoster(), "d1", m).weekly_roster_vor.value, 0.5);
  });
  it("positional surplus: with three elite TEs the third is cheap to lose to ME but valuable to the LEAGUE and the MARKET", () => {
    const roster = [onRoster(asset("te1", "TE", 14), "STARTER"), onRoster(asset("te2", "TE", 13), "BENCH"), onRoster(asset("te3", "TE", 12.5), "BENCH"), onRoster(asset("qb", "QB", 20), "STARTER")];
    const m = market([fa(asset("p1", "TE", 4)), fa(asset("p2", "TE", 3.5)), fa(asset("p3", "TE", 3)), fa(asset("p4", "TE", 3)), fa(asset("p5", "TE", 2.5))]);
    const r = computeDynamicVor({ rules: { ...RULES, slots: ["QB", "TE"] }, roster, playerId: "te3", week: 6, market: m });
    close(r.weekly_roster_vor.value, 0);                    // private: he does not start for me
    assert.ok(r.league_vor.value! > 100, "league value is large (12.5 vs a ~4 waiver TE over the horizon)");
    assert.ok(r.market_value_input.value! > r.ros_vor.value!, "market input != private roster value");
    assert.notEqual(r.market_value_input.value, r.ros_vor.value);
  });
  it("scarcity VOR depends on the SHAPE of the pool: a thin pool gives a higher scarcity VOR than a deep one at the same best alternative", () => {
    const base = onRoster(asset("te1", "TE", 10), "STARTER");
    const thin = market([fa(asset("a", "TE", 5)), fa(asset("b", "TE", 1)), fa(asset("c", "TE", 1)), fa(asset("d", "TE", 1)), fa(asset("e", "TE", 1))]);
    const deep = market([fa(asset("a", "TE", 5)), fa(asset("b", "TE", 5)), fa(asset("c", "TE", 5)), fa(asset("d", "TE", 5)), fa(asset("e", "TE", 5))]);
    const rules = { ...RULES, slots: ["TE"] };
    const t = computeDynamicVor({ rules, roster: [base], playerId: "te1", week: 6, market: thin }); const d = computeDynamicVor({ rules, roster: [base], playerId: "te1", week: 6, market: deep });
    close(t.league_vor.value, d.league_vor.value!);          // same best alternative -> same league VOR
    assert.ok(t.scarcity_vor.value! > d.scarcity_vor.value!);
  });
});

describe("W2.R1 scoring isolation, validation and determinism", () => {
  it("a scoring-fingerprint mismatch anywhere in the inputs refuses to value (no silent pooling of regimes)", () => {
    const roster = standardRoster(); roster[0] = { ...roster[0]!, scoring_fingerprint: "PPR-OTHER" };
    assert.equal(vor(roster, "rb1").weekly_roster_vor.value, null);
    assert.match(vor(roster, "rb1").flags.join(), /SCORING_FINGERPRINT_MISMATCH/);
    const m = market([fa({ ...asset("x", "RB", 5), scoring_fingerprint: "PPR-OTHER" })]);
    assert.equal(vor(standardRoster(), "rb1", m).weekly_roster_vor.value, null);
  });
  it("every output is labelled SHADOW with a model version and the scoring fingerprint", () => {
    const r = vor();
    assert.equal(r.label, "W2.R1 CURRENT INTELLIGENCE"); assert.equal(r.mode, "CURRENT_INTELLIGENCE"); assert.ok(r.model_version); assert.equal(r.scoring_fingerprint, FP);
  });
  it("deterministic: identical inputs give a byte-identical result", () => {
    const m = market([fa(asset("faRB", "RB", 11)), waiver(asset("w", "WR", 12), 0.4)]);
    assert.equal(JSON.stringify(vor(standardRoster(), "wr1", m)), JSON.stringify(vor(standardRoster(), "wr1", m)));
  });
  it("evidence validation: provenance, unknown reasons, bye=0, waiver never certain", () => {
    assert.ok(validateFeature({ name: "x", value: 1, unknown_reason: null, provenance: null }).length > 0);
    assert.ok(validateFeature({ name: "x", value: null, unknown_reason: null, provenance: PROV }).length > 0);
    assert.ok(validateFeature({ name: "x", value: 0, unknown_reason: "n/a", provenance: PROV }).length > 0);
    assert.deepEqual(validateFeature({ name: "x", value: null, unknown_reason: "no route data", provenance: PROV }), []);
    const badBye = asset("b", "RB", 5, { bye: 6 }); badBye.weeks[6] = { state: "BYE", lineup: 3, underlying: 0 };
    assert.ok(validateAsset(badBye).some((e) => /bye must contribute exactly 0/.test(e)));
    assert.ok(validateAsset({ ...asset("u", "RB", 5, { unknown: [3] }), missing_evidence: [] }).some((e) => /missing-evidence reason/.test(e)));
    assert.ok(validateMarket(market([{ ...waiver(asset("w", "RB", 5), 1) }])).some((e) => /never be assumed guaranteed/.test(e)));
    assert.deepEqual(validateAsset(asset("ok", "RB", 5, { bye: 7 })), []);
  });
  it("optimizeLineup never treats unknown as 0 and flags provisional only when the unknown is eligible", () => {
    const r = optimizeLineup({ slots: ["QB", "RB"], players: [{ id: "q", position: "QB", eligible_positions: ["QB"], value: 10 }, { id: "u", position: "WR", eligible_positions: ["WR"], value: null }] });
    assert.equal(r.provisional, false); assert.deepEqual(r.empty_slots, ["RB"]);
    assert.equal(optimizeLineup({ slots: ["RB"], players: [{ id: "u", position: "RB", eligible_positions: ["RB"], value: null }] }).provisional, true);
  });
});
