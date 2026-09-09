/**
 * Competitive Trade Intelligence — Checkpoint D.5: horizon-aware permanent-trade
 * utility, ROS threat alignment, weakness-repair semantics.
 *
 * Deterministic. Unit-tests `evaluateTradeHorizons` with hand-built synthetic
 * baselines (precise control of immediate vs ROS), plus threat/weakness
 * integration. Covers spec §32–§44 and the §52 freeze gates.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import type { CanonicalPosition } from "../lib/canonical/schema";
import { evaluateTradeHorizons } from "../lib/trades/competitive/horizon";
import { buildOpponentImpact } from "../lib/trades/competitive/opponent-impact";
import { buildLeagueThreat } from "../lib/trades/competitive/threat";
import { resolveCompetitiveDConfig } from "../lib/trades/competitive/config";

/* ---- synthetic baseline + ctx ---- */

function mkParticipant(slug: string, o: {
  immediate: number;
  starterImmediate?: number;
  benchImmediate?: number;
  needImmediate?: number;
  rosUsableSeason: number;
  strandedBefore?: number;
  strandedAfter?: number;
  playoffWindow?: number | null;
  byeCoverage?: number;
  needChanges?: Array<{ position: string; before_severity: string; after_severity: string; kind: string }>;
  entered?: string[];
  left?: string[];
}) {
  return {
    manager_slug: slug,
    manager_id: slug,
    canonical_team_id: `team:${slug}`,
    before: {} as never,
    after: {} as never,
    starter_points_delta: o.starterImmediate ?? o.immediate,
    starter_points_delta_status: "RESOLVED" as const,
    starter_vor_delta: null,
    bench_value_delta: o.benchImmediate ?? 0,
    roster_utility_delta: o.immediate,
    roster_utility_components: { starter_points: o.starterImmediate ?? o.immediate, starter_vor: 0, bench_value: o.benchImmediate ?? 0, positional_need: o.needImmediate ?? 0 },
    positional_need_changes: (o.needChanges ?? []) as never,
    lineup_displacement: { entered_starting_lineup: o.entered ?? [], left_starting_lineup: o.left ?? [], moved_to_bench: [], bench_promotions: [] },
    acceptance: "NEUTRAL" as never,
    above_acceptance_floor: true,
    diagnostics: [],
    phase2: {
      ros: {
        before: { usable_ros_points: 0, regular_season_usable: 0, playoff_window_usable: 0, standalone_ros_points: 0, stranded_ros_points: o.strandedBefore ?? 0, bye_hole_slot_weeks: 0, bye_hole_weeks: 0, weekly_totals: [] },
        after: { usable_ros_points: 0, regular_season_usable: 0, playoff_window_usable: 0, standalone_ros_points: 0, stranded_ros_points: o.strandedAfter ?? 0, bye_hole_slot_weeks: 0, bye_hole_weeks: 0, weekly_totals: [] },
        ros_usable_value_delta: o.rosUsableSeason,
        regular_season_ros_delta: o.rosUsableSeason,
        playoff_window_delta: null,
        bye_coverage_delta: o.byeCoverage ?? 0,
        standalone_ros_swing: o.rosUsableSeason,
        marginal_player_utility: [],
        interaction_residual: 0,
        usable_concentration_before: 0,
        usable_concentration_after: 0,
        consolidation_effect: 0,
        roster_shape_delta: "NEUTRAL" as const,
        diagnostics: [],
      },
      depth: {} as never,
      components: { ros_usable_value: o.rosUsableSeason / 17, playoff_window: o.playoffWindow ?? null, bye_coverage: o.byeCoverage ?? 0, usable_depth: 0, roster_fragility: 0, replacement_context: 0 },
      contextual_utility_delta: o.immediate,
      contextual_acceptance: "NEUTRAL" as never,
      phase1_acceptance: "NEUTRAL" as never,
      acceptance_divergence_reason: null,
      diagnostics: [],
    },
  };
}

