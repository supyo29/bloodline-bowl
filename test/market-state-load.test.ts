import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __clearMarketMemo, loadMarketSnapshot, type MarketFetchers } from "@/lib/market-state/load";
import { findLeagueTarget } from "@/lib/leagues/registry";
import { FAAB_SETTINGS, POSITIONS } from "./fixtures/market";

beforeEach(() => __clearMarketMemo());
const NOW = new Date("2026-09-22T15:00:00.000Z");
const idx = new Map([["10", { player_id: "10", full_name: "A", first_name: null, last_name: null, position: "WR", fantasy_positions: ["WR"], team: "KC", age: null, years_exp: null, status: "Active", injury_status: null, number: null, active: true, search_rank: null, resolved: true }], ["30", { player_id: "30", full_name: "B", first_name: null, last_name: null, position: "RB", fantasy_positions: ["RB"], team: "BUF", age: null, years_exp: null, status: "Active", injury_status: null, number: null, active: true, search_rank: null, resolved: true }]]);
function fetchers(o: Partial<MarketFetchers> & { calls?: Record<string, number> } = {}): MarketFetchers {
  const calls = o.calls ?? {}; const c = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; };
  return {
    league: (async () => { c("league"); return { league_id: "x", season: "2026", settings: FAAB_SETTINGS, roster_positions: POSITIONS }; }) as never,
    rosters: (async () => { c("rosters"); return [{ roster_id: 1, players: ["10"], reserve: [], taxi: [], settings: { waiver_budget_used: 5, waiver_position: 2 } }]; }) as never,
    transactions: (async () => { c("tx"); return []; }) as never,
    players: (async () => { c("players"); return idx; }) as never,
    playerAge: () => 3600, schedule: async () => { c("schedule"); return [{ week: 3, home: "KC", away: "BUF", status: "pre_game" }]; }, ...o,
  };
}

test("loader reads once and memoizes; ownership and a free agent come out of real-shaped provider data", async () => {
  const calls: Record<string, number> = {}; const f = fetchers({ calls });
  const a = await loadMarketSnapshot("bloodline-bowl", { week: 3, now: () => NOW }, f); const b = await loadMarketSnapshot("bloodline-bowl", { week: 3, now: () => NOW }, f);
  assert.equal(a, b); assert.equal(calls.rosters, 1); assert.equal(calls.players, 1);
  assert.equal(a.players.find((p) => p.provider_player_id === "10")?.status, "ROSTERED"); assert.equal(a.players.find((p) => p.provider_player_id === "30")?.status, "AVAILABLE_FREE_AGENT");
  assert.equal(a.acquisition.teams[0]!.faab_remaining, 95); assert.equal(a.readiness.pool_actionable, true);
});

test("each thrown provider read degrades to a precise blocked snapshot; nothing throws", async () => {
  const boom = async () => { throw new Error("upstream 503"); };
  for (const [name, patch, code] of [["rosters", { rosters: boom }, "ROSTER_STATE_UNAVAILABLE"], ["players", { players: boom }, "PLAYER_UNIVERSE_UNAVAILABLE"], ["tx", { transactions: boom }, "WAIVER_STATE_UNVERIFIABLE"], ["league", { league: boom }, "ACQUISITION_RULES_UNKNOWN"]] as const) {
    __clearMarketMemo(); const s = await loadMarketSnapshot("bloodline-bowl", { week: 3, now: () => NOW }, fetchers(patch as never));
    assert.ok(s.readiness.blocks.includes(code), name); assert.ok(s.readiness.blocks.includes("PROVIDER_ERROR"), name); assert.equal(s.counts.AVAILABLE_FREE_AGENT, 0, name);
  }
  __clearMarketMemo(); const s = await loadMarketSnapshot("bloodline-bowl", { week: 3, now: () => NOW }, fetchers({ schedule: boom }));
  assert.equal(s.readiness.pool_actionable, true); assert.ok(s.readiness.limitations.includes("GAME_LOCK_UNVERIFIABLE"));
});

test("an unregistered league yields a NOT_READY snapshot, not a guess", async () => {
  const s = await loadMarketSnapshot("no-such-league", { week: 3, now: () => NOW }, fetchers());
  assert.equal(s.readiness.pool_actionable, false); assert.equal(s.players.length, 0);
  void findLeagueTarget;
});
