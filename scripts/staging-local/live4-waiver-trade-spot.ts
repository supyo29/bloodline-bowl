/**
 * LIVE PHASE 4 (local Docker Supabase only; real providers read-only): the two Wave 1 staging-checklist spot checks that need REAL players.
 *   WAIVER: real Bloodline Bowl roster/forecasts through the REAL buildWaiverRecommendations. The certified free-agent pool is UNAVAILABLE in every
 *           real context (fail-closed), so ONLY the pool is grafted (one synthetic free agent) — roster, forecasts, injury model and asset values are real.
 *           Pass: the engine never offers a real bye star / injured star as the drop merely because his CURRENT-week value is depressed.
 *   TRADE:  the REAL evaluateTradeHorizons with a real star's real forecast row vs an equal healthy player: the availability term must be priced from
 *           ROS availability, never from a bye zero.
 */
import { check, finish, info } from "./lib";
import { buildCanonicalLeagueState } from "../../lib/canonical/state";
import { buildWeeklyTeamContext } from "../../lib/weekly/context";
import { buildWaiverRecommendations } from "../../lib/weekly/waivers";
import { evaluateTradeHorizons } from "../../lib/trades/competitive/horizon";
import { weeklyContext, player, proj, roster as fxRoster } from "../../test/fixtures/weekly";

