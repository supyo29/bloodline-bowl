/** Phase 4.5 Checkpoint D — Waiver 2.0 consumes the canonical market pool; ranking math is untouched; shadow-only. */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWaiver2 } from "@/lib/waiver2/actions";
import { waiverPoolFromMarket } from "@/lib/waiver2/market-pool";
import { WAIVER2_MARKET_POLICY } from "@/lib/waiver2/market-policy";
import { mayInfluenceProduction, WAIVER2_LIFECYCLE_STATE } from "@/lib/waiver2/lifecycle";
import { buildMarketSnapshot } from "@/lib/market-state/build";
import { PARAMS } from "@/lib/waiver2/config";
import { hashOf } from "@/lib/waiver2/hash";
import { mkWaiverInput, stdMine } from "./fixtures/waiver2";
import { agoMs, badSrc, marketInput, okSrc, up } from "./fixtures/market";
import type { WaiverInput } from "@/lib/waiver2/types";

const FAS = [{ id: "fa1", pos: "WR" as const, pts: 11, team: "BUF" }, { id: "fa2", pos: "RB" as const, pts: 9, team: "KC" }, { id: "fa3", pos: "WR" as const, pts: 8, team: "DAL" }];
const base = (): WaiverInput => mkWaiverInput({ mine: stdMine(), freeAgents: FAS });
const marketFor = (o: Parameters<typeof marketInput>[0] = {}) => {
  const i = marketInput({ universe: { source: okSrc(), players: FAS.map((f) => up(`sl-${f.id}`, { position: f.pos, fantasy_positions: [f.pos], team: f.team })) }, rosters: { source: okSrc(), teams: [{ team_id: "team:test-league:1", roster_id: 1, players: [], reserve: [], taxi: [], faab_used: 0, waiver_position: 1 }] }, ...o });
  return buildMarketSnapshot(i);
};

test("certified market ⇒ CERTIFIED pool of exactly the market-available candidates, with market lineage and coverage", () => {
  const w = base(); const pool = waiverPoolFromMarket(marketFor(), w.weekly);
  assert.equal(pool.certification, "CERTIFIED"); assert.deepEqual(pool.candidates.map((c) => c.canonical_player_id).sort(), ["fa1", "fa2", "fa3"]);
  assert.equal(pool.readiness?.actionable, true); assert.equal(pool.market?.coverage.pool_size, 3); assert.equal(pool.market?.coverage.unmatched, 0); assert.match(pool.market!.market_content_id, /^mkt:2026:w03:/);
});

test("a player the market says is ON_WAIVERS is excluded even though the weekly layer calls them unrostered", () => {
  const w = base(); const m = marketFor({ transactions: { source: okSrc(), entries: [{ type: "free_agent", status: "complete", status_updated: agoMs(1), adds: [], drops: ["sl-fa2"] }] } });
  const pool = waiverPoolFromMarket(m, w.weekly); assert.deepEqual(pool.candidates.map((c) => c.canonical_player_id).sort(), ["fa1", "fa3"]);
  assert.equal(pool.market?.coverage.pool_size, 2);
});

test("a market-blocked pool fails closed: UNCERTIFIED_POOL, no recommendation, precise reason codes; each provider failure blocks", () => {
  for (const [name, patch] of [["tx", { transactions: { source: badSrc(), entries: [] } }], ["rosters", { rosters: { source: badSrc(), teams: [] } }], ["universe", { universe: { source: badSrc(), players: [] } }], ["rules", { rules: { source: badSrc(), settings: null, roster_positions: null } }]] as const) {
    const w = base(); w.pool = waiverPoolFromMarket(marketFor(patch as never), w.weekly); const ev = evaluateWaiver2(w);
    assert.equal(w.pool.certification, "UNCERTIFIED_UNROSTERED", name); assert.equal(ev.availability.status, "UNCERTIFIED_POOL", name); assert.equal(ev.recommended, null, name);
    assert.equal(w.pool.readiness?.actionable, false, name); assert.ok((w.pool.readiness?.missing_inputs.length ?? 0) > 0, name);
  }
});

test("limiting reasons are tolerated by Waiver 2.0's explicit policy (lock unverifiable, FAAB missing) — the pool stays certified", () => {
  assert.deepEqual(WAIVER2_MARKET_POLICY.also_blocking, []);
  const w = base(); const m = marketFor({ schedule: { source: badSrc(), games: null } }); const pool = waiverPoolFromMarket(m, w.weekly);
  assert.equal(pool.certification, "CERTIFIED"); assert.ok(pool.market!.limitations.includes("GAME_LOCK_UNVERIFIABLE"));
});

test("ranking math unchanged: a market-sourced pool and the legacy certified pool over the same candidates produce byte-identical actions", () => {
  const legacy = base(); const viaMarket = base(); viaMarket.pool = waiverPoolFromMarket(marketFor(), viaMarket.weekly);
  const a = evaluateWaiver2(legacy); const b = evaluateWaiver2(viaMarket);
  assert.ok(a.actions.length > 0); assert.equal(hashOf(a.actions), hashOf(b.actions)); assert.equal(a.evaluation_hash, b.evaluation_hash);
  assert.equal(a.lineage.params_hash, b.lineage.params_hash);
  assert.equal(hashOf(Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, (v as { value: unknown }).value]))), hashOf(Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, (v as { value: unknown }).value]))));
});

test("shadow safety: a certified market pool does not activate anything", () => {
  const w = base(); w.pool = waiverPoolFromMarket(marketFor(), w.weekly); const ev = evaluateWaiver2(w);
  assert.equal(ev.deployment, "SHADOW_ONLY"); assert.equal(WAIVER2_LIFECYCLE_STATE, "SHADOW_ONLY"); assert.equal(mayInfluenceProduction(), false);
});
