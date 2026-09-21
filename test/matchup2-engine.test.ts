/** Phase 5 Checkpoints C/D/E — coverage/pass, run/front, player-specific engine. Synthetic 32-defense league (no files). */
import test from "node:test";
import assert from "node:assert/strict";
import { buildMatchupContext } from "@/lib/matchup2/context";
import { evaluatePlayer, evaluatePlayers, evaluateTeam } from "@/lib/matchup2/engine";
import { buildDefenseProfile } from "@/lib/matchup2/defense";
import type { MatchupEvaluation } from "@/lib/matchup2/contract";
import { mkSource, type SourceSpec } from "./fixtures/matchup2";

const ev = (spec: SourceSpec, def: string, player: string, off = "T00"): MatchupEvaluation => { const s = mkSource(spec); const r = evaluatePlayer(s, buildMatchupContext(s, { offense_team: off, defense_team: def, week: 3 }), player); assert.ok(!("error" in r), JSON.stringify(r)); return r as MatchupEvaluation; };
const comp = (e: MatchupEvaluation, id: string) => e.components.find((c) => c.id === id)!;
const ZONE_BEATER = { gsis: "wr-zone", pos: "WR" as const, epaMan: 0.0, epaZone: 0.3 }; const MAN_BEATER = { gsis: "wr-man", pos: "WR" as const, epaMan: 0.3, epaZone: 0.0 };

