/**
 * POST /api/trades/competitive — competitive trade intelligence.
 *
 * Semantically SEPARATE from `POST /api/trades/discover` (legacy mutual-benefit
 * trade discovery). This endpoint optimizes OUR championship equity subject to
 * the deal staying plausibly acceptable to the counterparty — the other
 * manager's improvement is a cost, not an objective.
 *
 * It exposes the certified competitive engine WITHOUT weakening its semantics:
 *   - `status: NO_ACTION` is a SUCCESSFUL analytical result (HTTP 200), not an
 *     error or a "not ready" state.
 *   - `status: REVIEW_REQUIRED` is preserved — it is never softened into a
 *     "BUY" / "TRADE" / "CONSIDER" recommendation.
 *   - confidence (VERY_LOW / LOW / MEDIUM / HIGH) and readiness pass through
 *     unchanged; they are never upgraded at the HTTP layer.
 *
 * Modes (`mode`):
 *   - "evaluate"      — evaluate one explicit proposal (give_assets / receive_assets / counterparty)
 *   - "negotiate"     — the base deal plus the value-extraction / negotiation envelope
 *   - "discover"      — search for competitively certified direct trades for the requester
 *   - "strategy_path" — direct vs hold vs buy-and-hold vs two-step vs no-action
 *
 * READ-ONLY analytics. This route never submits, accepts, or modifies a trade,
 * never creates a provider transaction, and never sends a message.
 *
 * Request body:
 *   {
 *     "league": "bloodline-bowl",
 *     "manager": "supyo29",
 *     "mode": "evaluate",
 *     "counterparty": "some-manager",
 *     "give_assets": ["Rhamondre Stevenson"],
 *     "receive_assets": ["Chuba Hubbard"]
 *   }
 */

import {
  evaluateCompetitiveTradeRequest,
  type CompetitiveTradeApiRequest,
  type CompetitiveTradeMode,
  type NegotiationAggressiveness,
} from "@/lib/trades/competitive/api";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 90;

const MAX_BODY_BYTES = 16 * 1024;
const VALID_MODES: CompetitiveTradeMode[] = ["evaluate", "negotiate", "discover", "strategy_path"];
const VALID_AGGRESSIVENESS: NegotiationAggressiveness[] = ["CONSERVATIVE", "BALANCED", "AGGRESSIVE_BUT_CREDIBLE"];
const MAX_ASSETS_PER_SIDE = 5;

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  if (!v.every((x) => typeof x === "string" && x.trim().length > 0)) return undefined;
  return v.map((x) => (x as string).trim());
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
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "invalid_body", "Expected a JSON object.");
  }
  const b = body as Record<string, unknown>;

  const league = typeof b.league === "string" ? b.league.trim() : "";
  if (!league) return errorResponse(400, "league_required", "`league` (registry slug) is required.");
  const manager = typeof b.manager === "string" ? b.manager.trim() : "";
  if (!manager) return errorResponse(400, "manager_required", "`manager` (slug or id) is required.");
  const mode = typeof b.mode === "string" ? (b.mode as CompetitiveTradeMode) : undefined;
  if (!mode || !VALID_MODES.includes(mode)) {
    return errorResponse(400, "invalid_mode", `\`mode\` must be one of: ${VALID_MODES.join(", ")}.`);
  }

  const give = strArray(b.give_assets);
  const receive = strArray(b.receive_assets);
  if (b.give_assets != null && give === undefined) return errorResponse(400, "invalid_give_assets", "`give_assets` must be an array of non-empty strings.");
  if (b.receive_assets != null && receive === undefined) return errorResponse(400, "invalid_receive_assets", "`receive_assets` must be an array of non-empty strings.");
  if ((give?.length ?? 0) > MAX_ASSETS_PER_SIDE || (receive?.length ?? 0) > MAX_ASSETS_PER_SIDE) {
    return errorResponse(400, "too_many_assets", `At most ${MAX_ASSETS_PER_SIDE} assets per side.`);
  }

  let aggressiveness: NegotiationAggressiveness | undefined;
  if (b.negotiation_aggressiveness != null) {
    if (typeof b.negotiation_aggressiveness !== "string" || !VALID_AGGRESSIVENESS.includes(b.negotiation_aggressiveness as NegotiationAggressiveness)) {
      return errorResponse(400, "invalid_aggressiveness", `\`negotiation_aggressiveness\` must be one of: ${VALID_AGGRESSIVENESS.join(", ")}.`);
    }
    aggressiveness = b.negotiation_aggressiveness as NegotiationAggressiveness;
  }

  const searchLimits =
    b.search_limits && typeof b.search_limits === "object" && !Array.isArray(b.search_limits)
      ? { max_results: typeof (b.search_limits as Record<string, unknown>).max_results === "number" ? ((b.search_limits as Record<string, unknown>).max_results as number) : undefined }
      : undefined;

  const req: CompetitiveTradeApiRequest = {
    league,
    manager,
    mode,
    counterparty: typeof b.counterparty === "string" ? b.counterparty.trim() : undefined,
    give_assets: give,
    receive_assets: receive,
    target_player: typeof b.target_player === "string" ? b.target_player.trim() : undefined,
    negotiation_aggressiveness: aggressiveness,
    search_limits: searchLimits,
  };

  let result;
  try {
    result = await evaluateCompetitiveTradeRequest(req);
  } catch (error) {
    return errorResponse(500, "competitive_trade_error", error instanceof Error ? error.message : "Unknown error");
  }

  // A valid analytical result — including NO_ACTION and REVIEW_REQUIRED — is HTTP 200.
  const httpStatus =
    result.error_kind === "MALFORMED"
      ? 400
      : result.error_kind === "NOT_FOUND"
        ? 404
        : result.error_kind === "OWNERSHIP" || result.error_kind === "STRUCTURAL"
          ? 409
          : result.error_kind === "CONTEXT_UNAVAILABLE"
            ? 503
            : result.error_kind === "INTERNAL"
              ? 500
              : 200;

  return jsonResponse(result, { status: httpStatus, headers: { "Cache-Control": "no-store" } });
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
