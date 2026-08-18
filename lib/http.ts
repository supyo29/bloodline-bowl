/**
 * Shared HTTP concerns: CORS and cache headers for the read-only JSON API.
 */

import { NextResponse } from "next/server";

/**
 * The bridge serves public, read-only league data with no credentials, so a
 * wildcard origin is appropriate — it lets ChatGPT, Claude, or a browser fetch
 * the endpoint directly. Only GET/OPTIONS are permitted.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};

/**
 * Vercel's CDN honours `s-maxage` and `stale-while-revalidate`, so a cached
 * response is served instantly while a refresh happens in the background.
 */
export function cacheHeader(
  maxAgeSeconds: number,
  staleWhileRevalidateSeconds: number,
): string {
  return `public, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`;
}

export function jsonResponse<T>(
  body: T,
  init: { status?: number; headers?: Record<string, string> } = {},
): NextResponse {
  return NextResponse.json(body, {
    status: init.status ?? 200,
    headers: { ...CORS_HEADERS, ...(init.headers ?? {}) },
  });
}

export function errorResponse(
  status: number,
  error: string,
  detail?: string,
): NextResponse {
  return jsonResponse(
    {
      ok: false,
      error,
      ...(detail ? { detail } : {}),
      status,
      generated_at: new Date().toISOString(),
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** Shared preflight handler for the GET-only endpoints. */
export function handleOptions(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