function mkCtx(players: Record<string, { position: string; rosPoints: number | null; avail?: number; riVor?: number | null; riRank?: number | null; disagree?: number | null }>, opts: { week?: number; rosWeeks?: number } = {}) {
  const byPlayer = new Map<string, unknown>();
  const byId = new Map<string, unknown>();
  for (const [id, p] of Object.entries(players)) {
    byPlayer.set(id, {
      canonical_player_id: id, projected_points: 10, expected_availability: p.avail ?? 1,
      rest_of_season_points: p.rosPoints,
      ros: p.rosPoints == null ? null : { points: p.rosPoints, ri_vor: p.riVor ?? null, ri_position_rank: p.riRank ?? null, disagreement_pct: p.disagree ?? null, external_season_points: p.rosPoints, ri_season_points: null, confidence: "MEDIUM" },
    });
    byId.set(id, { canonical_player_id: id, full_name: id, position: p.position });
  }
  const rosWeeks = opts.rosWeeks ?? 16;
  return {
    week: opts.week ?? 1,
    ros: { weeks: Array.from({ length: rosWeeks }, (_, i) => (opts.week ?? 1) + i), schedule_status: "READY", championship_week: 17 },
    projections: { by_player: byPlayer },
    players_by_id: byId,
  } as never;
}

function horizons(part: ReturnType<typeof mkParticipant>, ctx: ReturnType<typeof mkCtx>, incoming: string[], outgoing: string[]) {
  return evaluateTradeHorizons({
    baseline: { participants: { [part.manager_slug]: part } } as never,
    ctx,
    manager_slug: part.manager_slug,
    incoming_ids: incoming,
    outgoing_ids: outgoing,
  });
}

