import test from "node:test";
import assert from "node:assert/strict";
import { classifyUniversePlayer, startablePositionsFor, foldPosition, type UniversePlayer } from "@/lib/market-state/classify";
import { validatePlayerState } from "@/lib/market-state/integrity";
import type { PlayerMarketState } from "@/lib/market-state/contract";

const S = new Set(startablePositionsFor(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN"]));
const u = (o: Partial<UniversePlayer>): UniversePlayer => ({ player_id: "1", full_name: "A B", position: "WR", fantasy_positions: ["WR"], team: "KC", status: "Active", injury_status: null, active: true, ...o });

test("startable positions expand FLEX/SUPER_FLEX/IDP and ignore bench", () => {
  assert.deepEqual(startablePositionsFor(["QB", "FLEX", "BN", "IR"]), ["QB", "RB", "TE", "WR"]);
  assert.ok(startablePositionsFor(["SUPER_FLEX"]).includes("QB"));
  assert.deepEqual(startablePositionsFor(["DL", "LB", "DB", "BN"]), ["DB", "DL", "LB"]);
});
test("XX / null / non-league positions are ineligible with distinct reasons", () => {
  assert.deepEqual(classifyUniversePlayer(u({ position: "XX", fantasy_positions: [] }), S), { kind: "INELIGIBLE", reason: "NO_FANTASY_POSITION" });
  assert.deepEqual(classifyUniversePlayer(u({ position: null, fantasy_positions: [] }), S), { kind: "INELIGIBLE", reason: "NO_FANTASY_POSITION" });
  assert.deepEqual(classifyUniversePlayer(u({ position: "OL", fantasy_positions: ["OL"] }), S), { kind: "INELIGIBLE", reason: "POSITION_NOT_IN_LEAGUE" });
  assert.equal(foldPosition("DE"), "DL");
});
test("no NFL team is ineligible; retired is ineligible; team defense is a TEAM entity", () => {
  assert.equal((classifyUniversePlayer(u({ team: null }), S) as { reason: string }).reason, "NO_NFL_TEAM");
  assert.equal((classifyUniversePlayer(u({ status: "Retired" }), S) as { reason: string }).reason, "RETIRED_OR_INACTIVE_IDENTITY");
  const d = classifyUniversePlayer(u({ player_id: "KC", position: "DEF", team: "KC", status: null, fantasy_positions: ["DEF"] }), S);
  assert.equal(d.kind, "ELIGIBLE"); assert.equal((d as { entity: string }).entity, "TEAM_DEFENSE");
});
test("injured/IR/PUP/suspended players are ELIGIBLE with caveats — a poor or injured player is never excluded", () => {
  for (const [status, inj] of [["Injured Reserve", "IR"], ["Inactive", "Out"], ["Suspended", "Sus"], ["Active", "PUP"]] as const) {
    const r = classifyUniversePlayer(u({ status, injury_status: inj }), S); assert.equal(r.kind, "ELIGIBLE", status);
    assert.ok((r as { caveats: string[] }).caveats.length > 0);
  }
});
test("unknown vocabulary, empty status, practice squad and contradictory active flags never become eligible", () => {
  assert.equal((classifyUniversePlayer(u({ status: "Practice Squad" }), S) as { reason: string }).reason, "PRACTICE_SQUAD_ELIGIBILITY_UNVERIFIED");
  assert.equal(classifyUniversePlayer(u({ status: "Weird" }), S).kind, "UNKNOWN");
  assert.equal(classifyUniversePlayer(u({ status: null }), S).kind, "UNKNOWN");
  assert.equal(classifyUniversePlayer(u({ active: false }), S).kind, "UNKNOWN");
});

const base = (o: Partial<PlayerMarketState>): PlayerMarketState => ({
  player_key: "sleeper:1", provider: "sleeper", provider_player_id: "1", entity: "PLAYER", canonical_player_id: null, full_name: "x", position: "WR", team: "KC",
  league_slug: "l", season: 2026, week: 3, as_of: "t", status: "AVAILABLE_FREE_AGENT", ownership: "UNROSTERED", owner_team_id: null, roster_slot: null,
  acquisition: { status: "FREE_AGENT", mechanism: "FREE_AGENT_ADD" }, waiver_clears_at: null, waiver_window: null, eligible_to_add: true, reason: null, lock: "OPEN", caveats: [], injury_status: null, nfl_status: "Active",
  source: { provider: "sleeper", source_class: "PROVIDER_DERIVED", freshness: "FRESH" }, ...o,
});
test("integrity: a clean available player passes; ownership≠availability contradictions are caught", () => {
  assert.equal(validatePlayerState(base({})).length, 0);
  assert.ok(validatePlayerState(base({ ownership: "UNKNOWN" })).some((x) => x.code === "AVAILABLE_NOT_VERIFIED_UNROSTERED"));
  assert.ok(validatePlayerState(base({ owner_team_id: "t1" })).some((x) => x.code === "OWNED_BUT_NOT_ROSTERED_STATUS"));
  assert.ok(validatePlayerState(base({ status: "ROSTERED", ownership: "ROSTERED", owner_team_id: "t1" })).some((x) => x.code === "ROSTERED_ADDABLE"));
  assert.equal(validatePlayerState(base({ lock: "LOCKED" })).length, 0, "a started game is a lock fact, not a contradiction");
  assert.ok(validatePlayerState(base({ waiver_clears_at: "2026-09-22T00:00:00Z" })).some((x) => x.code === "CLEAR_TIME_FABRICATED_RISK"));
  assert.ok(validatePlayerState(base({ status: "WAIVER_CLAIM_PENDING" })).some((x) => x.code === "PENDING_CLAIM_UNSUPPORTED"));
  assert.ok(validatePlayerState(base({ status: "ON_WAIVERS", acquisition: { status: "WAIVER", mechanism: "WAIVER_CLAIM" }, eligible_to_add: false })).some((x) => x.code === "WAIVER_WITHOUT_WINDOW"));
});
