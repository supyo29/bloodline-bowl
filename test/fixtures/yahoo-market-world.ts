/**
 * A scripted Yahoo league for Market State tests: a REAL `YahooFantasyClient` (real auth, refresh, JSON handling, GET-only transport) over a fake `fetch`
 * that answers the league/standings/roster/players/transactions/user-teams resources in Yahoo's nested positional shape. Every request is recorded
 * (method + url) so tests can prove what was and was not asked of Yahoo. No network.
 */
import { YahooFantasyClient } from "../../lib/providers/yahoo/client";
import { InMemoryYahooTokenStore, type YahooTokenStore } from "../../lib/providers/yahoo/oauth";
import { defaultYahooMarketIO, type YahooLeagueHandle, type YahooMarketIO } from "../../lib/market-state/yahoo-load";
import type { ScheduleGameInput } from "../../lib/market-state/build";

export const LK = "471.l.287140";
export const CONFIG = { client_id: "id", client_secret: "secret", redirect_uri: "https://x/cb", scope: "fspt-r", game_key_override: null };

export interface WPlayer { id: number; name: string; pos: string; team: string; injury?: string; bye?: number }
export interface WTeam { id: number; faab?: number | null; priority?: number | null; roster: Array<WPlayer & { slot?: string }> }
export interface WorldSettings { waiver_type?: string | null; waiver_rule?: string | null; waiver_time?: string | number | null; uses_faab?: string | null; max_adds?: string | null; max_weekly_adds?: string | null; extra?: Record<string, string>; roster_positions?: Array<{ position: string; count: number }> }
export interface World {
  teams: WTeam[];
  fa: WPlayer[];
  waivers: Array<WPlayer & { clear?: string }>;
  /** extra rostered players Yahoo's T pool returns that no roster read lists (conflict / missing-roster scenarios) */
  tOnly?: Array<WPlayer & { owner: number }>;
  /** rows that appear in a pool but that Yahoo's ownership says belong to a team */
  rosteredInWaiverPool?: Array<WPlayer & { owner: number }>;
  settings?: WorldSettings;
  ownedTeamKeys?: string[];
  txHead?: unknown;
  pendingClaims?: Array<{ team: number; addKey: string; dropKey?: string; bid?: number }>;
  /** resource-substring -> failure */
  fail?: Record<string, { status: number } | "network">;
  /** per-pool page cap (simulates a partial provider / safety limit) */
  poolCap?: Partial<Record<"FA" | "W" | "T", number>>;
  /** token state for refresh scenarios */
  token?: { expires_at: number };
}

const team = (n: number) => `${LK}.t.${n}`;
const pkey = (id: number) => `471.p.${id}`;

function playerMeta(p: WPlayer) {
  return [
    { player_key: pkey(p.id) }, { player_id: String(p.id) },
    { name: { full: p.name, first: p.name.split(" ")[0], last: p.name.split(" ").slice(1).join(" ") } },
    { editorial_team_abbr: p.team }, { bye_weeks: { week: String(p.bye ?? 7) } }, { status: p.injury ?? "" },
    { display_position: p.pos }, { eligible_positions: [{ position: p.pos }, ...(["RB", "WR", "TE"].includes(p.pos) ? [{ position: "W/R/T" }] : [])] },
  ];
}
function poolNode(p: WPlayer, own?: { type: string; waiver_date?: string; owner?: number }) {
  return own ? { player: [playerMeta(p), { ownership: { ownership_type: own.type, waiver_date: own.waiver_date, owner_team_key: own.owner ? team(own.owner) : undefined } }] } : { player: [playerMeta(p)] };
}
function pageOf(nodes: unknown[]) {
  const players: Record<string, unknown> = { count: nodes.length };
  nodes.forEach((n, i) => (players[String(i)] = n));
  return { fantasy_content: { league: [{ league_key: LK }, { players }] } };
}

