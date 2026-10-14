/**
 * Yahoo Market State -> the weekly decision layer. Proves: a verified Yahoo pool is matched on CANONICAL identity (Yahoo has no Sleeper id), FA and claimable
 * waiver players stay distinct, "unrostered" never becomes available, replacement level comes from the VERIFIED pool, K/DEF participate, a verified player with
 * no projection stays in the pool (valuation unknown != unavailable), readiness is reported as separate axes, and the REAL waiver engine ranks Yahoo players.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildYahooMarketSnapshot, type YahooMarketBuildInput, type YahooPoolRow } from "../lib/market-state/yahoo-build";
import { buildMarketSnapshot } from "../lib/market-state/build";
import { certifyFreeAgentPool, scoringCompatibility } from "../lib/weekly/market-pool-adapter";
import { computeWeeklyReplacement } from "../lib/weekly/replacement";
import { buildWaiverRecommendations } from "../lib/weekly/waivers";
import { waiverPoolFromMarket } from "../lib/waiver2/market-pool";
import type { SourceReport } from "../lib/market-state/contract";
import { player, proj, roster as fxRoster, weeklyContext } from "./fixtures/weekly";

const AS_OF = "2026-10-14T03:00:00.000Z";
const src = (status: SourceReport["status"] = "OK"): SourceReport => ({ status, source_class: "PROVIDER_LIVE", fetched_at: status === "UNAVAILABLE" ? null : AS_OF, detail: null });
const prow = (key: number, name: string, pos: string, team: string, status: "FA" | "W" | "T"): YahooPoolRow => ({ player_key: `471.p.${key}`, player_id: String(key), name, display_position: pos, eligible_positions: [pos], team_abbr: team, status, waiver_clear_date: status === "W" ? "2026-10-14" : null, owner_team_key: status === "T" ? "471.l.1.t.9" : null, ownership_type: status === "T" ? "team" : status === "W" ? "waivers" : null, injury_status: null, bye_week: 7 });
const rpl = (key: number, pos: string, team: string, slot: string) => ({ player_key: `471.p.${key}`, selected_position: slot, name: `R${key}`, display_position: pos, eligible_positions: [pos], team_abbr: team, injury_status: null });

/** Yahoo key -> canonical id used by the fixture's projections */
const CANON: Record<string, string> = { "471.p.1": "qb1", "471.p.2": "rb1", "471.p.3": "rb2", "471.p.4": "wr1", "471.p.5": "wr2", "471.p.6": "te1", "471.p.7": "k1", "471.p.8": "def1", "471.p.9": "wrB", "471.p.50": "faWRa", "471.p.51": "faWRb", "471.p.53": "faK", "471.p.55": "faRB", "471.p.60": "ghostWR", "471.p.56": "player:gsis:00-0036358" };

function market(over: Partial<YahooMarketBuildInput> = {}) {
  return buildYahooMarketSnapshot({
    league_slug: "test-league", season: 2026, week: 1, as_of: AS_OF, request_id: "req:1", source_snapshot_id: null, scoring_fingerprint: "scoring:v1:x",
    rules: { source: src(), roster_positions: [{ position: "QB", count: 1 }, { position: "RB", count: 2 }, { position: "WR", count: 2 }, { position: "TE", count: 1 }, { position: "W/R/T", count: 1 }, { position: "K", count: 1 }, { position: "DEF", count: 1 }, { position: "BN", count: 5 }], uses_faab: false, waiver_type: "FR", waiver_rule: "gametime", waiver_time_days: 2, max_adds_season: null, max_adds_weekly: null, raw: { waiver_type: "FR", waiver_rule: "gametime" } },
    rosters: { source: src(), expected_teams: 1, teams: [{ team_key: "471.l.1.t.1", team_id: "team:test-league:1", faab_balance: null, waiver_priority: 4, players: [rpl(1, "QB", "KC", "QB"), rpl(2, "RB", "KC", "RB"), rpl(3, "RB", "KC", "RB"), rpl(4, "WR", "KC", "WR"), rpl(5, "WR", "KC", "WR"), rpl(6, "TE", "KC", "TE"), rpl(7, "K", "KC", "K"), rpl(8, "DEF", "KC", "DEF"), rpl(9, "WR", "KC", "BN")] }] },
    pool: { source: src(), rows: [prow(50, "FA WR1", "WR", "LV", "FA"), prow(51, "FA WR2", "WR", "LV", "W"), prow(53, "FA K", "K", "LV", "FA"), prow(54, "Las Vegas", "DEF", "LV", "FA"), prow(60, "Ghost WR", "WR", "LV", "FA"), prow(56, "Gsis TE", "TE", "LV", "FA"), ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => ({ ...prow(k, `R${k}`, "WR", "KC", "T"), owner_team_key: "471.l.1.t.1" }))], sub: { FA: { returned: 5, complete: true, pages_fetched: 1, stopped_reason: "end_of_pool" }, W: { returned: 1, complete: true, pages_fetched: 1, stopped_reason: "end_of_pool" }, T: { returned: 9, complete: true, pages_fetched: 1, stopped_reason: "end_of_pool" } } },
    transactions: { source: src() }, schedule: { source: src(), games: null },
    pending_claims: { visibility: "UNAVAILABLE", reason: "the authenticated Yahoo account owns no team in this league", entries: [] },
    canonical_id: (p) => CANON[p.player_key] ?? null,
    ...over,
  });
}

