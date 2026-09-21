/** Phase 5 Checkpoint H — adversarial representative cases (synthetic 32-defense league) + invariants. */
import test from "node:test";
import assert from "node:assert/strict";
import { buildMatchupContext } from "@/lib/matchup2/context";
import { evaluatePlayer, injuryUncertainty } from "@/lib/matchup2/engine";
import { buildDefenseProfile } from "@/lib/matchup2/defense";
import type { MatchupEvaluation } from "@/lib/matchup2/contract";
import { mkSource, mkPlayer, type SourceSpec } from "./fixtures/matchup2";

const run = (spec: SourceSpec, def: string, id: string, state?: { injury_status?: string | null }): MatchupEvaluation => { const s = mkSource(spec); return evaluatePlayer(s, buildMatchupContext(s, { offense_team: "T00", defense_team: def, week: 3 }), id, state) as MatchupEvaluation; };
const c = (e: MatchupEvaluation, id: string) => e.components.find((x) => x.id === id)!;

test("zone-heavy defense vs zone-beating slot-type WR ⇒ advantage; man-heavy defense vs perimeter separator ⇒ advantage; the mirror images are disadvantages", () => {
  const spec = { players: [{ gsis: "slot", pos: "WR" as const, epaMan: 0, epaZone: 0.3 }, { gsis: "sep", pos: "WR" as const, epaMan: 0.3, epaZone: 0.0 }] };
  assert.equal(c(run(spec, "T00", "slot"), "wr.coverage.man_zone").direction, "ADVANTAGE"); assert.equal(c(run(spec, "T31", "sep"), "wr.coverage.man_zone").direction, "ADVANTAGE"); assert.equal(c(run(spec, "T31", "slot"), "wr.coverage.man_zone").direction, "DISADVANTAGE"); assert.equal(c(run(spec, "T00", "sep"), "wr.coverage.man_zone").direction, "DISADVANTAGE");
});
test("blitz-heavy defense vs a QB who thrives against 5+ rushers is not a disadvantage; against one who collapses it is; four-man pressure is its own exposed dimension", () => {
  const spec: SourceSpec = { players: [{ gsis: "quick", pos: "QB", pressEpa: 0.1, cleanEpa: 0.12 }, { gsis: "slow", pos: "QB", pressEpa: -0.7, cleanEpa: 0.15 }], defs: { 30: { blitz: 0.6, pressure: 0.5 } } };
  const q = run(spec, "T30", "quick"), s = run(spec, "T30", "slow"); assert.notEqual(c(q, "qb.pressure.response").direction, "DISADVANTAGE"); assert.equal(c(s, "qb.pressure.response").direction, "DISADVANTAGE");
  assert.ok(["NEUTRAL", "DISADVANTAGE"].includes(c(s, "qb.pressure.rusher_count").direction));
  const prof = buildDefenseProfile(buildMatchupContext(mkSource(spec), { offense_team: "T00", defense_team: "T30", week: 3 }))!; assert.ok(prof.pressure.some((p) => p.key === "pressure_without_heavy_blitz_rate") && prof.pressure.some((p) => p.key === "blitz_proxy_rate" && p.rank_high_to_low === 1));
});
test("weak perimeter run defense vs an outside/edge profile ⇒ advantage; the same defense vs an inside profile is not", () => {
  const spec: SourceSpec = { players: [{ gsis: "edge", pos: "RB", midShare: 0.05 }, { gsis: "inside", pos: "RB", midShare: 0.95 }], defs: { 12: { runMid: -0.3, runEnd: 0.25 } } };
  assert.equal(c(run(spec, "T12", "edge"), "rb.run.direction").direction, "ADVANTAGE"); assert.notEqual(c(run(spec, "T12", "inside"), "rb.run.direction").direction, "ADVANTAGE");
});
test("TE vs middle-of-field: a defense that concedes the intermediate middle helps a middle-volume TE; the interaction reads the player's cells, not 'TE'", () => {
  const te = mkPlayer({ gsis: "te", pos: "TE", deepShare: 0.05, shortShare: 0.2 }); te.receiver_cells = te.receiver_cells.map((x) => ({ ...x, share: x.field_third === "MIDDLE" && x.depth_bin === "INTERMEDIATE" ? 0.4 : 0.6 / 11 }));
  const base = mkSource(); const src = { ...base, resolvePlayer: (id: string) => (id === "te" ? te : null), defense: (t: string) => { const d = base.defense(t)!; return t === "T15" ? { ...d, pass_cells: d.pass_cells.map((x) => (x.depth_bin === "INTERMEDIATE" && x.field_third === "MIDDLE" ? { ...x, epa: 0.4 } : x)) } : d; } };
  assert.equal((evaluatePlayer(src, buildMatchupContext(src, { offense_team: "T00", defense_team: "T15", week: 3 }), "te") as MatchupEvaluation).components.find((x) => x.id === "te.area.pass")!.direction, "ADVANTAGE");
});
test("mixed vintage + coaching/scheme change + missing role are all surfaced; none changes a component value", () => {
  const a = run({ players: [{ gsis: "w", pos: "WR", epaMan: 0, epaZone: 0.3 }] }, "T09", "w"); const b = run({ players: [{ gsis: "w", pos: "WR", epaMan: 0, epaZone: 0.3, role: null }], defs: { 9: { reset: true } } }, "T09", "w");
  assert.deepEqual(c(a, "wr.coverage.man_zone").value, c(b, "wr.coverage.man_zone").value); const kinds = b.uncertainty.map((u) => u.kind); for (const k of ["SCHEME_RESET_HINT", "ROLE_INSTABILITY", "MIXED_VINTAGE"]) assert.ok(kinds.includes(k as never), k); assert.ok(!a.uncertainty.some((u) => u.kind === "SCHEME_RESET_HINT"));
});
test("injury-driven state: reported availability adds uncertainty only — no injury is predicted and no redistribution or value change happens here", () => {
  const spec = { players: [{ gsis: "w", pos: "WR" as const, epaMan: 0, epaZone: 0.3 }] }; const healthy = run(spec, "T09", "w"); const out = run(spec, "T09", "w", { injury_status: "Out" }); const q = run(spec, "T09", "w", { injury_status: "Questionable" });
  assert.deepEqual(out.components, healthy.components); assert.equal(out.uncertainty.find((u) => u.kind === "PLAYER_INJURY_STATE")!.level, "HIGH"); assert.equal(q.uncertainty.find((u) => u.kind === "PLAYER_INJURY_STATE")!.level, "MEDIUM"); assert.ok(!healthy.uncertainty.some((u) => u.kind === "PLAYER_INJURY_STATE")); assert.notEqual(out.content_identity, healthy.content_identity);
  assert.deepEqual(injuryUncertainty({ injury_status: "Active" }), []); assert.deepEqual(injuryUncertainty({ injury_status: null }), []); assert.match(injuryUncertainty({ injury_status: "IR" })[0]!.note, /no injury is predicted/);
});
test("small-sample historical matchup / current-season charting: expressed as UNSUPPORTED, never as a directional claim", () => {
  const e = run({ players: [{ gsis: "w", pos: "WR", ev: "WEAK", epaMan: 0, epaZone: 0.3 }] }, "T09", "w"); assert.ok(e.unsupported.some((u) => u.id === "coach_history" && /leak later seasons/.test(u.reason))); assert.ok(e.unsupported.some((u) => u.id === "current_season_charting"));
  assert.ok(!e.components.some((x) => /history|head_to_head|coach/.test(x.id)));
});
test("invariants: interaction not rank — for the same defense two roles get opposite readings; position specificity; source honesty; shadow safety; determinism", () => {
  const spec = { players: [{ gsis: "a", pos: "WR" as const, epaMan: 0, epaZone: 0.3 }, { gsis: "b", pos: "WR" as const, epaMan: 0.3, epaZone: 0 }] };
  const A = c(run(spec, "T31", "a"), "wr.coverage.man_zone").direction, B = c(run(spec, "T31", "b"), "wr.coverage.man_zone").direction; assert.notEqual(A, B, "the same defense reads opposite for two roles");
  const e = run(spec, "T31", "a"); assert.equal(e.numeric_adjustment, null); assert.equal(e.may_influence_production, false); assert.ok(e.unsupported.some((u) => u.id === "cornerback_assignment")); assert.deepEqual(e, run(spec, "T31", "a"));
});
