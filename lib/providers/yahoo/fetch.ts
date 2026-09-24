/**
 * Yahoo live fetch + flatten layer.
 *
 * This is the ONLY place that reads Yahoo's raw `fantasy_content` shape for
 * league/team/roster/standings/transaction/draft resources. Every function here
 * returns a `YahooFlat*` shape (see `./canonical`) — Yahoo's positional-array
 * JSON never leaks past this module. `./provider.ts` calls these and hands the
 * result to `yahooBundleToCanonical`.
 *
 * Every request goes through `YahooFantasyClient` (auth, retry-once, timeout,
 * classified `YahooApiError`) — nothing here calls `fetch()` directly.
 *
 * Pagination: Yahoo's transaction collection is paged with `;start=N;count=M`.
 * This module keeps requesting pages until a short page is returned, and never
 * stops early on a full page (a would-be truncation raises a warning instead of
 * silently dropping rows) — see `MAX_TRANSACTION_PAGES`.
 */

import type { YahooFantasyClient } from "./client";
import { YahooApiError } from "./client";
import {
  asBool,
  asNumber,
  asRecord,
  asString,
  collectionEntries,
  fantasyContent,
  mergeYahooEntity,
  unwrap,
} from "./parse";
import { mapYahooScoringSettings, type YahooStatCategory, type YahooStatModifier } from "./scoring";
import type {
  YahooFlatBundle,
  YahooFlatLeague,
  YahooFlatPlayer,
  YahooFlatTeam,
  YahooFlatTransaction,
} from "./canonical";

const TRANSACTION_PAGE_SIZE = 100;
const MAX_TRANSACTION_PAGES = 30; // safety cap: 3000 transactions: never expected in one season

export interface YahooLeagueIdentity {
  league_key: string;
  league_id: string;
  name: string;
  season: number;
}

/** `GET /league/{key}/metadata` -> the league's identity + top-level facts. */
export async function fetchYahooLeagueIdentity(
  client: YahooFantasyClient,
  leagueKey: string,
): Promise<{
  identity: YahooLeagueIdentity;
  current_week: number | null;
  num_teams: number;
  scoring_type: string;
  draft_status: string | null;
}> {
  const { data } = await client.get(`/league/${leagueKey}/metadata`);
  const fc = fantasyContent(data);
  const leagueNode = collectionEntries(fc?.leagues)[0] ?? fc?.league;
  const m = mergeYahooEntity(unwrap(leagueNode, "league"));

  const league_key = asString(m.league_key);
  const league_id = asString(m.league_id);
  const name = asString(m.name);
  const season = asNumber(m.season);
  if (!league_key || !league_id || !name || season == null) {
    throw new YahooApiError(
      "MALFORMED",
      `Yahoo league metadata for ${leagueKey} was missing required fields.`,
      null,
      `/league/${leagueKey}/metadata`,
    );
  }
  return {
    identity: { league_key, league_id, name, season },
    current_week: asNumber(m.current_week),
    num_teams: asNumber(m.num_teams) ?? 0,
    scoring_type: asString(m.scoring_type) ?? "head",
    draft_status: asString(m.draft_status),
  };
}

export interface YahooLeagueSettingsRaw {
  roster_positions: Array<{ position: string; count: number }>;
  stat_categories: YahooStatCategory[];
  stat_modifiers: YahooStatModifier[];
  playoff_start_week: number | null;
  num_playoff_teams: number | null;
  waiver_type: string | null;
  uses_faab: boolean;
}