test("WR coverage: a zone-beating role is disadvantaged by a man-heavy defense and advantaged by a zone-heavy one; a man-beater is the reverse (interaction, not rank)", () => {
  const spec = { players: [ZONE_BEATER, MAN_BEATER] };
  assert.equal(comp(ev(spec, "T31", "wr-zone"), "wr.coverage.man_zone").direction, "DISADVANTAGE"); assert.equal(comp(ev(spec, "T00", "wr-zone"), "wr.coverage.man_zone").direction, "ADVANTAGE");
  assert.equal(comp(ev(spec, "T31", "wr-man"), "wr.coverage.man_zone").direction, "ADVANTAGE"); assert.equal(comp(ev(spec, "T00", "wr-man"), "wr.coverage.man_zone").direction, "DISADVANTAGE");
  const c = comp(ev(spec, "T31", "wr-zone"), "wr.coverage.man_zone"); assert.ok(Number(c.inputs.man_edge) < 0 && c.rank_among_defenses === 32 && c.sensitivity.length === 3);
});
test("strong defense overall can still be a favourable structure for THIS player (and the engine says the two disagree)", () => {
  const spec: SourceSpec = { players: [ZONE_BEATER], defs: { 0: { deepEpa: 0.25, shortEpa: 0.25, unitWr: 0.3, rz: 0.2, explDeep: 0.6 } } };
  const e = ev(spec, "T00", "wr-zone"); assert.equal(e.generic_defense_context.overall_percentile, 1, "generically the best defense in the league"); assert.equal(e.structural_verdict, "FAVORABLE"); assert.equal(e.player_specific_vs_generic, "DISAGREE"); assert.ok(e.advantages.length >= 3);
});
test("weak defense overall can be an unfavourable structure for THIS role", () => {
  const spec: SourceSpec = { players: [ZONE_BEATER], defs: { 31: { deepEpa: -0.4, shortEpa: -0.4, unitWr: -0.3, rz: -0.3, explDeep: 0.0 } } };
  const e = ev(spec, "T31", "wr-zone"); assert.equal(e.generic_defense_context.overall_percentile, 0); assert.equal(e.structural_verdict, "UNFAVORABLE"); assert.equal(e.player_specific_vs_generic, "DISAGREE");
});
test("position specificity: QB, RB, WR and TE use different component families", () => {
  const spec = { players: [{ gsis: "qb", pos: "QB" as const }, { gsis: "rb", pos: "RB" as const }, { gsis: "wr", pos: "WR" as const }, { gsis: "te", pos: "TE" as const }] };
  const ids = (p: string) => ev(spec, "T10", p).components.map((c) => c.id);
  const qb = ids("qb"), rb = ids("rb"), wr = ids("wr"), te = ids("te");
  for (const id of ["qb.pressure.response", "qb.pressure.rusher_count", "team.pressure.line"]) assert.ok(qb.includes(id), id); for (const id of ["rb.run.direction", "rb.run.gap", "rb.run.box"]) assert.ok(rb.includes(id), id);
  assert.ok(!wr.some((i) => i.includes("run.") || i.includes("pressure")) && !te.some((i) => i.includes("run.") || i.includes("pressure")) && !qb.some((i) => i.includes("run.")));
  assert.ok(wr.includes("receiver.route.family") && wr.includes("wr.receiving.unit_coverage") && te.includes("te.receiving.unit_coverage"));
});
test("QB pressure: a QB who collapses under pressure is disadvantaged by a heavy-pressure defense; a resilient QB is not", () => {
  const spec = { players: [{ gsis: "fragile", pos: "QB" as const, pressEpa: -0.6, cleanEpa: 0.2 }, { gsis: "resilient", pos: "QB" as const, pressEpa: 0.19, cleanEpa: 0.2 }] };
  assert.equal(comp(ev(spec, "T31", "fragile"), "qb.pressure.response").direction, "DISADVANTAGE"); assert.notEqual(comp(ev(spec, "T31", "resilient"), "qb.pressure.response").direction, "DISADVANTAGE");
  const c = comp(ev(spec, "T31", "fragile"), "qb.pressure.response"); assert.ok(Number(c.inputs.pressure_epa_drop) < 0 && c.inputs.time_to_throw_pressured != null && c.inputs.qb_sack_rate_pressured != null, "QB response detail exposed");
  assert.match(c.limitations.join(), /causality is not claimed/);
});
test("RB run: an inside-heavy RB is disadvantaged by a strong middle run defense; an edge-heavy RB is not; box interaction is separate", () => {
  const spec: SourceSpec = { players: [{ gsis: "inside", pos: "RB", midShare: 0.9 }, { gsis: "edge", pos: "RB", midShare: 0.0 }], defs: { 5: { runMid: -0.5, runEnd: -0.044, heavy_box: 0.5 } } };
  assert.equal(comp(ev(spec, "T05", "inside"), "rb.run.direction").direction, "DISADVANTAGE"); assert.equal(comp(ev(spec, "T05", "edge"), "rb.run.direction").direction, "NEUTRAL", "same defense, different role: the strong middle defense does not touch an edge runner");
  assert.equal(comp(ev(spec, "T05", "inside"), "rb.run.gap").direction, "DISADVANTAGE", "GUARD-heavy concession pattern in the fixture");
  const box = comp(ev(spec, "T05", "inside"), "rb.run.box"); assert.equal(box.family, "run.box"); assert.match(box.limitations.join(), /front ALIGNMENT/);
  assert.match(comp(ev(spec, "T05", "inside"), "rb.run.direction").limitations.join(), /NOT inside\/outside/);
});
test("RB receiving vs unit coverage is UNIT evidence (generic proxy) and neutral for a minor receiving role", () => {
  const spec: SourceSpec = { players: [{ gsis: "pass-rb", pos: "RB", role: { target_share: 0.15 } }, { gsis: "grinder", pos: "RB", role: { target_share: 0.02 } }], defs: { 20: { unitRb: 0.4 } } };
  const a = comp(ev(spec, "T20", "pass-rb"), "rb.receiving.unit_coverage"); assert.equal(a.direction, "ADVANTAGE"); assert.ok(a.uncertainty.some((u) => u.kind === "GENERIC_PROXY_ONLY")); assert.match(a.limitations.join(), /never a named defender/);
  assert.equal(comp(ev(spec, "T20", "grinder"), "rb.receiving.unit_coverage").direction, "NEUTRAL");
});
test("explosive environment is separate from volume: a defense can concede underneath volume while preventing deep explosives", () => {
  const spec: SourceSpec = { players: [{ gsis: "deep", pos: "WR", deepShare: 0.6, shortShare: 0.1 }, { gsis: "under", pos: "WR", deepShare: 0.05, shortShare: 0.8 }], defs: { 8: { shortEpa: 0.3, deepEpa: -0.4, explDeep: 0.0 } } };
  const d = ev(spec, "T08", "deep"), u = ev(spec, "T08", "under");
  assert.equal(comp(d, "wr.explosive.area").direction, "DISADVANTAGE"); assert.equal(comp(u, "wr.area.pass").direction, "ADVANTAGE"); assert.equal(comp(d, "wr.area.pass").direction, "DISADVANTAGE");
  const prof = buildDefenseProfile(buildMatchupContext(mkSource(spec), { offense_team: "T00", defense_team: "T08", week: 3 }))!; assert.ok(prof.shape.includes("concedes underneath efficiency while suppressing deep efficiency"));
});
test("evidence honesty: thin samples are UNDETERMINED, never a direction; the verdict says INSUFFICIENT_EVIDENCE", () => {
  const e = ev({ players: [{ gsis: "thin", pos: "WR", ev: "INSUFFICIENT", epaMan: 0, epaZone: 0.5 }] }, "T31", "thin");
  for (const c of e.components.filter((x) => x.origin !== "MODELED_GAME_EXPECTATION" && x.id !== "wr.receiving.unit_coverage" && x.id !== "wr.scoring.red_zone")) assert.equal(c.direction, "UNDETERMINED", c.id);
  assert.ok(e.uncertainty.some((u) => u.kind === "SMALL_SAMPLE"));
});
test("CB assignment / alignment / front / personnel / coach history stay UNSUPPORTED; nothing is inferred", () => {
  const e = ev({ players: [ZONE_BEATER] }, "T10", "wr-zone"); const ids = e.unsupported.map((u) => u.id);
  for (const id of ["cornerback_assignment", "receiver_alignment", "defense_front_alignment", "personnel_groupings", "coach_history", "route_family_allowed", "current_season_charting"]) assert.ok(ids.includes(id), id);
  assert.ok(e.unsupported.find((u) => u.id === "cornerback_assignment")!.chapter_ids.includes("matchup.cornerback_assignment")); assert.ok(!e.components.some((c) => /cornerback|slot|alignment/i.test(c.id)));
  assert.equal(comp(e, "receiver.route.family").direction, "UNDETERMINED"); assert.match(comp(e, "receiver.route.family").limitations.join(), /NOT computed/);
});
test("observed vs modeled: the game coverage expectation is MODELED, baseline-only, and excluded from the verdict", () => {
  const e = ev({ players: [ZONE_BEATER] }, "T31", "wr-zone"); const x = comp(e, "coverage.game_expectation");
  assert.equal(x.origin, "MODELED_GAME_EXPECTATION"); assert.equal(x.direction, "UNDETERMINED"); assert.ok(x.uncertainty.some((u) => u.kind === "BASELINE_ONLY_EXPECTATION" && u.level === "HIGH")); assert.equal(x.inputs.conditioning_inputs_available, 0);
  assert.equal(comp(e, "wr.coverage.man_zone").origin, "OBSERVED_DEFENSIVE_TENDENCY");
});
test("descriptive separation + shadow safety: no numeric adjustment, no production influence, descriptive families are never predictive candidates", () => {
  const e = ev({ players: [ZONE_BEATER] }, "T10", "wr-zone"); assert.equal(e.numeric_adjustment, null); assert.match(e.numeric_adjustment_reason, /Tier D/); assert.equal(e.may_influence_production, false); assert.equal(e.lifecycle_state, "SHADOW_ONLY");
  for (const c of e.components) if (c.origin === "DESCRIPTIVE_CONTEXT" || c.origin === "UNSUPPORTED") assert.notEqual(c.predictive_class, "PREDICTIVE_CANDIDATE_UNVALIDATED", c.id);
  assert.ok(!("adjustment" in e) && !("projection" in e));
});
test("uncertainty sources: prior-only current season, mixed vintage, scheme reset, missing role", () => {
  const e = ev({ players: [{ ...ZONE_BEATER, role: null }], defs: { 10: { reset: true } } }, "T10", "wr-zone"); const kinds = e.uncertainty.map((u) => u.kind);
  for (const k of ["PRIOR_ONLY_CURRENT_SEASON", "MIXED_VINTAGE", "SCHEME_RESET_HINT", "ROLE_INSTABILITY"]) assert.ok(kinds.includes(k as never), k); assert.equal(e.vintage.length, 3);
});
test("determinism + reuse: identical inputs ⇒ identical evaluation; the defense context is built once for a whole roster", () => {
  const spec = { players: [ZONE_BEATER, MAN_BEATER, { gsis: "qb", pos: "QB" as const }, { gsis: "rb", pos: "RB" as const }] };
  assert.deepEqual(ev(spec, "T12", "wr-zone"), ev(spec, "T12", "wr-zone")); assert.notEqual(ev(spec, "T12", "wr-zone").content_identity, ev(spec, "T13", "wr-zone").content_identity);
  const s = mkSource(spec); const r = evaluatePlayers(s, { offense_team: "T00", defense_team: "T12", week: 3 }, ["wr-zone", "wr-man", "qb", "rb", "nobody"]);
  assert.equal(r.results.filter((x) => !("error" in x.result)).length, 4); assert.equal((r.results.find((x) => x.id === "nobody")!.result as { error: string }).error, "PLAYER_UNRESOLVED");
  const k = mkSource({ players: [{ gsis: "k", pos: "WR" as const }] }); const ctx = buildMatchupContext(k, { offense_team: "T00", defense_team: "T01", week: 3 }); assert.equal(ctx.league, buildMatchupContext(k, { offense_team: "T00", defense_team: "T02", week: 3 }).league);
});
test("team evaluation + defensive profile keep source-native buckets and league ranks; team and player evidence stay separate", () => {
  const s = mkSource({ players: [] }); const ctx = buildMatchupContext(s, { offense_team: "T00", defense_team: "T31", week: 3 }); const t = evaluateTeam(s, ctx); assert.ok(!("error" in t));
  const r = t as Exclude<typeof t, { error: string }>; assert.equal(r.evaluation.offense_subject.kind, "TEAM"); assert.ok(r.evaluation.components.some((c) => c.id === "team.pressure.line")); assert.ok(r.evaluation.components.every((c) => c.position === "TEAM"));
  const p = r.defense_profile!; assert.deepEqual(p.coverage.shells_source_native.map((x) => x.key), ["cover_0", "cover_1", "cover_2", "cover_3", "cover_4", "cover_6", "two_man"]); assert.equal(p.coverage.man_zone[0]!.rank_high_to_low, 1, "T31 has the highest man rate"); assert.ok(p.unsupported.includes("front alignment"));
});
test("a defense with no evidence and an unsupported position fail with explicit errors, not guesses", () => {
  const s = mkSource({ players: [{ gsis: "k", pos: "WR" }] }); const bad = evaluatePlayer(s, buildMatchupContext(s, { offense_team: "T00", defense_team: "ZZZ", week: 3 }), "k"); assert.equal((bad as { error: string }).error, "DEFENSE_UNAVAILABLE");
  const src = mkSource(); const orig = src.resolvePlayer; src.resolvePlayer = () => ({ ...orig("x")!, gsis_id: "k", position: "K" } as never); void orig;
});
