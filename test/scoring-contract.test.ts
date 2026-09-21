/**
 * Phase 6 — Fantasy Scoring Contract Completeness.
 * CATALOG COVERAGE != SCORING SUPPORT: these tests prove which rules actually reach valuation, that each event is scored exactly once, and that
 * limitations are explicit. Two configurations differing by ONE rule must differ by exactly that rule's contribution wherever it is supported.
 */
import { describe, it, test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateFantasyPoints } from "@/lib/scoring/calculate";
import { scoreWeeklyLine } from "@/lib/weekly/scoring";
import { deriveCompletedGameThresholdEvents, materializeScoringEvents } from "@/lib/scoring/derived-events";
import { SUPPORT_CLASSES, buildSupportMatrix, classifyScoringKey, countByClass, leagueScoringContract, allKnownScoringKeys } from "@/lib/scoring/support-contract";
import { SCORING_CATALOG } from "@/lib/scoring/catalog";
import { scoringFingerprint, scoringEquivalent } from "@/lib/canonical/scoring-fingerprint";
import { leagueScoringContext, translateStatsToLeague } from "@/lib/projections/league";
import { EMPTY_STATS } from "@/lib/projections/schema";
import { SleeperWeeklyProjectionProvider } from "@/lib/weekly/projections/sleeper-weekly";
import type { ReturnGameSeasonSignal } from "@/lib/weekly/return-game-weekly";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { evaluateWaiver2 } from "@/lib/waiver2";
import { buildWaiverContext } from "@/lib/waiver2/context";
import { mkWaiverInput, stdMine, type WaiverFixture } from "./fixtures/waiver2";
import observed from "@/lib/scoring/data/observed-provider-keys.json";

const LIVE = observed.live_league_scoring as Record<string, Record<string, number>>;
const pts = (stats: Record<string, number>, scoring: Record<string, number>, pos?: string) => calculateFantasyPoints(materializeScoringEvents(stats, { position: pos }).stats, scoring).fantasy_points;

describe("derived events: position-specific scoring (one authoritative place, exactly once)", () => {
  const tePremium = { rec: 1, rec_yd: 0.1, rec_td: 6, bonus_rec_te: 0.5 };
  const line = { rec: 6, rec_yd: 60, rec_td: 1 };
  it("identical line: TE earns the premium, WR does not, and without the rule TE == WR", () => {
    assert.equal(pts(line, tePremium, "TE"), 6 + 6 + 6 + 3, "TE: 6 rec + 60 yd*0.1 + TD + 0.5*6 receptions");
    assert.equal(pts(line, tePremium, "WR"), 6 + 6 + 6); assert.equal(pts(line, tePremium, "RB"), 18);
    const noPremium = { rec: 1, rec_yd: 0.1, rec_td: 6 }; assert.equal(pts(line, noPremium, "TE"), pts(line, noPremium, "WR"));
  });
  it("RB / WR reception bonuses apply only to their own position", () => {
    const s = { rec: 1, bonus_rec_rb: 0.5, bonus_rec_wr: 0.25 }; const l = { rec: 4 };
    assert.equal(pts(l, s, "RB"), 4 + 2); assert.equal(pts(l, s, "WR"), 4 + 1); assert.equal(pts(l, s, "TE"), 4); assert.equal(pts(l, s, "QB"), 4);
  });
  it("NO DOUBLE COUNT: a provider-supplied bonus key is kept, never re-derived on top", () => {
    const provided = { rec: 6, bonus_rec_te: 6 }; const m = materializeScoringEvents(provided, { position: "TE" });
    assert.equal(m.stats.bonus_rec_te, 6); assert.equal(m.notes[0]!.action, "PROVIDER_KEPT"); assert.equal(m.stats, provided, "no-op keeps the same reference");
    assert.equal(pts(provided, tePremium, "TE"), 6 + 3, "bonus counted exactly once");
    assert.equal(materializeScoringEvents({ rec: 6, bonus_rec_te: 6 }, { position: "TE" }).notes.filter((n) => n.action === "DERIVED").length, 0);
  });
  it("a zero-reception line derives nothing; an unknown position derives nothing", () => {
    assert.equal(materializeScoringEvents({ rec: 0 }, { position: "TE" }).notes.length, 0); assert.equal(materializeScoringEvents({ rec: 5 }, { position: null }).stats.bonus_rec_te, undefined);
  });
});

