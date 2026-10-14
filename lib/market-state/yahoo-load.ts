/**
 * Yahoo Market State — the I/O edge. Reads, for ONE registered Yahoo league, everything the pure builder needs, then hands it to `buildYahooMarketSnapshot`.
 *
 * READ-ONLY by construction: every Yahoo call goes through `YahooFantasyClient.get` (a client with no other HTTP method), reached via
 * `YahooProvider.openReadHandle` — the same auth / token refresh / game-key / league-identity path as every other Yahoo read. No second client.
 *
 * CONNECTION ISOLATION: the connection is taken from the league's registry binding (`yahoo_connection_id`, default "primary") and re-validated against
 * `yahooLeaguesForConnection`; a league can never be read with another league's connection, and the league identity returned by Yahoo must match the
 * registry id (the provider refuses a substitution).
 *
 * FRESHNESS: Yahoo's market moves quickly (claims process, managers add/drop). A snapshot is reused for at most `YAHOO_MEMO_TTL_MS`; after that a CHEAP
 * fingerprint of the league's most recent transactions decides whether the cached raw reads are still valid (re-stamped, re-evaluated) or must be re-read.
 * Nothing older than `YAHOO_STALE_AFTER_MS` is ever served as actionable (the builder blocks with STALE_MARKET_STATE).
 *
 * Every failure degrades a SOURCE to UNAVAILABLE/PARTIAL with a PROVIDER_ERROR detail; nothing throws to the caller and nothing is fabricated.
 */
import { randomUUID } from "node:crypto";
import { findLeagueTarget } from "@/lib/leagues/registry";
import { teamId } from "@/lib/canonical/ids";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { loadYahooSleeperBridge } from "@/lib/canonical/yahoo-bridge-source";
import { defaultCrosswalkSource } from "@/lib/persistence/supabase/crosswalk-source";
import { YahooProvider } from "@/lib/providers/yahoo/provider";
import type { YahooFantasyClient } from "@/lib/providers/yahoo/client";
import { YahooApiError } from "@/lib/providers/yahoo/client";
import { DEFAULT_YAHOO_CONNECTION_ID, yahooLeaguesForConnection } from "@/lib/providers/yahoo/connections";
import { fetchYahooLeagueSettings, fetchYahooTeamRoster, fetchYahooTeamsAndStandings, type YahooLeagueSettingsRaw } from "@/lib/providers/yahoo/fetch";
import { fetchPlayerPool, type PoolResult, type YahooAvailabilityCode } from "@/lib/providers/yahoo/players";
import { readPendingClaims, type PendingClaimsRead } from "@/lib/providers/yahoo/pending-claims";
import { probeUserTeams } from "@/lib/providers/yahoo/discovery";
import { buildYahooMarketSnapshot, type YahooMarketBuildInput, type YahooPoolRow, type YahooRosterTeam, type YahooSubPool } from "./yahoo-build";
import { fetchNflSchedule } from "./schedule";
import { DEFAULT_STALE_AFTER_MS } from "./build";
import type { MarketSnapshot, SourceReport } from "./contract";
import type { ScheduleGameInput } from "./build";
import { hashOf } from "./hash";

export const YAHOO_MEMO_TTL_MS = 90_000;
/** the substrate's single staleness ceiling (10 min) — Market State's own freshness policy lives in ./build.ts; Yahoo does not keep a private copy */
export const YAHOO_STALE_AFTER_MS = DEFAULT_STALE_AFTER_MS;
export const YAHOO_POOL_TIME_BUDGET_MS = 40_000;
const ROSTER_WAVE = 4;

export interface YahooLeagueHandle { client: YahooFantasyClient; leagueKey: string; gameKey: string; connectionId: string }
export type YahooOpenResult = { ok: true; handle: YahooLeagueHandle } | { ok: false; code: string; detail: string };

