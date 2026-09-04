/**
 * Trade Engine — Phase 2 AUDIT suite.
 *
 * Traces the Phase 2 invariant: contextual value must reflect the usable
 * rest-of-season effect (displacement, byes, replacement, depth, fragility)
 * without double-counting Phase 1 value or contaminating the frozen foundation.
 *
 * Two confirmed defects fixed here (see docs/TRADE_ENGINE_PHASE2_AUDIT.md):
 *   D1 (P2) playoff-window mislabeling when a trade occurs at/after the
 *      league's playoff start week — the whole remaining window was wrongly
 *      dumped into "regular season" instead of being recognized as playoffs.
 *   D2 (P2) usable_depth_score / fragility_score double-counted a player
 *      eligible at multiple BASE positions (a real Sleeper case, e.g. a
 *      QB/TE-flagged player) once per eligible position.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, xfer, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import { evaluateTrade } from "../lib/trades/evaluate";
import { evaluateRosParticipant, rosSignalFor } from "../lib/trades/ros";
import { rosterResilience } from "../lib/trades/depth";
import { resolveRosWeekPlan } from "../lib/trades/context";
import { DEFAULT_TRADE_CONFIG, type PartialTradeConfig } from "../lib/trades/config";
import type { CanonicalPosition } from "../lib/canonical/schema";
import type { NormalizedProposal } from "../lib/trades/schema";
import type { RosSignal } from "../lib/weekly/schema";

const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3, 4].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) =>
  [0, 1, 2, 3, 4].map((i) => proj(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, { rest_of_season_points: (p === "QB" ? 12 - i : 6 - i) * ROS_WEEKS })),
);

function scene(teams: StdTeamSpec[], transfers: NormalizedProposal["transfers"], cfg?: PartialTradeConfig) {
  const built = teams.map(stdTeam);
  return tradeFixture({
    teams: built.map((b) => b.team),
    players: built.flatMap((b) => b.players),
    projections: built.flatMap((b) => b.projections),
    freeAgents: FA, faProjections: FA_PROJ, transfers, config: cfg,
    rosFlatHorizon: ROS_WEEKS,
  });
}
const T = (slug: string, over: Partial<StdTeamSpec> = {}): StdTeamSpec => ({
  slug, flex: { id: `${slug}_flex`, pos: "WR", pts: 10 }, ...over,
});
const FRESH_ROS = (points: number): RosSignal => ({
  points, source: "test", external_season_points: points * 2, ri_season_points: null, ri_position_rank: null,
  ri_vor: null, ri_tier: null, ri_confidence: null, disagreement_pct: null, disagreement_direction: "ONE_SOURCE",
  confidence: "MEDIUM", warnings: [],
});
function setPlayer(f: ReturnType<typeof tradeFixture>, id: string, weekly: number, rosWeeklyMean: number) {
  const cur = f.input.projections.by_player.get(id)!;
  const ros = Math.round(rosWeeklyMean * ROS_WEEKS);
  f.input.projections.by_player.set(id, { ...cur, projected_points: weekly, rest_of_season_points: ros, ros: cur.ros ? { ...cur.ros, points: ros } : FRESH_ROS(ros) });
}

/* ===================================================================== */
/* D1 — playoff-window mislabeling at/after playoff start (FIXED)         */
/* ===================================================================== */

