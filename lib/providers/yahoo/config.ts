/**
 * Yahoo Fantasy configuration + credential validation.
 *
 * Yahoo requires OAuth 2.0 for any private-league data. Credentials are NEVER
 * committed — they come from the environment:
 *
 *   YAHOO_CLIENT_ID       — OAuth app client id (aka "Consumer Key")
 *   YAHOO_CLIENT_SECRET   — OAuth app client secret (aka "Consumer Secret")
 *   YAHOO_REDIRECT_URI    — must match the app's registered redirect exactly,
 *                           e.g. https://<deployment>/api/auth/yahoo/callback
 *
 * Read-only scope is sufficient (`fspt-r`). This module only reports whether the
 * app is configured; it never logs secret values.
 */

import type { DegradedStatus } from "@/lib/canonical/schema";

export interface YahooConfig {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  /** Yahoo's fantasy game key for the NFL season, e.g. `nfl` or `461`. */
  game_key: string;
  scope: string;
}

export interface YahooConfigResult {
  configured: boolean;
  status: Extract<DegradedStatus, "READY" | "NOT_CONFIGURED">;
  config: YahooConfig | null;
  /** Names of the env vars that are missing (never their values). */
  missing: string[];
}

export function loadYahooConfig(env: NodeJS.ProcessEnv = process.env): YahooConfigResult {
  const clientId = env.YAHOO_CLIENT_ID?.trim();
  const clientSecret = env.YAHOO_CLIENT_SECRET?.trim();
  const redirectUri = env.YAHOO_REDIRECT_URI?.trim();

  const missing: string[] = [];
  if (!clientId) missing.push("YAHOO_CLIENT_ID");
  if (!clientSecret) missing.push("YAHOO_CLIENT_SECRET");
  if (!redirectUri) missing.push("YAHOO_REDIRECT_URI");

  if (missing.length > 0) {
    return { configured: false, status: "NOT_CONFIGURED", config: null, missing };
  }

  return {
    configured: true,
    status: "READY",
    config: {
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: redirectUri!,
      game_key: env.YAHOO_GAME_KEY?.trim() || "nfl",
      scope: "fspt-r",
    },
    missing: [],
  };
}

export const YAHOO_OAUTH_AUTHORIZE_URL = "https://api.login.yahoo.com/oauth2/request_auth";
export const YAHOO_OAUTH_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
export const YAHOO_FANTASY_BASE_URL = "https://fantasysports.yahooapis.com/fantasy/v2";
