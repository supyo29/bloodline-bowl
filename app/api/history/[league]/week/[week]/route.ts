/**
 * GET /api/history/{league}/week/{week}
 *
 * Historical snapshot retrieval from the durable SnapshotStore. Returns the
 * preferred (latest) capture for the week plus metadata for every retained
 * capture — earlier versions are never destroyed.
 *
 * Query: ?capture_type=PRE_WEEK|MID_WEEK|FINAL|AD_HOC  ?season=2026  ?versions=1
 *
 * If persistence is not configured this returns an explicit
 * `PERSISTENCE_NOT_CONFIGURED` state, not an empty success.
 */

import { resolveLeagueStrict } from "@/lib/leagues/resolve";
import { getPersistence } from "@/lib/persistence";
import type { CaptureType } from "@/lib/persistence/types";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const CAPTURE_TYPES: CaptureType[] = ["PRE_WEEK", "MID_WEEK", "FINAL", "AD_HOC"];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ league: string; week: string }> },
): Promise<Response> {
  const { league: leagueSlug, week: weekRaw } = await params;
  const url = new URL(request.url);

  const resolution = resolveLeagueStrict(leagueSlug);
  if (!resolution.ok) {
    return errorResponse(resolution.status, resolution.code, resolution.detail);
  }
  const league = resolution.league;

  const week = Number.parseInt(weekRaw, 10);
  if (!Number.isInteger(week) || week < 0 || week > 25) {
    return errorResponse(400, "invalid_week", "week must be an integer 0..25.");
  }

  const seasonRaw = url.searchParams.get("season");
  const season = seasonRaw ? Number.parseInt(seasonRaw, 10) : league.season;
  if (!Number.isInteger(season)) {
    return errorResponse(400, "invalid_season", "season must be a 4-digit year.");
  }

  const captureTypeRaw = url.searchParams.get("capture_type");
  const captureType =
    captureTypeRaw && CAPTURE_TYPES.includes(captureTypeRaw as CaptureType)
      ? (captureTypeRaw as CaptureType)
      : undefined;

  const persistence = getPersistence();
  const status = await persistence.snapshots.status();
  if (status !== "READY") {
    return jsonResponse(
      {
        status,
        detail:
          status === "PERSISTENCE_NOT_CONFIGURED"
            ? "Snapshot persistence is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)."
            : "Snapshot persistence is currently erroring.",
        league_slug: league.league_slug,
        season,
        week,
        snapshot: null,
        versions: [],
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  const key = { league_slug: league.league_slug, season, week, capture_type: captureType };
  const [latest, versions] = await Promise.all([
    persistence.snapshots.getLatest(key),
    persistence.snapshots.listVersions(key),
  ]);

  if (!latest) {
    return jsonResponse(
      {
        status: "NOT_CAPTURED",
        detail: `No snapshot has been captured for ${league.league_slug} ${season} week ${week}${
          captureType ? ` (${captureType})` : ""
        }.`,
        league_slug: league.league_slug,
        season,
        week,
        snapshot: null,
        versions: [],
      },
      { status: 200, headers: { "Cache-Control": cacheHeader(30, 120) } },
    );
  }

  return jsonResponse(
    {
      status: "READY",
      league_slug: league.league_slug,
      season,
      week,
      preferred_capture: {
        id: latest.id,
        capture_type: latest.capture_type,
        captured_at: latest.captured_at,
        schema_version: latest.schema_version,
      },
      versions,
      snapshot: url.searchParams.get("versions") === "1" ? null : latest.payload,
    },
    { headers: { "Cache-Control": cacheHeader(300, 3600) } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
