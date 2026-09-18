/**
 * GET /api/auth/yahoo/callback  — DEPRECATED alias.
 *
 * The registered Yahoo redirect URI is `/api/yahoo/oauth/callback`. This alias
 * 308-redirects there, preserving the `code`/`state`/`error` query string, in
 * case an older Yahoo app registration still points here.
 */

import { NextResponse } from "next/server";
import { handleOptions } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const src = new URL(request.url);
  const dest = new URL("/api/yahoo/oauth/callback", request.url);
  dest.search = src.search;
  return NextResponse.redirect(dest, { status: 308 });
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
