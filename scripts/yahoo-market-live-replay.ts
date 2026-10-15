/**
 * LIVE-DATA REPLAY CERTIFICATION for Yahoo Market State (READ-ONLY; no Yahoo credentials, no production writes, no Yahoo mutation).
 *
 * Real Yahoo data reaches this script ONLY through the deployed bridge's PUBLIC GET endpoints (which themselves read Yahoo with their own stored token):
 *   /api/league/{slug}/state                       canonical league state (teams, rosters, standings, FAAB / priority)
 *   /api/yahoo/leagues/{slug}/players/available    Yahoo's league player pools FA / W / T (paginated with all=true)
 *   /api/yahoo/leagues/{slug}/players/available?player_id=…   independent per-player lookup (the cross-check)
 * That data is fed through THIS BRANCH's new loader + builder (`loadYahooMarketSnapshot`) and weekly engine. What this proves: the classification, pagination
 * accounting, ownership reconciliation, identity bridge and waiver ranking on REAL Yahoo data. What it does NOT prove: the new direct-from-Yahoo reads of league
 * settings / user teams / pending claims (they need the account's own OAuth token) — those are reported as not live-verified.
 *
 * usage: node --import tsx scripts/yahoo-market-live-replay.ts <league-slug> [manager-slug] [--out docs/evidence/file.json]
 */
import { writeFileSync } from "node:fs";
import { loadYahooMarketSnapshot, defaultYahooMarketIO, __clearYahooMarketMemo, type YahooMarketIO, type YahooLeagueHandle } from "../lib/market-state/yahoo-load";
import { buildFreeAgentPool, acquirablePlayers } from "../lib/market-state/pool";
import { validateMarketSnapshot } from "../lib/market-state/integrity";
import { fetchNflSchedule } from "../lib/market-state/schedule";
import type { PoolResult, YahooPoolPlayer } from "../lib/providers/yahoo/players";
import type { MarketSnapshot } from "../lib/market-state/contract";

const BASE = process.env.BRIDGE_BASE ?? "https://bloodline-bowl-sleeper-bridge.vercel.app";
const slug = process.argv[2] as string; const manager = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;
const outArg = process.argv.indexOf("--out"); const out = outArg > 0 ? process.argv[outArg + 1]! : null;
if (!process.argv[2]) { console.error("usage: yahoo-market-live-replay.ts <league-slug> [manager-slug] [--out file]"); process.exit(2); }

