/**
 * STAGE 2 (local Docker Supabase only): the Role-shadow migration is applied. Every assertion goes through the REAL HTTP path
 * (store -> fetch -> Kong -> PostgREST -> Postgres), with direct SQL only to verify what the HTTP path claims.
 */
import { check, finish, info, rest, sql, ANON, DB } from "./lib";
import { SupabaseRest, loadSupabaseConfig } from "../../lib/persistence/supabase/rest";
import { SupabaseRoleShadowStore, ROLE_SHADOW_TABLE, captureRow } from "../../lib/persistence/supabase/role-shadow-store";
import { validateRecord, withIds, type RoleShadowRecord } from "../../lib/role-shadow/record";
import { contentHash } from "../../lib/bridge/hash";
import { PINNED } from "../../lib/role-shadow/spec";
import { runRoleShadowCapture } from "../../lib/role-shadow/capture";
import { execFileSync } from "node:child_process";
import { KICK, NOW, champion, leagueWeek, liveRecord, roleForecast } from "../../test/fixtures/role-shadow";

const T = ROLE_SHADOW_TABLE;
const cfg = loadSupabaseConfig().config!;
const mkStore = (now?: () => number) => new SupabaseRoleShadowStore(new SupabaseRest(cfg), now ?? (() => NOW));
const count = (where = "true") => Number(sql(`select count(*) from ${T} where ${where}`));
const strip = (r: RoleShadowRecord) => { const { capture_id: _a, content_hash: _b, ...rest } = r; void _a; void _b; return rest; };
const docker = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitRest = async (): Promise<boolean> => { for (let i = 0; i < 60; i++) { try { const r = await rest(`${T}?select=capture_id&limit=0`); if (r.status === 200) return true; } catch { /* still down */ } await sleep(1000); } return false; };

