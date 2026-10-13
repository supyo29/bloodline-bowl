/**
 * GET /api/ai/compact — compact, link-only discovery index for web-retrieval agents.
 *
 * `/api/ai` (≈40 KB) is the authoritative contract, but most of its navigable
 * URLs are relative paths or `{placeholder}` templates. Browsing tools such as
 * ordinary ChatGPT web retrieval generally open only URLs that appear verbatim
 * in a fetched document; they do not resolve relative paths inside JSON
 * strings or substitute template variables. This index lists every entry point
 * as an ABSOLUTE, fully concrete URL (current NFL week filled in when it can be
 * resolved) so a retrieval agent can follow links without constructing any.
 *
 * Additive only: it changes no existing route and duplicates no analysis.
 * One cheap, cached Sleeper NFL-state read (bounded by a timeout) supplies the
 * current week; if it fails, weekly URLs are omitted and the reason is stated.
 */

import {
  PRODUCTION_BASE_URL,
  SERVICE_DESCRIPTION,
  absoluteUrl,
  discoveryLeagues,
  discoveryManagers,
} from "@/lib/discovery";
import { getNflState } from "@/lib/sleeper/client";
import { cacheHeader, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WEEK_LOOKUP_TIMEOUT_MS = 2_500;

// Same source and revalidation (300 s) the weekly engine uses for its current-week gate
// (lib/providers/sleeper/provider.ts), so advertised weekly URLs match what the engine serves.
async function currentNflWeek(): Promise<{ status: "RESOLVED" | "UNAVAILABLE"; week: number | null; detail: string }> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), WEEK_LOOKUP_TIMEOUT_MS));
  const state = await Promise.race([getNflState().catch(() => null), timeout]);
  const week = Number(state?.week);
  if (!state || !Number.isInteger(week) || week < 1) {
    return { status: "UNAVAILABLE", week: null, detail: "Current NFL week could not be resolved; weekly URLs omitted. Read state.current_week from a league state_url." };
  }
  return { status: "RESOLVED", week, detail: `Sleeper NFL state week ${week}.` };
}

export async function GET(): Promise<Response> {
  const { status: weekStatus, week, detail: weekDetail } = await currentNflWeek();
  const generatedAt = new Date().toISOString();
  const leagues = discoveryLeagues();

  const body = {
    service: SERVICE_DESCRIPTION.name,
    read_only: true,
    contains_secrets: false,
    instructions: [
      "Every URL below is absolute and concrete — open it as-is; do not edit or construct URLs.",
      "HTTP 200 means only that the route resolved. Check each body's status / warnings / *_status fields before treating data as actionable.",
      "Weekly routes serve only the league's current week; any other week returns NON_CURRENT_WEEK_UNSUPPORTED.",
    ],
    links: {
      full_contract: absoluteUrl("/api/ai"),
      llms_txt: absoluteUrl("/llms.txt"),
      human_overview: absoluteUrl("/ai"),
      health: absoluteUrl("/api/health"),
      leagues: absoluteUrl("/api/leagues"),
      providers: absoluteUrl("/api/providers"),
    },
    current_week: { status: weekStatus, week, source: "sleeper_nfl_state", resolved_at: generatedAt, detail: weekDetail },
    leagues: leagues.map((l) => ({
      league_slug: l.league_slug,
      league_name: l.league_name,
      provider: l.provider,
      config_status: l.config_status,
      state_url: absoluteUrl(l.canonical_urls.state),
      transactions_url: absoluteUrl(l.canonical_urls.transactions),
      ...(l.sleeper_only_urls
        ? {
            overview_url: absoluteUrl(l.sleeper_only_urls.overview),
            managers_url: absoluteUrl(l.sleeper_only_urls.managers),
            snapshot_url: absoluteUrl(l.sleeper_only_urls.snapshot),
          }
        : {}),
    })),
    managers: discoveryManagers().map((m) => {
      const lw = (cap: string) => absoluteUrl(`/api/${cap}/${m.league_slug}/${m.manager_slug}/week/${week}`);
      return {
        manager_slug: m.manager_slug,
        league_slug: m.league_slug,
        home_url: absoluteUrl(m.canonical_url),
        snapshot_url: absoluteUrl(`${m.canonical_url}/snapshot`),
        context_url: absoluteUrl(`/api/context/${m.league_slug}/${m.manager_slug}`),
        ...(week != null
          ? {
              weekly_intelligence_url: lw("intelligence"),
              lineup_url: lw("lineup"),
              matchup_url: lw("matchup"),
              waivers_url: lw("waivers"),
            }
          : {}),
      };
    }),
    meta: {
      generated_at: generatedAt,
      note: "This index carries links only, never analysis. Each linked response states its own freshness and status.",
      production_base_url: PRODUCTION_BASE_URL,
    },
  };

  return jsonResponse(body, {
    headers: {
      // Short edge cache: at a week rollover the weekly links refresh within ~2 min. A stale link
      // fails explicitly (NON_CURRENT_WEEK_UNSUPPORTED); it never serves another week's data.
      "Cache-Control": cacheHeader(60, 60),
      "X-Bridge-Context": "ai-discovery-compact",
    },
  });
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
