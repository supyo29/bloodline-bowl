import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketSnapshot } from "@/lib/market-state/build";
import { buildFreeAgentPool, consumerActionability, managerAcquisitionContext, poolPositionView, replacementAvailability } from "@/lib/market-state/pool";
import { validateMarketSnapshot } from "@/lib/market-state/integrity";
import { AS_OF, FAAB_SETTINGS, PRIORITY_SETTINGS, POSITIONS, agoMs, badSrc, marketInput, okSrc, up } from "./fixtures/market";

const by = (s: ReturnType<typeof buildMarketSnapshot>, id: string) => s.players.find((p) => p.provider_player_id === id);

test("baseline: rostered incl. IR, empty slot makes no identity, DEF is a team entity, ineligible are counted not listed", () => {
  const s = buildMarketSnapshot(marketInput());
  assert.equal(s.readiness.status, "READY"); assert.equal(s.readiness.pool_actionable, true); assert.deepEqual(s.readiness.blocks, []);
  assert.equal(by(s, "12")?.status, "ROSTERED"); assert.equal(by(s, "12")?.roster_slot, "RESERVE"); assert.equal(by(s, "0"), undefined);
  assert.equal(by(s, "KC")?.entity, "TEAM_DEFENSE"); assert.equal(by(s, "KC")?.status, "AVAILABLE_FREE_AGENT");
  assert.equal(by(s, "30")?.status, "AVAILABLE_FREE_AGENT"); assert.equal(by(s, "31")?.caveats.includes("INJURY_DESIGNATION_PRESENT"), true, "injured is still available");
  assert.equal(by(s, "32"), undefined); assert.equal(by(s, "40"), undefined); assert.equal(by(s, "41"), undefined);
  assert.deepEqual(s.ineligible_counts, { NO_FANTASY_POSITION: 1, NO_NFL_TEAM: 1, POSITION_NOT_IN_LEAGUE: 1 });
  assert.equal(by(s, "50")?.status, "UNKNOWN_AVAILABILITY"); assert.equal(by(s, "50")?.eligible_to_add, false);
  assert.deepEqual(validateMarketSnapshot(s), []);
  assert.equal(s.players.filter((p) => p.status === "ROSTERED").length, 5);
});

test("ownership is not availability: no player is both rostered and addable; owner is unique", () => {
  const s = buildMarketSnapshot(marketInput());
  for (const p of s.players) if (p.ownership === "ROSTERED") assert.equal(p.eligible_to_add, false);
  const keys = s.players.map((p) => p.player_key); assert.equal(new Set(keys).size, keys.length);
});

test("duplicate owner across rosters fails closed with an integrity block", () => {
  const i = marketInput(); i.rosters.teams[1]!.players.push("10");
  const s = buildMarketSnapshot(i);
  assert.equal(s.readiness.pool_actionable, false); assert.ok(s.readiness.blocks.includes("OWNERSHIP_INTEGRITY_VIOLATION")); assert.equal(s.history_class, "UNSAFE");
  assert.equal(buildFreeAgentPool(s).members.length, 0);
});

test("waiver window: a drop inside waiver_clear_days is ON_WAIVERS (clear time UNKNOWN); outside it is a free agent; failed/trade ignored", () => {
  const drop = (days: number, type = "free_agent", status = "complete") => ({ type, status, status_updated: agoMs(days), adds: [], drops: ["30"] });
  let s = buildMarketSnapshot(marketInput({ transactions: { source: okSrc(), entries: [drop(1)] } }));
  const w = by(s, "30")!; assert.equal(w.status, "ON_WAIVERS"); assert.equal(w.waiver_clears_at, null); assert.equal(w.waiver_window?.clear_days, 2); assert.equal(w.eligible_to_add, false); assert.equal(w.acquisition.mechanism, "WAIVER_CLAIM");
  s = buildMarketSnapshot(marketInput({ transactions: { source: okSrc(), entries: [drop(3)] } })); assert.equal(by(s, "30")?.status, "AVAILABLE_FREE_AGENT");
  s = buildMarketSnapshot(marketInput({ transactions: { source: okSrc(), entries: [drop(1, "free_agent", "failed")] } })); assert.equal(by(s, "30")?.status, "AVAILABLE_FREE_AGENT");
  s = buildMarketSnapshot(marketInput({ transactions: { source: okSrc(), entries: [drop(1, "trade")] } })); assert.equal(by(s, "30")?.status, "AVAILABLE_FREE_AGENT");
  s = buildMarketSnapshot(marketInput({ transactions: { source: okSrc(), entries: [drop(1, "commissioner")] } })); assert.equal(by(s, "30")?.status, "ON_WAIVERS");
});

