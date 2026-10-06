/**
 * GET /api/yahoo/leagues/{leagueId}/players/available
 *
 * Read-only Yahoo player pool for one league (`{leagueId}` = registry slug such
 * as `rogers-park`, or the numeric Yahoo league id). Despite the name it can also
 * return rostered players so callers can tell the two apart.
 *
 * Query parameters
 *   status    available (default: FA + W) | FA | W | rostered (alias T)
 *   position  QB | RB | WR | TE | K | DEF | ...   (Yahoo position filter)
 *   search    player-name substring (Yahoo-side search)
 *   player_id Yahoo player id(s), comma-separated; looks the player up in this
 *             league regardless of status and classifies FA / W / rostered
 *   start     offset into each pool (default 0)
 *   count     players wanted per pool (default 25, max 500)
 *   all       true -> paginate until Yahoo's pool is exhausted (or the safety limit)
 *
 * Yahoo caps a page at 25 and returns no total, so `pagination.complete` is only
 * true when Yahoo itself signalled the end of the pool. See lib/providers/yahoo/players.ts.
 */

import { YahooApiError } from "@/lib/providers/yahoo/client";
import { resolveYahooConnectionSelection } from "@/lib/providers/yahoo/connections";
import { YAHOO_TARGET_SEASON } from "@/lib/providers/yahoo/config";
import { probeLeague } from "@/lib/providers/yahoo/discovery";
import { resolveNflGameKey } from "@/lib/providers/yahoo/games";
import {
  YAHOO_PLAYERS_MAX_PAGES,
  buildPlayersPath,
  YAHOO_PLAYERS_PAGE_SIZE,
  fetchPlayerPool,
  fetchPlayersWithOwnership,
  sanitizePosition,
  type PoolResult,
  type YahooAvailabilityCode,
  type YahooPoolPlayer,
} from "@/lib/providers/yahoo/players";
import { loadYahooSession } from "@/lib/providers/yahoo/session";
import { findLeagueTarget } from "@/lib/leagues/registry";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_COUNT = 500;
const TIME_BUDGET_MS = 48_000;
const NO_STORE = { "Cache-Control": "no-store" };

type StatusParam = "available" | "FA" | "W" | "rostered";

function parseStatus(raw: string | null): StatusParam | null {
  const v = (raw ?? "available").trim().toLowerCase();
  if (v === "available" || v === "a") return "available";
  if (v === "fa" || v === "free_agent" || v === "free_agents") return "FA";
  if (v === "w" || v === "waivers" || v === "waiver") return "W";
  if (v === "t" || v === "rostered" || v === "taken") return "rostered";
  return null;
}

function intParam(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n < min || n > max ? null : n;
}

/** Structure-only skeleton of a Yahoo JSON body (keys/types, first array element) for debugging parsers. */
function skeleton(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== "object") return typeof v === "string" ? `string(${v.slice(0, 24)})` : typeof v;
  if (depth >= 9) return "…";
  if (Array.isArray(v)) return v.length === 0 ? [] : [`len=${v.length}`, skeleton(v[0], depth + 1), ...(v.length > 1 ? [skeleton(v[1], depth + 1)] : [])];
  const out: Record<string, unknown> = {};
  const entries = Object.entries(v as Record<string, unknown>);
  for (const [k, val] of entries.slice(0, 3 + (entries.some(([kk]) => !/^\d+$/.test(kk)) ? 20 : 0))) out[k] = skeleton(val, depth + 1);
  if (entries.length > 23) out["…"] = `${entries.length} keys`;
  return out;
}

