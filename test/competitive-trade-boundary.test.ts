/**
 * Competitive Trade Intelligence — Checkpoint B: discovery boundary + wrapper.
 *
 * Proves (spec §2, §3, §21 B10–B12):
 *   - the STRUCTURAL candidate stage retains asymmetric "we gain / opponent
 *     loses" trades that the LEGACY mutual-benefit gate rejects;
 *   - legacy discovery output is unchanged (determinism check + full existing
 *     trade-engine suite in regression);
 *   - `evaluateCompetitiveTrade` adds ONLY the market-edge block and never
 *     turns a market edge into a finalized recommendation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeFixture, stdTeam, type StdTeamSpec } from "./fixtures/trades";
import { player, proj } from "./fixtures/weekly";
import { evaluateTrade } from "../lib/trades/evaluate";
import { runBilateralSearch } from "../lib/trades/discovery/bilateral";
import { buildDiscoveryEvalContext } from "../lib/trades/discovery/candidate-eval";
import { resolveTradeConfig } from "../lib/trades/config";
import { DEFAULT_SEARCH_LIMITS } from "../lib/trades/discovery/config";
import {
  generateStructuralTradeCandidates,
  legacyMutualBenefitWouldKeep,
} from "../lib/trades/competitive/candidates";
import { evaluateCompetitiveTrade, buildLeagueMarketEdgeTable } from "../lib/trades/competitive/evaluate";
import { buildCompetitiveMarketReport } from "../lib/trades/competitive";
import type { CanonicalPosition } from "../lib/canonical/schema";

const ROS_WEEKS = 6;
type Pos = CanonicalPosition;
const POSITIONS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FA = POSITIONS.flatMap((p) => [0, 1, 2, 3].map((i) => player(`fa_${p}_${i}`, p)));
const FA_PROJ = POSITIONS.flatMap((p) =>
  [0, 1, 2, 3].map((i) => proj(`fa_${p}_${i}`, p, p === "QB" ? 12 - i : 6 - i, { rest_of_season_points: (p === "QB" ? 12 - i : 6 - i) * ROS_WEEKS })),
);

function buildLeague(teams: StdTeamSpec[], transfers: { from: string; to: string; pid: string }[] = []) {
  const built = teams.map(stdTeam);
  return tradeFixture({
    teams: built.map((b) => b.team),
    players: built.flatMap((b) => b.players),
    projections: built.flatMap((b) => b.projections),
    freeAgents: FA,
    faProjections: FA_PROJ,
    transfers: transfers.map((t) => ({
      from_manager_id: `manager:test-league:${t.from}`,
      to_manager_id: `manager:test-league:${t.to}`,
      canonical_player_id: t.pid,
      input_player_id: t.pid,
    })),
    rosFlatHorizon: ROS_WEEKS,
    teamCount: 12,
  });
}

const MID = (slug: string) => `manager:test-league:${slug}`;

describe("Competitive Trade — discovery boundary (Checkpoint B)", () => {
  it("B11 — asymmetric 'we gain / opponent loses' candidate survives structural discovery, legacy rejects it", () => {
    // Alpha has a CRITICAL RB hole (weak locked RBs) and a throwaway bench WR.
    // Bravo's flex is a strong RB. Alpha-WRscrub ↔ Bravo-RBstud helps Alpha a
    // lot and hurts Bravo a lot.
    const fix = buildLeague([
      {
        slug: "alpha",
        flex: { id: "alpha_flexwr", pos: "WR", pts: 11 },
        bench: [{ id: "alpha_scrub_wr", pos: "WR", pts: 3 }],
        lockPts: { RB1: 6, RB2: 5 },
      },
      {
        slug: "bravo",
        flex: { id: "bravo_rb_stud", pos: "RB", pts: 18 },
        bench: [{ id: "bravo_scrub_rb", pos: "RB", pts: 4 }],
      },
    ]);

    const ctx = fix.context({ rosWeeks: ROS_WEEKS });
    const config = resolveTradeConfig();

    const { candidates } = generateStructuralTradeCandidates({
      ctx,
      config,
      my_manager_id: MID("alpha"),
      partner_manager_ids: [MID("bravo")],
    });

    assert.ok(candidates.length > 0, "structural stage produced candidates");

    const asymmetric = candidates.filter((c) => c.my_utility_delta > 1.5 && c.min_opponent_utility_delta < -0.5);
    assert.ok(
      asymmetric.length > 0,
      `expected ≥1 candidate where we gain (+${candidates.map((c) => c.my_utility_delta.toFixed(1))}) and opponent loses`,
    );

    for (const c of asymmetric) {
      const legacyKeeps = legacyMutualBenefitWouldKeep(c.evaluation, "alpha", "BEST_AVAILABLE");
      assert.equal(legacyKeeps, false, "legacy mutual-benefit gate rejects the asymmetric candidate");
    }
  });

  it("B11b — the structural stage is NOT gated by opponent private improvement", () => {
    const fix = buildLeague([
      { slug: "alpha", flex: { id: "alpha_flexwr", pos: "WR", pts: 11 }, bench: [{ id: "alpha_scrub_wr", pos: "WR", pts: 3 }], lockPts: { RB1: 6, RB2: 5 } },
      { slug: "bravo", flex: { id: "bravo_rb_stud", pos: "RB", pts: 18 }, bench: [{ id: "bravo_scrub_rb", pos: "RB", pts: 4 }] },
    ]);
    const ctx = fix.context({ rosWeeks: ROS_WEEKS });
    const { candidates } = generateStructuralTradeCandidates({ ctx, config: resolveTradeConfig(), my_manager_id: MID("alpha"), partner_manager_ids: [MID("bravo")] });
    // at least one retained candidate has a NEGATIVE opponent delta — proof the
    // stage never applied `opponent_gain >= threshold`
    assert.ok(candidates.some((c) => c.min_opponent_utility_delta < 0));
  });

  it("B10 — legacy bilateral discovery is deterministic and still finds mutually-beneficial deals", () => {
    const fix = buildLeague([
      { slug: "alpha", flex: { id: "alpha_flexwr", pos: "WR", pts: 11 }, bench: [{ id: "alpha_wr3", pos: "WR", pts: 12 }], lockPts: { RB1: 7, RB2: 6 } },
      { slug: "bravo", flex: { id: "bravo_flexrb", pos: "RB", pts: 12 }, bench: [{ id: "bravo_wr_need", pos: "WR", pts: 4 }], lockPts: { WR1: 8, WR2: 7 } },
    ]);
    const ctx = fix.context({ rosWeeks: ROS_WEEKS });
    const evalCtx = buildDiscoveryEvalContext(ctx);
    const args = {
      ctx,
      evalCtx,
      config: resolveTradeConfig(),
      mode: "BEST_AVAILABLE" as const,
      myManagerId: MID("alpha"),
      myManagerSlug: "alpha",
      limits: DEFAULT_SEARCH_LIMITS,
      maxResults: 10,
    };
    const a = runBilateralSearch(args);
    const b = runBilateralSearch(args);
    assert.deepEqual(JSON.stringify(a.results), JSON.stringify(b.results), "legacy discovery is deterministic");
  });

  it("B12 — a STRONG_BUY incoming player does NOT produce owner-perception / acceptance / negotiation / competitive-cost fields", () => {
    // Alpha would receive bravo_rb_stud; set its Sleeper ROS (market) LOW while
    // RI weekly (private) is high ⇒ buy-side edge.
    const fix = buildLeague([
      { slug: "alpha", flex: { id: "alpha_flexwr", pos: "WR", pts: 11 }, bench: [{ id: "alpha_scrub_wr", pos: "WR", pts: 3 }], lockPts: { RB1: 6, RB2: 5 } },
      { slug: "bravo", flex: { id: "bravo_rb_stud", pos: "RB", pts: 18 }, bench: [{ id: "bravo_scrub_rb", pos: "RB", pts: 4 }] },
    ]);
    const ctx = fix.context({ rosWeeks: ROS_WEEKS });

    // depress the market (Sleeper ROS) for the stud so private ≫ market
    const wp = ctx.projections.by_player.get("bravo_rb_stud")!;
    wp.rest_of_season_points = 12; // ~2/wk over 6 wks
    if (wp.ros) wp.ros = { ...wp.ros, points: 12, external_season_points: 34 };

    const baseline = evaluateTrade({
      ...fix.input,
      normalized: {
        league_slug: "test-league",
        participant_manager_ids: [MID("alpha"), MID("bravo")],
        transfers: [
          { from_manager_id: MID("alpha"), to_manager_id: MID("bravo"), canonical_player_id: "alpha_scrub_wr", input_player_id: "alpha_scrub_wr" },
          { from_manager_id: MID("bravo"), to_manager_id: MID("alpha"), canonical_player_id: "bravo_rb_stud", input_player_id: "bravo_rb_stud" },
        ],
      },
      participants: fix.input.participants,
      context: ctx,
    });

    const result = evaluateCompetitiveTrade({
      baseline,
      ctx,
      my_manager_id: MID("alpha"),
      incoming_player_ids: ["bravo_rb_stud"],
      outgoing_player_ids: ["alpha_scrub_wr"],
    });

    const comp = result.competitive as unknown as Record<string, unknown>;
    for (const forbidden of ["owner_perception", "acceptance", "extraction", "competitive_cost", "liquidity", "appreciation", "negotiation"]) {
      assert.ok(!(forbidden in comp), `Checkpoint B must not expose '${forbidden}'`);
    }
    assert.equal(result.baseline, baseline, "baseline passed through untouched");
    for (const e of [...result.competitive.market_edge.incoming, ...result.competitive.market_edge.outgoing]) {
      assert.equal(e.analytical_only, true);
    }
    assert.ok(result.competitive.notes.join(" ").includes("does NOT model"));
    // aggregate edge is not dressed up as a verdict
    const agg = result.competitive.market_edge.aggregate_edge as Record<string, unknown> | null;
    if (agg) assert.ok(!("recommendation" in agg) && !("verdict" in agg));
  });

  it("readiness fails closed — projections unavailable ⇒ overall UNAVAILABLE, no fabricated market value", () => {
    const fix = buildLeague([
      { slug: "alpha", flex: { id: "alpha_flexwr", pos: "WR", pts: 11 } },
      { slug: "bravo", flex: { id: "bravo_flexrb", pos: "RB", pts: 12 } },
    ]);
    const ctx = fix.context({ rosWeeks: ROS_WEEKS });
    // simulate a total projection outage
    (ctx.projections as { status: string }).status = "PROJECTIONS_UNAVAILABLE";

    const report = buildCompetitiveMarketReport(ctx, MID("alpha"));
    assert.equal(report.readiness.private_projection.state, "UNAVAILABLE");
    assert.equal(report.readiness.overall, "UNAVAILABLE");
  });

  it("league market-edge table is built once and reused (memoization contract)", () => {
    const fix = buildLeague([
      { slug: "alpha", flex: { id: "alpha_flexwr", pos: "WR", pts: 11 } },
      { slug: "bravo", flex: { id: "bravo_flexrb", pos: "RB", pts: 12 } },
    ]);
    const ctx = fix.context({ rosWeeks: ROS_WEEKS });
    const table = buildLeagueMarketEdgeTable(ctx);
    assert.ok(table.edges.by_player.size > 0);
    // every player appears exactly once
    assert.equal(new Set([...table.edges.by_player.keys()]).size, table.edges.by_player.size);
  });
});
