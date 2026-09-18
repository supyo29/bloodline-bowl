/**
 * POST /api/yahoo/diagnostics
 *   Authorization: Bearer <REFRESH_SECRET>   (or X-Refresh-Secret: <secret>)
 *
 * The deep, authenticated, read-only Yahoo probe: identity, dynamic game-key
 * resolution, league discovery, and per-configured-league sub-resource
 * reachability (metadata/settings/standings/scoreboard/teams/draft/transactions)
 * plus the authenticated user's team/roster reachability.
 *
 * Secret-guarded because it spends Yahoo API quota. POST (not GET) so it is
 * never triggered by a crawler. It performs NO write to Yahoo.
 */

import { authorizeSecret } from "@/lib/http-auth";
import { loadYahooSession } from "@/lib/providers/yahoo/session";
import { runDeepProbe } from "@/lib/providers/yahoo/diagnostics";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeSecret(request, "REFRESH_SECRET", { header: "x-refresh-secret" });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.detail);

  const session = await loadYahooSession();
  if (session.state !== "READY" || !session.client) {
    return jsonResponse(
      {
        provider: "yahoo",
        status: session.state,
        detail: session.detail,
        token: session.token,
      },
      { status: session.state === "NOT_CONFIGURED" ? 503 : 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const probe = await runDeepProbe(session.client, {
    overrideKey: session.config?.game_key_override ?? null,
  });

  return jsonResponse(
    {
      provider: "yahoo",
      status: "READY",
      token: session.token,
      ...probe,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