/** Everything the loader needs from Yahoo + the world, injectable so the whole flow is testable without a network. */
export interface YahooMarketIO {
  open(leagueSlug: string): Promise<YahooOpenResult>;
  settings(h: YahooLeagueHandle): Promise<YahooLeagueSettingsRaw>;
  teams(h: YahooLeagueHandle): Promise<Array<{ team_key: string; team_id: string; faab_balance: number | null; waiver_priority: number | null; /** Yahoo flags a manager as the connected account's own login */ owned_by_connection?: boolean }>>;
  roster(h: YahooLeagueHandle, teamKey: string): ReturnType<typeof fetchYahooTeamRoster>;
  pool(h: YahooLeagueHandle, code: YahooAvailabilityCode, deadlineMs: number): Promise<PoolResult>;
  /** newest transactions (read-only); used as the cheap change fingerprint and the transaction-feed health signal */
  transactionHead(h: YahooLeagueHandle): Promise<string>;
  userTeams(h: YahooLeagueHandle): Promise<{ ok: boolean; team_keys: string[]; detail: string }>;
  pending(h: YahooLeagueHandle, ownedTeamKeys: string[]): Promise<PendingClaimsRead>;
  schedule(season: number): Promise<ScheduleGameInput[]>;
  /** canonical identity for one Yahoo player (null = unresolved). */
  canonicalResolver(): Promise<(p: { player_key: string; name: string | null; position: string | null; team: string | null }) => string | null>;
}

const down = (e: unknown, what: string): SourceReport => ({ status: "UNAVAILABLE", source_class: "UNAVAILABLE", fetched_at: null, detail: `PROVIDER_ERROR: ${what}: ${e instanceof YahooApiError ? `${e.kind}${e.httpStatus ? ` ${e.httpStatus}` : ""}` : e instanceof Error ? e.message : String(e)}`.slice(0, 240) });
const okSrc = (at: string, detail: string | null = null): SourceReport => ({ status: "OK", source_class: "PROVIDER_LIVE", fetched_at: at, detail });
const partial = (at: string, detail: string): SourceReport => ({ status: "PARTIAL", source_class: "PROVIDER_LIVE", fetched_at: at, detail });

/** The registry binding of a league to its Yahoo OAuth connection — the ONLY source of the connection id used for a league's reads. */
export function yahooBindingFor(slug: string): { ok: true; connection_id: string; external_league_id: string; season: number } | { ok: false; code: string; detail: string } {
  const target = findLeagueTarget(slug);
  if (!target || target.provider !== "yahoo") return { ok: false, code: "league_not_yahoo", detail: `"${slug}" is not a registered Yahoo league` };
  const connection_id = target.yahoo_connection_id ?? DEFAULT_YAHOO_CONNECTION_ID;
  // isolation: the connection must be registered FOR this league
  if (!yahooLeaguesForConnection(connection_id).some((l) => l.key === slug)) return { ok: false, code: "yahoo_connection_league_mismatch", detail: `league "${slug}" is not bound to Yahoo connection "${connection_id}"` };
  return { ok: true, connection_id, external_league_id: target.external_league_id, season: target.season };
}

/** Provider construction is injectable so tests can prove which connection each league's reads use. */
export const yahooProviderFactory: { create: (connectionId: string) => Pick<YahooProvider, "openReadHandle"> } = { create: (connectionId) => new YahooProvider({ connectionId }) };

export const defaultYahooMarketIO: YahooMarketIO = {
  async open(slug) {
    const b = yahooBindingFor(slug);
    if (!b.ok) return b;
    const provider = yahooProviderFactory.create(b.connection_id);
    const r = await provider.openReadHandle({ league_slug: slug, external_league_id: b.external_league_id, season: b.season });
    if (!r.data) return { ok: false, code: r.warnings[0]?.code ?? "yahoo_unavailable", detail: r.warnings[0]?.message ?? "Yahoo league could not be opened" };
    if (r.data.connectionId !== b.connection_id) return { ok: false, code: "yahoo_connection_league_mismatch", detail: "the opened handle used a different connection than the registry binding" };
    return { ok: true, handle: r.data };
  },
  settings: (h) => fetchYahooLeagueSettings(h.client, h.leagueKey),
  async teams(h) { const t = await fetchYahooTeamsAndStandings(h.client, h.leagueKey); return t.map((x) => ({ team_key: x.team_key, team_id: x.team_id, faab_balance: x.faab_balance, waiver_priority: x.waiver_priority, owned_by_connection: x.managers.some((m) => m.is_current_login === true) })); },
  roster: (h, k) => fetchYahooTeamRoster(h.client, k),
  pool: (h, code, deadlineMs) => fetchPlayerPool(h.client, h.leagueKey, { status: code, start: 0, count: null, deadlineMs, withOwnership: code === "W" || code === "T" }),
  async transactionHead(h) { const { data } = await h.client.get(`/league/${h.leagueKey}/transactions;count=5`); return hashOf(data); },
  userTeams: (h) => probeUserTeams(h.client, h.leagueKey),
  pending: (h, owned) => readPendingClaims(h.client, h.leagueKey, owned),
  schedule: fetchNflSchedule,
  async canonicalResolver() {
    const src = defaultCrosswalkSource();
    const cw = new PlayerCrosswalk(src ?? NoCrosswalk);
    await cw.ensureLoaded();
    cw.useYahooSleeperBridge(await loadYahooSleeperBridge());
    return (p) => {
      const r = cw.resolve({ provider: "yahoo", provider_player_id: p.player_key, full_name: p.name, position: p.position, nfl_team: p.team, known_identifiers: { yahoo_player_key: p.player_key } });
      return r.unresolved || r.player.canonical_player_id.startsWith("player:yahoo:") || r.player.canonical_player_id.startsWith("player:name:") || r.player.canonical_player_id.startsWith("player:unresolved:") ? null : r.player.canonical_player_id;
    };
  },
};

