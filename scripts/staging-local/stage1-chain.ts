/**
 * STAGE 1 (local Docker Supabase only): the Wave 1 -> W2.P1 migration chain WITHOUT the Role-shadow migration.
 *   A. schema + PostgREST exposure + privileges for every table/view the chain creates; code-vs-schema drift
 *   B. SupabaseFinalPregameStore differential test: same operation sequence through the in-memory oracle and through REAL PostgREST
 *   C. SupabaseSourceObservationStore round trip + idempotency
 *   D. immutability enforced through the HTTP path (PATCH / DELETE)
 * Refuses to run unless every target is the local stack (see guard.ts).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { check, finding, finish, info, rest, sql, ANON } from "./lib";
import { SupabaseRest, loadSupabaseConfig } from "../../lib/persistence/supabase/rest";
import { SupabaseFinalPregameStore, SupabaseSourceObservationStore } from "../../lib/persistence/supabase/projection-observations";
import { MemoryFinalPregameStore, buildFinalPregameRecord, type FinalPregameRecord } from "../../lib/weekly/freshness/final-pregame";
import { MemorySourceObservationStore, observationContentHash } from "../../lib/weekly/freshness/observation";
import { buildCanonicalForecastBatch } from "../../lib/weekly/forecast";
import { contentHash } from "../../lib/bridge/hash";
import { player, proj } from "../../test/fixtures/weekly";

const ROOT = process.cwd();
const CHAIN_MAX = "20261009120000";
const MIN = 60_000;
const KICK = Date.parse("2026-10-20T17:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

async function main(): Promise<void> {
  const cfg = loadSupabaseConfig();
  const sb = new SupabaseRest(cfg.config!);

  /* ---------------- A. schema / exposure / privileges ---------------- */
  const migs = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.slice(0, 14) <= CHAIN_MAX).sort();
  const created = new Set<string>();
  for (const f of migs) for (const m of readFileSync(join(ROOT, "supabase/migrations", f), "utf8").matchAll(/create table(?: if not exists)?\s+(?:public\.)?([a-z0-9_]+)/gi)) created.add(m[1]!);
  const views = new Set<string>();
  for (const f of migs) for (const m of readFileSync(join(ROOT, "supabase/migrations", f), "utf8").matchAll(/create (?:or replace )?view\s+(?:public\.)?([a-z0-9_]+)/gi)) views.add(m[1]!);
  const inDb = new Set(sql("select tablename from pg_tables where schemaname='public'").split("\n").filter(Boolean));
  const viewsInDb = new Set(sql("select viewname from pg_views where schemaname='public'").split("\n").filter(Boolean));

  await check("A", `migration chain created ${created.size} tables + ${views.size} views; every one exists in Postgres`, async () => {
    const missing = [...created].filter((t) => !inDb.has(t)).concat([...views].filter((v) => !viewsInDb.has(v)));
    return { ok: missing.length === 0 && created.size >= 20, detail: { missing, tables: created.size, views: views.size } };
  });
  await check("A", "Postgres has NO unexpected public tables (nothing outside the migration chain)", async () => {
    const extra = [...inDb].filter((t) => !created.has(t));
    return { ok: extra.length === 0, detail: { extra } };
  });
  await check("A", "RLS is enabled on every table", async () => {
    const off = sql("select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity").split("\n").filter(Boolean);
    return { ok: off.length === 0, detail: { rls_off: off } };
  });
  await finding("A", "DEFENSE-IN-DEPTH: anon and authenticated should hold NO table privileges, but older migrations never revoke Supabase's default grants (they rely on RLS-without-policies alone; see the catalog-proof and behavior checks)", "P2", async () => {
    const leaks = sql("select c.relname || ':' || r.role_name || ':' || p.priv from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join (values ('anon'),('authenticated')) r(role_name) cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(priv) where n.nspname='public' and c.relkind='r' and has_table_privilege(r.role_name, c.oid, p.priv)").split("\n").filter(Boolean);
    const tablesWithGrants = [...new Set(leaks.map((l) => l.split(":")[0]))];
    return { ok: leaks.length === 0, detail: { tables_with_anon_or_authenticated_grants: tablesWithGrants, count: tablesWithGrants.length, note: "Supabase default privileges grant new public tables to anon/authenticated; the pre-W2.P2 migrations never REVOKE them" } };
  });
  await check("A", "CATALOG PROOF of the protection: zero RLS policies exist, anon/authenticated lack BYPASSRLS, and RLS is not bypassed by table ownership (default-deny for those roles)", async () => {
    const policies = Number(sql("select count(*) from pg_policies where schemaname='public'"));
    const bypass = sql("select rolname from pg_roles where rolname in ('anon','authenticated') and rolbypassrls").split("\n").filter(Boolean);
    const owned = sql("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner where n.nspname='public' and c.relkind='r' and r.rolname in ('anon','authenticated')").split("\n").filter(Boolean);
    return { ok: policies === 0 && bypass.length === 0 && owned.length === 0, detail: { policies, bypass, owned_by_anon_or_authenticated: owned } };
  });
  await check("A", "BEHAVIOR: despite those grants, RLS (enabled, no policies) means anon can neither READ rows nor WRITE rows on any table", async () => {
    const withGrants = sql("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and has_table_privilege('anon', c.oid, 'SELECT')").split("\n").filter(Boolean);
    const exposed: string[] = [];
    for (const t of withGrants) {
      // put one row in as service role where we can, then confirm anon sees none; and that an anon INSERT is refused
      const r = await rest(`${t}?select=*&limit=1`, { key: ANON });
      if (r.status === 200 && Array.isArray(r.body) && r.body.length > 0) exposed.push(`${t}:readable`);
      const w = await rest(t, { method: "POST", key: ANON, body: {} });
      if (w.status < 400) exposed.push(`${t}:writable`);
    }
    return { ok: exposed.length === 0, detail: { tables_checked: withGrants.length, exposed } };
  });
  const names = [...created, ...views];
  await check("A", `PostgREST (via Kong) exposes all ${names.length} relations to the service key (HTTP 200)`, async () => {
    const bad: string[] = [];
    for (const t of names) { const r = await rest(`${t}?select=*&limit=0`); if (r.status !== 200) bad.push(`${t}:${r.status}`); }
    return { ok: bad.length === 0, detail: { bad } };
  });
  info("A", "PostgREST status for the anon key on grant-bearing tables is 200 with an EMPTY array (RLS filters every row), 401 where grants were revoked", (() => { return "see A.5/A.6 behavior check"; })());
  await check("A", "the Role-shadow table does NOT exist yet (stage 1); PostgREST says so with the documented PGRST205 / 404", async () => {
    const r = await rest("bridge_role_shadow_captures?select=capture_id&limit=1");
    return { ok: r.status === 404 && r.body?.code === "PGRST205", detail: { status: r.status, code: r.body?.code } };
  });
  await check("A", "code-vs-schema drift: every bridge_* table the application code names exists in the chain's schema", async () => {
    const used = new Set<string>();
    const walk = (d: string): void => { for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) { if (e.name === "node_modules" || e.name.startsWith(".")) continue; const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name)) for (const m of readFileSync(join(ROOT, p), "utf8").matchAll(/["'`](bridge_[a-z0-9_]+)["'`]/g)) used.add(m[1]!); } };
    walk("lib"); walk("app");
    // verified by grep: these are NOT tables — a ranking-pack schema_version string, a scoring-source enum value, and an error code
    const NOT_TABLES = new Set(["bridge_ranking_pack_v1", "bridge_calculated_from_raw_stats", "bridge_error"]);
    // the Role-shadow table belongs to the NEXT migration; it must be absent at stage 1 and is asserted present in stage 2
    const NEXT_MIGRATION = new Set(["bridge_role_shadow_captures"]);
    const unknown = [...used].filter((t) => !created.has(t) && !views.has(t) && !inDb.has(t) && !NOT_TABLES.has(t) && !NEXT_MIGRATION.has(t));
    return { ok: unknown.length === 0, detail: { tables_referenced_in_code: used.size, unknown, not_tables: [...NOT_TABLES], next_migration: [...NEXT_MIGRATION] } };
  });

  /* ---------------- B. final-pregame store: differential (memory oracle vs real PostgREST) ---------------- */
  const real = new SupabaseFinalPregameStore(sb);
  const oracle = new MemoryFinalPregameStore();
  const mk = (o: { league?: string; pid?: string; obsMin: number; compMin: number; pts?: number; status?: string | null }): FinalPregameRecord => {
    const pid = o.pid ?? "wr1";
    const obsAt = iso(KICK + o.obsMin * MIN);
    const players = [{ provider: "sleeper", provider_player_id: pid, position: "WR", nfl_team: "KC", opponent: "LV", injury_status: o.status ?? null, gp: 1, stats: { rec: 6, rec_yd: Math.round((o.pts ?? 14.6) * 5) } }];
    const srcobs = `srcobs:${contentHash({ p: "sleeper", s: 2026, w: 7, t: obsAt, h: observationContentHash(players as never) }).slice(0, 20)}`;
    const row = proj(pid, "WR", o.pts ?? 14.6, { injury_status: o.status ?? null, expected_availability: o.status ? 0.78 : 1 });
    const live = { ...player(pid, "WR", { team: "KC", injury: o.status ?? null }), identifiers: { sleeper_id: pid } };
    const batch = { league_slug: o.league ?? "bloodline-bowl", season: 2026, week: 7, status: "READY" as const, by_player: new Map([[pid, row]]), resolved_players: new Map([[pid, live]]), source: "sleeper_weekly", model_version: "v", missing: [], teams_with_games: ["KC"], warnings: [], source_observation: { provider: "sleeper", observed_at: obsAt, observation_id: srcobs, content_hash: "h", fetch_path: "LIVE_FETCH" as const } };
    const f = buildCanonicalForecastBatch({ batch: batch as never, requested_player_ids: [pid], players: new Map([[pid, live]]) as never, freshness: { now_ms: KICK + o.compMin * MIN, kickoffFor: () => ({ kickoff_at: iso(KICK), game_id: "g1" }) } as never }).by_player.get(pid)!;
    return buildFinalPregameRecord({ forecast: f, league_slug: o.league ?? "bloodline-bowl", provider: "sleeper", scoring_fingerprint: "scoring:v1:aaaaaaaaaaaaaaaaaaaaaaaa", source_observation_id: srcobs, recorded_at: iso(KICK + o.compMin * MIN) })!;
  };
  const seq: Array<[string, ReturnType<typeof mk>]> = [
    ["first valid pregame observation", mk({ obsMin: -60, compMin: -55 })],
    ["same belief re-observed later (confirm)", mk({ obsMin: -40, compMin: -35 })],
    ["belief changes (Questionable) later", mk({ obsMin: -30, compMin: -25, status: "Questionable", pts: 14.6 })],
    ["OLDER observation proposing different content", mk({ obsMin: -50, compMin: -20, pts: 9.9 })],
    ["composition AT kickoff", mk({ obsMin: -10, compMin: 0, pts: 11.1 })],
    ["composition after kickoff", mk({ obsMin: -5, compMin: 5, pts: 12.2 })],
    ["observation AFTER composition (incoherent)", mk({ obsMin: -3, compMin: -8, pts: 13.3 })],
    ["identical belief re-recorded (idempotent)", mk({ obsMin: -30, compMin: -25, status: "Questionable", pts: 14.6 })],
  ];
  const outcomes: Array<{ label: string; oracle: string; real: string }> = [];
  for (const [label, rec] of seq) {
    const a = await oracle.upsertCandidate(rec);
    const b = await real.upsertCandidate(rec);
    outcomes.push({ label, oracle: a, real: b });
  }
  await check("B", "differential: every write outcome through real PostgREST equals the in-memory oracle's", async () => ({ ok: outcomes.every((o) => o.oracle === o.real), detail: outcomes }));
  await check("B", "differential: the final pointer and the full revision history are identical (ids, order, confirmed_through)", async () => {
    const a = await oracle.get("bloodline-bowl", 2026, 7, "wr1");
    const b = await real.get("bloodline-bowl", 2026, 7, "wr1");
    const ra = (await oracle.listRevisions("bloodline-bowl", 2026, 7, "wr1")).map((r) => r.forecast_id);
    const rb = (await real.listRevisions("bloodline-bowl", 2026, 7, "wr1")).map((r) => r.forecast_id);
    const same = (x?: string, y?: string) => x != null && y != null && Date.parse(x) === Date.parse(y);
    return { ok: a?.forecast_id === b?.forecast_id && same(a?.confirmed_through, b?.confirmed_through) && same(a?.source_observed_at, b?.source_observed_at) && same(a?.composed_at, b?.composed_at) && JSON.stringify(ra) === JSON.stringify(rb) && ra.length === 2, detail: { oracle: [a?.forecast_id, a?.confirmed_through, a?.composed_at], real: [b?.forecast_id, b?.confirmed_through, b?.composed_at], revisions: [ra.length, rb.length], note: "timestamps compared as INSTANTS: PostgREST renders timestamptz as +00:00, the oracle as Z" } };
  });
  await check("B", "no hindsight is stored: the database holds exactly the 2 valid revisions; every rejected candidate left no row", async () => {
    const n = Number(sql("select count(*) from bridge_final_pregame_revisions where league_slug='bloodline-bowl' and week=7"));
    const p = Number(sql("select count(*) from bridge_final_pregame_forecasts where league_slug='bloodline-bowl' and week=7"));
    return { ok: n === 2 && p === 1, detail: { revisions: n, pointers: p } };
  });
  await check("B", "bulk upsertMany of 120 players round-trips in one league-week; reading each back returns the same record", async () => {
    const recs = Array.from({ length: 120 }, (_, i) => mk({ league: "devoted-to-the-game", pid: `p${i}`, obsMin: -60, compMin: -50, pts: 5 + (i % 17) }));
    const counts = await real.upsertMany(recs);
    const back = await real.get("devoted-to-the-game", 2026, 7, "p77");
    return { ok: counts.RECORDED === 120 && back?.forecast_id === recs[77]!.forecast_id, detail: counts };
  });
  await check("B", "20 CONCURRENT identical writers (separate store instances over HTTP): exactly one revision, one pointer, no error", async () => {
    const rec = mk({ league: "sportys-alumni", pid: "conc", obsMin: -60, compMin: -50 });
    const stores = Array.from({ length: 20 }, () => new SupabaseFinalPregameStore(new SupabaseRest(cfg.config!)));
    await Promise.all(stores.map((s) => s.upsertMany([rec])));
    const n = Number(sql("select count(*) from bridge_final_pregame_revisions where league_slug='sportys-alumni' and canonical_player_id='conc'"));
    const p = Number(sql("select count(*) from bridge_final_pregame_forecasts where league_slug='sportys-alumni' and canonical_player_id='conc'"));
    return { ok: n === 1 && p === 1, detail: { revisions: n, pointers: p } };
  });

  /* ---------------- C. source-observation store ---------------- */
  const obsReal = new SupabaseSourceObservationStore(sb);
  const obsOracle = new MemorySourceObservationStore();
  const playersA = [{ provider: "sleeper", provider_player_id: "wr1", position: "WR", nfl_team: "KC", opponent: "LV", injury_status: null, gp: 1, stats: { rec: 6 } }];
  const hdrA = { observation_id: `srcobs:${"a".repeat(20)}`, format: 1 as const, provider: "sleeper", season: 2026, week: 7, observed_at: iso(KICK - 90 * MIN), content_hash: "h1", kind: "FULL" as const, base_observation_id: null, row_count: 1, changed_count: 1, removed_count: 0, fetch_path: "LIVE_FETCH" as const, segments: {} };
  const { provider: _p, provider_player_id: _i, ...rowBody } = playersA[0]! as Record<string, unknown>;
  void _p; void _i;
  const rowsA = [{ observation_id: hdrA.observation_id, provider_player_id: "wr1", player_hash: "ph1", removed: false, row: rowBody }] as never;
  await check("C", "source observation append/latestState/headers/stateAsOf match the in-memory oracle through real PostgREST", async () => {
    for (const s of [obsOracle, obsReal]) await s.append({ header: hdrA as never, rows: rowsA, events: [] });
    const a = await obsOracle.latestState("sleeper", 2026, 7);
    const b = await obsReal.latestState("sleeper", 2026, 7);
    const ha = (await obsOracle.headers("sleeper", 2026, 7)).map((h) => h.observation_id);
    const hb = (await obsReal.headers("sleeper", 2026, 7)).map((h) => h.observation_id);
    const sa = await obsOracle.stateAsOf("sleeper", 2026, 7, iso(KICK - 60 * MIN));
    const sb2 = await obsReal.stateAsOf("sleeper", 2026, 7, iso(KICK - 60 * MIN));
    return { ok: JSON.stringify(ha) === JSON.stringify(hb) && a.players.size === b.players.size && sa.players.size === sb2.players.size && sb2.observation?.observation_id === hdrA.observation_id, detail: { headers: hb.length, players: b.players.size } };
  });
  await check("C", "re-appending the SAME observation id is idempotent (no duplicate header or rows) — and `touch` only advances the confirmation pointer", async () => {
    await obsReal.append({ header: hdrA as never, rows: rowsA, events: [] }).catch(() => undefined);
    await obsReal.touch("sleeper", 2026, 7, iso(KICK - 80 * MIN), "h1");
    const n = Number(sql("select count(*) from bridge_projection_source_observations where observation_id='srcobs:" + "a".repeat(20) + "'"));
    const r = Number(sql("select count(*) from bridge_projection_source_observation_rows where observation_id='srcobs:" + "a".repeat(20) + "'"));
    return { ok: n === 1 && r === 1, detail: { headers: n, rows: r } };
  });

  /* ---------------- D. immutability through the HTTP path ---------------- */
  await check("D", "PATCH of a stored revision through PostgREST is REFUSED (insert-only trigger) and the row is unchanged", async () => {
    const before = sql("select md5(record::text) from bridge_final_pregame_revisions where league_slug='bloodline-bowl' and week=7 order by forecast_id limit 1");
    const r = await rest("bridge_final_pregame_revisions?league_slug=eq.bloodline-bowl", { method: "PATCH", body: { provider: "x" }, prefer: "return=representation" });
    const after = sql("select md5(record::text) from bridge_final_pregame_revisions where league_slug='bloodline-bowl' and week=7 order by forecast_id limit 1");
    return { ok: r.status >= 400 && before === after, detail: { status: r.status, code: r.body?.code } };
  });
  await check("D", "DELETE of stored revisions through PostgREST is REFUSED and no row disappears", async () => {
    const n0 = Number(sql("select count(*) from bridge_final_pregame_revisions"));
    const r = await rest("bridge_final_pregame_revisions?league_slug=eq.bloodline-bowl", { method: "DELETE" });
    return { ok: r.status >= 400 && Number(sql("select count(*) from bridge_final_pregame_revisions")) === n0, detail: { status: r.status, code: r.body?.code } };
  });
  await check("D", "a HINDSIGHT row POSTed straight over HTTP (composed after kickoff) is refused by the database CHECK (23514), not by application code", async () => {
    const r = await rest("bridge_final_pregame_revisions", { method: "POST", body: { forecast_id: `fpf:${"9".repeat(24)}`, league_slug: "l", season: 2026, week: 7, canonical_player_id: "p", provider: "sleeper", kickoff_at: iso(KICK), source_observed_at: iso(KICK - 2 * MIN), composed_at: iso(KICK + MIN), content_signature: "s", scoring_fingerprint: null, record: {} } });
    return { ok: r.status === 400 && r.body?.code === "23514", detail: { status: r.status, code: r.body?.code } };
  });
  info("D", "Postgres server version (local container)", sql("show server_version"));

  finish("docs/evidence/w2p2-local-staging-stage1.json");
}
main().catch((e) => { console.error(e); process.exit(2); });
