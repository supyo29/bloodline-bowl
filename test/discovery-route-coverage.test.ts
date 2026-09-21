/**
 * Phase 3.5B — every HTTP route is either advertised by AI discovery or on an explicit, reasoned allowlist.
 * Found: Team-Management (roster-health / schedule-planning / orchestrate), Player-Scheme (5 routes), the trade
 * POST routes and the Start/Sit evidence diagnostics were deployed and certified but invisible to /api/ai.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES } from "@/lib/discovery";

const ROOT = process.cwd();
const norm = (t: string) => t.split("?")[0]!.replace(/\{[^}]+\}/g, "*").replace(/\[[^\]]+\]/g, "*");

function routes(dir = "app/api", acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) routes(rel, acc);
    else if (e === "route.ts") acc.push("/" + dir.replace(/^app\//, ""));
  }
  return acc;
}

/** Routes intentionally NOT advertised to AI clients, with the reason. */
const UNADVERTISED: Record<string, string> = {
  "/api/ai": "the discovery entry point itself",
  "/api/trades/analyze": "legacy trade-engine POST analytics with a request body; discovery advertises only /api/trades/competitive (body schema + modes documented). Advertising these needs documented request schemas (Phase 3.5C prerequisite)",
  "/api/trades/discover": "legacy trade-engine POST analytics (see /api/trades/analyze)",
  "/api/trades/negotiate": "legacy trade-engine POST analytics (see /api/trades/analyze)",
  "/api/health": "operational probe, not a data capability",
  "/api/auth/yahoo/callback": "OAuth plumbing", "/api/auth/yahoo/connect": "OAuth plumbing", "/api/auth/yahoo/status": "OAuth plumbing",
  "/api/yahoo/auth/start": "OAuth plumbing", "/api/yahoo/oauth/callback": "OAuth plumbing", "/api/yahoo/status": "provider auth status",
  "/api/yahoo/diagnostics": "provider diagnostics", "/api/yahoo/leagues": "Yahoo provider (not yet a registered league source)", "/api/yahoo/leagues/*": "Yahoo provider",
  "/api/cron/capture": "scheduled job (auth-gated)", "/api/cron/publish": "scheduled job (auth-gated)", "/api/cron/waiver2-capture": "scheduled job (auth-gated)", "/api/refresh": "operator refresh (auth-gated)",
  "/api/bridge/board": "draft-board UI backend", "/api/draft/debug": "debug", "/api/raw": "raw provider passthrough (not a curated capability)",
  "/api/lineups": "superseded by lineups_history capability path form", "/api/league": "legacy query-form route", "/api/league/*/state": "legacy path form of league_state",
  "/api/snapshot/*": "legacy path form of league_snapshot", "/api/scoring/*": "legacy path form of scoring", "/api/scoring/calculate": "utility calculator",
  "/api/context/*/*": "path form of manager_context", "/api/leagues/*/snapshot": "advertised under a different id", "/api/leagues/*/projections/*": "advertised as player_projection",
  "/api/leagues/*/managers/*/snapshot": "advertised as manager_snapshot", "/api/leagues/*/managers/*/manage": "team-state building block consumed by orchestrate",
  "/api/leagues/*/manage": "team-state building block consumed by orchestrate", "/api/leagues/*/managers/*/strategic-context": "draft strategy building block",
  "/api/leagues/*/draft": "advertised as league_draft", "/api/leagues/*/managers/*/draft": "advertised as manager_draft",
  "/api/managers": "legacy manager directory", "/api/matchups": "legacy history form", "/api/player-weekly": "legacy stats form", "/api/roster-analysis": "legacy analysis form",
  "/api/standings": "legacy history form", "/api/projections": "legacy projections form", "/api/projections/*": "legacy projections form", "/api/providers": "advertised as providers",
  "/api/value": "legacy value form", "/api/weekly-stats": "legacy stats form", "/api/transactions": "legacy transactions form", "/api/history": "legacy history form",
  "/api/manager-availability": "legacy availability form", "/api/player-availability": "legacy availability form", "/api/draft": "legacy draft form", "/api/draft/*": "legacy draft form",
  "/api/leagues": "advertised as league_discovery", "/api/leagues/*": "advertised as league_overview", "/api/leagues/*/managers": "advertised as manager_directory",
  "/api/leagues/*/managers/*": "advertised as manager_home", "/api/leagues/*/scoring": "advertised as scoring", "/api/leagues/*/projections": "advertised as league_projections",
  "/api/leagues/*/managers/*/projections": "advertised as manager_projections", "/api/leagues/*/managers/*/recommendations": "advertised as manager_recommendations",
  "/api/snapshot": "legacy snapshot form", "/api/scoring": "legacy scoring form", "/api/lineups/*": "legacy lineup form",
};

test("every /api route is advertised by AI discovery or explicitly allowlisted with a reason", () => {
  const advertised = new Set(CAPABILITIES.map((c) => norm(c.route_template)));
  const missing = routes().filter((r) => !advertised.has(norm(r)) && !UNADVERTISED[norm(r)] && !UNADVERTISED[r]);
  assert.deepEqual(missing, [], `routes neither advertised nor allowlisted: ${missing.join(", ")}`);
});

test("every advertised capability resolves to a real route file, and the newly advertised intelligence routes are present", () => {
  for (const c of CAPABILITIES) {
    const base = c.route_template.split("?")[0]!.replace(/\{[^}]+\}/g, "[x]");
    const files = routes().map(norm);
    assert.ok(files.includes(norm(base)), `capability ${c.id} advertises ${c.route_template} but no route exists`);
  }
  const t = new Set(CAPABILITIES.map((c) => c.route_template));
  for (const must of [
    "/api/player-scheme", "/api/player-scheme/players/{playerId}", "/api/player-scheme/matchups/{playerId}/{opponent}",
    "/api/player-scheme/teams/{team}/offense", "/api/player-scheme/teams/{team}/defense",
    "/api/leagues/{leagueSlug}/roster-health", "/api/leagues/{leagueSlug}/managers/{managerSlug}/roster-health",
    "/api/leagues/{leagueSlug}/schedule-planning", "/api/leagues/{leagueSlug}/managers/{managerSlug}/schedule-planning",
    "/api/leagues/{leagueSlug}/orchestrate", "/api/leagues/{leagueSlug}/managers/{managerSlug}/orchestrate",
    "/api/football-intel/startsit-evidence",
  ]) assert.ok(t.has(must), `discovery is missing ${must}`);
});

test("advertised shadow / descriptive surfaces never claim to be predictive or production-active", () => {
  for (const c of CAPABILITIES.filter((x) => /player_scheme|startsit_evidence|orchestrate|roster_health|schedule_planning/.test(x.id))) {
    assert.doesNotMatch(c.description, /production[- ]active|PRODUCTION_ACTIVE|predicts? |will (win|score)/i, c.id);
    assert.match(c.description, /SHARED_|SHADOW|ADVISORY|READ-ONLY|DESCRIPTIVE/i, `${c.id} must state its nature`);
  }
  assert.ok(existsSync(join(ROOT, "app/api/ai/route.ts")) && readFileSync(join(ROOT, "lib/discovery.ts"), "utf8").includes("CAPABILITIES"));
});
