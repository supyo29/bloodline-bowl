/**
 * Yahoo -> Sleeper identity bridge. Yahoo carries no cross-provider id, so the ONLY safe evidence is name + position + NFL team, accepted ONLY when exactly one
 * active Sleeper player matches. Proves: unique match joins the Sleeper-keyed projections; ambiguity / absence / position mismatch never map; a team defense never
 * goes through the bridge; and the result is the SAME canonical id the projection side computes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { YahooSleeperBridge, type BridgeCandidate } from "../lib/canonical/yahoo-sleeper-bridge";
import { PlayerCrosswalk, NoCrosswalk, type CrosswalkRow } from "../lib/canonical/players";
import { loadYahooSleeperBridge, __clearYahooBridgeMemo } from "../lib/canonical/yahoo-bridge-source";

const c = (id: string, name: string, pos: string, team: string | null, o: Partial<BridgeCandidate> = {}): BridgeCandidate => ({ player_id: id, full_name: name, position: pos, fantasy_positions: [pos], team, status: "Active", active: true, ...o });
const SLEEPER = [c("4881", "Michael Pittman Jr.", "WR", "IND"), c("9509", "Jordan Addison", "WR", "MIN"), c("1111", "Josh Allen", "QB", "BUF"), c("2222", "Josh Allen", "LB", "JAX", { fantasy_positions: ["LB"] }), c("3001", "Chris Brown", "RB", "HOU"), c("3002", "Chris Brown", "RB", "HOU"), c("5555", "Old Timer", "WR", "DAL", { status: "Retired" }), c("5556", "Stale Guy", "WR", "DAL", { active: false }), c("7777", "Duplicate Player", "WR", "CHI"), c("8001", "Rookie Back", "RB", null)];
const bridge = new YahooSleeperBridge(SLEEPER);
const obs = (name: string, position: string, team: string | null) => ({ provider: "yahoo" as const, provider_player_id: `470.p.${name.length}`, full_name: name, position, nfl_team: team, known_identifiers: {} });

describe("YahooSleeperBridge.lookup", () => {
  it("a unique active name+position+team match maps (suffixes, case and team aliases normalize)", () => {
    assert.deepEqual(bridge.lookup({ name: "Michael Pittman", position: "WR", team: "Ind" }), { status: "MATCHED", sleeper_id: "4881" });
    assert.deepEqual(bridge.lookup({ name: "jordan addison", position: "wr", team: "MIN" }), { status: "MATCHED", sleeper_id: "9509" });
  });
  it("two active Sleeper players with the same name+position+team are AMBIGUOUS: never mapped", () => {
    const r = bridge.lookup({ name: "Chris Brown", position: "RB", team: "HOU" }); assert.equal(r.status, "AMBIGUOUS"); if (r.status === "AMBIGUOUS") assert.deepEqual(r.candidates, ["3001", "3002"]);
  });
  it("the same name at a different position or team does not match (a name alone is never enough)", () => {
    assert.equal(bridge.lookup({ name: "Josh Allen", position: "QB", team: "JAX" }).status, "NONE");
    assert.equal(bridge.lookup({ name: "Josh Allen", position: "LB", team: "JAX" }).status, "NONE", "IDP positions are out of scope");
    assert.deepEqual(bridge.lookup({ name: "Josh Allen", position: "QB", team: "BUF" }), { status: "MATCHED", sleeper_id: "1111" });
  });
  it("retired, inactive, duplicate-placeholder and team-less Sleeper rows never match", () => {
    for (const [n, t] of [["Old Timer", "DAL"], ["Stale Guy", "DAL"], ["Duplicate Player", "CHI"]] as const) assert.equal(bridge.lookup({ name: n, position: "WR", team: t }).status, "NONE");
    assert.equal(bridge.lookup({ name: "Rookie Back", position: "RB", team: null }).status, "NONE");
  });
  it("team aliases (JAX/JAC, WAS/WSH, LA -> LAR) are one team", () => {
    const b = new YahooSleeperBridge([c("1", "A Player", "WR", "JAX"), c("2", "B Player", "WR", "WAS"), c("3", "C Player", "WR", "LAR")]);
    assert.equal(b.lookup({ name: "A Player", position: "WR", team: "JAC" }).status, "MATCHED"); assert.equal(b.lookup({ name: "B Player", position: "WR", team: "WSH" }).status, "MATCHED"); assert.equal(b.lookup({ name: "C Player", position: "WR", team: "LA" }).status, "MATCHED");
  });
});

describe("YahooSleeperBridge: Sleeper's missing team is UNKNOWN, not contradictory (live: ~310 of 985 Rogers Park waiver players)", () => {
  const nt = new YahooSleeperBridge([c("10", "Kareem Hunt", "RB", null), c("11", "Nick Chubb", "RB", null), c("12", "Nick Chubb", "RB", "HOU"), c("13", "Twin Name", "WR", null), c("14", "Twin Name", "WR", null), c("15", "Solo Player", "WR", null), c("16", "Solo Player", "WR", "DAL"), c("17", "Retired Hunt", "RB", null, { status: "Retired" })]);
  it("exactly one active same-name same-position player, no team on record, nobody else with a team -> MATCHED, flagged team_unverified", () => {
    assert.deepEqual(nt.lookup({ name: "Kareem Hunt", position: "RB", team: "KC" }), { status: "MATCHED", sleeper_id: "10", team_unverified: true });
  });
  it("a team-confirmed match always wins over the fallback (no flag)", () => assert.deepEqual(nt.lookup({ name: "Nick Chubb", position: "RB", team: "HOU" }), { status: "MATCHED", sleeper_id: "12" }));
  it("if ANOTHER active same-name same-position player carries a team, the fallback refuses (that player could be the one Yahoo means)", () => {
    assert.equal(nt.lookup({ name: "Solo Player", position: "WR", team: "KC" }).status, "NONE"); assert.equal(nt.lookup({ name: "Nick Chubb", position: "RB", team: "KC" }).status, "NONE");
  });
  it("two team-less same-name same-position players are AMBIGUOUS; retired / inactive team-less rows never match", () => {
    const r = nt.lookup({ name: "Twin Name", position: "WR", team: "KC" }); assert.equal(r.status, "AMBIGUOUS"); if (r.status === "AMBIGUOUS") assert.deepEqual(r.candidates, ["13", "14"]);
    assert.equal(nt.lookup({ name: "Retired Hunt", position: "RB", team: "KC" }).status, "NONE");
  });
  it("the fallback is recorded on the resolution (method name_position, confidence low, team_unverified) and still yields the Sleeper canonical id", async () => {
    const cw = new PlayerCrosswalk(NoCrosswalk).useYahooSleeperBridge(nt); await cw.ensureLoaded();
    const r = cw.resolve({ provider: "yahoo", provider_player_id: "470.p.77", full_name: "Kareem Hunt", position: "RB", nfl_team: "KC", known_identifiers: {} });
    assert.equal(r.player.canonical_player_id, "player:sleeper:10"); assert.equal(r.player.resolution.method, "name_position"); assert.equal(r.player.resolution.confidence, "low"); assert.match(r.player.resolution.note ?? "", /team_unverified/);
  });
});

describe("PlayerCrosswalk integration (opt-in; default behavior unchanged)", () => {
  it("WITHOUT the bridge a Yahoo player with no crosswalk row stays provider-scoped (the defect: no projection join)", async () => {
    const cw = new PlayerCrosswalk(NoCrosswalk); await cw.ensureLoaded();
    const r = cw.resolve(obs("Jordan Addison", "WR", "MIN")); assert.match(r.player.canonical_player_id, /^player:yahoo:/);
  });
  it("WITH the bridge the Yahoo player resolves to the SAME canonical id the Sleeper-keyed projection side computes", async () => {
    const cw = new PlayerCrosswalk(NoCrosswalk).useYahooSleeperBridge(bridge); await cw.ensureLoaded();
    const y = cw.resolve(obs("Jordan Addison", "WR", "MIN")); const s = cw.resolve({ provider: "sleeper", provider_player_id: "9509", full_name: "Jordan Addison", position: "WR", nfl_team: "MIN", known_identifiers: {} });
    assert.equal(y.player.canonical_player_id, "player:sleeper:9509"); assert.equal(y.player.canonical_player_id, s.player.canonical_player_id);
    assert.equal(y.player.identifiers.sleeper_id, "9509"); assert.match(y.player.resolution.note ?? "", /yahoo_sleeper_bridge/); assert.equal(y.unresolved, null);
  });
  it("with a crosswalk row for the Sleeper id, the bridge yields the same GSIS canonical id the projection side uses", async () => {
    const row: CrosswalkRow = { full_name: "Michael Pittman Jr.", position: "WR", nfl_team: "IND", sleeper_id: "4881", gsis_id: "00-0036358" } as CrosswalkRow;
    const cw = new PlayerCrosswalk({ name: "t", load: async () => [row] }).useYahooSleeperBridge(bridge); await cw.ensureLoaded();
    const y = cw.resolve(obs("Michael Pittman", "WR", "IND")); const s = cw.resolve({ provider: "sleeper", provider_player_id: "4881", full_name: "Michael Pittman Jr.", position: "WR", nfl_team: "IND", known_identifiers: {} });
    assert.equal(y.player.canonical_player_id, "player:gsis:00-0036358"); assert.equal(y.player.canonical_player_id, s.player.canonical_player_id);
  });
  it("an ambiguous match is NOT mapped and the reason is recorded", async () => {
    const cw = new PlayerCrosswalk(NoCrosswalk).useYahooSleeperBridge(bridge); await cw.ensureLoaded();
    const r = cw.resolve(obs("Chris Brown", "RB", "HOU")); assert.match(r.player.canonical_player_id, /^player:yahoo:/); assert.match(r.player.resolution.note ?? "", /ambiguous/);
  });
  it("a Yahoo team defense never goes through the bridge: it is defense:nfl:<team>", async () => {
    const cw = new PlayerCrosswalk(NoCrosswalk).useYahooSleeperBridge(bridge); await cw.ensureLoaded();
    assert.equal(cw.resolve(obs("Jacksonville", "DEF", "Jax")).player.canonical_player_id, "defense:nfl:jax");
  });
  it("a Sleeper observation is never touched by the bridge", async () => {
    const cw = new PlayerCrosswalk(NoCrosswalk).useYahooSleeperBridge(bridge); await cw.ensureLoaded();
    assert.equal(cw.resolve({ provider: "sleeper", provider_player_id: "42", full_name: "Jordan Addison", position: "WR", nfl_team: "MIN", known_identifiers: {} }).player.canonical_player_id, "player:sleeper:42");
  });
});

describe("loadYahooSleeperBridge", () => {
  it("builds from Sleeper's player index, memoizes, and returns null (never throws) when the index is unavailable", async () => {
    __clearYahooBridgeMemo(); let calls = 0;
    const index = async () => { calls += 1; return new Map(SLEEPER.map((p) => [p.player_id, p])); };
    const a = await loadYahooSleeperBridge({ index, now: () => 1 }), b = await loadYahooSleeperBridge({ index, now: () => 2 });
    assert.ok(a && a === b && calls === 1);
    __clearYahooBridgeMemo(); assert.equal(await loadYahooSleeperBridge({ index: async () => { throw new Error("sleeper down"); } }), null);
    __clearYahooBridgeMemo(); assert.equal(await loadYahooSleeperBridge({ index: async () => new Map() }), null);
  });
});
