/**
 * Competitive Trade Intelligence — Checkpoint D: opponent actual impact, rival
 * threat, competitive externality, selfish trade ranking.
 *
 * Deterministic. Unit-tests the pure scoring modules with hand-built inputs
 * (precise control of our gain / opponent delta / threat band / weakness
 * repair / acceptance) plus a full-pipeline test. Covers spec §12–§47 and the
 * §51 freeze gates.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import type { CanonicalPosition, CanonicalDraftPick } from "../lib/canonical/schema";
import { buildCompetitiveExternality } from "../lib/trades/competitive/externality";
import { buildCompetitiveResult } from "../lib/trades/competitive/competitive-result";
import { buildLeagueThreat } from "../lib/trades/competitive/threat";
import { buildOpponentImpact } from "../lib/trades/competitive/opponent-impact";
import { resolveCompetitiveDConfig } from "../lib/trades/competitive/config";
import type {
  AcceptanceEstimate,
  OpponentImpact,
  OpponentThreat,
  ThreatBand,
  WeaknessRepair,
} from "../lib/trades/competitive/schema";

const D = resolveCompetitiveDConfig();

function threat(band: ThreatBand, opts: Partial<OpponentThreat> = {}): OpponentThreat {
  return {
    owner_manager_id: "opp",
    score: band === "ELITE" ? 1.4 : band === "HIGH" ? 0.6 : band === "MODERATE" ? 0 : -0.8,
    band,
    components: { projected_strength_z: 0, projected_strength_horizon: "ROS", results_strength_z: null, results_weight: 0, blended_strength_z: 0, balance_penalty: 0 },
    league_strength_percentile: band === "ELITE" ? 0.95 : band === "HIGH" ? 0.7 : 0.4,
    relative_to_us: opts.relative_to_us ?? (band === "ELITE" ? 0.8 : 0),
    contender_band: band === "ELITE" ? "TOP_CONTENDER" : band === "HIGH" ? "CONTENDER" : "MID_TIER",
    readiness: "FULL_COMPETITIVE_CONTEXT",
    calibration_status: "HEURISTIC",
    reasons: [],
    ...opts,
  };
}

function impact(o: Partial<OpponentImpact> = {}): OpponentImpact {
  return {
    owner_manager_id: "opp",
    private_delta: 4,
    starter_delta: 4,
    bench_delta: 0,
    ros_delta: 0,
    fragility_delta: 0,
    needs_improved: [],
    needs_worsened: [],
    weakness_repair: "NONE",
    weakness_repair_positions: [],
    reason_codes: [],
    reasons: [],
    ...o,
  };
}

function result(args: {
  ourGain: number;
  oi?: Partial<OpponentImpact>;
  band?: ThreatBand;
  threatOpts?: Partial<OpponentThreat>;
  acceptance?: AcceptanceEstimate["likelihood"];
  edge?: number | null;
}) {
  const th = threat(args.band ?? "MODERATE", args.threatOpts);
  const oi = impact(args.oi);
  const ext = buildCompetitiveExternality({ opponent_impact: oi, threat: th, config: D });
  return buildCompetitiveResult({
    our_private_gain: args.ourGain,
    market_net_actionable_edge: args.edge ?? null,
    acceptance_likelihood: (args.acceptance ?? "MODERATE"),
    acceptance_confidence: "MEDIUM",
    externality: ext,
    threat: th,
    owner_perception_confidence: "MEDIUM",
    readiness: "FULL_COMPETITIVE_CONTEXT",
    config: D,
  });
}

describe("Competitive Trade D — externality & competitive result", () => {
  it("§12 — weak opponent: a penalty exists but the trade can still rank well", () => {
    const r = result({ ourGain: 10, oi: { private_delta: 5, starter_delta: 5 }, band: "LOW" });
    assert.ok(r.components.competitive_externality > 0, "externality is a positive cost");
    assert.ok(r.score > D.result.classification_thresholds.buy, `still ranks well (${r.score})`);
    assert.ok(["STRONG_COMPETITIVE_BUY", "COMPETITIVE_BUY"].includes(r.classification));
  });

  it("§13 — elite rival + critical weakness repaired: larger penalty, lower desirability", () => {
    const weak = result({ ourGain: 10, oi: { private_delta: 5, starter_delta: 5 }, band: "LOW" });
    const elite = result({ ourGain: 10, oi: { private_delta: 5, starter_delta: 5, weakness_repair: "CRITICAL_WEAKNESS_REPAIRED" }, band: "ELITE", threatOpts: { relative_to_us: 0.9 } });
    assert.ok(elite.components.competitive_externality > weak.components.competitive_externality);
    assert.ok(elite.score < weak.score);
  });

  it("§14/§32/§46 — opponent loses value ⇒ favorable externality, strong competitive result", () => {
    const r = result({ ourGain: 9, oi: { private_delta: -3, starter_delta: -3 }, band: "MODERATE", acceptance: "MODERATE" });
    assert.ok(r.components.competitive_externality < 0, "externality is negative (favorable)");
    assert.ok(r.score > 9, "score exceeds raw our-gain because we also weakened them");
    assert.ok(r.reason_codes.includes("OPPONENT_ACTUALLY_WEAKENED"));
    assert.ok(["STRONG_COMPETITIVE_BUY", "COMPETITIVE_BUY"].includes(r.classification));
  });

  it("§15/§30 — overwhelming our gain: modest elite-rival improvement cannot swamp it", () => {
    const r = result({ ourGain: 20, oi: { private_delta: 3, starter_delta: 3 }, band: "ELITE", threatOpts: { relative_to_us: 0.8 } });
    assert.equal(r.classification, "STRONG_COMPETITIVE_BUY");
    assert.ok(r.reason_codes.includes("OUR_GAIN_DOMINATES_EXTERNALITY"));
  });

  it("§31 — weak our gain + large elite-rival improvement ⇒ avoid / reject", () => {
    const r = result({ ourGain: 2, oi: { private_delta: 6, starter_delta: 6, weakness_repair: "CRITICAL_WEAKNESS_REPAIRED" }, band: "ELITE", threatOpts: { relative_to_us: 1.0 } });
    assert.ok(["AVOID_COMPETITIVE_COST", "REJECT", "MARGINAL"].includes(r.classification), `got ${r.classification} score ${r.score}`);
    assert.ok(r.score < D.result.classification_thresholds.acceptable);
  });

  it("§28 — same trade, different opponent: identical our-gain/edge/acceptance, different desirability", () => {
    const vsLow = result({ ourGain: 8, oi: { private_delta: 4, starter_delta: 4 }, band: "LOW" });
    const vsElite = result({ ourGain: 8, oi: { private_delta: 4, starter_delta: 4 }, band: "ELITE", threatOpts: { relative_to_us: 0.7 } });
    assert.notEqual(vsLow.score, vsElite.score);
    assert.ok(vsLow.score > vsElite.score);
  });

  it("§4/§47 — opponent bench-only gain costs less than equal starter gain", () => {
    const starter = result({ ourGain: 8, oi: { private_delta: 5, starter_delta: 5, bench_delta: 0 }, band: "HIGH" });
    const bench = result({ ourGain: 8, oi: { private_delta: 5, starter_delta: 0, bench_delta: 5 }, band: "HIGH" });
    assert.ok(bench.components.competitive_externality < starter.components.competitive_externality);
  });

  it("§29/§45 — fixing a starting hole costs more than reinforcing a surplus (equal raw delta)", () => {
    const hole = buildCompetitiveExternality({ opponent_impact: impact({ private_delta: 5, starter_delta: 5, weakness_repair: "CRITICAL_WEAKNESS_REPAIRED" }), threat: threat("HIGH"), config: D });
    const surplus = buildCompetitiveExternality({ opponent_impact: impact({ private_delta: 5, starter_delta: 5, weakness_repair: "SURPLUS_REINFORCED" }), threat: threat("HIGH"), config: D });
    assert.ok(hole.score > surplus.score * 2);
  });

  it("§33 — acceptance below threshold: not actionable, classification capped at MARGINAL", () => {
    const r = result({ ourGain: 20, oi: { private_delta: -5, starter_delta: -5 }, band: "MODERATE", acceptance: "VERY_LOW" });
    assert.equal(r.actionable, false);
    assert.ok(["MARGINAL", "REJECT", "AVOID_COMPETITIVE_COST"].includes(r.classification));
    assert.ok(r.reason_codes.includes("ACCEPTANCE_BELOW_THRESHOLD"));
  });

  it("§18 — the result is a decomposable staged flow", () => {
    const r = result({ ourGain: 6, oi: { private_delta: 3, starter_delta: 3 }, band: "MODERATE" });
    const stages = r.gate_trace.map((g) => g.stage);
    assert.deepEqual(stages, ["readiness", "our_gain", "acceptance_feasibility", "score"]);
    assert.ok("our_private_gain" in r.components && "competitive_externality" in r.components);
  });
});

describe("Competitive Trade D — §47 monotonicity invariants", () => {
  it("increasing our private gain cannot reduce competitive desirability", () => {
    const lo = result({ ourGain: 4, oi: { private_delta: 3, starter_delta: 3 }, band: "MODERATE" });
    const hi = result({ ourGain: 10, oi: { private_delta: 3, starter_delta: 3 }, band: "MODERATE" });
    assert.ok(hi.score >= lo.score);
  });
  it("increasing opponent actual gain cannot improve competitive desirability", () => {
    const lo = result({ ourGain: 8, oi: { private_delta: 2, starter_delta: 2 }, band: "HIGH" });
    const hi = result({ ourGain: 8, oi: { private_delta: 8, starter_delta: 8 }, band: "HIGH" });
    assert.ok(hi.score <= lo.score);
  });
  it("increasing opponent threat cannot reduce the externality", () => {
    const mod = buildCompetitiveExternality({ opponent_impact: impact({ private_delta: 5, starter_delta: 5 }), threat: threat("MODERATE"), config: D });
    const elite = buildCompetitiveExternality({ opponent_impact: impact({ private_delta: 5, starter_delta: 5 }), threat: threat("ELITE"), config: D });
    assert.ok(elite.score >= mod.score);
  });
  it("repairing a larger weakness cannot reduce the externality", () => {
    const order: WeaknessRepair[] = ["SURPLUS_REINFORCED", "DEPTH_IMPROVED", "PREEXISTING_STARTER_HOLE_FILLED", "HIGH_NEED_REPAIRED", "CRITICAL_WEAKNESS_REPAIRED"];
    const scores = order.map((wr) => buildCompetitiveExternality({ opponent_impact: impact({ private_delta: 5, starter_delta: 5, weakness_repair: wr }), threat: threat("HIGH"), config: D }).score);
    for (let i = 1; i < scores.length; i += 1) assert.ok(scores[i]! >= scores[i - 1]!, `${order[i]} >= ${order[i - 1]}`);
  });
  it("negative opponent delta never produces a positive competitive penalty", () => {
    const e = buildCompetitiveExternality({ opponent_impact: impact({ private_delta: -4, starter_delta: -4 }), threat: threat("ELITE"), config: D });
    assert.ok(e.score <= 0);
  });
  it("stronger relative opponent position cannot reduce threat-adjusted externality", () => {
    const near = buildCompetitiveExternality({ opponent_impact: impact({ private_delta: 5, starter_delta: 5 }), threat: threat("HIGH", { relative_to_us: 0 }), config: D });
    const above = buildCompetitiveExternality({ opponent_impact: impact({ private_delta: 5, starter_delta: 5 }), threat: threat("HIGH", { relative_to_us: 1.0 }), config: D });
    assert.ok(above.score >= near.score);
  });
  it("raising acceptance from VERY_LOW to MODERATE improves actionability but not the raw value score", () => {
    const lo = result({ ourGain: 8, oi: { private_delta: -3, starter_delta: -3 }, band: "MODERATE", acceptance: "VERY_LOW" });
    const hi = result({ ourGain: 8, oi: { private_delta: -3, starter_delta: -3 }, band: "MODERATE", acceptance: "MODERATE" });
    assert.equal(lo.actionable, false);
    assert.equal(hi.actionable, true);
    assert.ok(Math.abs(hi.score - lo.score) < 1e-6, "score is unchanged by acceptance — it's a feasibility gate");
  });
});

/* ---------------- integration: threat + opponent impact via fixtures ---------------- */

