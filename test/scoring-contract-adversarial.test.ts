/** Phase 6 — adversarial league fixtures (each breaks a casual assumption) and the double-counting audit: one statistical event -> one scoring treatment. */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { calculateFantasyPoints } from "@/lib/scoring/calculate";
import { materializeScoringEvents, deriveCompletedGameThresholdEvents } from "@/lib/scoring/derived-events";
import { leagueScoringContract, classifyScoringKey } from "@/lib/scoring/support-contract";
import { scoringFingerprint } from "@/lib/canonical/scoring-fingerprint";
import { SleeperWeeklyProjectionProvider } from "@/lib/weekly/projections/sleeper-weekly";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";

const CORE = { pass_yd: 0.04, pass_td: 4, pass_int: -1, rush_yd: 0.1, rush_td: 6, rec_yd: 0.1, rec_td: 6 };
const FIXTURES: Record<string, Record<string, number>> = {
  NO_PPR: { ...CORE, rec: 0 }, FULL_PPR: { ...CORE, rec: 1 }, HALF_PPR: { ...CORE, rec: 0.5 }, TE_PREMIUM: { ...CORE, rec: 1, bonus_rec_te: 0.5 },
  UNUSUAL_QB: { ...CORE, rec: 1, pass_td: 6, pass_int: -3, pass_cmp: 0.1, pass_inc: -0.1, pass_sack: -1 },
  RETURN_HEAVY: { ...CORE, rec: 1, kr_yd: 0.1, pr_yd: 0.1, st_td: 6 }, YARDAGE_BONUS: { ...CORE, rec: 1, bonus_rec_yd_100: 3, bonus_pass_yd_300: 3, bonus_rush_yd_100: 3 },
  TIERED_DST: { pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1, pts_allow_28_34: -1, pts_allow_35p: -4, sack: 1, int: 2, yds_allow_300_349: -1 },
  FLAT_FG: { fgm: 3, fgmiss: -1, xpm: 1, xpmiss: -1 }, DISTANCE_K: { fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50_59: 5, fgm_60p: 6, fgmiss_40_49: -1, xpm: 1 },
  IDP: { ...CORE, rec: 1, idp_tkl: 1, idp_sack: 4, tkl_solo: 1 },
};
const LINE = { pass_yd: 250, pass_td: 2, pass_int: 1, rush_yd: 20, rush_td: 0, rec: 5, rec_yd: 60, rec_td: 1 };

describe("adversarial leagues: identity, arithmetic, and honest support states", () => {
  it("every fixture has a distinct canonical fingerprint (no scoring-incompatible league can reuse another's identity)", () => {
    const fps = Object.entries(FIXTURES).map(([k, s]) => [k, scoringFingerprint(s)] as const); assert.equal(new Set(fps.map(([, f]) => f)).size, fps.length);
  });
  it("reception scoring family: no-PPR / half / full differ by exactly rec x 0.5 steps; TE premium is TE-only", () => {
    const p = (f: string, pos: string) => calculateFantasyPoints(materializeScoringEvents(LINE, { position: pos }).stats, FIXTURES[f]!).fantasy_points;
    assert.equal(p("NO_PPR", "WR"), 10 + 8 + 2 + 6 + 6 - 1); assert.equal(p("HALF_PPR", "WR") - p("NO_PPR", "WR"), 2.5); assert.equal(p("FULL_PPR", "WR") - p("HALF_PPR", "WR"), 2.5);
    assert.equal(p("TE_PREMIUM", "TE") - p("FULL_PPR", "TE"), 2.5); assert.equal(p("TE_PREMIUM", "WR"), p("FULL_PPR", "WR"));
  });
  it("unusual QB scoring: completions/incompletions/sacks are scored when supplied, exactly once", () => {
    const l = { ...LINE, pass_cmp: 20, pass_inc: 10, pass_sack: 2 }; const base = calculateFantasyPoints(l, FIXTURES.FULL_PPR!).fantasy_points; const qb = calculateFantasyPoints(l, FIXTURES.UNUSUAL_QB!).fantasy_points;
    assert.equal(Math.round((qb - base) * 100) / 100, Math.round((2 * 2 /* +2 per pass td */ - 2 * 1 /* int -3 vs -1 */ + 2 - 1 - 2) * 100) / 100);
  });
  it("same D/ST line under two tier systems differs only by the tiers (exact on a completed game)", () => {
    const g = { sack: 3, int: 1, pts_allow_14_20: 1, yds_allow_300_349: 1 }; const a = calculateFantasyPoints(g, FIXTURES.TIERED_DST!).fantasy_points; const b = calculateFantasyPoints(g, { ...FIXTURES.TIERED_DST!, pts_allow_14_20: 4 }).fantasy_points;
    assert.equal(a, 3 + 2 + 1 - 1); assert.equal(b - a, 3);
  });
  it("flat-FG vs distance-tiered kicking score the same made kick differently, and a distance rule the provider does not supply is not invented", () => {
    const k = { fgm_40_49: 1, fgm: 1, xpm: 2 }; assert.equal(calculateFantasyPoints(k, FIXTURES.FLAT_FG!).fantasy_points, 3 + 2); assert.equal(calculateFantasyPoints(k, FIXTURES.DISTANCE_K!).fantasy_points, 4 + 2);
    assert.equal(classifyScoringKey("fgm_50_59").classification, "PROVIDER_LIMITED"); assert.ok(classifyScoringKey("fgm_50_59").limitation.includes("absent from the weekly feed"));
  });
  it("contract states per fixture: thresholds unresolved for projections, tiers/K approximated & provider-limited, return DECISION_LAYER_MISSING, IDP unsupported", () => {
    const yb = leagueScoringContract(FIXTURES.YARDAGE_BONUS!); assert.deepEqual(yb.offense_rules_not_reaching_weekly_projection.sort(), ["bonus_pass_yd_300", "bonus_rec_yd_100", "bonus_rush_yd_100"]); assert.equal(yb.by_class.NONLINEAR_PROJECTION_UNRESOLVED, 3);
    const dst = leagueScoringContract(FIXTURES.TIERED_DST!); assert.equal(dst.by_class.PROVIDER_LIMITED, dst.active_rule_count); assert.ok(dst.approximations.length >= 5);
    const rh = leagueScoringContract(FIXTURES.RETURN_HEAVY!); assert.equal(rh.rules.find((r) => r.key === "kr_yd")!.classification, "DECISION_LAYER_MISSING"); assert.equal(rh.rules.find((r) => r.key === "rec")!.classification, "FULLY_PROPAGATED");
    const idp = leagueScoringContract(FIXTURES.IDP!); assert.equal(idp.by_class.UNSUPPORTED, 3, "idp_tkl, idp_sack, tkl_solo"); assert.equal(idp.rules.find((r) => r.key === "idp_sack")!.exact_vs_approximate, "NOT_PROJECTED");
    const kd = leagueScoringContract(FIXTURES.FLAT_FG!); assert.equal(kd.weekly_basis.k_dst, "PROVIDER_STANDARD_POINTS_NOT_LEAGUE_SPECIFIC");
  });
  it("PROVIDER PORTABILITY: Yahoo-style numeric stat ids are never silently mapped to Sleeper meanings — they are unrecognized/UNSUPPORTED", () => {
    const yahoo = { "4": 0.04, "5": 4, "6": -1, "11": 0.1, "12": 6 }; const c = leagueScoringContract(yahoo); assert.deepEqual(c.unrecognized_active_keys.sort(), ["11", "12", "4", "5", "6"]); assert.equal(c.by_class.UNSUPPORTED, 5);
    assert.notEqual(scoringFingerprint(yahoo), scoringFingerprint(FIXTURES.FULL_PPR!));
  });
});

