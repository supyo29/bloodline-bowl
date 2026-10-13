/**
 * W2.P2 migration verification against a REAL Postgres engine (PGlite = Postgres compiled to WASM). NOT part of `npm test` (PGlite is not a repo
 * dependency). Run from the repo root:
 *
 *     npm install --no-save @electric-sql/pglite@0.3.2 && node scripts/w2p2/verify-migration.mjs
 *
 * Applies supabase/migrations/20261013180000_role_shadow_captures.sql and checks: idempotent re-apply, insert-only, idempotent duplicate no-op,
 * late-evidence refusal on the DATABASE clock, every CHECK constraint, RLS + revoked privileges, exactly two guard triggers, and that the documented
 * ROLLBACK block restores the original table set. Exit code 1 if any check fails.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const MIG = join(dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations/20261013180000_role_shadow_captures.sql");
const sql = readFileSync(MIG, "utf8");
const base = {
 "capture_id": "rsc:6e555a5536deb44f",
 "capture_class": "LIVE_CAPTURED",
 "season": 2026,
 "week": 6,
 "league_slug": "bloodline-bowl",
 "provider": "sleeper",
 "canonical_player_id": "p1",
 "gsis_id": "00-0001",
 "position": "WR",
 "challenger_model_id": "role-opportunity-challenger-2026.0",
 "challenger_config_hash": "a95fe2c494cee49e4dec475bb176a6bc",
 "control_config_hash": "327a30acfcba88b5dc8c37576c8a25e0",
 "scoring_fingerprint": "scoring:v1:aaaaaaaaaaaaaaaaaaaaaaaa",
 "scoring_compatibility": "TEMPLATE_HALF_ON_MODELED_KEYS",
 "kickoff_at": "2026-10-18T17:00:00.000Z",
 "captured_at": "2026-10-16T17:00:00.000Z",
 "source_observed_at": "2026-10-16T16:30:00.000Z",
 "eligible": true,
 "content_hash": "bf26ce7a1182fc4df5b9cbb08f5fdfe1",
 "record_schema_version": 1,
 "record": {
  "capture_id": "rsc:6e555a5536deb44f",
  "may_influence_production": false,
  "lifecycle_state": "SHADOW_ONLY"
 }
};
const db = new PGlite();
await db.exec("create role anon; create role authenticated;");
const results = [];
const ok = (name, cond, extra = "") => { results.push({ name, pass: !!cond, extra }); };
const tables = async () => (await db.query("select table_name from information_schema.tables where table_schema='public' order by 1")).rows.map((r) => r.table_name);

const before = await tables();
await db.exec(sql);
const after = await tables();
ok("migration applies cleanly; adds exactly one table", after.length === before.length + 1 && after.includes("bridge_role_shadow_captures"), after.join());
await db.exec(sql); // idempotent re-apply
ok("migration is idempotent (applies twice with no error)", true);

const ins = async (over = {}, rec = {}) => {
  const row = { ...base, ...over };
  row.record = { ...base.record, capture_id: row.capture_id, ...rec };
  const cols = Object.keys(row);
  const vals = cols.map((c) => (c === "record" ? JSON.stringify(row[c]) : row[c]));
  const q = `insert into public.bridge_role_shadow_captures (${cols.join(",")}) values (${cols.map((_, i) => (cols[i] === "record" ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(",")}) on conflict (capture_id) do nothing returning capture_id`;
  return db.query(q, vals);
};
const fails = async (name, fn, re) => { try { await fn(); ok(name, false, "no error raised"); } catch (e) { ok(name, re.test(String(e.message)), String(e.message).slice(0, 110)); } };
const future = (d) => new Date(Date.now() + d * 3600e3).toISOString();

// valid pregame row (kickoff in the future on the DB clock)
const good = { kickoff_at: future(48), captured_at: future(1), source_observed_at: future(0.5) };
const r1 = await ins(good);
ok("valid LIVE_CAPTURED pregame insert", r1.rows.length === 1);
const r2 = await ins(good);
ok("duplicate id is a silent no-op under ON CONFLICT DO NOTHING (idempotent)", r2.rows.length === 0);
ok("exactly one row stored", (await db.query("select count(*)::int n from public.bridge_role_shadow_captures")).rows[0].n === 1);

await fails("UPDATE is rejected (insert-only)", () => db.query("update public.bridge_role_shadow_captures set eligible=false"), /immutable/);
await fails("DELETE is rejected (insert-only)", () => db.query("delete from public.bridge_role_shadow_captures"), /immutable/);
await fails("TRUNCATE-free: row still present after attempts", async () => { const n = (await db.query("select count(*)::int n from public.bridge_role_shadow_captures")).rows[0].n; if (n !== 1) return; throw new Error("immutable-ok"); }, /immutable-ok/);

const id = (n) => ({ capture_id: `rsc:${String(n).padStart(16, "0")}` });
await fails("LATE: LIVE_CAPTURED insert is refused on the DATABASE clock when now() >= kickoff", () => ins({ ...id(2), kickoff_at: future(-1), captured_at: future(-3), source_observed_at: future(-4) }), /insert refused/);
await fails("LATE even though the app-supplied captured_at is pregame (app clock cannot override the DB clock)", () => ins({ ...id(3), kickoff_at: future(-0.01), captured_at: future(-5), source_observed_at: future(-6) }), /insert refused/);
await fails("CHECK: LIVE_CAPTURED requires captured_at < kickoff_at", () => ins({ ...id(4), kickoff_at: future(10), captured_at: future(11), source_observed_at: future(1) }), /bridge_role_shadow_live_is_pregame/);
await fails("CHECK: LIVE_CAPTURED requires source_observed_at < kickoff_at", () => ins({ ...id(5), kickoff_at: future(10), captured_at: future(1), source_observed_at: future(10) }), /bridge_role_shadow_live_is_pregame/);
await fails("CHECK: LIVE_CAPTURED requires a source observation instant", () => ins({ ...id(6), kickoff_at: future(10), captured_at: future(1), source_observed_at: null }), /bridge_role_shadow_live_is_pregame/);
await fails("CHECK: HISTORICALLY_RECONSTRUCTED can never be eligible", () => ins({ ...id(7), capture_class: "HISTORICALLY_RECONSTRUCTED", eligible: true, kickoff_at: future(-100), captured_at: future(-120), source_observed_at: future(-121) }), /bridge_role_shadow_reconstructed_never_eligible/);
const rec = await ins({ ...id(8), capture_class: "HISTORICALLY_RECONSTRUCTED", eligible: false, kickoff_at: future(-100), captured_at: future(-120), source_observed_at: null });
ok("a reconstructed, non-eligible row may be stored for a PAST kickoff (the live-clock rule does not apply to it)", rec.rows.length === 1);
await fails("CHECK: record must be SHADOW_ONLY", () => ins({ ...id(9), ...good }, { lifecycle_state: "PRODUCTION" }), /check constraint/);
await fails("CHECK: may_influence_production must be false", () => ins({ ...id(10), ...good }, { may_influence_production: true }), /check constraint/);
await fails("CHECK: record.capture_id must equal the row id", () => ins({ ...id(11), ...good }, { capture_id: "rsc:ffffffffffffffff" }).then(() => {}), /check constraint/);
await fails("CHECK: position limited to QB/RB/WR/TE (no K/DST)", () => ins({ ...id(12), ...good, position: "K" }), /check constraint/);
await fails("CHECK: capture_id format", () => ins({ capture_id: "bad-id", ...good }), /check constraint/);
await fails("CHECK: config hash format", () => ins({ ...id(13), ...good, challenger_config_hash: "xyz" }), /check constraint/);
await fails("CHECK: unknown capture class", () => ins({ ...id(14), ...good, capture_class: "LIVE_POST_LOCK" }), /check constraint/);

const rls = (await db.query("select relrowsecurity from pg_class where relname='bridge_role_shadow_captures'")).rows[0];
ok("row level security enabled", rls.relrowsecurity === true);
const priv = (await db.query("select has_table_privilege('anon','public.bridge_role_shadow_captures','SELECT') a, has_table_privilege('anon','public.bridge_role_shadow_captures','INSERT') b, has_table_privilege('authenticated','public.bridge_role_shadow_captures','SELECT') c, has_table_privilege('authenticated','public.bridge_role_shadow_captures','INSERT') d")).rows[0];
ok("anon/authenticated have NO privileges (service-role only)", !priv.a && !priv.b && !priv.c && !priv.d, JSON.stringify(priv));
const trg = (await db.query("select tgname from pg_trigger where tgrelid='public.bridge_role_shadow_captures'::regclass and not tgisinternal order by 1")).rows.map((r) => r.tgname);
ok("exactly the two guard triggers exist", JSON.stringify(trg) === JSON.stringify(["bridge_role_shadow_captures_immutable", "bridge_role_shadow_captures_not_late"]), trg.join());

// rollback block from the migration header
const rb = ["drop table if exists public.bridge_role_shadow_captures;", "drop function if exists public.bridge_role_shadow_immutable();", "drop function if exists public.bridge_role_shadow_not_late();"];
await db.exec(rb.join("\n"));
const fnLeft = (await db.query("select proname from pg_proc where proname like 'bridge_role_shadow%'")).rows.length;
ok("documented rollback removes the table and both functions completely", !(await tables()).includes("bridge_role_shadow_captures") && fnLeft === 0);
ok("rollback restores the original table set", JSON.stringify(await tables()) === JSON.stringify(before));

for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "   <-- " + r.extra}`);
const bad = results.filter((r) => !r.pass);
console.log(`\n${results.length - bad.length}/${results.length} migration checks passed`);
process.exit(bad.length ? 1 : 0);