function ctxFixture() {
  const players = [player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"), player("k1", "K"), player("def1", "DEF"), player("wrB", "WR")];
  const fas = [player("faWRa", "WR"), player("faWRb", "WR"), player("faWRc", "WR"), player("faRB", "RB"), player("faK", "K"), player("defense:nfl:lv", "DEF"), player("player:gsis:00-0036358", "TE")];
  return weeklyContext({
    league_slug: "test-league", myRoster: fxRoster("team:test-league:1", ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "wrB", "k1", "def1"], []),
    players, projections: [proj("qb1", "QB", 20), proj("rb1", "RB", 15), proj("rb2", "RB", 12), proj("wr1", "WR", 16), proj("wr2", "WR", 13), proj("te1", "TE", 9), proj("wrB", "WR", 4), proj("k1", "K", 6), proj("def1", "DEF", 5)],
    freeAgents: fas, faProjections: [proj("faWRa", "WR", 14), proj("faWRb", "WR", 12), proj("faWRc", "WR", 22), proj("faRB", "RB", 18), proj("faK", "K", 9), proj("defense:nfl:lv", "DEF", 8), proj("player:gsis:00-0036358", "TE", 7)],
    waiver_settings: { type: "rolling", faab_budget: null, waiver_day: null },
  });
}

