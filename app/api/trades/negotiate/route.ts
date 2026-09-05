/**
 * POST /api/trades/negotiate — negotiation intelligence and offer strategy (Phase 5).
 *
 * Answers "how should I structure, present, and negotiate this trade?" —
 * NEVER "will they accept it?" Every offer, sweetener, counter, and
 * walk-away boundary is a real candidate scored by the same canonical
 * `validateTrade`/`evaluateTrade` pair `POST /api/trades/analyze` and
 * `POST /api/trades/discover` use (`lib/trades/discovery/candidate-eval.ts`).
 * Negotiation intelligence != acceptance probability: nothing in this
 * response is a percentage. Behavioral (manager-specific) intelligence
 * remains `INSUFFICIENT_DATA` until a real per-manager trade history exists
 * (see `calibration_status`/`behavioral_intelligence`).
 *
 * Read-only and stateless. Nothing is persisted or sent to any manager —
 * this endpoint has no write path to Sleeper or anywhere else.
 *
 * Request body (one of):
 *   { "league": "...", "manager": "...", "target_player_id": "13305" }        // ACQUIRE_TARGET
 *   { "league": "...", "manager": "...", "sell_player_id": "..." }             // SELL_ASSET
 *   { "league": "...", "manager": "...", "proposal": {...}, "mode": "..." }    // IMPROVE_OFFER / REDUCE_OVERPAY / COUNTER_PROPOSAL
 */

import { negotiateTrade } from "@/lib/trades/negotiation/negotiate";
import type { NegotiationMode, NegotiationRequest } from "@/lib/trades/negotiation/types";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 16 * 1024;
const VALID_MODES: NegotiationMode[] = ["ACQUIRE_TARGET", "SELL_ASSET", "IMPROVE_OFFER", "REDUCE_OVERPAY", "COUNTER_PROPOSAL"];

function sanitizeProposal(raw: unknown): NegotiationRequest["proposal"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.participants) || !r.participants.every((p) => typeof p === "string")) return undefined;
  if (!Array.isArray(r.transfers)) return undefined;
  const transfers: Array<{ from_manager_id: string; to_manager_id: string; canonical_player_id: string }> = [];
  for (const t of r.transfers) {
    if (!t || typeof t !== "object") return undefined;
    const tt = t as Record<string, unknown>;
    if (typeof tt.from_manager_id !== "string" || typeof tt.to_manager_id !== "string" || typeof tt.canonical_player_id !== "string") return undefined;
    transfers.push({ from_manager_id: tt.from_manager_id, to_manager_id: tt.to_manager_id, canonical_player_id: tt.canonical_player_id });
  }
  return { participants: r.participants as string[], transfers };
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

  const mode = typeof b.mode === "string" ? (b.mode as NegotiationMode) : undefined;
  if (mode && !VALID_MODES.includes(mode)) return errorResponse(400, "invalid_mode", `\`mode\` must be one of: ${VALID_MODES.join(", ")}.`);

  const req: NegotiationRequest = {
    league,
    manager,
    mode,
    target_player_id: typeof b.target_player_id === "string" ? b.target_player_id : undefined,
    sell_player_id: typeof b.sell_player_id === "string" ? b.sell_player_id : undefined,
    proposal: sanitizeProposal(b.proposal),
    untouchable_player_ids: Array.isArray(b.untouchable_player_ids) && b.untouchable_player_ids.every((x) => typeof x === "string") ? (b.untouchable_player_ids as string[]) : undefined,
  };

  let result;
  try {
    result = await negotiateTrade(req);
  } catch (error) {
    return errorResponse(500, "trade_negotiation_error", error instanceof Error ? error.message : "Unknown error");
  }

  const httpStatus = result.status === "OK" ? 200 : result.status === "VALIDATION_FAILED" ? 422 : 503;
  return jsonResponse(result, { status: httpStatus, headers: { "Cache-Control": "no-store" } });
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