test("game lock is a per-player fact, not an availability verdict: started game => lock LOCKED but still addable; bye => open; missing schedule => UNKNOWN, limiting not blocking", () => {
  let s = buildMarketSnapshot(marketInput({ schedule: { source: okSrc(), games: [{ week: 3, home: "KC", away: "BUF", status: "in_game" }, { week: 3, home: "DAL", away: "SF", status: "pre_game" }] } }));
  assert.equal(by(s, "30")?.status, "AVAILABLE_FREE_AGENT"); assert.equal(by(s, "30")?.lock, "LOCKED"); assert.equal(by(s, "30")?.eligible_to_add, true); assert.equal(by(s, "31")?.lock, "OPEN");
  s = buildMarketSnapshot(marketInput({ schedule: { source: okSrc(), games: [{ week: 3, home: "DAL", away: "SF", status: "pre_game" }] } })); assert.equal(by(s, "30")?.lock, "OPEN"); assert.equal(by(s, "30")?.status, "AVAILABLE_FREE_AGENT");
  s = buildMarketSnapshot(marketInput({ schedule: { source: badSrc(), games: null } }));
  assert.equal(by(s, "30")?.status, "AVAILABLE_FREE_AGENT"); assert.equal(by(s, "30")?.lock, "UNKNOWN"); assert.ok(s.readiness.limitations.includes("GAME_LOCK_UNVERIFIABLE")); assert.equal(s.readiness.pool_actionable, true); assert.equal(s.readiness.status, "PARTIAL");
});

test("each provider failure degrades truthfully and blocks the pool with the precise code", () => {
  const cases: Array<[string, Partial<Parameters<typeof marketInput>[0]>, string]> = [
    ["universe", { universe: { source: badSrc(), players: [] } }, "PLAYER_UNIVERSE_UNAVAILABLE"],
    ["rosters", { rosters: { source: badSrc(), teams: [] } }, "ROSTER_STATE_UNAVAILABLE"],
    ["rules", { rules: { source: badSrc(), settings: null, roster_positions: null } }, "ACQUISITION_RULES_UNKNOWN"],
    ["transactions", { transactions: { source: badSrc(), entries: [] } }, "WAIVER_STATE_UNVERIFIABLE"],
  ];
  for (const [name, patch, code] of cases) {
    const s = buildMarketSnapshot(marketInput(patch as never)); assert.ok(s.readiness.blocks.includes(code as never), name); assert.equal(s.readiness.pool_actionable, false, name);
    assert.ok(s.readiness.blocks.includes("PROVIDER_ERROR"), `${name} carries PROVIDER_ERROR`);
    assert.equal(s.counts.AVAILABLE_FREE_AGENT, 0, `${name}: nothing is falsely AVAILABLE`); assert.equal(buildFreeAgentPool(s).members.length, 0);
  }
  const noRost = buildMarketSnapshot(marketInput({ rosters: { source: badSrc(), teams: [] } })); assert.ok(noRost.counts.SOURCE_UNAVAILABLE > 0); assert.ok(noRost.players.every((p) => p.ownership === "UNKNOWN"));
  const noTx = buildMarketSnapshot(marketInput({ transactions: { source: badSrc(), entries: [] } })); assert.ok(noTx.players.filter((p) => p.ownership === "UNROSTERED").every((p) => p.status !== "AVAILABLE_FREE_AGENT"));
});

test("stale sources block; a fresh universe tolerance is separate from live sources", () => {
  const s = buildMarketSnapshot(marketInput({ evaluated_at: "2026-09-22T15:30:00.000Z" })); assert.ok(s.readiness.blocks.includes("STALE_MARKET_STATE"));
  const u = buildMarketSnapshot(marketInput({ universe: { source: okSrc("2026-09-21T15:00:00.000Z"), players: marketInput().universe.players } })); assert.ok(!u.readiness.blocks.includes("STALE_MARKET_STATE"), "24h-old universe within its 26h ceiling");
});

test("acquisition system is per league; priority league carries no FAAB currency; FAAB is separate from availability", () => {
  const p = buildMarketSnapshot(marketInput({ rules: { source: okSrc(), settings: PRIORITY_SETTINGS, roster_positions: POSITIONS } }));
  assert.equal(p.acquisition.rules.system, "PRIORITY"); assert.equal(p.acquisition.rules.faab_budget, null); assert.equal(p.acquisition.teams[0]!.faab_remaining, null);
  const f = buildMarketSnapshot(marketInput()); assert.equal(f.acquisition.rules.system, "FAAB"); assert.equal(managerAcquisitionContext(f, "team:l:1")?.faab_remaining, 88);
  const noFaab = marketInput(); noFaab.rosters.teams[0]!.faab_used = null; const g = buildMarketSnapshot(noFaab);
  assert.equal(by(g, "30")?.status, "AVAILABLE_FREE_AGENT", "missing FAAB never makes a real FA look unavailable"); assert.ok(g.readiness.limitations.includes("FAAB_CONTEXT_UNAVAILABLE")); assert.equal(g.readiness.pool_actionable, true);
});