describe("certification on canonical identity", () => {
  const ctx = ctxFixture(); const m = market(); const c = certifyFreeAgentPool(m, ctx.availability);
  it("the uncertified baseline treats every unrostered projected player as a free agent (the defect this fixes)", () => {
    assert.ok(ctx.availability.free_agents.some((p) => p.canonical_player_id === "faWRc") && ctx.availability.free_agents.some((p) => p.canonical_player_id === "faRB"));
  });
  it("only players Yahoo itself lists as FA / W are certified; the unrostered-but-unverified (faWRc, faRB) are excluded and demoted", () => {
    const ids = c.free_agents.map((p) => p.canonical_player_id).sort();
    assert.deepEqual(ids, ["defense:nfl:lv", "faK", "faWRa", "faWRb", "player:gsis:00-0036358"]);
    const demoted = c.players!.filter((p) => p.canonical_player_id === "faWRc" || p.canonical_player_id === "faRB");
    assert.ok(demoted.length === 2 && demoted.every((p) => p.ownership === "locked_ineligible" && /not verified available by Yahoo/.test(p.unresolved_note ?? "")));
  });
  it("free agents and waiver claims stay distinct, each with its acquisition method and clear DATE", () => {
    const wr1 = c.free_agents.find((p) => p.canonical_player_id === "faWRa")!, wr2 = c.free_agents.find((p) => p.canonical_player_id === "faWRb")!;
    assert.equal(wr1.ownership, "free_agent"); assert.deepEqual(wr1.acquisition, { method: "FREE_AGENT_ADD", provider_status: "FA", waiver_clears_on: null });
    assert.equal(wr2.ownership, "waiver"); assert.deepEqual(wr2.acquisition, { method: "WAIVER_CLAIM", provider_status: "W", waiver_clears_on: "2026-10-14" });
  });
  it("K and D/ST are certified like any other position", () => assert.ok(c.free_agents.some((p) => p.player.position === "K") && c.free_agents.some((p) => p.player.position === "DEF")));
  it("rostered players are untouched", () => assert.ok(c.players!.filter((p) => ["qb1", "wr1", "k1"].includes(p.canonical_player_id)).every((p) => p.ownership === "rostered_by_manager")));
  it("a blocked market certifies nothing and fails closed (fail-closed behavior is not weakened)", () => {
    const blocked = market({ pool: { source: src("UNAVAILABLE"), rows: [], sub: {} } });
    const r = certifyFreeAgentPool(blocked, ctx.availability);
    assert.equal(r.free_agent_pool_readiness.actionable, false); assert.equal(r.summary, null); assert.equal(r.free_agents, ctx.availability.free_agents, "raw list is returned only so the readiness gate can refuse it");
  });
  it("the Sleeper path is untouched: no relabeling, no summary", () => {
    const s = buildMarketSnapshot({ league_slug: "x", season: 2026, week: 1, as_of: AS_OF, request_id: "r", source_snapshot_id: null, scoring_fingerprint: null, rules: { source: src(), settings: { waiver_type: 0, waiver_clear_days: 1 }, roster_positions: ["QB", "RB", "WR", "BN"] }, rosters: { source: src(), teams: [] }, universe: { source: src(), players: [{ player_id: "1", full_name: "A", position: "WR", fantasy_positions: ["WR"], team: "KC", status: "Active", injury_status: null, active: true }] }, transactions: { source: src(), entries: [] }, schedule: { source: src(), games: null } });
    const r = certifyFreeAgentPool(s, ctx.availability); assert.equal(r.summary, null); assert.equal(r.players, undefined);
  });
});