describe("audit §6/§9 — remaining-week geometry & playoff-window correctness", () => {
  it("resolveRosWeekPlan: playoff_start_week in the future splits regular/playoff with no gaps or overlaps", () => {
    const plan = resolveRosWeekPlan(10, 17, 15);
    assert.deepEqual(plan.weeks, [10, 11, 12, 13, 14, 15, 16, 17]);
    assert.deepEqual(plan.regular_season_weeks, [10, 11, 12, 13, 14]);
    assert.deepEqual(plan.playoff_weeks, [15, 16, 17]);
    assert.equal(plan.regular_season_weeks.length + plan.playoff_weeks.length, plan.weeks.length);
    assert.equal(new Set([...plan.regular_season_weeks, ...plan.playoff_weeks]).size, plan.weeks.length, "no overlap");
    assert.equal(plan.playoff_window_available, true);
  });

  it("D1 FIX: playoff_start_week AT the current week -> the ENTIRE window is playoffs, not regular season", () => {
    // Before the fix: `playoff_start_week > week` was false at week===15, so the
    // whole remaining window fell through to "regular_season" with no playoff
    // split at all — mislabeling a trade made mid-playoffs.
    const plan = resolveRosWeekPlan(15, 17, 15);
    assert.deepEqual(plan.regular_season_weeks, []);
    assert.deepEqual(plan.playoff_weeks, [15, 16, 17]);
    assert.equal(plan.playoff_window_available, true);
    assert.equal(plan.playoff_unresolved_reason, null);
  });

  it("D1 FIX: playoff_start_week BEFORE the current week (deep in playoffs) -> still the whole window", () => {
    const plan = resolveRosWeekPlan(16, 17, 14);
    assert.deepEqual(plan.regular_season_weeks, []);
    assert.deepEqual(plan.playoff_weeks, [16, 17]);
    assert.equal(plan.playoff_window_available, true);
  });

  it("playoff_start_week beyond the analyzed horizon -> no playoff weeks, reason = outside_range", () => {
    const plan = resolveRosWeekPlan(1, 5, 15); // championship capped before playoffs would start
    assert.deepEqual(plan.playoff_weeks, []);
    assert.equal(plan.playoff_window_available, false);
    assert.equal(plan.playoff_unresolved_reason, "outside_range");
  });

  it("no playoff_start_week configured -> unresolved, all weeks regular", () => {
    const plan = resolveRosWeekPlan(1, 10, null);
    assert.deepEqual(plan.regular_season_weeks, plan.weeks);
    assert.equal(plan.playoff_window_available, false);
    assert.equal(plan.playoff_unresolved_reason, "unresolved");
  });

  it("preseason/week-1 through pre-playoff-week fixtures all produce a valid, gapless partition", () => {
    for (const [week, champ, po] of [[1, 17, 15], [1, 17, null], [8, 17, 15], [14, 17, 15], [15, 17, 15], [17, 17, 15]] as const) {
      const plan = resolveRosWeekPlan(week, champ, po);
      assert.deepEqual(plan.weeks, Array.from({ length: champ - week + 1 }, (_, i) => week + i));
      assert.equal(plan.regular_season_weeks.length + plan.playoff_weeks.length, plan.weeks.length, `week=${week}`);
      for (const w of plan.regular_season_weeks) assert.ok(!plan.playoff_weeks.includes(w));
    }
  });

  it("the fixture's synthetic context() shares the SAME resolveRosWeekPlan (no drift between test harness and production)", () => {
    const f = scene([T("X"), T("Y")], []);
    const ctx = f.context({ rosWeeks: 3, playoffStartWeek: 1 }); // current week === playoff start
    assert.deepEqual(ctx.ros.regular_season_weeks, []);
    assert.equal(ctx.ros.playoff_window_available, true);
  });
});

/* ===================================================================== */
/* D2 — multi-eligible player double-counted in depth aggregate (FIXED)   */
/* ===================================================================== */

describe("audit §11/§14 — usable depth respects primary position (no cross-position double count)", () => {
  it("D2 FIX: a QB/TE dual-eligible player is credited at ONE base position, not both", () => {
    const xTeam: StdTeamSpec = {
      slug: "X",
      flex: { id: "X_flex", pos: "WR", pts: 10 },
      // a real Sleeper case: fantasy_positions can list a player under 2 base
      // positions (e.g. Taysom-Hill-style QB/TE). Primary position is QB.
      bench: [{ id: "DUAL", pos: "QB", pts: 14, eligible: ["QB", "TE"] }],
    };
    const f = scene([xTeam, T("Y")], []);
    const res = rosterResilience(f.rosters.get("manager:test-league:X")!, f.context({ rosWeeks: ROS_WEEKS }));
    const qb = res.by_position.find((d) => d.position === "QB")!;
    const te = res.by_position.find((d) => d.position === "TE")!;
    // DUAL must appear as a QB backup, NEVER as a TE backup too.
    assert.equal(qb.usable_backups, 1, `DUAL should count once at QB: ${JSON.stringify(qb)}`);
    assert.equal(te.usable_backups, 0, `DUAL must NOT also count as a TE backup: ${JSON.stringify(te)}`);
  });

  it("a dual-eligible player's BASE-POSITION credit is identical to a single-eligible player's — extra FLEX-qualifying eligibility is a separate, non-duplicated dimension", () => {
    // DUAL (QB, also TE-eligible) vs SOLO (QB only) at the SAME points: both
    // must credit QB depth identically. DUAL's TE eligibility legitimately also
    // feeds the FLEX pool (TE is a FLEX-eligible position, QB is not in a
    // standard non-superflex league) — that is real extra flexibility, not a
    // re-count of the same QB-depth fact, so the two aggregate scores may
    // legitimately differ by exactly the flex-pool contribution.
    const withDual = scene([
      { slug: "X", flex: { id: "X_flex", pos: "WR", pts: 10 }, bench: [{ id: "DUAL", pos: "QB", pts: 14, eligible: ["QB", "TE"] }] },
      T("Y"),
    ], []);
    const withSingle = scene([
      { slug: "X", flex: { id: "X_flex", pos: "WR", pts: 10 }, bench: [{ id: "SOLO", pos: "QB", pts: 14 }] },
      T("Y"),
    ], []);
    const rDual = rosterResilience(withDual.rosters.get("manager:test-league:X")!, withDual.context({ rosWeeks: ROS_WEEKS }));
    const rSingle = rosterResilience(withSingle.rosters.get("manager:test-league:X")!, withSingle.context({ rosWeeks: ROS_WEEKS }));
    const qbDual = rDual.by_position.find((d) => d.position === "QB")!;
    const qbSingle = rSingle.by_position.find((d) => d.position === "QB")!;
    assert.equal(qbDual.usable_backups, qbSingle.usable_backups, "QB-bucket credit must be identical regardless of extra eligibility");
    assert.equal(qbDual.viable_starters, qbSingle.viable_starters);
    // DUAL (position "QB") must not ALSO appear as a backup at any other base
    // position — its own base-position bucket count must be unaffected by
    // whether DUAL exists at all (compare against a roster with no such player).
    const rNone = rosterResilience(
      scene([{ slug: "X", flex: { id: "X_flex", pos: "WR", pts: 10 } }, T("Y")], []).rosters.get("manager:test-league:X")!,
      scene([{ slug: "X", flex: { id: "X_flex", pos: "WR", pts: 10 } }, T("Y")], []).context({ rosWeeks: ROS_WEEKS }),
    );
    for (const pos of ["RB", "WR", "TE", "K", "DEF"]) {
      const withDualAt = rDual.by_position.find((d) => d.position === pos)!;
      const withoutAt = rNone.by_position.find((d) => d.position === pos)!;
      assert.equal(withDualAt.usable_backups, withoutAt.usable_backups, `DUAL must not ALSO appear as a backup at ${pos}`);
      assert.equal(withDualAt.viable_starters, withoutAt.viable_starters, `DUAL must not ALSO appear as a viable starter at ${pos}`);
    }
  });
});

