/**
 * ONE wall-clock sample for the true kickoff-boundary test (local Docker Supabase only; real providers read-only; REAL clock, nothing injected).
 * Run repeatedly (scheduled) across the next real kickoff; each run APPENDS one JSON line to docs/evidence/kickoff-boundary-samples.jsonl.
 * It never resets the local database: continuity across samples is the point. `kickoff-boundary-verdict.ts` judges the series.
 *   env: KICKOFF_ISO (default 2026-10-16T00:15:00Z, Thursday-night game of NFL week 6)
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { sql } from "./lib";
import { buildCanonicalLeagueState } from "../../lib/canonical/state";
import { buildWeeklyTeamContext } from "../../lib/weekly/context";
import { listLeagueTargets, leagueConfigStatus } from "../../lib/leagues/registry";
import { loadProductionLeagueWeeks, loadLiveRoleForecasts } from "../../lib/persistence/supabase/role-shadow-runtime";
import { runRoleShadowCapture } from "../../lib/role-shadow/capture";

const KICK = process.env.KICKOFF_ISO ?? "2026-10-16T00:15:00Z";
const kickMs = Date.parse(KICK);
const fp = (where: string) => ({
  revisions: Number(sql(`select count(*) from bridge_final_pregame_revisions where ${where}`)),
  revisions_md5: sql(`select md5(coalesce(string_agg(forecast_id || ':' || composed_at::text || ':' || md5(record::text), ',' order by forecast_id), '')) from bridge_final_pregame_revisions where ${where}`),
  pointers: Number(sql(`select count(*) from bridge_final_pregame_forecasts where ${where}`)),
  pointers_md5: sql(`select md5(coalesce(string_agg(league_slug || ':' || canonical_player_id || ':' || forecast_id || ':' || confirmed_through::text, ',' order by league_slug, canonical_player_id), '')) from bridge_final_pregame_forecasts where ${where}`),
});
async function main(): Promise<void> {
  const t0 = Date.now();
  const kExact = `kickoff_at = '${KICK}'`;
  const before = { at_kickoff: fp(kExact), other: fp(`kickoff_at <> '${KICK}'`) };
  const storedMin = sql("select to_char(min(kickoff_at) at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from bridge_final_pregame_revisions");
  const leagues: Record<string, unknown> = {};
  for (const t of listLeagueTargets().filter((x) => x.provider === "sleeper" && leagueConfigStatus(x) === "READY")) {
    const st = await buildCanonicalLeagueState(t.key, { reportPersistence: false });
    const mgr = st.snapshot?.managers[0];
    if (!st.snapshot || !mgr) { leagues[t.key] = { status: "NO_SNAPSHOT" }; continue; }
    const c = (await buildWeeklyTeamContext(t.key, mgr.manager_slug, { snapshotOverride: st.snapshot })).context?.final_pregame_capture;
    leagues[t.key] = { status: c?.status, candidates: c?.candidates, counts: c?.counts, error: c?.error };
  }
  const composedAt = Date.now(); // the clock the requests above were composed against (to within the build time)
  const weeks = await loadProductionLeagueWeeks();
  const role = await runRoleShadowCapture({ env: { ...process.env, ROLE_SHADOW_CAPTURE: "1" } as NodeJS.ProcessEnv, dryRun: true, store: null, now: () => Date.now(), loadLeagueWeeks: async () => weeks, loadRoleForecasts: (s, w, n) => loadLiveRoleForecasts(s, w, n) });
  const after = { at_kickoff: fp(kExact), other: fp(`kickoff_at <> '${KICK}'`) };
  const line = {
    sampled_at: new Date(t0).toISOString(), finished_at: new Date().toISOString(), composed_at_approx: new Date(composedAt).toISOString(),
    minutes_to_kickoff_at_start: +((kickMs - t0) / 60000).toFixed(2), minutes_to_kickoff_at_compose: +((kickMs - composedAt) / 60000).toFixed(2),
    phase: composedAt < kickMs ? "PRE" : "POST", kickoff_iso: KICK, stored_min_kickoff: storedMin,
    leagues, before, after, role_shadow_dry_run: { built: role.totals.counters.built, no_role_forecast: role.totals.counters.no_role_forecast, status: role.status, failures: role.failures },
  };
  mkdirSync("docs/evidence", { recursive: true });
  appendFileSync("docs/evidence/kickoff-boundary-samples.jsonl", JSON.stringify(line) + "\n");
  console.log(JSON.stringify({ phase: line.phase, min_to_kick: line.minutes_to_kickoff_at_compose, kickoff_revisions: after.at_kickoff.revisions, frozen_unchanged_by_this_request: before.at_kickoff.revisions_md5 === after.at_kickoff.revisions_md5 && before.at_kickoff.pointers_md5 === after.at_kickoff.pointers_md5, role_built: line.role_shadow_dry_run.built }));
}
main().catch((e) => { console.error(e); process.exit(2); });
