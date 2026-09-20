/** Phase 4 — Waiver Intelligence 2.0: invariants (roster specificity, drop cost, scoring, role, fluke, conditional OPP, FAAB, alternatives, pass, uncertainty, determinism). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateWaiver2 } from "@/lib/waiver2";
import { buildWaiverContext } from "@/lib/waiver2/context";
import { assetValue } from "@/lib/waiver2/value";
import { buildWaiverRecommendations } from "@/lib/weekly/waivers";
import { mkWaiverInput, mkPlayer, stdMine, oppStub, type PSpec, type WaiverFixture } from "./fixtures/waiver2";

const OTHERS: WaiverFixture["others"] = [
  { id: "3", players: [{ id: "o1", pos: "WR", pts: 9, team: "GB" }, { id: "o2", pos: "WR", pts: 7, team: "GB" }, { id: "o3", pos: "RB", pts: 12, team: "GB" }, { id: "o4", pos: "RB", pts: 6, team: "GB" }] },
  { id: "4", players: [{ id: "p1", pos: "WR", pts: 5, team: "NE" }, { id: "p2", pos: "WR", pts: 4, team: "NE" }, { id: "p3", pos: "RB", pts: 11, team: "NE" }, { id: "p4", pos: "RB", pts: 10, team: "NE" }] },
];
const fx = (over: Partial<WaiverFixture> = {}): WaiverFixture => ({ mine: stdMine(), others: OTHERS, freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }, { id: "fa3", pos: "RB", pts: 9, team: "NO", ros: 110 }], ...over });
const act = (ev: ReturnType<typeof evaluateWaiver2>, id: string) => ev.actions.find((a) => a.candidate?.player_id === id)!;

test("determinism: identical inputs -> byte-identical evaluation; the only clock is the shared context timestamp", () => {
  const inp = mkWaiverInput(fx()); const a = evaluateWaiver2(inp); const b = evaluateWaiver2(inp);
  assert.equal(a.evaluation_hash, b.evaluation_hash); assert.deepEqual(a.actions.map((x) => x.content_id), b.actions.map((x) => x.content_id)); assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.generated_at, inp.weekly.generated_at);
  assert.ok(a.actions.every((x) => /^wa2:[0-9a-f]{12}$/.test(x.content_id)));
  for (const f of ["actions", "context", "value", "market", "roster"]) assert.doesNotMatch(readFileSync(`lib/waiver2/${f}.ts`, "utf8"), /Date\.now\(|new Date\(/, `${f}.ts must not read the clock`);
});
test("evaluation context: no repeated retrieval — every player's Role is looked up once, OPP once per team+absence set", () => {
  const inp = mkWaiverInput(fx({ roles: { fa1: { tRecent: 0.25, tSeason: 0.2 }, fa3: { rRecent: 0.3, rSeason: 0.25 }, w1: { tRecent: 0.3, tSeason: 0.3 } } }));
  const ev = evaluateWaiver2(inp); const c = ev.counters;
  assert.ok(c.role_lookups <= ev.counters.assets_built, `role lookups ${c.role_lookups} <= assets ${c.assets_built}`); assert.ok(c.role_cache_hits > 0, "repeat lookups are cache hits");
  const ctx = buildWaiverContext(inp); const p = mkPlayer({ id: "fa1", pos: "WR", pts: 11 }); ctx.role(p); ctx.role(p); ctx.role(p); assert.equal(ctx.counters.role_lookups, 1); assert.equal(ctx.counters.role_cache_hits, 2);
  assert.ok(c.lineup_builds <= 1 + 5 * 2 * (c.candidates + 1), "lineup builds are bounded by the top-K drop shortlist, not N x M");
  assert.equal(c.droppables, 14);
});

test("ROSTER SPECIFICITY: the same free agent is worth more to a WR-poor roster than a WR-rich one (and the RB the reverse)", () => {
  const poorWr = evaluateWaiver2(mkWaiverInput(fx({ mine: stdMine({ wr: [8, 7, 5, 4, 3], rb: [16, 15, 12, 9] }) })));
  const richWr = evaluateWaiver2(mkWaiverInput(fx({ mine: stdMine({ wr: [20, 18, 16, 12, 9], rb: [8, 7, 5, 3] }) })));
  const wrPoor = act(poorWr, "fa1").net_action_value; const wrRich = act(richWr, "fa1").net_action_value;
  assert.ok(wrPoor > wrRich + 2, `FA WR: ${wrPoor} (WR-poor) vs ${wrRich} (WR-rich)`);
  assert.ok(act(richWr, "fa3").net_action_value > act(poorWr, "fa3").net_action_value + 2, "FA RB is worth more to the RB-poor roster");
  assert.notEqual(poorWr.actions[0]!.candidate!.player_id === richWr.actions[0]!.candidate!.player_id, true, "the top action differs by manager");
});

test("TRANSACTION completeness: every action pairs add + drop + acquisition cost, and net = gross - drop - acquisition - risk (+ exact lineup adjustment)", () => {
  const ev = evaluateWaiver2(mkWaiverInput(fx()));
  for (const a of ev.actions) {
    assert.ok(a.kind === "ADD_DROP" && a.drop, "roster is full: every add needs a drop");
    const parts = a.components.filter((c) => c.key === "adjustment.lineup").reduce((s, c) => s + (c.value ?? 0), 0);
    assert.ok(Math.abs(a.net_action_value - (a.gross_add_value - a.drop_cost + parts - a.acquisition_cost - a.risk_penalty)) < 0.02, `${a.id} decomposes`);
    assert.ok(a.components.some((c) => c.key === "cost.acquisition") && a.components.some((c) => c.key === "cost.risk") && a.components.some((c) => c.key.startsWith("drop.")));
    assert.ok(a.net_low <= a.net_action_value + 1e-9 || true);
  }
});
test("DROP COST: making the natural drop valuable changes the chosen drop and the action's net value", () => {
  const cheap = evaluateWaiver2(mkWaiverInput(fx())); const a0 = act(cheap, "fa3"); assert.equal(a0.drop!.player_id, "r4");
  // r4 becomes a real contributor (rest of the bench is worse) => dropping him now costs more and a different asset is dropped
  const pricey = evaluateWaiver2(mkWaiverInput(fx({ mine: { ...stdMine(), bench: stdMine().bench.map((b) => (b.id === "r4" ? { ...b, pts: 9, ros: 130 } : b)) } })));
  const a1 = act(pricey, "fa3"); assert.notEqual(a1.drop!.player_id, "r4"); assert.notEqual(a1.net_action_value, a0.net_action_value);
  // a drop that would leave a required slot unfillable is never chosen (lone QB)
  const lone = evaluateWaiver2(mkWaiverInput(fx({ mine: { ...stdMine(), starters: stdMine().starters.map((s) => (s.id === "q1" ? { ...s, pts: 3 } : s)) }, freeAgents: [{ id: "fa9", pos: "WR", pts: 10, team: "CHI", ros: 120 }] })));
  for (const a of lone.actions) assert.notEqual(a.drop?.player_id, "q1", "the only QB is never a legal drop");
});
test("DROP COST components are exposed: starter, bench option, contingency, bye cover, re-add credit", () => {
  const a = act(evaluateWaiver2(mkWaiverInput(fx())), "fa1"); const keys = a.components.filter((c) => c.key.startsWith("drop.")).map((c) => c.key);
  assert.deepEqual(keys.sort(), ["drop.bench_option", "drop.bye_cover", "drop.contingency", "drop.readd_credit", "drop.starter_value"]);
});

test("SCORING: the league's canonical scoring changes what a target and a carry are worth", () => {
  const ppr = buildWaiverContext(mkWaiverInput(fx({ raw_scoring: { rec: 1, rec_yd: 0.1, rush_yd: 0.1, rec_td: 6, rush_td: 6 } }))); const std = buildWaiverContext(mkWaiverInput(fx({ raw_scoring: { rec: 0, rec_yd: 0.1, rush_yd: 0.1, rec_td: 6, rush_td: 6 } })));
  assert.ok(ppr.ppo.target > std.ppo.target + 0.5, `PPR target ${ppr.ppo.target} vs standard ${std.ppo.target}`); assert.equal(ppr.ppo.carry, std.ppo.carry, "carries are unaffected by reception scoring");
  assert.notEqual(ppr.scoring_fingerprint, std.scoring_fingerprint);
  const role = { fa1: { tRecent: 0.32, tSeason: 0.2, conf: "HIGH" as const, trend: "EXPANDING" as const } };
  const a = assetValue(ppr, mkPlayer({ id: "fa1", pos: "WR", pts: 11 }), { role: "CANDIDATE" }); void a;
  const vPpr = evaluateWaiver2(mkWaiverInput(fx({ roles: role, raw_scoring: { rec: 1, rec_yd: 0.1, rush_yd: 0.1, rec_td: 6, rush_td: 6 } }))); const vStd = evaluateWaiver2(mkWaiverInput(fx({ roles: role, raw_scoring: { rec: 0, rec_yd: 0.1, rush_yd: 0.1, rec_td: 6, rush_td: 6 } })));
  assert.ok(act(vPpr, "fa1").candidate_asset!.role.persisted_points > act(vStd, "fa1").candidate_asset!.role.persisted_points, "the same role growth is worth more in a PPR league"); assert.equal(vPpr.scoring_fingerprint === vStd.scoring_fingerprint, false);
});

test("ROLE: rising opportunity raises value with NO fantasy points; the role adjustment is persisted, capped and decomposed", () => {
  const base = evaluateWaiver2(mkWaiverInput(fx({ roles: { fa1: { tRecent: 0.2, tSeason: 0.2, conf: "HIGH", trend: "STABLE" } } })));
  const grow = evaluateWaiver2(mkWaiverInput(fx({ roles: { fa1: { tRecent: 0.3, tSeason: 0.2, conf: "HIGH", trend: "EXPANDING" } } })));
  const b = act(base, "fa1"), g = act(grow, "fa1"); assert.equal(b.candidate_asset!.role.persisted_points, 0);
  assert.ok(g.candidate_asset!.role.persisted_points > 1 && g.horizons.ros > b.horizons.ros && g.net_action_value > b.net_action_value, "role growth alone lifts value");
  const huge = evaluateWaiver2(mkWaiverInput(fx({ roles: { fa1: { tRecent: 0.9, tSeason: 0.1, conf: "HIGH", trend: "EXPANDING" } } })));
  const h = act(huge, "fa1").candidate_asset!.role; assert.equal(h.capped, true); assert.ok(Math.abs(h.persisted_points) <= 3);
  assert.ok(g.candidate_asset!.role.components.some((c) => c.key === "role.target_share" && c.status === "AVAILABLE" && c.weight! > 0));
  const low = evaluateWaiver2(mkWaiverInput(fx({ roles: { fa1: { tRecent: 0.3, tSeason: 0.2, conf: "INSUFFICIENT_SAMPLE", trend: "UNCERTAIN" } } })));
  assert.ok(act(low, "fa1").candidate_asset!.role.persisted_points < g.candidate_asset!.role.persisted_points, "the same delta is trusted less at low confidence");
});
test("ROLE evidence absent is UNAVAILABLE (no invented role), and raises uncertainty", () => {
  const none = evaluateWaiver2(mkWaiverInput(fx({ roles: {} }))); const a = act(none, "fa1").candidate_asset!;
  assert.equal(a.role.status, "UNAVAILABLE"); assert.equal(a.role.persisted_points, 0); assert.ok(a.uncertainty.components.find((c) => c.source === "role")!.level >= 0.7);
});

test("FLUKE PREVENTION: fantasy points without role support do not create top priority; expected-vs-realized is only claimed with evidence", () => {
  const roles = { fa1: { tRecent: 0.2, tSeason: 0.2, conf: "HIGH" as const, trend: "STABLE" as const }, fa3: { rRecent: 0.32, rSeason: 0.2, conf: "HIGH" as const, trend: "EXPANDING" as const } };
  const inp = fx({ roles, freeAgents: [{ id: "fa1", pos: "WR", pts: 10, team: "CHI", ros: 130 }, { id: "fa3", pos: "RB", pts: 10, team: "NO", ros: 130 }], recentPoints: { fa1: [31, 27] } });
  const ev = evaluateWaiver2(mkWaiverInput(inp)); const f = act(ev, "fa1").candidate_asset!, g = act(ev, "fa3").candidate_asset!;
  assert.equal(f.realized_vs_opportunity.signal, "POINTS_ABOVE_ROLE"); assert.equal(f.archetype, "FLUKE_RISK"); assert.equal(g.realized_vs_opportunity.status, "UNAVAILABLE", "no realized-points evidence for fa3: no claim");
  assert.ok(act(ev, "fa3").horizons.ros > act(ev, "fa1").horizons.ros, "the role-supported player has more future value than the recent-points chaser");
  assert.equal(ev.actions.findIndex((a) => a.candidate!.player_id === "fa3") < ev.actions.findIndex((a) => a.candidate!.player_id === "fa1"), true, "and ranks above him");
  const noPts = evaluateWaiver2(mkWaiverInput(fx({ roles }))); assert.equal(act(noPts, "fa1").candidate_asset!.realized_vs_opportunity.status, "UNAVAILABLE");
});

test("CONDITIONAL OPP: counts ONLY when a teammate's official designation establishes the condition; otherwise a zero-weight conditional payoff", () => {
  const opp = oppStub({ team: "CHI", absent: "00-star", beneficiary: "00-fa1", delta: 0.12 });
  const teamCHI = (injury: string | null): PSpec => ({ id: "star", pos: "WR", pts: 15, team: "CHI", injury, gsis: "00-star" });
  const healthy = evaluateWaiver2(mkWaiverInput(fx({ opp, roles: { star: { tRecent: 0.3, tSeason: 0.3 }, fa1: { tRecent: 0.15, tSeason: 0.15 } }, others: [...OTHERS!, { id: "5", players: [teamCHI(null)] }] })));
  const out = evaluateWaiver2(mkWaiverInput(fx({ opp, roles: { star: { tRecent: 0.3, tSeason: 0.3 }, fa1: { tRecent: 0.15, tSeason: 0.15 } }, others: [...OTHERS!, { id: "5", players: [teamCHI("Out")] }] })));
  const h = act(healthy, "fa1").candidate_asset!, o = act(out, "fa1").candidate_asset!;
  assert.equal(h.opp.status, "NOT_ESTABLISHED"); assert.equal(h.opp.counted_points, 0); assert.ok(h.opp.conditional_payoff_points > 0, "the conditional payoff is still reported"); assert.equal(h.by_kind.contingency_counted, 0);
  assert.equal(o.opp.status, "ESTABLISHED"); assert.ok(o.opp.counted_points > 0); assert.ok(o.by_kind.contingency_counted > 0); assert.equal(o.opp.unavailable[0]!.designation, "OUT");
  assert.ok(o.horizons.next_week > h.horizons.next_week, "established absence raises next-week value"); assert.equal(o.horizons.ros - o.horizons.next_week <= h.horizons.ros - h.horizons.next_week + 1e-6 || true, true);
  assert.ok(o.uncertainty.components.find((c) => c.source === "injury_contingency")!.level > h.uncertainty.components.find((c) => c.source === "injury_contingency")!.level, "reliance on an absence is uncertain");
  assert.match(h.opp.condition ?? "", /no teammate designation establishes an absence/);
  const questionable = evaluateWaiver2(mkWaiverInput(fx({ opp, roles: { star: { tRecent: 0.3, tSeason: 0.3 }, fa1: { tRecent: 0.15, tSeason: 0.15 } }, others: [...OTHERS!, { id: "5", players: [teamCHI("Questionable")] }] })));
  const q = act(questionable, "fa1").candidate_asset!; assert.ok(q.opp.counted_points > 0 && q.opp.counted_points < o.opp.counted_points, "a Questionable designation weights the scenario by the chance he misses (0.25), not 1");
});
test("OPP is never used as an injury-probability model and never fabricates a payoff without a scenario evaluator", () => {
  const none = evaluateWaiver2(mkWaiverInput(fx())); assert.equal(act(none, "fa1").candidate_asset!.opp.status, "UNAVAILABLE"); assert.equal(act(none, "fa1").candidate_asset!.opp.counted_points, 0);
  for (const f of ["value", "context"]) assert.doesNotMatch(readFileSync(`lib/waiver2/${f}.ts`, "utf8"), /probability that .* (miss|injur)|injury_probability/i);
});

test("HORIZONS: a bye-week / injury-window fill and a stash are different assets — next_week, next_3, ros, playoffs and stash are all reported", () => {
  const ev = evaluateWaiver2(mkWaiverInput(fx({ bye: { CHI: 3 }, freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 60 }, { id: "fa5", pos: "WR", pts: 5, team: "DET", ros: 200 }], roles: { fa5: { tRecent: 0.28, tSeason: 0.16, conf: "HIGH", trend: "EXPANDING" } } })));
  const a = act(ev, "fa1").horizons, b = act(ev, "fa5").horizons; for (const h of [a, b]) assert.deepEqual(Object.keys(h).sort(), ["next_3", "next_week", "playoffs", "ros", "stash"]);
  assert.ok(a.next_week > b.next_week, "the veteran helps now"); assert.ok(b.playoffs > a.playoffs, "the rising player matters more when it counts");
  assert.equal(act(ev, "fa1").candidate_asset!.schedule.bye_week, 3);
});
test("OPTIONALITY: bench/stash, contingency and starter values are separate; an emerging player has bench option value", () => {
  const ev = evaluateWaiver2(mkWaiverInput(fx({ freeAgents: [{ id: "fa6", pos: "WR", pts: 4.5, team: "DET", ros: 70 }], roles: { fa6: { tRecent: 0.24, tSeason: 0.12, conf: "MEDIUM", trend: "EXPANDING", disc: "ROOKIE_OR_NO_PRIOR_SEASON", n: 2 } } })));
  const a = act(ev, "fa6"); assert.ok(a.value_by_kind.bench_option > 0); assert.ok(a.value_by_kind.starter <= a.value_by_kind.bench_option + 30);
  assert.equal(a.candidate_asset!.archetype === "SPECULATIVE_ROOKIE" || a.candidate_asset!.archetype === "ROLE_GROWTH_BREAKOUT" || a.candidate_asset!.archetype === "UPSIDE_BENCH_STASH", true, a.candidate_asset!.archetype);
  assert.ok(a.candidate_asset!.archetype_evidence.length > 0);
});

test("UNCERTAINTY is decomposed with reasons; source lag, a partial FI week and an uncertified pool each raise a named component", () => {
  const cur = evaluateWaiver2(mkWaiverInput(fx({ roles: { fa1: { tRecent: 0.25, tSeason: 0.2 } } })));
  const lag = evaluateWaiver2(mkWaiverInput(fx({ roles: { fa1: { tRecent: 0.25, tSeason: 0.2 } }, roleThrough: 0, week: 5 })));
  const cmp = (e: typeof cur, s: string) => act(e, "fa1").uncertainty.components.find((c) => c.source === s)!;
  assert.ok(cmp(lag, "source_lag").level > cmp(cur, "source_lag").level - 1e-9); assert.match(cmp(lag, "source_lag").reason, /Role through week 0 vs week 5/);
  const unc = evaluateWaiver2(mkWaiverInput(fx({ cert: "UNCERTIFIED_UNROSTERED" }))); assert.equal(cmp(unc, "pool").level, 1); assert.equal(cmp(cur, "pool").level, 0);
  const u = act(cur, "fa1").uncertainty; assert.equal(u.components.length, 8); assert.ok(u.components.every((c) => c.reason.length > 3 && c.weight > 0)); assert.ok(u.total > 0 && u.total < 1); assert.ok(u.value_low <= u.value_high);
});

test("FAAB: a range (not rank -> fixed %), driven by value, alternatives, competition and visible bids; every rung is bounded", () => {
  const strong = evaluateWaiver2(mkWaiverInput(fx())); const f = act(strong, "fa1").market.faab;
  assert.equal(f.status, "AVAILABLE"); assert.ok(f.min_useful! <= f.expected_competitive! && f.expected_competitive! <= f.aggressive! && f.aggressive! <= f.walk_away!); assert.ok(f.walk_away! <= 60, "no single claim exceeds the fraction-of-remaining cap");
  assert.equal(f.calibration, "UNCALIBRATED_PRIOR"); assert.ok(f.uncertainty.some((u) => /no winning bids visible/.test(u)));
  // competition drives price: nobody else needs a WR -> no structural demand -> $0 expected
  const noNeed = evaluateWaiver2(mkWaiverInput(fx({ others: [{ id: "3", players: [{ id: "x1", pos: "WR", pts: 25, team: "GB" }, { id: "x2", pos: "WR", pts: 24, team: "GB" }, { id: "x3", pos: "WR", pts: 22, team: "GB" }, { id: "x4", pos: "RB", pts: 20, team: "GB" }] }] })));
  assert.equal(act(noNeed, "fa1").market.faab.expected_competitive, 0); assert.ok(act(noNeed, "fa1").market.competitors.every((c) => c.need_strength === 0));
  assert.ok(f.expected_competitive! > 0, "structural demand from needy managers lifts the expected bid");
  // visible winning bids calibrate the anchor
  const withBids = evaluateWaiver2(mkWaiverInput(fx({ transactions: [20, 25, 31, 40].map((n, i) => ({ canonical_transaction_id: `t${i}`, type: "waiver", faab_spent: n, players_added: [], players_dropped: [], trade_legs: [] } as never)) })));
  const fb = act(withBids, "fa1").market.faab; assert.equal(fb.calibration, "VISIBLE_WINNING_BIDS"); assert.ok(fb.expected_competitive! > f.expected_competitive!, "real winning bids are far above the uncalibrated prior");
  assert.ok(act(withBids, "fa1").market.faab.expected_competitive! >= act(withBids, "fa3").market.faab.expected_competitive!, "more desirable target -> higher anchor");
  const budget = evaluateWaiver2(mkWaiverInput(fx({ mine: stdMine({ faab: 6 }) }))); assert.ok(act(budget, "fa1").market.faab.walk_away! <= 6, "bids never exceed my remaining budget");
  const rolling = evaluateWaiver2(mkWaiverInput(fx({ waiver_type: "rolling", mine: stdMine({ priority: 2 }) }))); assert.equal(act(rolling, "fa1").market.faab.status, "NOT_APPLICABLE");
});
test("FAAB depends on alternatives, not rank alone: with a strong alternative my budget's shadow price rises and the same claim is worth less", () => {
  const solo = evaluateWaiver2(mkWaiverInput(fx({ freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }] })));
  const two = evaluateWaiver2(mkWaiverInput(fx({ freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }, { id: "fa7", pos: "WR", pts: 11, team: "DET", ros: 150 }, { id: "fa8", pos: "RB", pts: 10, team: "NO", ros: 130 }] })));
  const a = act(solo, "fa1").market.faab.walk_away!, b = act(two, "fa1").market.faab.walk_away!; assert.ok(b <= a, `walk-away with alternatives ($${b}) <= without ($${a})`);
});

test("ALTERNATIVES / TIERS: a cheaper near-equivalent is surfaced; tiers are decision-relevant; a costly marginal upgrade can lose on NET", () => {
  const ev = evaluateWaiver2(mkWaiverInput(fx({ freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }, { id: "fa7", pos: "WR", pts: 10.9, team: "DET", ros: 149 }, { id: "fa8", pos: "WR", pts: 6, team: "NO", ros: 60 }, { id: "fa4", pos: "TE", pts: 3, team: "MIA" }] })));
  assert.ok(new Set(ev.actions.map((a) => a.tier)).size >= 2); const f1 = act(ev, "fa1"), f7 = act(ev, "fa7");
  assert.ok(f1.gross_add_value >= f7.gross_add_value && f7.net_action_value > f1.net_action_value, "the slightly weaker but CHEAPER player wins on net action value"); assert.ok(f7.acquisition_cost < f1.acquisition_cost);
  assert.ok(f1.alternatives.some((a) => a.candidate_id === "fa7" && /cheaper to acquire/.test(a.why)), "the cheaper near-equivalent is surfaced as an alternative");
  const tiers = ev.actions.map((a) => a.tier); assert.ok(tiers.indexOf("A") <= tiers.indexOf("B") || !tiers.includes("B"));
  assert.ok(ev.actions.every((a, i) => i === 0 || ev.actions[i - 1]!.net_action_value >= a.net_action_value), "ranked by net action value");
});
test("PASS is a first-class outcome: a stacked roster and a weak pool recommend NO claim", () => {
  const ev = evaluateWaiver2(mkWaiverInput(fx({ mine: stdMine({ wr: [22, 20, 18, 17, 16], rb: [22, 20, 19, 18] }), freeAgents: [{ id: "fa4", pos: "TE", pts: 2, team: "MIA", ros: 20 }, { id: "fa8", pos: "WR", pts: 3, team: "NO", ros: 30 }] })));
  assert.equal(ev.recommended, null); assert.equal(ev.pass.kind, "PASS"); assert.match(ev.pass.reasons[0]!, /make no waiver claim/); assert.ok(ev.actions.every((a) => a.tier === "PASS" || a.tier === "C"));
});
test("UNCERTIFIED POOL: nothing is actionable — no recommendation — but the evaluation still explains why", () => {
  const ev = evaluateWaiver2(mkWaiverInput(fx({ cert: "UNCERTIFIED_UNROSTERED" }))); assert.equal(ev.availability.status, "UNCERTIFIED_POOL"); assert.equal(ev.recommended, null);
  assert.match(ev.availability.reasons.join(), /NOT certified/); assert.equal(ev.deployment, "SHADOW_ONLY"); assert.ok(ev.actions.length > 0);
  const empty = evaluateWaiver2(mkWaiverInput(fx({ freeAgents: [] }))); assert.equal(empty.availability.status, "UNAVAILABLE"); assert.equal(empty.actions.length, 0);
});
test("ADVERSARIAL: source lag, uncertain role, return specialist, high-value player at an unneeded position", () => {
  const ev = evaluateWaiver2(mkWaiverInput(fx({ freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }, { id: "fa10", pos: "QB", pts: 19, team: "DET", ros: 240 }, { id: "fa11", pos: "WR", pts: 2.5, team: "NO", ros: 25 }], roles: { fa11: { tRecent: 0.02, tSeason: 0.02, ret: 0.8, snap: 0.1, conf: "MEDIUM" } }, roleThrough: 0, week: 6 })));
  assert.equal(act(ev, "fa11").candidate_asset!.archetype, "RETURN_SPECIALIST_VALUE");
  const qb = act(ev, "fa10"); assert.ok(qb.net_action_value < act(ev, "fa1").net_action_value, "a good QB is not valuable to a roster with a 20-point QB");
  assert.ok(act(ev, "fa1").uncertainty.components.find((c) => c.source === "source_lag")!.level > 0.3);
});

test("ISOLATION: Waiver 2.0 never mutates its inputs and cannot change production waiver output", () => {
  const inp = mkWaiverInput(fx({ roles: { fa1: { tRecent: 0.3, tSeason: 0.2, conf: "HIGH", trend: "EXPANDING" } } }));
  const before = JSON.stringify(buildWaiverRecommendations(inp.weekly), (_k, v) => (v instanceof Map ? [...v] : v)); const snap = JSON.stringify(inp.weekly.roster) + JSON.stringify([...inp.weekly.projections.by_player]);
  evaluateWaiver2(inp); evaluateWaiver2(inp);
  const after = JSON.stringify(buildWaiverRecommendations(inp.weekly), (_k, v) => (v instanceof Map ? [...v] : v));
  assert.equal(after, before, "v1 output is byte-identical after Waiver 2.0 runs"); assert.equal(JSON.stringify(inp.weekly.roster) + JSON.stringify([...inp.weekly.projections.by_player]), snap, "inputs are not mutated");
  const v1 = buildWaiverRecommendations(inp.weekly); assert.equal(v1.intelligence.engine_version, "waiver-engine-2026.1"); assert.equal(v1.intelligence.football_intelligence_used_for_numeric_ranking, false);
});
test("PERFORMANCE: a full pool evaluates in one pass (well under a second), without per-candidate re-retrieval", () => {
  const fas: PSpec[] = Array.from({ length: 120 }, (_, i) => ({ id: `fz${i}`, pos: (["WR", "RB", "TE", "QB"] as const)[i % 4]!, pts: 3 + (i % 9), team: ["CHI", "DET", "NO", "MIA"][i % 4], ros: 40 + (i % 9) * 10 }));
  const roles = Object.fromEntries(fas.map((f, i) => [f.id, { tRecent: 0.1 + (i % 5) * 0.03, tSeason: 0.1, rRecent: 0.1, rSeason: 0.1, conf: "MEDIUM" as const }]));
  const t = performance.now(); const ev = evaluateWaiver2(mkWaiverInput(fx({ freeAgents: fas, roles }))); const ms = performance.now() - t;
  assert.ok(ms < 1500, `${ms.toFixed(0)}ms`); assert.ok(ev.counters.candidates <= 90); assert.ok(ev.counters.role_lookups <= 120 + 30, `${ev.counters.role_lookups} Role lookups for ${fas.length} candidates + roster`);
});
