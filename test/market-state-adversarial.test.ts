/** Phase 4.5 Checkpoint G — adversarial provider behaviour, ordering, scale, isolation. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildMarketSnapshot } from "@/lib/market-state/build";
import { buildFreeAgentPool } from "@/lib/market-state/pool";
import { __clearMarketMemo, loadMarketSnapshot, type MarketFetchers } from "@/lib/market-state/load";
import { AS_OF, FAAB_SETTINGS, POSITIONS, agoMs, badSrc, marketInput, okSrc, up } from "./fixtures/market";

beforeEach(() => __clearMarketMemo());
const NOW = new Date(AS_OF);

test("ORDER: shuffled provider payloads produce the byte-identical snapshot and content id", () => {
  const a = marketInput({ transactions: { source: okSrc(), entries: [{ type: "free_agent", status: "complete", status_updated: agoMs(1), adds: [], drops: ["30"] }, { type: "waiver", status: "complete", status_updated: agoMs(0.5), adds: [], drops: ["31"] }] } });
  const b = JSON.parse(JSON.stringify(a)) as typeof a; b.universe.players.reverse(); b.rosters.teams.reverse(); b.rosters.teams.forEach((t) => t.players.reverse()); b.transactions.entries.reverse();
  assert.deepEqual(buildMarketSnapshot(a), buildMarketSnapshot(b));
});
test("ROSTER TRUTH beats history: a player dropped then re-added by any team is ROSTERED, not on waivers", () => {
  const i = marketInput({ transactions: { source: okSrc(), entries: [{ type: "free_agent", status: "complete", status_updated: agoMs(1), adds: [], drops: ["10"] }] } });
  const s = buildMarketSnapshot(i); assert.equal(s.players.find((p) => p.provider_player_id === "10")?.status, "ROSTERED");
});
test("MALFORMED transactions: null/future/negative timestamps and unknown types never create a waiver window or throw", () => {
  const e = (o: object) => ({ type: "free_agent", status: "complete", status_updated: agoMs(1) as number | null, adds: [] as string[], drops: ["30"], ...o });
  for (const bad of [e({ status_updated: null }), e({ status_updated: Date.parse(AS_OF) + 86_400_000 }), e({ type: "mystery" }), e({ status: "pending" }), e({ drops: [] })]) {
    const s = buildMarketSnapshot(marketInput({ transactions: { source: okSrc(), entries: [bad as never] } })); assert.equal(s.players.find((p) => p.provider_player_id === "30")?.status, "AVAILABLE_FREE_AGENT");
  }
});
test("PARTIAL/UNKNOWN RULES: missing waiver_clear_days or an unknown waiver_type blocks with ACQUISITION_RULES_UNKNOWN and nothing is falsely available", () => {
  for (const settings of [{ ...FAAB_SETTINGS, waiver_clear_days: undefined as unknown as number }, { ...FAAB_SETTINGS, waiver_type: 7 }, {} as Record<string, number>]) {
    const s = buildMarketSnapshot(marketInput({ rules: { source: okSrc(), settings, roster_positions: POSITIONS } })); assert.ok(s.readiness.blocks.includes("ACQUISITION_RULES_UNKNOWN")); assert.equal(s.counts.AVAILABLE_FREE_AGENT, 0);
  }
  const noPos = buildMarketSnapshot(marketInput({ rules: { source: okSrc(), settings: FAAB_SETTINGS, roster_positions: [] } })); assert.ok(noPos.readiness.blocks.includes("ACQUISITION_RULES_UNKNOWN"), "a league with no startable positions cannot define a pool");
});
test("STALE UNIVERSE beyond its ceiling blocks; a duplicate universe id cannot yield two states", () => {
  const stale = buildMarketSnapshot(marketInput({ universe: { source: okSrc("2026-09-20T00:00:00.000Z"), players: marketInput().universe.players } })); assert.ok(stale.readiness.blocks.includes("STALE_MARKET_STATE"));
  const dup = marketInput(); dup.universe.players.push(up("30", { position: "WR", fantasy_positions: ["WR"] }));
  const s = buildMarketSnapshot(dup); assert.equal(s.players.filter((p) => p.provider_player_id === "30").length, 2, "duplicate provider rows are surfaced, not merged"); assert.ok(s.readiness.blocks.includes("OWNERSHIP_INTEGRITY_VIOLATION"), "and block the pool");
});
test("SCALE: a 12,000-player universe builds a full snapshot + pool well inside the request budget", () => {
  const i = marketInput(); for (let n = 0; n < 12000; n += 1) i.universe.players.push(up(`x${n}`, { position: n % 3 ? "OL" : "WR", fantasy_positions: [n % 3 ? "OL" : "WR"], team: n % 5 ? "KC" : null }));
  const t0 = performance.now(); const s = buildMarketSnapshot(i); const p = buildFreeAgentPool(s); const ms = performance.now() - t0;
  assert.ok(ms < 1500, `built in ${ms.toFixed(0)}ms`); assert.ok(p.members.length > 1000); assert.equal(s.readiness.pool_actionable, true);
});

const idx = new Map([["10", { player_id: "10", full_name: "A", first_name: null, last_name: null, position: "WR", fantasy_positions: ["WR"], team: "KC", age: null, years_exp: null, status: "Active", injury_status: null, number: null, active: true, search_rank: null, resolved: true }]]);
const F = (o: Partial<MarketFetchers> = {}): MarketFetchers => ({
  league: (async () => ({ league_id: "x", season: "2026", settings: FAAB_SETTINGS, roster_positions: POSITIONS })) as never, rosters: (async () => [{ roster_id: 1, players: ["10"], reserve: [], taxi: [], settings: {} }]) as never,
  transactions: (async () => []) as never, players: (async () => idx) as never, playerAge: () => 60, schedule: async () => [{ week: 3, home: "KC", away: "BUF", status: "pre_game" }], ...o,
});
test("PROVIDER: hung reads time out into precise blocks (no hang); malformed payloads are failures, not empty successes", async () => {
  const hang = () => new Promise(() => undefined);
  for (const [name, patch, code] of [["rosters", { rosters: hang }, "ROSTER_STATE_UNAVAILABLE"], ["tx", { transactions: hang }, "WAIVER_STATE_UNVERIFIABLE"], ["league", { league: hang }, "ACQUISITION_RULES_UNKNOWN"]] as const) {
    __clearMarketMemo(); const t0 = Date.now(); const s = await loadMarketSnapshot("bloodline-bowl", { week: 3, now: () => NOW, timeoutMs: 40 }, F(patch as never));
    assert.ok(Date.now() - t0 < 1500, name); assert.ok(s.readiness.blocks.includes(code), name); assert.ok(s.readiness.blocks.includes("PROVIDER_ERROR"), name);
  }
  for (const [name, patch, code] of [["rosters not a list", { rosters: (async () => ({ oops: true })) as never }, "ROSTER_STATE_UNAVAILABLE"], ["tx not a list", { transactions: (async () => "nope") as never }, "WAIVER_STATE_UNVERIFIABLE"]] as const) {
    __clearMarketMemo(); const s = await loadMarketSnapshot("bloodline-bowl", { week: 3, now: () => NOW }, F(patch as never)); assert.ok(s.readiness.blocks.includes(code), name); assert.equal(s.counts.AVAILABLE_FREE_AGENT, 0, name);
  }
});
test("PROVIDER: numeric / null / sentinel roster ids are normalized so ownership can never be missed", async () => {
  const s = await loadMarketSnapshot("bloodline-bowl", { week: 3, now: () => NOW }, F({ rosters: (async () => [{ roster_id: 1, players: [10, null, "", "0"], reserve: null, taxi: undefined, settings: null }]) as never }));
  assert.equal(s.players.find((p) => p.provider_player_id === "10")?.status, "ROSTERED"); assert.equal(s.counts.ROSTERED, 1);
});
test("PROVIDER: a transaction feed missing one of the required weeks fails the whole window (partial window ≠ verified)", async () => {
  let n = 0; const s = await loadMarketSnapshot("bloodline-bowl", { week: 3, now: () => NOW }, F({ transactions: (async () => { n += 1; if (n === 1) throw new Error("503"); return []; }) as never }));
  assert.ok(s.readiness.blocks.includes("WAIVER_STATE_UNVERIFIABLE")); assert.equal(s.counts.AVAILABLE_FREE_AGENT, 0);
});

test("PRODUCTION ISOLATION: no production, canonical, weekly, trade, orchestrator or provider module imports the market state", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === "node_modules" || f === ".next" ? [] : walk(p)) : /\.tsx?$/.test(f) ? [p] : []; });
  const importers = [...walk("app"), ...walk("lib")].filter((f) => !f.startsWith("lib/market-state/") && /@\/lib\/market-state/.test(readFileSync(f, "utf8"))).sort();
  assert.deepEqual(importers, ["lib/book-ready/families/market-state.ts", "lib/book-ready/query.ts", "lib/persistence/supabase/market-state.ts", "lib/waiver2/adapter.ts", "lib/waiver2/market-pool.ts", "lib/waiver2/market-policy.ts", "lib/waiver2/types.ts"].sort());
  for (const f of walk("lib/market-state")) assert.doesNotMatch(readFileSync(f, "utf8"), /@\/lib\/(waiver2|weekly|trades|orchestrator|book-ready|analysis-book|canonical\/state)/, `${f}: the substrate depends on no consumer`);
  const noWrites = walk("lib/market-state").filter((f) => !f.endsWith("load.ts")); for (const f of noWrites) assert.doesNotMatch(readFileSync(f, "utf8"), /\bfetch\(|supabase|\.insert\(|process\.env|writeFileSync/i, `${f}: pure`);
  const canonicalWaiver = readFileSync("lib/canonical/capabilities.ts", "utf8"); assert.match(canonicalWaiver, /free_agent_pool_not_materialized/, "the production readiness contract is untouched: production waivers still fail closed");
});
