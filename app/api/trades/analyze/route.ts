/**
 * POST /api/trades/analyze — multi-team trade analysis.
 *
 * Phase 1 (`ri-trade-foundation-2026.2`, FROZEN): how a proposed transaction
 * changes each participating manager's ACTUAL current-week roster utility —
 * every roster reconstructed before/after and re-run through the same
 * optimal-lineup / VOR / positional-need machinery used elsewhere. 2- and
 * 3-team trades are one code path; arbitrary transfer routing, no bilateral
 * reciprocity.
 *
 * Phase 2 (`ri-trade-contextual-2026.2`, ADDITIVE): a per-participant `phase2`
 * block with rest-of-season usable value, bye-week coverage, playoff window,
 * usable depth and roster fragility — assembled from ONE immutable league
 * snapshot (no second provider read). Every Phase 2 composite weight defaults to
 * 0 (components exposed, not folded in), so `contextual_utility_delta` equals
 * the Phase 1 `roster_utility_delta` unless a caller sets `config.phase2.weights`.
 * A Phase 2 failure never removes the frozen Phase 1 output.
 *
 * Read-only and stateless. Nothing is persisted.
 *
 * Request body:
 *   {
 *     "league": "bloodline-bowl",
 *     "participants": ["supyo29", "manager_b", "manager_c"],
 *     "transfers": [
 *       { "from_manager_id": "supyo29", "to_manager_id": "manager_b",
 *         "asset": { "type": "PLAYER", "player_id": "4046" } }
 *     ],
 *     "config": { "phase2": { "weights": { "ros_usable_value": 0 } }, ... }
 *   }
 */

import { analyzeTrade } from "@/lib/trades/analyze";
import type { TradeProposal, TradeTransfer } from "@/lib/trades/schema";
import type { PartialTradeConfig } from "@/lib/trades/config";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 90;

const MAX_BODY_BYTES = 32 * 1024;
const MAX_PARTICIPANTS = 6;
const MAX_TRANSFERS = 40;

export async function POST(request: Request): Promise<Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return errorResponse(413, "payload_too_large", `Request body must be under ${MAX_BODY_BYTES} bytes.`);
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      return errorResponse(413, "payload_too_large", `Request body must be under ${MAX_BODY_BYTES} bytes.`);
    }
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "invalid_body", "Expected a JSON object.");
  }
  const b = body as Record<string, unknown>;

  const league = typeof b.league === "string" ? b.league.trim() : "";
  if (!league) return errorResponse(400, "league_required", "`league` (registry slug) is required.");

  if (!Array.isArray(b.participants) || b.participants.length === 0) {
    return errorResponse(400, "participants_required", "`participants` must be a non-empty array of manager ids/slugs.");
  }
  if (b.participants.length > MAX_PARTICIPANTS) {
    return errorResponse(400, "too_many_participants", `At most ${MAX_PARTICIPANTS} participants.`);
  }
  const participants: Array<{ manager_id: string }> = b.participants.map((p): { manager_id: string } => {
    if (typeof p === "string") return { manager_id: p };
    const mid = p && typeof p === "object" ? (p as Record<string, unknown>).manager_id : undefined;
    return { manager_id: typeof mid === "string" ? mid : "" };
  });
  if (participants.some((p) => !p.manager_id)) {
    return errorResponse(400, "invalid_participant", "Each participant must be a non-empty string or `{ manager_id }`.");
  }

  if (!Array.isArray(b.transfers) || b.transfers.length === 0) {
    return errorResponse(400, "transfers_required", "`transfers` must be a non-empty array.");
  }
  if (b.transfers.length > MAX_TRANSFERS) {
    return errorResponse(400, "too_many_transfers", `At most ${MAX_TRANSFERS} transfers.`);
  }
  const transfers: TradeTransfer[] = [];
  for (const t of b.transfers) {
    if (!t || typeof t !== "object") {
      return errorResponse(400, "invalid_transfer", "Each transfer must be an object.");
    }
    const tt = t as Record<string, unknown>;
    const asset = tt.asset as Record<string, unknown> | undefined;
    if (asset && asset.type != null && asset.type !== "PLAYER") {
      return errorResponse(
        400,
        "unsupported_asset_type",
        `Phase 1 supports only "PLAYER" assets; got "${String(asset.type)}". Draft-pick and FAAB assets are out of scope.`,
      );
    }
    const playerId =
      asset && typeof asset.player_id === "string"
        ? asset.player_id
        : typeof tt.player_id === "string"
          ? (tt.player_id as string)
          : "";
    if (typeof tt.from_manager_id !== "string" || typeof tt.to_manager_id !== "string" || !playerId) {
      return errorResponse(
        400,
        "invalid_transfer",
        "Each transfer needs `from_manager_id`, `to_manager_id`, and `asset.player_id`.",
      );
    }
    transfers.push({
      from_manager_id: tt.from_manager_id,
      to_manager_id: tt.to_manager_id,
      asset: { type: "PLAYER", player_id: playerId },
    });
  }

  const proposal: TradeProposal = { league, participants, transfers };
  const config = (b.config && typeof b.config === "object" && !Array.isArray(b.config)
    ? (b.config as PartialTradeConfig)
    : undefined);

  let analysis;
  try {
    analysis = await analyzeTrade(proposal, { config });
  } catch (error) {
    return errorResponse(500, "trade_analysis_error", error instanceof Error ? error.message : "Unknown error");
  }

  const httpStatus =
    analysis.status === "OK" ? 200 : analysis.status === "VALIDATION_FAILED" ? 422 : 503;
  return jsonResponse(analysis, { status: httpStatus, headers: { "Cache-Control": "no-store" } });
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
