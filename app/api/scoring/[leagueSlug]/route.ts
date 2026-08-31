/**
 * GET /api/scoring/:leagueSlug — flat alias for /api/leagues/:leagueSlug/scoring.
 * Same handler, same strict league resolver. Route-segment config is declared
 * locally because Next.js does not allow it to be re-exported.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export { GET, OPTIONS } from "@/app/api/leagues/[leagueSlug]/scoring/route";