describe("Competitive Trade D.5 — horizon-aware permanent utility", () => {
  it("§32 — short-term loss / ROS gain ⇒ positive permanent utility, SHORT_TERM_LOSS_LONG_TERM_GAIN", () => {
    const part = mkParticipant("us", { immediate: -6, rosUsableSeason: 16 * 4 }); // −6 now, +4/wk ROS
    const ctx = mkCtx({ A: { position: "RB", rosPoints: 200 }, B: { position: "RB", rosPoints: 260 } });
    const h = horizons(part, ctx, ["B"], ["A"]);
    assert.ok(h.immediate.total_delta < 0);
    assert.ok(h.ros.total_delta > 0);
    assert.ok(h.permanent_trade_utility > 0, `permanent ${h.permanent_trade_utility}`);
    assert.equal(h.horizon_classification, "SHORT_TERM_LOSS_LONG_TERM_GAIN");
  });

  it("§33 — short-term gain / ROS loss ⇒ negative permanent utility, SHORT_TERM_GAIN_LONG_TERM_LOSS", () => {
    const part = mkParticipant("us", { immediate: 6, rosUsableSeason: -16 * 4 });
    const ctx = mkCtx({ A: { position: "RB", rosPoints: 260 }, B: { position: "RB", rosPoints: 200 } });
    const h = horizons(part, ctx, ["B"], ["A"]);
    assert.ok(h.permanent_trade_utility < 0);
    assert.equal(h.horizon_classification, "SHORT_TERM_GAIN_LONG_TERM_LOSS");
  });

  it("§34 — consistent gain", () => {
    const part = mkParticipant("us", { immediate: 3, rosUsableSeason: 16 * 3 });
    const h = horizons(part, mkCtx({ A: { position: "WR", rosPoints: 180 }, B: { position: "WR", rosPoints: 230 } }), ["B"], ["A"]);
    assert.equal(h.horizon_classification, "CONSISTENT_POSITIVE");
    assert.ok(h.permanent_trade_utility > 0);
  });

  it("§35 — consistent loss", () => {
    const part = mkParticipant("us", { immediate: -3, rosUsableSeason: -16 * 3 });
    const h = horizons(part, mkCtx({ A: { position: "WR", rosPoints: 230 }, B: { position: "WR", rosPoints: 180 } }), ["B"], ["A"]);
    assert.equal(h.horizon_classification, "CONSISTENT_NEGATIVE");
    assert.ok(h.permanent_trade_utility < 0);
  });

  it("§37 — expected-games reversal: higher per-game but fewer games loses to durable player", () => {
    // A: 260 ROS pts but 0.6 availability. B: 230 ROS pts, full availability.
    const part = mkParticipant("us", { immediate: 0, rosUsableSeason: 16 * 2 }); // ROS lineup math favors A slightly
    const withRisk = horizons(part, mkCtx({ A: { position: "RB", rosPoints: 260, avail: 0.6 }, B: { position: "RB", rosPoints: 230, avail: 1 } }), ["A"], ["B"]);
    const noRisk = horizons(part, mkCtx({ A: { position: "RB", rosPoints: 260, avail: 1 }, B: { position: "RB", rosPoints: 230, avail: 1 } }), ["A"], ["B"]);
    assert.ok(withRisk.ros.availability_delta < 0, "acquiring the injury-risk player is an availability drag");
    assert.ok(withRisk.permanent_trade_utility < noRisk.permanent_trade_utility);
  });

  it("§36 / §16 — roster-context reversal: higher individual ROS value, lower trade-level utility, explained", () => {
    // standalone swing strongly positive, but ros_usable_value_delta (roster context) negative
    const part = mkParticipant("us", { immediate: 1, rosUsableSeason: -16 * 2 });
    part.phase2!.ros.standalone_ros_swing = 40; // naive: incoming much better
    const h = horizons(part, mkCtx({ A: { position: "RB", rosPoints: 180 }, B: { position: "RB", rosPoints: 240 } }), ["B"], ["A"]);
    assert.ok(h.ros.standalone_ros_swing > 0, "naive swing favors the incoming player");
    assert.ok(h.ros.total_delta < 0, "but trade-level ROS utility is negative (redundancy / displacement)");
    assert.ok(h.reasons.join(" ").includes("ROS"));
  });

  it("RI ordinal sign conflict ⇒ REVIEW_REQUIRED + low confidence (the Rhamondre/Chuba case)", () => {
    const part = mkParticipant("us", { immediate: -4, rosUsableSeason: -16 }); // external ROS: slightly negative
    // RI: incoming ri_vor 50 vs outgoing 15 (RI loves the incoming), 45% disagreement
    const ctx = mkCtx({
      OUT: { position: "RB", rosPoints: 155, riVor: 15, riRank: 31, disagree: -0.45 },
      IN: { position: "RB", rosPoints: 135, riVor: 50, riRank: 15, disagree: -0.11 },
    });
    const h = horizons(part, ctx, ["IN"], ["OUT"]);
    assert.equal(h.ri_ordinal.sign_conflict, true);
    assert.ok(h.ri_ordinal.ri_vor_delta! > 0, "RI VOR favors the incoming player");
    assert.equal(h.horizon_classification, "REVIEW_REQUIRED");
    assert.ok(["LOW", "VERY_LOW"].includes(h.confidence));
  });

  it("§13/§44 — immediate and ROS remain separately inspectable; ROS dominates the blend", () => {
    const part = mkParticipant("us", { immediate: 8, rosUsableSeason: -16 * 5 });
    const h = horizons(part, mkCtx({ A: { position: "RB", rosPoints: 240 }, B: { position: "RB", rosPoints: 160 } }), ["B"], ["A"]);
    assert.equal(h.immediate.total_delta, 8);
    assert.ok(h.ros.total_delta < -3);
    assert.ok(h.permanent_trade_utility < 0, "a large ROS loss is not overridden by a current-week gain");
    assert.ok(h.ros_weight > h.immediate_weight);
  });

  it("§14 — season timing: immediate weight grows through the season but is capped", () => {
    const part = mkParticipant("us", { immediate: 4, rosUsableSeason: 16 * 1 });
    const w2 = horizons(part, mkCtx({ A: { position: "RB", rosPoints: 100 }, B: { position: "RB", rosPoints: 120 } }, { week: 2, rosWeeks: 16 }), ["B"], ["A"]);
    const w14 = horizons(part, mkCtx({ A: { position: "RB", rosPoints: 100 }, B: { position: "RB", rosPoints: 120 } }, { week: 14, rosWeeks: 4 }), ["B"], ["A"]);
    assert.ok(w14.immediate_weight > w2.immediate_weight);
    assert.ok(w14.immediate_weight <= 0.4 + 1e-9);
  });
});

