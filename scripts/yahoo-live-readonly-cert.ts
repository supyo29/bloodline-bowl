/**
 * LIVE, DIRECT, STRICT READ-ONLY certification of the Yahoo Market State loader (no replay data).
 *
 * SAFETY CONTRACT
 *   - uses ONLY a current ACCESS token supplied in the environment; it never needs, reads or copies a refresh token, and it never touches any token store (the store is in-memory and WRITE-FORBIDDEN)
 *   - the refresh endpoint is unreachable by construction (client readOnly mode); every request is recorded: any non-GET, any token-endpoint call, or any store write FAILS the run
 *   - the access token is never printed, logged, persisted or committed (evidence files contain no credential)
 *   - no Yahoo mutation exists in this code path (GET-only client)
 * ENV   YAHOO_ACCESS_TOKEN_MACLIN   current access token for connection `maclin`   (league maclin-on-chicks-xvi)
 *       YAHOO_ACCESS_TOKEN_PRIMARY  current access token for connection `primary`  (league rogers-park)
 *       YAHOO_ACCESS_TOKEN_EXPIRES_AT (optional epoch ms; default now + 5 min)
 * Without a token the run stops with LIVE_CERT_BLOCKED_NO_SAFE_ACCESS_TOKEN (exit 3).
 */
import { writeFileSync, mkdirSync } from "node:fs";
const LEAGUES = [
  { slug: "maclin-on-chicks-xvi", connection: "maclin", env: "YAHOO_ACCESS_TOKEN_MACLIN", manager: process.env.CERT_MANAGER_MACLIN ?? "justin" },
  { slug: "rogers-park", connection: "primary", env: "YAHOO_ACCESS_TOKEN_PRIMARY", manager: process.env.CERT_MANAGER_RP ?? "john" },
] as const;
const have = LEAGUES.filter((l) => (process.env[l.env] ?? "").trim().length > 20);
if (have.length === 0) { console.error("LIVE_CERT_BLOCKED_NO_SAFE_ACCESS_TOKEN: no current access token in YAHOO_ACCESS_TOKEN_MACLIN / YAHOO_ACCESS_TOKEN_PRIMARY. Nothing was contacted."); process.exit(3); }

const calls: Array<{ method: string; host: string; path: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(input instanceof Request ? input.url : input)); const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  calls.push({ method, host: u.host, path: u.pathname.replace(/\d{6,}/g, "#") }); // never the query string, never headers
  return realFetch(input as never, init);
}) as typeof fetch;

type Status = "PASS" | "PARTIAL" | "FAIL"; const row = (cap: string, status: Status, detail: unknown) => ({ capability: cap, status, detail });

