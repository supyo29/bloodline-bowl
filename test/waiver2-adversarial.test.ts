/** Phase 4 (Checkpoint H) — adversarial cases the spec names, on the synthetic league (real-league runs are recorded in the doc). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateWaiver2 } from "@/lib/waiver2";
import { mkWaiverInput, stdMine, oppStub, type WaiverFixture } from "./fixtures/waiver2";

const OTHERS: WaiverFixture["others"] = [{ id: "3", players: [{ id: "o1", pos: "WR", pts: 9, team: "GB" }, { id: "o3", pos: "RB", pts: 12, team: "GB" }] }, { id: "4", players: [{ id: "p1", pos: "WR", pts: 5, team: "NE" }, { id: "p3", pos: "RB", pts: 11, team: "NE" }] }];
const fx = (over: Partial<WaiverFixture> = {}): WaiverFixture => ({ mine: stdMine(), others: OTHERS, freeAgents: [], ...over });
const act = (ev: ReturnType<typeof evaluateWaiver2>, id: string) => ev.actions.find((a) => a.candidate?.player_id === id)!;

test("one-week fluke: big recent points, flat role, ordinary projection -> flagged FLUKE_RISK, haircut on future weeks, never the top priority over a role-supported peer", () => {
  const ev = evaluateWaiver2(mkWaiverInput(fx({ freeAgents: [{ id: "fluke", pos: "WR", pts: 8, team: "CHI", ros: 110 }, { id: "solid", pos: "WR", pts: 8, team: "DET", ros: 110 }], roles: { fluke: { tRecent: 0.14, tSeason: 0.14, conf: "HIGH" }, solid: { tRecent: 0.22, tSeason: 0.18, conf: "HIGH", trend: "EXPANDING" } }, recentPoints: { fluke: [34, 29], solid: [9, 10] } })));
  const f = act(ev, "fluke"), s = act(ev, "solid"); assert.equal(f.candidate_asset!.archetype, "FLUKE_RISK"); assert.ok(s.horizons.ros > f.horizons.ros); assert.ok(s.net_action_value > f.net_action_value);
});
test("low-score EMERGING role: a low weekly projection with rising, confident opportunity is valued above a flat peer with more points", () => {
  const ev = evaluateWaiver2(mkWaiverInput(fx({ freeAgents: [{ id: "emerge", pos: "WR", pts: 5, team: "CHI", ros: 90 }, { id: "flat", pos: "WR", pts: 6, team: "DET", ros: 90 }], roles: { emerge: { tRecent: 0.3, tSeason: 0.12, conf: "HIGH", trend: "EXPANDING" }, flat: { tRecent: 0.12, tSeason: 0.12, conf: "HIGH" } } })));
  assert.ok(act(ev, "emerge").horizons.ros > act(ev, "flat").horizons.ros); assert.ok(act(ev, "emerge").candidate_asset!.role.persisted_points >= 1);
});
test("injury replacement with a TWO-WEEK window: the established absence counts for next week only, is flagged uncertain, and ROS is not inflated by it", () => {
  const opp = oppStub({ team: "CHI", absent: "00-star", beneficiary: "00-fill", delta: 0.15 });
  const mk = (injury: string | null) => evaluateWaiver2(mkWaiverInput(fx({ opp, freeAgents: [{ id: "fill", pos: "WR", pts: 6, team: "CHI", ros: 70 }], others: [...OTHERS!, { id: "5", players: [{ id: "star", pos: "WR", pts: 16, team: "CHI", injury, gsis: "00-star" }] }], roles: { star: { tRecent: 0.3, tSeason: 0.3 }, fill: { tRecent: 0.1, tSeason: 0.1 } } })));
  const out = act(mk("Out"), "fill"), well = act(mk(null), "fill");
  const dn = out.horizons.next_week - well.horizons.next_week; assert.ok(dn > 0, "next week gains"); const d3 = out.horizons.next_3 - well.horizons.next_3; assert.ok(Math.abs(d3 - dn) < dn * 0.05 + 0.01, "next_3 gains only the same single week — the window is not extrapolated");
  assert.ok(out.candidate_asset!.uncertainty.components.find((c) => c.source === "injury_contingency")!.level >= 0.6); assert.equal(out.candidate_asset!.archetype, "SHORT_TERM_INJURY_REPLACEMENT");
});
test("elite handcuff: a healthy lead back's backup shows a large CONDITIONAL payoff that is reported, labelled CONTINGENT_HANDCUFF, and carries zero weight in net value", () => {
  const opp = oppStub({ team: "DEN", absent: "00-lead", beneficiary: "00-cuff", dim: "rush_share", delta: 0.4 });
  const mk = (cuffPts: number) => evaluateWaiver2(mkWaiverInput(fx({ opp, freeAgents: [{ id: "cuff", pos: "RB", pts: cuffPts, team: "DEN", ros: 30 }], others: [...OTHERS!, { id: "6", players: [{ id: "lead", pos: "RB", pts: 18, team: "DEN", gsis: "00-lead" }] }], roles: { lead: { rRecent: 0.6, rSeason: 0.6 }, cuff: { rRecent: 0.1, rSeason: 0.1 } } })));
  const a = act(mk(2), "cuff").candidate_asset!; assert.ok(a.by_kind.contingency_payoff >= 1.5); assert.equal(a.by_kind.contingency_counted, 0); assert.equal(a.archetype, "CONTINGENT_HANDCUFF");
  const withoutOpp = evaluateWaiver2(mkWaiverInput(fx({ freeAgents: [{ id: "cuff", pos: "RB", pts: 2, team: "DEN", ros: 30 }], others: [...OTHERS!, { id: "6", players: [{ id: "lead", pos: "RB", pts: 18, team: "DEN", gsis: "00-lead" }] }], roles: { lead: { rRecent: 0.6, rSeason: 0.6 }, cuff: { rRecent: 0.1, rSeason: 0.1 } } })));
  assert.equal(act(mk(2), "cuff").gross_add_value, act(withoutOpp, "cuff").gross_add_value, "the unestablished conditional payoff does not move net value at all");
});
test("an add that requires dropping a similarly valuable, NON-redundant asset yields negative net — never a free +gross", () => {
  const deep = { ...stdMine({ wr: [16, 15, 14, 3, 2] }), bench: [{ id: "r3", pos: "RB" as const, pts: 9, team: "PHI", ros: 120 }, { id: "k2", pos: "K" as const, pts: 9, team: "SF", ros: 100 }, { id: "t2", pos: "TE" as const, pts: 9, team: "MIN", ros: 120 }, { id: "q2", pos: "QB" as const, pts: 12, team: "NE", ros: 130 }, { id: "d2", pos: "DEF" as const, pts: 9, team: "SEA", ros: 120 }] };
  const ev = evaluateWaiver2(mkWaiverInput(fx({ mine: deep, freeAgents: [{ id: "fa1", pos: "WR", pts: 10, team: "CHI", ros: 120 }] }))); const a = act(ev, "fa1");
  assert.ok(a.drop_cost > 1, `drop cost ${a.drop_cost}`); assert.ok(a.drop_asset!.by_kind.bench_option > 0, "the dropped asset carries positional-depth value"); assert.ok(a.net_action_value < a.gross_add_value, "net is gross minus what is given up");
  assert.ok(a.net_action_value < 1.5 && ev.recommended === null, `net ${a.net_action_value}`);
  const cheapDrop = evaluateWaiver2(mkWaiverInput(fx({ freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 140 }] }))); assert.ok(act(cheapDrop, "fa1").net_action_value > a.net_action_value + 5, "the same add is worth far more when the drop is cheap");
});
test("scarce player, many needy managers: competitors are ranked by structural need with evidence, and the expected bid rises with demand", () => {
  const needy = (id: string) => ({ id, players: [{ id: `${id}a`, pos: "WR" as const, pts: 2, team: "GB" }, { id: `${id}b`, pos: "WR" as const, pts: 1, team: "GB" }, { id: `${id}c`, pos: "RB" as const, pts: 14, team: "GB" }, { id: `${id}d`, pos: "RB" as const, pts: 13, team: "GB" }] });
  const many = evaluateWaiver2(mkWaiverInput(fx({ others: [needy("7"), needy("8"), needy("9")], freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }] }))); const few = evaluateWaiver2(mkWaiverInput(fx({ others: [needy("7")], freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }] })));
  const c = act(many, "fa1").market.competitors; assert.equal(c.length, 3); assert.ok(c.every((x, i) => i === 0 || c[i - 1]!.need_strength >= x.need_strength)); assert.ok(c[0]!.evidence.length > 0 && c[0]!.need_strength > 0.3);
  assert.ok(act(many, "fa1").market.faab.expected_competitive! >= act(few, "fa1").market.faab.expected_competitive!);
});
test("no useful waiver move: PASS with reasons, and every action is below the floor once drop, cost and risk are paid", () => {
  const ev = evaluateWaiver2(mkWaiverInput(fx({ mine: stdMine({ wr: [22, 21, 20, 19, 18], rb: [22, 21, 20, 19] }), freeAgents: [{ id: "a", pos: "WR", pts: 6, team: "CHI", ros: 50 }, { id: "b", pos: "RB", pts: 5, team: "DET", ros: 40 }] })));
  assert.equal(ev.recommended, null); assert.match(ev.pass.reasons[0]!, /no waiver claim/); assert.ok(ev.actions.every((a) => a.net_action_value < 3));
});
test("every recommended action is decomposable: named components sum to the reported net", () => {
  const ev = evaluateWaiver2(mkWaiverInput(fx({ freeAgents: [{ id: "fa1", pos: "WR", pts: 11, team: "CHI", ros: 150 }], roles: { fa1: { tRecent: 0.28, tSeason: 0.2, conf: "HIGH", trend: "EXPANDING" } } })));
  for (const a of ev.actions) { const parts = a.gross_add_value - a.drop_cost - a.acquisition_cost - a.risk_penalty + a.components.filter((c) => c.key === "adjustment.lineup").reduce((s, c) => s + (c.value ?? 0), 0); assert.ok(Math.abs(parts - a.net_action_value) < 0.02, a.id); const g = a.value_by_kind.starter + a.value_by_kind.bench_option + a.value_by_kind.contingency_counted; assert.ok(Math.abs(g - a.gross_add_value) < 0.02); }
});
