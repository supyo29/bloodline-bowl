/**
 * YahooProvider — live authenticated fetch/flatten/canonical implementation.
 *
 * Every data method:
 *   1. Confirms OAuth health (`#authStatus`) — `NOT_CONFIGURED` / `AUTH_REQUIRED`
 *      / `PROVIDER_ERROR` (unhealthy token) exactly as before.
 *   2. Resolves the CURRENT season's NFL game key live (`games.ts` —
 *      `YAHOO_GAME_KEY` is only ever a last-resort fallback if the live call
 *      itself fails; a successful resolution always wins).
 *   3. Builds `{game_key}.l.{external_league_id}` and probes it
 *      (`discovery.ts#probeLeague`) — an inaccessible league (Yahoo 403/404)
 *      fails closed with the real classification, never a fabricated READY.
 *   4. Fetches + flattens the requested resource (`./fetch.ts`) through the
 *      shared `YahooFantasyClient`.
 *   5. Converts the flattened shape to canonical entities (`./canonical.ts`) —
 *      the SAME conversion `test/provider-normalization.test.ts` already
 *      exercises against a fixture.
 *
 * Nothing here fabricates a capability: a step that fails returns the specific
 * degraded `ProviderResult` for what actually happened.
 */

import { leagueId, teamId } from "@/lib/canonical/ids";
import { canonicalPosition } from "@/lib/canonical/players";
import type {
  CanonicalDraftPick,
  CanonicalLeague,
  CanonicalManager,
  CanonicalMatchup,
  CanonicalRoster,
  CanonicalStanding,
  CanonicalTransaction,
  CanonicalWaiverState,
} from "@/lib/canonical/schema";
import {
  degraded,
  ok,
  type CanonicalLeagueStateBundle,
  type FantasyProvider,
  type ProviderCapabilities,
  type ProviderHealth,
  type ProviderLeagueContext,
  type ProviderResult,
  type TransactionQuery,
} from "../types";
import { yahooBundleToCanonical, yahooMatchupsToCanonical, type YahooFlatBundle } from "./canonical";
import { loadYahooConfig, type YahooConfig } from "./config";
import { YahooApiError, YahooFantasyClient } from "./client";
import { probeLeague } from "./discovery";
import {
  fetchYahooLeagueBundle,
  fetchYahooPlayersByKeys,
  fetchYahooScoreboard,
  fetchYahooTeamsAndStandings,
  fetchYahooTransactions,
} from "./fetch";
import { resolveNflGameKey } from "./games";
import { fetchYahooGameWeeks, weekFilterIsAuthoritative, weekForTimestamp, type YahooGameWeek } from "./game-weeks";
import {
  YAHOO_PLAYERS_PAGE_SIZE,
  fetchLeaguePlayerPools,
  sanitizePosition,
  type PoolResult,
  type YahooPoolPlayer,
  type YahooPoolSelector,
} from "./players";
import {
  InMemoryYahooTokenStore,
  getValidAccessToken,
  type YahooTokenStore,
} from "./oauth";
import { resolveYahooTokenStore } from "./token-store";

export interface YahooProviderOptions {
  env?: NodeJS.ProcessEnv;
  tokenStore?: YahooTokenStore;
  /** Durable OAuth connection id. Defaults to the legacy/certified "primary". */
  connectionId?: string;
}

const POOL_TIME_BUDGET_MS = 48_000;

export interface AvailablePlayersQuery {
  status?: YahooPoolSelector;
  position?: string | null;
  search?: string | null;
  start?: number;
  count?: number;
  /** Paginate each pool to Yahoo's end-of-pool signal (bounded by the players.ts safety limit). */
  all?: boolean;
}

export interface YahooAvailablePlayers {
  league_key: string;
  status: YahooPoolSelector;
  players: YahooPoolPlayer[];
  pools: Array<Omit<PoolResult, "players" | "requests">>;
  complete: boolean;
}

function summarizePool(p: PoolResult): Omit<PoolResult, "players" | "requests"> {
  const { players: _players, requests: _requests, ...rest } = p;
  void _players;
  void _requests;
  return rest;
}

function describe(error: unknown): string {
  return error instanceof YahooApiError || error instanceof Error ? error.message : String(error);
}

