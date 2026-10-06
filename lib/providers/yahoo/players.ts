/**
 * Yahoo league player pool: free agents, waivers, and rostered players.
 *
 * Endpoint: `GET /league/{league_key}/players;status=<S>;position=<P>;search=<N>;start=<n>;count=<c>`
 *
 * How Yahoo represents availability (documented Yahoo behavior; this module
 * records which query produced each row so the label never depends on a field
 * Yahoo may omit):
 *   - `status=FA` -> free agents (unrostered, pick-up-able immediately)
 *   - `status=W`  -> players on waivers (unrostered, claim-only until `waiver_date`)
 *   - `status=A`  -> FA + W combined (Yahoo does not label which is which)
 *   - `status=T`  -> taken / rostered by some team
 *   - the player's own `status` field is the INJURY designation (Q/O/IR/NA/SUSP…),
 *     NOT availability — it is surfaced separately as `injury_status`.
 *   - the `/ownership` sub-resource carries `ownership_type`
 *     (`freeagents` | `waivers` | `team`), `waiver_date`, and `owner_team_key`.
 *
 * Pagination: Yahoo caps `count` at 25 per request and never returns a total, so
 * a pool is complete only when a page comes back short (< 25) or empty. Pages are
 * fetched in small concurrent waves up to a documented safety limit.
 */

import type { YahooFantasyClient } from "./client";
import { YahooApiError } from "./client";
import {
  asNumber,
  asRecord,
  asString,
  collectionEntries,
  fantasyContent,
  mergeYahooEntity,
  unwrap,
} from "./parse";

/** Yahoo's hard per-request ceiling on `count`. */
export const YAHOO_PLAYERS_PAGE_SIZE = 25;
/** Safety limit: pages per sub-pool in one request (25 * 160 = 4000 players). */
export const YAHOO_PLAYERS_MAX_PAGES = 160;
/** Concurrent page fetches per wave (kept low to stay under Yahoo's rate limits). */
const WAVE = 4;

export type YahooAvailabilityCode = "FA" | "W" | "T";
export type YahooAvailability = "free_agent" | "waivers" | "rostered";

export const AVAILABILITY_BY_CODE: Record<YahooAvailabilityCode, YahooAvailability> = {
  FA: "free_agent",
  W: "waivers",
  T: "rostered",
};

export interface YahooPoolPlayer {
  player_id: string;
  player_key: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  display_position: string | null;
  eligible_positions: string[];
  editorial_team_abbr: string | null;
  /** Availability code from the query that returned the row: FA | W | T. */
  status: YahooAvailabilityCode;
  availability: YahooAvailability;
  /** ISO date (YYYY-MM-DD) Yahoo reports for waiver clearance, else null. */
  waiver_clear_date: string | null;
  bye_week: number | null;
  /** Yahoo's raw player `status` (injury designation: Q, O, IR, NA, …), else null. */
  injury_status: string | null;
  injury_note: string | null;
  /** Rostering team for status=T rows (from the ownership sub-resource). */
  owner_team_key: string | null;
  /** Raw `ownership_type` when the ownership sub-resource was returned. */
  ownership_type: string | null;
}

export interface PoolQuery {
  status: YahooAvailabilityCode;
  position?: string | null;
  search?: string | null;
  start: number;
  /** Max players wanted from this pool; null = everything (all=true). */
  count: number | null;
  maxPages?: number;
  /** Absolute epoch-ms deadline after which no new page waves start. */
  deadlineMs?: number;
  /** Request the ownership sub-resource (waiver_date, owner). Falls back if Yahoo rejects it. */
  withOwnership?: boolean;
}

export interface PoolResult {
  status: YahooAvailabilityCode;
  players: YahooPoolPlayer[];
  pages_fetched: number;
  requests: string[];
  /** True when Yahoo signalled the end of the pool (short or empty page). */
  complete: boolean;
  /** Offset to request next when `complete` is false, else null. */
  next_start: number | null;
  stopped_reason: "end_of_pool" | "count_reached" | "safety_limit" | "deadline";
  ownership: "requested" | "not_requested" | "unavailable_fell_back";
  /** Rows dropped because Yahoo's ownership said "team" inside an FA/W query. */
  dropped_rostered: number;
  duplicates_dropped: number;
}

