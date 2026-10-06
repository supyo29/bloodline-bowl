/**
 * Public fantasy-API gateway (Next 16 `proxy`, formerly middleware).
 *
 * Applies ONE provider-agnostic policy (lib/public-api/policy.ts) to every
 * `/api/*` request: allowlisted read routes are public for GET/HEAD/OPTIONS,
 * stateless compute routes for POST, everything else is denied or left to the
 * route's own secret guard. Also adds CORS for public routes and a generous
 * best-effort rate limit. Contains no credentials and reads no secrets.
 */

import { NextResponse, type NextRequest } from "next/server";
import { allowedMethods, decide } from "@/lib/public-api/policy";
import { checkRate, clientIp } from "@/lib/public-api/rate-limit";

const CORS_BASE = {
  // Public, credential-free API: wildcard origin, and deliberately NO
  // Access-Control-Allow-Credentials (browsers forbid combining the two).
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Expose-Headers": "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining",
  "Access-Control-Max-Age": "86400",
};

function jsonError(status: number, code: string, detail: string, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(
    { ok: false, error: code, detail, status, generated_at: new Date().toISOString() },
    { status, headers: { ...CORS_BASE, "Cache-Control": "no-store", ...extra } },
  );
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const decision = decide(request.method, pathname);

  if (decision.kind === "deny") {
    return jsonError(decision.status, decision.code, decision.detail, decision.allow ? { Allow: decision.allow.join(", ") } : {});
  }

  if (decision.kind === "preflight") {
    return new NextResponse(null, {
      status: 204,
      headers: { ...CORS_BASE, "Access-Control-Allow-Methods": allowedMethods(decision.entry).join(", ") },
    });
  }

  // Self-guarded / admin routes: untouched (their own secret check applies).
  if (!decision.cors) return NextResponse.next();

  const rate = checkRate(clientIp(request.headers), decision.entry.cost);
  if (!rate.allowed) {
    return jsonError(429, "rate_limited", `Rate limit exceeded (${rate.limit}/min for this route class). Retry shortly.`, {
      "Retry-After": String(rate.retryAfterSeconds),
      "X-RateLimit-Limit": String(rate.limit),
      "X-RateLimit-Remaining": "0",
    });
  }
  return NextResponse.next({
    headers: {
      ...CORS_BASE,
      "X-RateLimit-Limit": String(rate.limit),
      "X-RateLimit-Remaining": String(rate.remaining),
    },
  });
}

export const config = {
  matcher: ["/api/:path*"],
};
