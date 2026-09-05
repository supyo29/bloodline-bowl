/**
 * PHASE 6 — real-league, read-only strategic-context smoke test.
 *
 *   npx tsx scripts/phase6-real-league-smoke-test.ts
 *
 * Read-only: builds strategic profiles and runs one strategy-aware discovery
 * + one strategy-aware negotiation call against the REAL registered leagues.
 * Nothing is mutated.
 */
import { buildTradeAnalysisContext } from "../lib/trades/context";
import { resolveManager } from "../lib/canonical/manager-context";
import { buildManagerStrategicProfile } from "../lib/trades/strategy/profile";
import { discoverTrades } from "../lib/trades/discovery/discover";
import { negotiateTrade } from "../lib/trades/negotiation/negotiate";

async function reportLeague(leagueSlug: string) {
  console.log(`\n########## ${leagueSlug} ##########`);
  const ctxResult = await buildTradeAnalysisContext(leagueSlug);
  if (!ctxResult.context) {
    console.log(`ERROR: context unavailable (${ctxResult.code}): ${ctxResult.detail}`);
    return;
  }
  const ctx = ctxResult.context;
  console.log(`season=${ctx.season} week=${ctx.week}`);
  console.log(`playoff_settings=${JSON.stringify(ctx.snapshot.league.playoff_settings)}`);
  console.log(`standings (${ctx.snapshot.standings.length} teams):`);
  for (const s of ctx.snapshot.standings) {
    const team = ctx.snapshot.teams.find((t) => t.canonical_team_id === s.canonical_team_id);
    const mgrSlugs = team?.canonical_manager_ids.map((id) => ctx.snapshot.managers.find((m) => m.canonical_manager_id === id)?.manager_slug ?? id).join(",");
    console.log(`  rank=${s.rank} ${mgrSlugs} ${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ""} pf=${s.points_for}`);
  }

  const managers = ctx.snapshot.managers;
  const sampleSlugs = [managers[0]?.manager_slug, managers[Math.floor(managers.length / 2)]?.manager_slug, managers.at(-1)?.manager_slug].filter((s, i, arr): s is string => !!s && arr.indexOf(s) === i);

  for (const slug of sampleSlugs) {
    const m = resolveManager(ctx.snapshot.managers, slug);
    if (!m) continue;
    const profile = buildManagerStrategicProfile(ctx, m.canonical_manager_id, m.manager_slug);
    console.log(`\n--- ${slug} ---`);
    console.log(`archetype=${profile.archetype} (${profile.archetype_reasons.join("; ")})`);
    console.log(`playoff_status=${profile.playoff.status} games_back=${profile.playoff.games_back} odds_band=${profile.playoff.playoff_odds_band}`);
    console.log(`urgency=${profile.urgency.score} preferred_horizons=${profile.preferred_horizons.join(",")}`);
    console.log(`diagnostics=${profile.diagnostics.join(",") || "(none)"}`);
  }

  const firstSlug = sampleSlugs[0];
  if (firstSlug) {
    console.log(`\n--- strategy-aware discovery for ${firstSlug} (BEST_AVAILABLE, include_strategic) ---`);
    try {
      const disc = await discoverTrades({ league: leagueSlug, manager: firstSlug, mode: "BEST_AVAILABLE", max_results: 3, include_strategic: true });
      console.log(`status=${disc.status} results=${disc.results.length} archetype=${disc.manager_strategic_profile?.archetype}`);
      for (const r of disc.results.slice(0, 3)) {
        console.log(`  my_gain=${r.my_gain} strategic_score=${r.strategic?.strategic_trade_score} recommendation=${r.strategic?.strategic_recommendation}`);
      }
    } catch (e) {
      console.log(`ERROR: ${(e as Error).message}`);
    }

    // Try a strategy-aware negotiation ACQUIRE_TARGET against a real rostered player owned by someone else.
    const otherManagerId = [...ctx.rosters_by_manager.keys()].find((id) => id !== resolveManager(ctx.snapshot.managers, firstSlug)?.canonical_manager_id);
    const targetId = otherManagerId ? ctx.rosters_by_manager.get(otherManagerId)?.all_players[0] : undefined;
    if (targetId) {
      console.log(`\n--- strategy-aware negotiation for ${firstSlug} acquiring ${targetId} ---`);
      try {
        const neg = await negotiateTrade({ league: leagueSlug, manager: firstSlug, target_player_id: targetId, include_strategic: true });
        console.log(`status=${neg.status} mode=${neg.mode}`);
        console.log(`strategic_offer_guidance=${JSON.stringify(neg.strategic_offer_guidance)}`);
      } catch (e) {
        console.log(`ERROR: ${(e as Error).message}`);
      }
    }
  }
}

async function main() {
  await reportLeague("bloodline-bowl");
  await reportLeague("devoted-to-the-game");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