describe("Competitive Trade D.5 — §44 monotonicity invariants", () => {
  const base = () => mkParticipant("us", { immediate: 0, rosUsableSeason: 0 });
  it("increasing ROS starter gain cannot reduce permanent trade utility", () => {
    const lo = evaluateTradeHorizons({ baseline: { participants: { us: { ...base(), phase2: { ...base().phase2!, ros: { ...base().phase2!.ros, ros_usable_value_delta: 16 } } } } } as never, ctx: mkCtx({}) as never, manager_slug: "us", incoming_ids: [], outgoing_ids: [] });
    const hi = evaluateTradeHorizons({ baseline: { participants: { us: { ...base(), phase2: { ...base().phase2!, ros: { ...base().phase2!.ros, ros_usable_value_delta: 64 } } } } } as never, ctx: mkCtx({}) as never, manager_slug: "us", incoming_ids: [], outgoing_ids: [] });
    assert.ok(hi.permanent_trade_utility >= lo.permanent_trade_utility);
  });
  it("a current-week gain alone cannot override a much larger ROS loss", () => {
    const p = mkParticipant("us", { immediate: 10, rosUsableSeason: -16 * 8 });
    const h = horizons(p, mkCtx({}) as never, [], []);
    assert.ok(h.permanent_trade_utility < 0);
  });
  it("immediate and ROS values remain separately inspectable", () => {
    const h = horizons(mkParticipant("us", { immediate: 5, rosUsableSeason: 32 }), mkCtx({}) as never, [], []);
    assert.equal(typeof h.immediate.total_delta, "number");
    assert.equal(typeof h.ros.total_delta, "number");
    assert.notEqual(h.immediate.total_delta, h.ros.total_delta);
  });
});

/* ---- weakness-repair semantics + ROS threat (integration) ---- */

const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) => [0, 1, 2, 3].map((i) => proj(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, { rest_of_season_points: (p === "QB" ? 12 - i : 6 - i) * ROS_WEEKS })));
const MID = (slug: string) => `manager:test-league:${slug}`;

function buildLeague(teams: StdTeamSpec[], week = 1) {
  const built = teams.map(stdTeam);
  const fix = tradeFixture({ teams: built.map((b) => b.team), players: built.flatMap((b) => b.players), projections: built.flatMap((b) => b.projections), freeAgents: FA, faProjections: FA_PROJ, transfers: [], rosFlatHorizon: ROS_WEEKS, teamCount: 12 });
  const ctx = fix.context({ rosWeeks: ROS_WEEKS });
  (ctx as { week: number }).week = week;
  return { fix, ctx };
}

