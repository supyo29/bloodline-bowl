/**
 * GET /api/yahoo/auth/start
 *
 * Step 1 of Yahoo OAuth 2.0 (Authorization Code). Validates configuration,
 * mints a 32-byte CSRF `state`, sets it as an HttpOnly SameSite=Lax cookie, and
 * 302-redirects the user to Yahoo's consent screen.
 *
 * If the app is not configured, or there is nowhere durable to persist the
 * resulting tokens, this returns an explicit JSON error instead of a broken
 * redirect — we never start a flow we cannot finish.
 */

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { loadYahooConfig } from "@/lib/providers/yahoo/config";
import { buildAuthorizeUrl } from "@/lib/providers/yahoo/oauth";
import { resolveYahooTokenStore } from "@/lib/providers/yahoo/token-store";
import { YAHOO_STATE_COOKIE } from "@/lib/providers/yahoo/oauth-state";
import { CORS_HEADERS, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const cfg = loadYahooConfig();
  if (!cfg.configured || !cfg.config) {
    return jsonResponse(
      {
        status: "NOT_CONFIGURED",
        detail: `Yahoo OAuth is not configured. Set: ${cfg.missing.join(", ")}.`,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const storage = resolveYahooTokenStore();
  if (!storage.ok) {
    return jsonResponse(
      {
        status: "STORAGE_UNAVAILABLE",
        detail: storage.reason,
        missing_env: storage.missing,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const state = randomBytes(32).toString("hex");
  const authorizeUrl = buildAuthorizeUrl(cfg.config, state);

  const res = NextResponse.redirect(authorizeUrl, { status: 302 });
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  res.headers.set("Cache-Control", "no-store");
  res.cookies.set(YAHOO_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/yahoo",
  });
  return res;
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