async function main(): Promise<void> {
  const st = await buildCanonicalLeagueState("bloodline-bowl", { reportPersistence: false });
  const snap = st.snapshot!;
  const rostered = new Set(snap.rosters.flatMap((r) => r.all_players));
  const out: Array<Record<string, unknown>> = [];
  let realByeStars = 0, realInjuredStars = 0, wrongDrops = 0, decisions = 0, unavailableProvedFailClosed = 0;

  for (const mgr of snap.managers) {
    const ctx0 = (await buildWeeklyTeamContext("bloodline-bowl", mgr.manager_slug, { snapshotOverride: snap })).context;
    if (!ctx0?.forecasts) continue;
    // fail-closed baseline: the REAL context must refuse to recommend without a certified pool
    const real = buildWaiverRecommendations(ctx0) as unknown as { availability_status: string };
    if (real.availability_status === "UNAVAILABLE") unavailableProvedFailClosed++;
    // graft ONLY the pool (shape from the standard fixture builder) + one free agent that is a clear upgrade over bench filler
    const tpl = weeklyContext({ myRoster: fxRoster("team:t:1", ["a"], []), players: [player("a", "WR")], freeAgents: [player("faWR", "WR", { team: "KC", name: "Synthetic Free Agent" })], projections: [proj("a", "WR", 1)], faProjections: [proj("faWR", "WR", 11, { rest_of_season_points: 130 })] });
    const ctx = { ...ctx0, availability: { ...ctx0.availability, free_agents: tpl.availability.free_agents }, free_agent_pool_readiness: tpl.free_agent_pool_readiness };
    ctx.projections.by_player.set("faWR", tpl.projections.by_player.get("faWR")!);
    const mine = new Set(ctx.roster.all_players);
    const f = (id: string) => ctx.forecasts!.by_player.get(id);
    const stars = [...mine].map((id) => ({ id, f: f(id) })).filter((x) => x.f && (x.f.asset_context?.asset_value?.hold_points_per_week ?? x.f.weekly_value?.underlying_points_if_game_played ?? 0) >= 10);
    const byeStars = stars.filter((x) => x.f!.value_state === "BYE_VERIFIED");
    const injStars = stars.filter((x) => ["QUESTIONABLE", "DOUBTFUL", "OUT"].includes(x.f!.injury_model.normalized_state) || x.f!.injury_model.availability_state === "UNAVAILABLE");
    realByeStars += byeStars.length; realInjuredStars += injStars.length;
    const w = buildWaiverRecommendations(ctx) as unknown as { availability_status?: string; recommendations: Array<{ add_player_id: string; drop_player_id: string | null; priority: string; drop_cost?: number }> };
    const rec = w.recommendations.find((r) => r.add_player_id === "faWR");
    if (!rec) continue;
    decisions++;
    const dropped = rec.drop_player_id ? f(rec.drop_player_id) : null;
    const guarded = new Set([...byeStars, ...injStars].map((x) => x.id));
    const bad = !!(rec.drop_player_id && guarded.has(rec.drop_player_id) && rec.priority !== "DO_NOT_ADD");
    if (bad) wrongDrops++;
    out.push({ manager: mgr.manager_slug, bye_stars: byeStars.map((x) => x.id), injured_stars: injStars.map((x) => x.id), drop: rec.drop_player_id, priority: rec.priority, drop_cost: rec.drop_cost, dropped_state: dropped?.value_state ?? null, wrong: bad });
  }
  info("WAIVER", "per-manager graft results (real roster/forecasts, synthetic pool)", out);
  await check("WAIVER", "the REAL (ungrafted) context refuses waiver output: the certified pool is UNAVAILABLE and nothing is claimed (fail-closed intact on real data)", async () => ({ ok: unavailableProvedFailClosed > 0, detail: { managers_failing_closed: unavailableProvedFailClosed } }));
  await check("WAIVER", "real bye/injured stars exist on real rosters to exercise the guard", async () => ({ ok: realByeStars + realInjuredStars > 0, detail: { real_bye_stars: realByeStars, real_injured_or_questionable_stars: realInjuredStars, decisions } }));
  await check("WAIVER", "no real bye star / injured star is recommended as the drop for an 11-point free agent (asset value, not the depressed current week, prices the drop)", async () => ({ ok: decisions > 0 && wrongDrops === 0, detail: { decisions, wrong_drops: wrongDrops } }));

  /* ---------------- TRADE: real forecast rows -> real horizon evaluator ---------------- */
  const mgr = snap.managers[0]!;
  const ctx = (await buildWeeklyTeamContext("bloodline-bowl", mgr.manager_slug, { snapshotOverride: snap })).context!;
  const fs = [...ctx.forecasts!.by_player.values()].filter((x) => rostered.has(x.canonical_player_id));
  const pick = (pred: (x: (typeof fs)[number]) => boolean) => fs.filter(pred).sort((a, b) => (b.weekly_value.underlying_points_if_game_played ?? 0) - (a.weekly_value.underlying_points_if_game_played ?? 0))[0];
  const bye = pick((x) => x.value_state === "BYE_VERIFIED");
  const healthy = pick((x) => x.value_state !== "BYE_VERIFIED" && !x.injury_model.normalized_state.match(/OUT|QUESTIONABLE|DOUBTFUL/) && (x.weekly_value.underlying_points_if_game_played ?? 0) > 0);
  const injured = pick((x) => x.injury_model.availability_state === "UNAVAILABLE" && !x.game_status.is_bye);
  info("TRADE", "real subjects", { bye: bye?.canonical_player_id, healthy: healthy?.canonical_player_id, out_not_bye: injured?.canonical_player_id });
  const part = () => ({ manager_slug: "us", roster_utility_delta: 0, starter_points_delta: 0, bench_value_delta: 0, roster_utility_components: { starter_points: 0, starter_vor: 0, bench_value: 0, positional_need: 0 }, phase2: { ros: { ros_usable_value_delta: 0, before: { stranded_ros_points: 0 }, after: { stranded_ros_points: 0 }, standalone_ros_swing: 0 }, components: { playoff_window: null, bye_coverage: 0 } } });
  const weeks = Array.from({ length: 12 }, (_, i) => ctx.league.week + i);
  const price = (giveId: string, getId: string) => {
    const by = new Map<string, unknown>();
    for (const id of [giveId, getId]) by.set(id, ctx.projections.by_player.get(id));
    const c = { week: ctx.league.week, ros: { weeks, schedule_status: "READY", championship_week: 17 }, projections: { by_player: by }, players_by_id: new Map() } as never;
    const h = evaluateTradeHorizons({ baseline: { participants: { us: part() } } as never, ctx: c, manager_slug: "us", incoming_ids: [getId], outgoing_ids: [giveId] });
    return { availability_delta: h.ros.availability_delta, permanent: h.permanent_trade_utility };
  };
  if (bye && healthy) {
    const give = price(bye.canonical_player_id, healthy.canonical_player_id);
    const giveHealthy = price(healthy.canonical_player_id, healthy.canonical_player_id === bye.canonical_player_id ? healthy.canonical_player_id : bye.canonical_player_id);
    info("TRADE", "give real bye star / receive real healthy player", { give_bye: give, give_healthy_receive_bye: giveHealthy, bye_ros: ctx.projections.by_player.get(bye.canonical_player_id)?.rest_of_season_points, healthy_ros: ctx.projections.by_player.get(healthy.canonical_player_id)?.rest_of_season_points });
    await check("TRADE", "a real bye star is NOT priced as a one-week zero: giving him is not charged a bye-zero availability penalty larger than one week of his value", async () => {
      const oneWeek = (bye.weekly_value.underlying_points_if_game_played ?? 0);
      return { ok: Math.abs(give.availability_delta ?? 0) <= oneWeek * 1.01 + 0.01, detail: { availability_delta: give.availability_delta, one_week_value: oneWeek } };
    });
  } else info("TRADE", "NOT RUN: no real bye star / healthy comparison on any roster this week", { bye: !!bye, healthy: !!healthy }, "BLOCKED");
  if (injured) {
    const comp = healthy ?? bye;
    const r = comp ? price(injured.canonical_player_id, comp.canonical_player_id) : null;
    info("TRADE", "give real OUT (non-bye) player", { id: injured.canonical_player_id, result: r, status: injured.availability.injury_status });
    await check("TRADE", "a real OUT player's availability is priced from his rest-of-season availability (finite, not NaN)", async () => ({ ok: !!r && Number.isFinite(r.availability_delta ?? 0), detail: r }));
  } else info("TRADE", "NOT RUN: no real OUT (non-bye) rostered player this week", {}, "BLOCKED");
  finish("docs/evidence/w2p2-local-staging-live4-waiver-trade.json");
}
main().catch((e) => { console.error(e); process.exit(2); });