describe("derived events: whole-game thresholds — exact on completed games, never on projections", () => {
  const rec = { rec_yd: 0.1, bonus_rec_yd_100: 3, bonus_rec_yd_200: 2 }; const pass = { pass_yd: 0.04, bonus_pass_yd_300: 3, bonus_pass_yd_400: 2 };
  const done = (l: Record<string, number>, s: Record<string, number>) => calculateFantasyPoints(deriveCompletedGameThresholdEvents(l), s).fantasy_points;
  it("99 / 100 / 101 receiving yards: inclusive >= boundary, then stacking at 200", () => {
    assert.equal(done({ rec_yd: 99 }, rec), 9.9); assert.equal(done({ rec_yd: 100 }, rec), 13); assert.equal(done({ rec_yd: 101 }, rec), 13.1); assert.equal(done({ rec_yd: 200 }, rec), 20 + 3 + 2);
  });
  it("299 / 300 / 400 passing yards: 300 bonus at 300, both tiers stack at 400", () => {
    assert.equal(done({ pass_yd: 299 }, pass), 11.96); assert.equal(done({ pass_yd: 300 }, pass), 12 + 3); assert.equal(done({ pass_yd: 400 }, pass), 16 + 3 + 2);
  });
  it("combined rush+rec 100 stacks with the single-stat flags", () => {
    const s = { rush_yd: 0.1, rec_yd: 0.1, bonus_rush_rec_yd_100: 5, bonus_rush_yd_100: 3 }; assert.equal(done({ rush_yd: 60, rec_yd: 40 }, s), 10 + 5); assert.equal(done({ rush_yd: 100, rec_yd: 10 }, s), 11 + 5 + 3);
  });
  it("a provider-published flag is never overwritten (Sleeper's award is authoritative, incl. its one 244-yd anomaly)", () => {
    assert.equal(deriveCompletedGameThresholdEvents({ rush_yd: 244, bonus_rush_yd_100: 0 }).bonus_rush_yd_100, 0);
  });
  it("PROJECTION HONESTY: a projected 101-yard mean is NOT treated as an observed 100-yard game", () => {
    const projected = scoreWeeklyLine({ rec_yd: 101, rec: 6 }, { rec_yd: 0.1, rec: 1, bonus_rec_yd_100: 3 }).points; assert.equal(projected, 16.1, "linear part only; no threshold bonus is invented");
    for (const k of ["bonus_rec_yd_100", "bonus_pass_yd_300", "bonus_rush_yd_200"]) assert.equal(classifyScoringKey(k).classification, "NONLINEAR_PROJECTION_UNRESOLVED");
  });
});

describe("negative and zero scoring are data, not 'unavailable'", () => {
  it("negative interception / sack / fumble / missed-kick lines score negative", () => {
    const s = { pass_int: -2, pass_sack: -1, fum_lost: -2, fgmiss: -1 }; assert.equal(scoreWeeklyLine({ pass_int: 1.5, pass_sack: 2, fum_lost: 0.2 }, s).points, -3 - 2 - 0.4); assert.ok(scoreWeeklyLine({ fgmiss: 1 }, s).points < 0);
  });
  it("a real zero line scores 0 (not null) through the weekly provider, status 'projected'", async (t) => {
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => [{ player_id: "z1", team: "SEA", opponent: "SF", week: 3, stats: { rec: 0, rec_yd: 0 }, player: { first_name: "Zero", last_name: "Line", position: "WR", team: "SEA" } }] }) as unknown as Response);
    const b = await new SleeperWeeklyProjectionProvider().getWeeklyProjections({ league: { league_slug: "l", season: 2026, raw_scoring: { rec: 1, rec_yd: 0.1 }, scoring_rules: [] }, week: 3, crosswalk: new PlayerCrosswalk(NoCrosswalk), canonical_player_ids: [], want_rest_of_season: false });
    const p = [...b.by_player.values()][0]!; assert.equal(p.projected_points, 0); assert.equal(p.projection_status, "projected"); mock.restoreAll();
  });
});

