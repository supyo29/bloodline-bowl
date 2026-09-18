/**
 * YahooProvider — structurally complete, not yet live.
 *
 * Yahoo needs OAuth for private-league data and no approved credentials exist
 * yet, so every data method returns an explicit degraded `ProviderResult`
 * (`NOT_CONFIGURED` with no env, `AUTH_REQUIRED` when configured but not
 * connected). It NEVER returns fabricated league data.
 *
 * The canonical conversion path (`./canonical#yahooBundleToCanonical`) IS
 * exercised — by `test/provider-normalization.test.ts` against a fixture — so
 * when a real Yahoo connection lands, only the fetch/flatten layer is new.
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
  type CanonicalLeagueStateBundle,
  type FantasyProvider,
  type ProviderCapabilities,
  type ProviderHealth,
  type ProviderLeagueContext,
  type ProviderResult,
} from "../types";
import { loadYahooConfig } from "./config";
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
    // What the Yahoo Fantasy API is CAPABLE of once authenticated — not what is
    // wired up today. `live_authenticated_access` is the honest gate.
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
      live_authenticated_access: false,
    };
  }

  async #authStatus(): Promise<
    | { ok: true; accessToken: string }
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
    return { ok: true, accessToken: result.access_token };
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

  /**
   * Every data method funnels through here: report the honest auth state
   * (NOT_CONFIGURED / AUTH_REQUIRED) or, once authenticated,
   * `yahoo_fetch_unimplemented` — the live fetch/flatten layer is deferred to a
   * later phase and is NEVER a fabricated success.
   */
  async #unavailable<T>(ctx: ProviderLeagueContext): Promise<ProviderResult<T>> {
    const auth = await this.#authStatus();
    if (!auth.ok) return auth.result;
    return degraded(
      "PROVIDER_ERROR",
      "yahoo_fetch_unimplemented",
      `Yahoo live fetch for "${ctx.league_slug}" is not implemented in the foundation phase.`,
    );
  }

  getLeagueState(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalLeagueStateBundle>> {
    return this.#unavailable(ctx);
  }
  getLeague(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalLeague>> {
    return this.#unavailable(ctx);
  }
  getManagers(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalManager[]>> {
    return this.#unavailable(ctx);
  }
  getStandings(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalStanding[]>> {
    return this.#unavailable(ctx);
  }
  getRosters(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalRoster[]>> {
    return this.#unavailable(ctx);
  }
  getMatchups(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalMatchup[]>> {
    return this.#unavailable(ctx);
  }
  getTransactions(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalTransaction[]>> {
    return this.#unavailable(ctx);
  }
  getDraftResults(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalDraftPick[]>> {
    return this.#unavailable(ctx);
  }
  getWaiverState(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalWaiverState>> {
    return this.#unavailable(ctx);
  }
}

// Referenced so the canonical position map is part of the Yahoo module graph
// even before the live flattener exists.
void canonicalPosition;
