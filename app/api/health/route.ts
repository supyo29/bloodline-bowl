/**
 * GET /api/health — liveness probe.
 *
 * Cheap by default. Pass `?draft=1` to additionally report the active draft's
 * id and status, which costs two small cached Sleeper calls; the bare probe
 * still makes no upstream requests at all.
 */

import {
  SleeperError,
  getLeagueDrafts,
  getPlayerCacheStatus,
} from "@/lib/sleeper/client";
import { selectActiveDraft } from "@/lib/sleeper/draft";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const leagueId = resolveLeagueId();
  const wantsDraft = new URL(request.url).searchParams.get("draft") === "1";

  const base = {
    ok: true,
    service: "bloodline-bowl-sleeper-bridge",
    league_id: leagueId,
    timestamp: new Date().toISOString(),
    player_cache: getPlayerCacheStatus(),
  };

  if (!wantsDraft) {
    return jsonResponse(base, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const drafts = await getLeagueDrafts(leagueId);
    const active = selectActiveDraft(drafts);
    return jsonResponse(
      {
        ...base,
        sleeper: true,
        active_draft_id: active?.draft_id ?? null,
        draft_status: active?.status ?? null,
        draft_type: active?.type ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Sleeper being unreachable does not mean this service is down; report the
    // service as healthy but flag the upstream.
    return jsonResponse(
      {
        ...base,
        sleeper: false,
        active_draft_id: null,
        draft_status: null,
        draft_type: null,
        sleeper_error:
          error instanceof SleeperError || error instanceof Error
            ? error.message
            : "Unknown error",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