describe("D-1 return yards: namespace-correct, provider-first, never priced twice", () => {
  const BLOODLINE_RET = { rec: 0.5, rec_yd: 0.1, kr_yd: 0.04, def_kr_yd: 0.04, pr_yd: 0.04 };
  const RAW = [{ player_id: "ret1", team: "DAL", opponent: "NYG", week: 3, stats: { rec: 2, rec_yd: 20, def_kr_yd: 80, def_kr_td: 0.05, pr_yd: 10 }, player: { first_name: "Kick", last_name: "Returner", position: "WR", team: "DAL" } },
    { player_id: "d1", team: "DAL", opponent: "NYG", week: 3, stats: { sack: 3, int: 1, def_kr_yd: 100, def_pr_yd: 50, pts_std: 8 }, player: { first_name: "Dallas", last_name: "Defense", position: "DEF", team: "DAL" } }];
  const SEASON = new Map<string, ReturnGameSeasonSignal>([["ret1", { kr_yd: 340, pr_yd: null }]]);
  const run = async (t: { mock: { method: typeof mock.method } }, raw_scoring: Record<string, number>) => {
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => RAW }) as unknown as Response);
    const b = await new SleeperWeeklyProjectionProvider().getWeeklyProjections({ league: { league_slug: "l", season: 2026, raw_scoring, scoring_rules: [] }, week: 3, crosswalk: new PlayerCrosswalk(NoCrosswalk), canonical_player_ids: [], want_rest_of_season: false, return_game_season: SEASON });
    const by = (n: string) => [...b.by_player.values()].find((p) => b.resolved_players.get(p.canonical_player_id)?.full_name === n)!; mock.restoreAll(); return by;
  };
  it("league scoring BOTH kr_yd and def_kr_yd (Bloodline): the returner's 80 yards are priced once, and the season-model enrichment does not stack", async (t) => {
    const r = (await run(t, BLOODLINE_RET))("Kick Returner"); assert.equal(r.projected_points, 6.6, "0.5*2 + 0.1*20 + 0.04*80 (once) + 0.04*10");
    assert.ok(!r.warnings.some((w) => w.includes("weekly_kr_yd_enrichment")), "provider-first: a provider kick-return projection suppresses enrichment");
  });
  it("league scoring ONLY kr_yd: the provider's own per-game number is used (not the season-model substitute)", async (t) => {
    const r = (await run(t, { rec: 0.5, rec_yd: 0.1, kr_yd: 0.04 }))("Kick Returner"); assert.equal(r.projected_points, 6.2);
  });
  it("league scoring ONLY the team-defense rule def_kr_yd: an individual offensive player earns nothing from it", async (t) => {
    const r = (await run(t, { rec: 0.5, rec_yd: 0.1, def_kr_yd: 0.04 }))("Kick Returner"); assert.equal(r.projected_points, 3, "receiving only");
  });
  it("return-disabled league: identical line, no return points (return scoring is the ONLY difference)", async (t) => {
    const on = (await run(t, BLOODLINE_RET))("Kick Returner").projected_points!; const off = (await run(t, { rec: 0.5, rec_yd: 0.1 }))("Kick Returner").projected_points!;
    assert.equal(Math.round((on - off) * 100) / 100, 3.6, "difference == 0.04*(80 kr + 10 pr)");
  });
  it("team defense rows are untouched by the offensive namespace rule", () => { const m = materializeScoringEvents({ def_kr_yd: 100, def_pr_yd: 50 }, { position: "DEF" }); assert.deepEqual(m.stats, { def_kr_yd: 100, def_pr_yd: 50 }); });
});

describe("weekly provider: position bonuses exactly once, provider-first", () => {
  const league = (raw_scoring: Record<string, number>) => ({ league_slug: "l", season: 2026, raw_scoring, scoring_rules: [] });
  const feed = (t: { mock: { method: typeof mock.method } }, rows: unknown[]) => t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => rows }) as unknown as Response);
  const row = (id: string, pos: string, stats: Record<string, number>) => ({ player_id: id, team: "KC", opponent: "LV", week: 3, stats, player: { first_name: id, last_name: pos, position: pos, team: "KC" } });
  it("TE without a provider premium key is derived; WR with the identical line is not; provider-supplied key is not doubled", async (t) => {
    feed(t, [row("te", "TE", { rec: 5, rec_yd: 50 }), row("wr", "WR", { rec: 5, rec_yd: 50 }), row("te2", "TE", { rec: 5, rec_yd: 50, bonus_rec_te: 5 })]);
    const b = await new SleeperWeeklyProjectionProvider().getWeeklyProjections({ league: league({ rec: 1, rec_yd: 0.1, bonus_rec_te: 0.5 }), week: 3, crosswalk: new PlayerCrosswalk(NoCrosswalk), canonical_player_ids: [], want_rest_of_season: false });
    const get = (n: string) => [...b.by_player.values()].find((p) => b.resolved_players.get(p.canonical_player_id)?.full_name?.startsWith(n))!;
    assert.equal(get("te ").projected_points, 5 + 5 + 2.5); assert.equal(get("wr ").projected_points, 10); assert.equal(get("te2").projected_points, 12.5, "exactly once"); mock.restoreAll();
  });
});