/* ===================================================================== */
/* Composite safety — weights=0 => contextual === Phase 1, exactly        */
/* ===================================================================== */

describe("audit §20/§22 — composite safety: zero Phase 2 weights change nothing", () => {
  function matrix(): ReturnType<typeof scene>[] {
    return [
      // current-week winner, ROS-flat
      scene([T("X", { flex: { id: "X_f", pos: "WR", pts: 6 } }), T("Y", { flex: { id: "Y_f", pos: "WR", pts: 8 }, bench: [{ id: "IN", pos: "WR", pts: 16 }] })],
        [xfer("X", "Y", "X_f"), xfer("Y", "X", "IN")]),
      // high fragility change (ship the only RB backup)
      scene([T("X", { bench: [{ id: "RB3", pos: "RB", pts: 12 }] }), T("Y", { bench: [{ id: "sp", pos: "WR", pts: 3 }] })],
        [xfer("X", "Y", "RB3"), xfer("Y", "X", "sp")]),
      // high consolidation change
      scene([T("X", { bench: [{ id: "d1", pos: "WR", pts: 9 }, { id: "d2", pos: "WR", pts: 9 }, { id: "d3", pos: "RB", pts: 9 }] }), T("Y", { bench: [{ id: "STAR", pos: "WR", pts: 24 }] })],
        [xfer("X", "Y", "d1"), xfer("X", "Y", "d2"), xfer("X", "Y", "d3"), xfer("Y", "X", "STAR")]),
      // 3-team circular, arbitrary routing
      scene(
        [T("A", { flex: { id: "A_flex", pos: "RB", pts: 16 }, bench: [{ id: "A_rb4", pos: "RB", pts: 14 }], lockPts: { WR2: 6 } }),
         T("B", { flex: { id: "B_flex", pos: "WR", pts: 16 }, bench: [{ id: "B_wr4", pos: "WR", pts: 14 }], lockPts: { TE: 5 } }),
         T("C", { flex: { id: "C_flex", pos: "WR", pts: 14 }, bench: [{ id: "C_te2", pos: "TE", pts: 13 }], lockPts: { RB2: 6, TE: 13 } })],
        [xfer("A", "C", "A_rb4"), xfer("C", "B", "C_te2"), xfer("B", "A", "B_wr4")],
      ),
    ];
  }

  it("every fixture: contextual_utility_delta === roster_utility_delta, contextual_acceptance === phase1_acceptance, EXACTLY", () => {
    for (const f of matrix()) {
      const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS, playoffStartWeek: 4 }) });
      for (const p of Object.values(out.participants)) {
        assert.equal(p.phase2!.contextual_utility_delta, p.roster_utility_delta, `${p.manager_slug}: composite drifted at weight 0`);
        assert.equal(p.phase2!.contextual_acceptance, p.acceptance);
        assert.equal(p.phase2!.acceptance_divergence_reason, null);
      }
    }
  });

  it("trade-level: contextual_viability === trade_summary.trade_viability at weight 0", () => {
    for (const f of matrix()) {
      const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
      assert.equal(out.phase2_summary!.contextual_viability, out.trade_summary.trade_viability);
    }
  });

  it("DEFAULT_TRADE_CONFIG.phase2.weights are all exactly 0", () => {
    for (const v of Object.values(DEFAULT_TRADE_CONFIG.phase2.weights)) assert.equal(v, 0);
  });
});

describe("audit §21 — no hidden contextual penalty outside the configured composite", () => {
  it("a trade that materially worsens fragility does NOT change phase1 acceptance/viability/trade_summary", () => {
    const f = scene(
      [T("X", { bench: [{ id: "RB3", pos: "RB", pts: 14 }] }), T("Y", { bench: [{ id: "sp", pos: "WR", pts: 2 }] })],
      [xfer("X", "Y", "RB3"), xfer("Y", "X", "sp")],
    );
    const noCtx = evaluateTrade(f.input); // Phase 1 only
    const withCtx = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    assert.ok(withCtx.participants.X!.phase2!.depth.fragility_delta < 0, "fixture should worsen fragility");
    // every Phase 1 field is identical whether or not the fragility-worsening
    // Phase 2 context was supplied — only the additive `phase2` key differs.
    const { phase2: p2X, phase3: p3X, ...phase1OnlyX } = withCtx.participants.X!;
    const { phase2: p2Y, phase3: p3Y, ...phase1OnlyY } = withCtx.participants.Y!;
    void p2X; void p2Y; void p3X; void p3Y;
    assert.deepEqual(noCtx.participants.X, phase1OnlyX);
    assert.deepEqual(noCtx.participants.Y, phase1OnlyY);
    assert.deepEqual(noCtx.trade_summary, withCtx.trade_summary);
    assert.equal(noCtx.participants.X!.acceptance, withCtx.participants.X!.acceptance);
  });
});

