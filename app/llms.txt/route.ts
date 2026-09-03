/**
 * GET /llms.txt — concise plain-text guide for AI systems.
 *
 * Supplemental to the JSON manifest at /api/ai (which is authoritative). This
 * file exists so a crawler / model that only fetches /llms.txt still learns the
 * entry point and the identity rule.
 */

import {
  CAPABILITIES,
  GITHUB_REPOSITORY,
  PRODUCTION_BASE_URL,
  SERVICE_DESCRIPTION,
  discoveryLeagues,
  discoveryManagers,
} from "@/lib/discovery";
import { CORS_HEADERS } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const leagues = discoveryLeagues();
  const managers = discoveryManagers();

  const lines: string[] = [];
  lines.push(`# ${SERVICE_DESCRIPTION.name}`);
  lines.push("");
  lines.push(`> ${SERVICE_DESCRIPTION.purpose}`);
  lines.push("");
  lines.push(`Production base URL: ${PRODUCTION_BASE_URL}`);
  lines.push(`GitHub repository (methodology only, not required): ${GITHUB_REPOSITORY}`);
  lines.push(`Read-only: yes. No auth required for public leagues.`);
  lines.push("");
  lines.push("## Start here");
  lines.push("");
  lines.push(`Canonical AI entry point: ${PRODUCTION_BASE_URL}/api/ai`);
  lines.push(
    "Fetch it first. It returns the full service map: leagues, known managers, every capability, and concrete route templates. Follow the links it returns — do not guess URLs.",
  );
  lines.push("");
  lines.push("## Routing hierarchy (canonical)");
  lines.push("");
  lines.push("/api/ai");
  lines.push("  -> /api/leagues");
  lines.push("    -> /api/leagues/{leagueSlug}");
  lines.push("      -> /api/leagues/{leagueSlug}/managers");
  lines.push("        -> /api/leagues/{leagueSlug}/managers/{managerSlug}");
  lines.push("          -> specific analysis capability");
  lines.push("");
  lines.push("## Identity rule");
  lines.push("");
  lines.push(
    "League identity != manager identity. The league slug selects the league; the manager slug selects a team owner INSIDE it.",
  );
  lines.push(
    "Membership is validated live. A non-member manager returns a 4xx error, never a different manager. There is no cross-league fallback.",
  );
  lines.push(
    "Given only a manager username, find its league in the known-manager list below (or via /api/leagues/{leagueSlug}/managers), then descend league -> manager -> capability.",
  );
  lines.push("");
  lines.push("## Leagues");
  lines.push("");
  for (const l of leagues) {
    lines.push(
      `- ${l.league_slug} (${l.league_name}) — provider: ${l.provider}, status: ${l.config_status}${
        l.is_default ? ", default" : ""
      } — ${PRODUCTION_BASE_URL}/api/leagues/${l.league_slug}`,
    );
  }
  lines.push("");
  lines.push("## Known manager routes");
  lines.push("");
  for (const m of managers) {
    lines.push(
      `- ${m.manager_slug}${
        m.sleeper_username ? ` (Sleeper: ${m.sleeper_username})` : ""
      } — league ${m.league_slug} — ${PRODUCTION_BASE_URL}${m.canonical_url}`,
    );
  }
  lines.push("");
  lines.push("## Analysis capabilities");
  lines.push("");
  for (const c of CAPABILITIES) {
    lines.push(`- ${c.title} [${c.scope}]: ${c.route_template} — ${c.description}`);
  }
  lines.push("");
  lines.push("## Legacy compatibility");
  lines.push("");
  lines.push(
    "`?league=<slug>` query-form routes (e.g. /api/league?league=bloodline-bowl) still work but are legacy. Prefer the canonical path routes above. Let /api/ai tell you which capabilities are only available in the legacy form.",
  );
  lines.push("");

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
