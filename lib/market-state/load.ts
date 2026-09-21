/**
 * Phase 4.5 — the I/O edge of the market-state substrate. Reads league rules, rosters, the player universe, the transaction
 * window and the NFL schedule ONCE, hands them to the pure builder, and memoizes the result briefly ("build once, consume many").
 *
 * REFRESH STRATEGY (hybrid, see the Phase 4.5 doc §17): request-scoped build over
 *   rosters / rules / transactions / schedule fetched `no-store`, the 12k-player universe served from the provider's 24h in-process
 *   cache (its age is reported and bounded by a 26h staleness ceiling), and a 30s in-process memo so the evidence route, Waiver 2.0
 *   and the capture hook share ONE read instead of hammering Sleeper. Nothing is persisted here.
 * Every failure degrades a SOURCE to UNAVAILABLE with a PROVIDER_ERROR detail; nothing throws to the caller.
 */
import { randomUUID } from "node:crypto";
import { SLEEPER_ROOT_URL, fetchSleeper, getLeague, getLeagueRostersFresh, getLeagueTransactions, getPlayerCacheStatus, getPlayerIndex } from "@/lib/sleeper/client";
import { scoringFingerprint } from "@/lib/canonical/scoring-fingerprint";
import { findLeagueTarget } from "@/lib/leagues/registry";
import type { RawRoster, RawTransaction } from "@/lib/sleeper/types";
import type { SourceReport } from "./contract";
import { buildMarketSnapshot, type MarketBuildInput, type RosterInput, type ScheduleGameInput, type TransactionInput } from "./build";
import type { UniversePlayer } from "./classify";
import type { MarketSnapshot } from "./contract";

