/**
 * POST /api/scoring/calculate — apply Bloodline Bowl's live scoring settings to
 * a caller-supplied stat line. Useful for simulations ("what would this stat
 * line have scored?") without hand-computing the league's rules.
 *
 * Read-only and stateless: nothing is persisted, no authentication is needed.
 * Input is strictly validated — only stat keys the league's own scoring
 * settings actually define are accepted, and the payload is bounded so this
 * can never be used to smuggle an arbitrarily large body through the API.
 */

import { getLeague } from "@/lib/sleeper/client";
import { SleeperError } from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { calculateFantasyPoints } from "@/lib/scoring/calculate";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";
import type { StatLine } from "@/lib/scoring/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Generous for a single game's box score; rejects anything absurd. */
const MAX_STAT_KEYS = 60;
const MAX_ABS_STAT_VALUE = 100_000;
/** Rejects an oversized body before it is even parsed. */
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request): Promise<Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return errorResponse(
      413,
      "payload_too_large",
      `Request body must be under ${MAX_BODY_BYTES} bytes.`,
    );
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      return errorResponse(
        413,
        "payload_too_large",
        `Request body must be under ${MAX_BODY_BYTES} bytes.`,
      );
    }
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "invalid_body", "Expected a JSON object.");
  }

  const stats = (body as Record<string, unknown>).stats;
  if (typeof stats !== "object" || stats === null || Array.isArray(stats)) {
    return errorResponse(
      400,
      "invalid_stats",
      'Expected `{ "stats": { "<sleeper_stat_key>": <number>, ... } }`.',
    );
  }

  const statEntries = Object.entries(stats as Record<string, unknown>);
  if (statEntries.length === 0) {
    return errorResponse(400, "empty_stats", "`stats` must contain at least one key.");
  }
  if (statEntries.length > MAX_STAT_KEYS) {
    return errorResponse(
      400,
      "too_many_stats",
      `\`stats\` may contain at most ${MAX_STAT_KEYS} keys.`,
    );
  }

  const leagueId = resolveLeagueId();
  let scoringSettings: Record<string, number>;
  try {
    const league = await getLeague(leagueId);
    scoringSettings = league.scoring_settings ?? {};
  } catch (error) {
    if (error instanceof SleeperError) {
      return errorResponse(502, "sleeper_upstream_error", error.message);
    }
    return errorResponse(
      500,
      "internal_error",
      error instanceof Error ? error.message : "Unknown error",
    );
  }

  // Only stat keys this league's own scoring settings define are accepted —
  // this is what keeps the endpoint from becoming an arbitrary compute sink.
  const knownKeys = new Set(Object.keys(scoringSettings));
  const rejected: string[] = [];
  const stat_line: StatLine = {};

  for (const [key, value] of statEntries) {
    if (!knownKeys.has(key)) {
      rejected.push(key);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return errorResponse(
        400,
        "invalid_stat_value",
        `Stat '${key}' must be a finite number.`,
      );
    }
    if (Math.abs(value) > MAX_ABS_STAT_VALUE) {
      return errorResponse(
        400,
        "stat_value_out_of_range",
        `Stat '${key}' must have a magnitude under ${MAX_ABS_STAT_VALUE}.`,
      );
    }
    stat_line[key] = value;
  }

  if (Object.keys(stat_line).length === 0) {
    return errorResponse(
      400,
      "no_recognized_stats",
      `None of the supplied stat keys are part of this league's scoring settings. Rejected: ${rejected.join(", ")}`,
    );
  }

  const result = calculateFantasyPoints(stat_line, scoringSettings);
  if (rejected.length > 0) {
    result.warnings.push(
      `Rejected unknown stat key(s) not in this league's scoring settings: ${rejected.join(", ")}.`,
    );
  }

  return jsonResponse(
    {
      generated_at: new Date().toISOString(),
      league_id: leagueId,
      fantasy_points: result.fantasy_points,
      breakdown: result.breakdown,
      warnings: result.warnings,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