test("content identity: stable across request id, snapshot id, as_of, injury designation, roster slot moves; FAAB is its own identity", () => {
  const a = buildMarketSnapshot(marketInput());
  const v = marketInput({ request_id: "req:Z", source_snapshot_id: "snap:Z", as_of: "2026-09-22T15:00:09.000Z" }); v.universe.players = v.universe.players.map((p) => (p.player_id === "31" ? { ...p, injury_status: "Out" } : p));
  v.rosters.teams[0]!.reserve = []; // bench <-> IR slot move
  const b = buildMarketSnapshot(v);
  assert.equal(a.identities.market_content_id, b.identities.market_content_id); assert.notEqual(a.identities.request_id, b.identities.request_id);
  const fa = marketInput(); fa.rosters.teams[0]!.faab_used = 40; const c = buildMarketSnapshot(fa);
  assert.equal(a.identities.market_content_id, c.identities.market_content_id, "FAAB spend does not change availability content"); assert.notEqual(a.acquisition.context_id, c.acquisition.context_id);
  assert.deepEqual(buildMarketSnapshot(marketInput()), buildMarketSnapshot(marketInput()), "byte-identical for identical inputs");
});

test("content identity changes on: ownership change, add/drop, status change, window change, readiness change (NOT on game-lock progression)", () => {
  const a = buildMarketSnapshot(marketInput()).identities.market_content_id; const ids = new Set([a]);
  const addOwner = marketInput(); addOwner.rosters.teams[1]!.players.push("30"); ids.add(buildMarketSnapshot(addOwner).identities.market_content_id);
  const swap = marketInput(); swap.rosters.teams[0]!.players = ["10", "11", "31"]; ids.add(buildMarketSnapshot(swap).identities.market_content_id);
  const stat = marketInput(); stat.universe.players = stat.universe.players.map((p) => (p.player_id === "30" ? { ...p, status: "Inactive" } : p)); ids.add(buildMarketSnapshot(stat).identities.market_content_id);
  ids.add(buildMarketSnapshot(marketInput({ transactions: { source: okSrc(), entries: [{ type: "free_agent", status: "complete", status_updated: agoMs(1), adds: [], drops: ["30"] }] } })).identities.market_content_id);
  const locked = buildMarketSnapshot(marketInput({ schedule: { source: okSrc(), games: [{ week: 3, home: "KC", away: "BUF", status: "in_game" }, { week: 3, home: "DAL", away: "SF", status: "pre_game" }] } }));
  assert.equal(locked.identities.market_content_id, a, "kickoffs do not churn the market identity"); assert.notEqual(locked.identities.lock_id, buildMarketSnapshot(marketInput()).identities.lock_id);
  ids.add(buildMarketSnapshot(marketInput({ transactions: { source: badSrc(), entries: [] } })).identities.market_content_id);
  assert.equal(ids.size, 6);
});

test("pool: deterministic product, positional views over the same snapshot, availability-only replacement support, explicit consumer policy", () => {
  const s = buildMarketSnapshot(marketInput()); const pool = buildFreeAgentPool(s);
  assert.equal(pool.market_content_id, s.identities.market_content_id); assert.equal(buildFreeAgentPool(s).pool_id, pool.pool_id);
  assert.deepEqual(pool.members.map((m) => m.provider_player_id), [...pool.members.map((m) => m.provider_player_id)].sort());
  assert.deepEqual(poolPositionView(pool, "RB").map((m) => m.provider_player_id), ["30"]); assert.equal(replacementAvailability(pool, "DEF").available, 1);
  assert.equal(managerAcquisitionContext(s, "team:l:1")?.roster_size, 2); assert.equal(managerAcquisitionContext(s, "team:nope"), null);
  const pol = consumerActionability(buildMarketSnapshot(marketInput({ schedule: { source: badSrc(), games: null } })), { consumer: "strict", also_blocking: ["GAME_LOCK_UNVERIFIABLE"] });
  assert.equal(pol.actionable, false); assert.deepEqual(pol.blocked_by, ["GAME_LOCK_UNVERIFIABLE"]);
  assert.equal(consumerActionability(s, { consumer: "waiver2", also_blocking: [] }).actionable, true);
});

test("unsupported provider limits are always disclosed; pending claims and clear time are never asserted", () => {
  const s = buildMarketSnapshot(marketInput()); assert.equal(s.limitations.length, 2); assert.ok(s.readiness.reasons.some((r) => r.code === "PENDING_CLAIMS_NOT_EXPOSED"));
  assert.ok(s.players.every((p) => p.status !== "WAIVER_CLAIM_PENDING" && p.waiver_clears_at === null));
  void FAAB_SETTINGS; void AS_OF; void up;
});