/** `GET /league/{key}/settings` -> roster slots + scoring configuration. */
export async function fetchYahooLeagueSettings(
  client: YahooFantasyClient,
  leagueKey: string,
): Promise<YahooLeagueSettingsRaw> {
  const { data } = await client.get(`/league/${leagueKey}/settings`);
  const fc = fantasyContent(data);
  const leagueMerged = mergeYahooEntity(fc?.league ?? fc?.leagues);
  const settings = mergeYahooEntity(leagueMerged.settings);

  const roster_positions = collectionEntries(settings.roster_positions).map((entry) => {
    const rp = mergeYahooEntity(unwrap(entry, "roster_position"));
    return {
      position: asString(rp.position) ?? "UNKNOWN",
      count: asNumber(rp.count) ?? 0,
    };
  });

  const statCategories = asRecord(settings.stat_categories);
  const stat_categories: YahooStatCategory[] = collectionEntries(statCategories?.stats).map((entry) => {
    const s = mergeYahooEntity(unwrap(entry, "stat"));
    return {
      stat_id: asString(s.stat_id) ?? "",
      name: asString(s.name),
      display_name: asString(s.display_name),
    };
  }).filter((s) => s.stat_id !== "");

  const statModifiers = asRecord(settings.stat_modifiers);
  const stat_modifiers: YahooStatModifier[] = collectionEntries(statModifiers?.stats).map((entry) => {
    const s = mergeYahooEntity(unwrap(entry, "stat"));
    return { stat_id: asString(s.stat_id) ?? "", value: asNumber(s.value) ?? 0 };
  }).filter((s) => s.stat_id !== "");

  return {
    roster_positions,
    stat_categories,
    stat_modifiers,
    playoff_start_week: asNumber(settings.playoff_start_week),
    num_playoff_teams: asNumber(settings.num_playoff_teams),
    waiver_type: asString(settings.waiver_type),
    uses_faab: asBool(settings.uses_faab),
  };
}

function parseYahooPlayer(node: unknown): YahooFlatPlayer | null {
  const p = mergeYahooEntity(unwrap(node, "player"));
  const player_key = asString(p.player_key);
  const player_id = asString(p.player_id);
  if (!player_key || !player_id) return null;
  const nameRec = asRecord(p.name);
  const full_name = (nameRec ? asString(nameRec.full) : null) ?? asString(p.name) ?? "Unknown Player";
  const eligible = collectionEntries(p.eligible_positions)
    .map((e) => (typeof e === "string" ? e : asString(unwrap(e, "position"))))
    .filter((v): v is string => Boolean(v));
  return {
    player_key,
    player_id,
    full_name,
    first_name: nameRec ? asString(nameRec.first) ?? undefined : undefined,
    last_name: nameRec ? asString(nameRec.last) ?? undefined : undefined,
    editorial_team_abbr: asString(p.editorial_team_abbr),
    display_position: asString(p.display_position),
    eligible_positions: eligible.length > 0 ? eligible : undefined,
    status: asString(p.status),
  };
}

/** `GET /league/{key}/standings` -> every team's identity, managers, and record. */
export async function fetchYahooTeamsAndStandings(
  client: YahooFantasyClient,
  leagueKey: string,
): Promise<YahooFlatTeam[]> {
  const { data } = await client.get(`/league/${leagueKey}/standings`);
  const fc = fantasyContent(data);
  const leagueMerged = mergeYahooEntity(fc?.league ?? fc?.leagues);
  const standings = mergeYahooEntity(leagueMerged.standings);
  const teamEntries = collectionEntries(standings.teams);

  return teamEntries.map((entry) => {
    const t = mergeYahooEntity(unwrap(entry, "team"));
    const team_key = asString(t.team_key) ?? "";
    const team_id = asString(t.team_id) ?? "";
    const name = asString(t.name) ?? `Team ${team_id}`;

    const managers = collectionEntries(t.managers).map((m) => {
      const mm = mergeYahooEntity(unwrap(m, "manager"));
      return {
        // Yahoo may privacy-mask GUIDs for managers other than the current
        // login, while manager_id remains league-stable and unique. Canonical
        // manager ids are league-scoped, so prefer manager_id and use GUID only
        // as a fallback rather than collapsing multiple managers onto one
        // masked GUID value.
        guid: asString(mm.manager_id) ?? asString(mm.guid) ?? `unknown-${team_id}`,
        nickname: asString(mm.nickname) ?? "Unknown Manager",
        is_commissioner: asBool(mm.is_commissioner),
        is_current_login: asBool(mm.is_current_login),
      };
    });

    const teamStandings = asRecord(t.team_standings);
    const outcomes = asRecord(teamStandings?.outcome_totals);

    return {
      team_key,
      team_id,
      name,
      managers,
      wins: asNumber(outcomes?.wins) ?? 0,
      losses: asNumber(outcomes?.losses) ?? 0,
      ties: asNumber(outcomes?.ties) ?? 0,
      points_for: asNumber(teamStandings?.points_for) ?? 0,
      points_against: asNumber(teamStandings?.points_against) ?? 0,
      faab_balance: asNumber(t.faab_balance),
      waiver_priority: asNumber(t.waiver_priority),
      rank: asNumber(teamStandings?.rank),
      roster: [], // filled by fetchYahooTeamRoster
    };
  });
}