export function sanitizePosition(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  return /^[A-Z/]{1,8}$/.test(v) ? v : null;
}

/** Build the collection path for one page. Exported for tests. */
export function buildPlayersPath(
  leagueKey: string,
  q: { status?: string; position?: string | null; search?: string | null; start: number; count: number; playerKeys?: string[] },
  withOwnership: boolean,
): string {
  const parts: string[] = [];
  if (q.playerKeys?.length) parts.push(`player_keys=${q.playerKeys.join(",")}`);
  if (q.status) parts.push(`status=${q.status}`);
  if (q.position) parts.push(`position=${encodeURIComponent(q.position)}`);
  if (q.search) parts.push(`search=${encodeURIComponent(q.search)}`);
  if (!q.playerKeys?.length) {
    parts.push(`start=${q.start}`, `count=${q.count}`);
    // Overall rank gives a stable ordering across pages (otherwise paging can drift).
    parts.push("sort=OR");
  }
  return `/league/${leagueKey}/players;${parts.join(";")}${withOwnership ? "/ownership" : ""}`;
}

/** Parse one Yahoo `player` node (with optional ownership sub-resource). */
export function parseYahooPoolPlayer(
  node: unknown,
  status: YahooAvailabilityCode,
): YahooPoolPlayer | null {
  const p = mergeYahooEntity(unwrap(node, "player"));
  const player_key = asString(p.player_key);
  const player_id = asString(p.player_id);
  if (!player_key || !player_id) return null;
  const nameRec = asRecord(p.name);
  const eligible = collectionEntries(p.eligible_positions)
    .map((e) => (typeof e === "string" ? e : asString(unwrap(e, "position"))))
    .filter((v): v is string => Boolean(v));
  const own = p.ownership ? mergeYahooEntity(p.ownership) : null;
  const bye = p.bye_weeks ? mergeYahooEntity(p.bye_weeks) : null;
  const waiver = own ? asString(own.waiver_date) : null;
  const injury = asString(p.status);
  return {
    player_id,
    player_key,
    name: (nameRec ? asString(nameRec.full) : null) ?? asString(p.name) ?? "Unknown Player",
    first_name: nameRec ? asString(nameRec.first) : null,
    last_name: nameRec ? asString(nameRec.last) : null,
    display_position: asString(p.display_position),
    eligible_positions: eligible,
    editorial_team_abbr: asString(p.editorial_team_abbr),
    status,
    availability: AVAILABILITY_BY_CODE[status],
    waiver_clear_date: waiver && waiver !== "0" ? waiver : null,
    bye_week: bye ? asNumber(bye.week) : null,
    injury_status: injury && injury !== "" ? injury : null,
    injury_note: asString(p.injury_note) || null,
    owner_team_key: own ? asString(own.owner_team_key) || null : null,
    ownership_type: own ? asString(own.ownership_type) : null,
  };
}