/** Map a classified `YahooApiError` to the honest degraded envelope. */
function mapYahooError<T>(error: unknown, resource: string): ProviderResult<T> {
  if (error instanceof YahooApiError) {
    switch (error.kind) {
      case "NOT_CONNECTED":
        return degraded("AUTH_REQUIRED", "yahoo_auth_required", "Yahoo is configured but no account is connected.");
      case "AUTH":
        return degraded("AUTH_REQUIRED", "yahoo_token_unhealthy", `Yahoo authentication failed fetching ${resource}: ${error.message}`);
      case "FORBIDDEN":
        return degraded("AUTH_REQUIRED", "yahoo_forbidden", `The authenticated Yahoo account cannot access ${resource} (HTTP 403).`);
      case "NOT_FOUND":
        return degraded("PROVIDER_ERROR", "yahoo_not_found", `Yahoo returned 404 for ${resource}.`);
      case "RATE_LIMITED":
        return degraded("PROVIDER_ERROR", "yahoo_rate_limited", `Yahoo rate-limited this request for ${resource}.`);
      case "SERVER":
        return degraded("PROVIDER_ERROR", "yahoo_server_error", `Yahoo returned a server error fetching ${resource}: ${error.message}`);
      case "MALFORMED":
        return degraded("PROVIDER_ERROR", "yahoo_malformed_response", `Yahoo response for ${resource} could not be parsed: ${error.message}`);
      case "TIMEOUT":
        return degraded("PROVIDER_ERROR", "yahoo_timeout", `Yahoo request for ${resource} timed out.`);
      case "NETWORK":
        return degraded("PROVIDER_ERROR", "yahoo_network_error", `Network error fetching ${resource} from Yahoo: ${error.message}`);
    }
  }
  return degraded("PROVIDER_ERROR", "yahoo_upstream_error", `${resource}: ${describe(error)}`);
}

interface ResolvedYahooLeague {
  client: YahooFantasyClient;
  leagueKey: string;
  gameKey: string;
  leagueName: string;
}

export class YahooProvider implements FantasyProvider {
  readonly name = "yahoo" as const;
  readonly authentication = "OAUTH" as const;

  #env: NodeJS.ProcessEnv;
  #tokenStore: YahooTokenStore;
  #connectionId: string;