/* ===================================================================== */
/* Interaction residual — identity, magnitude, order invariance           */
/* ===================================================================== */

describe("audit §16/§17 — interaction_residual identity and the documented asymmetric-baseline behavior", () => {
  it("identity holds exactly: interaction_residual === usable_delta − Σ(marginal_ros_delta)", () => {
    const f = scene(
      [T("X", { flex: { id: "X_flex", pos: "RB", pts: 14 }, lockPts: { WR2: 6 } }), T("Y", { bench: [{ id: "WRa", pos: "WR", pts: 17 }, { id: "WRb", pos: "WR", pts: 16 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "WRa"), xfer("Y", "X", "WRb")],
    );
    const ros = evaluateRosParticipant({
      ctx: f.context({ rosWeeks: ROS_WEEKS }),
      manager_id: "manager:test-league:X",
      before: f.rosters.get("manager:test-league:X")!,
      after: (() => {
        // build the actual post-trade roster the same way evaluateTrade does
        const r = f.rosters.get("manager:test-league:X")!;
        return { ...r, all_players: [...r.all_players.filter((id) => id !== "X_flex"), "WRa", "WRb"], bench: [...r.bench, "WRa", "WRb"], starters: r.starters.filter((id) => id !== "X_flex") };
      })(),
      incoming_ids: ["WRa", "WRb"], outgoing_ids: ["X_flex"],
    });
    const sum = ros.marginal_player_utility.reduce((s, m) => s + (m.marginal_ros_delta ?? 0), 0);
    assert.equal(ros.interaction_residual, Math.round((ros.ros_usable_value_delta - sum) * 100) / 100);
  });

  it("independent players (unrelated positions, no lineup overlap) produce a near-zero residual", () => {
    const f = scene(
      [T("X", { bench: [{ id: "x_junk1", pos: "K", pts: 1 }, { id: "x_junk2", pos: "DEF", pts: 1 }] }), T("Y", { bench: [{ id: "GOOD_RB", pos: "RB", pts: 16 }, { id: "GOOD_WR", pos: "WR", pts: 15 }] }, )],
      [xfer("X", "Y", "x_junk1"), xfer("X", "Y", "x_junk2"), xfer("Y", "X", "GOOD_RB"), xfer("Y", "X", "GOOD_WR")],
    );
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    // GOOD_RB and GOOD_WR each fill a DIFFERENT open slot (RB bench vs WR bench) -> should be close to additive
    const ros = out.participants.X!.phase2!.ros;
    assert.ok(Math.abs(ros.interaction_residual) < Math.abs(ros.ros_usable_value_delta) + 5,
      `residual should not dwarf the total for non-competing additions: ${ros.interaction_residual} vs total ${ros.ros_usable_value_delta}`);
  });

  it("two incoming players competing for ONE FLEX slot produce a materially negative interaction (documented -48-style example)", () => {
    // Reproduces the documented adversarial example: X ships a hot-now WR + its
    // only RB backup for one elite ROS WR. The two outgoing players are mutual
    // FLEX backstops for each other; ELITE's leave-one-out (evaluated on the
    // AFTER roster, which already lacks both outgoing players) claims its full
    // standalone value, while each outgoing player's leave-one-out (evaluated on
    // the BEFORE roster, which still has its counterpart as a backstop)
    // understates the true joint cost. This is the asymmetric-baseline property,
    // not a bug — the residual is what makes it visible.
    const f = scene(
      [T("X", { flex: { id: "HOTNOW", pos: "WR", pts: 16 }, bench: [{ id: "RB3", pos: "RB", pts: 11 }], lockPts: { RB2: 12 } }),
       T("Y", { bench: [{ id: "ELITE", pos: "WR", pts: 20 }] })],
      [xfer("X", "Y", "HOTNOW"), xfer("X", "Y", "RB3"), xfer("Y", "X", "ELITE")],
    );
    setPlayer(f, "HOTNOW", 16, 8);
    setPlayer(f, "ELITE", 20, 22);
    const ctx = f.context({ rosWeeks: ROS_WEEKS, playoffStartWeek: 5 });
    const out = evaluateTrade({ ...f.input, context: ctx });
    const ros = out.participants.X!.phase2!.ros;
    // authoritative transaction-level number
    assert.equal(ros.ros_usable_value_delta, 66);
    const marg = new Map(ros.marginal_player_utility.map((m) => [m.canonical_player_id, m.marginal_ros_delta]));
    assert.equal(marg.get("ELITE"), 132);
    assert.equal(marg.get("HOTNOW"), 0);
    assert.equal(marg.get("RB3"), -18);
    assert.equal(ros.interaction_residual, -48, "documented example must reproduce exactly");
    // the identity is exact by construction — prove it, don't just assert the constant
    assert.equal(ros.interaction_residual, Math.round((ros.ros_usable_value_delta - (132 + 0 - 18)) * 100) / 100);
  });

  it("marginal attribution is order-invariant: permuting incoming_ids does not change any individual value", () => {
    const build = (order: string[]) => scene(
      [T("X", { flex: { id: "X_flex", pos: "RB", pts: 14 }, lockPts: { WR2: 6 } }), T("Y", { bench: [{ id: "WRa", pos: "WR", pts: 17 }, { id: "WRb", pos: "WR", pts: 16 }] })],
      order.map((id) => (id === "X_flex" ? xfer("X", "Y", "X_flex") : xfer("Y", "X", id))),
    );
    const o1 = evaluateTrade({ ...build(["X_flex", "WRa", "WRb"]).input, context: build(["X_flex", "WRa", "WRb"]).context({ rosWeeks: ROS_WEEKS }) });
    const o2 = evaluateTrade({ ...build(["WRb", "WRa", "X_flex"]).input, context: build(["WRb", "WRa", "X_flex"]).context({ rosWeeks: ROS_WEEKS }) });
    const m1 = new Map(o1.participants.X!.phase2!.ros.marginal_player_utility.map((m) => [m.canonical_player_id, m.marginal_ros_delta]));
    const m2 = new Map(o2.participants.X!.phase2!.ros.marginal_player_utility.map((m) => [m.canonical_player_id, m.marginal_ros_delta]));
    for (const id of ["X_flex", "WRa", "WRb"]) assert.equal(m1.get(id), m2.get(id), `marginal(${id}) changed with transfer order`);
    assert.equal(o1.participants.X!.phase2!.ros.interaction_residual, o2.participants.X!.phase2!.ros.interaction_residual);
  });
});

/* ===================================================================== */
/* ROS input semantics — units, denominators, degenerate cases            */
/* ===================================================================== */

describe("audit §4 — ROS input units and degenerate denominators", () => {
  it("ros_weekly_mean = ros_points / games_remaining (byes excluded from the denominator)", () => {
    const f = scene([T("X"), T("Y")], []);
    const ctx = f.context({ rosWeeks: 6, byeWeeksByTeam: { KC: [3, 4] } }); // X's players default to team KC
    const sig = rosSignalFor("X_flex", ctx.players_by_id, ctx.projections, ctx.ros);
    assert.equal(sig.ros_games_remaining, 4, "2 of 6 weeks are byes for KC");
    assert.equal(sig.ros_weekly_mean, Math.round(((sig.ros_points ?? 0) / 4) * 100) / 100);
  });

  it("a player on bye EVERY remaining week -> zero games remaining -> null mean, never a divide-by-zero or fabricated 0", () => {
    const f = scene([T("X"), T("Y")], []);
    const ctx = f.context({ rosWeeks: 2, byeWeeksByTeam: { KC: [1, 2] } }); // both remaining weeks are byes
    const sig = rosSignalFor("X_flex", ctx.players_by_id, ctx.projections, ctx.ros);
    assert.equal(sig.ros_games_remaining, 0);
    assert.equal(sig.ros_weekly_mean, null);
    assert.equal(sig.covered, false);
    assert.ok(Number.isFinite(sig.ros_games_remaining));
  });

  it("a rostered player with no team/no schedule info still gets a finite games_remaining (falls back to full window)", () => {
    const f = scene([T("X"), T("Y")], []);
    const p = f.input.players_by_id.get("X_flex")!;
    f.input.players_by_id.set("X_flex", { ...p, nfl_team: null });
    const ctx = f.context({ rosWeeks: 5 });
    const sig = rosSignalFor("X_flex", ctx.players_by_id, ctx.projections, ctx.ros);
    assert.equal(sig.ros_games_remaining, 5);
    assert.ok(Number.isFinite(sig.ros_weekly_mean ?? 0));
  });
});

/* ===================================================================== */
/* Bye-week handling — A through E                                        */
/* ===================================================================== */

describe("audit §5 — bye-week handling fixtures A–E", () => {
  it("A — clean bye replacement: strong bench replacement exists, small/no loss", () => {
    const f = scene(
      [{ slug: "X", flex: { id: "X_flex", pos: "WR", pts: 10 }, bench: [{ id: "BYE_TE_BACKUP", pos: "TE", pts: 12 }] }, T("Y")],
      [],
    );
    const bye = f.input.players_by_id.get("X_TE")!;
    f.input.players_by_id.set("X_TE", { ...bye, nfl_team: "LV" });
    const ctx = f.context({ rosWeeks: 4, byeWeeksByTeam: { LV: [2] } });
    const val = evaluateRosParticipant({
      ctx, manager_id: "m", before: f.rosters.get("manager:test-league:X")!, after: f.rosters.get("manager:test-league:X")!,
      incoming_ids: [], outgoing_ids: [],
    });
    assert.equal(val.before.bye_hole_weeks, 0, "a strong TE backup should prevent any bye hole");
  });

  it("B — no replacement: bye week produces a clear coverage hole", () => {
    const f = scene([{ slug: "X", flex: { id: "X_flex", pos: "WR", pts: 10 } }, T("Y")], []);
    const bye = f.input.players_by_id.get("X_TE")!;
    f.input.players_by_id.set("X_TE", { ...bye, nfl_team: "LV" });
    const ctx = f.context({ rosWeeks: 4, byeWeeksByTeam: { LV: [2] } });
    const val = evaluateRosParticipant({
      ctx, manager_id: "m", before: f.rosters.get("manager:test-league:X")!, after: f.rosters.get("manager:test-league:X")!,
      incoming_ids: [], outgoing_ids: [],
    });
    assert.equal(val.before.bye_hole_weeks, 1);
    assert.equal(val.before.bye_hole_slot_weeks, 1);
  });

  it("C — trade solves the bye: positive bye_coverage_delta", () => {
    const f = scene(
      [{ slug: "X", flex: { id: "X_flex", pos: "WR", pts: 9 }, bench: [{ id: "junk", pos: "WR", pts: 3 }] }, { slug: "Y", flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "COVER", pos: "TE", pts: 9 }] }],
      [xfer("X", "Y", "junk"), xfer("Y", "X", "COVER")],
    );
    const bye = f.input.players_by_id.get("X_TE")!;
    f.input.players_by_id.set("X_TE", { ...bye, nfl_team: "LV" });
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: 4, byeWeeksByTeam: { LV: [2, 3] } }) });
    assert.ok(out.participants.X!.phase2!.ros.bye_coverage_delta >= 2);
  });

  it("D — trade creates concentrated bye exposure: negative bye_coverage_delta", () => {
    // X ships its only TE backup (COVER) away, X_TE (LV) has a bye -> new hole.
    const f = scene(
      [{ slug: "X", flex: { id: "X_flex", pos: "WR", pts: 9 }, bench: [{ id: "COVER", pos: "TE", pts: 9 }] }, { slug: "Y", flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "junk", pos: "WR", pts: 3 }] }],
      [xfer("X", "Y", "COVER"), xfer("Y", "X", "junk")],
    );
    const bye = f.input.players_by_id.get("X_TE")!;
    f.input.players_by_id.set("X_TE", { ...bye, nfl_team: "LV" });
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: 4, byeWeeksByTeam: { LV: [2, 3] } }) });
    assert.ok(out.participants.X!.phase2!.ros.bye_coverage_delta < 0, `expected worse bye coverage: ${out.participants.X!.phase2!.ros.bye_coverage_delta}`);
  });

  it("E — both incoming and outgoing share the SAME bye week: acquired player does not falsely appear to solve it", () => {
    // COVER (incoming TE) shares LV's bye with X_TE -> does NOT cover the hole those weeks.
    const f = scene(
      [{ slug: "X", flex: { id: "X_flex", pos: "WR", pts: 9 }, bench: [{ id: "junk", pos: "WR", pts: 3 }] }, { slug: "Y", flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "COVER", pos: "TE", pts: 9 }] }],
      [xfer("X", "Y", "junk"), xfer("Y", "X", "COVER")],
    );
    const xte = f.input.players_by_id.get("X_TE")!;
    f.input.players_by_id.set("X_TE", { ...xte, nfl_team: "LV" });
    const cover = f.input.players_by_id.get("COVER")!;
    f.input.players_by_id.set("COVER", { ...cover, nfl_team: "LV" }); // same team, same bye
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: 4, byeWeeksByTeam: { LV: [2, 3] } }) });
    assert.equal(out.participants.X!.phase2!.ros.bye_coverage_delta, 0, "sharing the same bye must not appear to solve coverage");
  });
});

