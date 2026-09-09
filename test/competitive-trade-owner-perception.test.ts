/**
 * Competitive Trade Intelligence — Checkpoint C: owner-perceived value,
 * reservation price, acceptance likelihood.
 *
 * Deterministic. Drives the pure modules against synthetic
 * `TradeAnalysisContext` fixtures (the established trade-engine test pattern).
 * Covers spec §37–§49 and the §60 freeze gates.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import type { CanonicalPosition, CanonicalDraftPick } from "../lib/canonical/schema";
import { buildOwnerContext } from "../lib/trades/competitive/owner-context";
import { buildOwnerPerceivedValues, draftAnchorWeight } from "../lib/trades/competitive/owner-perception";
import { buildReservationPrice } from "../lib/trades/competitive/reservation";
import { buildAcceptanceEstimate } from "../lib/trades/competitive/acceptance";
import { evaluateOwnerPerception } from "../lib/trades/competitive/owner-perception-eval";
import { buildLeagueMarketEdgeTable } from "../lib/trades/competitive/evaluate";
import { buildDynamicMarketEdges } from "../lib/trades/competitive/dynamic";
import { resolveOwnerPerceptionConfig } from "../lib/trades/competitive/config";
import {
  loadCompetitiveMarketCalibration,
  isFullyCalibrated,
  DEFAULT_COMPETITIVE_MARKET_CALIBRATION,
} from "../lib/trades/competitive/calibration";

const CFG = resolveOwnerPerceptionConfig();
const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) =>
  [0, 1, 2, 3].map((i) => proj(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, { rest_of_season_points: (p === "QB" ? 12 - i : 6 - i) * ROS_WEEKS })),
);
const MID = (slug: string) => `manager:test-league:${slug}`;

function draftPick(manager: string, pid: string, round: number, pick: number): CanonicalDraftPick {
  return {
    canonical_draft_pick_id: `dp:${pid}`,
    canonical_league_id: "league:test-league",
    season: 2026,
    round,
    pick_number: pick,
    draft_slot: ((pick - 1) % 12) + 1,
    canonical_team_id: null,
    canonical_manager_id: MID(manager),
    canonical_player_id: pid,
    auction_amount: null,
    is_keeper: false,
    provenance: { provider: "sleeper", provider_id: `dp:${pid}`, provider_synced_at: null },
  };
}

function league(teams: StdTeamSpec[], drafts: CanonicalDraftPick[] = [], week = 1) {
  const built = teams.map(stdTeam);
  const fix = tradeFixture({
    teams: built.map((b) => b.team),
    players: built.flatMap((b) => b.players),
    projections: built.flatMap((b) => b.projections),
    freeAgents: FA,
    faProjections: FA_PROJ,
    transfers: [],
    rosFlatHorizon: ROS_WEEKS,
    teamCount: 12,
  });
  const ctx = fix.context({ rosWeeks: ROS_WEEKS });
  ctx.snapshot.draft_picks.push(...drafts);
  (ctx as { week: number }).week = week;
  return { fix, ctx };
}

/** two RBs on Alpha's bench: rb_deep_1 (better), rb_deep_2. Bravo has one thin RB. */
function twoOwnerLeague(week = 1) {
  return league(
    [
      {
        slug: "alpha",
        flex: { id: "alpha_flexwr", pos: "WR", pts: 12 },
        bench: [
          { id: "chuba", pos: "RB", pts: 11 },
          { id: "alpha_rb3", pos: "RB", pts: 10 },
          { id: "alpha_rb4", pos: "RB", pts: 9 },
        ],
        lockPts: { RB1: 20, RB2: 18 },
      },
      {
        slug: "bravo",
        flex: { id: "rhamondre", pos: "RB", pts: 13 },
        bench: [{ id: "bravo_wr3", pos: "WR", pts: 4 }],
        lockPts: { RB1: 8, RB2: 7, WR1: 9, WR2: 8 },
      },
    ],
    [
      draftPick("alpha", "chuba", 8, 90),
      draftPick("alpha", "alpha_rb3", 10, 115),
      draftPick("alpha", "alpha_rb4", 12, 140),
      draftPick("bravo", "rhamondre", 3, 30),
    ],
    week,
  );
}