function settingsBody(s: WorldSettings = {}) {
  const rp = s.roster_positions ?? [{ position: "QB", count: 1 }, { position: "RB", count: 2 }, { position: "WR", count: 2 }, { position: "TE", count: 1 }, { position: "W/R/T", count: 1 }, { position: "K", count: 1 }, { position: "DEF", count: 1 }, { position: "BN", count: 6 }, { position: "IR", count: 1 }];
  const obj: Record<string, unknown> = {
    draft_type: "live", scoring_type: "head", playoff_start_week: "15", num_playoff_teams: "4",
    uses_faab: s.uses_faab === undefined ? "0" : s.uses_faab, waiver_type: s.waiver_type === undefined ? "FR" : s.waiver_type, waiver_rule: s.waiver_rule === undefined ? "gametime" : s.waiver_rule,
    ...(s.waiver_time === undefined ? { waiver_time: "2" } : s.waiver_time === null ? {} : { waiver_time: s.waiver_time }),
    ...(s.max_adds ? { max_adds: s.max_adds } : {}), ...(s.max_weekly_adds ? { max_weekly_adds: s.max_weekly_adds } : {}), ...(s.extra ?? {}),
    roster_positions: rp.map((r) => ({ roster_position: { position: r.position, position_type: "O", count: String(r.count) } })),
    stat_categories: { stats: [{ stat: { stat_id: "5", name: "Passing Touchdowns", display_name: "Pass TD" } }] }, stat_modifiers: { stats: [{ stat: { stat_id: "5", value: "6" } }] },
  };
  return { fantasy_content: { league: [{ league_key: LK }, { settings: [obj] }] } };
}
function standingsBody(w: World) {
  const entries: Record<string, unknown> = { count: w.teams.length };
  w.teams.forEach((t, i) => {
    entries[String(i)] = { team: [[{ team_key: team(t.id) }, { team_id: String(t.id) }, { name: `Team ${t.id}` }, ...(t.priority != null ? [{ waiver_priority: String(t.priority) }] : []), ...(t.faab != null ? [{ faab_balance: String(t.faab) }] : []), { managers: [{ manager: { manager_id: String(t.id), nickname: `m${t.id}`, ...((w.ownedTeamKeys ?? []).includes(team(t.id)) ? { is_current_login: "1" } : {}) } }] }], { team_standings: { rank: String(i + 1), outcome_totals: { wins: "1", losses: "0", ties: "0" }, points_for: "10", points_against: "5" } }] };
  });
  return { fantasy_content: { league: [{ league_key: LK }, { standings: [{ teams: entries }] }] } };
}
function rosterBody(t: WTeam) {
  const players: Record<string, unknown> = { count: t.roster.length };
  t.roster.forEach((p, i) => (players[String(i)] = { player: [playerMeta(p), { selected_position: [{ coverage_type: "week" }, { week: "6" }, { position: p.slot ?? "BN" }] }] }));
  return { fantasy_content: { team: [[{ team_key: team(t.id) }], { roster: { "0": { coverage_type: "week", week: "6", players } } }] } };
}
function userTeamsBody(keys: string[]) {
  const teams: Record<string, unknown> = { count: keys.length };
  keys.forEach((k, i) => (teams[String(i)] = { team: [[{ team_key: k }, { team_id: k.split(".t.")[1] }]] }));
  return { fantasy_content: { users: { "0": { user: [{ guid: "G" }, { games: { "0": { game: [{ game_key: "471" }, { teams }] }, count: 1 } }] }, count: 1 } } };
}
function transactionsBody(w: World) {
  if (w.pendingClaims) return null;
  return w.txHead ?? { fantasy_content: { league: [{ league_key: LK }, { transactions: { count: 0 } }] } };
}
function pendingBody(w: World) {
  const rows = (w.pendingClaims ?? []).map((c, i) => [String(i), { transaction: [{ transaction_key: `${LK}.tr.${i + 1}`, transaction_id: String(i + 1), type: "add/drop", status: "pending", timestamp: "1760400000", faab_bid: c.bid != null ? String(c.bid) : undefined }, { players: { "0": { player: [[{ player_key: c.addKey }], { transaction_data: [{ type: "add", destination_team_key: team(c.team) }] }] }, ...(c.dropKey ? { "1": { player: [[{ player_key: c.dropKey }], { transaction_data: [{ type: "drop", source_team_key: team(c.team) }] }] } } : {}), count: c.dropKey ? 2 : 1 } }] }] as const);
  return { fantasy_content: { league: [{ league_key: LK }, { transactions: { ...Object.fromEntries(rows), count: rows.length } }] } };
}

