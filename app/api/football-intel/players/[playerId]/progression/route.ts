/**
 * GET /api/football-intel/players/{playerId}/progression
 *
 * Current/historical raw FTN read_thrown codes for actual receiver targets.
 * DESCRIPTIVE_ONLY: the bucket is the code recorded on the thrown target; this
 * endpoint never infers the unthrown progression order for other receivers and
 * intentionally withholds first/second/third-read labels for numeric codes
 * (UNVERIFIED_SOURCE_CONFLICT).
 */
import { loadFootballIntelligence } from "@/lib/football-intel";
import { receiverProgression, summarizeReceiverProgression } from "@/lib/football-intel/progression";
import { cacheHeader, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function intParam(value: string | null, min: number, max: number): number | null {
  if (value == null || value === "") return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ playerId: string }> },
): Promise<Response> {
  const { playerId } = await params;
  const fi = loadFootballIntelligence();
  if (!fi) {
    return jsonResponse(
      { status: "NOT_AVAILABLE", detail: "Football Intelligence snapshot is not published.", data: null },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = new URL(request.url);
  const seasonRaw = url.searchParams.get("season");
  const weekRaw = url.searchParams.get("week");
  const season = seasonRaw == null ? fi.manifest.season : intParam(seasonRaw, 2000, 2100);
  const week = weekRaw == null ? null : intParam(weekRaw, 1, 22);

  if (season == null || (weekRaw != null && week == null)) {
    return jsonResponse(
      { status: "INVALID_QUERY", detail: "season must be a valid year and week must be an integer 1..22.", data: null },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const rows = receiverProgression(
    playerId,
    { season, ...(week == null ? {} : { week }) },
  );
  const ftnCutoff = fi.manifest.data_cutoff.ftn_charting ?? null;
  const currentSeasonSourceLag =
    season === fi.manifest.season &&
    (ftnCutoff == null || (week != null && week > ftnCutoff));
  const status = rows.length > 0 ? "READY" : currentSeasonSourceLag ? "EXPECTED_SOURCE_LAG" : "NOT_AVAILABLE";
  const summary = summarizeReceiverProgression(rows);

  return jsonResponse(
    {
      status,
      player_id: playerId,
      season,
      week,
      lineage: {
        football_intelligence_version: fi.manifest.football_intelligence_version,
        snapshot_through_week: fi.manifest.through_week,
        ftn_charting_through_week: ftnCutoff,
        output_class: "DESCRIPTIVE_ONLY",
        source: "FTN Data via nflverse",
        numeric_read_semantics_status: "UNVERIFIED_SOURCE_CONFLICT",
        read_semantics:
          "RAW_0/RAW_1/RAW_2 = raw FTN numeric read_thrown codes 0/1/2 (meaning unverified; NOT labelled first/second/third read). CHK=CHECKDOWN, DES=DESIGNED, SD=SCRAMBLE_DRILL.",
        limitation:
          "The bucket is the raw code on the target that was thrown. It does not reveal every receiver's full unthrown progression on the play. Numeric codes are intentionally not interpreted as first/second/third read: the current nflreadr dictionary definitions (0=first, 1=second, 2=third-plus, introduced by PR #319) conflict with observed FTN distributions, and the original nflverse issue #216 checklist enumerated only 1, 2, CHK, SD and DES (its parenthetical 'read 0, eg screens' referred to the designed-read concept, not literal numeric 0). No cited FTN confirmation resolves the discrepancy, so numeric semantics are intentionally withheld.",
      },
      summary,
      rows,
    },
    { headers: { "Cache-Control": status === "READY" ? cacheHeader(300, 900) : cacheHeader(60, 180) } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