  constructor(opts: YahooProviderOptions = {}) {
    this.#env = opts.env ?? process.env;
    this.#connectionId = opts.connectionId?.trim() || "primary";
    if (opts.tokenStore) {
      this.#tokenStore = opts.tokenStore;
    } else {
      // Use the durable Supabase-backed store when the environment supports it;
      // otherwise an in-memory store (which simply reads as "not connected").
      const resolved = resolveYahooTokenStore(this.#env, {
        allowMemoryFallback: true,
        connectionId: this.#connectionId,
      });
      this.#tokenStore = resolved.ok ? resolved.store : new InMemoryYahooTokenStore();
    }
  }

  capabilities(): ProviderCapabilities {
    // A capability is true only once it is implemented, normalized, and tested
    // (see `test/yahoo-fetch.test.ts` / `test/yahoo-players.test.ts` /
    // `test/yahoo-provider-availability.test.ts`). `free_agents` / `waivers` are
    // true because the Yahoo player pool (FA + W + rostered, with waiver dates) is
    // served via `getFreeAgents` / `getWaiverPlayers` / `getAvailablePlayers` and
    // `getWaiverState`, all backed by `./players.ts`.
    return {
      league: true,
      settings: true,
      managers: true,
      standings: true,
      rosters: true,
      matchups: true,
      transactions: true,
      players: true,
      free_agents: true,
      waivers: true,
      draft_results: true,
      live_authenticated_access: true,
    };
  }

  async #authStatus(): Promise<
    | { ok: true; accessToken: string; config: YahooConfig }
    | { ok: false; result: ProviderResult<never> }
  > {
    const cfg = loadYahooConfig(this.#env);
    if (!cfg.configured || !cfg.config) {
      return {
        ok: false,
        result: degraded(
          "NOT_CONFIGURED",
          "yahoo_not_configured",
          `Yahoo OAuth is not configured. Missing env: ${cfg.missing.join(", ")}.`,
        ),
      };
    }
    const result = await getValidAccessToken(cfg.config, this.#tokenStore).catch(
      () => ({ status: "REFRESH_FAILED" as const, access_token: null, token: null }),
    );
    if (result.status === "NOT_CONNECTED" || !result.access_token) {
      return {
        ok: false,
        result: degraded(
          result.status === "REFRESH_FAILED" ? "PROVIDER_ERROR" : "AUTH_REQUIRED",
          result.status === "REFRESH_FAILED" ? "yahoo_token_unhealthy" : "yahoo_auth_required",
          result.status === "REFRESH_FAILED"
            ? `Yahoo connection "${this.#connectionId}" has an unhealthy token. Re-authorize that connection.`
            : `Yahoo connection "${this.#connectionId}" is not authorized. Complete the Yahoo OAuth flow for this league/connection.`,
        ),
      };
    }
    return { ok: true, accessToken: result.access_token, config: cfg.config };
  }

  /**
   * Auth + live game-key resolution + league-key build + accessibility probe.
   * Every data method funnels through this before touching a league resource.
   */
  async #resolveLeague(
    ctx: Pick<ProviderLeagueContext, "league_slug" | "external_league_id" | "season">,
  ): Promise<{ ok: true; resolved: ResolvedYahooLeague } | { ok: false; result: ProviderResult<never> }> {
    const auth = await this.#authStatus();
    if (!auth.ok) return auth;

    const client = new YahooFantasyClient({ config: auth.config, store: this.#tokenStore });

    const gameKeyResult = await resolveNflGameKey(client, ctx.season, {
      overrideKey: auth.config.game_key_override,
    });
    if (!gameKeyResult.ok) {
      const code =
        gameKeyResult.kind === "API_ERROR" && gameKeyResult.error instanceof YahooApiError
          ? gameKeyResult.error
          : null;
      return {
        ok: false,
        result: code
          ? mapYahooError(code, `the ${ctx.season} NFL game key`)
          : degraded("PROVIDER_ERROR", "yahoo_game_key_unresolved", gameKeyResult.detail),
      };
    }

    const gameKey = gameKeyResult.game.game_key;
    const probe = await probeLeague(client, gameKey, ctx.external_league_id);
    if (!probe.accessible) {
      return {
        ok: false,
        result: degraded(
          probe.error_kind === "FORBIDDEN" || probe.error_kind === "NOT_FOUND" ? "AUTH_REQUIRED" : "PROVIDER_ERROR",
          "yahoo_league_inaccessible",
          `Yahoo league "${ctx.league_slug}" (${probe.league_key}) is not accessible to the connected account: ${probe.detail}`,
        ),
      };
    }
    // Integrity: the registry's numeric id must be the SAME league Yahoo actually
    // returned. `probeLeague` builds the key FROM that id, so a mismatch here
    // would mean Yahoo silently substituted another league — fail closed rather
    // than trust it.
    if (probe.league && probe.league.league_id !== ctx.external_league_id) {
      return {
        ok: false,
        result: degraded(
          "PROVIDER_ERROR",
          "yahoo_league_identity_mismatch",
          `Yahoo returned league id ${probe.league.league_id} ("${probe.league.name}") for the league key built from configured id ${ctx.external_league_id}; refusing to substitute.`,
        ),
      };
    }

    return {
      ok: true,
      resolved: { client, leagueKey: probe.league_key, gameKey, leagueName: probe.league?.name ?? ctx.league_slug },
    };
  }

  /**
   * Live per-league accessibility check — the piece `healthCheck()` (provider
   * account-level) and the static registry (`leagueConfigStatus`) cannot do:
   * "is THIS specific league reachable by the connected account, right now?"
   * Not part of `FantasyProvider` (Sleeper has no equivalent concept — every
   * public Sleeper league id is reachable) — callers that want it construct a
   * `YahooProvider` directly (see `/api/providers`).
   */
  async checkLeagueAccessibility(
    externalLeagueId: string,
    season: number,
  ): Promise<
    | { status: "NOT_CONFIGURED" | "AUTH_REQUIRED" | "PROVIDER_ERROR"; accessible: false; detail: string }
    | { status: "READY"; accessible: true; league_key: string; league_name: string }
  > {
    const resolved = await this.#resolveLeague({
      league_slug: `__probe__:${externalLeagueId}`,
      external_league_id: externalLeagueId,
      season,
    });
    if (!resolved.ok) {
      return {
        status: resolved.result.status === "NOT_CONFIGURED" || resolved.result.status === "AUTH_REQUIRED"
          ? resolved.result.status
          : "PROVIDER_ERROR",
        accessible: false,
        detail: resolved.result.warnings[0]?.message ?? "Yahoo league is not accessible.",
      };
    }
    // `#resolveLeague` already probed accessibility + the identity integrity
    // check above; no need to hit Yahoo a second time.
    return {
      status: "READY",
      accessible: true,
      league_key: resolved.resolved.leagueKey,
      league_name: resolved.resolved.leagueName,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const cfg = loadYahooConfig(this.#env);
    const base = {
      provider: this.name,
      authentication: this.authentication,
      checked_at: new Date().toISOString(),
    };
    if (!cfg.configured) {
      return {
        ...base,
        status: "NOT_CONFIGURED",
        detail: `Yahoo OAuth env not set (missing: ${cfg.missing.join(", ")}).`,
      };
    }
    let token;
    try {
      token = await this.#tokenStore.get();
    } catch (err) {
      return {
        ...base,
        status: "PROVIDER_ERROR",
        detail: `Yahoo token store unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!token) {
      return {
        ...base,
        status: "AUTH_REQUIRED",
        detail: `Yahoo app configured; connection "${this.#connectionId}" has no authorized account yet.`,
      };
    }
    if (cfg.config) {
      const check = await getValidAccessToken(cfg.config, this.#tokenStore).catch(
        () => ({ status: "REFRESH_FAILED" as const, access_token: null, token: null }),
      );
      if (check.status !== "OK") {
        return {
          ...base,
          status: "PROVIDER_ERROR",
          detail: `Yahoo account connected but token is unhealthy (${check.status}).`,
        };
      }
    }
    return {
      ...base,
      status: "READY",
      detail: `Yahoo app configured and connection "${this.#connectionId}" is authorized.`,
    };
  }

  async getLeagueState(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalLeagueStateBundle>> {
    const resolved = await this.#resolveLeague(ctx);
    if (!resolved.ok) return resolved.result;
    const { client, leagueKey } = resolved.resolved;

    const syncedAt = new Date().toISOString();
    let fetched;
    try {
      fetched = await fetchYahooLeagueBundle(client, leagueKey);
    } catch (error) {
      return mapYahooError(error, `league state for "${ctx.league_slug}"`);
    }

    if (fetched.bundle.league.league_id !== ctx.external_league_id) {
      return degraded(
        "PROVIDER_ERROR",
        "yahoo_league_identity_mismatch",
        `Yahoo league state for key ${leagueKey} reported league id ${fetched.bundle.league.league_id}, expected ${ctx.external_league_id}.`,
      );
    }

    await ctx.crosswalk.ensureLoaded();
    const canon = yahooBundleToCanonical(ctx.league_slug, fetched.bundle, ctx.crosswalk, syncedAt, fetched.draftResults);

    const warnings: ProviderResult<unknown>["warnings"] = [];
    if (canon.unresolved_players.length > 0) {
      warnings.push({
        code: "unresolved_player_identities",
        message: `${canon.unresolved_players.length} player id(s) could not be resolved to a stable identity; provider provenance is preserved on each.`,
      });
    }
    if (fetched.scoringWarnings.length > 0) {
      warnings.push({
        code: "unmapped_yahoo_scoring_stats",
        message: `${fetched.scoringWarnings.length} Yahoo scoring stat(s) (${fetched.scoringWarnings
          .map((w) => w.name ?? `stat_id ${w.stat_id}`)
          .join(", ")}) have no canonical mapping; preserved as yahoo_stat_<id> in raw_scoring and ignored by the scoring engine rather than misapplied.`,
      });
    }

    const bundle: CanonicalLeagueStateBundle = {
      league: canon.league,
      managers: canon.managers,
      teams: canon.teams,
      rosters: canon.rosters,
      standings: canon.standings,
      draft_picks: canon.draft_picks,
      players: canon.players,
      unresolved_players: canon.unresolved_players,
    };
    return ok(bundle, { warnings, provider_synced_at: syncedAt });
  }

  async getLeague(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalLeague>> {
    const state = await this.getLeagueState(ctx);
    if (!state.data) return degraded(state.status, "yahoo_league_unavailable", state.warnings[0]?.message ?? "unavailable");
    return ok(state.data.league, { warnings: state.warnings, provider_synced_at: state.provider_synced_at });
  }

  async getManagers(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalManager[]>> {
    const state = await this.getLeagueState(ctx);
    if (!state.data) return degraded(state.status, "yahoo_managers_unavailable", state.warnings[0]?.message ?? "unavailable");
    return ok(state.data.managers, { warnings: state.warnings, provider_synced_at: state.provider_synced_at });
  }

  async getStandings(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalStanding[]>> {
    const state = await this.getLeagueState(ctx);
    if (!state.data) return degraded(state.status, "yahoo_standings_unavailable", state.warnings[0]?.message ?? "unavailable");
    return ok(state.data.standings, { warnings: state.warnings, provider_synced_at: state.provider_synced_at });
  }

  async getRosters(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalRoster[]>> {
    const state = await this.getLeagueState(ctx);
    if (!state.data) return degraded(state.status, "yahoo_rosters_unavailable", state.warnings[0]?.message ?? "unavailable");
    return ok(state.data.rosters, { warnings: state.warnings, provider_synced_at: state.provider_synced_at });
  }

  async getDraftResults(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalDraftPick[]>> {
    const state = await this.getLeagueState(ctx);
    if (!state.data) return degraded(state.status, "yahoo_draft_unavailable", state.warnings[0]?.message ?? "unavailable");
    if (state.data.draft_picks.length === 0) {
      return degraded("PARTIAL" as const, "yahoo_draft_not_available", "Yahoo reported no draft results for this league (undrafted, or the account cannot read draftresults).") as ProviderResult<CanonicalDraftPick[]>;
    }
    return ok(state.data.draft_picks, { warnings: state.warnings, provider_synced_at: state.provider_synced_at });
  }

  async getMatchups(ctx: ProviderLeagueContext, week: number): Promise<ProviderResult<CanonicalMatchup[]>> {
    if (!Number.isInteger(week) || week < 1 || week > 22) {
      return degraded("PROVIDER_ERROR", "invalid_week", "week must be 1..22.");
    }
    const resolved = await this.#resolveLeague(ctx);
    if (!resolved.ok) return resolved.result;
    const { client, leagueKey } = resolved.resolved;
    try {
      const [teams, matchups] = await Promise.all([
        fetchYahooTeamsAndStandings(client, leagueKey),
        fetchYahooScoreboard(client, leagueKey, week),
      ]);
      const canon = yahooMatchupsToCanonical(ctx.league_slug, week, matchups, teams, new Date().toISOString());
      return ok(canon);
    } catch (error) {
      return mapYahooError(error, `week ${week} matchups for "${ctx.league_slug}"`);
    }
  }

  async getTransactions(
    ctx: ProviderLeagueContext,
    query: TransactionQuery = {},
  ): Promise<ProviderResult<CanonicalTransaction[]>> {
    const resolved = await this.#resolveLeague(ctx);
    if (!resolved.ok) return resolved.result;
    const { client, leagueKey, gameKey } = resolved.resolved;
    try {
      await ctx.crosswalk.ensureLoaded();
      const [teams, txResult] = await Promise.all([
        fetchYahooTeamsAndStandings(client, leagueKey),
        fetchYahooTransactions(client, leagueKey),
      ]);
      // Hydrate transaction-only player keys through Yahoo before canonical
      // conversion. A waiver/add/drop often references players who are not on
      // any current roster, so bare-key fallback would create avoidable
      // unresolved identities even though Yahoo can provide player metadata.
      const transactionPlayerKeys = [...new Set(
        txResult.transactions.flatMap((tx) => tx.players.map((p) => p.player_key)).filter(Boolean),
      )];
      const txPlayers = transactionPlayerKeys.length > 0
        ? await fetchYahooPlayersByKeys(client, transactionPlayerKeys)
        : new Map();

      const minimalBundle: YahooFlatBundle = {
        league: {
          league_key: leagueKey,
          league_id: ctx.external_league_id,
          name: ctx.league_slug,
          season: ctx.season,
          current_week: null,
          num_teams: teams.length,
          scoring_type: "head",
          stat_modifiers: {},
          roster_positions: [],
          playoff_start_week: null,
          num_playoff_teams: null,
          waiver_type: null,
          uses_faab: false,
        },
        teams,
        players: [...txPlayers.values()],
        transactions: txResult.transactions,
      };
      const canon = yahooBundleToCanonical(ctx.league_slug, minimalBundle, ctx.crosswalk, new Date().toISOString());
      // Yahoo transactions carry a timestamp but no fantasy-week field; stamp the
      // week from Yahoo's own game-week calendar (best effort, never fatal).
      let weeks: YahooGameWeek[] = [];
      try {
        weeks = await fetchYahooGameWeeks(client, gameKey);
      } catch {
        weeks = [];
      }
      const tsSeconds = (t: { provider_timestamp: string | null }) =>
        t.provider_timestamp ? Date.parse(t.provider_timestamp) / 1000 : Number.NaN;
      let transactions = canon.transactions.map((t) =>
        t.fantasy_week != null ? t : { ...t, fantasy_week: weekForTimestamp(weeks, tsSeconds(t)) },
      );

      const warnings: ProviderResult<unknown>["warnings"] = [];
      if (query.week != null) {
        const authoritative = weekFilterIsAuthoritative(
          weeks,
          query.week,
          transactions.map((t) => ({ fantasy_week: t.fantasy_week, timestamp_seconds: tsSeconds(t) })),
        );
        if (authoritative) {
          transactions = transactions.filter((t) => t.fantasy_week === query.week);
        } else {
          // Calendar unavailable, or a transaction falls outside every Yahoo
          // week window: do not turn an unverifiable week filter into a false
          // empty/partial result. Return the recent feed and say so.
          warnings.push({
            code: "week_transactions_unavailable",
            message:
              `Yahoo transaction weeks could not be fully resolved from Yahoo's game-week calendar; returned recent transactions without applying week=${query.week}. ` +
              "Do not treat this result as authoritative current-week transaction history.",
          });
        }
      }
      if (query.limit && transactions.length > query.limit) transactions = transactions.slice(0, query.limit);
      if (canon.unresolved_players.length > 0) {
        warnings.push({
          code: "unresolved_player_identities",
          message: `${canon.unresolved_players.length} transaction player id(s) could not be resolved; provider provenance preserved.`,
        });
      }
      if (txResult.truncated) {
        warnings.push({
          code: "transaction_pagination_capped",
          message: "Yahoo transaction pagination hit the safety cap before a short page was returned; some older transactions may be missing.",
        });
      }
      return ok(transactions, { warnings, provider_synced_at: new Date().toISOString() });
    } catch (error) {
      return mapYahooError(error, `transactions for "${ctx.league_slug}"`);
    }
  }

  /**
   * Provider-level read of Yahoo's league player pool (FA / W / available /
   * rostered). Thin wrapper over `./players.ts` — all Yahoo querying, paging and
   * parsing lives there. NOT part of `FantasyProvider` (Yahoo-specific, like
   * `checkLeagueAccessibility`).
   */
  async getAvailablePlayers(
    ctx: ProviderLeagueContext,
    query: AvailablePlayersQuery = {},
  ): Promise<ProviderResult<YahooAvailablePlayers>> {
    const resolved = await this.#resolveLeague(ctx);
    if (!resolved.ok) return resolved.result;
    const { client, leagueKey } = resolved.resolved;
    const status = query.status ?? "available";
    const position = sanitizePosition(query.position);
    if (query.position && !position) {
      return degraded("PROVIDER_ERROR", "yahoo_invalid_position", `position "${query.position}" is not valid.`);
    }
    try {
      const pool = await fetchLeaguePlayerPools(client, leagueKey, {
        status,
        position,
        search: query.search?.trim() || null,
        start: query.start ?? 0,
        count: query.all ? null : (query.count ?? YAHOO_PLAYERS_PAGE_SIZE),
        deadlineMs: Date.now() + POOL_TIME_BUDGET_MS,
      });
      const warnings: ProviderResult<unknown>["warnings"] = [];
      if (!pool.complete) {
        warnings.push({
          code: "yahoo_pool_incomplete",
          message: "At least one Yahoo pool was not read to its end (count, safety limit or time budget); see pools[].next_start.",
        });
      }
      return ok(
        { league_key: leagueKey, status, players: pool.players, pools: pool.pools.map(summarizePool), complete: pool.complete },
        { warnings, status: "READY" },
      );
    } catch (error) {
      return mapYahooError(error, `the ${status} player pool for "${ctx.league_slug}"`);
    }
  }

  getFreeAgents(ctx: ProviderLeagueContext, query: Omit<AvailablePlayersQuery, "status"> = {}) {
    return this.getAvailablePlayers(ctx, { ...query, status: "FA" });
  }

  getWaiverPlayers(ctx: ProviderLeagueContext, query: Omit<AvailablePlayersQuery, "status"> = {}) {
    return this.getAvailablePlayers(ctx, { ...query, status: "W" });
  }

  /**
   * Per-player availability in THIS league: free agents, waiver players (with
   * Yahoo's waiver date) and rostered players (with owning team).
   *
   * Contract decision: `CanonicalWaiverState` is "per-player availability in this
   * league" with `free_agent` / `waiver` / `rostered` ownership, so the complete
   * pool is materialized (Rogers Park: ~1,000 unrostered + ~155 rostered, ~50
   * requests in concurrent waves). Nothing in production calls this per request
   * (the snapshot's `waiver_state` stays null), so cost is paid only by explicit
   * callers; narrower reads should use `getAvailablePlayers`. If any pool is cut
   * short (safety limit / time budget) the result is PARTIAL with a
   * `yahoo_pool_incomplete` warning rather than a plausible-looking full pool.
   */
  async getWaiverState(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalWaiverState>> {
    const resolved = await this.#resolveLeague(ctx);
    if (!resolved.ok) return resolved.result;
    const { client, leagueKey } = resolved.resolved;

    let pool;
    try {
      pool = await fetchLeaguePlayerPools(client, leagueKey, {
        status: "all",
        count: null,
        deadlineMs: Date.now() + POOL_TIME_BUDGET_MS,
      });
    } catch (error) {
      return mapYahooError(error, `waiver state for "${ctx.league_slug}"`);
    }

    await ctx.crosswalk.ensureLoaded();
    const syncedAt = new Date().toISOString();
    let unresolved = 0;
    const players: CanonicalWaiverState["players"] = pool.players.map((yp) => {
      const { player, unresolved: u } = ctx.crosswalk.resolve({
        provider: "yahoo",
        provider_player_id: yp.player_key,
        full_name: yp.name,
        first_name: yp.first_name,
        last_name: yp.last_name,
        position: yp.display_position,
        nfl_team: yp.editorial_team_abbr,
        status: yp.injury_status,
        eligible_positions: yp.eligible_positions,
        known_identifiers: { yahoo_id: yp.player_id, yahoo_player_key: yp.player_key },
      });
      if (u) unresolved += 1;
      const ownerTeam = yp.owner_team_key?.split(".t.")[1];
      return {
        canonical_player_id: player.canonical_player_id,
        ownership: yp.status === "FA" ? "free_agent" : yp.status === "W" ? "waiver" : "rostered",
        canonical_team_id: yp.status === "T" && ownerTeam ? teamId(ctx.league_slug, ownerTeam) : null,
        // Yahoo exposes a date (YYYY-MM-DD), not a time; passed through verbatim.
        waiver_clears_at: yp.status === "W" ? yp.waiver_clear_date : null,
        provider_player_id: yp.player_id,
        injury_status: yp.injury_status,
      };
    });

    const warnings: ProviderResult<unknown>["warnings"] = [];
    if (!pool.complete) {
      warnings.push({
        code: "yahoo_pool_incomplete",
        message: "The Yahoo player pool was not read to its end (safety limit or time budget); availability is partial.",
      });
    }
    if (unresolved > 0) {
      warnings.push({
        code: "unresolved_player_identities",
        message: `${unresolved} player id(s) could not be resolved to a stable identity; provider ids are preserved on each row.`,
      });
    }
    return ok(
      {
        canonical_league_id: leagueId(ctx.league_slug),
        league_slug: ctx.league_slug,
        players,
        provenance: { provider: "yahoo", provider_id: ctx.external_league_id, provider_synced_at: syncedAt },
      },
      { warnings, provider_synced_at: syncedAt },
    );
  }
}

// Referenced so the canonical position map is part of the Yahoo module graph.
void canonicalPosition;