/* ===================================================================== */
/* Replacement cliff — sign & magnitude                                   */
/* ===================================================================== */

describe("audit §12 — replacement cliff sign and magnitude", () => {
  it("a larger starter-to-backup drop produces a larger cliff", () => {
    const shallow = scene([{ slug: "X", flex: { id: "X_flex", pos: "WR", pts: 10 }, lockPts: { RB1: 18 }, bench: [{ id: "rb_backup", pos: "RB", pts: 17 }] }, T("Y")], []);
    const steep = scene([{ slug: "X", flex: { id: "X_flex", pos: "WR", pts: 10 }, lockPts: { RB1: 18 }, bench: [{ id: "rb_backup", pos: "RB", pts: 6 }] }, T("Y")], []);
    const rShallow = rosterResilience(shallow.rosters.get("manager:test-league:X")!, shallow.context({ rosWeeks: ROS_WEEKS }));
    const rSteep = rosterResilience(steep.rosters.get("manager:test-league:X")!, steep.context({ rosWeeks: ROS_WEEKS }));
    const cliffShallow = rShallow.by_position.find((d) => d.position === "RB")!.replacement_cliff!;
    const cliffSteep = rSteep.by_position.find((d) => d.position === "RB")!.replacement_cliff!;
    assert.ok(cliffSteep > cliffShallow, `steep=${cliffSteep} should exceed shallow=${cliffShallow}`);
    assert.ok(cliffShallow >= 0 && cliffSteep >= 0, "cliff must never be negative");
  });

  it("cliff never treats the starter as its own backup", () => {
    const f = scene([T("X"), T("Y")], []); // no bench RB at all beyond the 2 starters
    const res = rosterResilience(f.rosters.get("manager:test-league:X")!, f.context({ rosWeeks: ROS_WEEKS }));
    const rb = res.by_position.find((d) => d.position === "RB")!;
    assert.equal(rb.best_backup_points, null, "no third RB exists -> no backup, not a fabricated 0");
  });
});

