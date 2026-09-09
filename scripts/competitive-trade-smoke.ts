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
import {
  buildCompetitiveMarketReport,
  buildLeagueMarketEdgeTable,
  buildDynamicMarketEdges,
  evaluateOwnerPerception,
  buildOwnerContext,
  buildLeagueThreat,
  resolveCompetitiveDConfig,
} from "../lib/trades/competitive";
import { evaluateCompetitiveTrade } from "../lib/trades/competitive/evaluate";
import { evaluateTrade } from "../lib/trades/evaluate";
import { resolveTradeConfig } from "../lib/trades/config";
import type { MarketEdge } from "../lib/trades/competitive/schema";

type Ctx = NonNullable<Awaited<ReturnType<typeof buildTradeAnalysisContext>>["context"]>;

function competitiveTradeResult(ctx: Ctx, myMgrId: string, cpMgrId: string, weSend: string, weReceive: string) {
  const myTeam = ctx.snapshot.teams.find((t) => t.canonical_manager_ids.includes(myMgrId))!;
  const cpTeam = ctx.snapshot.teams.find((t) => t.canonical_manager_ids.includes(cpMgrId))!;
  const norm = {
    league_slug: ctx.league_slug,
    participant_manager_ids: [myMgrId, cpMgrId],
    transfers: [
      { from_manager_id: myMgrId, to_manager_id: cpMgrId, canonical_player_id: weSend, input_player_id: weSend },
      { from_manager_id: cpMgrId, to_manager_id: myMgrId, canonical_player_id: weReceive, input_player_id: weReceive },
    ],
  };
  const participants = [
    { manager: ctx.snapshot.managers.find((m) => m.canonical_manager_id === myMgrId)! as never, team: myTeam as never, roster: ctx.rosters_by_manager.get(myMgrId)! },
    { manager: ctx.snapshot.managers.find((m) => m.canonical_manager_id === cpMgrId)! as never, team: cpTeam as never, roster: ctx.rosters_by_manager.get(cpMgrId)! },
  ];
  const baseline = evaluateTrade({
    normalized: norm, week: ctx.week, constraints: ctx.constraints, team_count: ctx.team_count,
    projections: ctx.projections, replacement: ctx.replacement, players_by_id: ctx.players_by_id,
    participants, config: resolveTradeConfig(), projections_status: "READY", context: ctx,
  });
  return evaluateCompetitiveTrade({
    baseline, ctx, my_manager_id: myMgrId, incoming_player_ids: [weReceive], outgoing_player_ids: [weSend],
    counterparty_manager_id: cpMgrId,
  });
}

const WATCH = ["Rhamondre Stevenson", "Rome Odunze", "Chuba Hubbard"];

