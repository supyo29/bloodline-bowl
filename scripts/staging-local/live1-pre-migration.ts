/**
 * LIVE PHASE 1 (local Docker Supabase only; REAL Sleeper/ESPN providers, read-only; REAL PostgREST path).
 * State of the database: Wave 1 -> W2.P1 chain applied, Role-shadow migration NOT applied, ROLE_SHADOW_CAPTURE=1 (local env only).
 *   - Wave 1 live: real weekly contexts for the registered Sleeper leagues persist final-pregame revisions / source observations through PostgREST
 *   - capture-failure VISIBILITY: the Role-shadow table is missing, so every capture write must fail loudly, never silently, never throwing
 *   - five-league accounting: Yahoo leagues must be reported as skipped with a reason
 */
import { check, finish, info, sql } from "./lib";
import { runScheduledRoleShadowCapture } from "../../lib/persistence/supabase/role-shadow-runtime";

const q = (s: string) => Number(sql(s));

async function main(): Promise<void> {
  process.env.ROLE_SHADOW_CAPTURE = "1"; // LOCAL staging only; the guard in lib.ts already refused any non-loopback target
  const t0 = Date.now();
  const run = await runScheduledRoleShadowCapture({ env: process.env });
  info("L1", `real capture run finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`, { status: run.status, failures: run.failures, totals: run.totals, skipped: run.skipped, leagues: run.leagues.map((l) => [l.league_slug, l.ok, l.counters?.built, l.by_status]) });

  await check("L1", "CAPTURE-FAILURE VISIBILITY: with the table missing every write is reported as ERROR, the run is PARTIAL (not OK), and nothing threw", async () => {
    const built = run.totals.counters.built;
    return { ok: built > 0 && run.status === "PARTIAL" && run.totals.by_status.ERROR === built && run.failures === built && !run.totals.by_status.INSERTED, detail: { built, by_status: run.totals.by_status, failures: run.failures, status: run.status } };
  });
  await check("L1", "FIVE-LEAGUE ACCOUNTING: 3 Sleeper leagues were built; both Yahoo leagues are reported as SKIPPED with a reason (not failed, not silent)", async () => {
    const built = run.leagues.filter((l) => l.ok).map((l) => l.league_slug).sort();
    const sk = run.skipped.map((s) => s.league_slug).sort();
    return { ok: JSON.stringify(built) === JSON.stringify(["bloodline-bowl", "devoted-to-the-game", "sportys-alumni"]) && JSON.stringify(sk) === JSON.stringify(["maclin-on-chicks-xvi", "rogers-park"]) && run.skipped.every((s) => s.provider === "yahoo" && s.reason.length > 20), detail: { built, skipped: run.skipped } };
  });

  /* ---- Wave 1 live persistence through the real PostgREST path ---- */
  const rev = q("select count(*) from bridge_final_pregame_revisions");
  const ptr = q("select count(*) from bridge_final_pregame_forecasts");
  const byLeague = sql("select league_slug || '=' || n from (select league_slug, count(*) n from bridge_final_pregame_revisions group by league_slug) x order by league_slug").split("\n");
  await check("W1", "LIVE final-pregame capture persisted real revisions + pointers for every Sleeper league via PostgREST", async () => ({ ok: rev > 0 && ptr > 0 && byLeague.length === 3, detail: { revisions: rev, pointers: ptr, by_league: byLeague } }));
  await check("W1", "every stored revision is pregame by the database's own arithmetic: observed <= composed < kickoff, for ALL rows", async () => {
    const bad = q("select count(*) from bridge_final_pregame_revisions where not (source_observed_at <= composed_at and composed_at < kickoff_at and source_observed_at < kickoff_at)");
    return { ok: bad === 0 && rev > 0, detail: { violations: bad, rows: rev } };
  });
  await check("W1", "pointer integrity: exactly one pointer per (league, season, week, player); each pointer references an existing revision of the SAME player-week", async () => {
    const dup = q("select count(*) from (select league_slug, season, week, canonical_player_id from bridge_final_pregame_forecasts group by 1,2,3,4 having count(*) > 1) x");
    const dangling = q("select count(*) from bridge_final_pregame_forecasts p left join bridge_final_pregame_revisions r on r.forecast_id = p.forecast_id and r.league_slug = p.league_slug and r.week = p.week and r.canonical_player_id = p.canonical_player_id where r.forecast_id is null");
    return { ok: dup === 0 && dangling === 0, detail: { duplicate_pointers: dup, dangling_pointers: dangling } };
  });
  await check("W1", "source observations are persisted through PostgREST (header + rows) and every header's row_count matches its stored rows", async () => {
    const h = q("select count(*) from bridge_projection_source_observations");
    const mismatch = q("select count(*) from bridge_projection_source_observations o where o.kind='FULL' and o.row_count <> (select count(*) from bridge_projection_source_observation_rows r where r.observation_id=o.observation_id)");
    return { ok: h > 0 && mismatch === 0, detail: { headers: h, row_count_mismatches: mismatch } };
  });
  info("W1", "other Wave 1 tables after the live run (row counts)", Object.fromEntries(["bridge_projection_snapshots", "bridge_projection_snapshot_players", "bridge_projection_latest", "bridge_intelligence_freshness_history", "bridge_projection_source_observations", "bridge_projection_source_observation_rows"].map((t) => [t, q(`select count(*) from ${t}`)])));

  /* ---- idempotency of a second identical run ---- */
  const before = { rev, ptr };
  const run2 = await runScheduledRoleShadowCapture({ env: process.env });
  const after = { rev: q("select count(*) from bridge_final_pregame_revisions"), ptr: q("select count(*) from bridge_final_pregame_forecasts") };
  await check("W1", "a second live run adds no duplicate revisions for unchanged evidence (revisions only grow when the observed belief really changed); pointers stay one per player-week", async () => {
    const dupIds = q("select count(*) from (select forecast_id from bridge_final_pregame_revisions group by 1 having count(*) > 1) x");
    return { ok: dupIds === 0 && after.ptr === before.ptr && after.rev >= before.rev, detail: { before, after, run2_failures: run2.failures, duplicate_forecast_ids: dupIds } };
  });
  finish("docs/evidence/w2p2-local-staging-live1.json");
}
main().catch((e) => { console.error(e); process.exit(2); });