function diagnostics(
  err: unknown,
  ctx: { league_key: string | null; route_params: Record<string, unknown> },
): Record<string, unknown> {
  if (err instanceof YahooApiError) {
    return {
      layer: "yahoo_fantasy_api",
      error_kind: err.kind,
      http_status: err.httpStatus,
      yahoo_message: err.yahooMessage,
      resource_path: err.resourcePath,
      league_key: ctx.league_key,
      route_params: ctx.route_params,
      auth_refresh_attempted: err.refreshAttempted,
    };
  }
  return {
    layer: "bridge",
    error: err instanceof Error ? err.message.slice(0, 300) : "unknown error",
    league_key: ctx.league_key,
    route_params: ctx.route_params,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  const { leagueId: raw } = await params;
  const url = new URL(request.url);
  const sp = url.searchParams;

  const target = findLeagueTarget(raw) ?? findLeagueTarget(raw.toLowerCase());
  if (target && target.provider !== "yahoo") {
    return errorResponse(400, "not_a_yahoo_league", `"${raw}" is a ${target.provider} league; this route is Yahoo-only.`);
  }
  const leagueId = target ? target.external_league_id : raw;
  if (!/^\d+$/.test(leagueId)) {
    return errorResponse(400, "yahoo_invalid_league_id", `"${raw}" is not a Yahoo league id or a known Yahoo registry slug.`);
  }

  const status = parseStatus(sp.get("status"));
  if (!status) return errorResponse(400, "invalid_status", "status must be one of: available, FA, W, rostered.");
  const rawPosition = sp.get("position");
  const position = sanitizePosition(rawPosition);
  if (rawPosition && !position) return errorResponse(400, "invalid_position", `position "${rawPosition}" is not valid (e.g. QB, RB, WR, TE, K, DEF).`);
  const search = sp.get("search")?.trim().slice(0, 80) || null;
  const start = intParam(sp.get("start"), 0, 0, 100_000);
  const count = intParam(sp.get("count"), YAHOO_PLAYERS_PAGE_SIZE, 1, MAX_COUNT);
  if (start === null) return errorResponse(400, "invalid_start", "start must be a non-negative integer.");
  if (count === null) return errorResponse(400, "invalid_count", `count must be an integer between 1 and ${MAX_COUNT}.`);
  const all = ["true", "1", "yes"].includes((sp.get("all") ?? "").toLowerCase());
  const playerIdRaw = sp.get("player_id") ?? sp.get("player_ids");
  const playerIds = playerIdRaw ? playerIdRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (playerIds.some((id) => !/^\d{1,9}$/.test(id)) || playerIds.length > 50) {
    return errorResponse(400, "invalid_player_id", "player_id must be up to 50 comma-separated numeric Yahoo player ids.");
  }

  const connectionId = target?.yahoo_connection_id ?? undefined;
  const selection = resolveYahooConnectionSelection(connectionId ? new URLSearchParams({ league: target!.key }) : new URLSearchParams());
  if (!selection.ok) return errorResponse(selection.status, selection.code, selection.detail);

  const routeParams = {
    league: raw,
    status,
    position,
    search,
    player_id: playerIds.length ? playerIds : null,
    start,
    count: all ? null : count,
    all,
  };

  const session = await loadYahooSession(process.env, { connectionId: selection.connection_id });
  if (session.state !== "READY" || !session.client) {
    return jsonResponse(
      {
        ok: false,
        error: "yahoo_session_unavailable",
        diagnostics: {
          layer: "oauth",
          session_state: session.state,
          detail: session.detail,
          token_healthy: session.token.healthy,
          token_expires_in_seconds: session.token.expires_in_seconds,
          route_params: routeParams,
          auth_refresh_attempted: session.state === "TOKEN_UNHEALTHY",
        },
      },
      { status: session.state === "NOT_CONFIGURED" || session.state === "STORAGE_UNAVAILABLE" ? 503 : 409, headers: NO_STORE },
    );
  }
  const client = session.client;

  let leagueKey: string | null = null;
  try {
    const gameKeyResult = await resolveNflGameKey(client, target?.season ?? YAHOO_TARGET_SEASON, {
      overrideKey: session.config?.game_key_override ?? null,
    });
    if (!gameKeyResult.ok) {
      return jsonResponse(
        { ok: false, error: "yahoo_game_key_unresolved", diagnostics: { layer: "game_key", detail: gameKeyResult.detail, kind: gameKeyResult.kind, route_params: routeParams } },
        { status: 502, headers: NO_STORE },
      );
    }
    const probe = await probeLeague(client, gameKeyResult.game.game_key, leagueId);
    leagueKey = probe.league_key;
    if (!probe.accessible || !probe.league) {
      return jsonResponse(
        { ok: false, error: "yahoo_league_inaccessible", diagnostics: { layer: "league", error_kind: probe.error_kind, detail: probe.detail, league_key: leagueKey, route_params: routeParams } },
        { status: probe.error_kind === "FORBIDDEN" || probe.error_kind === "NOT_FOUND" ? 403 : 502, headers: NO_STORE },
      );
    }
    if (probe.league.league_id !== leagueId) {
      return jsonResponse(
        { ok: false, error: "yahoo_league_identity_mismatch", diagnostics: { layer: "league", league_key: leagueKey, returned_league_id: probe.league.league_id, route_params: routeParams } },
        { status: 502, headers: NO_STORE },
      );
    }

    const deadlineMs = Date.now() + TIME_BUDGET_MS;
    const meta = {
      league: { slug: target?.key ?? null, yahoo_league_id: leagueId, league_key: leagueKey, name: probe.league.name },
      filters: { status, position, search, player_id: playerIds.length ? playerIds : null },
    };
    const generated_at = new Date().toISOString();

    // ── Player-id lookup: classify specific players whatever their status ────
    if (playerIds.length > 0) {
      const gameKey = gameKeyResult.game.game_key;
      const keys = playerIds.map((id) => `${gameKey}.p.${id}`);
      const found = await fetchPlayersWithOwnership(client, leagueKey, keys);
      const foundIds = new Set(found.players.map((p) => p.player_id));
      return jsonResponse(
        {
          ok: true,
          ...meta,
          pagination: { returned: found.players.length, total: found.players.length, start: 0, complete: true },
          not_found_or_unclassified: playerIds.filter((id) => !foundIds.has(id)),
          players: found.players,
          yahoo_requests: found.requests,
          generated_at,
        },
        { headers: NO_STORE },
      );
    }

    if (sp.get("debug") === "shape") {
      const code = status === "available" ? "A" : status === "rostered" ? "T" : status;
      const path = buildPlayersPath(leagueKey, { status: code, position, search, start, count: Math.min(count, 25) }, sp.get("ownership") === "1");
      const { data, meta: ym } = await client.get(path);
      return jsonResponse({ ok: true, ...meta, debug: { path, http_status: ym.http_status, refreshed: ym.refreshed, shape: skeleton(data) }, generated_at }, { headers: NO_STORE });
    }

    // ── Pool queries ─────────────────────────────────────────────────────────
    const codes: YahooAvailabilityCode[] = status === "available" ? ["FA", "W"] : status === "rostered" ? ["T"] : [status];
    const pools: PoolResult[] = await Promise.all(
      codes.map((code) =>
        fetchPlayerPool(client, leagueKey!, {
          status: code,
          position,
          search,
          start,
          count: all ? null : count,
          maxPages: YAHOO_PLAYERS_MAX_PAGES,
          deadlineMs,
          // Waiver clear dates and owners live in the ownership sub-resource.
          withOwnership: code === "W" || code === "T",
        }),
      ),
    );

    const seen = new Set<string>();
    const players: YahooPoolPlayer[] = [];
    for (const pool of pools) {
      for (const p of pool.players) {
        if (seen.has(p.player_key)) continue;
        seen.add(p.player_key);
        players.push(p);
      }
    }
    const complete = pools.every((p) => p.complete);

    return jsonResponse(
      {
        ok: true,
        ...meta,
        pagination: {
          returned: players.length,
          // Yahoo exposes no total; known only when every pool was exhausted from start=0.
          total: complete && start === 0 ? players.length : null,
          start,
          complete,
          page_size: YAHOO_PLAYERS_PAGE_SIZE,
          safety_limit_pages_per_pool: YAHOO_PLAYERS_MAX_PAGES,
          pools: Object.fromEntries(
            pools.map((p) => [
              p.status,
              {
                returned: p.players.length,
                complete: p.complete,
                next_start: p.next_start,
                pages_fetched: p.pages_fetched,
                stopped_reason: p.stopped_reason,
                ownership_subresource: p.ownership,
                dropped_rostered_rows: p.dropped_rostered,
                duplicate_rows_dropped: p.duplicates_dropped,
              },
            ]),
          ),
        },
        players,
        yahoo_requests: pools.flatMap((p) => p.requests.slice(0, 3)).slice(0, 6),
        generated_at,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    const upstream = err instanceof YahooApiError;
    return jsonResponse(
      { ok: false, error: upstream ? "yahoo_request_failed" : "bridge_error", diagnostics: diagnostics(err, { league_key: leagueKey, route_params: routeParams }) },
      {
        status: upstream ? (err.kind === "AUTH" || err.kind === "NOT_CONNECTED" ? 409 : err.kind === "RATE_LIMITED" ? 429 : 502) : 500,
        headers: NO_STORE,
      },
    );
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