/**
 * `GET /team/{teamKey}/roster` -> that team's current slots + full player
 * metadata for everyone on it (Yahoo's roster response embeds player details,
 * so this is the primary source of `YahooFlatPlayer` rows).
 */
export async function fetchYahooTeamRoster(
  client: YahooFantasyClient,
  teamKey: string,
): Promise<{ slots: Array<{ player_key: string; selected_position: string }>; players: YahooFlatPlayer[] }> {
  const { data } = await client.get(`/team/${teamKey}/roster`);
  const fc = fantasyContent(data);
  const teamMerged = mergeYahooEntity(fc?.team ?? fc?.teams);
  const roster = mergeYahooEntity(teamMerged.roster);
  const playerEntries = collectionEntries(roster.players);

  const slots: Array<{ player_key: string; selected_position: string }> = [];
  const players: YahooFlatPlayer[] = [];

  for (const entry of playerEntries) {
    const playerNode = unwrap(entry, "player");
    const flat = parseYahooPlayer(playerNode);
    if (!flat) continue;
    players.push(flat);
    const merged = mergeYahooEntity(playerNode);
    const selPos = mergeYahooEntity(merged.selected_position);
    slots.push({
      player_key: flat.player_key,
      selected_position: asString(selPos.position) ?? "BN",
    });
  }

  return { slots, players };
}

/**
 * `GET /players;player_keys=k1,k2,...` -> metadata for player keys not covered
 * by any current roster read (e.g. a player referenced only by a transaction).
 * Batched at 25 keys/request — Yahoo's documented practical ceiling.
 */
export async function fetchYahooPlayersByKeys(
  client: YahooFantasyClient,
  playerKeys: string[],
): Promise<Map<string, YahooFlatPlayer>> {
  const out = new Map<string, YahooFlatPlayer>();
  const unique = [...new Set(playerKeys)].filter(Boolean);
  const BATCH = 25;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const { data } = await client.get(`/players;player_keys=${batch.join(",")}`);
    const fc = fantasyContent(data);
    for (const entry of collectionEntries(fc?.players)) {
      const flat = parseYahooPlayer(unwrap(entry, "player"));
      if (flat) out.set(flat.player_key, flat);
    }
  }
  return out;
}

export interface YahooDraftPickRaw {
  pick: number;
  round: number;
  team_key: string;
  player_key: string | null;
  cost: number | null;
}

/** `GET /league/{key}/draftresults` -> every pick, if the league has drafted. */
export async function fetchYahooDraftResults(
  client: YahooFantasyClient,
  leagueKey: string,
): Promise<YahooDraftPickRaw[]> {
  const { data } = await client.get(`/league/${leagueKey}/draftresults`);
  const fc = fantasyContent(data);
  const leagueMerged = mergeYahooEntity(fc?.league ?? fc?.leagues);
  const draftResults = mergeYahooEntity(leagueMerged.draft_results);
  const entries = collectionEntries(draftResults).length > 0
    ? collectionEntries(draftResults)
    : collectionEntries(leagueMerged.draft_results);

  return entries.map((entry) => {
    const d = mergeYahooEntity(unwrap(entry, "draft_result"));
    return {
      pick: asNumber(d.pick) ?? 0,
      round: asNumber(d.round) ?? 0,
      team_key: asString(d.team_key) ?? "",
      player_key: asString(d.player_key),
      cost: asNumber(d.cost),
    };
  }).filter((p) => p.pick > 0 && p.team_key !== "");
}