describe("double-counting audit: one statistical event -> one defined scoring treatment", () => {
  const feed = (t: { mock: { method: typeof mock.method } }, rows: unknown[]) => t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => rows }) as unknown as Response);
  const run = async (raw_scoring: Record<string, number>) => new SleeperWeeklyProjectionProvider().getWeeklyProjections({ league: { league_slug: "l", season: 2026, raw_scoring, scoring_rules: [] }, week: 3, crosswalk: new PlayerCrosswalk(NoCrosswalk), canonical_player_ids: [], want_rest_of_season: false });
  const row = (id: string, pos: string, stats: Record<string, number>) => ({ player_id: id, team: "KC", opponent: "LV", week: 3, stats, player: { first_name: id, last_name: pos, position: pos, team: "KC" } });
  it("materialization is idempotent (applying it twice never accumulates a second event)", () => {
    for (const [stats, pos] of [[{ rec: 6, def_kr_yd: 80, pr_yd: 5 }, "TE"], [{ rec: 4, bonus_rec_wr: 4 }, "WR"], [{ rec: 3, def_kr_yd: 50 }, "RB"]] as const) { const once = materializeScoringEvents(stats, { position: pos }).stats; assert.deepEqual(materializeScoringEvents(once, { position: pos }).stats, once); }
  });
  it("provider precomputed totals never combine with component scoring for offense (pts_* ignored)", async (t) => {
    feed(t, [row("a", "WR", { rec: 5, rec_yd: 50, pts_ppr: 99, pts_std: 88, pts_half_ppr: 77 })]); const b = await run({ rec: 1, rec_yd: 0.1 }); assert.equal([...b.by_player.values()][0]!.projected_points, 10); mock.restoreAll();
  });
  it("K / D-ST: standard points are NOT summed with league event scoring (fallback is used alone, and flagged)", async (t) => {
    feed(t, [row("k", "K", { fgm: 2, xpm: 3, pts_std: 8.5 }), row("d", "DEF", { sack: 3, int: 1, pts_std: 7.25 })]); const b = await run({ fgm: 3, xpm: 1, sack: 1, int: 2 });
    const pts = [...b.by_player.values()].map((p) => p.projected_points).sort(); assert.deepEqual(pts, [7.25, 8.5]); assert.ok([...b.by_player.values()].every((p) => p.warnings.some((w) => w.startsWith("k_dst_uses_sleeper_standard_points")))); mock.restoreAll();
  });
  it("a distance-TD bonus is never derived on top of the base TD (no phantom bonus events)", () => {
    const m = materializeScoringEvents({ rec_td: 1, rec_yd: 55 }, { position: "WR" }).stats; assert.ok(!("rec_td_40p" in m) && !("rec_td_50p" in m)); assert.ok(!("rec_td_40p" in deriveCompletedGameThresholdEvents({ rec_td: 1, rec_yd: 55 })));
  });
  it("season-path TE premium is applied once (statLine + calculator), not once per consumer", async () => {
    const { statLineFromProjection } = await import("@/lib/projections/league"); const { EMPTY_STATS } = await import("@/lib/projections/schema");
    const line = statLineFromProjection({ stats: { ...EMPTY_STATS, rec: 70 }, position: "TE", availability: { expected_games: 17 } as never }); assert.equal(line.bonus_rec_te, 70); assert.equal(statLineFromProjection({ stats: { ...EMPTY_STATS, rec: 70 }, position: "WR", availability: { expected_games: 17 } as never }).bonus_rec_te, undefined);
  });
});