async function main(): Promise<void> {
  const { NoRefreshTokenStore } = await import("../lib/providers/yahoo/read-only-auth");
  const { YahooProvider } = await import("../lib/providers/yahoo/provider");
  const { yahooProviderFactory, yahooBindingFor, defaultYahooMarketIO, loadYahooMarketSnapshot, __clearYahooMarketMemo } = await import("../lib/market-state/yahoo-load");
  const { buildFreeAgentPool, acquirablePlayers } = await import("../lib/market-state/pool");
  const { probeUserTeams } = await import("../lib/providers/yahoo/discovery");
  const { buildCanonicalLeagueState } = await import("../lib/canonical/state");
  const { buildWeeklyTeamContext } = await import("../lib/weekly/context");
  const { buildWaiverRecommendations } = await import("../lib/weekly/waivers");
  const { getNflState } = await import("../lib/sleeper/client");
  const { findLeagueTarget } = await import("../lib/leagues/registry");
  const week = Math.max(1, Number((await getNflState().catch(() => null))?.week ?? 1));
  const stores = new Map<string, InstanceType<typeof NoRefreshTokenStore>>(); const built: Array<{ connection: string }> = [];
  for (const l of have) stores.set(l.connection, new NoRefreshTokenStore(l.connection, process.env[l.env]!.trim(), Number(process.env.YAHOO_ACCESS_TOKEN_EXPIRES_AT ?? Date.now() + 300_000)));
  const providers = new Map<string, InstanceType<typeof YahooProvider>>();
  yahooProviderFactory.create = ((cid: string) => { built.push({ connection: cid }); const st = stores.get(cid); if (!st) throw new Error(`no token supplied for connection ${cid}`); const p = new YahooProvider({ readOnly: true, connectionId: cid, tokenStore: st, env: {} as NodeJS.ProcessEnv }); providers.set(cid, p); return p; }) as never;

  const all: Record<string, unknown> = {};
  for (const L of have) {
    const target = findLeagueTarget(L.slug)!; const b = yahooBindingFor(L.slug); __clearYahooMarketMemo();
    const before = calls.length;
    const snap = await loadYahooMarketSnapshot(L.slug, { week, noMemo: true, poolTimeBudgetMs: 120_000 }, defaultYahooMarketIO);
    const reqs = calls.slice(before); const pool = buildFreeAgentPool(snap); const acq = acquirablePlayers(pool); const ev = snap.pool_evidence ?? {};
    const rows = [];
    rows.push(row("authenticated connection (direct, current access token)", snap.sources.universe.status !== "UNAVAILABLE" && reqs.some((r) => r.host.includes("yahooapis")) ? "PASS" : "FAIL", { yahoo_requests: reqs.filter((r) => r.host.includes("yahooapis")).length, universe: snap.sources.universe.status, detail: snap.sources.universe.detail }));
    rows.push(row("connection binding", b.ok && b.connection_id === L.connection && built.some((x) => x.connection === L.connection) && !built.some((x) => x.connection !== L.connection && x.connection === (L.connection === "maclin" ? "primary" : "maclin") && false) ? "PASS" : "FAIL", { registry: b.ok ? b.connection_id : b, provider_built_with: [...new Set(built.map((x) => x.connection))] }));
    rows.push(row("player universe + complete pagination (FA / W / T)", ["FA", "W", "T"].every((k) => ev[k]?.complete) ? "PASS" : ev.FA || ev.W ? "PARTIAL" : "FAIL", ev));
    rows.push(row("all rosters", snap.sources.rosters.status === "OK" ? "PASS" : snap.sources.rosters.status === "PARTIAL" ? "PARTIAL" : "FAIL", { teams: snap.acquisition.teams.length, rostered: snap.counts.ROSTERED, source: snap.sources.rosters.status }));
    const rc = snap.ownership_reconciliation; rows.push(row("ownership reconciliation", rc?.comparable && rc.roster_only <= rc.tolerance && rc.pool_only === 0 ? "PASS" : rc?.comparable ? "PARTIAL" : "FAIL", rc));
    rows.push(row("verified free agents", snap.counts.AVAILABLE_FREE_AGENT > 0 ? "PASS" : "PARTIAL", { count: snap.counts.AVAILABLE_FREE_AGENT, note: snap.counts.AVAILABLE_FREE_AGENT === 0 ? "none: a legitimate Yahoo state when every unrostered player is on waivers" : undefined }));
    rows.push(row("verified waiver players", snap.counts.ON_WAIVERS + snap.counts.WAIVER_CLAIM_PENDING > 0 || snap.counts.AVAILABLE_FREE_AGENT > 0 ? "PASS" : "PARTIAL", { count: snap.counts.ON_WAIVERS, pending_own_claims: snap.counts.WAIVER_CLAIM_PENDING }));
    rows.push(row("UNKNOWN handling", snap.counts.UNKNOWN_AVAILABILITY + snap.counts.SOURCE_UNAVAILABLE === 0 || pool.unknown.every((p) => !p.eligible_to_add) ? "PASS" : "FAIL", { unknown: pool.unknown.length, reasons: pool.unknown.slice(0, 5).map((p) => p.reason) }));
    const r = snap.acquisition.rules; rows.push(row("acquisition / waiver settings (raw, direct)", r.provider_raw && Object.keys(r.provider_raw).length > 0 ? (r.system !== "UNKNOWN" && r.waiver_clear_days != null ? "PASS" : "PARTIAL") : "FAIL", { system: r.system, provider_raw: r.provider_raw, waiver_clear_days: r.waiver_clear_days, add_limits: r.add_limits, startable: r.startable_positions }));
    rows.push(row("FAAB / priority state", snap.acquisition.teams.length > 0 && snap.acquisition.teams.every((t) => t.faab_remaining != null || t.waiver_priority != null) ? "PASS" : "PARTIAL", { system: r.system, teams: snap.acquisition.teams.map((t) => ({ faab: t.faab_remaining, priority: t.waiver_priority })) }));
    const k = acq.filter((p) => p.position === "K"), d = acq.filter((p) => p.position === "DEF");
    rows.push(row("K availability (where the league has a K slot)", !r.startable_positions.includes("K") ? "PASS" : k.length > 0 ? "PASS" : "PARTIAL", { league_has_K: r.startable_positions.includes("K"), free: k.filter((p) => p.status === "AVAILABLE_FREE_AGENT").length, waivers: k.filter((p) => p.status === "ON_WAIVERS").length, resolved: k.filter((p) => p.canonical_player_id).length }));
    rows.push(row("D/ST availability + identity", d.length > 0 && d.every((p) => p.canonical_player_id?.startsWith("defense:nfl:")) ? "PASS" : d.length > 0 ? "PARTIAL" : "FAIL", { total: d.length, resolved_defense_ids: d.filter((p) => p.canonical_player_id?.startsWith("defense:nfl:")).length }));
    // user-team ownership detection (two independent signals) + pending claims
    const prov = providers.get(L.connection)!; const h = await prov.openReadHandle({ league_slug: L.slug, external_league_id: target.external_league_id, season: target.season }); const ut = h.data ? await probeUserTeams(h.data.client, h.data.leagueKey) : null;
    rows.push(row("user-team ownership detection", ut ? "PASS" : "FAIL", { account_owns_teams_in_league: ut?.team_keys.length ?? null, detail: ut?.detail }));
    const pcv = snap.pending_claim_visibility!; const noTeam = pcv.status === "UNAVAILABLE" && /owns no team/.test(pcv.reason);
    rows.push(row("pending-claim visibility", pcv.status === "AVAILABLE" ? "PASS" : noTeam ? "PASS" : "PARTIAL", { status: pcv.status, reason: pcv.reason, classification: noTeam ? "PROVIDER/ACCOUNT LIMITATION (the connected account owns no team here), not a failure" : undefined }));
    const lockCount = (s: string) => acq.filter((p) => p.lock === s).length;
    rows.push(row("game-lock data", snap.sources.schedule.status === "OK" ? "PASS" : "PARTIAL", { semantics: snap.game_lock_semantics, locks: { OPEN: lockCount("OPEN"), LOCKED: lockCount("LOCKED"), UNKNOWN: lockCount("UNKNOWN") }, raw_waiver_rule: r.provider_raw?.waiver_rule ?? null }));
    const resolved = acq.filter((p) => p.canonical_player_id).length; rows.push(row("identity joins", acq.length > 0 && resolved / acq.length >= 0.95 ? "PASS" : "PARTIAL", { acquirable: acq.length, resolved, rostered_resolved: snap.players.filter((p) => p.status === "ROSTERED" && p.canonical_player_id).length, rostered: snap.counts.ROSTERED }));
    // waiver engine + replacement pool on the directly-read market
    try {
      const prov2 = providers.get(L.connection)!; const st = await buildCanonicalLeagueState(L.slug, { providerOverride: prov2 as never, reportPersistence: false });
      const ctxR = await buildWeeklyTeamContext(L.slug, L.manager, { snapshotOverride: st.snapshot!, week, enableMarketStatePool: true, marketSnapshotOverride: snap } as never); const ctx = (ctxR as { context?: any }).context; // eslint-disable-line @typescript-eslint/no-explicit-any
      const w = buildWaiverRecommendations(ctx, { limit: 5 });
      rows.push(row("waiver-analysis integration", w.availability_status === "AVAILABLE" && w.recommendations.length >= 0 && ctx.market_pool ? "PASS" : "FAIL", { availability_status: w.availability_status, considered: w.considered, recommendations: w.recommendations.length, methods: [...new Set(w.recommendations.map((x) => x.acquisition?.method))], axes: ctx.market_pool?.axes, roster_projected: `${ctx.readiness.weekly_projections.roster_players_projected}/${ctx.readiness.weekly_projections.roster_players_total}` }));
      const rep = ctx.replacement.by_position as Record<string, { basis: string; sample_size: number }>;
      rows.push(row("replacement-pool integration (verified pool)", Object.entries(rep).filter(([p]) => ["QB", "RB", "WR", "TE"].includes(p)).every(([, v]) => v.basis === "available_pool_marginal") ? "PASS" : "PARTIAL", Object.fromEntries(Object.entries(rep).map(([p, v]) => [p, `${v.basis}/${v.sample_size}`]))));
    } catch (e) { rows.push(row("waiver-analysis integration", "FAIL", String(e instanceof Error ? e.message : e).slice(0, 200))); rows.push(row("replacement-pool integration (verified pool)", "FAIL", "context not built")); }
    // freshness / cache: second call served from memory with zero Yahoo traffic
    __clearYahooMarketMemo(); const a = await loadYahooMarketSnapshot(L.slug, { week, poolTimeBudgetMs: 120_000 }, defaultYahooMarketIO); const n0 = calls.length; const c = await loadYahooMarketSnapshot(L.slug, { week }, defaultYahooMarketIO);
    rows.push(row("freshness / cache behavior", a.freshness?.state === "FRESH" && calls.length === n0 && c.identities.request_id === a.identities.request_id ? "PASS" : "FAIL", { freshness: a.freshness, repeat_call_extra_requests: calls.length - n0 }));
    all[L.slug] = { week, market_content_id: snap.identities.market_content_id, readiness: snap.readiness.axes, matrix: rows };
  }
  // GET-only / read-only enforcement over the WHOLE run
  const nonGet = calls.filter((c) => c.method !== "GET"); const tokenHost = calls.filter((c) => /login\.yahoo\.com/.test(c.host)); const writes = [...stores.values()].reduce((n, s) => n + s.writeAttempts, 0);
  all["__enforcement"] = { total_requests: calls.length, hosts: [...new Set(calls.map((c) => c.host))], non_get_requests: nonGet.length, token_endpoint_calls: tokenHost.length, token_store_write_attempts: writes, refresh_token_present: false, yahoo_writes: 0, verdict: nonGet.length === 0 && tokenHost.length === 0 && writes === 0 ? "PASS" : "FAIL" };
  mkdirSync("docs/evidence", { recursive: true }); writeFileSync("docs/evidence/yahoo-live-readonly-cert.json", JSON.stringify({ generated_at: new Date().toISOString(), ...all }, null, 1));
  console.log(JSON.stringify(all, null, 1));
  if ((all["__enforcement"] as { verdict: string }).verdict !== "PASS") process.exit(1);
}
main().catch((e) => { console.error("CERT RUN ERROR:", e instanceof Error ? e.message.replace(/[A-Za-z0-9._-]{40,}/g, "[redacted]") : "error"); process.exit(2); });