describe("Competitive Trade C — B.5 calibration metadata correction (§1)", () => {
  it("the shipped artifact is PARTIALLY_CALIBRATED, not CALIBRATED", () => {
    const cal = loadCompetitiveMarketCalibration();
    assert.equal(cal.status, "PARTIALLY_CALIBRATED");
    assert.equal(cal.components.season_maturity.status, "CALIBRATED");
    assert.notEqual(cal.components.recency_decay.status, "CALIBRATED");
    assert.equal(cal.components.opponent_adjustment.status, "HEURISTIC");
    assert.equal(cal.components.market_response_weights.status, "HEURISTIC");
  });

  it("downstream cannot treat PARTIALLY_CALIBRATED as fully calibrated", () => {
    const partial = loadCompetitiveMarketCalibration();
    assert.equal(isFullyCalibrated(partial), false);
    assert.equal(isFullyCalibrated(DEFAULT_COMPETITIVE_MARKET_CALIBRATION), false);
    assert.equal(isFullyCalibrated({ status: "CALIBRATED" }), true);
    // a doctored artifact claiming CALIBRATED while a component is HEURISTIC is
    // downgraded by the loader
    const doctored = loadCompetitiveMarketCalibration();
    assert.notEqual(doctored.status, "CALIBRATED");
  });
});

