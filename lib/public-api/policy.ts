/**
 * Public fantasy-API access policy — the single source of truth for which
 * `/api/*` routes an anonymous client may call, and with which methods.
 *
 * The policy is keyed by ROUTE SAFETY, never by provider: a Sleeper-backed and a
 * Yahoo-backed league go through exactly the same rules. `proxy.ts` enforces it;
 * `test/public-api-policy.test.ts` fails if a `route.ts` file exists that this
 * table does not classify (so a new route can never be public by accident).
 *
 *   public-read     GET / HEAD / OPTIONS. Read-only fantasy data. Anonymous OK.
 *   public-compute  POST / OPTIONS. Stateless analysis over a request body
 *                   (nothing persisted). Anonymous OK; every other method denied.
 *   self-guarded    Passed through untouched: the route authenticates itself
 *                   (cron / refresh / diagnostics use secrets) or is part of the
 *                   OAuth redirect flow. The proxy adds no CORS and no public access.
 *   admin           Never public. Needs the REFRESH_SECRET, checked in the route.
 *
 * Anything under `/api` not listed here is denied (404) by the proxy.
 */

import { findLeagueTarget, listLeagueTargets } from "@/lib/leagues/registry";

export type RouteAccess = "public-read" | "public-compute" | "self-guarded" | "admin";
export type RouteCost = "standard" | "expensive";

export interface PolicyEntry {
  /** Next route template with `:param` segments, e.g. `/api/leagues/:leagueSlug/managers`. */
  template: string;
  access: RouteAccess;
  /** `expensive` = fans out to Yahoo (paginated/probing) and gets a tighter rate limit. */
  cost: RouteCost;
}