/**
 * `GET /league/{key}/transactions` — paginated with `;start=N;count=M`. Keeps
 * requesting pages until a short page comes back; if the safety cap is hit
 * while a page was still full, that is reported to the caller (never silently
 * truncated).
 */
export async function fetchYahooTransactions(
  client: YahooFantasyClient,
  leagueKey: string,
): Promise<{ transactions: YahooFlatTransaction[]; truncated: boolean }> {
  const all: YahooFlatTransaction[] = [];
  let truncated = false;

  for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
    const start = page * TRANSACTION_PAGE_SIZE;
    const { data } = await client.get(
      `/league/${leagueKey}/transactions;start=${start};count=${TRANSACTION_PAGE_SIZE}`,
    );
    const fc = fantasyContent(data);
    const leagueMerged = mergeYahooEntity(fc?.league ?? fc?.leagues);
    const txCollection = mergeYahooEntity(leagueMerged.transactions);
    const entries = collectionEntries(txCollection).length > 0
      ? collectionEntries(txCollection)
      : collectionEntries(leagueMerged.transactions);

    for (const entry of entries) {
      const parsed = parseYahooTransaction(entry);
      if (parsed) all.push(parsed);
    }

    if (entries.length < TRANSACTION_PAGE_SIZE) {
      return { transactions: all, truncated: false };
    }
    if (page === MAX_TRANSACTION_PAGES - 1) truncated = true;
  }
  return { transactions: all, truncated };
}

function parseYahooTransaction(entry: unknown): YahooFlatTransaction | null {
  const t = mergeYahooEntity(unwrap(entry, "transaction"));
  const transaction_key = asString(t.transaction_key);
  const transaction_id = asString(t.transaction_id);
  const type = asString(t.type);
  if (!transaction_key || !transaction_id || !type) return null;

  const players = collectionEntries(t.players).map((p) => {
    const pm = mergeYahooEntity(unwrap(p, "player"));
    const txData = mergeYahooEntity(pm.transaction_data);
    const moveType = asString(txData.type) === "drop" ? ("drop" as const) : ("add" as const);
    return {
      player_key: asString(pm.player_key) ?? "",
      type: moveType,
      source_team_key: asString(txData.source_team_key),
      destination_team_key: asString(txData.destination_team_key),
    };
  }).filter((p) => p.player_key !== "");

  return {
    transaction_key,
    transaction_id,
    type,
    status: asString(t.status) ?? "unknown",
    timestamp: asNumber(t.timestamp) ?? 0,
    week: null, // Yahoo transaction resources do not carry an explicit fantasy week
    players,
    faab_bid: asNumber(t.faab_bid),
    trader_team_key: asString(t.trader_team_key),
    tradee_team_key: asString(t.tradee_team_key),
  };
}

export interface YahooMatchupSideRaw {
  team_key: string;
  points: number | null;
  projected_points: number | null;
}

export interface YahooMatchupRaw {
  week: number;
  status: string | null;
  sides: YahooMatchupSideRaw[];
}

/** `GET /league/{key}/scoreboard;week=N` -> that week's matchups. */
export async function fetchYahooScoreboard(
  client: YahooFantasyClient,
  leagueKey: string,
  week: number,
): Promise<YahooMatchupRaw[]> {
  const { data } = await client.get(`/league/${leagueKey}/scoreboard;week=${week}`);
  const fc = fantasyContent(data);
  const leagueMerged = mergeYahooEntity(fc?.league ?? fc?.leagues);
  const scoreboard = mergeYahooEntity(leagueMerged.scoreboard);
  const matchupEntries = collectionEntries(scoreboard.matchups);

  return matchupEntries.map((entry) => {
    const m = mergeYahooEntity(unwrap(entry, "matchup"));
    const teamEntries = collectionEntries(m.teams);
    const sides: YahooMatchupSideRaw[] = teamEntries.map((te) => {
      const tm = mergeYahooEntity(unwrap(te, "team"));
      const pts = asRecord(tm.team_points);
      const proj = asRecord(tm.team_projected_points);
      return {
        team_key: asString(tm.team_key) ?? "",
        points: pts ? asNumber(pts.total) : null,
        projected_points: proj ? asNumber(proj.total) : null,
      };
    }).filter((s) => s.team_key !== "");
    return {
      week: asNumber(m.week) ?? week,
      status: asString(m.status),
      sides,
    };
  }).filter((mu) => mu.sides.length > 0);
}