export interface Recorded { method: string; url: string }
export function makeWorldClient(w: World, o: { readOnlyStore?: YahooTokenStore } = {}): { client: YahooFantasyClient; requests: Recorded[]; store: YahooTokenStore; refreshes: () => number } {
  const requests: Recorded[] = [];
  const memStore = new InMemoryYahooTokenStore(); const store: YahooTokenStore = o.readOnlyStore ?? memStore;
  if (!o.readOnlyStore) void memStore.set({ access_token: "A", refresh_token: "R", token_type: "bearer", scope: "fspt-r", expires_at: w.token?.expires_at ?? Date.now() + 3_600_000, yahoo_guid: "G" });
  let refreshCount = 0;
  const poolSources = (): Record<"FA" | "W" | "T", unknown[]> => {
    const all = [...w.teams.flatMap((t) => t.roster.map((p) => ({ p, owner: t.id }))), ...(w.tOnly ?? []).map((p) => ({ p, owner: p.owner }))];
    return {
      FA: w.fa.map((p) => poolNode(p)),
      W: [...w.waivers.map((p) => poolNode(p, { type: "waivers", waiver_date: p.clear ?? "2026-10-14" })), ...(w.rosteredInWaiverPool ?? []).map((p) => poolNode(p, { type: "team", owner: p.owner }))],
      T: all.map(({ p, owner }) => poolNode(p, { type: "team", owner })),
    };
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET";
    requests.push({ method, url });
    if (url.includes("login.yahoo.com") || url.includes("/oauth2/get_token")) { refreshCount += 1; return new Response(JSON.stringify({ access_token: "A2", refresh_token: "R2", token_type: "bearer", expires_in: 3600 }), { status: 200 }); }
    for (const [needle, f] of Object.entries(w.fail ?? {})) if (url.includes(needle)) { if (f === "network") throw new TypeError("fetch failed"); return new Response(JSON.stringify({ error: { description: "scripted failure" } }), { status: f.status }); }
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (/\/league\/[^/]+\/settings/.test(url)) return json(settingsBody(w.settings));
    if (/\/league\/[^/]+\/standings/.test(url)) return json(standingsBody(w));
    const roster = /\/team\/[^/]+\.t\.(\d+)\/roster/.exec(url);
    if (roster) { const t = w.teams.find((x) => x.id === Number(roster[1])); return t ? json(rosterBody(t)) : new Response("{}", { status: 404 }); }
    if (/users;use_login=1/.test(url)) return json(userTeamsBody(w.ownedTeamKeys ?? []));
    if (/\/transactions;team_key=.*type=waiver/.test(url)) return json(pendingBody(w));
    if (/\/league\/[^/]+\/transactions/.test(url)) return json(transactionsBody(w));
    const pm = /\/players;(.*?)(?:\/ownership)?\?/.exec(url) ?? /\/players;(.*?)(?:\/ownership)?$/.exec(url);
    if (pm) {
      const status = /status=([A-Z]+)/.exec(pm[1]!)?.[1] as "FA" | "W" | "T";
      const start = Number(/start=(\d+)/.exec(pm[1]!)?.[1] ?? 0); const count = Math.min(25, Number(/count=(\d+)/.exec(pm[1]!)?.[1] ?? 25));
      const src = poolSources()[status] ?? []; const cap = w.poolCap?.[status];
      const visible = cap != null ? src.slice(0, cap) : src;
      const withOwn = /\/ownership/.test(url);
      void withOwn;
      return json(pageOf(visible.slice(start, start + count)));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { client: new YahooFantasyClient({ config: CONFIG, store, fetchImpl, readOnly: !!o.readOnlyStore }), requests, store, refreshes: () => refreshCount };
}

export interface WorldIO { io: YahooMarketIO; requests: Recorded[]; client: YahooFantasyClient; handle: YahooLeagueHandle; opened: { count: number }; schedule: ScheduleGameInput[] }
export function makeWorldIO(w: World, o: { readOnlyStore?: YahooTokenStore; schedule?: ScheduleGameInput[] | "fail"; resolver?: (p: { player_key: string; name: string | null; position: string | null; team: string | null }) => string | null; openFail?: { code: string; detail: string } } = {}): WorldIO {
  const { client, requests } = makeWorldClient(w, { readOnlyStore: o.readOnlyStore });
  const handle: YahooLeagueHandle = { client, leagueKey: LK, gameKey: "471", connectionId: "primary" };
  const opened = { count: 0 };
  const schedule: ScheduleGameInput[] = o.schedule === "fail" || !o.schedule ? [{ week: 6, home: "BUF", away: "NYJ", status: "pre_game" }, { week: 6, home: "DET", away: "MIN", status: "complete" }] : o.schedule;
  // The REAL default reads (settings / teams / rosters / pools / transaction head / user teams / pending claims) run over the scripted client: only the
  // handle, the NFL schedule and identity resolution are test doubles.
  const io: YahooMarketIO = {
    ...defaultYahooMarketIO,
    async open() { opened.count += 1; return o.openFail ? { ok: false, ...o.openFail } : { ok: true, handle }; },
    async schedule() { if (o.schedule === "fail") throw new Error("schedule down"); return schedule; },
    async canonicalResolver() { return o.resolver ?? ((p) => (p.name ? `player:sleeper:${p.player_key.split(".p.")[1]}` : null)); },
  };
  return { io, requests, client, handle, opened, schedule };
}

/** A realistic small league: 4 teams, K and DEF rostered and available, FA + waiver players across every position. */
export function standardWorld(): World {
  const mk = (id: number, name: string, pos: string, team: string, extra: Partial<WPlayer> = {}): WPlayer => ({ id, name, pos, team, ...extra });
  return {
    teams: [
      { id: 1, faab: null, priority: 3, roster: [{ ...mk(1001, "Josh Allen", "QB", "BUF"), slot: "QB" }, { ...mk(1002, "Bijan Robinson", "RB", "ATL"), slot: "RB" }, { ...mk(1003, "Baltimore", "DEF", "BAL"), slot: "DEF" }, { ...mk(1004, "Justin Tucker", "K", "BAL"), slot: "K" }] },
      { id: 2, faab: null, priority: 1, roster: [{ ...mk(2001, "Lamar Jackson", "QB", "BAL"), slot: "QB" }, { ...mk(2002, "CeeDee Lamb", "WR", "DAL"), slot: "WR" }, { ...mk(2003, "Detroit", "DEF", "DET"), slot: "DEF" }] },
      { id: 3, faab: null, priority: 2, roster: [{ ...mk(3001, "Jalen Hurts", "QB", "PHI"), slot: "QB" }, { ...mk(3002, "Travis Kelce", "TE", "KC"), slot: "TE" }] },
      { id: 4, faab: null, priority: 4, roster: [{ ...mk(4001, "Joe Burrow", "QB", "CIN"), slot: "QB" }, { ...mk(4002, "Jaxon Smith-Njigba", "WR", "SEA"), slot: "WR" }] },
    ],
    fa: [mk(5001, "Tre Tucker", "WR", "LV"), mk(5002, "Jordan Addison", "WR", "MIN", { injury: "Q" }), mk(5003, "Brandon McManus", "K", "GB"), mk(5004, "Jacksonville", "DEF", "JAX"), mk(5005, "Washington", "DEF", "WSH"), mk(5006, "Tyler Allgeier", "RB", "ATL"), mk(5007, "Kenny Pickett", "QB", "LV"), mk(5008, "Isaiah Likely", "TE", "BAL")],
    waivers: [{ ...mk(6001, "Rachaad White", "RB", "TB"), clear: "2026-10-14" }, { ...mk(6002, "Younghoe Koo", "K", "ATL"), clear: "2026-10-14" }, { ...mk(6003, "Chicago", "DEF", "CHI"), clear: "2026-10-14" }],
    settings: {},
    ownedTeamKeys: [],
  };
}