describe("season/draft/trade projection path (D-2): TE premium now reaches league points", () => {
  const avail = { expected_games: 17 } as never; const stats = { ...EMPTY_STATS, rec: 80, rec_yd: 800, rec_td: 6, targets: 110 };
  const ctx = (s: Record<string, number>) => leagueScoringContext("l", "1", s);
  it("same football line, same player: premium league differs by exactly 0.5 x receptions; WR unchanged; non-premium identical to before", () => {
    const base = { rec: 1, rec_yd: 0.1, rec_td: 6 }; const prem = { ...base, bonus_rec_te: 0.5 };
    const te0 = translateStatsToLeague({ stats, position: "TE", availability: avail }, ctx(base)).league_points; const te1 = translateStatsToLeague({ stats, position: "TE", availability: avail }, ctx(prem)).league_points;
    const wr0 = translateStatsToLeague({ stats, position: "WR", availability: avail }, ctx(base)).league_points; const wr1 = translateStatsToLeague({ stats, position: "WR", availability: avail }, ctx(prem)).league_points;
    assert.equal(Math.round((te1 - te0) * 100) / 100, 40); assert.equal(wr1, wr0); assert.equal(te0, wr0);
  });
});

describe("Waiver 2.0 (D-3): opportunity is priced by position through the canonical scoring contract", () => {
  const OTHERS: WaiverFixture["others"] = [{ id: "3", players: [{ id: "o1", pos: "WR", pts: 9, team: "GB" }, { id: "o3", pos: "RB", pts: 12, team: "GB" }] }];
  const role = { tRecent: 0.32, tSeason: 0.2, conf: "HIGH" as const, trend: "EXPANDING" as const };
  const fx = (raw_scoring: Record<string, number>): WaiverFixture => ({ mine: stdMine(), others: OTHERS, freeAgents: [{ id: "fte", pos: "TE", pts: 9, team: "CHI", ros: 120 }, { id: "fwr", pos: "WR", pts: 9, team: "CHI", ros: 120 }], roles: { fte: role, fwr: role }, raw_scoring });
  const act = (ev: ReturnType<typeof evaluateWaiver2>, id: string) => ev.actions.find((a) => a.candidate?.player_id === id)!;
  const BASE = { rec: 1, rec_yd: 0.1, rush_yd: 0.1, rec_td: 6, rush_td: 6 };
  it("ppoFor: a TE target is worth 0.5 x rec-per-target more only in a TE-premium league; other positions and the neutral baseline are unchanged", () => {
    const c = buildWaiverContext(mkWaiverInput(fx({ ...BASE, bonus_rec_te: 0.5 }))); const n = buildWaiverContext(mkWaiverInput(fx(BASE)));
    assert.equal(Math.round((c.ppoFor("TE").target - n.ppoFor("TE").target) * 1000) / 1000, 0.33, "0.5 x 0.66 receptions per target"); assert.equal(c.ppoFor("WR").target, n.ppoFor("WR").target); assert.equal(c.ppo.target, n.ppo.target);
    assert.equal(c.ppoFor("TE").carry, n.ppoFor("TE").carry, "carries unaffected");
  });
  it("PROOF OF PATH: same role growth, TE vs WR — the TE's waiver role value rises only under TE premium (mathematically = share delta x volume x premium)", () => {
    const prem = evaluateWaiver2(mkWaiverInput(fx({ ...BASE, bonus_rec_te: 0.5 }))); const base = evaluateWaiver2(mkWaiverInput(fx(BASE)));
    const teP = act(prem, "fte").candidate_asset!.role.role_delta_points, teB = act(base, "fte").candidate_asset!.role.role_delta_points, wrP = act(prem, "fwr").candidate_asset!.role.role_delta_points, wrB = act(base, "fwr").candidate_asset!.role.role_delta_points;
    assert.ok(teP > teB, `TE role value ${teP} vs ${teB}`); assert.equal(wrP, wrB, "WR unaffected by a TE-only rule"); assert.equal(teB, wrB, "without the rule TE == WR");
    assert.notEqual(prem.scoring_fingerprint, base.scoring_fingerprint);
  });
});