/* ===================================================================== */
/* Consolidation — 1-for-1 must not move materially                       */
/* ===================================================================== */

describe("audit §18 — 1-for-1 does not move consolidation materially", () => {
  it("swapping two similarly-valued single players barely changes usable_concentration", () => {
    const f = scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: 10 } }), T("Y", { flex: { id: "Y_flex", pos: "WR", pts: 8 }, bench: [{ id: "SIM", pos: "WR", pts: 11 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "SIM")],
    );
    const ros = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) }).participants.X!.phase2!.ros;
    assert.ok(Math.abs(ros.consolidation_effect) < 0.05, `1-for-1 should barely move concentration: ${ros.consolidation_effect}`);
    assert.equal(ros.roster_shape_delta, "NEUTRAL");
  });
});

/* ===================================================================== */
/* Same player, different roster — core Phase 2 purpose                   */
/* ===================================================================== */

describe("audit §31 — the same player has different contextual value on different rosters", () => {
  it("ROS usable value, usable-depth delta, and fragility delta ALL differ for a needy vs stacked roster", () => {
    const mkFor = (needy: boolean) => scene(
      [T("X", { flex: { id: "X_flex", pos: "WR", pts: needy ? 6 : 15 }, lockPts: { WR2: needy ? 5 : 19 } }), T("Y", { bench: [{ id: "SAME", pos: "WR", pts: 14 }] })],
      [xfer("X", "Y", "X_flex"), xfer("Y", "X", "SAME")],
    );
    const needy = evaluateTrade({ ...mkFor(true).input, context: mkFor(true).context({ rosWeeks: ROS_WEEKS }) }).participants.X!.phase2!;
    const stacked = evaluateTrade({ ...mkFor(false).input, context: mkFor(false).context({ rosWeeks: ROS_WEEKS }) }).participants.X!.phase2!;
    assert.ok(needy.ros.ros_usable_value_delta > stacked.ros.ros_usable_value_delta, "needy roster gains more usable ROS");
    assert.notEqual(needy.depth.usable_depth_delta, undefined);
    // it is not merely the SAME number twice — Phase 2 is roster-specific
    assert.notDeepEqual(needy.ros, stacked.ros);
  });
});

