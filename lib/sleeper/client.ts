/**
 * Minimal read-only client for the Sleeper public API.
 *
 * Two caching layers are in play:
 *
 *  1. Small resources (league, users, rosters, drafts, picks, state) go through
 *     Next's data cache via `next.revalidate`, so a warm deployment serves them
 *     without touching Sleeper.
 *  2. The `/players/nfl` dump (~14MB, ~12k players) is far too large for the
 *     data cache (2MB/entry limit), so it is fetched with `no-store`, trimmed
 *     down immediately, and held in a module-scoped map for the lifetime of the
 *     serverless instance. Sleeper's docs ask that this endpoint be called "once
 *     per day at most", which the 24h TTL respects.
 */

import type {
  RawDraft,
  RawDraftPick,
  RawLeague,
  RawLeagueUser,
  RawNflState,
  RawPlayer,
  RawRoster,
  RawTradedPick,
  NormalizedPlayer,
} from "./types";

export const SLEEPER_BASE_URL = "https://api.sleeper.app/v1";

/** Sleeper data changes slowly; five minutes is plenty fresh for analysis. */
export const CORE_REVALIDATE_SECONDS = 300;
/** Sleeper explicitly asks for at most one player-database call per day. */
export const PLAYER_DB_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_TIMEOUT_MS = 10_000;
/** The player dump is large and slow; give it substantially more room. */
const PLAYER_DB_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;

export class SleeperError extends Error {
  readonly status: number;
  readonly resource: string;

  constructor(message: string, resource: string, status: number) {
    super(message);
    this.name = "SleeperError";
    this.resource = resource;
    this.status = status;
  }
}

interface FetchOptions {
  /** Seconds to keep the response in Next's data cache. */
  revalidate?: number;
  timeoutMs?: number;
  /** Bypass the data cache entirely (used for the oversized player dump). */
  noStore?: boolean;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a Sleeper resource as JSON, retrying transient failures with backoff.
 * Throws `SleeperError` on non-retryable failures or exhausted retries.
 */
export async function fetchSleeper<T>(
  path: string,
  options: FetchOptions = {},
): Promise<T> {
  const {
    revalidate = CORE_REVALIDATE_SECONDS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    noStore = false,
  } = options;

  const url = `${SLEEPER_BASE_URL}${path}`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        ...(noStore
          ? { cache: "no-store" as const }
          : { next: { revalidate } }),
      });

      if (!response.ok) {
        // Sleeper returns 404 for things like a league with no drafts.
        if (!isRetryableStatus(response.status)) {
          throw new SleeperError(
            `Sleeper returned ${response.status} for ${path}`,
            path,
            response.status,
          );
        }
        lastError = new SleeperError(
          `Sleeper returned ${response.status} for ${path}`,
          path,
          response.status,
        );
      } else {
        try {
          return (await response.json()) as T;
        } catch {
          throw new SleeperError(
            `Sleeper returned a malformed JSON body for ${path}`,
            path,
            502,
          );
        }
      }
    } catch (error) {
      // A non-retryable SleeperError should propagate immediately.
      if (error instanceof SleeperError && !isRetryableStatus(error.status)) {
        clearTimeout(timer);
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        lastError = new SleeperError(
          `Request to ${path} timed out after ${timeoutMs}ms`,
          path,
          504,
        );
      } else if (error instanceof Error) {
        lastError = error;
      } else {
        lastError = new Error(String(error));
      }
    } finally {
      clearTimeout(timer);
    }

    if (attempt < MAX_RETRIES) {
      await sleep(250 * 2 ** attempt);
    }
  }

  throw lastError instanceof SleeperError
    ? lastError
    : new SleeperError(
        `Failed to fetch ${path}: ${lastError?.message ?? "unknown error"}`,
        path,
        502,
      );
}

/* -------------------------------------------------------------------------- */
/* Resource helpers                                                            */
/* -------------------------------------------------------------------------- */

export function getNflState(): Promise<RawNflState> {
  return fetchSleeper<RawNflState>("/state/nfl");
}

export function getLeague(leagueId: string): Promise<RawLeague> {
  return fetchSleeper<RawLeague>(`/league/${leagueId}`);
}

export function getLeagueUsers(leagueId: string): Promise<RawLeagueUser[]> {
  return fetchSleeper<RawLeagueUser[]>(`/league/${leagueId}/users`);
}

export function getLeagueRosters(leagueId: string): Promise<RawRoster[]> {
  return fetchSleeper<RawRoster[]>(`/league/${leagueId}/rosters`);
}

export function getLeagueDrafts(leagueId: string): Promise<RawDraft[]> {
  return fetchSleeper<RawDraft[]>(`/league/${leagueId}/drafts`);
}