describe("scoring fingerprint integrity (one authoritative identity)", () => {
  const base = { rec: 1, rec_yd: 0.1, pass_td: 4, bonus_rec_te: 0.5 };
  it("key order, explicit zero vs absent, and numeric serialization noise do not change identity", () => {
    assert.equal(scoringFingerprint({ b: 1, a: 2 }), scoringFingerprint({ a: 2, b: 1 })); assert.equal(scoringFingerprint({ rec: 0, pass_td: 4 }), scoringFingerprint({ pass_td: 4 })); assert.equal(scoringFingerprint({ x: 1 }), scoringFingerprint({ x: 1.0000000001 }));
  });
  it("every meaningful change alters it: position bonus, return, defensive tier, IDP, threshold, rec value", () => {
    const fp = scoringFingerprint(base);
    for (const [k, v] of [["bonus_rec_te", 0.75], ["kr_yd", 0.04], ["pts_allow_14_20", 1], ["idp_tkl", 1], ["bonus_rec_yd_100", 3], ["rec", 0.5], ["bonus_rec_wr", 0.5]] as const) assert.notEqual(scoringFingerprint({ ...base, [k]: v }), fp, k);
    assert.ok(/^scoring:v1:[0-9a-f]{24}$/.test(fp)); assert.equal(scoringEquivalent(base, { ...base, kr_yd: 0 }), true);
  });
  it("the canonical fingerprint is the identity carried by the league scoring context (legacy hash is scoped, not authoritative)", () => {
    const c = leagueScoringContext("l", "1", base); assert.equal(c.scoring_fingerprint, scoringFingerprint(base)); assert.match(c.scoring_hash, /^sha_/); assert.notEqual(c.scoring_hash, c.scoring_fingerprint);
  });
});