const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) => [0, 1, 2, 3].map((i) => proj(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, { rest_of_season_points: (p === "QB" ? 12 - i : 6 - i) * ROS_WEEKS })));
const MID = (slug: string) => `manager:test-league:${slug}`;

function dp(manager: string, pid: string, round: number, pick: number): CanonicalDraftPick {
  return { canonical_draft_pick_id: `dp:${pid}`, canonical_league_id: "league:test-league", season: 2026, round, pick_number: pick, draft_slot: 1, canonical_team_id: null, canonical_manager_id: MID(manager), canonical_player_id: pid, auction_amount: null, is_keeper: false, provenance: { provider: "sleeper", provider_id: pid, provider_synced_at: null } };
}

function buildLeague(teams: StdTeamSpec[], week = 1, standings?: Array<{ slug: string; wins: number; losses: number; pf: number }>) {
  const built = teams.map(stdTeam);
  const fix = tradeFixture({
    teams: built.map((b) => b.team), players: built.flatMap((b) => b.players), projections: built.flatMap((b) => b.projections),
    freeAgents: FA, faProjections: FA_PROJ, transfers: [], rosFlatHorizon: ROS_WEEKS, teamCount: 12,
  });
  const ctx = fix.context({ rosWeeks: ROS_WEEKS });
  (ctx as { week: number }).week = week;
  if (standings) {
    ctx.snapshot.standings = standings.map((s, i) => {
      const team = ctx.snapshot.teams.find((t) => t.canonical_manager_ids.includes(MID(s.slug)))!;
      return { canonical_team_id: team.canonical_team_id, rank: i + 1, wins: s.wins, losses: s.losses, ties: 0, win_percentage: s.wins / (s.wins + s.losses), points_for: s.pf, points_against: 0, games_played: s.wins + s.losses, playoff_seed: null };
    });
  }
  return { fix, ctx };
}