describe("Competitive Trade D.5 — weakness-repair semantics (§18–§21, §39–§40)", () => {
  it("§39 — entering the optimal lineup with pre-trade need NONE ⇒ STARTER_UPGRADED, not a hole", () => {
    const fakeBaseline = {
      participants: {
        them: {
          manager_slug: "them", roster_utility_delta: 5, starter_points_delta: 5, bench_value_delta: 0,
          positional_need_changes: [{ position: "RB", before_severity: "strong", after_severity: "strong", kind: "IMPROVES_NEED" }],
          lineup_displacement: { entered_starting_lineup: ["in1"], left_starting_lineup: [], moved_to_bench: [], bench_promotions: [] },
        },
      },
    } as never;
    const oi = buildOpponentImpact({ baseline: fakeBaseline, counterparty_slug: "them", counterparty_manager_id: "them", received_ids: ["in1"], players_by_id: new Map([["in1", { position: "RB" } as never]]) });
    assert.equal(oi.weakness_repair, "STARTER_UPGRADED");
    assert.ok(oi.reason_codes.includes("STARTER_UPGRADED"));
    assert.ok(!oi.reason_codes.includes("PREEXISTING_STARTER_HOLE_FILLED"));
  });

  it("§40 — pre-trade need CRITICAL resolved ⇒ CRITICAL_WEAKNESS_REPAIRED", () => {
    const fakeBaseline = {
      participants: {
        them: {
          manager_slug: "them", roster_utility_delta: 7, starter_points_delta: 7, bench_value_delta: 0,
          positional_need_changes: [{ position: "RB", before_severity: "critical", after_severity: "adequate", kind: "IMPROVES_NEED" }],
          lineup_displacement: { entered_starting_lineup: ["in1"], left_starting_lineup: [], moved_to_bench: [], bench_promotions: [] },
        },
      },
    } as never;
    const oi = buildOpponentImpact({ baseline: fakeBaseline, counterparty_slug: "them", counterparty_manager_id: "them", received_ids: ["in1"], players_by_id: new Map([["in1", { position: "RB" } as never]]) });
    assert.equal(oi.weakness_repair, "CRITICAL_WEAKNESS_REPAIRED");
  });

  it("§44 — worsening pre-trade need severity can only raise the weakness-repair classification", () => {
    const mk = (before: string) => {
      const b = { participants: { them: { manager_slug: "them", roster_utility_delta: 6, starter_points_delta: 6, bench_value_delta: 0, positional_need_changes: [{ position: "RB", before_severity: before, after_severity: "strong", kind: "IMPROVES_NEED" }], lineup_displacement: { entered_starting_lineup: ["in1"], left_starting_lineup: [], moved_to_bench: [], bench_promotions: [] } } } } as never;
      return buildOpponentImpact({ baseline: b, counterparty_slug: "them", counterparty_manager_id: "them", received_ids: ["in1"], players_by_id: new Map([["in1", { position: "RB" } as never]]) }).weakness_repair;
    };
    const rank: Record<string, number> = { STARTER_UPGRADED: 3, PREEXISTING_STARTER_HOLE_FILLED: 4, HIGH_NEED_REPAIRED: 5, CRITICAL_WEAKNESS_REPAIRED: 6 };
    assert.ok(rank[mk("weak")]! >= rank[mk("adequate")]!);
    assert.ok(rank[mk("critical")]! >= rank[mk("weak")]!);
  });
});

describe("Competitive Trade D.5 — ROS threat alignment (§22–§26, §41–§43)", () => {
  it("§41 — threat barely moves when only the current-week matchup changes", () => {
    const { ctx } = buildLeague([
      { slug: "a", flex: { id: "a_flex", pos: "RB", pts: 14 }, lockPts: { QB: 24, RB1: 20, RB2: 19, WR1: 19, WR2: 18, TE: 13 } },
      { slug: "b", flex: { id: "b_flex", pos: "RB", pts: 10 }, lockPts: { QB: 18, RB1: 14, RB2: 13, WR1: 13, WR2: 12, TE: 9 } },
    ]);
    const before = buildLeagueThreat(ctx, resolveCompetitiveDConfig(), MID("a")).by_manager.get(MID("a"))!;
    // simulate a monster current-week matchup for team a: quadruple every current-week projection
    for (const [, wp] of ctx.projections.by_player) {
      if ((wp as { projected_points: number | null }).projected_points != null) {
        (wp as { projected_points: number }).projected_points *= 4;
      }
    }
    const after = buildLeagueThreat(ctx, resolveCompetitiveDConfig(), MID("a")).by_manager.get(MID("a"))!;
    assert.ok(Math.abs(after.score - before.score) < 0.25, `threat moved ${(after.score - before.score).toFixed(2)} on a matchup-only change`);
    assert.equal(after.components.projected_strength_horizon, "ROS");
  });

  it("§26 — threat exposes its projected-strength horizon (no hidden temporal basis)", () => {
    const { ctx } = buildLeague([
      { slug: "a", flex: { id: "a_flex", pos: "RB", pts: 14 } },
      { slug: "b", flex: { id: "b_flex", pos: "RB", pts: 10 } },
    ]);
    const t = buildLeagueThreat(ctx, resolveCompetitiveDConfig(), MID("a")).by_manager.get(MID("a"))!;
    assert.ok(["ROS", "CURRENT_WEEK", "MIXED"].includes(t.components.projected_strength_horizon));
  });
});