describe("structured pool evidence (clients never parse prose)", () => {
  const ctx = ctxFixture(); const c = certifyFreeAgentPool(market(), ctx.availability); const s = c.summary!;
  it("counts verified free agents, waivers, unknown and rostered; provider and basis are explicit", () => {
    assert.equal(s.provider, "yahoo"); assert.equal(s.basis, "PROVIDER_STATUS"); assert.equal(s.verified_free_agents, 5); assert.equal(s.verified_waivers, 1); assert.equal(s.unknown_availability, 0); assert.equal(s.rostered, 9);
  });
  it("UNKNOWN PROJECTION != UNAVAILABLE: a verified free agent with no projection stays in the pool and is counted", () => {
    assert.equal(s.verified_without_projection, 1); // ghostWR is verified FA by Yahoo but has no weekly projection
    assert.ok(s.verified_free_agents >= 5 && s.evaluated_with_projection === 5);
  });
  it("verified players with no projection are NAMED (a sample), so the gap is inspectable", () => {
    assert.deepEqual(s.verified_without_projection_sample, ["Ghost WR (WR, LV)"]);
  });
  it("scoring compatibility: the exact fingerprint travels with the pool and the K / D-ST approximation is stated, never hidden", () => {
    const approx = scoringCompatibility("scoring:v1:abc", ["roster_projection_gap", "k_dst_weekly_approximated"]), clean = scoringCompatibility("scoring:v1:abc", []);
    assert.equal(approx.fingerprint, "scoring:v1:abc"); assert.equal(approx.k_dst_weekly_projection, "APPROXIMATED_FROM_PROVIDER_STANDARD_POINTS"); assert.match(approx.note, /Availability of K \/ D\/ST is unaffected/);
    assert.equal(clean.k_dst_weekly_projection, "NOT_FLAGGED");
  });
  it("a verified player with no canonical identity stays in the pool and is counted as identity-unresolved", () => {
    const s2 = certifyFreeAgentPool(market({ canonical_id: (p) => (p.player_key === "471.p.60" ? null : CANON[p.player_key] ?? null) }), ctx.availability).summary!;
    assert.equal(s2.verified_identity_unresolved, 1); assert.equal(s2.verified_free_agents, 5); assert.ok(s2.axes.valuation !== "READY");
  });
  it("readiness AXES are separate: availability READY while valuation / transaction / recommendation are PARTIAL", () => {
    assert.equal(s.axes.availability, "READY"); assert.notEqual(s.axes.valuation, "NOT_READY"); assert.equal(s.axes.transaction, "PARTIAL"); assert.equal(s.axes.recommendation, "PARTIAL");
  });
  it("pending-claim visibility, pool pagination evidence, rules and freshness are exposed", () => {
    assert.equal(s.pending_claims.status, "UNAVAILABLE"); assert.equal(s.pool_evidence!.FA!.complete, true); assert.equal(s.rules.waiver_rule, "gametime"); assert.equal(s.rules.waiver_time_days, 2); assert.equal(s.freshness, "FRESH"); assert.equal(s.observed_at, AS_OF);
    assert.match(s.game_lock_semantics ?? "", /Yahoo's own per-player status/); assert.ok(s.by_position.K!.free_agents === 1 && s.by_position.DEF!.free_agents === 1 && s.by_position.WR!.waivers === 1);
  });
});

describe("replacement and waiver ranking use the VERIFIED Yahoo pool", () => {
  const ctx = ctxFixture(); const c = certifyFreeAgentPool(market(), ctx.availability);
  const certAvail = { ...ctx.availability, free_agents: c.free_agents, players: c.players! };
  const replace = (availability: typeof ctx.availability) => computeWeeklyReplacement({ league_slug: "test-league", week: 1, team_count: 12, constraints: ctx.league.roster_constraints, projections: ctx.projections, availability });
  it("WR replacement level comes from the verified pool (the unverified 22-pt faWRc does not set it); the uncertified baseline is inflated", () => {
    const base = replace(ctx.availability), cert = replace(certAvail);
    assert.ok(cert.by_position.WR!.replacement_points! < base.by_position.WR!.replacement_points!, `certified ${cert.by_position.WR!.replacement_points} < uncertified ${base.by_position.WR!.replacement_points}`);
    assert.equal(cert.by_position.WR!.basis, "available_pool_marginal"); assert.equal(cert.by_position.WR!.sample_size, 2, "faWRa + the claim-only faWRb");
  });
  it("K and D/ST replacement come from the verified K / DEF, not the full-pool rank fallback", () => {
    const cert = replace(certAvail); assert.equal(cert.by_position.K!.basis, "available_pool_marginal"); assert.equal(cert.by_position.DEF!.basis, "available_pool_marginal");
    assert.equal(cert.by_position.RB!.basis !== "available_pool_marginal" || cert.by_position.RB!.sample_size === 0, true, "faRB is unverified: it is NOT an RB replacement");
  });
  it("the real waiver engine ranks Yahoo players: recommendations carry their acquisition method and never include an unverified player", () => {
    const withMarket = { ...ctx, availability: certAvail, replacement: replace(certAvail), market_pool: c.summary! };
    const r = buildWaiverRecommendations(withMarket, { limit: 25 });
    assert.equal(r.availability_status, "AVAILABLE"); assert.ok(r.considered > 0);
    const ids = [...r.recommendations.map((x) => x.add_player_id), ...r.do_not_add.map((x) => x.add_player_id)];
    assert.ok(!ids.includes("faWRc") && !ids.includes("faRB"), "unrostered-but-unverified players never reach the engine");
    assert.ok(r.recommendations.some((x) => x.acquisition?.method === "WAIVER_CLAIM" || x.acquisition?.method === "FREE_AGENT_ADD"));
    for (const x of r.recommendations) { assert.ok(x.acquisition); assert.ok(x.drop_player_id === null || typeof x.drop_player_id === "string"); }
    assert.equal(r.market_pool!.provider, "yahoo"); assert.equal(r.market_pool!.verified_free_agents, 5);
  });
  it("Waiver 2.0's pool reduction matches Yahoo players on canonical identity and includes verified claim-only players", () => {
    const m = market(); const pool = waiverPoolFromMarket(m, { availability: certAvail });
    assert.equal(pool.certification, "CERTIFIED"); const ids = pool.candidates.map((x) => x.canonical_player_id).sort(); assert.deepEqual(ids, ["defense:nfl:lv", "faK", "faWRa", "faWRb", "player:gsis:00-0036358"]);
    assert.equal(pool.market!.coverage.pool_size, 6, "5 verified + the ghost");
  });
});