describe("Competitive Trade D — threat model (integration)", () => {
  it("§41 — week 1: threat is projected roster strength only; 0-0 record contributes nothing", () => {
    const { ctx } = buildLeague([
      { slug: "strong", flex: { id: "s_flex", pos: "RB", pts: 16 }, lockPts: { QB: 30, RB1: 24, RB2: 22, WR1: 22, WR2: 21, TE: 16 } },
      { slug: "weak", flex: { id: "w_flex", pos: "RB", pts: 6 }, lockPts: { QB: 14, RB1: 8, RB2: 7, WR1: 8, WR2: 7, TE: 6 } },
    ], 1);
    const lt = buildLeagueThreat(ctx, D, MID("strong"));
    const strong = lt.by_manager.get(MID("strong"))!;
    const weak = lt.by_manager.get(MID("weak"))!;
    assert.equal(strong.components.results_weight, 0);
    assert.equal(strong.components.results_strength_z, null);
    assert.ok(strong.score > weak.score, "projected-strong team is the bigger threat");
    assert.ok(strong.reasons.some((r) => r.toLowerCase().includes("0-0") || r.toLowerCase().includes("week 1")));
  });

  it("§42/§43/§44 — week 8: current results shift threat without fully overriding projection", () => {
    const { ctx } = buildLeague(
      [
        { slug: "a", flex: { id: "a_flex", pos: "RB", pts: 14 }, lockPts: { QB: 26, RB1: 22, RB2: 20, WR1: 21, WR2: 20, TE: 14 } },
        { slug: "b", flex: { id: "b_flex", pos: "RB", pts: 14 }, lockPts: { QB: 26, RB1: 22, RB2: 20, WR1: 21, WR2: 20, TE: 14 } },
        { slug: "lucky", flex: { id: "l_flex", pos: "RB", pts: 6 }, lockPts: { QB: 13, RB1: 8, RB2: 7, WR1: 8, WR2: 7, TE: 6 } },
      ],
      8,
      [
        { slug: "a", wins: 6, losses: 2, pf: 1000 },
        { slug: "b", wins: 2, losses: 6, pf: 700 },
        { slug: "lucky", wins: 5, losses: 3, pf: 640 }, // fluky: good record, weak roster + low PF
      ],
    );
    const lt = buildLeagueThreat(ctx, D, MID("a"));
    const a = lt.by_manager.get(MID("a"))!;
    const b = lt.by_manager.get(MID("b"))!;
    const lucky = lt.by_manager.get(MID("lucky"))!;
    assert.ok(a.components.results_weight > 0 && a.components.results_weight <= D.threat.results_weight_cap);
    assert.ok(a.score > b.score, "6-2 strong roster > 2-6 identical roster");
    // §43 fluky record: not automatically the top threat despite 5-3
    assert.ok(lucky.score < a.score, "lucky team's weak roster + low PF keeps threat below the real contender");
    // §44 underperforming contender b still meaningful
    assert.ok(b.band !== "LOW" || b.components.projected_strength_z > 0);
  });
});