function parsePage(data: unknown, status: YahooAvailabilityCode): YahooPoolPlayer[] {
  const fc = fantasyContent(data);
  const league = mergeYahooEntity(fc?.league);
  const out: YahooPoolPlayer[] = [];
  for (const entry of collectionEntries(league.players)) {
    const row = parseYahooPoolPlayer(entry, status);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Retrieve one availability pool (FA, W or T) with pagination.
 * Throws `YahooApiError` on a Yahoo rejection (caller attaches diagnostics).
 */
export async function fetchPlayerPool(
  client: YahooFantasyClient,
  leagueKey: string,
  q: PoolQuery,
): Promise<PoolResult> {
  const maxPages = q.maxPages ?? YAHOO_PLAYERS_MAX_PAGES;
  let withOwnership = q.withOwnership ?? false;
  let ownershipFellBack = false;
  const requests: string[] = [];
  const players: YahooPoolPlayer[] = [];
  const seen = new Set<string>();
  let dropped_rostered = 0;
  let duplicates_dropped = 0;
  let pages = 0;
  let offset = q.start;
  let complete = false;
  let stopped: PoolResult["stopped_reason"] = "safety_limit";

  const wanted = q.count;

  const fetchPage = async (start: number, count: number) => {
    const path = buildPlayersPath(leagueKey, { status: q.status, position: q.position, search: q.search, start, count }, withOwnership);
    requests.push(path);
    const { data } = await client.get(path);
    return parsePage(data, q.status);
  };

  while (pages < maxPages) {
    if (q.deadlineMs && Date.now() > q.deadlineMs) {
      stopped = "deadline";
      break;
    }
    // Plan one wave of page requests.
    const remaining = wanted === null ? Infinity : wanted - players.length;
    if (remaining <= 0) {
      stopped = "count_reached";
      break;
    }
    const wave: Array<{ start: number; count: number }> = [];
    let cursor = offset;
    let left = remaining;
    while (wave.length < WAVE && left > 0 && pages + wave.length < maxPages) {
      const count = Math.min(YAHOO_PLAYERS_PAGE_SIZE, left);
      wave.push({ start: cursor, count });
      cursor += count;
      left -= count;
    }

    let results: YahooPoolPlayer[][];
    try {
      results = await Promise.all(wave.map((w) => fetchPage(w.start, w.count)));
    } catch (err) {
      // The ownership sub-resource is an enrichment; if Yahoo rejects it with a
      // 4xx, retry the same wave without it rather than losing the pool.
      if (withOwnership && err instanceof YahooApiError && err.httpStatus !== null && err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 401 && err.httpStatus !== 403 && err.httpStatus !== 429) {
        withOwnership = false;
        ownershipFellBack = true;
        results = await Promise.all(wave.map((w) => fetchPage(w.start, w.count)));
      } else {
        throw err;
      }
    }
    pages += wave.length;

    let ended = false;
    for (let i = 0; i < wave.length; i++) {
      const rows = results[i] ?? [];
      for (const row of rows) {
        if (seen.has(row.player_key)) {
          duplicates_dropped++;
          continue;
        }
        // An FA/W query must never yield a rostered player; trust Yahoo's ownership if present.
        if (q.status !== "T" && row.ownership_type === "team") {
          dropped_rostered++;
          continue;
        }
        seen.add(row.player_key);
        players.push(row);
      }
      // A short page (fewer rows than requested) means Yahoo ran out of players.
      if (rows.length < (wave[i]?.count ?? 0)) {
        ended = true;
        break;
      }
    }
    offset = cursor;
    if (ended) {
      complete = true;
      stopped = "end_of_pool";
      break;
    }
    if (wanted !== null && players.length >= wanted) {
      stopped = "count_reached";
      break;
    }
    if (pages >= maxPages) {
      stopped = "safety_limit";
      break;
    }
  }

  return {
    status: q.status,
    players,
    pages_fetched: pages,
    requests,
    complete,
    next_start: complete ? null : offset,
    stopped_reason: stopped,
    ownership: ownershipFellBack ? "unavailable_fell_back" : q.withOwnership ? "requested" : "not_requested",
    dropped_rostered,
    duplicates_dropped,
  };
}

/**
 * Look up specific players by key (any availability) and classify each from the
 * ownership sub-resource: freeagents -> FA, waivers -> W, team -> T.
 */
export async function fetchPlayersWithOwnership(
  client: YahooFantasyClient,
  leagueKey: string,
  playerKeys: string[],
): Promise<{ players: YahooPoolPlayer[]; requests: string[]; unclassified: string[] }> {
  const players: YahooPoolPlayer[] = [];
  const requests: string[] = [];
  const unclassified: string[] = [];
  const keys = [...new Set(playerKeys)];
  for (let i = 0; i < keys.length; i += YAHOO_PLAYERS_PAGE_SIZE) {
    const batch = keys.slice(i, i + YAHOO_PLAYERS_PAGE_SIZE);
    const groups: string[][] = [batch];
    for (let g = 0; g < groups.length; g++) {
      const keysInGroup = groups[g] as string[];
      const path = buildPlayersPath(leagueKey, { start: 0, count: keysInGroup.length, playerKeys: keysInGroup }, true);
      requests.push(path);
      let data: unknown;
      try {
        ({ data } = await client.get(path));
      } catch (err) {
        // Yahoo rejects the WHOLE request (HTTP 400) if any one key does not exist.
        // Retry one key at a time so valid players still resolve; unknown keys are reported.
        if (err instanceof YahooApiError && err.httpStatus === 400) {
          if (keysInGroup.length > 1) {
            for (const k of keysInGroup) groups.push([k]);
          } else {
            unclassified.push(keysInGroup[0] as string);
          }
          continue;
        }
        throw err;
      }
      const fc = fantasyContent(data);
      const league = mergeYahooEntity(fc?.league);
      for (const entry of collectionEntries(league.players)) {
        const probe = parseYahooPoolPlayer(entry, "FA");
        if (!probe) continue;
        const code = classifyOwnership(probe.ownership_type);
        if (!code) {
          unclassified.push(probe.player_key);
          continue;
        }
        players.push({ ...probe, status: code, availability: AVAILABILITY_BY_CODE[code] });
      }
    }
  }
  return { players, requests, unclassified };
}

export function classifyOwnership(type: string | null): YahooAvailabilityCode | null {
  switch ((type ?? "").toLowerCase()) {
    case "freeagents":
      return "FA";
    case "waivers":
      return "W";
    case "team":
      return "T";
    default:
      return null;
  }
}

export type YahooPoolSelector = "available" | "FA" | "W" | "rostered" | "all";

export interface LeaguePoolQuery {
  status: YahooPoolSelector;
  position?: string | null;
  search?: string | null;
  start?: number;
  /** Players wanted per pool; null = paginate to the end of each pool. */
  count: number | null;
  maxPages?: number;
  deadlineMs?: number;
}

export interface LeaguePoolResult {
  players: YahooPoolPlayer[];
  pools: PoolResult[];
  /** True only when every queried pool was read to Yahoo's end-of-pool signal. */
  complete: boolean;
}

/** Availability codes queried for a selector. `available` = FA + W (never rostered). */
export function codesForSelector(status: YahooPoolSelector): YahooAvailabilityCode[] {
  switch (status) {
    case "available":
      return ["FA", "W"];
    case "rostered":
      return ["T"];
    case "all":
      return ["FA", "W", "T"];
    default:
      return [status];
  }
}

/**
 * Query one or more availability pools (concurrently) and merge them, deduping by
 * player_key. Waiver (W) and rostered (T) pools request the ownership sub-resource
 * so waiver dates / owners come through. All paging is delegated to `fetchPlayerPool`.
 */
export async function fetchLeaguePlayerPools(
  client: YahooFantasyClient,
  leagueKey: string,
  q: LeaguePoolQuery,
): Promise<LeaguePoolResult> {
  const pools = await Promise.all(
    codesForSelector(q.status).map((code) =>
      fetchPlayerPool(client, leagueKey, {
        status: code,
        position: q.position,
        search: q.search,
        start: q.start ?? 0,
        count: q.count,
        maxPages: q.maxPages,
        deadlineMs: q.deadlineMs,
        withOwnership: code === "W" || code === "T",
      }),
    ),
  );
  const seen = new Set<string>();
  const players: YahooPoolPlayer[] = [];
  for (const pool of pools) {
    for (const p of pool.players) {
      if (seen.has(p.player_key)) continue;
      seen.add(p.player_key);
      players.push(p);
    }
  }
  return { players, pools, complete: pools.every((p) => p.complete) };
}