/**
 * Full league-state fetch: identity + settings + teams/standings + every
 * team's roster (players embedded) + draft results. Deliberately does NOT
 * fetch transactions or a specific week's scoreboard — those are separate,
 * narrower provider calls (`getTransactions` / `getMatchups`), matching
 * `CanonicalLeagueStateBundle`'s shape.
 */
export async function fetchYahooLeagueBundle(
  client: YahooFantasyClient,
  leagueKey: string,
): Promise<{
  bundle: YahooFlatBundle;
  draftResults: YahooDraftPickRaw[];
  scoringWarnings: Array<{ stat_id: string; name: string | null; value: number }>;
}> {
  const [identity, settings, teams] = await Promise.all([
    fetchYahooLeagueIdentity(client, leagueKey),
    fetchYahooLeagueSettings(client, leagueKey),
    fetchYahooTeamsAndStandings(client, leagueKey),
  ]);

  const rosterResults = await Promise.all(
    teams.map((t) => fetchYahooTeamRoster(client, t.team_key)),
  );

  const playersByKey = new Map<string, YahooFlatPlayer>();
  for (let i = 0; i < teams.length; i += 1) {
    const team = teams[i];
    const result = rosterResults[i];
    if (!team || !result) continue;
    team.roster = result.slots;
    for (const p of result.players) playersByKey.set(p.player_key, p);
  }

  // Fail closed on the exact production defect found during Rogers Park live
  // certification: an in-season league with real teams must not silently
  // normalize ten empty rosters as usable ownership state.
  if (identity.current_week && teams.length > 0 && teams.every((t) => t.roster.length === 0)) {
    throw new YahooApiError(
      "MALFORMED",
      `Yahoo returned no rostered players for any of ${teams.length} teams in in-season league ${leagueKey}.`,
      null,
      `/league/${leagueKey}/state`,
    );
  }

  const draftResults = await fetchYahooDraftResults(client, leagueKey).catch(() => [] as YahooDraftPickRaw[]);

  // Draft picks may reference players not on any current roster (since traded/dropped).
  const missingDraftPlayerKeys: string[] = [];
  for (const d of draftResults) {
    if (d.player_key && !playersByKey.has(d.player_key)) missingDraftPlayerKeys.push(d.player_key);
  }
  if (missingDraftPlayerKeys.length > 0) {
    const extra = await fetchYahooPlayersByKeys(client, missingDraftPlayerKeys).catch(
      () => new Map<string, YahooFlatPlayer>(),
    );
    for (const [k, v] of extra) playersByKey.set(k, v);
  }

  const scoring = mapYahooScoringSettings(settings.stat_categories, settings.stat_modifiers);

  const league: YahooFlatLeague = {
    league_key: identity.identity.league_key,
    league_id: identity.identity.league_id,
    name: identity.identity.name,
    season: identity.identity.season,
    current_week: identity.current_week,
    num_teams: identity.num_teams || teams.length,
    scoring_type: identity.scoring_type,
    stat_modifiers: scoring.raw_scoring,
    roster_positions: settings.roster_positions,
    playoff_start_week: settings.playoff_start_week,
    num_playoff_teams: settings.num_playoff_teams,
    waiver_type: settings.waiver_type,
    uses_faab: settings.uses_faab,
  };

  const bundle: YahooFlatBundle = {
    league,
    teams,
    players: [...playersByKey.values()],
    transactions: [],
  };

  return { bundle, draftResults, scoringWarnings: scoring.unmapped };
}
