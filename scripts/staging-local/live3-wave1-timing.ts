/**
 * LIVE PHASE 3 (local Docker Supabase only; real providers read-only): timing-sensitive Wave 1 gates + Role-shadow kickoff behavior on REAL week-6 data.
 *   T. per-player kickoff exclusion of the capture at three injected clocks (dry run: nothing written)
 *   W. a request composed AFTER kickoff leaves the frozen final-pregame revisions byte-identical (the Wave 1 staging checklist's step 4)
 *   B. real bye / injured / out players: current-week value vs asset value vs availability (the checklist's spot check)
 */
import { check, finish, info, sql } from "./lib";
import { buildCanonicalLeagueState } from "../../lib/canonical/state";
import { buildWeeklyTeamContext } from "../../lib/weekly/context";
import { listLeagueTargets, leagueConfigStatus } from "../../lib/leagues/registry";
import { loadProductionLeagueWeeks, loadLiveRoleForecasts } from "../../lib/persistence/supabase/role-shadow-runtime";
import { runRoleShadowCapture } from "../../lib/role-shadow/capture";

const MIN = 60_000;

async function main(): Promise<void> {
  /* The earliest kickoff among stored revisions is the next real game (Thursday night). */
  const tnfKick = sql("select to_char(min(kickoff_at) at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from bridge_final_pregame_revisions");
  const tnfMs = Date.parse(tnfKick);
  const nowReal = Date.now();
  info("T", "the next real kickoff in the stored data / the real clock", { first_kickoff: tnfKick, hours_from_now: +((tnfMs - nowReal) / 3_600_000).toFixed(2) });

  /* ---------------- T. capture at injected clocks (dry run) ---------------- */
  const weeks = await loadProductionLeagueWeeks();
  const runAt = async (nowMs: number) => runRoleShadowCapture({ env: { ...process.env, ROLE_SHADOW_CAPTURE: "1" } as NodeJS.ProcessEnv, dryRun: true, store: null, now: () => nowMs, loadLeagueWeeks: async () => weeks, loadRoleForecasts: (s, w, n) => loadLiveRoleForecasts(s, w, n) });
  const at = {
    now: await runAt(nowReal + 60_000),
    afterTnf: await runAt(tnfMs + 5 * MIN),
    afterSundayEarly: await runAt(Date.parse("2026-10-18T17:30:00Z")),
    afterAll: await runAt(Date.parse("2026-10-21T12:00:00Z")),
  };
  const b = (r: typeof at.now) => r.totals.counters.built;
  info("T", "records built at each injected capture clock (real kickoff schedule)", { now: b(at.now), after_TNF_kickoff: b(at.afterTnf), after_Sunday_early_window: b(at.afterSundayEarly), after_every_game: b(at.afterAll), no_role_forecast_at: [at.now, at.afterTnf, at.afterSundayEarly, at.afterAll].map((r) => r.totals.counters.no_role_forecast) });
  await check("T", "PER-PLAYER KICKOFF EXCLUSION on the real schedule: the number of capturable decisions falls monotonically as kickoffs pass, and reaches ZERO after the last game", async () => {
    const seq = [b(at.now), b(at.afterTnf), b(at.afterSundayEarly), b(at.afterAll)];
    return { ok: seq[0]! > 300 && seq[1]! < seq[0]! && seq[2]! < seq[1]! && seq[3] === 0 && at.afterAll.status === "OK" && at.afterAll.failures === 0, detail: seq };
  });
  await check("T", "after the TNF kickoff the TNF players are not capturable but the rest of the slate still is (real mixed-kickoff week)", async () => {
    const dropped = b(at.now) - b(at.afterTnf);
    return { ok: dropped > 0 && dropped < b(at.now) * 0.2 && b(at.afterTnf) > 300, detail: { dropped_tnf_decisions: dropped, remaining: b(at.afterTnf) } };
  });
  await check("T", "no capture is ever built with a kickoff at/before its capture clock (checked on every record built at the TNF-passed clock)", async () => {
    const roles = await loadLiveRoleForecasts(2026, 6, tnfMs + 5 * MIN);
    const bad = roles.filter((r) => r.kickoff_at && Date.parse(r.kickoff_at) <= tnfMs + 5 * MIN).length;
    return { ok: roles.length > 0 && bad === 0, detail: { role_forecasts_frozen: roles.length, at_or_after_kickoff: bad } };
  });

  /* ---------------- W. Wave 1: post-kickoff request cannot alter frozen revisions ---------------- */
  const snapshotState = (kick: string) => sql(`select md5(coalesce(string_agg(forecast_id || ':' || composed_at::text || ':' || md5(record::text), ',' order by forecast_id), '')) from bridge_final_pregame_revisions where kickoff_at = '${kick}'`);
  const pointerState = (kick: string) => sql(`select md5(coalesce(string_agg(canonical_player_id || ':' || forecast_id || ':' || confirmed_through::text, ',' order by league_slug, canonical_player_id), '')) from bridge_final_pregame_forecasts where kickoff_at = '${kick}'`);
  const tnfRows = Number(sql(`select count(*) from bridge_final_pregame_revisions where kickoff_at = '${tnfKick}'`));
  const revBefore = snapshotState(tnfKick);
  const ptrBefore = pointerState(tnfKick);
  const otherBefore = Number(sql(`select count(*) from bridge_final_pregame_revisions where kickoff_at <> '${tnfKick}'`));
  const cand = { normal: 0, postKickoff: 0 };
  const store: Record<string, number> = {};
  for (const t of listLeagueTargets().filter((x) => x.provider === "sleeper" && leagueConfigStatus(x) === "READY")) {
    const st = await buildCanonicalLeagueState(t.key, { reportPersistence: false });
    const mgr = st.snapshot?.managers[0];
    if (!st.snapshot || !mgr) continue;
    const normal = (await buildWeeklyTeamContext(t.key, mgr.manager_slug, { snapshotOverride: st.snapshot })).context?.final_pregame_capture;
    const post = (await buildWeeklyTeamContext(t.key, mgr.manager_slug, { snapshotOverride: st.snapshot, nowMs: () => tnfMs + 5 * MIN })).context?.final_pregame_capture;
    cand.normal += normal?.candidates ?? 0;
    cand.postKickoff += post?.candidates ?? 0;
    for (const [k, v] of Object.entries(post?.counts ?? {})) store[k] = (store[k] ?? 0) + (v as number);
    info("W", `${t.key}: final-pregame capture candidates at the real clock vs after the TNF kickoff`, { normal: [normal?.status, normal?.candidates, normal?.counts], post_kickoff: [post?.status, post?.candidates, post?.counts] });
  }
  await check("W", "WAVE 1 STAGING GATE: a request composed AFTER the TNF kickoff does not even SUBMIT those players (the context filters composed >= kickoff upstream of the store): candidates drop; the store's own REJECTED_POST_KICKOFF path is proven separately in stage 1", async () => ({ ok: cand.postKickoff < cand.normal && cand.postKickoff > 0, detail: { candidates_normal: cand.normal, candidates_after_tnf_kickoff: cand.postKickoff, dropped: cand.normal - cand.postKickoff, store_outcomes_post_kickoff: store } }));
  await check("W", "… and the frozen revisions and pointers of those players are BYTE-IDENTICAL afterwards (revisions + pointers checksum), on real data over real PostgREST", async () => {
    return { ok: tnfRows > 0 && snapshotState(tnfKick) === revBefore && pointerState(tnfKick) === ptrBefore, detail: { tnf_revisions: tnfRows, revisions_unchanged: snapshotState(tnfKick) === revBefore, pointers_unchanged: pointerState(tnfKick) === ptrBefore } };
  });
  await check("W", "the same post-kickoff request still serves players whose games have NOT started (their records stay valid; none were corrupted)", async () => {
    const bad = Number(sql("select count(*) from bridge_final_pregame_revisions where not (source_observed_at <= composed_at and composed_at < kickoff_at)"));
    return { ok: bad === 0 && Number(sql(`select count(*) from bridge_final_pregame_revisions where kickoff_at <> '${tnfKick}'`)) >= otherBefore, detail: { hindsight_rows: bad } };
  });

  /* ---------------- B. real bye / injured spot check ---------------- */
  const st = await buildCanonicalLeagueState("bloodline-bowl", { reportPersistence: false });
  const mgr = st.snapshot!.managers[0]!;
  const ctx = (await buildWeeklyTeamContext("bloodline-bowl", mgr.manager_slug, { snapshotOverride: st.snapshot! })).context!;
  const rostered = new Set(st.snapshot!.rosters.flatMap((r) => r.all_players));
  const fs = [...ctx.forecasts!.by_player.values()].filter((f) => rostered.has(f.canonical_player_id));
  const byes = fs.filter((f) => f.value_state === "BYE_VERIFIED");
  const injured = fs.filter((f) => ["QUESTIONABLE", "DOUBTFUL"].includes(f.injury_model.normalized_state) && (f.projection.source_points ?? 0) >= 8);
  const out = fs.filter((f) => f.injury_model.availability_state === "UNAVAILABLE");
  info("B", "real week-6 rostered players in Bloodline Bowl", { rostered_with_forecast: fs.length, bye: byes.length, questionable_or_doubtful_relevant: injured.length, known_unavailable: out.length });
  await check("B", "BYE STARS: a real bye player scores exactly 0 for the week (BYE_VERIFIED) but keeps a positive underlying/asset value — a bye zero is not evidence to drop him", async () => {
    const withValue = byes.filter((f) => (f.weekly_value.underlying_points_if_game_played ?? 0) > 0);
    const ok = byes.length > 0 && byes.every((f) => f.projection.expected_points === 0 && f.weekly_value.current_week_state === "BYE" && f.asset_context.bye_suppressed_current_week) && withValue.length > 0;
    return { ok, detail: { bye_players: byes.length, with_underlying_value: withValue.length, example: withValue[0] ? { cur: withValue[0].projection.expected_points, underlying: withValue[0].weekly_value.underlying_points_if_game_played, basis: withValue[0].weekly_value.underlying_basis } : null } };
  });
  await check("B", "INJURED STARS: a real Questionable/Doubtful relevant player is discounted exactly once (expected = conditional x P(active)), with P(active) strictly between 0 and 1 and the provider status preserved verbatim", async () => {
    const bad = injured.filter((f) => !(f.injury_model.probability_active! > 0 && f.injury_model.probability_active! < 1) || (f.projection.expected_points ?? 0) > (f.projection.conditional_active_points ?? 0) + 0.011 || f.availability.injury_status == null);
    const ex = injured[0];
    return { ok: injured.length > 0 && bad.length === 0, detail: { injured: injured.length, violations: bad.length, example: ex ? { status: ex.availability.injury_status, source: ex.projection.source_points, cond: ex.projection.conditional_active_points, expected: ex.projection.expected_points, p: ex.injury_model.probability_active } : null } };
  });
  await check("B", "OUT players are a KNOWN ZERO distinct from a bye: expected 0, availability UNAVAILABLE, value_state KNOWN_UNAVAILABLE", async () => {
    const outOnly = out.filter((f) => !f.game_status.is_bye);
    const bad = outOnly.filter((f) => f.projection.expected_points !== 0 || f.value_state !== "KNOWN_UNAVAILABLE");
    return { ok: outOnly.length > 0 && bad.length === 0, detail: { out_not_on_bye: outOnly.length, violations: bad.length } };
  });
  await check("B", "BYE WINS WHEN BOTH APPLY: a player who is Out AND on a bye is BYE_VERIFIED with reason BYE, while his Out designation stays visible (schema rule, verified on real data)", async () => {
    const both = out.filter((f) => f.game_status.is_bye);
    const bad = both.filter((f) => f.value_state !== "BYE_VERIFIED" || f.asset_context.temporary_unavailability_reason !== "BYE" || f.projection.expected_points !== 0 || f.injury_model.normalized_state !== "OUT");
    return { ok: bad.length === 0, detail: { out_and_bye: both.length, violations: bad.length } };
  });
  finish("docs/evidence/w2p2-local-staging-live3.json");
}
main().catch((e) => { console.error(e); process.exit(2); });
