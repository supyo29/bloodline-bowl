/**
 * Assemble a ready-to-use Yahoo session (config + token store + client) from the
 * environment, or report exactly why one cannot be built. Route handlers call
 * this instead of wiring the pieces themselves.
 */

import { loadYahooConfig, type YahooConfig } from "./config";
import { YahooFantasyClient } from "./client";
import { getValidAccessToken, type YahooTokenStore } from "./oauth";
import { resolveYahooTokenStore } from "./token-store";

export type YahooSessionState =
  | "NOT_CONFIGURED" // OAuth app env missing
  | "STORAGE_UNAVAILABLE" // configured, but no durable place to keep tokens
  | "NOT_CONNECTED" // configured + storage ok, but no account authorized
  | "TOKEN_UNHEALTHY" // connected, but the token cannot be refreshed
  | "READY";

export interface YahooSession {
  state: YahooSessionState;
  detail: string;
  config: YahooConfig | null;
  store: YahooTokenStore | null;
  client: YahooFantasyClient | null;
  /** Non-secret token health for /status. */
  token: {
    connected: boolean;
    healthy: boolean;
    expires_at: string | null;
    expires_in_seconds: number | null;
    yahoo_guid: string | null;
    backend: string;
  };
  missing_env: string[];
}

const EMPTY_TOKEN = {
  connected: false,
  healthy: false,
  expires_at: null,
  expires_in_seconds: null,
  yahoo_guid: null,
  backend: "none",
} as const;

export async function loadYahooSession(
  env: NodeJS.ProcessEnv = process.env,
  opts: { allowMemoryFallback?: boolean } = {},
): Promise<YahooSession> {
  const cfg = loadYahooConfig(env);
  if (!cfg.configured || !cfg.config) {
    return {
      state: "NOT_CONFIGURED",
      detail: `Yahoo OAuth is not configured. Missing: ${cfg.missing.join(", ")}.`,
      config: null,
      store: null,
      client: null,
      token: { ...EMPTY_TOKEN },
      missing_env: cfg.missing,
    };
  }

  const resolved = resolveYahooTokenStore(env, opts);
  if (!resolved.ok) {
    return {
      state: "STORAGE_UNAVAILABLE",
      detail: resolved.reason,
      config: cfg.config,
      store: null,
      client: null,
      token: { ...EMPTY_TOKEN },
      missing_env: resolved.missing,
    };
  }

  const store = resolved.store;
  const client = new YahooFantasyClient({ config: cfg.config, store });

  let current;
  try {
    current = await store.get();
  } catch (err) {
    return {
      state: "TOKEN_UNHEALTHY",
      detail: `Token store read failed: ${err instanceof Error ? err.message : String(err)}`,
      config: cfg.config,
      store,
      client,
      token: { ...EMPTY_TOKEN, backend: store.backend },
      missing_env: [],
    };
  }

  if (!current) {
    return {
      state: "NOT_CONNECTED",
      detail: "Yahoo app configured; no account authorized yet. Visit /api/yahoo/auth/start.",
      config: cfg.config,
      store,
      client,
      token: { ...EMPTY_TOKEN, backend: store.backend },
      missing_env: [],
    };
  }

  const check = await getValidAccessToken(cfg.config, store);
  const now = Date.now();
  const live = check.token ?? current;
  const tokenInfo = {
    connected: true,
    healthy: check.status === "OK",
    expires_at: new Date(live.expires_at).toISOString(),
    expires_in_seconds: Math.round((live.expires_at - now) / 1000),
    yahoo_guid: live.yahoo_guid,
    backend: store.backend,
  };

  if (check.status !== "OK") {
    return {
      state: "TOKEN_UNHEALTHY",
      detail: `Yahoo token could not be refreshed: ${check.detail ?? check.status}`,
      config: cfg.config,
      store,
      client,
      token: tokenInfo,
      missing_env: [],
    };
  }

  return {
    state: "READY",
    detail: "Yahoo account connected and token healthy.",
    config: cfg.config,
    store,
    client,
    token: tokenInfo,
    missing_env: [],
  };
}