describe("Competitive Trade D — full pipeline via evaluateCompetitiveTrade", () => {
  it("attaches opponent_impact / opponent_threat / competitive_externality / competitive_result with a counterparty; absent without", async () => {
    const { evaluateCompetitiveTrade } = await import("../lib/trades/competitive/evaluate");
    const { evaluateTrade } = await import("../lib/trades/evaluate");
    const { resolveTradeConfig } = await import("../lib/trades/config");
    const { ctx } = buildLeague([
      { slug: "alpha", flex: { id: "alpha_flexwr", pos: "WR", pts: 11 }, bench: [{ id: "alpha_rb3", pos: "RB", pts: 11 }], lockPts: { RB1: 6, RB2: 5 } },
      { slug: "bravo", flex: { id: "bravo_rb", pos: "RB", pts: 15 }, bench: [{ id: "bravo_wr3", pos: "WR", pts: 4 }], lockPts: { WR1: 8, WR2: 7 } },
    ], 1);
    ctx.snapshot.draft_picks.push(dp("alpha", "alpha_rb3", 9, 100), dp("bravo", "bravo_rb", 3, 28));
    const norm = {
      league_slug: "test-league", participant_manager_ids: [MID("alpha"), MID("bravo")],
      transfers: [
        { from_manager_id: MID("alpha"), to_manager_id: MID("bravo"), canonical_player_id: "alpha_rb3", input_player_id: "alpha_rb3" },
        { from_manager_id: MID("bravo"), to_manager_id: MID("alpha"), canonical_player_id: "bravo_rb", input_player_id: "bravo_rb" },
      ],
    };
    const participants = [
      { manager: ctx.snapshot.managers.find((m) => m.manager_slug === "alpha")! as never, team: ctx.snapshot.teams[0]! as never, roster: ctx.rosters_by_manager.get(MID("alpha"))! },
      { manager: ctx.snapshot.managers.find((m) => m.manager_slug === "bravo")! as never, team: ctx.snapshot.teams[1]! as never, roster: ctx.rosters_by_manager.get(MID("bravo"))! },
    ];
    const baseline = evaluateTrade({ normalized: norm, week: 1, constraints: ctx.constraints, team_count: 12, projections: ctx.projections, replacement: ctx.replacement, players_by_id: ctx.players_by_id, participants, config: resolveTradeConfig(), projections_status: "READY", context: ctx });

    const without = evaluateCompetitiveTrade({ baseline, ctx, my_manager_id: MID("alpha"), incoming_player_ids: ["bravo_rb"], outgoing_player_ids: ["alpha_rb3"] });
    assert.equal(without.competitive.opponent_impact, undefined);
    assert.equal(without.competitive.competitive_result, undefined);

    const withCp = evaluateCompetitiveTrade({ baseline, ctx, my_manager_id: MID("alpha"), incoming_player_ids: ["bravo_rb"], outgoing_player_ids: ["alpha_rb3"], counterparty_manager_id: MID("bravo") });
    assert.ok(withCp.competitive.opponent_impact);
    assert.ok(withCp.competitive.opponent_threat);
    assert.ok(withCp.competitive.competitive_externality);
    assert.ok(withCp.competitive.competitive_result);
    assert.equal(withCp.competitive.opponent_threat!.calibration_status, "HEURISTIC");
    assert.ok(["FULL_COMPETITIVE_CONTEXT", "PARTIAL_COMPETITIVE_CONTEXT"].includes(withCp.competitive.competitive_result!.readiness));
    assert.equal(withCp.baseline, baseline);
    // opponent impact is from evaluateTrade, NOT owner perception
    const oi = withCp.competitive.opponent_impact!;
    assert.ok(typeof oi.private_delta === "number" || oi.private_delta === null);
    assert.ok(oi.starter_delta !== undefined && oi.bench_delta !== undefined);
  });

  it("buildOpponentImpact reads the counterparty participant, not our own", () => {
    // synthetic baseline
    const fakeBaseline = {
      participants: {
        us: { manager_slug: "us", roster_utility_delta: 12, starter_points_delta: 12, bench_value_delta: 0, positional_need_changes: [], lineup_displacement: { entered_starting_lineup: [], left_starting_lineup: [], moved_to_bench: [], bench_promotions: [] } },
        them: { manager_slug: "them", roster_utility_delta: -3, starter_points_delta: -3, bench_value_delta: 0, positional_need_changes: [], lineup_displacement: { entered_starting_lineup: [], left_starting_lineup: [], moved_to_bench: [], bench_promotions: [] } },
      },
    } as never;
    const oi = buildOpponentImpact({ baseline: fakeBaseline, counterparty_slug: "them", counterparty_manager_id: "them", received_ids: [], players_by_id: new Map() });
    assert.equal(oi.private_delta, -3);
    assert.ok(oi.reason_codes.includes("OPPONENT_ACTUALLY_WEAKENED"));
  });
});
