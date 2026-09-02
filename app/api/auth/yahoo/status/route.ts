/**
 * GET /api/auth/yahoo/status
 *
 * Reports whether the Yahoo OAuth app is configured and whether an account is
 * connected. Never returns tokens or secret values.
 */

import { loadYahooConfig } from "@/lib/providers/yahoo/config";
import { YahooProvider } from "@/lib/providers/yahoo/provider";
import { handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const cfg = loadYahooConfig();
  const health = await new YahooProvider().healthCheck();
  return jsonResponse(
    {
      configured: cfg.configured,
      status: health.status,
      detail: health.detail,
      missing_env: cfg.missing,
      authorize_url: cfg.configured ? "/api/auth/yahoo/connect" : null,
      note:
        "Yahoo live OAuth has NOT been verified against the real API — no approved credentials exist yet.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