export const PUBLIC_API_POLICY: readonly PolicyEntry[] = [
  { template: "/api/ai", access: "public-read", cost: "standard" },
  { template: "/api/auth/yahoo/callback", access: "self-guarded", cost: "standard" },
  { template: "/api/auth/yahoo/connect", access: "self-guarded", cost: "standard" },
  { template: "/api/auth/yahoo/status", access: "self-guarded", cost: "standard" },
  { template: "/api/bridge/board", access: "public-read", cost: "standard" },
  { template: "/api/calibration/report", access: "public-read", cost: "standard" },
  { template: "/api/context/:league/:manager", access: "public-read", cost: "standard" },
  { template: "/api/draft", access: "public-read", cost: "standard" },
  { template: "/api/draft/:leagueSlug", access: "public-read", cost: "standard" },
  { template: "/api/draft/debug", access: "public-read", cost: "standard" },
  { template: "/api/evidence", access: "public-read", cost: "standard" },
  { template: "/api/football-intel/players/:playerId/progression", access: "public-read", cost: "standard" },
  { template: "/api/football-intel/startsit-evidence", access: "public-read", cost: "standard" },
  { template: "/api/game-distribution/evaluate", access: "public-read", cost: "standard" },
  { template: "/api/game-distribution/report", access: "public-read", cost: "standard" },
  { template: "/api/health", access: "public-read", cost: "standard" },
  { template: "/api/history", access: "public-read", cost: "standard" },
  { template: "/api/history/:league/week/:week", access: "public-read", cost: "standard" },
  { template: "/api/intelligence/:league/:manager/week/:week", access: "public-read", cost: "standard" },
  { template: "/api/league", access: "public-read", cost: "standard" },
  { template: "/api/league/:league/state", access: "public-read", cost: "standard" },
  { template: "/api/leagues", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/draft", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/manage", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/managers", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/managers/:managerSlug", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/managers/:managerSlug/draft", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/managers/:managerSlug/manage", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/managers/:managerSlug/orchestrate", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/managers/:managerSlug/projections", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/managers/:managerSlug/recommendations", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/managers/:managerSlug/roster-health", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/managers/:managerSlug/schedule-planning", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/managers/:managerSlug/snapshot", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/managers/:managerSlug/strategic-context", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/orchestrate", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/projections", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/projections/:playerId", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/roster-health", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/schedule-planning", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/scoring", access: "public-read", cost: "standard" },
  { template: "/api/leagues/:leagueSlug/snapshot", access: "public-read", cost: "standard" },
  { template: "/api/lineup/:league/:manager/week/:week", access: "public-read", cost: "standard" },
  { template: "/api/lineups", access: "public-read", cost: "standard" },
  { template: "/api/manager-availability", access: "public-read", cost: "standard" },
  { template: "/api/managers", access: "public-read", cost: "standard" },
  { template: "/api/matchup/:league/:manager/week/:week", access: "public-read", cost: "standard" },
  { template: "/api/matchups", access: "public-read", cost: "standard" },
  { template: "/api/player-availability", access: "public-read", cost: "standard" },
  { template: "/api/player-scheme", access: "public-read", cost: "standard" },
  { template: "/api/player-scheme/matchups/:playerId/:opponent", access: "public-read", cost: "standard" },
  { template: "/api/player-scheme/players/:playerId", access: "public-read", cost: "standard" },
  { template: "/api/player-scheme/teams/:team/defense", access: "public-read", cost: "standard" },
  { template: "/api/player-scheme/teams/:team/offense", access: "public-read", cost: "standard" },
  { template: "/api/player-weekly", access: "public-read", cost: "standard" },
  { template: "/api/projections", access: "public-read", cost: "standard" },
  { template: "/api/projections/:playerId", access: "public-read", cost: "standard" },
  { template: "/api/providers", access: "public-read", cost: "standard" },
  { template: "/api/raw", access: "public-read", cost: "standard" },
  { template: "/api/refresh", access: "self-guarded", cost: "standard" },
  { template: "/api/role-calibration/evaluate", access: "public-read", cost: "standard" },
  { template: "/api/role-calibration/report", access: "public-read", cost: "standard" },
  { template: "/api/roster-analysis", access: "public-read", cost: "standard" },
  { template: "/api/scoring", access: "public-read", cost: "standard" },
  { template: "/api/scoring/:leagueSlug", access: "public-read", cost: "standard" },
  { template: "/api/scoring/calculate", access: "public-compute", cost: "standard" },
  { template: "/api/snapshot", access: "public-read", cost: "standard" },
  { template: "/api/snapshot/:leagueSlug", access: "public-read", cost: "standard" },
  { template: "/api/standings", access: "public-read", cost: "standard" },
  { template: "/api/trades/analyze", access: "public-compute", cost: "standard" },
  { template: "/api/trades/competitive", access: "public-compute", cost: "standard" },
  { template: "/api/trades/discover", access: "public-compute", cost: "standard" },
  { template: "/api/trades/negotiate", access: "public-compute", cost: "standard" },
  { template: "/api/transactions", access: "public-read", cost: "standard" },
  { template: "/api/transactions/:league", access: "public-read", cost: "standard" },
  { template: "/api/value", access: "public-read", cost: "standard" },
  { template: "/api/waivers/:league/:manager/week/:week", access: "public-read", cost: "standard" },
  { template: "/api/weekly-stats", access: "public-read", cost: "standard" },
  { template: "/api/yahoo/auth/start", access: "self-guarded", cost: "standard" },
  { template: "/api/yahoo/diagnostics", access: "self-guarded", cost: "standard" },
  { template: "/api/yahoo/leagues", access: "admin", cost: "standard" },
  { template: "/api/yahoo/leagues/:leagueId", access: "public-read", cost: "expensive" },
  { template: "/api/yahoo/leagues/:leagueId/players/available", access: "public-read", cost: "expensive" },
  { template: "/api/yahoo/leagues/:leagueId/provider-availability", access: "public-read", cost: "expensive" },
  { template: "/api/yahoo/oauth/callback", access: "self-guarded", cost: "standard" },
  { template: "/api/yahoo/status", access: "public-read", cost: "standard" },
];

/**
 * Prefix rules for route families that are classified as a group. `/api/cron/*`
 * are scheduler endpoints that each authenticate themselves with CRON_SECRET;
 * `test/public-api-policy.test.ts` asserts every cron route file calls the guard.
 */
export const PREFIX_RULES: readonly { prefix: string; access: RouteAccess; cost: RouteCost }[] = [
  { prefix: "/api/cron/", access: "self-guarded", cost: "standard" },
];

const READ_METHODS = ["GET", "HEAD", "OPTIONS"] as const;
const COMPUTE_METHODS = ["POST", "OPTIONS"] as const;

function compile(template: string): RegExp {
  const body = template
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${body}/?$`);
}

const COMPILED = PUBLIC_API_POLICY.map((entry) => ({ entry, re: compile(entry.template) }));

/** Static segments outrank `:param` segments so `/api/draft/debug` never loses to `/api/draft/:leagueSlug`. */
function specificity(template: string): number {
  return template.split("/").filter((s) => s && !s.startsWith(":")).length * 100 - template.split("/").filter((s) => s.startsWith(":")).length;
}

export function classifyPath(pathname: string): PolicyEntry | null {
  for (const rule of PREFIX_RULES) {
    if (pathname.startsWith(rule.prefix)) return { template: `${rule.prefix}*`, access: rule.access, cost: rule.cost };
  }
  let best: PolicyEntry | null = null;
  for (const { entry, re } of COMPILED) {
    if (re.test(pathname) && (!best || specificity(entry.template) > specificity(best.template))) best = entry;
  }
  return best;
}

export function allowedMethods(entry: PolicyEntry): readonly string[] {
  if (entry.access === "public-read") return READ_METHODS;
  if (entry.access === "public-compute") return COMPUTE_METHODS;
  return [];
}

/**
 * Yahoo league routes must only serve REGISTERED Yahoo leagues. The server holds
 * one Yahoo account's OAuth token; without this check an anonymous caller could
 * read any other league that account happens to belong to by guessing its id.
 */
export function isRegisteredYahooLeague(idOrSlug: string): boolean {
  const target = findLeagueTarget(idOrSlug) ?? findLeagueTarget(idOrSlug.toLowerCase());
  if (target) return target.provider === "yahoo";
  return listLeagueTargets().some((t) => t.provider === "yahoo" && t.external_league_id === idOrSlug);
}

/** `/api/yahoo/leagues/<id>[/...]` → `<id>`, else null. */
export function yahooLeagueParam(pathname: string): string | null {
  const m = /^\/api\/yahoo\/leagues\/([^/]+)(?:\/|$)/.exec(pathname);
  return m ? decodeURIComponent(m[1] as string) : null;
}

export type Decision =
  | { kind: "pass"; entry: PolicyEntry; cors: boolean }
  | { kind: "preflight"; entry: PolicyEntry }
  | { kind: "deny"; status: 404 | 405; code: string; detail: string; allow?: readonly string[] };

/** Pure request decision (no I/O) — what the proxy does with `method` + `pathname`. */
export function decide(method: string, pathname: string): Decision {
  const entry = classifyPath(pathname);
  if (!entry) return { kind: "deny", status: 404, code: "not_found", detail: "No such public API route." };
  if (entry.access === "self-guarded") return { kind: "pass", entry, cors: false };
  if (entry.access === "admin") return { kind: "pass", entry, cors: false };

  const allow = allowedMethods(entry);
  const m = method.toUpperCase();
  if (!allow.includes(m)) {
    return { kind: "deny", status: 405, code: "method_not_allowed", detail: `${m} is not allowed on this route.`, allow };
  }
  const yl = yahooLeagueParam(pathname);
  if (yl !== null && !isRegisteredYahooLeague(yl)) {
    return { kind: "deny", status: 404, code: "league_not_registered", detail: "Unknown or unregistered Yahoo league." };
  }
  if (m === "OPTIONS") return { kind: "preflight", entry };
  return { kind: "pass", entry, cors: true };
}
