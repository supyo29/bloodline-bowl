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
  fetchYahooScoreboard,
  fetchYahooTeamsAndStandings,
  fetchYahooTransactions,
} from "./fetch";
import { resolveNflGameKey } from "./games";
import {
  InMemoryYahooTokenStore,
  getValidAccessToken,
  type YahooTokenStore,
} from "./oauth";
import { resolveYahooTokenStore } from "./token-store";

export interface YahooProviderOptions {
  env?: NodeJS.ProcessEnv;
  tokenStore?: YahooTokenStore;
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
}

export class YahooProvider implements FantasyProvider {
  readonly name = "yahoo" as const;
  readonly authentication = "OAUTH" as const;

  #env: NodeJS.ProcessEnv;
  #tokenStore: YahooTokenStore;

  constructor(opts: YahooProviderOptions = {}) {
    this.#env = opts.env ?? process.env;
    if (opts.tokenStore) {
      this.#tokenStore = opts.tokenStore;
    } else {
      // Use the durable Supabase-backed store when the environment supports it;
      // otherwise an in-memory store (which simply reads as "not connected").
      const resolved = resolveYahooTokenStore(this.#env, { allowMemoryFallback: true });
      this.#tokenStore = resolved.ok ? resolved.store : new InMemoryYahooTokenStore();
    }
  }

  capabilities(): ProviderCapabilities {
    // A capability is true only once it is implemented, normalized, and tested
    // (see `test/yahoo-fetch.test.ts` / `test/yahoo-provider.test.ts`). Full
    // free-agent pool materialization is NOT implemented (see `getWaiverState`),
    // so `free_agents` stays false rather than a fabricated true.
    return {
      league: true,
      settings: true,
      managers: true,
      standings: true,
      rosters: true,
      matchups: true,
      transactions: true,
      players: true,
      free_agents: false,
      waivers: false,
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
            ? "Yahoo account connected but its token could not be refreshed. Re-authorize via /api/yahoo/auth/start."
            : "Yahoo is configured but no account is connected. Complete /api/yahoo/auth/start.",
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
    ctx: ProviderLeagueContext,
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

    return { ok: true, resolved: { client, leagueKey: probe.league_key, gameKey } };
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
        detail: "Yahoo app configured; no account connected yet.",
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
      detail: "Yahoo app configured and an account is connected.",
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
    const { client, leagueKey } = resolved.resolved;
    try {
      await ctx.crosswalk.ensureLoaded();
      const [teams, txResult] = await Promise.all([
        fetchYahooTeamsAndStandings(client, leagueKey),
        fetchYahooTransactions(client, leagueKey),
      ]);
      // Reuse the SAME bundle->canonical conversion (and its player-crosswalk
      // resolution) with an empty roster/player set — transaction-only player
      // keys resolve through `resolveYahooKey`'s crosswalk fallback exactly as
      // they would inside the full league-state bundle.
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
        players: [],
        transactions: txResult.transactions,
      };
      const canon = yahooBundleToCanonical(ctx.league_slug, minimalBundle, ctx.crosswalk, new Date().toISOString());
      let transactions = canon.transactions;
      if (query.week != null) transactions = transactions.filter((t) => t.fantasy_week === query.week);
      if (query.limit && transactions.length > query.limit) transactions = transactions.slice(0, query.limit);

      const warnings: ProviderResult<unknown>["warnings"] = [];
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

  async getWaiverState(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalWaiverState>> {
    // Conservative, same contract as Sleeper: only rostered ownership is
    // reported (derived from the live league state). Yahoo's full free-agent
    // pool is NOT materialized in this phase — `capabilities().free_agents` and
    // `.waivers` are honestly `false`, and this always returns PARTIAL.
    const state = await this.getLeagueState(ctx);
    if (!state.data) {
      return degraded(state.status, "yahoo_waiver_state_unavailable", state.warnings[0]?.message ?? "unavailable");
    }
    const players: CanonicalWaiverState["players"] = [];
    for (const roster of state.data.rosters) {
      for (const pid of roster.all_players) {
        players.push({ canonical_player_id: pid, ownership: "rostered", canonical_team_id: roster.canonical_team_id, waiver_clears_at: null });
      }
    }
    return ok(
      {
        canonical_league_id: state.data.league.canonical_league_id,
        league_slug: ctx.league_slug,
        players,
        provenance: { provider: "yahoo", provider_id: ctx.external_league_id, provider_synced_at: state.provider_synced_at },
      },
      {
        status: "PARTIAL",
        warnings: [
          {
            code: "free_agent_pool_not_materialized",
            message: "Only rostered ownership is reported. Yahoo's full free-agent/waiver pool is not yet materialized in this phase.",
          },
        ],
      },
    );
  }
}

// Referenced so the canonical position map is part of the Yahoo module graph.
void canonicalPosition;
