/**
 * GET /api/auth/yahoo/status  — DEPRECATED alias for GET /api/yahoo/status.
 */

import { NextResponse } from "next/server";
import { handleOptions } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return NextResponse.redirect(new URL("/api/yahoo/status", request.url), { status: 308 });
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
