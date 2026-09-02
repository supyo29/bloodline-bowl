/**
 * GET /api/transactions/{league}   (canonical, path-based)
 *
 * Normalized canonical transactions for one league. Reads from the durable
 * LedgerStore when persistence is configured and populated; otherwise falls
 * back to a LIVE provider read so the endpoint is useful before the first sync.
 * The `source` field always says which path was taken.
 *
 * Query: ?season=2026 ?week=5 ?type=trade ?team=<canonical_team_id> ?limit=100
 *
 * The legacy Sleeper-native `GET /api/transactions?league=<slug>` route is
 * unchanged and still available.
 */

import { resolveLeagueStrict } from "@/lib/leagues/resolve";
import { getProvider } from "@/lib/providers/registry";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { defaultCrosswalkSource } from "@/lib/persistence/supabase/crosswalk-source";
import { getPersistence } from "@/lib/persistence";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ league: string }> },
): Promise<Response> {
  const { league: leagueSlug } = await params;
  const url = new URL(request.url);

  const resolution = resolveLeagueStrict(leagueSlug);
  if (!resolution.ok) {
    return errorResponse(resolution.status, resolution.code, resolution.detail);
  }
  const league = resolution.league;

  const season = url.searchParams.get("season")
    ? Number.parseInt(url.searchParams.get("season")!, 10)
    : league.season;
  const week = url.searchParams.get("week") ? Number.parseInt(url.searchParams.get("week")!, 10) : null;
  const type = url.searchParams.get("type");
  const team = url.searchParams.get("team");
  const limit = url.searchParams.get("limit")
    ? Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("limit")!, 10)))
    : 200;

  const persistence = getPersistence();
  const ledgerStatus = await persistence.ledger.status();

  if (ledgerStatus === "READY") {
    const stored = await persistence.ledger.query({
      league_slug: league.league_slug,
      season,
      week,
      type,
      team_id: team,
      limit,
    });
    if (stored.length > 0) {
      return jsonResponse(
        {
          source: "ledger",
          league_slug: league.league_slug,
          season,
          count: stored.length,
          transactions: stored.map((s) => s.payload),
          ledger_meta: stored.map((s) => ({
            id: s.id,
            first_seen_at: s.first_seen_at,
            last_seen_at: s.last_seen_at,
          })),
        },
        { headers: { "Cache-Control": cacheHeader(30, 120) } },
      );
    }
  }

  // Fallback: live provider read.
  if (league.provider !== "sleeper") {
    return jsonResponse(
      {
        source: "unavailable",
        league_slug: league.league_slug,
        season,
        status: "AUTH_REQUIRED",
        detail: `Live transaction reads for provider "${league.provider}" require authenticated access. Run a sync once credentials exist.`,
        transactions: [],
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  const provider = getProvider(league.provider);
  const crosswalk = defaultCrosswalkSource()
    ? new PlayerCrosswalk(defaultCrosswalkSource()!)
    : new PlayerCrosswalk(NoCrosswalk);
  const live = await provider.getTransactions(
    {
      league_slug: league.league_slug,
      external_league_id: league.external_league_id,
      season,
      crosswalk,
    },
    { week, limit },
  );

  if (!live.data) {
    return errorResponse(502, live.warnings[0]?.code ?? "provider_error", live.warnings[0]?.message);
  }

  let txns = live.data;
  if (type) txns = txns.filter((t) => t.type === type);
  if (team) txns = txns.filter((t) => t.canonical_team_ids.includes(team));

  return jsonResponse(
    {
      source: "live_provider",
      league_slug: league.league_slug,
      season,
      count: txns.length,
      ledger_status: ledgerStatus,
      note:
        ledgerStatus === "READY"
          ? "Ledger is configured but has no rows for this filter yet — run syncLeagueTransactions."
          : "Ledger not configured; served live. Configure SUPABASE_* to persist history.",
      transactions: txns,
      warnings: live.warnings,
    },
    { headers: { "Cache-Control": cacheHeader(45, 180) } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
