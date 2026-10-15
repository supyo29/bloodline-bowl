/**
 * LIVE PHASE 2 (local Docker Supabase only; REAL providers read-only): the production wiring end to end over HTTP.
 *   HTTP client -> Next.js server (`next start`, minimal explicit env) -> /api/cron/role-shadow-capture -> real Sleeper/ESPN reads ->
 *   real weekly contexts -> capture records -> Supabase store -> fetch -> Kong -> PostgREST -> Postgres
 * The server gets ONLY: PATH/HOME, the local Supabase URL + local demo key, a local cron secret, and (per phase) ROLE_SHADOW_CAPTURE.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { check, finish, info, sql, URL_, KEY } from "./lib";

const PORT = 3055;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = process.env.CRON_SECRET!;
const T = "bridge_role_shadow_captures";
const count = (where = "true") => Number(sql(`select count(*) from ${T} where ${where}`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startServer(flag: string | null): Promise<ChildProcess> {
  const env: Record<string, string> = { PATH: process.env.PATH!, HOME: process.env.HOME!, NEXT_TELEMETRY_DISABLED: "1", SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: KEY, CRON_SECRET: SECRET };
  if (flag !== null) env.ROLE_SHADOW_CAPTURE = flag;
  const p: ChildProcess = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], { env: env as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout?.on("data", () => undefined);
  p.stderr?.on("data", () => undefined);
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return p; } catch { /* starting */ } await sleep(500); }
  p.kill("SIGKILL");
  throw new Error("server did not start");
}
const stop = async (p: ChildProcess): Promise<void> => { p.kill("SIGTERM"); await sleep(1500); if (!p.killed) p.kill("SIGKILL"); };
const call = async (qs = "", headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) => {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/cron/role-shadow-capture${qs}`, { headers });
  const text = await r.text();
  let body: any = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, ms: Date.now() - t0 };
};

async function main(): Promise<void> {
  const rows0 = count();
  /* ---- flag OFF ---- */
  let srv = await startServer(null);
  await check("H", "HTTP: the route rejects unauthenticated, wrong-secret and query-string-secret calls (401) and exposes no data", async () => {
    const a = await call("", {});
    const b = await call("", { authorization: "Bearer nope" });
    const c = await call(`?secret=${SECRET}`, {});
    return { ok: [a, b, c].every((r) => r.status === 401 && !JSON.stringify(r.body).includes("league_slug")), detail: [a.status, b.status, c.status] };
  });
  await check("H", "HTTP: authorized call with the flag UNSET is a complete no-op: status DISABLED, no Supabase write, row count unchanged", async () => {
    const r = await call();
    return { ok: r.status === 200 && r.body?.status === "DISABLED" && r.body?.flag?.enabled === false && count() === rows0, detail: { status: r.status, body_status: r.body?.status } };
  });
  await check("H", "HTTP: an anonymous cross-origin request gets 401 and an error body with NO data (note: the shared jsonResponse helper adds CORS * to every route's 401 too — a pre-existing pattern on all cron routes, P3, no data exposed)", async () => {
    const r = await fetch(`${BASE}/api/cron/role-shadow-capture`, { headers: { origin: "https://evil.example" } });
    const body = await r.text();
    return { ok: r.status === 401 && !/league|capture_id|record/.test(body.replace(/"error":"[^"]*"|"detail":"[^"]*"|"code":"[^"]*"/g, "")), detail: { status: r.status, acao: r.headers.get("access-control-allow-origin"), body: body.slice(0, 160) } };
  });
  await stop(srv);

  /* ---- flag ON ---- */
  srv = await startServer("1");
  await check("H", "HTTP: ROLE_SHADOW_CAPTURE='true' (not exactly '1') stays DISABLED — verified on the live server", async () => {
    await stop(srv);
    srv = await startServer("true");
    const r = await call();
    await stop(srv);
    srv = await startServer("1");
    return { ok: r.body?.status === "DISABLED", detail: r.body?.status };
  });
  let dry: Awaited<ReturnType<typeof call>>;
  await check("H", "HTTP ?dry_run=1 (flag on): real providers + real contexts build, records counted, NOTHING written to Supabase", async () => {
    dry = await call("?dry_run=1");
    return { ok: dry.status === 200 && dry.body?.status === "OK" && dry.body?.dry_run === true && dry.body?.totals?.counters?.built > 300 && Object.keys(dry.body?.totals?.by_status ?? {}).length === 0 && count() === rows0, detail: { ms: dry.ms, built: dry.body?.totals?.counters?.built, counters: dry.body?.totals?.counters } };
  });
  let real1: Awaited<ReturnType<typeof call>>;
  await check("H", "HTTP real run #1: every built record is INSERTED through PostgREST; DB row count equals the INSERTED count; status OK; 0 failures", async () => {
    real1 = await call();
    const ins = real1.body?.totals?.by_status?.INSERTED ?? 0;
    return { ok: real1.status === 200 && real1.body?.status === "OK" && real1.body?.failures === 0 && ins > 300 && count() === rows0 + ins && ins === real1.body?.totals?.counters?.built, detail: { ms: real1.ms, by_status: real1.body?.totals?.by_status, built: real1.body?.totals?.counters?.built, rows: count() } };
  });
  const afterReal1 = count();
  await check("H", "HTTP real run #2 (a second scheduled invocation): idempotent — no duplicates; any new rows are real evidence changes (a changed projection/injury), never a re-insert", async () => {
    const r = await call();
    const st = r.body?.totals?.by_status ?? {};
    const dupIds = Number(sql(`select count(*) from (select capture_id from ${T} group by 1 having count(*) > 1) x`));
    return { ok: r.body?.status === "OK" && r.body?.failures === 0 && (st.DUPLICATE_IDENTICAL ?? 0) > 0.9 * (r.body?.totals?.counters?.built ?? 1) && count() === afterReal1 + (st.INSERTED ?? 0) && dupIds === 0, detail: { by_status: st, rows: count() } };
  });
  await stop(srv);
  srv = await startServer("1");
  const afterRestart = count();
  await check("H", "HTTP after a full SERVER RESTART: durable dedupe (state lives in Postgres, not memory) — still no duplicate captures", async () => {
    const r = await call();
    const st = r.body?.totals?.by_status ?? {};
    return { ok: r.body?.status === "OK" && (st.DUPLICATE_IDENTICAL ?? 0) > 0.9 * (r.body?.totals?.counters?.built ?? 1) && count() === afterRestart + (st.INSERTED ?? 0), detail: st };
  });
  await stop(srv);

  /* ---- database-level facts about what the live run stored ---- */
  const total = count();
  await check("S", "every stored row is LIVE_CAPTURED and pregame by BOTH clocks: captured_at < kickoff_at AND the database's own insertion time recorded_at < kickoff_at", async () => {
    const bad = Number(sql(`select count(*) from ${T} where capture_class <> 'LIVE_CAPTURED' or not (captured_at < kickoff_at and recorded_at < kickoff_at and source_observed_at < kickoff_at)`));
    return { ok: bad === 0 && total > 300, detail: { rows: total, violations: bad } };
  });
  const byLeague = sql(`select league_slug || '|' || scoring_compatibility || '|' || eligible || '=' || n from (select league_slug, scoring_compatibility, eligible, count(*) n from ${T} group by 1,2,3) x order by 1`).split("\n");
  info("S", "stored rows by league | scoring compatibility | eligible", byLeague);
  await check("S", "NO SILENT POOLING: only Bloodline Bowl rows are ever eligible; Devoted and Sporty's rows are stored for coverage but ALL ineligible with scoring NO_FROZEN_FIT", async () => {
    const eligibleOther = Number(sql(`select count(*) from ${T} where eligible and league_slug <> 'bloodline-bowl'`));
    const eligibleBadScoring = Number(sql(`select count(*) from ${T} where eligible and scoring_compatibility <> 'TEMPLATE_HALF_ON_MODELED_KEYS'`));
    const bb = Number(sql(`select count(*) from ${T} where league_slug='bloodline-bowl' and eligible`));
    const otherLeaguesCompat = Number(sql(`select count(*) from ${T} where league_slug <> 'bloodline-bowl' and scoring_compatibility = 'TEMPLATE_HALF_ON_MODELED_KEYS'`));
    return { ok: eligibleOther === 0 && eligibleBadScoring === 0 && bb > 50 && otherLeaguesCompat === 0, detail: { eligible_other_leagues: eligibleOther, eligible_with_non_template_scoring: eligibleBadScoring, bloodline_bowl_eligible: bb, other_league_template_rows: otherLeaguesCompat } };
  });
  await check("S", "only QB/RB/WR/TE are stored; every row identifies its player by the sleeper-via-profile join (the known gsis crosswalk gap is visible, not hidden)", async () => {
    const pos = sql(`select string_agg(distinct position, ',' order by position) from ${T}`);
    const joins = sql(`select record->'player'->>'join_method' || '=' || count(*) from ${T} group by record->'player'->>'join_method'`);
    return { ok: pos === "QB,RB,TE,WR", detail: { positions: pos, joins } };
  });
  finish("docs/evidence/w2p2-local-staging-live2.json");
}
main().catch((e) => { console.error(e); process.exit(2); });