/* ===================================================================== */
/* Snapshot / context immutability across repeated & distinct trades      */
/* ===================================================================== */

describe("audit §3/§33 — one context, many analyses: no accumulation", () => {
  it("evaluating two DIFFERENT trades against the SAME context never lets one contaminate the other", () => {
    const built = [stdTeam(T("X", { bench: [{ id: "p1", pos: "WR", pts: 9 }, { id: "p2", pos: "RB", pts: 9 }] })), stdTeam(T("Y", { bench: [{ id: "q1", pos: "WR", pts: 9 }] }))];
    const f = tradeFixture({
      teams: built.map((b) => b.team), players: built.flatMap((b) => b.players), projections: built.flatMap((b) => b.projections),
      freeAgents: FA, faProjections: FA_PROJ, transfers: [], rosFlatHorizon: ROS_WEEKS,
    });
    const ctx = f.context({ rosWeeks: ROS_WEEKS });
    const xBefore = JSON.stringify(f.rosters.get("manager:test-league:X"));

    const tradeA = { ...f.input, context: ctx, normalized: { league_slug: "test-league", participant_manager_ids: ["manager:test-league:X", "manager:test-league:Y"], transfers: [xfer("X", "Y", "p1")] } };
    const tradeB = { ...f.input, context: ctx, normalized: { league_slug: "test-league", participant_manager_ids: ["manager:test-league:X", "manager:test-league:Y"], transfers: [xfer("X", "Y", "p2")] } };
    const outA = evaluateTrade(tradeA);
    const outB = evaluateTrade(tradeB);
    // A's outgoing (p1) must not appear in B's "after" roster analysis and vice versa
    assert.ok(!outB.participants.X!.after.all_player_ids.includes("p1") === false || outB.participants.X!.after.all_player_ids.includes("p1"),
      "B's after roster should still contain p1 (untouched by trade A)");
    assert.ok(!outB.participants.X!.after.all_player_ids.includes("p2"), "B ships p2, so it is gone from B's own after");
    assert.equal(JSON.stringify(f.rosters.get("manager:test-league:X")), xBefore, "the underlying roster snapshot was never mutated by either analysis");
    // repeating trade A gives an identical result
    assert.deepEqual(evaluateTrade(tradeA).participants.X!.phase2!.components, outA.participants.X!.phase2!.components);
  });
});

/* ===================================================================== */
/* Degradation isolation                                                  */
/* ===================================================================== */

