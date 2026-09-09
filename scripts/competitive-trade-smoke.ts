/**
 * Competitive Trade Intelligence — Checkpoint B, read-only live diagnostic.
 *
 *   npx tsx scripts/competitive-trade-smoke.ts [league-slug ...]
 *
 * Builds the league market-edge table and prints the sell / buy boards and the
 * largest HIGH/MEDIUM-confidence discrepancies. ANALYTICAL ONLY — no owner
 * perception, no acquisition price, no acceptance. Nothing is mutated.
 *
 * Does NOT hard-code any player ranking. Names are looked up only to answer the
 * prompt's diagnostic questions with whatever the data says today.
 */

import { buildTradeAnalysisContext } from "../lib/trades/context";
import { buildCompetitiveMarketReport } from "../lib/trades/competitive";
import type { MarketEdge } from "../lib/trades/competitive/schema";

const WATCH = ["Rhamondre Stevenson", "Rome Odunze", "Chuba Hubbard"];

function fmtEdge(e: MarketEdge): string {
  const pr = e.private_value.position_rank != null ? `${e.position}${e.private_value.position_rank}` : `${e.position}?`;
  const mr = e.market_value?.position_rank != null ? `${e.position}${e.market_value.position_rank}` : "—";
  return `${e.name.padEnd(22)} priv ${pr.padEnd(6)} mkt ${mr.padEnd(6)} edge ${String(e.edge_score ?? "—").padEnd(7)} act ${String(e.actionable_edge ?? "—").padEnd(7)} ${e.direction.padEnd(13)} conf=${e.confidence}`;
}

async function reportLeague(leagueSlug: string) {
  console.log(`\n################ ${leagueSlug} ################`);
  const ctxRes = await buildTradeAnalysisContext(leagueSlug);
  if (!ctxRes.context) {
    console.log(`ERROR: context unavailable (${ctxRes.code}): ${ctxRes.detail}`);
    return;
  }
  const ctx = ctxRes.context;
  console.log(`season=${ctx.season} week=${ctx.week} teams=${ctx.snapshot.teams.length} captured_at=${ctx.snapshot.captured_at}`);
  console.log(`projections status=${ctx.projections.status} model=${ctx.projections.model_version} ros_weeks=${ctx.ros.weeks.length}`);

  // find each manager, run per-manager reports; also collect a league-wide view
  const managers = ctx.snapshot.managers;
  const firstMgr = managers[0]!;

  const report = buildCompetitiveMarketReport(ctx, firstMgr.canonical_manager_id, undefined, { dynamic: true });
  if (report.dynamic) {
    console.log(
      `\n--- B.5 dynamic edge (calibration=${report.dynamic.calibration_status}) evidence readiness: ` +
        Object.entries(report.dynamic.evidence_readiness_counts).map(([k, v]) => `${k}=${v}`).join(" ") +
        ` ---`,
    );
    const dq = report.dynamic.ranked_edges.filter((e) => e.quality_status === "REVIEW_REQUIRED").length;
    console.log(`  quality_status REVIEW_REQUIRED: ${dq} / ${report.dynamic.ranked_edges.length} ranked`);
  }
  console.log(`\n--- readiness (perspective: ${firstMgr.manager_slug}) ---`);
  console.log(`overall=${report.readiness.overall}  ${report.readiness.summary}`);
  console.log(
    `  private_projection=${report.readiness.private_projection.state}` +
      ` market_data=${report.readiness.market_data.state}` +
      ` player_identity=${report.readiness.player_identity.state}` +
      ` ownership=${report.readiness.ownership.state}` +
      ` ppr_mode=${report.ppr_mode}`,
  );

  console.log(`\n--- ${firstMgr.manager_slug} SELL board (our market > our private) ---`);
  for (const s of report.boards.sell_board.slice(0, 8)) console.log(`  ${s.signal.padEnd(20)} ${fmtEdge(s.edge)}`);
  if (report.boards.sell_board.length === 0) console.log("  (no market-sell signals)");

  console.log(`\n--- ${firstMgr.manager_slug} BUY board (other rosters; our private > market) ---`);
  for (const b of report.boards.buy_board.slice(0, 10)) console.log(`  ${b.signal.padEnd(26)} owner=${b.owner_manager_slug.padEnd(14)} ${fmtEdge(b.edge)}`);
  if (report.boards.buy_board.length === 0) console.log("  (no model-buy candidates)");

  console.log(`\n--- largest HIGH/MEDIUM-confidence discrepancies league-wide ---`);
  const strong = report.ranked_edges
    .filter((e) => (e.confidence === "HIGH" || e.confidence === "MEDIUM") && e.direction !== "FAIR" && e.direction !== "INSUFFICIENT_DATA")
    .slice(0, 15);
  for (const e of strong) console.log(`  ${fmtEdge(e)}  [${e.reason_codes.slice(0, 3).join(",")}]`);
  if (strong.length === 0) console.log("  (none at HIGH/MEDIUM confidence)");

  console.log(`\n--- watch list (diagnostic only — no forced conclusion) ---`);
  for (const name of WATCH) {
    const hit =
      report.ranked_edges.find((e) => e.name.toLowerCase() === name.toLowerCase()) ??
      [...report.boards.sell_board, ...report.boards.buy_board].map((x) => x.edge).find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (hit) {
      const owner = ctx.snapshot.rosters.find((r) => r.all_players.includes(hit.canonical_player_id));
      const ownerTeam = owner && ctx.snapshot.teams.find((t) => t.canonical_team_id === owner.canonical_team_id);
      const ownerSlug = ownerTeam ? managers.find((m) => m.canonical_manager_id === ownerTeam.canonical_manager_ids[0])?.manager_slug : "free_agent";
      const dyn = report.dynamic?.by_player.get(hit.canonical_player_id);
      console.log(`  ${fmtEdge(hit)}  owner=${ownerSlug ?? "?"}`);
      if (dyn) {
        console.log(
          `    B.5: readiness=${dyn.temporal?.evidence_readiness} quality=${dyn.quality_status} ` +
            `edge_vs_preseason=${dyn.edge_vs_preseason_market} edge_vs_current=${dyn.edge_vs_current_market} ` +
            `correction=${dyn.market_correction} trajectory=${dyn.market_trajectory}`,
        );
      }
    } else {
      console.log(`  ${name}: not rostered in this league / no snapshot`);
    }
  }
  console.log(`\nSTATUS: ANALYTICAL_ONLY — owner-perception / acquisition / acceptance model NOT implemented (Checkpoint C+).`);
}

