/**
 * GET /api/auth/yahoo/connect
 *
 * Step 1 of Yahoo OAuth: redirect the user to Yahoo's consent screen with a
 * single-use CSRF `state`. If the app is not configured this returns an
 * explicit `NOT_CONFIGURED` JSON body instead of a broken redirect.
 *
 * NOTE: the downstream callback / token exchange is written to spec in
 * `lib/providers/yahoo/oauth.ts` but UNVERIFIED against the live Yahoo API.
 */

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { loadYahooConfig } from "@/lib/providers/yahoo/config";
import { buildAuthorizeUrl } from "@/lib/providers/yahoo/oauth";
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

  const state = randomBytes(16).toString("hex");
  const authorizeUrl = buildAuthorizeUrl(cfg.config, state);

  const res = NextResponse.redirect(authorizeUrl, { status: 302 });
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  // Single-use CSRF nonce, checked in the callback. HttpOnly so JS cannot read it.
  res.cookies.set("yahoo_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/auth/yahoo",
  });
  return res;
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
