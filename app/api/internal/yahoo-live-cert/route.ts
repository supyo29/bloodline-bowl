/**
 * TEMPORARY, PREVIEW-ONLY live certification harness for the Yahoo token lifecycle + Market State (removed before merge).
 * 404 outside a Vercel PREVIEW deployment (and the preview is behind Vercel Authentication). GET-only against Yahoo. Output is credential-free.
 * ?step=market&league=<slug> | state&league= | waivers&league=&manager= | health | keepalive | rotate&connection=<id> | concurrent&connection=<id>
 */
import { loadYahooConfig } from "@/lib/providers/yahoo/config";
import { resolveYahooTokenStore } from "@/lib/providers/yahoo/token-store";
import { getValidAccessToken, getYahooLifecycleRecord } from "@/lib/providers/yahoo/oauth";
import { getYahooConnectionHealth } from "@/lib/providers/yahoo/health";
import { runYahooHealthJob } from "@/lib/providers/yahoo/health-job";
import { listYahooConnectionBindings } from "@/lib/providers/yahoo/connections";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type Call = { method: string; host: string; path: string };
const g = globalThis as unknown as { __certCalls?: Call[]; __certInstalled?: boolean };
g.__certCalls ??= [];
if (!g.__certInstalled) {
  g.__certInstalled = true; const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    try { const u = new URL(String(input instanceof Request ? input.url : input)); const m = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(); g.__certCalls!.push({ method: m, host: u.host, path: u.pathname.replace(/\d{6,}/g, "#").slice(0, 80) }); } catch { /* ignore */ }
    return real(input as never, init);
  }) as typeof fetch;
}
const mark = () => g.__certCalls!.length;
const since = (n: number) => { const c = g.__certCalls!.slice(n); const yahoo = c.filter((x) => /yahoo/i.test(x.host)); return { total: c.length, yahoo_hosts: [...new Set(yahoo.map((x) => x.host))], yahoo_gets: yahoo.filter((x) => x.method === "GET" && x.host.includes("yahooapis")).length, token_endpoint_posts: yahoo.filter((x) => x.method === "POST" && /login\.yahoo\.com/.test(x.host)).length, other_non_get_yahoo: yahoo.filter((x) => x.method !== "GET" && !/login\.yahoo\.com/.test(x.host)).length }; };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b, null, 1), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function GET(request: Request): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") return new Response("Not Found", { status: 404 });
  const q = new URL(request.url).searchParams; const step = q.get("step") ?? "";
  try {
    if (step === "health") {
      const out = []; for (const b of listYahooConnectionBindings()) { const r = resolveYahooTokenStore(process.env, { connectionId: b.connection_id }); out.push(r.ok ? await getYahooConnectionHealth(b.connection_id, r.store) : { connection_id: b.connection_id, status: "STORE_UNAVAILABLE" }); }
      return json({ step, out });
    }
    if (step === "keepalive") { const n = mark(); const res = await runYahooHealthJob(); return json({ step, res, enforcement: since(n) }); }
    if (step === "rotate" || step === "concurrent") {
      const conn = q.get("connection") ?? ""; if (!listYahooConnectionBindings().some((b) => b.connection_id === conn)) return json({ error: "unknown connection" }, 400);
      const cfg = loadYahooConfig(); const r = resolveYahooTokenStore(process.env, { connectionId: conn }); if (!cfg.configured || !cfg.config || !r.ok) return json({ error: "config/store unavailable", configured: cfg.configured, store_ok: r.ok }, 503);
      const other = listYahooConnectionBindings().map((b) => b.connection_id).filter((c) => c !== conn); const otherStores = other.map((c) => { const rr = resolveYahooTokenStore(process.env, { connectionId: c }); return rr.ok ? rr.store : null; });
      const snap = async (s: typeof r.store) => { const v = await s.getVersioned?.(); return v ? { seq: v.seq, expires_at: new Date(v.token.expires_at).toISOString(), last_refreshed_at: v.last_refreshed_at, access_changed_marker: v.token.access_token.length, refresh_len: v.token.refresh_token.length } : null; };
      const marker = async (s: typeof r.store) => { const v = await s.getVersioned?.(); return v ? `${v.token.access_token.slice(-0)}${v.seq}` : null; };
      const beforeOther = await Promise.all(otherStores.map(async (s) => (s ? JSON.stringify(await s.getVersioned?.().then((v) => v && { seq: v.seq, exp: v.token.expires_at, a: v.token.access_token.length })) : null)));
      const before = await snap(r.store); const beforeTok = (await r.store.getVersioned!())!.token; const n = mark();
      const calls = step === "concurrent" ? 6 : 1;
      const results = await Promise.all(Array.from({ length: calls }, () => getValidAccessToken(cfg.config!, r.store, { forceRefresh: true })));
      const after = await snap(r.store); const afterTok = (await r.store.getVersioned!())!.token; void marker;
      const afterOther = await Promise.all(otherStores.map(async (s) => (s ? JSON.stringify(await s.getVersioned?.().then((v) => v && { seq: v.seq, exp: v.token.expires_at, a: v.token.access_token.length })) : null)));
      return json({ step, connection: conn, calls, statuses: results.map((x) => x.status), failure_kinds: results.map((x) => x.failure_kind ?? null), reauth: results.map((x) => x.reauthorization_required ?? false), all_same_access_token: new Set(results.map((x) => x.access_token)).size === 1, before, after, seq_delta: before && after ? after.seq - before.seq : null, access_token_rotated: beforeTok.access_token !== afterTok.access_token, refresh_token_rotated: beforeTok.refresh_token !== afterTok.refresh_token, persisted_equals_served: results.every((x) => x.access_token === afterTok.access_token), other_connections_untouched: JSON.stringify(beforeOther) === JSON.stringify(afterOther), lifecycle: getYahooLifecycleRecord(conn), enforcement: since(n) });
    }
    const slug = q.get("league") ?? ""; if (!["maclin-on-chicks-xvi", "rogers-park"].includes(slug)) return json({ error: "league must be maclin-on-chicks-xvi or rogers-park" }, 400);
    if (step === "state") {
      const { buildCanonicalLeagueState } = await import("@/lib/canonical/state"); const n = mark(); const st = (await buildCanonicalLeagueState(slug, { reportPersistence: false } as never)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      const s = st.snapshot ?? st; return json({ step, keys: Object.keys(s).slice(0, 30), managers: (s.managers ?? []).map((m: any) => ({ id: m.canonical_manager_id, slug: m.manager_slug ?? m.slug ?? null, name: m.display_name ?? null })), teams: (s.teams ?? []).length, players: (s.players ?? []).length, enforcement: since(n) }); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    if (step === "pages") {
      const { defaultYahooMarketIO: io } = await import("@/lib/market-state/yahoo-load"); const o = await io.open(slug); if (!o.ok) return json({ error: o.code });
      const out: Record<string, number[]> = {};
      for (const code of ["T", "FA"]) { const arr: number[] = []; for (let i = 0; i < (code === "T" ? 10 : 45); i++) { const { data } = await o.handle.client.get(`/league/${o.handle.leagueKey}/players;status=${code};start=${i * 25};count=25;sort=OR/ownership`) as any; const pl = data?.fantasy_content?.league?.[1]?.players ?? {}; arr.push(Object.keys(pl).filter((k) => k !== "count").length); if (arr.length > 3 && arr.slice(-3).every((x) => x === 0)) break; } out[code] = arr; } // eslint-disable-line @typescript-eslint/no-explicit-any
      return json({ step, slug, rows_per_page: out });
    }
    if (step === "recon") {
      const { defaultYahooMarketIO: io } = await import("@/lib/market-state/yahoo-load");
      const o = await io.open(slug); if (!o.ok) return json({ error: o.code });
      const teams = await io.teams(o.handle); const rosterRows = new Map<string, { team: string; slot: string | null; name: string | null; pos: string | null; nfl: string | null; status: unknown }>();
      for (const t of teams) { const r = (await io.roster(o.handle, t.team_key)) as any; const byKey = new Map<string, any>((r.players ?? []).map((p: any) => [p.player_key, p])); for (const sl of r.slots ?? []) { const pl = byKey.get(sl.player_key) ?? {}; rosterRows.set(sl.player_key, { team: t.team_key.split(".t.")[1] ?? "?", slot: sl.selected_position ?? null, name: pl.name ?? pl.full_name ?? null, pos: pl.position ?? pl.display_position ?? null, nfl: pl.team ?? pl.editorial_team_abbr ?? null, status: pl.status ?? pl.injury_status ?? null }); } } // eslint-disable-line @typescript-eslint/no-explicit-any
      const T = await io.pool(o.handle, "T", Date.now() + 120_000); const tKeys = new Set(T.players.map((p: any) => p.player_key)); // eslint-disable-line @typescript-eslint/no-explicit-any
      const only = [...rosterRows].filter(([k]) => !tKeys.has(k)).map(([k, v]) => ({ key: k, ...v }));
      const slotDist: Record<string, number> = {}; for (const v of rosterRows.values()) slotDist[v.slot ?? "?"] = (slotDist[v.slot ?? "?"] ?? 0) + 1;
      const { fetchPlayersWithOwnership } = await import("@/lib/providers/yahoo/players");
      const T2 = await io.pool(o.handle, "T", Date.now() + 120_000); const T3 = await io.pool(o.handle, "T", Date.now() + 120_000);
      const direct = await fetchPlayersWithOwnership(o.handle.client, o.handle.leagueKey, only.map((x) => x.key)); const dist: Record<string, number> = {}; for (const p of direct.players as any[]) dist[p.status ?? "?"] = (dist[p.status ?? "?"] ?? 0) + 1; // eslint-disable-line @typescript-eslint/no-explicit-any
      const FA = await io.pool(o.handle, "FA", Date.now() + 120_000); const W = await io.pool(o.handle, "W", Date.now() + 120_000); const poolKeys = new Set([...FA.players, ...W.players].map((p: any) => p.player_key)); // eslint-disable-line @typescript-eslint/no-explicit-any
      return json({ step, slug, roster_union: rosterRows.size, T_pool_runs: [T.players.length, T2.players.length, T3.players.length], T_requests_sample: T.requests.slice(0, 2), direct_lookup_of_roster_only: { asked: only.length, classified_status_counts: dist, unclassified: direct.unclassified.length }, roster_only_present_in_FA_or_W: only.filter((x) => poolKeys.has(x.key)).length, FA_total: FA.players.length, W_total: W.players.length, roster_only_n: only.length, slot_distribution: slotDist });
    }
    if (step === "market") {
      const { loadYahooMarketSnapshot, defaultYahooMarketIO, __clearYahooMarketMemo, yahooBindingFor } = await import("@/lib/market-state/yahoo-load");
      const { buildFreeAgentPool, acquirablePlayers } = await import("@/lib/market-state/pool");
      const { getNflState } = await import("@/lib/sleeper/client"); const week = Math.max(1, Number((await getNflState().catch(() => null))?.week ?? 1));
      __clearYahooMarketMemo(); const n = mark(); const t0 = Date.now();
      const snap = await loadYahooMarketSnapshot(slug, { week, noMemo: true, poolTimeBudgetMs: 150_000 }, defaultYahooMarketIO); const spent = Date.now() - t0; const reqs = since(n);
      const pool = buildFreeAgentPool(snap); const acq = acquirablePlayers(pool); const ev = (snap as any).pool_evidence ?? {}; const r = snap.acquisition.rules; const b = yahooBindingFor(slug); // eslint-disable-line @typescript-eslint/no-explicit-any
      __clearYahooMarketMemo(); const a = await loadYahooMarketSnapshot(slug, { week, poolTimeBudgetMs: 150_000 }, defaultYahooMarketIO); const n0 = mark(); const c = await loadYahooMarketSnapshot(slug, { week }, defaultYahooMarketIO); const repeat = mark() - n0;
      const k = acq.filter((p) => p.position === "K"), d = acq.filter((p) => p.position === "DEF");
      return json({ step, slug, week, duration_ms: spent, binding: b, requests: reqs, readiness: snap.readiness.axes ?? snap.readiness, sources: snap.sources, counts: snap.counts, pool_evidence: ev, reconciliation: snap.ownership_reconciliation, rules: { system: r.system, provider_raw: r.provider_raw, waiver_clear_days: r.waiver_clear_days, add_limits: r.add_limits, startable: r.startable_positions }, teams: snap.acquisition.teams.map((t) => ({ faab: t.faab_remaining, priority: t.waiver_priority, owned_by_connection: (t as any).owned_by_connection })), // eslint-disable-line @typescript-eslint/no-explicit-any
        pending_claim_visibility: snap.pending_claim_visibility, game_lock_semantics: snap.game_lock_semantics, locks: { OPEN: acq.filter((p) => p.lock === "OPEN").length, LOCKED: acq.filter((p) => p.lock === "LOCKED").length, UNKNOWN: acq.filter((p) => p.lock === "UNKNOWN").length },
        K: { n: k.length, free: k.filter((p) => p.status === "AVAILABLE_FREE_AGENT").length, waivers: k.filter((p) => p.status === "ON_WAIVERS").length, resolved: k.filter((p) => p.canonical_player_id).length }, DEF: { n: d.length, resolved_defense_ids: d.filter((p) => p.canonical_player_id?.startsWith("defense:nfl:")).length },
        unknown: { count: pool.unknown.length, any_addable: pool.unknown.some((p) => p.eligible_to_add) }, identity: { acquirable: acq.length, resolved: acq.filter((p) => p.canonical_player_id).length, rostered: snap.counts.ROSTERED, rostered_resolved: snap.players.filter((p) => p.status === "ROSTERED" && p.canonical_player_id).length },
        freshness: a.freshness, repeat_call_extra_requests: repeat, repeat_same_request_id: c.identities.request_id === a.identities.request_id, market_content_id: snap.identities.market_content_id });
    }
    if (step === "waivers") {
      const manager = q.get("manager") ?? ""; const week = q.get("week") ?? "";
      const mod = await import("@/app/api/waivers/[league]/[manager]/week/[week]/route"); const n = mark();
      const res = await mod.GET(new Request(`https://preview.invalid/api/waivers/${slug}/${manager}/week/${week}`), { params: Promise.resolve({ league: slug, manager, week }) } as never);
      const body = await res.json() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      return json({ step, status: res.status, availability_status: body.availability_status ?? null, keys: Object.keys(body).slice(0, 25), recommendations: (body.recommendations ?? []).length, methods: [...new Set((body.recommendations ?? []).map((x: any) => x.acquisition?.method))], market_pool: body.market_pool ?? body.context?.market_pool ?? null, replacement: body.replacement ?? null, enforcement: since(n) }); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    return json({ error: "unknown step" }, 400);
  } catch (e) { return json({ error: "cert step failed", message: (e instanceof Error ? e.message : "error").replace(/[A-Za-z0-9._~+/=-]{32,}/g, "[redacted]").slice(0, 300) }, 500); }
}