export interface LoadYahooMarketOptions { week: number; scoring_fingerprint?: string | null; source_snapshot_id?: string | null; now?: () => Date; noMemo?: boolean; poolTimeBudgetMs?: number }

interface MemoEntry { at: number; fingerprint: string | null; input: YahooMarketBuildInput; snapshot: MarketSnapshot; fetchedAtMs: number }
const memo = new Map<string, MemoEntry>();
const inflight = new Map<string, Promise<MarketSnapshot>>();
export const __clearYahooMarketMemo = (): void => { memo.clear(); inflight.clear(); };
/** Explicit invalidation (refresh events, claim processing, roster changes the caller knows about). */
export function invalidateYahooMarket(leagueSlug?: string): void { for (const k of [...memo.keys()]) if (!leagueSlug || k.startsWith(`${leagueSlug}:`)) memo.delete(k); }

export async function loadYahooMarketSnapshot(leagueSlug: string, opts: LoadYahooMarketOptions, io: YahooMarketIO = defaultYahooMarketIO): Promise<MarketSnapshot> {
  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();
  const key = `${leagueSlug}:${opts.week}`;
  const hit = memo.get(key);
  if (!opts.noMemo && hit) {
    const age = nowMs - hit.at;
    if (age < YAHOO_MEMO_TTL_MS) return hit.snapshot;
    if (nowMs - hit.fetchedAtMs < YAHOO_STALE_AFTER_MS && hit.fingerprint) {
      // cheap revalidation: unchanged transaction head -> re-stamp the same raw reads; changed or unreadable -> full re-read
      const opened = await io.open(leagueSlug).catch(() => null);
      const fp = opened?.ok ? await io.transactionHead(opened.handle).catch(() => null) : null;
      if (fp && fp === hit.fingerprint) {
        const snapshot = buildYahooMarketSnapshot({ ...hit.input, as_of: now().toISOString(), request_id: `req:${randomUUID()}` });
        memo.set(key, { ...hit, at: nowMs, snapshot });
        return snapshot;
      }
    }
    memo.delete(key);
  }
  const pending = inflight.get(key);
  if (!opts.noMemo && pending) return pending;
  const p = readAndBuild(leagueSlug, opts, io, now).then((r) => { if (!opts.noMemo && r.entry) memo.set(key, r.entry); return r.snapshot; }).finally(() => inflight.delete(key));
  if (!opts.noMemo) inflight.set(key, p);
  return p;
}

const EMPTY_PC = { visibility: "UNAVAILABLE" as const, reason: "not read", entries: [] };