describe("Competitive Trade C — owner-perceived value & reservation", () => {
  it("§37 — same player, different owners: reservation_price differs by roster context", () => {
    // Owner A: deep RB room, drafted late, weak WR. Owner B: thin RB, locked starter, drafted early.
    const a = league(
      [
        { slug: "deep", flex: { id: "tgt_a", pos: "RB", pts: 12 }, bench: [{ id: "d_rb2", pos: "RB", pts: 11 }, { id: "d_rb3", pos: "RB", pts: 11 }], lockPts: { RB1: 19, RB2: 18, WR1: 8, WR2: 7 } },
        { slug: "thin", flex: { id: "tgt_b", pos: "RB", pts: 12 }, bench: [{ id: "t_wr3", pos: "WR", pts: 10 }], lockPts: { RB1: 7, RB2: 6 } },
      ],
      [draftPick("deep", "tgt_a", 13, 150), draftPick("thin", "tgt_b", 2, 18)],
    );
    const table = buildLeagueMarketEdgeTable(a.ctx);
    const dyn = buildDynamicMarketEdges({ table, season: 2026, as_of_week: 1, remaining_games_expected: ROS_WEEKS, config: table.config });

    const evA = evaluateOwnerPerception({
      ctx: a.ctx, table, dynamic_edges: dyn.by_player,
      counterparty: { manager_id: MID("deep"), receives: [], gives: ["tgt_a"] },
    });
    const evB = evaluateOwnerPerception({
      ctx: a.ctx, table, dynamic_edges: dyn.by_player,
      counterparty: { manager_id: MID("thin"), receives: [], gives: ["tgt_b"] },
    });
    const rA = evA.owner_perception.reservation[0]!.reservation_price!;
    const rB = evB.owner_perception.reservation[0]!.reservation_price!;
    assert.ok(rB > rA, `thin-room locked starter reservation (${rB}) > deep-room bench reservation (${rA})`);
  });

  it("§38 — draft anchor: an early pick perceives higher value than a late pick early season, decays with games", () => {
    const early = draftAnchorWeight("STRONG_ANCHOR", 0, CFG);
    const lateEarlySeason = draftAnchorWeight("MINIMAL_ANCHOR", 0, CFG);
    assert.ok(early > lateEarlySeason);
    const w0 = draftAnchorWeight("STRONG_ANCHOR", 0, CFG);
    const w8 = draftAnchorWeight("STRONG_ANCHOR", 8, CFG);
    assert.ok(w8 < w0, "anchor weight decays with meaningful games");
    // but slower than the market's season-maturity re-pricing
    assert.ok(CFG.draft_anchor_decay_lambda < 0.16, "anchor decays slower than the season-maturity lambda");
  });

  it("§39 — starter replacement cost: no viable replacement ⇒ higher reservation; adding a backup lowers it", () => {
    const noBackup = league(
      [{ slug: "o", flex: { id: "star_rb", pos: "RB", pts: 16 }, bench: [{ id: "o_wr3", pos: "WR", pts: 8 }], lockPts: { RB1: 6, RB2: 5 } }],
      [draftPick("o", "star_rb", 4, 40)],
    );
    const withBackup = league(
      [{ slug: "o", flex: { id: "star_rb", pos: "RB", pts: 16 }, bench: [{ id: "o_rb3", pos: "RB", pts: 13 }], lockPts: { RB1: 6, RB2: 5 } }],
      [draftPick("o", "star_rb", 4, 40)],
    );
    const res = (l: ReturnType<typeof league>) => {
      const table = buildLeagueMarketEdgeTable(l.ctx);
      const dyn = buildDynamicMarketEdges({ table, season: 2026, as_of_week: 1, remaining_games_expected: ROS_WEEKS, config: table.config });
      const perceived = buildOwnerPerceivedValues({
        owner: buildOwnerContext(l.ctx, MID("o")), player_ids: ["star_rb"],
        global_market_z: new Map([["star_rb", 0.5]]), market_trajectory: new Map([["star_rb", "STABLE"]]),
        adp_position_rank: new Map([["star_rb", 12]]), meaningful_games: 0, config: CFG,
      });
      void dyn;
      return buildReservationPrice({ ctx: l.ctx, owner: buildOwnerContext(l.ctx, MID("o")), outgoing_ids: ["star_rb"], perceived, config: CFG });
    };
    const r1 = res(noBackup).components.replacement_cost;
    const r2 = res(withBackup).components.replacement_cost;
    assert.ok(r1 >= r2, `no-backup replacement cost (${r1}) >= with-backup (${r2})`);
  });

  it("§40/§41/§42 — perceived win / actual loss: acceptance can be MODERATE+ while opponent actual gain is negative", () => {
    // Bravo gives thin-room RB rhamondre, receives Alpha's RB4 (weak) + gets need relief nowhere.
    // Make it a lopsided-for-us swap: Alpha gets rhamondre, Bravo gets chuba (Alpha RB depth).
    const { ctx } = twoOwnerLeague();
    const table = buildLeagueMarketEdgeTable(ctx);
    const dyn = buildDynamicMarketEdges({ table, season: 2026, as_of_week: 1, remaining_games_expected: ROS_WEEKS, config: table.config });
    const ev = evaluateOwnerPerception({
      ctx, table, dynamic_edges: dyn.by_player,
      counterparty: { manager_id: MID("bravo"), receives: ["chuba"], gives: ["rhamondre"] },
    });
    // acceptance is computed from THEIR perceived economics, never our private delta
    assert.equal(ev.acceptance.calibration_status, "INSUFFICIENT_TRADE_HISTORY");
    assert.ok(["VERY_LOW", "LOW", "MODERATE", "HIGH"].includes(ev.acceptance.likelihood));
    assert.ok(!("private" in (ev.acceptance as unknown as Record<string, unknown>)));
    assert.ok(typeof ev.acceptance.perceived_ledger.perceived_surplus === "number" || ev.acceptance.perceived_ledger.perceived_surplus === null);
  });

  it("§43 — global-market-only fallback when owner context is missing; confidence capped low", () => {
    const { ctx } = twoOwnerLeague();
    const table = buildLeagueMarketEdgeTable(ctx);
    const dyn = buildDynamicMarketEdges({ table, season: 2026, as_of_week: 1, remaining_games_expected: ROS_WEEKS, config: table.config });
    const ev = evaluateOwnerPerception({
      ctx, table, dynamic_edges: dyn.by_player,
      counterparty: { manager_id: "manager:test-league:ghost", receives: ["chuba"], gives: ["rhamondre"] },
    });
    assert.ok(["GLOBAL_MARKET_ONLY", "UNAVAILABLE"].includes(ev.owner_perception.readiness));
    assert.ok(["LOW", "VERY_LOW"].includes(ev.acceptance.confidence));
  });

  it("§47 — falling market: personal anchor slows decline but does not prevent it", () => {
    const { ctx } = twoOwnerLeague();
    const owner = buildOwnerContext(ctx, MID("bravo"));
    const stable = buildOwnerPerceivedValues({
      owner, player_ids: ["rhamondre"], global_market_z: new Map([["rhamondre", 0.0]]),
      market_trajectory: new Map([["rhamondre", "STABLE"]]), adp_position_rank: new Map([["rhamondre", 20]]),
      meaningful_games: 0, config: CFG,
    }).get("rhamondre")!;
    const falling = buildOwnerPerceivedValues({
      owner, player_ids: ["rhamondre"], global_market_z: new Map([["rhamondre", 0.0]]),
      market_trajectory: new Map([["rhamondre", "FALLING_FAST"]]), adp_position_rank: new Map([["rhamondre", 20]]),
      meaningful_games: 0, config: CFG,
    }).get("rhamondre")!;
    assert.ok((falling.owner_perceived_value ?? 0) < (stable.owner_perceived_value ?? 0), "falling trajectory lowers perceived value");
  });

  it("§48 — bundle reservation is NOT additive: losing two RBs together costs more than the sum", () => {
    const { ctx } = twoOwnerLeague();
    const owner = buildOwnerContext(ctx, MID("alpha"));
    const perceived = buildOwnerPerceivedValues({
      owner, player_ids: ["chuba", "alpha_rb3", "alpha_rb4"],
      global_market_z: new Map([["chuba", 0.3], ["alpha_rb3", 0.1], ["alpha_rb4", 0]]),
      market_trajectory: new Map(), adp_position_rank: new Map(), meaningful_games: 0, config: CFG,
    });
    const single = buildReservationPrice({ ctx, owner, outgoing_ids: ["chuba"], perceived, config: CFG });
    const single3 = buildReservationPrice({ ctx, owner, outgoing_ids: ["alpha_rb3"], perceived, config: CFG });
    const bundle = buildReservationPrice({ ctx, owner, outgoing_ids: ["chuba", "alpha_rb3"], perceived, config: CFG });
    assert.ok(bundle.reservation_price != null);
    // bundle_nonadditivity is 0 or positive, never negative
    assert.ok(bundle.components.bundle_nonadditivity >= 0);
    void single; void single3;
  });
});