describe("support contract: every rule has an explicit state; catalog presence never implies support", () => {
  const matrix = buildSupportMatrix();
  it("every catalog key and every live-league key is classified with a valid class", () => {
    const keys = new Set(matrix.map((r) => r.key)); for (const k of Object.keys(SCORING_CATALOG)) assert.ok(keys.has(k), `catalog key ${k} missing from matrix`);
    for (const s of Object.values(LIVE)) for (const k of Object.keys(s)) assert.ok(keys.has(k), `live key ${k} missing`);
    for (const r of matrix) { assert.ok(SUPPORT_CLASSES.includes(r.classification), r.key); assert.ok(r.limitation !== undefined); }
    assert.equal(Object.values(countByClass(matrix)).reduce((a, b) => a + b, 0), matrix.length); assert.deepEqual(matrix.map((r) => r.key), allKnownScoringKeys());
  });
  it("family semantics: IDP unsupported; unknown key unsupported; thresholds nonlinear-unresolved; K/DST provider-limited; offense linear fully propagated", () => {
    for (const k of ["idp_tkl", "idp_sack", "tkl_solo", "qb_hit"]) assert.equal(classifyScoringKey(k).classification, "UNSUPPORTED", k);
    assert.equal(classifyScoringKey("totally_new_key_2027").classification, "UNSUPPORTED");
    for (const k of ["fgm", "fgm_40_49", "xpm", "pts_allow", "pts_allow_14_20", "yds_allow_300_349", "sack", "def_forced_punts", "int"]) assert.equal(classifyScoringKey(k).classification, "PROVIDER_LIMITED", k);
    for (const k of ["rec", "rec_yd", "rec_td", "pass_yd", "pass_int", "rush_yd", "bonus_rec_te", "fum_lost"]) assert.equal(classifyScoringKey(k).classification, "FULLY_PROPAGATED", k);
  });
  it("honest gaps: provider-supplied but not materialized downstream is DECISION_LAYER_MISSING (sacks, first downs, individual return yards)", () => {
    for (const k of ["pass_sack", "pass_int_td", "rec_fd", "rush_fd", "kr_yd", "pr_yd"]) assert.equal(classifyScoringKey(k).classification, "DECISION_LAYER_MISSING", k);
    assert.equal(classifyScoringKey("kr_yd").waiver_role_pricing, "DECISION_LAYER_MISSING"); assert.equal(classifyScoringKey("rec_td_40p").classification, "PROVIDER_LIMITED");
  });
  it("the checked-in machine-readable matrix is current", () => { assert.deepEqual(JSON.parse(readFileSync("docs/scoring-support-matrix.json", "utf8")).rules, JSON.parse(JSON.stringify(matrix))); });
  it("live league contracts: weekly K/DST is exposed as NOT league-specific; offense rules all reach the weekly projection", () => {
    for (const [slug, scoring] of Object.entries(LIVE)) {
      const c = leagueScoringContract(scoring); assert.equal(c.weekly_basis.k_dst, "PROVIDER_STANDARD_POINTS_NOT_LEAGUE_SPECIFIC"); assert.deepEqual(c.offense_rules_not_reaching_weekly_projection, [], slug); assert.equal(c.unrecognized_active_keys.length, 0, slug);
      assert.ok(c.k_dst_rules_not_reflected_in_weekly_values.length > 0, slug);
    }
    const bb = leagueScoringContract(LIVE["bloodline-bowl"]!); assert.ok(bb.k_dst_rules_not_reflected_in_weekly_values.includes("pts_allow")); assert.ok(bb.k_dst_rules_not_reflected_in_weekly_values.includes("def_forced_punts"));
    assert.ok(leagueScoringContract(LIVE["devoted-to-the-game"]!).approximations.some((a) => a.startsWith("pts_allow_")), "tiered D/ST season projection is declared an approximation");
    assert.notEqual(leagueScoringContract(LIVE["bloodline-bowl"]!).scoring_fingerprint, leagueScoringContract(LIVE["devoted-to-the-game"]!).scoring_fingerprint);
  });
});

test("architecture: calculateFantasyPoints stays the ONLY arithmetic authority (no second multiplier in derived-events or the contract)", () => {
  for (const f of ["lib/scoring/derived-events.ts", "lib/scoring/support-contract.ts"]) assert.doesNotMatch(readFileSync(f, "utf8"), /\*\s*(?:multiplier|rate|points_per)/, `${f} must not multiply by a scoring rate`);
});

describe("trade/ROS inputs: rest-of-season points (a trade-value input) reflect a TE premium exactly, WR unaffected", () => {
  it("same season line, premium vs base league: TE ROS differs by 0.5 x receptions x weeks-left fraction; WR identical", async (t) => {
    const rows = ["TE", "WR"].map((pos) => ({ player_id: pos, team: "KC", opponent: "LV", week: 3, stats: { rec: 80, rec_yd: 800, rec_td: 6 }, player: { first_name: pos, last_name: "P", position: pos, team: "KC" } }));
    const go = async (raw_scoring: Record<string, number>) => { t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => rows }) as unknown as Response); const b = await new SleeperWeeklyProjectionProvider().getWeeklyProjections({ league: { league_slug: "l", season: 2026, raw_scoring, scoring_rules: [] }, week: 3, crosswalk: new PlayerCrosswalk(NoCrosswalk), canonical_player_ids: [], want_rest_of_season: true }); mock.restoreAll(); const by = (n: string) => [...b.by_player.values()].find((p) => p.position === n)!; return { te: by("TE").rest_of_season_points!, wr: by("WR").rest_of_season_points! }; };
    const base = { rec: 1, rec_yd: 0.1, rec_td: 6 }; const a = await go(base), b = await go({ ...base, bonus_rec_te: 0.5 });
    const frac = 15 / 17; /* REGULAR_SEASON_WEEKS = 17; week 3 -> (17 - 2) / 17 */ assert.ok(Math.abs((b.te - a.te) - 40 * frac) < 0.02, `TE ROS delta ${b.te - a.te} vs ${40 * frac}`); assert.equal(b.wr, a.wr); assert.equal(a.te, a.wr);
  });
});