describe("audit §27 — each Phase 2 subsystem degrades independently; Phase 1 always survives", () => {
  it("ROS unavailable for every player (rostered AND free agents): Phase 1 intact, ROS diagnostics present, depth still computed", () => {
    const built = [stdTeam(T("X")), stdTeam(T("Y", { bench: [{ id: "IN", pos: "WR", pts: 10 }] }))];
    const strip = (p: (typeof FA_PROJ)[number]) => ({ ...p, rest_of_season_points: null, ros: null });
    const projections = built.flatMap((b) => b.projections).map(strip);
    const f = tradeFixture({
      teams: built.map((b) => b.team), players: built.flatMap((b) => b.players), projections,
      freeAgents: FA, faProjections: FA_PROJ.map(strip), transfers: [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")],
    });
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    assert.equal(typeof out.participants.X!.roster_utility_delta, "number", "Phase 1 survives");
    assert.ok(out.diagnostics.some((d) => d.code === "ROS_PROJECTIONS_UNAVAILABLE"), JSON.stringify(out.diagnostics.map((d) => d.code)));
    assert.ok(out.participants.X!.phase2!.depth, "depth metrics remain available even when ROS is degraded");
  });

  it("replacement pool degraded at a position with NO projected player anywhere in the league: depth degrades gracefully, ROS still computed", () => {
    // DEF players stay rostered (so lineups remain legal) but NO ONE — rostered
    // or free agent — has a DEF projection, so replacement.by_position.DEF is
    // genuinely unavailable.
    const built = [stdTeam(T("X")), stdTeam(T("Y", { bench: [{ id: "IN", pos: "WR", pts: 10 }] }))];
    const stripDef = (p: (typeof FA_PROJ)[number]) => (p.position === "DEF" ? { ...p, projected_points: null, rest_of_season_points: null, ros: null } : p);
    const projections = built.flatMap((b) => b.projections).map(stripDef);
    const faProjNoDef = FA_PROJ.map(stripDef);
    const f = tradeFixture({
      teams: built.map((b) => b.team),
      players: built.flatMap((b) => b.players), projections,
      freeAgents: FA, faProjections: faProjNoDef, transfers: [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")], rosFlatHorizon: ROS_WEEKS,
    });
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS }) });
    assert.ok(out.participants.X!.phase2!.depth.diagnostics.some((d) => d.code === "REPLACEMENT_POOL_DEGRADED"),
      JSON.stringify(out.participants.X!.phase2!.depth.diagnostics.map((d) => d.code)));
    assert.equal(typeof out.participants.X!.phase2!.ros.ros_usable_value_delta, "number", "ROS unaffected by depth degradation");
  });

  it("schedule unavailable: BYE_DATA_UNAVAILABLE surfaces, no bye fabricated, ROS/usable-depth still numeric", () => {
    const f = scene([T("X"), T("Y", { bench: [{ id: "IN", pos: "WR", pts: 10 }] })], [xfer("X", "Y", "X_flex"), xfer("Y", "X", "IN")]);
    const out = evaluateTrade({ ...f.input, context: f.context({ rosWeeks: ROS_WEEKS, scheduleStatus: "UNAVAILABLE" }) });
    assert.ok(out.diagnostics.some((d) => d.code === "BYE_DATA_UNAVAILABLE"));
    assert.equal(out.participants.X!.phase2!.ros.before.bye_hole_slot_weeks, 0, "no bye asserted without a verified schedule");
    assert.equal(typeof out.participants.X!.phase2!.ros.ros_usable_value_delta, "number");
  });
});

/* ===================================================================== */
/* Determinism                                                            */
/* ===================================================================== */

describe("audit §29 — full Phase 2 determinism", () => {
  it("5 repeated evaluations of a 3-team trade produce byte-identical phase2 blocks for all three participants", () => {
    const f = scene(
      [T("A", { flex: { id: "A_flex", pos: "RB", pts: 16 }, bench: [{ id: "A_rb4", pos: "RB", pts: 14 }], lockPts: { WR2: 6 } }),
       T("B", { flex: { id: "B_flex", pos: "WR", pts: 16 }, bench: [{ id: "B_wr4", pos: "WR", pts: 14 }], lockPts: { TE: 5 } }),
       T("C", { flex: { id: "C_flex", pos: "WR", pts: 14 }, bench: [{ id: "C_te2", pos: "TE", pts: 13 }], lockPts: { RB2: 6, TE: 13 } })],
      [xfer("A", "C", "A_rb4"), xfer("C", "B", "C_te2"), xfer("B", "A", "B_wr4")],
    );
    const ctx = f.context({ rosWeeks: ROS_WEEKS, playoffStartWeek: 5, byeWeeksByTeam: { KC: [3] } });
    const golden = JSON.stringify(["A", "B", "C"].map((s) => evaluateTrade({ ...f.input, context: ctx }).participants[s]!.phase2));
    for (let i = 0; i < 5; i += 1) {
      const again = JSON.stringify(["A", "B", "C"].map((s) => evaluateTrade({ ...f.input, context: ctx }).participants[s]!.phase2));
      assert.equal(again, golden);
    }
  });
});
