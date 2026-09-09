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

  const report = buildCompetitiveMarketReport(ctx, firstMgr.canonical_manager_id);
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
      console.log(`  ${fmtEdge(hit)}  owner=${ownerSlug ?? "?"}  reasons: ${hit.reasons[0] ?? ""}`);
    } else {
      console.log(`  ${name}: not rostered in this league / no snapshot`);
    }
  }
  console.log(`\nSTATUS: ANALYTICAL_ONLY — owner-perception / acquisition / acceptance model NOT implemented (Checkpoint C+).`);
}

async function main() {
  const slugs = process.argv.slice(2);
  const leagues = slugs.length > 0 ? slugs : ["bloodline-bowl"];
  for (const l of leagues) {
    try {
      await reportLeague(l);
    } catch (e) {
      console.log(`\n${l}: FATAL ${(e as Error).message}`);
    }
  }
}

void main();