export const MARKET_MEMO_TTL_MS = 30_000;
/** Hard ceiling on any single provider read: a hung provider degrades that SOURCE to UNAVAILABLE (PROVIDER_ERROR) instead of hanging the request. */
export const MARKET_READ_TIMEOUT_MS = 10_000;
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => new Promise<T>((res, rej) => { const t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
const ids = (a: unknown): string[] => (Array.isArray(a) ? a.filter((x) => x != null && x !== "").map((x) => String(x)) : []);
const DAY_MS = 86_400_000;
const ok = (klass: SourceReport["source_class"], at: string, detail: string | null = null): SourceReport => ({ status: "OK", source_class: klass, fetched_at: at, detail });
const down = (e: unknown): SourceReport => ({ status: "UNAVAILABLE", source_class: "UNAVAILABLE", fetched_at: null, detail: `PROVIDER_ERROR: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
const unsupported = (why: string): SourceReport => ({ status: "UNAVAILABLE", source_class: "UNAVAILABLE", fetched_at: null, detail: why });

export interface LoadMarketOptions { week: number; scoring_fingerprint?: string | null; source_snapshot_id?: string | null; canonical_id?: (id: string) => string | null; now?: () => Date; noMemo?: boolean; timeoutMs?: number }
export interface MarketFetchers {
  league: typeof getLeague; rosters: typeof getLeagueRostersFresh; transactions: typeof getLeagueTransactions; players: typeof getPlayerIndex; playerAge: () => number | null;
  schedule: (season: number) => Promise<ScheduleGameInput[]>;
}
const defaultFetchers: MarketFetchers = {
  league: getLeague, rosters: getLeagueRostersFresh, transactions: getLeagueTransactions, players: getPlayerIndex, playerAge: () => getPlayerCacheStatus().age_seconds,
  schedule: async (season) => { const g = await fetchSleeper<ScheduleGameInput[]>(`/schedule/nfl/regular/${season}`, { baseUrl: SLEEPER_ROOT_URL, noStore: true, timeoutMs: 2000 }); if (!Array.isArray(g)) throw new Error("schedule shape"); return g; },
};

const memo = new Map<string, { at: number; p: Promise<MarketSnapshot> }>();
export const __clearMarketMemo = (): void => memo.clear();

export function loadMarketSnapshot(leagueSlug: string, opts: LoadMarketOptions, fetchers: MarketFetchers = defaultFetchers): Promise<MarketSnapshot> {
  const nowMs = (opts.now ?? (() => new Date()))().getTime(); const key = `${leagueSlug}:${opts.week}`;
  const hit = memo.get(key);
  if (!opts.noMemo && hit && nowMs - hit.at < MARKET_MEMO_TTL_MS) return hit.p;
  const p = readAndBuild(leagueSlug, opts, fetchers);
  if (!opts.noMemo) memo.set(key, { at: nowMs, p });
  return p;
}

async function readAndBuild(leagueSlug: string, opts: LoadMarketOptions, f: MarketFetchers): Promise<MarketSnapshot> {
  const now = opts.now ?? (() => new Date()); const asOf = now().toISOString();
  const target = findLeagueTarget(leagueSlug);
  const base = { league_slug: leagueSlug, week: opts.week, as_of: asOf, request_id: `req:${randomUUID()}`, source_snapshot_id: opts.source_snapshot_id ?? null, scoring_fingerprint: opts.scoring_fingerprint ?? null, canonical_id: opts.canonical_id };
  if (!target || target.provider !== "sleeper" || !target.external_league_id) {
    const u = unsupported("league is not a registered Sleeper league; no market state can be built");
    return buildMarketSnapshot({ ...base, season: 0, rules: { source: u, settings: null, roster_positions: null }, rosters: { source: u, teams: [] }, universe: { source: u, players: [] }, transactions: { source: u, entries: [] }, schedule: { source: u, games: null } });
  }
  const id = target.external_league_id;
  const T = opts.timeoutMs ?? MARKET_READ_TIMEOUT_MS;
  const [leagueR, rostersR, playersR] = await Promise.allSettled([withTimeout(Promise.resolve(f.league(id, { revalidate: 0 })), T, "league"), withTimeout(Promise.resolve(f.rosters(id, { noStore: true })), T, "rosters"), withTimeout(Promise.resolve(f.players()), T * 2, "player universe")]);
  const league = leagueR.status === "fulfilled" ? leagueR.value : null; const season = league ? Number.parseInt(league.season, 10) : 0;
  const clearDays = league?.settings?.waiver_clear_days ?? null;

  const rules: MarketBuildInput["rules"] = league ? { source: ok("PROVIDER_LIVE", asOf), settings: league.settings ?? {}, roster_positions: league.roster_positions ?? [] } : { source: down(leagueR.status === "rejected" ? leagueR.reason : "league unavailable"), settings: null, roster_positions: null };
  const rosters: MarketBuildInput["rosters"] = rostersR.status === "fulfilled" && Array.isArray(rostersR.value)
    ? { source: ok("PROVIDER_LIVE", asOf), teams: (rostersR.value as RawRoster[]).map((r): RosterInput => ({ team_id: `team:${leagueSlug}:${r.roster_id}`, roster_id: r.roster_id, players: ids(r.players), reserve: ids(r.reserve), taxi: ids(r.taxi), faab_used: typeof r.settings?.waiver_budget_used === "number" ? r.settings.waiver_budget_used : null, waiver_position: typeof r.settings?.waiver_position === "number" ? r.settings.waiver_position : null })) }
    : { source: down(rostersR.status === "rejected" ? rostersR.reason : "rosters payload was not a list"), teams: [] };
  const age = f.playerAge();
  const universe: MarketBuildInput["universe"] = playersR.status === "fulfilled"
    ? { source: ok("PROVIDER_DERIVED", new Date(now().getTime() - (age ?? 0) * 1000).toISOString(), age == null ? "player database age unknown" : null), players: [...playersR.value.values()].map((p): UniversePlayer => ({ player_id: p.player_id, full_name: p.full_name, position: p.position, fantasy_positions: p.fantasy_positions, team: p.team, status: p.status, injury_status: p.injury_status, active: p.active })) }
    : { source: down(playersR.reason), players: [] };

  // Transaction window: every week that can contain a drop still inside the clear window (plus one for the week boundary).
  let transactions: MarketBuildInput["transactions"];
  if (clearDays == null || !league) transactions = { source: unsupported("waiver window unknowable without league rules"), entries: [] };
  else {
    const back = Math.floor(clearDays / 7) + 1; const weeks: number[] = []; for (let w = Math.max(1, opts.week - back); w <= Math.max(1, opts.week); w += 1) weeks.push(w);
    const rs = await Promise.allSettled(weeks.map((w) => withTimeout(Promise.resolve(f.transactions(id, w, { revalidate: 0 })), T, `transactions week ${w}`)));
    const failed = rs.find((r) => r.status === "rejected" || !Array.isArray(r.value)) as PromiseSettledResult<unknown> | undefined;
    transactions = failed ? { source: down(failed.status === "rejected" ? failed.reason : "transactions payload was not a list"), entries: [] } : { source: ok("PROVIDER_LIVE", asOf), entries: (rs as PromiseFulfilledResult<RawTransaction[]>[]).flatMap((r) => (Array.isArray(r.value) ? r.value : [])).map((t): TransactionInput => ({ type: t.type, status: t.status, status_updated: t.status_updated, adds: Object.keys(t.adds ?? {}), drops: Object.keys(t.drops ?? {}), bid: typeof t.settings?.waiver_bid === "number" ? t.settings.waiver_bid : null, roster_id: Array.isArray(t.roster_ids) && t.roster_ids.length ? t.roster_ids[0]! : null })) };
  }
  let schedule: MarketBuildInput["schedule"];
  try { schedule = { source: ok("PROVIDER_LIVE", asOf), games: await withTimeout(Promise.resolve(f.schedule(season || new Date().getUTCFullYear())), T, "schedule") }; } catch (e) { schedule = { source: down(e), games: null }; }
  void DAY_MS;
  // the scoring fingerprint is derived from the league's own raw scoring settings (same pure function the canonical layer uses)
  const fp = opts.scoring_fingerprint ?? (league ? scoringFingerprint(league.scoring_settings ?? {}) : null);
  return buildMarketSnapshot({ ...base, scoring_fingerprint: fp, season, rules, rosters, universe, transactions, schedule });
}
