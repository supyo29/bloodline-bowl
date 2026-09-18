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
import { exchangeCodeForToken, statesMatch, YahooOAuthError } from "@/lib/providers/yahoo/oauth";
import { resolveYahooTokenStore } from "@/lib/providers/yahoo/token-store";
import { YAHOO_STATE_COOKIE } from "@/lib/providers/yahoo/oauth-state";
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

  const cfg = loadYahooConfig();
  if (!cfg.configured || !cfg.config) {
    return errorResponse(503, "yahoo_not_configured", `Missing: ${cfg.missing.join(", ")}.`);
  }
  const storage = resolveYahooTokenStore();
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
        storage_backend: storage.store.backend,
        durable: storage.durable,
        yahoo_guid: token.yahoo_guid,
        access_token_expires_at: new Date(token.expires_at).toISOString(),
        scope: token.scope,
        next: "/api/yahoo/status",
      },
      { status: 200 },
    ),
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