async function readAndBuild(leagueSlug: string, opts: LoadYahooMarketOptions, io: YahooMarketIO, nowFn: () => Date): Promise<{ snapshot: MarketSnapshot; entry: MemoEntry | null }> {
  const target = findLeagueTarget(leagueSlug);
  const season = target?.season ?? 0;
  const base = { league_slug: leagueSlug, season, week: opts.week, request_id: `req:${randomUUID()}`, source_snapshot_id: opts.source_snapshot_id ?? null, scoring_fingerprint: opts.scoring_fingerprint ?? null };
  const iso = () => nowFn().toISOString();
  const emptyBuild = (why: SourceReport, asOf: string): MarketSnapshot => buildYahooMarketSnapshot({
    ...base, as_of: asOf,
    rules: { source: why, roster_positions: null, uses_faab: null, waiver_type: null, waiver_rule: null, waiver_time_days: null, max_adds_season: null, max_adds_weekly: null, raw: null },
    rosters: { source: why, teams: [], expected_teams: null }, pool: { source: why, rows: [], sub: {} }, transactions: { source: why },
    schedule: { source: why, games: null }, pending_claims: { ...EMPTY_PC, reason: why.detail ?? "Yahoo unavailable" },
  });

  const opened = await io.open(leagueSlug).catch((e: unknown) => ({ ok: false as const, code: "yahoo_open_failed", detail: e instanceof Error ? e.message : String(e) }));
  if (!opened.ok) return { snapshot: emptyBuild({ status: "UNAVAILABLE", source_class: "UNAVAILABLE", fetched_at: null, detail: `PROVIDER_ERROR: ${opened.code}: ${opened.detail}`.slice(0, 240) }, iso()), entry: null };
  const h = opened.handle;
  // the network time budget is WALL-CLOCK plumbing (fetchPlayerPool enforces it against Date.now()), independent of the injectable `now` used for stamping
  const deadline = Date.now() + (opts.poolTimeBudgetMs ?? YAHOO_POOL_TIME_BUDGET_MS);

  const settledAt = () => iso();
  const [settingsR, teamsR, faR, wR, tR, txR, userTeamsR, scheduleR, resolverR] = await Promise.allSettled([
    io.settings(h), io.teams(h), io.pool(h, "FA", deadline), io.pool(h, "W", deadline), io.pool(h, "T", deadline), io.transactionHead(h), io.userTeams(h), io.schedule(season || nowFn().getUTCFullYear()), io.canonicalResolver(),
  ]);

  /* rules */
  const rules: YahooMarketBuildInput["rules"] = settingsR.status === "fulfilled"
    ? { source: okSrc(settledAt()), roster_positions: settingsR.value.roster_positions, uses_faab: settingsR.value.uses_faab_stated, waiver_type: settingsR.value.waiver_type, waiver_rule: settingsR.value.waiver_rule, waiver_time_days: settingsR.value.waiver_time_days, max_adds_season: settingsR.value.max_adds_season, max_adds_weekly: settingsR.value.max_adds_weekly, raw: { waiver_type: settingsR.value.waiver_type, uses_faab: settingsR.value.uses_faab_stated, ...settingsR.value.acquisition_raw } }
    : { source: down(settingsR.reason, "league settings"), roster_positions: null, uses_faab: null, waiver_type: null, waiver_rule: null, waiver_time_days: null, max_adds_season: null, max_adds_weekly: null, raw: null };

  /* rosters: one read per team, bounded concurrency; a failed team degrades the source to PARTIAL, never silently */
  let rosters: YahooMarketBuildInput["rosters"];
  if (teamsR.status !== "fulfilled") rosters = { source: down(teamsR.reason, "teams/standings"), teams: [], expected_teams: null };
  else {
    const teams = teamsR.value; const out: YahooRosterTeam[] = []; const failed: string[] = [];
    for (let i = 0; i < teams.length; i += ROSTER_WAVE) {
      const wave = teams.slice(i, i + ROSTER_WAVE);
      const rs = await Promise.allSettled(wave.map((t) => io.roster(h, t.team_key)));
      rs.forEach((r, j) => {
        const t = wave[j]!;
        if (r.status !== "fulfilled") { failed.push(t.team_key); return; }
        const meta = new Map(r.value.players.map((p) => [p.player_key, p]));
        out.push({ team_key: t.team_key, team_id: teamId(leagueSlug, t.team_id), faab_balance: t.faab_balance, waiver_priority: t.waiver_priority, players: r.value.slots.map((s) => { const p = meta.get(s.player_key); return { player_key: s.player_key, selected_position: s.selected_position, name: p?.full_name ?? null, display_position: p?.display_position ?? null, eligible_positions: p?.eligible_positions ?? [], team_abbr: p?.editorial_team_abbr ?? null, injury_status: p?.status ?? null }; }) });
      });
    }
    rosters = { source: failed.length === 0 ? okSrc(settledAt()) : out.length === 0 ? down(`${failed.length} of ${teams.length} roster reads failed`, "rosters") : partial(settledAt(), `${failed.length} of ${teams.length} team roster reads failed: ${failed.join(", ")}`), teams: out, expected_teams: teams.length };
  }

  /* pool: raw rows per sub-pool (NOT the cross-pool deduped merge: a player in two pools is a conflict the builder must see) */
  const rows: YahooPoolRow[] = []; const sub: YahooMarketBuildInput["pool"]["sub"] = {}; const poolErrs: string[] = [];
  for (const [code, r] of [["FA", faR], ["W", wR], ["T", tR]] as const) {
    if (r.status !== "fulfilled") { poolErrs.push(`${code}: ${r.reason instanceof YahooApiError ? r.reason.kind : r.reason instanceof Error ? r.reason.message : String(r.reason)}`); continue; }
    sub[code] = { returned: r.value.players.length, complete: r.value.complete, pages_fetched: r.value.pages_fetched, stopped_reason: r.value.stopped_reason, dropped_rostered: r.value.dropped_rostered } satisfies YahooSubPool;
    for (const p of r.value.players) rows.push({ player_key: p.player_key, player_id: p.player_id, name: p.name, display_position: p.display_position, eligible_positions: p.eligible_positions, team_abbr: p.editorial_team_abbr, status: code, waiver_clear_date: p.waiver_clear_date, owner_team_key: p.owner_team_key, ownership_type: p.ownership_type, injury_status: p.injury_status, bye_week: p.bye_week });
  }
  const poolAt = settledAt();
  const pool: YahooMarketBuildInput["pool"] = {
    source: !sub.FA && !sub.W ? down(poolErrs.join("; ") || "no pool could be read", "player pools") : poolErrs.length || Object.values(sub).some((s) => !s.complete) ? partial(poolAt, `${poolErrs.length ? `pool read failed: ${poolErrs.join("; ")}. ` : ""}${Object.entries(sub).filter(([, s]) => !s.complete).map(([k, s]) => `${k} stopped at ${s.stopped_reason}`).join("; ")}`.trim()) : okSrc(poolAt),
    rows, sub,
  };

  /* transactions (health + fingerprint) */
  const transactions: YahooMarketBuildInput["transactions"] = { source: txR.status === "fulfilled" ? okSrc(settledAt()) : down(txR.reason, "transactions") };
  const fingerprint = txR.status === "fulfilled" ? txR.value : null;

  /* schedule */
  const schedule: YahooMarketBuildInput["schedule"] = scheduleR.status === "fulfilled" ? { source: okSrc(settledAt()), games: scheduleR.value } : { source: down(scheduleR.reason, "NFL schedule"), games: null };

  /* pending claims: only for a team the connected account owns — two independent signals: Yahoo's users/teams listing and the standings' is_current_login flag */
  let pending_claims: YahooMarketBuildInput["pending_claims"];
  const flagged = teamsR.status === "fulfilled" ? teamsR.value.filter((t) => t.owned_by_connection).map((t) => t.team_key) : [];
  const listed = userTeamsR.status === "fulfilled" && userTeamsR.value.ok ? userTeamsR.value.team_keys : [];
  const owned = [...new Set([...listed, ...flagged])].sort();
  if (userTeamsR.status !== "fulfilled" && flagged.length === 0) pending_claims = { visibility: "UNAVAILABLE", reason: "the connected account's teams could not be read", entries: [] };
  else if (userTeamsR.status === "fulfilled" && !userTeamsR.value.ok && flagged.length === 0) pending_claims = { visibility: "UNAVAILABLE", reason: userTeamsR.value.detail, entries: [] };
  else {
    const pc = await io.pending(h, owned).catch((e: unknown): PendingClaimsRead => ({ visibility: "UNAVAILABLE", reason: `pending-claims read failed: ${e instanceof Error ? e.message : String(e)}`, claims: [] }));
    pending_claims = { visibility: pc.visibility, reason: pc.reason, entries: pc.claims.map((c) => ({ team_key: c.team_key, add_player_key: c.add_player_key, drop_player_key: c.drop_player_key, bid: c.bid })) };
  }

  const resolver = resolverR.status === "fulfilled" ? resolverR.value : null;
  const asOf = iso();
  const input: YahooMarketBuildInput = {
    ...base, as_of: asOf, rules, rosters, pool, transactions, schedule, pending_claims, stale_after_ms: YAHOO_STALE_AFTER_MS,
    canonical_id: resolver ? (p) => resolver({ player_key: p.player_key, name: p.name, position: p.position, team: p.team }) : undefined,
    team_id_for_key: (k) => { const m = /\.t\.(\d+)$/.exec(k); return m ? teamId(leagueSlug, m[1]!) : null; },
  };
  const snapshot = buildYahooMarketSnapshot(input);
  const fetchedAtMs = Math.min(...[pool.source.fetched_at, rosters.source.fetched_at, rules.source.fetched_at].filter((x): x is string => !!x).map((x) => Date.parse(x)));
  const cacheable = snapshot.readiness.pool_actionable && Number.isFinite(fetchedAtMs);
  return { snapshot, entry: cacheable ? { at: nowFn().getTime(), fingerprint, input, snapshot, fetchedAtMs } : null };
}
