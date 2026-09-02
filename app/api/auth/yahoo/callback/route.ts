/**
 * GET /api/auth/yahoo/callback?code=...&state=...
 *
 * Step 2 of Yahoo OAuth: verify the CSRF `state`, exchange the `code` for
 * tokens, and persist them server-side via a YahooTokenStore.
 *
 * STATUS: structurally complete, UNVERIFIED against the live Yahoo API. Until a
 * real Yahoo app + approval exists this path cannot be reached (connect returns
 * NOT_CONFIGURED). Kept here so the full flow is reviewable and testable.
 *
 * The token store wiring (Supabase `yahoo_connections`) is a follow-up: this
 * handler currently reports `PERSISTENCE_PENDING` after a successful exchange
 * rather than writing to an unimplemented store.
 */

import { loadYahooConfig } from "@/lib/providers/yahoo/config";
import { exchangeCodeForToken } from "@/lib/providers/yahoo/oauth";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return errorResponse(400, "yahoo_oauth_denied", `Yahoo returned error: ${error}`);
  }
  if (!code || !state) {
    return errorResponse(400, "yahoo_oauth_missing_params", "Missing `code` or `state`.");
  }

  const cookieState = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("yahoo_oauth_state="))
    ?.split("=")[1];

  if (!cookieState || cookieState !== state) {
    return errorResponse(400, "yahoo_oauth_state_mismatch", "CSRF state did not match. Restart the flow.");
  }

  const cfg = loadYahooConfig();
  if (!cfg.configured || !cfg.config) {
    return errorResponse(503, "yahoo_not_configured", `Missing: ${cfg.missing.join(", ")}.`);
  }

  try {
    const token = await exchangeCodeForToken(cfg.config, code);
    // TODO(yahoo): persist `token` via SupabaseYahooTokenStore(yahoo_connections).
    return jsonResponse(
      {
        status: "CONNECTED_NOT_PERSISTED",
        detail:
          "Yahoo token exchange succeeded but the token store is not wired up yet. " +
          "The connection will not survive a restart until the Supabase-backed store lands.",
        yahoo_guid: token.yahoo_guid,
        expires_at: token.expires_at,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(
      502,
      "yahoo_token_exchange_failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