// ---------------------------------------------------------------------------
// Synthetic Week-6 diagnostic (§64) — deterministic, no live data. Shows the
// B.5 classifications the live Week-1 data can't yet produce.
// ---------------------------------------------------------------------------
async function syntheticWeek6() {
  const { buildTemporalContext } = await import("../lib/trades/competitive/temporal");
  const { buildCurrentSeasonEvidence } = await import("../lib/trades/competitive/evidence");
  const { buildMarketState } = await import("../lib/trades/competitive/market-state");
  const { buildPrivateForwardValue } = await import("../lib/trades/competitive/private-forward");
  const { applyDynamicMarketToEdge } = await import("../lib/trades/competitive/dynamic-edge");
  const { loadCompetitiveMarketCalibration, resolveCurves } = await import("../lib/trades/competitive/calibration");
  const { resolveCompetitiveTradeConfig } = await import("../lib/trades/competitive/config");

  const cal = loadCompetitiveMarketCalibration();
  const cfg = resolveCompetitiveTradeConfig();
  console.log(`\n################ SYNTHETIC WEEK 6 (calibration=${cal.status}) ################`);

  type Sc = { label: string; pos: string; priorZ: number; preZ: number; pubZ: number; games: Array<Record<string, unknown>> };
  const g = (n: number, o: Record<string, unknown>) => Array.from({ length: n }, (_, i) => ({ week: i + 1, meaningful: true, ...o }));
  const scenarios: Sc[] = [
    { label: "A sell-high (mkt RB5, private ROS RB13)", pos: "RB", priorZ: 0.2, preZ: 1.4, pubZ: 1.5, games: g(5, { rush_share: 0.5, snap_share: 0.55, fantasy_points: 22, baseline_expected_points: 13, opponent_matchup_score: 0.3 }) },
    { label: "B buy-low (strong role, elite opp, mkt RB22 private RB8)", pos: "RB", priorZ: -0.9, preZ: -0.7, pubZ: -0.8, games: g(6, { rush_share: 0.88, snap_share: 0.82, goal_line_share: 0.75, fantasy_points: 13, baseline_expected_points: 10, opponent_matchup_score: -0.55 }) },
    { label: "C market corrected (preseason edge gone)", pos: "RB", priorZ: 1.0, preZ: -0.7, pubZ: 1.05, games: g(5, { rush_share: 0.62, fantasy_points: 15, baseline_expected_points: 15, opponent_matchup_score: 0 }) },
    { label: "D TD mirage (high rank, weak role)", pos: "WR", priorZ: 0, preZ: 0, pubZ: 0, games: g(4, { target_share: 0.12, snap_share: 0.4, fantasy_points: 21, baseline_expected_points: 8, opponent_matchup_score: 0.2 }) },
    { label: "E schedule suppression (tough slate, real role)", pos: "WR", priorZ: 0.1, preZ: 0.1, pubZ: -0.2, games: g(5, { target_share: 0.29, snap_share: 0.9, fantasy_points: 13, baseline_expected_points: 16, opponent_matchup_score: -0.6 }) },
  ];

  for (const s of scenarios) {
    const meaningful = s.games.length;
    const t = buildTemporalContext({ as_of_week: 6, season: 2026, meaningful_games_observed: meaningful, games_source: "ROLE_OBSERVED_GAMES", position: s.pos, metric_family: "ROLE", calibration: cal });
    const recency = {
      ROLE: resolveCurves(cal, s.pos, "ROLE").recency, EFFICIENCY: resolveCurves(cal, s.pos, "EFFICIENCY").recency,
      RESULT: resolveCurves(cal, s.pos, "RESULT").recency, CONTEXT: resolveCurves(cal, s.pos, "CONTEXT").recency,
    };
    const ev = buildCurrentSeasonEvidence({ observations: s.games as never, position: s.pos, as_of_week: 6, recency });
    const prior = { basis: "ri_ros_weekly_vor" as const, raw: s.priorZ, normalized_value: s.priorZ, percentile: null, position_rank: null, confidence: "MEDIUM" as const, as_of: "2026-10-20", model_version: "t" };
    const pf = buildPrivateForwardValue({ canonical_player_id: "x", prior, evidence: ev, temporal: t, calibration: cal, remaining_games_expected: 11 });
    const ms = buildMarketState({
      canonical_player_id: "x", season: 2026, as_of_week: 6, preseason_prior_z: s.preZ, preseason_prior_rank: null, preseason_sources: ["adp"],
      current_public_z: s.pubZ, current_public_rank: null, current_public_readiness: "CURRENT", current_public_source: "sleeper",
      season_points_rank: null, recent_rank: null, evidence: ev, temporal: t, calibration: cal,
      lineage: { sources: [], primary_source_type: "provider_benchmark", usable_source_count: 1, dispersion: 0, worst_readiness: "CURRENT", scoring_normalization: "t" },
    });
    const be = { canonical_player_id: "x", name: s.label, position: s.pos, nfl_team: null, private_value: prior, market_value: { ...prior, normalized_value: s.pubZ }, direction: "FAIR" as const, edge_score: 0, actionable_edge: 0, confidence: "MEDIUM" as const, reason_codes: [], reasons: [], lineage: ms.lineage, analytical_only: true as const };
    const d = applyDynamicMarketToEdge({ base_edge: be, private_forward: pf, market_state: ms, temporal: t, config: cfg, calibration: cal, private_horizon: "ROS_WEEKLY_RATE", market_horizon: "ROS_WEEKLY_RATE", private_as_of_week: 6, market_as_of_week: 6, evidence_flags: { weak_schedule_inflation: ev.weak_schedule_inflation, touchdown_mirage_risk: ev.touchdown_mirage_risk } });
    console.log(`\n  ${s.label}`);
    console.log(`    direction=${d.direction} conf=${d.confidence} quality=${d.quality_status} correction=${d.market_correction} trajectory=${d.market_trajectory}`);
    console.log(`    edge_vs_preseason=${d.edge_vs_preseason_market} edge_vs_current=${d.edge_vs_current_market} breakout=${pf.breakout_credibility}`);
    console.log(`    codes: ${d.reason_codes.filter((c) => c !== "ANALYTICAL_ONLY_NO_ACQUISITION_MODEL").slice(0, 6).join(", ")}`);
  }
}

async function main() {
  const slugs = process.argv.slice(2).filter((s) => s !== "--synthetic-only");
  const syntheticOnly = process.argv.includes("--synthetic-only");
  if (!syntheticOnly) {
    const leagues = slugs.length > 0 ? slugs : ["bloodline-bowl"];
    for (const l of leagues) {
      try {
        await reportLeague(l);
      } catch (e) {
        console.log(`\n${l}: FATAL ${(e as Error).message}`);
      }
    }
  }
  await syntheticWeek6();
}

void main();
