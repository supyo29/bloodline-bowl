/**
 * GET /api/yahoo/oauth/callback?code=...&state=...
 *
 * Step 2 of Yahoo OAuth. THIS PATH is the redirect URI registered with Yahoo
 * (`https://<deployment>/api/yahoo/oauth/callback`) — do not move it without
 * also updating the Yahoo app registration and YAHOO_REDIRECT_URI.
 *
 *   1. Detect a Yahoo-side authorization error (`?error=`).
 *   2. Require `code` + `state`.
 *   3. Constant-time-compare `state` against the HttpOnly cookie from
 *      /api/yahoo/auth/start; reject on mismatch (CSRF).
 *   4. Exchange `code` for tokens server-side (HTTP Basic client auth).
 *   5. Persist via the durable token store (encrypted at rest).
 *   6. Clear the state cookie. Never put a token in the response body.
 */

import { NextResponse } from "next/server";
import { loadYahooConfig } from "@/lib/providers/yahoo/config";
import {
  exchangeCodeForToken,
  InMemoryYahooTokenStore,
  statesMatch,
  YahooOAuthError,
} from "@/lib/providers/yahoo/oauth";
import { resolveYahooTokenStore } from "@/lib/providers/yahoo/token-store";
import {
  isRegisteredYahooConnectionId,
  yahooLeaguesForConnection,
} from "@/lib/providers/yahoo/connections";
import {
  decodeYahooOAuthState,
  YAHOO_STATE_COOKIE,
} from "@/lib/providers/yahoo/oauth-state";
import { YahooFantasyClient } from "@/lib/providers/yahoo/client";
import { resolveNflGameKey } from "@/lib/providers/yahoo/games";
import { probeLeague } from "@/lib/providers/yahoo/discovery";
import { findLeagueTarget } from "@/lib/leagues/registry";
import { CORS_HEADERS, errorResponse, handleOptions } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clearStateCookie(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  res.headers.set("Cache-Control", "no-store");
  res.cookies.set(YAHOO_STATE_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", maxAge: 0, path: "/api/yahoo" });
  return res;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return clearStateCookie(
      NextResponse.json(
        { ok: false, error: "yahoo_oauth_denied", detail: `Yahoo returned "${error}"${errorDescription ? `: ${errorDescription}` : ""}.`, status: 400 },
        { status: 400 },
      ),
    );
  }
  if (!code || !state) {
    return errorResponse(400, "yahoo_oauth_missing_params", "Missing `code` or `state`.");
  }

  const cookieState = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${YAHOO_STATE_COOKIE}=`))
    ?.slice(YAHOO_STATE_COOKIE.length + 1);

  if (!statesMatch(cookieState, state)) {
    return clearStateCookie(
      NextResponse.json(
        { ok: false, error: "yahoo_oauth_state_mismatch", detail: "CSRF state did not match. Restart at /api/yahoo/auth/start.", status: 400 },
        { status: 400 },
      ),
    );
  }

  const statePayload = decodeYahooOAuthState(state);
  if (!statePayload || !isRegisteredYahooConnectionId(statePayload.connection_id)) {
    return clearStateCookie(
      NextResponse.json(
        {
          ok: false,
          error: "yahoo_oauth_state_invalid",
          detail: "OAuth state did not contain a valid registered Yahoo connection. Restart the authorization flow.",
          status: 400,
        },
        { status: 400 },
      ),
    );
  }

  if (statePayload.league_slug) {
    const bound = findLeagueTarget(statePayload.league_slug);
    const boundConnection = bound?.yahoo_connection_id ?? null;
    if (!bound || bound.provider !== "yahoo" || boundConnection !== statePayload.connection_id) {
      return clearStateCookie(
        NextResponse.json(
          {
            ok: false,
            error: "yahoo_oauth_binding_invalid",
            detail: "The requested Yahoo league is not bound to this OAuth connection.",
            status: 400,
          },
          { status: 400 },
        ),
      );
    }
  }

  const cfg = loadYahooConfig();
  if (!cfg.configured || !cfg.config) {
    return errorResponse(503, "yahoo_not_configured", `Missing: ${cfg.missing.join(", ")}.`);
  }
  const storage = resolveYahooTokenStore(process.env, {
    connectionId: statePayload.connection_id,
  });
  if (!storage.ok) {
    return errorResponse(503, "yahoo_storage_unavailable", storage.reason);
  }

  let token;
  try {
    token = await exchangeCodeForToken(cfg.config, code);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const status = err instanceof YahooOAuthError && err.kind === "INVALID_GRANT" ? 400 : 502;
    return clearStateCookie(
      NextResponse.json({ ok: false, error: "yahoo_token_exchange_failed", detail, status }, { status }),
    );
  }

  // If the OAuth flow was launched for a specific league, prove the newly
  // authorized account can read that exact league BEFORE persisting it. This
  // prevents a mistaken Yahoo login from replacing a known-good connection.
  if (statePayload.league_slug) {
    const league = findLeagueTarget(statePayload.league_slug);
    if (!league || league.provider !== "yahoo") {
      return clearStateCookie(
        NextResponse.json(
          { ok: false, error: "yahoo_oauth_binding_invalid", detail: "Yahoo league binding disappeared during authorization.", status: 400 },
          { status: 400 },
        ),
      );
    }

    const temporaryStore = new InMemoryYahooTokenStore();
    await temporaryStore.set(token);
    const temporaryClient = new YahooFantasyClient({
      config: cfg.config,
      store: temporaryStore,
    });

    const game = await resolveNflGameKey(temporaryClient, league.season, {
      overrideKey: cfg.config.game_key_override,
      forceRefresh: true,
    });
    if (!game.ok) {
      return clearStateCookie(
        NextResponse.json(
          {
            ok: false,
            error: "yahoo_oauth_league_verification_failed",
            detail: `Yahoo login succeeded, but the ${league.season} NFL game key could not be verified for "${league.display_name}". No token was stored.`,
            status: 502,
          },
          { status: 502 },
        ),
      );
    }

    const access = await probeLeague(
      temporaryClient,
      game.game.game_key,
      league.external_league_id,
    );
    if (!access.accessible) {
      return clearStateCookie(
        NextResponse.json(
          {
            ok: false,
            error: "yahoo_oauth_wrong_account",
            detail:
              `The Yahoo account you authorized cannot access "${league.display_name}" (league ${league.external_league_id}). ` +
              "Sign in with the Yahoo account that owns or belongs to that league. No existing connection was changed.",
            status: 403,
          },
          { status: 403 },
        ),
      );
    }
  }

  try {
    await storage.store.set(token);
  } catch (err) {
    return clearStateCookie(
      NextResponse.json(
        {
          ok: false,
          error: "yahoo_token_persist_failed",
          detail: `Token exchange succeeded but persistence failed: ${err instanceof Error ? err.message : String(err)}`,
          status: 500,
        },
        { status: 500 },
      ),
    );
  }

  return clearStateCookie(
    NextResponse.json(
      {
        ok: true,
        status: "CONNECTED",
        detail: "Yahoo account authorized and tokens stored securely.",
        connection_id: statePayload.connection_id,
        league_slug: statePayload.league_slug,
        bound_leagues: yahooLeaguesForConnection(statePayload.connection_id).map((l) => l.key),
        storage_backend: storage.store.backend,
        durable: storage.durable,
        yahoo_guid: token.yahoo_guid,
        access_token_expires_at: new Date(token.expires_at).toISOString(),
        scope: token.scope,
        next: statePayload.league_slug
          ? `/api/yahoo/status?league=${encodeURIComponent(statePayload.league_slug)}`
          : `/api/yahoo/status?connection=${encodeURIComponent(statePayload.connection_id)}`,
      },
      { status: 200 },
    ),
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