const get = async <T = any>(path: string): Promise<T> => { const r = await fetch(`${BASE}${path}`, { method: "GET", headers: { accept: "application/json" } }); if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`); return (await r.json()) as T; };

async function main(): Promise<void> {
  const state = (await get<any>(`/api/league/${slug}/state`)).state;
  const players = new Map<string, any>(state.players.map((p: any) => [p.canonical_player_id, p]));
  const teams: any[] = state.teams;
  const leagueKey: string = (teams[0].provider_team_id as string).replace(/\.t\.\d+$/, "");
  const poolCache = new Map<string, PoolResult>();
  const poolFor = async (code: "FA" | "W" | "T"): Promise<PoolResult> => {
    const st = code === "T" ? "rostered" : code;
    const body = await get<any>(`/api/yahoo/leagues/${slug}/players/available?status=${st}&all=true&count=500`);
    const info = body.pagination?.pools?.[code] ?? {};
    const rows: YahooPoolPlayer[] = body.players;
    const r: PoolResult = { status: code, players: rows, pages_fetched: info.pages_fetched ?? 0, requests: body.yahoo_requests ?? [], complete: info.complete === true, next_start: info.next_start ?? null, stopped_reason: info.stopped_reason ?? "end_of_pool", ownership: "requested", dropped_rostered: info.dropped_rostered_rows ?? 0, duplicates_dropped: info.duplicate_rows_dropped ?? 0 };
    poolCache.set(code, r); return r;
  };
  const io: YahooMarketIO = {
    ...defaultYahooMarketIO,
    async open() { return { ok: true, handle: { client: null as never, leagueKey, gameKey: leagueKey.split(".")[0]!, connectionId: "replay" } as YahooLeagueHandle }; },
    async settings() {
      const rs = state.league.roster_settings; const ws = state.league.waiver_settings;
      const count = (a: string[]) => { const m = new Map<string, number>(); for (const x of a) m.set(x, (m.get(x) ?? 0) + 1); return [...m].map(([position, count]) => ({ position, count })); };
      return { roster_positions: [...count(rs.starting_slots), { position: "BN", count: rs.bench_slots }, { position: "IR", count: rs.ir_slots }], stat_categories: [], stat_modifiers: [], playoff_start_week: null, num_playoff_teams: null, waiver_type: null, uses_faab: ws.type === "faab", acquisition_raw: { canonical_waiver_type: ws.type }, waiver_rule: null, waiver_time_days: null, max_adds_season: null, max_adds_weekly: null, uses_faab_stated: ws.type === "faab" ? true : null } as never;
    },
    async teams() { return teams.map((t) => ({ team_key: t.provider_team_id, team_id: String(t.provider_team_id).split(".t.")[1]!, faab_balance: t.faab_remaining ?? null, waiver_priority: t.waiver_priority ?? null, owned_by_connection: false })); },
    async roster(_h, teamKey) {
      const ro = state.rosters.find((r: any) => teams.find((t) => t.provider_team_id === teamKey)?.canonical_team_id === r.canonical_team_id);
      const slots: Array<{ player_key: string; selected_position: string }> = []; const flat: any[] = [];
      for (const s of ro?.slots ?? []) { if (s.is_empty || !s.canonical_player_id) continue; const p = players.get(s.canonical_player_id); const key = p?.identifiers?.yahoo_player_key; if (!key) continue; slots.push({ player_key: key, selected_position: s.slot }); flat.push({ player_key: key, player_id: p.identifiers.yahoo_id, full_name: p.full_name, editorial_team_abbr: p.nfl_team, display_position: p.position, eligible_positions: p.eligible_positions, status: p.injury_status ?? null }); }
      return { slots, players: flat } as never;
    },
    pool: (_h, code) => poolFor(code),
    async transactionHead() { return JSON.stringify((state.recent_transactions ?? []).slice(0, 5).map((t: any) => t.canonical_transaction_id ?? t)).length.toString(); },
    async userTeams() { return { ok: false, team_keys: [], detail: "replay: the connected account's teams are not readable without its token" }; },
    async pending() { return { visibility: "UNAVAILABLE", reason: "replay: pending claims need the connected account's own token and an owned team", claims: [] }; },
    schedule: fetchNflSchedule,
  };

  __clearYahooMarketMemo();
  const week = state.week as number;
  const t0 = Date.now();
  const snap: MarketSnapshot = await loadYahooMarketSnapshot(slug, { week, noMemo: true, poolTimeBudgetMs: 120_000 }, io);
  const pool = buildFreeAgentPool(snap);
  const viol = validateMarketSnapshot(snap);

  /* ---- internal consistency ---- */
  const keys = snap.players.map((p) => p.provider_player_id); const dupKeys = keys.length - new Set(keys).size;
  const rosteredIds = new Set(snap.players.filter((p) => p.status === "ROSTERED").map((p) => p.provider_player_id));
  const availableAndRostered = snap.players.filter((p) => (p.status === "AVAILABLE_FREE_AGENT" || p.status === "ON_WAIVERS") && rosteredIds.has(p.provider_player_id)).length;
  const stateRostered = new Set(state.players.map((p: any) => p.identifiers?.yahoo_player_key).filter(Boolean));
  const rosteredVsState = { market_rostered: rosteredIds.size, canonical_state_rostered: stateRostered.size, market_not_in_state: [...rosteredIds].filter((k) => !stateRostered.has(k)).length, state_not_in_market: [...stateRostered].filter((k) => !rosteredIds.has(k as string)).length };
  const acq = acquirablePlayers(pool);
  const byPos = (xs: typeof acq) => xs.reduce<Record<string, number>>((m, p) => { const k = p.position ?? "?"; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const identity = { acquirable: acq.length, resolved: acq.filter((p) => p.canonical_player_id).length, defenses: acq.filter((p) => p.entity === "TEAM_DEFENSE").length, defenses_resolved: acq.filter((p) => p.entity === "TEAM_DEFENSE" && p.canonical_player_id?.startsWith("defense:nfl:")).length, unresolved_samples: acq.filter((p) => !p.canonical_player_id).slice(0, 8).map((p) => `${p.full_name} ${p.position} ${p.team}`) };
  const rosteredResolved = snap.players.filter((p) => p.status === "ROSTERED" && p.canonical_player_id).length;

  /* ---- independent cross-check against Yahoo itself (a different request path: per-player lookup) ---- */
  const rnd = (a: number) => { let s = a; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }; const r = rnd(20261014);
  const sample = (xs: typeof acq, n: number) => [...xs].sort(() => r() - 0.5).slice(0, n);
  const kdef = acq.filter((p) => p.position === "K" || p.position === "DEF");
  const toCheck = [...sample(snap.players.filter((p) => p.status === "AVAILABLE_FREE_AGENT"), 20), ...sample(snap.players.filter((p) => p.status === "ON_WAIVERS" || p.status === "WAIVER_CLAIM_PENDING"), 20), ...sample(snap.players.filter((p) => p.status === "ROSTERED"), 15), ...sample(kdef, 8)];
  const want = (p: { status: string }) => (p.status === "AVAILABLE_FREE_AGENT" ? "FA" : p.status === "ON_WAIVERS" || p.status === "WAIVER_CLAIM_PENDING" ? "W" : "T");
  const mismatches: unknown[] = []; let checked = 0;
  for (let i = 0; i < toCheck.length; i += 10) {
    const batch = toCheck.slice(i, i + 10); const ids = batch.map((p) => p.provider_player_id.split(".p.")[1]).join(",");
    const body = await get<any>(`/api/yahoo/leagues/${slug}/players/available?player_id=${ids}`);
    const byId = new Map<string, any>((body.players ?? []).map((p: any) => [p.player_id, p]));
    for (const p of batch) { const y = byId.get(p.provider_player_id.split(".p.")[1]!); checked += 1; if (!y) { mismatches.push({ player: p.full_name, expected: want(p), yahoo: "NOT_RETURNED" }); continue; } if (y.status !== want(p)) mismatches.push({ player: p.full_name, expected: want(p), yahoo: y.status }); }
  }

  const report: Record<string, unknown> = {
    league: slug, week, league_key: leagueKey, read_through: "deployed bridge public GET endpoints (Yahoo-sourced); NOT the new direct Yahoo reads", elapsed_ms: Date.now() - t0,
    readiness: { status: snap.readiness.status, pool_actionable: snap.readiness.pool_actionable, axes: snap.readiness.axes, blocks: snap.readiness.blocks, limitations: snap.readiness.limitations },
    counts: snap.counts, ineligible_counts: snap.ineligible_counts, claimable: pool.claimable.length,
    pool_evidence: snap.pool_evidence, freshness: snap.freshness, ownership_reconciliation: snap.ownership_reconciliation,
    integrity_violations: viol.length, duplicate_player_keys: dupKeys, available_and_rostered: availableAndRostered, rostered_vs_canonical_state: rosteredVsState,
    acquirable_by_position: byPos(acq), free_agents_by_position: byPos(pool.members), waivers_by_position: byPos(pool.claimable),
    k_def: { free_agents: pool.members.filter((p) => p.position === "K" || p.position === "DEF").map((p) => `${p.position} ${p.full_name} ${p.canonical_player_id ?? "UNRESOLVED"}`), waivers: pool.claimable.filter((p) => p.position === "K" || p.position === "DEF").map((p) => `${p.position} ${p.full_name} ${p.canonical_player_id ?? "UNRESOLVED"} clears ${p.waiver_clears_on}`).slice(0, 12) },
    identity: { ...identity, rostered: snap.counts.ROSTERED, rostered_resolved_to_sleeper_or_gsis: rosteredResolved },
    acquisition: { system: snap.acquisition.rules.system, status: snap.acquisition.status, team_context: snap.acquisition.teams.slice(0, 3) },
    pending_claim_visibility: snap.pending_claim_visibility, cross_check_vs_yahoo: { checked, mismatches: mismatches.length, mismatch_detail: mismatches.slice(0, 10) },
  };
  console.log(JSON.stringify(report, null, 1));

  /* ---- the real waiver engine on this live market (needs the weekly context) ---- */
  if (manager) {
    const { buildWeeklyTeamContext } = await import("../lib/weekly/context");
    const { buildWaiverRecommendations } = await import("../lib/weekly/waivers");
    const { loadYahooSleeperBridge } = await import("../lib/canonical/yahoo-bridge-source");
    const { PlayerCrosswalk, NoCrosswalk } = await import("../lib/canonical/players");
    // re-resolve the deployed snapshot's Yahoo identities with the bridge (what the new state build produces), then run the REAL context + waiver engine
    const cw = new PlayerCrosswalk(NoCrosswalk).useYahooSleeperBridge(await loadYahooSleeperBridge()); await cw.ensureLoaded();
    const remap = new Map<string, string>(); let bridged = 0;
    for (const p of state.players) {
      if (p.is_team_defense) continue;
      const res = cw.resolve({ provider: "yahoo", provider_player_id: p.identifiers.yahoo_player_key, full_name: p.full_name, position: p.position, nfl_team: p.nfl_team, eligible_positions: p.eligible_positions, status: p.status, known_identifiers: { yahoo_id: p.identifiers.yahoo_id, yahoo_player_key: p.identifiers.yahoo_player_key } });
      if (res.player.canonical_player_id !== p.canonical_player_id) { remap.set(p.canonical_player_id, res.player.canonical_player_id); bridged += 1; }
    }
    let text = JSON.stringify(state); for (const [a, b] of remap) text = text.split(JSON.stringify(a)).join(JSON.stringify(b));
    const snapshotOverride = JSON.parse(text);
    const ctxRes = await buildWeeklyTeamContext(slug, manager, { snapshotOverride, week, enableMarketStatePool: true, marketSnapshotOverride: snap } as never);
    const ctx = (ctxRes as { context?: any }).context;
    if (!ctx) { console.log(JSON.stringify({ manager, context_error: (ctxRes as any).error ?? (ctxRes as any).detail ?? "no context", keys: Object.keys(ctxRes as object) })); return; }
    const w = buildWaiverRecommendations(ctx, { limit: 8 });
    const nm = (id: string | null) => (id ? ctx.availability.players.find((p: any) => p.canonical_player_id === id)?.player.full_name ?? ctx.all_rostered.find((p: any) => p.canonical_player_id === id)?.full_name ?? id : null);
    const wr = {
      manager, bridged_roster_identities: bridged, roster_players_projected: ctx.readiness.weekly_projections.roster_players_projected, roster_players_total: ctx.readiness.weekly_projections.roster_players_total,
      availability_status: w.availability_status, readiness: { market: ctx.readiness.market.status, market_axes: ctx.readiness.market.axes, weekly_projections: ctx.readiness.weekly_projections.status, waiver_recommendations: ctx.readiness.waiver_recommendations },
      market_pool: ctx.market_pool ? { ...ctx.market_pool, by_position: ctx.market_pool.by_position } : null, considered: w.considered, waiver_model: w.waiver_model, faab: w.faab, waiver_priority: w.waiver_priority,
      replacement: Object.fromEntries(Object.entries(ctx.replacement.by_position as Record<string, any>).map(([k, v]) => [k, { pts: v.replacement_points, basis: v.basis, n: v.sample_size }])),
      top_recommendations: w.recommendations.slice(0, 8).map((x) => ({ add: x.add_name, pos: x.position, method: x.acquisition?.method, clears_on: x.acquisition?.waiver_clears_on, weekly: x.weekly_projection, vor: x.weekly_vor, drop: x.drop_name ?? (x.drop_player_id ? nm(x.drop_player_id) : null), net: x.net_roster_gain, priority: x.priority })),
      do_not_add: w.do_not_add.slice(0, 4).map((x) => `${x.add_name}: ${x.reason}`), warnings: w.warnings.map((x) => `${x.code}`),
    };
    console.log("WAIVER_ANALYSIS " + JSON.stringify(wr, null, 1));
    (report as any).waiver_analysis = wr;
  }
  if (out) writeFileSync(out, JSON.stringify(report, null, 1));
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(2); });