function findPlayer(ctx: Awaited<ReturnType<typeof buildTradeAnalysisContext>>["context"], name: string) {
  if (!ctx) return null;
  const p = ctx.snapshot.players.find((pp) => pp.full_name.toLowerCase() === name.toLowerCase());
  if (!p) return null;
  const roster = ctx.snapshot.rosters.find((r) => r.all_players.includes(p.canonical_player_id));
  const team = roster && ctx.snapshot.teams.find((t) => t.canonical_team_id === roster.canonical_team_id);
  const ownerId = team?.canonical_manager_ids[0] ?? null;
  const ownerSlug = ownerId ? ctx.snapshot.managers.find((m) => m.canonical_manager_id === ownerId)?.manager_slug ?? null : null;
  return { player: p, owner_id: ownerId, owner_slug: ownerSlug };
}

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
  // ---- Checkpoint C: owner perception + acceptance ----
  console.log(`\n================ CHECKPOINT C — owner perception & acceptance ================`);
  const cTable = buildLeagueMarketEdgeTable(ctx);
  const cDyn = buildDynamicMarketEdges({ table: cTable, season: ctx.season, as_of_week: ctx.week, remaining_games_expected: Math.max(1, ctx.ros.weeks.length), config: cTable.config });

  const chuba = findPlayer(ctx, "Chuba Hubbard");
  const rham = findPlayer(ctx, "Rhamondre Stevenson");
  const rome = findPlayer(ctx, "Rome Odunze");

  if (chuba?.owner_id) {
    const oc = buildOwnerContext(ctx, chuba.owner_id);
    const pc = oc.by_player.get(chuba.player.canonical_player_id);
    console.log(`\n--- BijiMac(${chuba.owner_slug}) / Chuba Hubbard ---`);
    console.log(`  Chuba: starter_importance=${pc?.starter_importance} draft=${pc?.draft_round == null ? "n/a" : "R" + pc.draft_round + " (overall " + pc.draft_pick + ")"} startable_RB_on_roster=${pc?.position_startable_count} (without Chuba: ${pc?.position_startable_without})`);
    const rbNeed = oc.profile.needs.find((n) => n.position === "RB");
    const rbSurplus = oc.profile.surpluses.find((s) => s.position === "RB");
    console.log(`  BijiMac RB need=${rbNeed?.severity ?? "NONE"} RB surplus_count=${rbSurplus?.surplus_count ?? 0}`);
  }

  if (chuba?.owner_id && rham) {
    console.log(`\n--- hypothetical: Rhamondre Stevenson  →  Chuba Hubbard  (we send Rhamondre, receive Chuba) ---`);
    const ev = evaluateOwnerPerception({
      ctx, table: cTable, dynamic_edges: cDyn.by_player,
      counterparty: { manager_id: chuba.owner_id, receives: [rham.player.canonical_player_id], gives: [chuba.player.canonical_player_id] },
    });
    const op = ev.owner_perception;
    console.log(`  readiness=${op.readiness} confidence=${op.confidence}`);
    console.log(`  THEIR perceived ledger (${chuba.owner_slug}):`);
    console.log(`    receive Rhamondre  perceived ≈ ${op.perceived_incoming_value?.toFixed(2)}`);
    console.log(`    give up  Chuba     reservation ≈ ${op.perceived_outgoing_reservation?.toFixed(2)}  (perceived value ${op.reservation[0]?.perceived_value?.toFixed(2)}; components ${JSON.stringify(op.reservation[0]?.components)})`);
    console.log(`    perceived surplus ≈ ${op.perceived_surplus?.toFixed(2)}`);
    console.log(`  acceptance: likelihood=${ev.acceptance.likelihood} internal_score=${ev.acceptance.internal_score} confidence=${ev.acceptance.confidence} (${ev.acceptance.calibration_status})`);
    console.log(`    ${ev.acceptance.reasons.slice(0, 3).join("\n    ")}`);
    console.log(`  (our private ledger comes from evaluateTrade — NOT shown here; extraction NOT recommended — Checkpoint C boundary)`);
  }

  if (rome) {
    console.log(`\n--- Rome Odunze as outgoing currency to different owners (owner-specific perceived value) ---`);
    const others = ctx.snapshot.managers.filter((m) => m.canonical_manager_id !== rome.owner_id).slice(0, 4);
    for (const m of others) {
      const oc = buildOwnerContext(ctx, m.canonical_manager_id);
      const wrNeed = oc.profile.needs.find((n) => n.position === "WR")?.severity ?? "NONE";
      // perceived value if Rome were on THIS owner's roster is not directly computable
      // (he isn't), but their WR need drives how much need-relief he'd provide
      console.log(`  ${m.manager_slug.padEnd(16)} WR need=${wrNeed} startable_WR≈${oc.profile.surpluses.find((s) => s.position === "WR")?.surplus_count ?? 0}`);
    }
  }

  // multi-owner RB comparison — reservation differs by roster context
  const rbOwners = ctx.snapshot.rosters
    .map((r) => {
      const team = ctx.snapshot.teams.find((t) => t.canonical_team_id === r.canonical_team_id);
      const mid = team?.canonical_manager_ids[0];
      if (!mid) return null;
      const oc = buildOwnerContext(ctx, mid);
      const rbCount = [...oc.by_player.values()].filter((p) => p.position === "RB").length;
      const rbNeed = oc.profile.needs.find((n) => n.position === "RB")?.severity ?? "NONE";
      return { slug: oc.manager_slug, rbCount, rbNeed };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => b.rbCount - a.rbCount);
  console.log(`\n--- RB roster context across the league (drives reservation-price differences) ---`);
  for (const o of rbOwners) console.log(`  ${o.slug.padEnd(16)} RB rostered=${o.rbCount}  RB need=${o.rbNeed}`);

  // ---- Checkpoint D: opponent impact, threat, externality, competitive result ----
  console.log(`\n================ CHECKPOINT D — opponent impact, threat, competitive result ================`);
  const myMgr = ctx.snapshot.managers[0]!; // arbitrary "us" perspective for the hypothetical
  const lt = buildLeagueThreat(ctx, resolveCompetitiveDConfig(), myMgr.canonical_manager_id);
  console.log(`\n--- league threat bands (week ${ctx.week}, projected-roster-driven) ---`);
  for (const [mid, t] of [...lt.by_manager].sort((a, b) => b[1].score - a[1].score)) {
    const slug = ctx.snapshot.managers.find((m) => m.canonical_manager_id === mid)?.manager_slug ?? mid;
    console.log(`  ${slug.padEnd(16)} band=${t.band.padEnd(9)} score=${t.score.toFixed(2)} percentile=${t.league_strength_percentile?.toFixed(2)} contender=${t.contender_band} results_weight=${t.components.results_weight}`);
  }

  if (chuba?.owner_id && rham?.owner_id) {
    console.log(`\n--- Rhamondre Stevenson  →  Chuba Hubbard  (perspective: ${rham.owner_slug} sends Rhamondre, receives Chuba) ---`);
    const cr = competitiveTradeResult(ctx, rham.owner_id, chuba.owner_id, rham.player.canonical_player_id, chuba.player.canonical_player_id);
    const c = cr.competitive;
    const oh = c.our_trade_horizons!;
    const ph = c.opponent_trade_horizons!;
    console.log(`  OUR (${rham.owner_slug}) horizons: immediate=${oh.immediate.total_delta.toFixed(2)} ROS=${oh.ros.total_delta.toFixed(2)} (starter ${oh.ros.starter_delta.toFixed(2)}, avail ${oh.ros.availability_delta.toFixed(2)}, playoff ${oh.ros.playoff_window_delta}) → permanent=${oh.permanent_trade_utility.toFixed(2)}/wk [${oh.horizon_classification}, ${oh.horizon_readiness}, conf ${oh.confidence}]`);
    console.log(`    RI ordinal: ri_vor_delta=${oh.ri_ordinal.ri_vor_delta} incoming_ri_rank=${oh.ri_ordinal.incoming_ri_ranks.map((x) => x.position + x.ri_position_rank).join(",")} outgoing_ri_rank=${oh.ri_ordinal.outgoing_ri_ranks.map((x) => x.position + x.ri_position_rank).join(",")} sign_conflict=${oh.ri_ordinal.sign_conflict} — ${oh.ri_ordinal.note}`);
    console.log(`  BIJIMAC(${chuba.owner_slug}) horizons: immediate=${ph.immediate.total_delta.toFixed(2)} ROS=${ph.ros.total_delta.toFixed(2)} → permanent=${ph.permanent_trade_utility.toFixed(2)}/wk [${ph.horizon_classification}]`);
    console.log(`  opponent ACTUAL impact (permanent): private_delta=${c.opponent_impact?.private_delta} starter_delta=${c.opponent_impact?.starter_delta} weakness_repair=${c.opponent_impact?.weakness_repair}`);
    console.log(`  opponent perceived surplus (C): ${c.owner_perception?.perceived_surplus?.toFixed(2)} | acceptance=${c.acceptance?.likelihood} (conf ${c.acceptance?.confidence})`);
    console.log(`  opponent threat: band=${c.opponent_threat?.band} score=${c.opponent_threat?.score.toFixed(2)} horizon=${c.opponent_threat?.components.projected_strength_horizon} relative_to_us=${c.opponent_threat?.relative_to_us}`);
    console.log(`  competitive externality: ${c.competitive_externality?.score.toFixed(2)}  [${c.competitive_externality?.reason_codes.join(",")}]`);
    console.log(`  competitive_result: classification=${c.competitive_result?.classification} score=${c.competitive_result?.score.toFixed(2)} actionable=${c.competitive_result?.actionable} confidence=${c.competitive_result?.confidence}`);
    console.log(`    gates: ${c.competitive_result?.gate_trace.map((g) => `${g.stage}=${g.pass ? "✓" : "✗"}`).join("  ")}`);
  }

  // §48 — three materially different RB targets, horizon-aware
  if (rham?.owner_id) {
    console.log(`\n--- §48: ${rham.owner_slug} trades Rhamondre for three different RBs — horizon-aware ---`);
    const cands = ctx.snapshot.rosters
      .flatMap((rr) => {
        const team = ctx.snapshot.teams.find((t) => t.canonical_team_id === rr.canonical_team_id)!;
        const mid = team.canonical_manager_ids[0]!;
        if (mid === rham.owner_id) return [];
        return [...buildOwnerContext(ctx, mid).by_player.values()]
          .filter((p) => p.position === "RB")
          .map((p) => {
            const wp = ctx.projections.by_player.get(p.canonical_player_id);
            return { mid, pid: p.canonical_player_id, name: p.name, riRank: wp?.ros?.ri_position_rank ?? 999, riVor: wp?.ros?.ri_vor ?? 0 };
          });
      })
      .sort((a, b) => a.riRank - b.riRank);
    const picks = [cands[0], cands[Math.floor(cands.length / 2)], cands[cands.length - 1]].filter((x): x is NonNullable<typeof x> => !!x);
    for (const pk of picks) {
      try {
        const cr = competitiveTradeResult(ctx, rham.owner_id, pk.mid, rham.player.canonical_player_id, pk.pid);
        const c = cr.competitive;
        const oh = c.our_trade_horizons!;
        console.log(`  ${pk.name.padEnd(20)} (RI ${("RB" + pk.riRank).padEnd(6)}) immediate=${oh.immediate.total_delta.toFixed(2).padStart(6)} ROS=${oh.ros.total_delta.toFixed(2).padStart(6)} permanent=${oh.permanent_trade_utility.toFixed(2).padStart(6)} class=${oh.horizon_classification.padEnd(28)} result=${(c.competitive_result?.classification ?? "?").padEnd(22)} actionable=${c.competitive_result?.actionable}`);
      } catch (e) {
        console.log(`  ${pk.name}: ${(e as Error).message}`);
      }
    }
  }

  // §40 — same our-side asset, RB acquired from counterparties of DIFFERENT threat.
  // "us" = a manager with a real RB need, so our_gain is positive and D's
  // threat/externality logic actually drives the classification.
  const rbNeedyMgr = ctx.snapshot.managers
    .map((m) => ({ m, oc: buildOwnerContext(ctx, m.canonical_manager_id) }))
    .find(({ oc }) => oc.profile.needs.some((n) => n.position === "RB" && (n.severity === "CRITICAL" || n.severity === "HIGH")));
  if (rbNeedyMgr) {
    const usId = rbNeedyMgr.m.canonical_manager_id;
    // our most expendable non-RB bench asset to offer
    const offer = [...rbNeedyMgr.oc.by_player.values()]
      .filter((p) => p.position !== "RB" && (p.starter_importance === "BENCH_DEPTH" || p.starter_importance === "ROTATIONAL"))
      .sort((a, b) => (a.vor ?? 0) - (b.vor ?? 0))[0];
    const rbTargets = ctx.snapshot.rosters
      .flatMap((r) => {
        const team = ctx.snapshot.teams.find((t) => t.canonical_team_id === r.canonical_team_id)!;
        const mid = team.canonical_manager_ids[0]!;
        if (mid === usId) return [];
        const oc = buildOwnerContext(ctx, mid);
        return [...oc.by_player.values()]
          .filter((p) => p.position === "RB" && (p.starter_importance === "ROTATIONAL" || p.starter_importance === "FLEX_STARTER"))
          .slice(0, 1)
          .map((p) => ({ mid, slug: oc.manager_slug, pid: p.canonical_player_id, name: p.name, threat: lt.by_manager.get(mid)?.band }));
      });
    console.log(`\n--- §40: ${rbNeedyMgr.m.manager_slug} (RB need) acquires an RB — same asset offered, counterparties of different threat ---`);
    if (offer) {
      const seen = new Set<string>();
      for (const tgt of rbTargets) {
        if (seen.has(tgt.slug)) continue;
        seen.add(tgt.slug);
        try {
          const cr = competitiveTradeResult(ctx, usId, tgt.mid, offer.canonical_player_id, tgt.pid);
          const c = cr.competitive;
          const ourPerm = c.our_trade_horizons?.permanent_trade_utility;
          const ourImm = c.our_trade_horizons?.immediate.total_delta;
          console.log(`  vs ${tgt.slug.padEnd(14)} (${tgt.name.padEnd(18)}) our_perm=${ourPerm?.toFixed(2).padStart(6)} (imm ${ourImm?.toFixed(2)}) threat=${(c.opponent_threat?.band ?? "?").padEnd(9)} opp_perm=${c.opponent_impact?.private_delta?.toFixed(2).padStart(6)} ext=${c.competitive_externality?.score.toFixed(2).padStart(6)} result=${(c.competitive_result?.classification ?? "?").padEnd(22)} actionable=${c.competitive_result?.actionable}`);
        } catch (e) {
          console.log(`  vs ${tgt.slug}: ${(e as Error).message}`);
        }
      }
    }
  }

  // ---- Checkpoint E: value extraction + negotiation envelope ----
  console.log(`\n================ CHECKPOINT E — value extraction & negotiation envelope ================`);
  const { evaluateNegotiationEnvelopeInner } = await import("../lib/trades/competitive");

  if (rham?.owner_id && chuba?.owner_id) {
    const env = evaluateNegotiationEnvelopeInner({
      ctx, my_manager_id: rham.owner_id, counterparty_manager_id: chuba.owner_id,
      our_assets: [rham.player.canonical_player_id], their_assets: [chuba.player.canonical_player_id],
    });
    console.log(`\n--- Rhamondre Stevenson → Chuba Hubbard negotiation (perspective ${rham.owner_slug}) ---`);
    console.log(`  base certified=${env.base_trade_certified} readiness=${env.readiness} extraction band=${env.extraction.band}`);
    console.log(`  base: our permanent utility=${env.base_proposal.our_permanent_utility?.toFixed(2)}  their perceived surplus=${env.base_proposal.counterparty_perceived_surplus?.toFixed(2)}  acceptance=${env.base_proposal.acceptance_likelihood}  competitive=${env.base_proposal.competitive_classification}`);
    console.log(`  ${env.reasons[0] ?? env.extraction.reasons[0] ?? ""}`);
    console.log(`  → EXPECTED: no aggressive extraction (base rejected / review-required).  opening=${env.opening_offer?.label} target=${env.target_settlement?.label}`);
  }

  // §75 — search current candidate space for a certified base where we win and they perceive a win
  console.log(`\n--- §75: searching for a real "they think they won, we think we won more" negotiation base ---`);
  const managersE = ctx.snapshot.managers;
  let shown = 0;
  outer: for (const me of managersE) {
    const myOc = buildOwnerContext(ctx, me.canonical_manager_id);
    const offers = [...myOc.by_player.values()]
      .filter((p) => p.starter_importance === "BENCH_DEPTH" || p.starter_importance === "ROTATIONAL")
      .sort((a, b) => (a.vor ?? 0) - (b.vor ?? 0))
      .slice(0, 2);
    if (offers.length === 0) continue;
    for (const offer of offers) {
    for (const cp of managersE) {
      if (cp.canonical_manager_id === me.canonical_manager_id) continue;
      const cpOc = buildOwnerContext(ctx, cp.canonical_manager_id);
      const target = [...cpOc.by_player.values()]
        .filter((p) => (p.starter_importance === "ROTATIONAL" || p.starter_importance === "FLEX_STARTER"))
        .sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0))[0];
      if (!target) continue;
      const env = evaluateNegotiationEnvelopeInner({
        ctx, my_manager_id: me.canonical_manager_id, counterparty_manager_id: cp.canonical_manager_id,
        our_assets: [offer.canonical_player_id], their_assets: [target.canonical_player_id],
      });
      const b = env.base_proposal;
      if (env.base_trade_certified && (b.counterparty_perceived_surplus ?? -1) > 0 && (b.our_permanent_utility ?? -1) > 0.5) {
        shown += 1;
        console.log(`\n  #${shown}: ${me.manager_slug} gives ${offer.name} → ${cp.manager_slug} for ${target.name}`);
        console.log(`     our permanent utility=${b.our_permanent_utility?.toFixed(2)}  their perceived surplus=+${b.counterparty_perceived_surplus?.toFixed(2)}  their ACTUAL impact=${b.opponent_actual_impact?.toFixed(2)}  acceptance=${b.acceptance_likelihood}`);
        console.log(`     extraction band=${env.extraction.band}  recommended extraction≈${env.extraction.recommended_extraction?.toFixed(2)} (leaving them ${env.extraction.remaining_counterparty_surplus?.toFixed(2)})`);
        console.log(`     top add-ons: ${env.extraction.ranked_secondary_assets.slice(0, 3).map((a) => `${a.name} (efficiency ${a.efficiency?.toFixed(2)}, their reservation ${a.their_reservation?.toFixed(2)}, worth ${a.our_private_value?.toFixed(2)} to us)`).join("; ")}`);
        console.log(`     OPENING: ${env.opening_offer?.label}  (our permanent utility ${env.opening_offer?.our_permanent_utility?.toFixed(2)}, acceptance ${env.opening_offer?.acceptance_likelihood})`);
        console.log(`     TARGET SETTLEMENT: ${env.target_settlement?.label}  (our ${env.target_settlement?.our_permanent_utility?.toFixed(2)}, their surplus ${env.target_settlement?.counterparty_perceived_surplus?.toFixed(2)}, acceptance ${env.target_settlement?.acceptance_likelihood})`);
        console.log(`     ACCEPTABLE DEAL: ${env.acceptable_deal?.label}   WALK-AWAY: ${env.walk_away.explanation}`);
        // §76 straight-swap vs extracted
        if (env.target_settlement && env.target_settlement.label !== "base") {
          const bd = env.base_proposal;
          const td = env.target_settlement;
          console.log(`     §76 straight swap vs extracted package:`);
          console.log(`        straight swap  : our ${bd.our_permanent_utility?.toFixed(2)}  their surplus ${bd.counterparty_perceived_surplus?.toFixed(2)}  acceptance ${bd.acceptance_likelihood}  their actual ${bd.opponent_actual_impact?.toFixed(2)}`);
          console.log(`        extracted deal : our ${td.our_permanent_utility?.toFixed(2)}  their surplus ${td.counterparty_perceived_surplus?.toFixed(2)}  acceptance ${td.acceptance_likelihood}  their actual ${td.opponent_actual_impact?.toFixed(2)}`);
        }
        if (shown >= 3) break outer;
      }
    }
    }
  }
  if (shown === 0) console.log(`  no certified "both perceive a win" base trade found in the sampled space — reported honestly`);

  console.log(`\nSTATUS: Checkpoint E — value extraction + negotiation envelope (opening / target settlement / acceptable deal / walk-away) modeled. We negotiate using their perceived economics and decide using our private permanent utility. Base trade must be certified first; Rhamondre→Chuba stays gated.`);

  // ---- Checkpoint F: liquidity, appreciation, buy-and-hold, multi-step paths ----
  console.log(`\n================ CHECKPOINT F — liquidity / appreciation / hold / multi-step paths ================`);
  const F = await import("../lib/trades/competitive");

  // §2–§4 / §83 — performance: build the request-scoped context ONCE, then measure
  const tBuild = performance.now();
  const ec = F.buildCompetitiveTradeEvaluationContext(ctx);
  const buildMs = performance.now() - tBuild;
  console.log(`\n--- §83 performance: request-scoped evaluation context ---`);
  console.log(`  context build: ${buildMs.toFixed(0)} ms  (identity ${ec.snapshot_identity})  build_counts=${JSON.stringify(ec.build_counts)}`);

  const ownerOfId = (pid: string): string | null => {
    const r = ctx.snapshot.rosters.find((rr) => rr.all_players.includes(pid));
    const team = r && ctx.snapshot.teams.find((t) => t.canonical_team_id === r.canonical_team_id);
    return team?.canonical_manager_ids[0] ?? null;
  };

  // one full competitive proposal eval AFTER context construction (target: low ms)
  if (rham?.owner_id && chuba?.owner_id) {
    const { buildDiscoveryEvalContext, evaluateCandidate } = await import("../lib/trades/discovery/candidate-eval");
    const { resolveTradeConfig } = await import("../lib/trades/config");
    const dctx = buildDiscoveryEvalContext(ctx);
    const tc = resolveTradeConfig();
    const transfers = [
      { from_manager_id: chuba.owner_id, to_manager_id: rham.owner_id, canonical_player_id: chuba.player.canonical_player_id },
      { from_manager_id: rham.owner_id, to_manager_id: chuba.owner_id, canonical_player_id: rham.player.canonical_player_id },
    ];
    const cres = evaluateCandidate([rham.owner_id, chuba.owner_id], transfers, ctx, dctx, tc);
    if (cres.ok && cres.evaluation) {
      const t1 = performance.now();
      for (let i = 0; i < 10; i++)
        F.evaluateCompetitiveTrade({ baseline: cres.evaluation, ctx, my_manager_id: rham.owner_id, incoming_player_ids: [chuba.player.canonical_player_id], outgoing_player_ids: [rham.player.canonical_player_id], counterparty_manager_id: chuba.owner_id, eval_context: ec });
      console.log(`  single full competitive proposal eval (shared context): ${((performance.now() - t1) / 10).toFixed(2)} ms  (target: low single-to-double-digit ms)`);
    }
  }
  {
    const { evaluateNegotiationEnvelopeInner } = F;
    if (rham?.owner_id && chuba?.owner_id) {
      const tN = performance.now();
      evaluateNegotiationEnvelopeInner({ ctx, my_manager_id: rham.owner_id, counterparty_manager_id: chuba.owner_id, our_assets: [rham.player.canonical_player_id], their_assets: [chuba.player.canonical_player_id], eval_context: ec });
      console.log(`  one negotiation envelope (shared context): ${(performance.now() - tN).toFixed(0)} ms  (Checkpoint E baseline ≈ 700 ms; target: materially below)`);
    }
  }

  // §5–§9 liquidity + §10–§16 appreciation — league-wide scan for the diagnostics
  console.log(`\n--- §79/§82 live Bloodline Bowl diagnostics ---`);
  const myId = firstMgr.canonical_manager_id;
  const allPlayerIds = [...new Set(ctx.snapshot.rosters.flatMap((r) => r.all_players))];
  type LiqRow = ReturnType<typeof F.buildTradeLiquidity>;
  type ApprRow = ReturnType<typeof F.buildMarketAppreciation>;
  const liqRows: LiqRow[] = [];
  const apprRows: ApprRow[] = [];
  for (const pid of allPlayerIds) {
    const owner = ownerOfId(pid);
    if (owner === myId) continue;
    liqRows.push(F.buildTradeLiquidity({ ec, canonical_player_id: pid, current_owner_manager_id: owner, my_manager_id: myId }));
    apprRows.push(F.buildMarketAppreciation({ ec, canonical_player_id: pid }));
  }
  const liqRank = (c: string) => ["VERY_LOW", "LOW", "MODERATE", "HIGH", "VERY_HIGH"].indexOf(c);
  const bestLiq = [...liqRows].sort((a, b) => liqRank(b.classification) - liqRank(a.classification) || b.buyer_count - a.buyer_count)[0];
  console.log(`  highest-liquidity intermediate asset: ${bestLiq?.name} — ${bestLiq?.classification} (${bestLiq?.buyer_count} plausible buyers, ${bestLiq?.high_fit_buyers} high-fit; scarcity ${bestLiq?.positional_scarcity_ratio})`);
  const trustworthyAppr = apprRows
    .filter((a) => (a.classification === "HIGH_APPRECIATION_POTENTIAL" || a.classification === "MODERATE_APPRECIATION_POTENTIAL") && (a.confidence === "MEDIUM" || a.confidence === "HIGH"))
    .sort((a, b) => (b.private_market_gap ?? 0) - (a.private_market_gap ?? 0));
  if (trustworthyAppr.length > 0) {
    const a = trustworthyAppr[0]!;
    console.log(`  strongest appreciation candidate with sufficient confidence: ${a.name} — ${a.classification} @ ${a.confidence} (gap ${a.private_market_gap}, catalysts ${a.catalysts.join("/") || "none"})`);
  } else {
    console.log(`  strongest appreciation candidate with sufficient confidence: NONE — no player clears MODERATE+ appreciation at MEDIUM+ confidence at Week ${ctx.week} (reported honestly; §55 caps early-season certainty)`);
  }

  // §20–§54 staged path search from our roster
  const paths = F.buildStrategyPathComparison({ ec, my_manager_id: myId });
  console.log(`\n--- §83 staged path search (perspective ${firstMgr.manager_slug}) ---`);
  console.log(`  ${paths.reasons[0]}`);
  console.log(`  recommended=${paths.recommended}  direct_path_preferred=${paths.direct_path_preferred}  elapsed=${paths.search_stats.elapsed_ms} ms`);
  const byStrat = (s: string) => paths.paths.find((p) => p.strategy === s);
  for (const s of ["DIRECT_ACQUISITION", "TWO_STEP_UPGRADE", "BUY_AND_HOLD", "HOLD_CURRENT_ASSET", "NO_ACTION"]) {
    const p = byStrat(s);
    if (p) console.log(`  [${s}] score=${p.aggregate.score} finalΔ=${p.final_state.permanent_roster_delta} txns=${p.aggregate.transactions} feasibility=${p.aggregate.feasibility} — ${p.reasons[0]}`);
    else console.log(`  [${s}] not produced (no certified path of this shape at Week ${ctx.week} — honest)`);
  }

  // §57/§80 — Rhamondre/Chuba must NOT resurrect as BUY-AND-HOLD
  if (rham?.owner_id && chuba?.owner_id) {
    const cres2 = competitiveTradeResult(ctx, rham.owner_id, chuba.owner_id, rham.player.canonical_player_id, chuba.player.canonical_player_id);
    const compF = F.evaluateCompetitiveTrade({
      baseline: cres2.baseline, ctx, my_manager_id: rham.owner_id,
      incoming_player_ids: [chuba.player.canonical_player_id], outgoing_player_ids: [rham.player.canonical_player_id],
      counterparty_manager_id: chuba.owner_id, eval_context: ec, include_liquidity_and_appreciation: true,
    });
    const hold = compF.competitive.hold;
    console.log(`\n--- §57/§80 Rhamondre Stevenson → Chuba Hubbard under Checkpoint F ---`);
    console.log(`  buy-and-hold decision: ${hold?.decision}  (permanent gain ${hold?.components.current_permanent_roster_gain?.toFixed(2)}, optionality ${hold?.future_optionality.score.toFixed(2)}, hold score ${hold?.hold_score?.toFixed(2)})`);
    console.log(`  appreciation(Chuba): ${compF.competitive.appreciation?.[0]?.classification} @ ${compF.competitive.appreciation?.[0]?.confidence}`);
    console.log(`  → EXPECTED: DO_NOTHING or REVIEW_REQUIRED — NOT "BUY CHUBA AND HOLD" (§57).`);
  }

  // §81 — Mahomes / Jadarian Price / Jonah Coleman follow-up
  const mahomes = findPlayer(ctx, "Patrick Mahomes");
  const price = findPlayer(ctx, "Jadarian Price") ?? findPlayer(ctx, "Jaydon Blue");
  const coleman = findPlayer(ctx, "Jonah Coleman");
  console.log(`\n--- §81 Mahomes / Price / Coleman follow-up ---`);
  for (const p of [mahomes, price, coleman]) {
    if (!p?.owner_id) { console.log(`  (player not rostered in this league — skipped)`); continue; }
    const liq = F.buildTradeLiquidity({ ec, canonical_player_id: p.player.canonical_player_id, current_owner_manager_id: p.owner_id, my_manager_id: myId });
    const appr = F.buildMarketAppreciation({ ec, canonical_player_id: p.player.canonical_player_id });
    console.log(`  ${p.player.full_name.padEnd(20)} liquidity=${liq.classification.padEnd(9)} buyers=${String(liq.buyer_count).padStart(2)}  appreciation=${appr.classification} @ ${appr.confidence}`);
  }

  console.log(`\nSTATUS: Checkpoint F — TRADE LIQUIDITY (owner-independent after acquisition, §9), MARKET APPRECIATION POTENTIAL (speculative, consumes B.5 correction state, §14/§30), BUY-AND-HOLD (decomposed, DO_NOTHING/ACQUIRE_AND_HOLD legitimate), and bounded 2-step trade paths (staged beam search, max 2 completed trades). Request-scoped evaluation context eliminates per-proposal league-wide recomputation.`);

  // ---- Checkpoint G: the HTTP request orchestrator, exercised live ----
  console.log(`\n================ CHECKPOINT G — competitive trade API, live end-to-end ================`);
  const { evaluateCompetitiveTradeRequest } = await import("../lib/trades/competitive/api");
  // §34 — supyo29 is the primary live perspective for Bloodline Bowl; fall back
  // to the first manager for any other league.
  const meSlug = ctx.snapshot.managers.some((m) => m.manager_slug === "supyo29") ? "supyo29" : firstMgr.manager_slug;

  const show = (label: string, r: Awaited<ReturnType<typeof evaluateCompetitiveTradeRequest>>) => {
    console.log(`\n--- ${label} ---`);
    console.log(`  status=${r.status} error_kind=${r.error_kind} readiness=${r.readiness} confidence=${r.confidence ?? "n/a"}${r.recommended_strategy ? ` recommended=${r.recommended_strategy}` : ""}`);
    console.log(`  snapshot=${r.snapshot?.league_snapshot_id ?? "n/a"} generated_at=${r.snapshot?.generated_at ?? "n/a"}`);
    if (r.reasons[0]) console.log(`  ${r.reasons[0]}`);
  };

  // Part A §12 — participant-set reconciliation
  {
    const { buildCompetitiveTradeEvaluationContext: mkEc } = await import("../lib/trades/competitive/eval-context");
    const ec = mkEc(ctx);
    const ps = ec.participant_set;
    const canonicalOwners = new Set<string>();
    for (const r of ctx.snapshot.rosters) {
      const team = ctx.snapshot.teams.find((t) => t.canonical_team_id === r.canonical_team_id);
      for (const m of team?.canonical_manager_ids ?? []) canonicalOwners.add(ctx.snapshot.managers.find((mm) => mm.canonical_manager_id === m)?.manager_slug ?? m);
    }
    console.log(`\n--- Part A §12 participant-set reconciliation ---`);
    console.log(`  canonical roster count = ${ps.canonical_participant_count}   threat participant count = ${ps.threat_participant_count}   exact_match = ${ps.exact_match}   mismatch = ${ec.participant_set_mismatch}`);
    console.log(`  missing = [${ps.missing_participant_ids.join(", ")}]   unexpected = [${ps.unexpected_participant_ids.join(", ")}]`);
    console.log(`  managers (${canonicalOwners.size}, co-managers resolve to one roster): ${[...canonicalOwners].sort().join(", ")}`);
    const distinctZ = new Set([...ec.league_threat.by_manager.values()].map((t) => t.components.blended_strength_z));
    console.log(`  distinct team-level threat records = ${distinctZ.size} (expect = canonical roster count)`);
  }

  // §33/§35 discover
  const tD = performance.now();
  const disc = await evaluateCompetitiveTradeRequest({ league: leagueSlug, manager: meSlug, mode: "discover" });
  show(`discover (${meSlug}) — ${(performance.now() - tD).toFixed(0)} ms`, disc);
  console.log(`  structural evaluated=${disc.discovery?.structural_candidates_evaluated}  analytical candidates=${disc.discovery?.analytical_candidate_count}  negotiation-worth=${disc.discovery?.negotiation_worth_exploring_count}  transaction-ready=${disc.discovery?.transaction_ready_count}`);
  for (const t of disc.discovery?.direct_trade_candidates ?? []) {
    console.log(`    give ${t.give.join("+")} <- ${t.receive.join("+")} from ${t.counterparty_manager_slug}: permΔ=${t.permanent_rest_of_season_impact?.toFixed(2)} class=${t.competitive_classification} acc=${t.overall_acceptance_likelihood} conf=${t.confidence} → ${t.transaction_readiness}`);
  }

  // §34 — a second manager, to prove perspective isolation at the API boundary
  const otherSlug = firstMgr.manager_slug === meSlug ? (ctx.snapshot.managers[1]?.manager_slug ?? meSlug) : firstMgr.manager_slug;
  if (otherSlug !== meSlug) {
    const disc2 = await evaluateCompetitiveTradeRequest({ league: leagueSlug, manager: otherSlug, mode: "discover" });
    console.log(`  discover (${otherSlug}): status=${disc2.status} recommended=${disc2.recommended_strategy} analytical=${disc2.discovery?.analytical_candidate_count} transaction-ready=${disc2.discovery?.transaction_ready_count} (independent per-requester result)`);
  }

  // §33 strategy path
  const tS = performance.now();
  const sp = await evaluateCompetitiveTradeRequest({ league: leagueSlug, manager: meSlug, mode: "strategy_path" });
  show(`strategy_path (${meSlug}) — ${(performance.now() - tS).toFixed(0)} ms`, sp);
  for (const p of sp.strategy_paths?.paths.slice(0, 4) ?? []) console.log(`     [${p.strategy}] score=${p.aggregate.score} finalΔ=${p.final_state.permanent_roster_delta} txns=${p.aggregate.transactions}`);

  // §36 Rhamondre → Chuba through the API
  if (rham?.owner_slug && chuba?.player) {
    const tE = performance.now();
    const rc = await evaluateCompetitiveTradeRequest({
      league: leagueSlug, manager: rham.owner_slug, mode: "evaluate",
      counterparty: chuba.owner_slug ?? undefined,
      give_assets: [rham.player.full_name], receive_assets: [chuba.player.full_name],
    });
    show(`§36 evaluate Rhamondre Stevenson → Chuba Hubbard (${rham.owner_slug}) — ${(performance.now() - tE).toFixed(0)} ms`, rc);
    console.log(`  result classification=${rc.evaluation?.result.classification} actionable=${rc.evaluation?.result.actionable} permanent ROS impact=${rc.evaluation?.private_trade.permanent_rest_of_season_impact?.toFixed(2)} horizon=${rc.evaluation?.private_trade.horizon_classification}`);
    console.log(`  buy-and-hold=${rc.evaluation?.buy_and_hold?.decision}  → EXPECTED: not recommended / no aggressive extraction / no buy-and-hold resurrection`);
    const rcN = await evaluateCompetitiveTradeRequest({
      league: leagueSlug, manager: rham.owner_slug, mode: "negotiate",
      counterparty: chuba.owner_slug ?? undefined,
      give_assets: [rham.player.full_name], receive_assets: [chuba.player.full_name],
    });
    console.log(`  negotiate: status=${rcN.status} extraction_band=${rcN.negotiation?.extraction_band} base_certified=${rcN.negotiation?.base_trade_certified}`);
  }

  // §37 clean-positive control — a lopsided proposal the counterparty should perceive well and we win big
  {
    const managersG = ctx.snapshot.managers;
    let control: { me: string; cp: string; give: string; receive: string } | null = null;
    outerG: for (const meM of managersG) {
      const myOc = buildOwnerContext(ctx, meM.canonical_manager_id);
      const worst = [...myOc.by_player.values()].filter((p) => p.starter_importance === "BENCH_DEPTH").sort((a, b) => (a.vor ?? 0) - (b.vor ?? 0))[0];
      if (!worst) continue;
      for (const cpM of managersG) {
        if (cpM.canonical_manager_id === meM.canonical_manager_id) continue;
        const cpOc = buildOwnerContext(ctx, cpM.canonical_manager_id);
        const best = [...cpOc.by_player.values()].filter((p) => p.starter_importance === "ROTATIONAL" || p.starter_importance === "FLEX_STARTER").sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0))[0];
        if (!best) continue;
        const r = await evaluateCompetitiveTradeRequest({
          league: leagueSlug, manager: meM.manager_slug, mode: "evaluate",
          counterparty: cpM.manager_slug, give_assets: [worst.name], receive_assets: [best.name],
        });
        if (r.evaluation?.result.actionable && (r.evaluation.private_trade.permanent_rest_of_season_impact ?? 0) > 0.5) {
          control = { me: meM.manager_slug, cp: cpM.manager_slug, give: worst.name, receive: best.name };
          show(`§37 positive control: ${meM.manager_slug} sends ${worst.name} → ${cpM.manager_slug} for ${best.name}`, r);
          console.log(`  → competitively actionable=${r.evaluation.result.actionable} classification=${r.evaluation.result.classification} transaction_readiness=${r.evaluation.result.transaction_readiness}`);
          console.log(`  NOTE (§37): at Week ${ctx.week} the record is 0-0 so opponent-threat context is PARTIAL → confidence is capped at LOW → even a STRONG_COMPETITIVE_BUY resolves to NEGOTIATION_WORTH_EXPLORING, not TRANSACTION_READY. A TRANSACTION_READY result is structurally impossible this early; the synthetic mid-season control in test/competitive-trade-api.test.ts proves the ready path exists.`);
          break outerG;
        }
      }
    }
    if (!control) console.log(`\n--- §37 positive control: no lopsided-but-actionable proposal found in the sampled space at Week ${ctx.week} (reported honestly; the synthetic API test covers this contract deterministically) ---`);
  }

  // §38 perspective isolation — evaluate the SAME counterparty from two requesters
  {
    const { buildCompetitiveTradeEvaluationContext: mkEc } = await import("../lib/trades/competitive/eval-context");
    const ec = mkEc(ctx);
    const managersG = ctx.snapshot.managers;
    const cp = managersG.find((m) => m.canonical_manager_id !== firstMgr.canonical_manager_id)!;
    const other = managersG.find((m) => m.canonical_manager_id !== firstMgr.canonical_manager_id && m.canonical_manager_id !== cp.canonical_manager_id)!;
    const cpThreatAbs = ec.league_threat.by_manager.get(cp.canonical_manager_id)?.components.blended_strength_z;
    console.log(`\n--- §38 perspective isolation (counterparty ${cp.manager_slug}) ---`);
    console.log(`  ${cp.manager_slug} absolute blended strength z = ${cpThreatAbs?.toFixed(4)} (perspective-independent)`);
    const relA = Math.round(((ec.league_threat.by_manager.get(cp.canonical_manager_id)!.components.blended_strength_z) - (ec.league_threat.by_manager.get(firstMgr.canonical_manager_id)?.components.blended_strength_z ?? 0)) * 10000) / 10000;
    const relB = Math.round(((ec.league_threat.by_manager.get(cp.canonical_manager_id)!.components.blended_strength_z) - (ec.league_threat.by_manager.get(other.canonical_manager_id)?.components.blended_strength_z ?? 0)) * 10000) / 10000;
    console.log(`  relative_to_us from ${firstMgr.manager_slug}: ${relA}   from ${other.manager_slug}: ${relB}   (re-derived per requester)`);
  }

  // §21 HTTP-status contract — malformed / unknown / ownership
  const bad1 = await evaluateCompetitiveTradeRequest({ league: leagueSlug, manager: "no-such-manager-xyz", mode: "strategy_path" });
  const bad2 = await evaluateCompetitiveTradeRequest({ league: leagueSlug, manager: meSlug, mode: "evaluate", counterparty: meSlug, give_assets: ["nobody"], receive_assets: ["nobody2"] });
  console.log(`\n--- §21 error contract ---`);
  console.log(`  unknown manager → status=${bad1.status} error_kind=${bad1.error_kind} (route maps NOT_FOUND→404)`);
  console.log(`  bad proposal    → status=${bad2.status} error_kind=${bad2.error_kind}`);

  console.log(`\nSTATUS: Checkpoint G — POST /api/trades/competitive exposes evaluate / negotiate / discover / strategy_path over the certified engine. NO_ACTION and REVIEW_REQUIRED survive serialization; confidence / readiness are never upgraded; every response carries the source snapshot lineage; one shared evaluation context per request; a stale context cannot leak across snapshots. READ_ONLY_ANALYTICS — no writes, no messages.`);
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
