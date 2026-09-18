/**
 * Yahoo Fantasy configuration + credential validation.
 *
 * Yahoo requires OAuth 2.0 for any private-league data. Credentials are NEVER
 * committed — they come from the environment:
 *
 *   YAHOO_CLIENT_ID              — OAuth app client id (aka "Consumer Key")
 *   YAHOO_CLIENT_SECRET         — OAuth app client secret (aka "Consumer Secret")
 *   YAHOO_REDIRECT_URI          — must match the app's registered redirect exactly:
 *                                 https://<deployment>/api/yahoo/oauth/callback
 *   YAHOO_TOKEN_ENCRYPTION_KEY  — (for durable storage) 32-byte key; see crypto.ts
 *
 * Read-only scope is sufficient (`fspt-r`). This module only reports whether the
 * app is configured; it never logs secret values.
 *
 * The 2026 NFL game key is NEVER hard-coded — it is resolved from the live API
 * (see `games.ts`). `YAHOO_GAME_KEY` exists ONLY as an optional operator
 * override for offline/dev use and is never trusted over a live resolution.
 */

import type { DegradedStatus } from "@/lib/canonical/schema";
import { yahooCryptoStatus } from "./crypto";

/** Yahoo's game *code* for NFL (stable across seasons; not the season game key). */
export const YAHOO_NFL_GAME_CODE = "nfl";

/** The season this phase targets. */
export const YAHOO_TARGET_SEASON = 2026;

export interface YahooConfig {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scope: string;
  /** Optional operator override for the NFL season game key. Prefer live resolution. */
  game_key_override: string | null;
}

export interface YahooConfigResult {
  configured: boolean;
  status: Extract<DegradedStatus, "READY" | "NOT_CONFIGURED">;
  config: YahooConfig | null;
  /** Names of the env vars that are missing (never their values). */
  missing: string[];
  /** Durable token storage needs an encryption key; in-memory does not. */
  encryption_key_present: boolean;
}

export function loadYahooConfig(env: NodeJS.ProcessEnv = process.env): YahooConfigResult {
  const clientId = env.YAHOO_CLIENT_ID?.trim();
  const clientSecret = env.YAHOO_CLIENT_SECRET?.trim();
  const redirectUri = env.YAHOO_REDIRECT_URI?.trim();
  const encryption_key_present = yahooCryptoStatus(env).configured;

  const missing: string[] = [];
  if (!clientId) missing.push("YAHOO_CLIENT_ID");
  if (!clientSecret) missing.push("YAHOO_CLIENT_SECRET");
  if (!redirectUri) missing.push("YAHOO_REDIRECT_URI");

  if (missing.length > 0) {
    return {
      configured: false,
      status: "NOT_CONFIGURED",
      config: null,
      missing,
      encryption_key_present,
    };
  }

  return {
    configured: true,
    status: "READY",
    config: {
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: redirectUri!,
      scope: "fspt-r",
      game_key_override: env.YAHOO_GAME_KEY?.trim() || null,
    },
    missing: [],
    encryption_key_present,
  };
}

export const YAHOO_OAUTH_AUTHORIZE_URL = "https://api.login.yahoo.com/oauth2/request_auth";
export const YAHOO_OAUTH_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
export const YAHOO_FANTASY_BASE_URL = "https://fantasysports.yahooapis.com/fantasy/v2";
