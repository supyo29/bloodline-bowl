/**
 * GET /api/auth/yahoo/connect  — DEPRECATED alias.
 *
 * The Yahoo OAuth flow moved to `/api/yahoo/*` (the callback path there,
 * `/api/yahoo/oauth/callback`, is the one registered with Yahoo). This alias
 * 308-redirects to the new start route so any old bookmark keeps working.
 */

import { NextResponse } from "next/server";
import { handleOptions } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return NextResponse.redirect(new URL("/api/yahoo/auth/start", request.url), { status: 308 });
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