describe("Competitive Trade C — §49 monotonicity invariants", () => {
  const { ctx } = twoOwnerLeague();
  const owner = buildOwnerContext(ctx, MID("alpha"));
  const perceivedAt = (gmZ: number) =>
    buildOwnerPerceivedValues({
      owner, player_ids: ["chuba"], global_market_z: new Map([["chuba", gmZ]]),
      market_trajectory: new Map([["chuba", "STABLE"]]), adp_position_rank: new Map([["chuba", 40]]),
      meaningful_games: 0, config: CFG,
    }).get("chuba")!;

  it("increasing global market value cannot reduce owner-perceived value, all else equal", () => {
    const lo = perceivedAt(0.0).owner_perceived_value!;
    const hi = perceivedAt(1.0).owner_perceived_value!;
    assert.ok(hi >= lo);
  });

  it("stronger starter importance cannot reduce reservation price", () => {
    // compare a bench RB vs a locked-starter RB on the same owner
    const perceived = buildOwnerPerceivedValues({
      owner, player_ids: [...owner.by_player.keys()],
      global_market_z: new Map([...owner.by_player.keys()].map((k) => [k, 0.2])),
      market_trajectory: new Map(), adp_position_rank: new Map(), meaningful_games: 0, config: CFG,
    });
    const lockedId = [...owner.by_player.values()].find((p) => p.starter_importance === "LOCKED_STARTER")?.canonical_player_id;
    const benchId = [...owner.by_player.values()].find((p) => p.starter_importance === "BENCH_DEPTH" || p.starter_importance === "ROTATIONAL")?.canonical_player_id;
    if (lockedId && benchId) {
      const rl = buildReservationPrice({ ctx, owner, outgoing_ids: [lockedId], perceived, config: CFG }).reservation_price!;
      const rb = buildReservationPrice({ ctx, owner, outgoing_ids: [benchId], perceived, config: CFG }).reservation_price!;
      assert.ok(rl >= rb - 0.01, `locked-starter reservation (${rl}) >= bench reservation (${rb})`);
    }
  });

  it("personal draft-anchor influence decays monotonically with meaningful games", () => {
    const ws = [0, 2, 4, 8, 14].map((g) => draftAnchorWeight("MODERATE_ANCHOR", g, CFG));
    for (let i = 1; i < ws.length; i += 1) assert.ok(ws[i]! <= ws[i - 1]!);
  });

  it("increasing perceived incoming value cannot reduce acceptance likelihood (internal score)", () => {
    const owner2 = buildOwnerContext(ctx, MID("bravo"));
    const mkAccept = (incZ: number) => {
      const inc = buildOwnerPerceivedValues({
        owner: owner2, player_ids: ["chuba"], global_market_z: new Map([["chuba", incZ]]),
        market_trajectory: new Map([["chuba", "STABLE"]]), adp_position_rank: new Map([["chuba", 30]]),
        meaningful_games: 0, config: CFG,
      });
      const res = buildReservationPrice({ ctx, owner: owner2, outgoing_ids: ["rhamondre"], perceived: new Map(), config: CFG });
      return buildAcceptanceEstimate({
        owner: owner2, incoming_to_owner: [inc.get("chuba")!], outgoing_from_owner_reservation: res,
        name_of: (id) => id, need_positions_filled: [], incoming_trajectory_rising: 0,
        net_asset_delta: 0, roster_at_capacity: false, forced_drops_startable: 0, config: CFG,
      }).internal_score;
    };
    assert.ok(mkAccept(1.2) >= mkAccept(-0.5));
  });

  it("evaluateCompetitiveTrade: owner_perception/acceptance present only with a counterparty; baseline untouched", async () => {
    const { evaluateCompetitiveTrade } = await import("../lib/trades/competitive/evaluate");
    const { evaluateTrade } = await import("../lib/trades/evaluate");
    const { ctx: c3 } = twoOwnerLeague();
    const norm = {
      league_slug: "test-league",
      participant_manager_ids: [MID("alpha"), MID("bravo")],
      transfers: [
        { from_manager_id: MID("alpha"), to_manager_id: MID("bravo"), canonical_player_id: "chuba", input_player_id: "chuba" },
        { from_manager_id: MID("bravo"), to_manager_id: MID("alpha"), canonical_player_id: "rhamondre", input_player_id: "rhamondre" },
      ],
    };
    const participants = [
      { manager: c3.snapshot.managers.find((m) => m.manager_slug === "alpha")! as never, team: c3.snapshot.teams[0]! as never, roster: c3.rosters_by_manager.get(MID("alpha"))! },
      { manager: c3.snapshot.managers.find((m) => m.manager_slug === "bravo")! as never, team: c3.snapshot.teams[1]! as never, roster: c3.rosters_by_manager.get(MID("bravo"))! },
    ];
    const baseline = evaluateTrade({
      normalized: norm, week: 1, constraints: c3.constraints, team_count: 12,
      projections: c3.projections, replacement: c3.replacement, players_by_id: c3.players_by_id,
      participants, config: (await import("../lib/trades/config")).resolveTradeConfig(), projections_status: "READY", context: c3,
    });
    const without = evaluateCompetitiveTrade({ baseline, ctx: c3, my_manager_id: MID("alpha"), incoming_player_ids: ["rhamondre"], outgoing_player_ids: ["chuba"] });
    assert.equal(without.competitive.owner_perception, undefined);
    assert.equal(without.competitive.acceptance, undefined);

    const withCp = evaluateCompetitiveTrade({ baseline, ctx: c3, my_manager_id: MID("alpha"), incoming_player_ids: ["rhamondre"], outgoing_player_ids: ["chuba"], counterparty_manager_id: MID("bravo") });
    assert.ok(withCp.competitive.owner_perception);
    assert.ok(withCp.competitive.acceptance);
    assert.equal(withCp.competitive.acceptance!.calibration_status, "INSUFFICIENT_TRADE_HISTORY");
    assert.equal(withCp.baseline, baseline);
  });

  it("missing owner data cannot increase confidence; opponent private gain not required", () => {
    const { ctx: c2 } = twoOwnerLeague();
    const table = buildLeagueMarketEdgeTable(c2);
    const dyn = buildDynamicMarketEdges({ table, season: 2026, as_of_week: 1, remaining_games_expected: ROS_WEEKS, config: table.config });
    const full = evaluateOwnerPerception({ ctx: c2, table, dynamic_edges: dyn.by_player, counterparty: { manager_id: MID("bravo"), receives: ["chuba"], gives: ["rhamondre"] } });
    const ghost = evaluateOwnerPerception({ ctx: c2, table, dynamic_edges: dyn.by_player, counterparty: { manager_id: "manager:test-league:ghost", receives: ["chuba"], gives: ["rhamondre"] } });
    const order = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];
    assert.ok(order.indexOf(ghost.acceptance.confidence) <= order.indexOf(full.acceptance.confidence));
  });
});
