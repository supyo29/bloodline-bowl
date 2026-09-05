/**
 * POST /api/trades/discover — trade target discovery and counteroffer intelligence (Phase 4).
 *
 * Discovery SEARCHES the transaction space; it never replaces the canonical
 * trade evaluator. Every candidate this endpoint returns was validated by
 * `validateTrade` and scored by `evaluateTrade` — the exact same functions
 * `POST /api/trades/analyze` uses (`lib/trades/discovery/candidate-eval.ts`).
 *
 * Ranking uses ONLY Phase 1/2 authoritative utility (`roster_utility_delta`/
 * `contextual_utility_delta`) — Phase 3 shadow intelligence never influences
 * `discovery_score`; it appears only in each result's `phase3_shadow` block,
 * explicitly labeled "SHADOW INTELLIGENCE — NOT INCLUDED IN TRADE SCORE".
 * Trade-level Phase 3 calibration remains deferred (see `calibration_status`
 * in the response) — `POST /api/trades/discover` never activates a nonzero
 * Phase 3 weight, same as `analyze`.
 *
 * Read-only and stateless. Nothing is persisted or sent to any manager.
 *
 * Request body:
 *   {
 *     "league": "devoted-to-the-game",
 *     "manager": "darthmarker",
 *     "mode": "POSITIONAL_NEED",
 *     "target_position": "RB",
 *     "max_results": 10
 *   }
 *
 * Modes: BEST_AVAILABLE, BUY_PLAYER (+target_player_id), SELL_PLAYER
 * (+sell_player_id), POSITIONAL_NEED (+target_position), CONSOLIDATE,
 * FAIR_TRADES, EASY_TO_ACCEPT, BLOCKBUSTER, THREE_TEAM.
 */

import { discoverTrades } from "@/lib/trades/discovery/discover";
import type { SearchMode, TradeDiscoveryRequest, TradeSearchConstraints } from "@/lib/trades/discovery/types";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 16 * 1024;
const VALID_MODES: SearchMode[] = ["BEST_AVAILABLE", "BUY_PLAYER", "SELL_PLAYER", "POSITIONAL_NEED", "CONSOLIDATE", "FAIR_TRADES", "EASY_TO_ACCEPT", "BLOCKBUSTER", "THREE_TEAM"];

function sanitizeConstraints(raw: unknown): TradeSearchConstraints | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const strArr = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const out: TradeSearchConstraints = {};
  const untouchable = strArr(r.untouchable_player_ids); if (untouchable) out.untouchable_player_ids = untouchable;
  const reqIn = strArr(r.required_incoming_player_ids); if (reqIn) out.required_incoming_player_ids = reqIn;
  const reqOut = strArr(r.required_outgoing_player_ids); if (reqOut) out.required_outgoing_player_ids = reqOut;
  const excl = strArr(r.excluded_trade_partner_ids); if (excl) out.excluded_trade_partner_ids = excl;
  const allowed = strArr(r.allowed_trade_partner_ids); if (allowed) out.allowed_trade_partner_ids = allowed;
  const maxSent = num(r.max_assets_sent); if (maxSent != null) out.max_assets_sent = maxSent;
  const maxRecv = num(r.max_assets_received); if (maxRecv != null) out.max_assets_received = maxRecv;
  const minMy = num(r.minimum_my_utility_delta); if (minMy != null) out.minimum_my_utility_delta = minMy;
  const minPartner = num(r.minimum_partner_utility_delta); if (minPartner != null) out.minimum_partner_utility_delta = minPartner;
  return out;
}

export async function POST(request: Request): Promise<Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return errorResponse(413, "payload_too_large", `Request body must be under ${MAX_BODY_BYTES} bytes.`);
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return errorResponse(413, "payload_too_large", `Request body must be under ${MAX_BODY_BYTES} bytes.`);
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return errorResponse(400, "invalid_body", "Expected a JSON object.");
  const b = body as Record<string, unknown>;

  const league = typeof b.league === "string" ? b.league.trim() : "";
  if (!league) return errorResponse(400, "league_required", "`league` (registry slug) is required.");
  const manager = typeof b.manager === "string" ? b.manager.trim() : "";
  if (!manager) return errorResponse(400, "manager_required", "`manager` (slug or id) is required.");
  const mode = typeof b.mode === "string" ? (b.mode as SearchMode) : undefined;
  if (!mode || !VALID_MODES.includes(mode)) return errorResponse(400, "invalid_mode", `\`mode\` must be one of: ${VALID_MODES.join(", ")}.`);

  const req: TradeDiscoveryRequest = {
    league,
    manager,
    mode,
    target_player_id: typeof b.target_player_id === "string" ? b.target_player_id : undefined,
    sell_player_id: typeof b.sell_player_id === "string" ? b.sell_player_id : undefined,
    target_position: typeof b.target_position === "string" ? b.target_position : undefined,
    max_results: typeof b.max_results === "number" ? b.max_results : undefined,
    max_assets_per_side: typeof b.max_assets_per_side === "number" ? b.max_assets_per_side : undefined,
    include_three_team: b.include_three_team === true,
    constraints: sanitizeConstraints(b.constraints),
    include_strategic: b.include_strategic === true,
  };

  let result;
  try {
    result = await discoverTrades(req);
  } catch (error) {
    return errorResponse(500, "trade_discovery_error", error instanceof Error ? error.message : "Unknown error");
  }

  const httpStatus = result.status === "OK" ? 200 : result.status === "VALIDATION_FAILED" ? 422 : 503;
  return jsonResponse(result, { status: httpStatus, headers: { "Cache-Control": "no-store" } });
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