export function getLeagueTradedPicks(
  leagueId: string,
): Promise<RawTradedPick[]> {
  return fetchSleeper<RawTradedPick[]>(`/league/${leagueId}/traded_picks`);
}

export function getDraftPicks(draftId: string): Promise<RawDraftPick[]> {
  return fetchSleeper<RawDraftPick[]>(`/draft/${draftId}/picks`);
}

/* -------------------------------------------------------------------------- */
/* Player database                                                             */
/* -------------------------------------------------------------------------- */

/** Trimmed player index: `player_id` -> slim player record. */
export type PlayerIndex = ReadonlyMap<string, NormalizedPlayer>;

interface PlayerCacheEntry {
  index: Map<string, NormalizedPlayer>;
  fetchedAt: number;
}

/**
 * Module scope survives across invocations on a warm serverless instance, so
 * most requests reuse this index rather than re-downloading 14MB from Sleeper.
 */
let playerCache: PlayerCacheEntry | null = null;
/** De-duplicates concurrent cold-start fetches into a single upstream request. */
let inFlightPlayerFetch: Promise<Map<string, NormalizedPlayer>> | null = null;

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reduce a raw Sleeper player to the handful of fields worth serving.
 * Sleeper carries ~45 fields per player (external ids, high school, birth city,
 * practice notes); keeping all of them would bloat the response for no benefit.
 */
export function slimPlayer(
  playerId: string,
  raw: RawPlayer | undefined,
): NormalizedPlayer {
  if (!raw) {
    return {
      player_id: playerId,
      full_name: `Unknown player (${playerId})`,
      first_name: null,
      last_name: null,
      position: null,
      fantasy_positions: [],
      team: null,
      age: null,
      years_exp: null,
      status: null,
      injury_status: null,
      number: null,
      resolved: false,
    };
  }

  const firstName = toNullableString(raw.first_name);
  const lastName = toNullableString(raw.last_name);
  // Team defenses have a null `full_name` but do carry first/last names
  // ("Houston" / "Texans"), so composing them yields a better label than the id.
  const fullName =
    toNullableString(raw.full_name) ??
    [firstName, lastName].filter(Boolean).join(" ");

  return {
    player_id: playerId,
    // Team defenses have no first/last name, so fall back to the id (e.g. "MIN").
    full_name: fullName.length > 0 ? fullName : playerId,
    first_name: firstName,
    last_name: lastName,
    position: toNullableString(raw.position),
    fantasy_positions: Array.isArray(raw.fantasy_positions)
      ? raw.fantasy_positions.filter(
          (position): position is string => typeof position === "string",
        )
      : [],
    team: toNullableString(raw.team),
    age: toNullableNumber(raw.age),
    years_exp: toNullableNumber(raw.years_exp),
    status: toNullableString(raw.status),
    injury_status: toNullableString(raw.injury_status),
    number: toNullableNumber(raw.number),
    resolved: true,
  };
}

async function downloadPlayerIndex(): Promise<Map<string, NormalizedPlayer>> {
  const raw = await fetchSleeper<Record<string, RawPlayer>>("/players/nfl", {
    noStore: true,
    timeoutMs: PLAYER_DB_TIMEOUT_MS,
  });

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SleeperError(
      "Sleeper player database had an unexpected shape",
      "/players/nfl",
      502,
    );
  }

  const index = new Map<string, NormalizedPlayer>();
  for (const [playerId, player] of Object.entries(raw)) {
    index.set(playerId, slimPlayer(playerId, player));
  }
  return index;
}

/**
 * Return the trimmed player index, downloading it only when the cache is cold
 * or older than {@link PLAYER_DB_TTL_MS}.
 */
export async function getPlayerIndex(): Promise<PlayerIndex> {
  const now = Date.now();
  if (playerCache && now - playerCache.fetchedAt < PLAYER_DB_TTL_MS) {
    return playerCache.index;
  }

  if (inFlightPlayerFetch) {
    return inFlightPlayerFetch;
  }

  inFlightPlayerFetch = downloadPlayerIndex()
    .then((index) => {
      playerCache = { index, fetchedAt: Date.now() };
      return index;
    })
    .finally(() => {
      inFlightPlayerFetch = null;
    });

  try {
    return await inFlightPlayerFetch;
  } catch (error) {
    // Serving a stale index beats failing the whole request.
    if (playerCache) {
      return playerCache.index;
    }
    throw error;
  }
}

/** Cache diagnostics for the health endpoint. */
export function getPlayerCacheStatus(): {
  cached: boolean;
  player_count: number;
  age_seconds: number | null;
} {
  if (!playerCache) {
    return { cached: false, player_count: 0, age_seconds: null };
  }
  return {
    cached: true,
    player_count: playerCache.index.size,
    age_seconds: Math.round((Date.now() - playerCache.fetchedAt) / 1000),
  };
}