async function main(): Promise<void> {
  /* ---------------- R. schema / privileges ---------------- */
  await check("R", "table exists; PostgREST serves it (schema cache includes it) to the service key", async () => { const r = await rest(`${T}?select=capture_id&limit=0`); return { ok: r.status === 200, detail: { status: r.status } }; });
  await check("R", "RLS on; anon/authenticated hold NO privileges; PostgREST answers the anon key with 401/403 (never 200)", async () => {
    const rls = sql(`select relrowsecurity from pg_class where relname='${T}'`);
    const priv = sql(`select has_table_privilege('anon','public.${T}','SELECT') or has_table_privilege('anon','public.${T}','INSERT') or has_table_privilege('authenticated','public.${T}','SELECT') or has_table_privilege('authenticated','public.${T}','INSERT')`);
    const r = await rest(`${T}?select=*&limit=1`, { key: ANON });
    const w = await rest(T, { method: "POST", key: ANON, body: {} });
    return { ok: rls === "t" && priv === "f" && [401, 403].includes(r.status) && [401, 403].includes(w.status), detail: { rls, any_priv: priv, anon_read: r.status, anon_write: w.status } };
  });
  await check("R", "exactly the two guard triggers (not-late, immutable) exist", async () => {
    const trg = sql(`select tgname from pg_trigger where tgrelid='public.${T}'::regclass and not tgisinternal order by 1`).split("\n");
    return { ok: JSON.stringify(trg) === JSON.stringify(["bridge_role_shadow_captures_immutable", "bridge_role_shadow_captures_not_late"]), detail: trg };
  });

  /* ---------------- I. insert / idempotency / concurrency ---------------- */
  const store = mkStore();
  const rec = liveRecord();
  await check("I", "a valid pregame record is INSERTED over HTTP; the stored columns match the record and the jsonb equals it semantically (jsonb reorders keys, so compared canonically)", async () => {
    const res = await store.record(rec);
    const row = (await rest(`${T}?capture_id=eq.${rec.capture_id}&select=*`)).body?.[0];
    const match = row && contentHash(row.record) === contentHash(JSON.parse(JSON.stringify(rec))) && row.eligible === rec.population.eligible && Date.parse(row.kickoff_at) === Date.parse(rec.game.kickoff_at!) && row.challenger_config_hash === PINNED.challenger_config_hash;
    return { ok: res.status === "INSERTED" && !!match, detail: { status: res.status } };
  });
  await check("I", "ROUND TRIP: a record read back from Postgres jsonb through PostgREST RE-VALIDATES (content hash, point-in-time, arms replay) — the evaluator depends on this", async () => {
    const back = (await store.list()).find((r) => r.capture_id === rec.capture_id)!;
    const errs = validateRecord(back);
    return { ok: errs.length === 0 && back.content_hash === rec.content_hash && contentHash(back) === contentHash(rec), detail: { errors: errs } };
  });
  await check("I", "re-recording the same decision is DUPLICATE_IDENTICAL and the stored row is byte-identical (checksum before == after)", async () => {
    const before = sql(`select md5(record::text) from ${T} where capture_id='${rec.capture_id}'`);
    const res = await store.record(rec);
    return { ok: res.status === "DUPLICATE_IDENTICAL" && before === sql(`select md5(record::text) from ${T} where capture_id='${rec.capture_id}'`) && count() === 1, detail: res };
  });
  const conc = liveRecord({ points: 17.3 });
  await check("I", "25 CONCURRENT writers (25 independent stores over HTTP): exactly one INSERTED, 24 DUPLICATE_IDENTICAL, one row, zero errors", async () => {
    const res = await Promise.all(Array.from({ length: 25 }, () => mkStore().record(conc)));
    const by = res.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
    return { ok: by.INSERTED === 1 && by.DUPLICATE_IDENTICAL === 24 && count(`capture_id='${conc.capture_id}'`) === 1, detail: by };
  });

  /* ---------------- M. immutability through HTTP ---------------- */
  await check("M", "PATCH through PostgREST is REFUSED and the row is unchanged", async () => {
    const before = sql(`select md5(record::text) from ${T} where capture_id='${rec.capture_id}'`);
    const r = await rest(`${T}?capture_id=eq.${rec.capture_id}`, { method: "PATCH", body: { eligible: false }, prefer: "return=representation" });
    return { ok: r.status >= 400 && before === sql(`select md5(record::text) from ${T} where capture_id='${rec.capture_id}'`), detail: { status: r.status, code: r.body?.code } };
  });
  await check("M", "DELETE through PostgREST is REFUSED and no row disappears", async () => {
    const n = count();
    const r = await rest(`${T}?capture_id=eq.${rec.capture_id}`, { method: "DELETE" });
    return { ok: r.status >= 400 && count() === n, detail: { status: r.status, code: r.body?.code } };
  });
  await check("M", "the UPSERT bypass (POST with Prefer: resolution=merge-duplicates on an existing id) is REFUSED — an existing observation cannot be replaced via insert", async () => {
    const before = sql(`select md5(record::text) from ${T} where capture_id='${rec.capture_id}'`);
    const r = await rest(T, { method: "POST", body: { ...captureRow(rec), eligible: false }, prefer: "resolution=merge-duplicates,return=representation" });
    return { ok: r.status >= 400 && before === sql(`select md5(record::text) from ${T} where capture_id='${rec.capture_id}'`), detail: { status: r.status, code: r.body?.code } };
  });
  await check("M", "TRUNCATE is not reachable through PostgREST (no such verb); the service role has no TRUNCATE-by-API path", async () => {
    const r = await rest(T, { method: "DELETE" });
    return { ok: r.status >= 400 && count() >= 2, detail: { status: r.status } };
  });

  /* ---------------- L. post-kickoff rejection (database clock) ---------------- */
  await check("L", "the DATABASE refuses a pregame-composed record that ARRIVES after kickoff (trigger P0001 through PostgREST -> store REFUSED_LATE), even though the app clock still said 'pregame'", async () => {
    const t0 = Date.now();
    const kick = t0 + 4_000;
    const lateRec = liveRecord({ kickoff_ms: kick, observed_ms: t0 - 60_000, composed_ms: t0 - 30_000 }, { kickoff_ms: kick, as_of_ms: t0 - 20_000, cutoff_ms: t0 - 86_400_000 }, {}, t0 - 10_000);
    const appThinksPregame = mkStore(() => t0); // frozen app clock: the application check passes
    await sleep(6_000); // real time passes the kickoff
    const res = await appThinksPregame.record(lateRec);
    const raw = await rest(T, { method: "POST", body: captureRow(lateRec) });
    return { ok: res.status === "REFUSED_LATE" && /database clock/.test(res.reason ?? "") && raw.status >= 400 && raw.body?.code === "P0001" && count(`capture_id='${lateRec.capture_id}'`) === 0, detail: { store: res, raw_status: raw.status, raw_code: raw.body?.code } };
  });
  await check("L", "the application-side refusal fires first when its own clock is past kickoff (REFUSED_LATE, no HTTP write attempted)", async () => {
    const res = await mkStore(() => KICK + 60_000).record(liveRecord({ points: 12.5 }));
    return { ok: res.status === "REFUSED_LATE" && !/database clock/.test(res.reason ?? ""), detail: res };
  });
  await check("L", "CHECK constraints hold over HTTP: reconstructed-and-eligible (23514), captured_at >= kickoff_at (23514), unknown class (23514), K position (23514)", async () => {
    const base = captureRow(liveRecord({ points: 13.5 })) as Record<string, any>;
    const bad = async (over: Record<string, unknown>) => (await rest(T, { method: "POST", body: { ...base, capture_id: `rsc:${Math.random().toString(16).slice(2, 18).padEnd(16, "0")}`, ...over, record: { ...base.record, capture_id: undefined } } }));
    const mk = async (over: Record<string, unknown>) => { const id = `rsc:${Math.random().toString(16).slice(2, 18).padEnd(16, "0")}`; return rest(T, { method: "POST", body: { ...base, capture_id: id, ...over, record: { ...base.record, capture_id: id } } }); };
    void bad;
    const results = await Promise.all([mk({ capture_class: "HISTORICALLY_RECONSTRUCTED", eligible: true }), mk({ captured_at: base.kickoff_at }), mk({ capture_class: "LIVE_POST_LOCK" }), mk({ position: "K" })]);
    return { ok: results.every((r) => r.status === 400 && r.body?.code === "23514"), detail: results.map((r) => [r.status, r.body?.code]) };
  });

  /* ---------------- V. model-version isolation ---------------- */
  await check("V", "another model version cannot be stored through the store (REFUSED_INVALID) and cannot overwrite; a foreign-hash row written raw lands as a SEPARATE row and the frozen version's rows stay untouched", async () => {
    const alien = withIds({ ...strip(rec), models: { ...rec.models, challenger: { ...rec.models.challenger, config_hash: "f".repeat(32) } } });
    const viaStore = await store.record(alien);
    const before = sql(`select md5(record::text) from ${T} where capture_id='${rec.capture_id}'`);
    const raw = await rest(T, { method: "POST", body: captureRow(alien), prefer: "return=minimal" });
    const frozenRows = (await store.list({ challenger_config_hash: PINNED.challenger_config_hash })).length;
    const alienRows = count(`challenger_config_hash='${"f".repeat(32)}'`);
    return { ok: viaStore.status === "REFUSED_INVALID" && raw.status < 300 && alienRows === 1 && before === sql(`select md5(record::text) from ${T} where capture_id='${rec.capture_id}'`) && frozenRows >= 2, detail: { via_store: viaStore.status, raw_status: raw.status, frozen_rows: frozenRows, alien_rows: alienRows, note: "the DATABASE does not validate config hashes; the guarantee is application validation + content-addressed ids + the evaluator never pooling versions" } };
  });

  /* ---------------- P. paging against the real PostgREST max-rows ---------------- */
  await check("P", "listing 2,300 rows pages correctly against the REAL server row cap (no truncation, stable order, no duplicates)", async () => {
    const base = captureRow(rec) as Record<string, any>;
    const rows = Array.from({ length: 2300 }, (_, i) => { const id = `rsc:${(0xabc0000000000000n + BigInt(i)).toString(16)}`; return { ...base, capture_id: id, captured_at: new Date(Date.parse(base.captured_at) + i * 1000).toISOString(), record: { ...base.record, capture_id: id } }; });
    for (let i = 0; i < rows.length; i += 400) { const r = await rest(T, { method: "POST", body: rows.slice(i, i + 400), prefer: "return=minimal" }); if (r.status >= 300) return { ok: false, detail: { batch: i, status: r.status, code: r.body?.code } }; }
    const all = await mkStore().list();
    const ids = new Set(all.map((r) => r.capture_id));
    const sorted = all.every((r, i) => i === 0 || all[i - 1]!.timing.captured_at <= r.timing.captured_at);
    return { ok: all.length === count() && ids.size === all.length && sorted && all.length >= 2300, detail: { listed: all.length, in_db: count(), unique: ids.size, server_max_rows: sql("select current_setting('pgrst.db_max_rows', true)") || "(default 1000)" } };
  });

  /* ---------------- D. durability across restarts + outage visibility ---------------- */
  const rowsBefore = count();
  const digest = () => sql(`select md5(string_agg(capture_id || md5(record::text), ',' order by capture_id)) from ${T}`);
  const d0 = digest();
  await check("D", "RESTART of the database and PostgREST containers: every row survives byte-for-byte; the store reads them back; re-recording changes nothing", async () => {
    docker("restart", DB);
    docker("restart", "supabase_rest_bloodline-wave1-w2-local-staging");
    const up = await waitRest();
    const again = await mkStore().record(rec);
    return { ok: up && count() === rowsBefore && digest() === d0 && again.status === "DUPLICATE_IDENTICAL", detail: { rows: rowsBefore, status_after_restart: again.status } };
  });
  await check("D", "DATABASE OUTAGE is VISIBLE: with the database stopped, a record write returns ERROR (never throws); the runner reports PARTIAL with failures counted", async () => {
    docker("stop", DB);
    await sleep(1500);
    const fresh = liveRecord({ points: 19.9 });
    const res = await mkStore().record(fresh);
    const run = await runRoleShadowCapture({ env: { ...process.env, ROLE_SHADOW_CAPTURE: "1" } as NodeJS.ProcessEnv, now: () => NOW, store: mkStore(), loadLeagueWeeks: async () => [leagueWeek([champion({ points: 18.1 })])], loadRoleForecasts: async () => [roleForecast()] });
    docker("start", DB);
    const up = await waitRest();
    return { ok: res.status === "ERROR" && run.status === "PARTIAL" && run.failures >= 1 && run.totals.by_status.ERROR === 1 && up, detail: { single: res.status, run: { status: run.status, failures: run.failures, by_status: run.totals.by_status }, recovered: up } };
  });
  await check("D", "RECOVERY: after the outage the very same capture succeeds exactly once on retry (no loss, no duplicate)", async () => {
    const mkRun = () => runRoleShadowCapture({ env: { ...process.env, ROLE_SHADOW_CAPTURE: "1" } as NodeJS.ProcessEnv, now: () => NOW, store: mkStore(), loadLeagueWeeks: async () => [leagueWeek([champion({ points: 18.1 })])], loadRoleForecasts: async () => [roleForecast()] });
    const a = await mkRun();
    const b = await mkRun();
    return { ok: a.totals.by_status.INSERTED === 1 && b.totals.by_status.DUPLICATE_IDENTICAL === 1 && a.status === "OK", detail: { first: a.totals.by_status, second: b.totals.by_status } };
  });
  await check("D", "a WRONG service key (credential failure) is VISIBLE as ERROR, not silent", async () => {
    const bad = new SupabaseRoleShadowStore(new SupabaseRest({ url: cfg.url, serviceRoleKey: ["not", "the", "right", "key"].join("-") }), () => NOW);
    const res = await bad.record(liveRecord({ points: 20.2 }));
    return { ok: res.status === "ERROR", detail: res };
  });
  info("D", "final row count in the local table", count());
  finish("docs/evidence/w2p2-local-staging-stage2.json");
}
main().catch((e) => { console.error(e); process.exit(2); });
