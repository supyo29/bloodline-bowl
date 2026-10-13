/**
 * In-process invocation of existing bridge route handlers.
 *
 * Each MCP tool calls the SAME exported route handler a public HTTP client
 * reaches, with the same params, so a tool result can never diverge from the
 * route it wraps (test/mcp-parity.test.ts proves this byte-for-byte). No second
 * analytics path, no self-HTTP round trip, no re-implementation.
 *
 * The handlers are imported statically so the deployment bundle carries them.
 */

import { GET as leaguesGET } from "@/app/api/leagues/route";
import { GET as leagueStateGET } from "@/app/api/league/[league]/state/route";
import { GET as contextGET } from "@/app/api/context/[league]/[manager]/route";
import { GET as scoringGET } from "@/app/api/leagues/[leagueSlug]/scoring/route";
import { GET as intelligenceGET } from "@/app/api/intelligence/[league]/[manager]/week/[week]/route";
import { GET as lineupGET } from "@/app/api/lineup/[league]/[manager]/week/[week]/route";
import { GET as matchupGET } from "@/app/api/matchup/[league]/[manager]/week/[week]/route";
import { GET as waiversGET } from "@/app/api/waivers/[league]/[manager]/week/[week]/route";
import { GET as rosterHealthGET } from "@/app/api/leagues/[leagueSlug]/managers/[managerSlug]/roster-health/route";
import { GET as schedulePlanningGET } from "@/app/api/leagues/[leagueSlug]/managers/[managerSlug]/schedule-planning/route";
import { GET as orchestrateGET } from "@/app/api/leagues/[leagueSlug]/managers/[managerSlug]/orchestrate/route";
import { GET as strategicContextGET } from "@/app/api/leagues/[leagueSlug]/managers/[managerSlug]/strategic-context/route";
import { GET as historyWeekGET } from "@/app/api/history/[league]/week/[week]/route";
import { GET as leaguePlayerProjectionGET } from "@/app/api/leagues/[leagueSlug]/projections/[playerId]/route";
import { GET as evidenceGET } from "@/app/api/evidence/route";
import { POST as competitiveTradePOST } from "@/app/api/trades/competitive/route";
import { byteLength } from "./json";

/** Synthetic origin for in-process requests. Never fetched — handlers only parse it. */
const INTERNAL_ORIGIN = "https://mcp.internal.bloodline-bowl";

type Params = Record<string, string>;
type Handler = (request: Request, ctx: { params: Promise<Params> }) => Promise<Response>;

interface RouteSpec {
  /** Public route template, reported in provenance so a reader can reproduce the call. */
  template: string;
  method: "GET" | "POST";
  handler: Handler;
}

const asHandler = (h: unknown): Handler => h as Handler;

export const ROUTES = {
  leagues: { template: "/api/leagues", method: "GET", handler: asHandler(leaguesGET) },
  league_state: { template: "/api/league/{league}/state", method: "GET", handler: asHandler(leagueStateGET) },
  manager_context: { template: "/api/context/{league}/{manager}", method: "GET", handler: asHandler(contextGET) },
  scoring: { template: "/api/leagues/{leagueSlug}/scoring", method: "GET", handler: asHandler(scoringGET) },
  intelligence: { template: "/api/intelligence/{league}/{manager}/week/{week}", method: "GET", handler: asHandler(intelligenceGET) },
  lineup: { template: "/api/lineup/{league}/{manager}/week/{week}", method: "GET", handler: asHandler(lineupGET) },
  matchup: { template: "/api/matchup/{league}/{manager}/week/{week}", method: "GET", handler: asHandler(matchupGET) },
  waivers: { template: "/api/waivers/{league}/{manager}/week/{week}", method: "GET", handler: asHandler(waiversGET) },
  roster_health: { template: "/api/leagues/{leagueSlug}/managers/{managerSlug}/roster-health", method: "GET", handler: asHandler(rosterHealthGET) },
  schedule_planning: { template: "/api/leagues/{leagueSlug}/managers/{managerSlug}/schedule-planning", method: "GET", handler: asHandler(schedulePlanningGET) },
  orchestrate: { template: "/api/leagues/{leagueSlug}/managers/{managerSlug}/orchestrate", method: "GET", handler: asHandler(orchestrateGET) },
  strategic_context: { template: "/api/leagues/{leagueSlug}/managers/{managerSlug}/strategic-context", method: "GET", handler: asHandler(strategicContextGET) },
  history_week: { template: "/api/history/{league}/week/{week}", method: "GET", handler: asHandler(historyWeekGET) },
  player_projection: { template: "/api/leagues/{leagueSlug}/projections/{playerId}", method: "GET", handler: asHandler(leaguePlayerProjectionGET) },
  evidence: { template: "/api/evidence", method: "GET", handler: asHandler(evidenceGET) },
  competitive_trade: { template: "/api/trades/competitive", method: "POST", handler: asHandler(competitiveTradePOST) },
} as const satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof ROUTES;

export interface RouteCall {
  route: RouteName;
  params?: Params;
  query?: Record<string, string | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export type RouteResult =
  | {
      ok: true;
      route: RouteName;
      /** Concrete public path, e.g. /api/lineup/devoted-to-the-game/darthmarker/week/6. */
      path: string;
      http_status: number;
      body: unknown;
      bytes: number;
      ms: number;
    }
  | {
      ok: false;
      route: RouteName;
      path: string;
      http_status: number | null;
      code: "UPSTREAM_TIMEOUT" | "UPSTREAM_EXCEPTION" | "UPSTREAM_NON_JSON";
      detail: string;
      ms: number;
    };

export const DEFAULT_ROUTE_TIMEOUT_MS = 45_000;

/** Fill a `{param}` template — values are URI-encoded exactly as an HTTP client would. */
export function concretePath(template: string, params: Params = {}): string {
  return template.replace(/\{([^}]+)\}/g, (_, k: string) => encodeURIComponent(params[k] ?? `{${k}}`));
}

export function buildRequest(call: RouteCall): { request: Request; path: string } {
  const spec = ROUTES[call.route];
  const path = concretePath(spec.template, call.params);
  const url = new URL(path, INTERNAL_ORIGIN);
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const init: RequestInit = { method: spec.method, headers: { accept: "application/json" } };
  if (spec.method === "POST") {
    init.body = JSON.stringify(call.body ?? {});
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  return { request: new Request(url, init), path: url.pathname + url.search };
}

export async function callRoute(call: RouteCall): Promise<RouteResult> {
  const spec = ROUTES[call.route];
  const { request, path } = buildRequest(call);
  const started = Date.now();
  const timeoutMs = call.timeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const raced = await Promise.race([spec.handler(request, { params: Promise.resolve(call.params ?? {}) }), timeout]);
    if (raced === "timeout") {
      return { ok: false, route: call.route, path, http_status: null, code: "UPSTREAM_TIMEOUT", detail: `${spec.template} did not answer within ${timeoutMs} ms.`, ms: Date.now() - started };
    }
    const text = await raced.text();
    let body: unknown;
    try {
      body = text.length ? JSON.parse(text) : null;
    } catch {
      return { ok: false, route: call.route, path, http_status: raced.status, code: "UPSTREAM_NON_JSON", detail: `${spec.template} returned a non-JSON body (HTTP ${raced.status}).`, ms: Date.now() - started };
    }
    return { ok: true, route: call.route, path, http_status: raced.status, body, bytes: byteLength(text), ms: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      route: call.route,
      path,
      http_status: null,
      code: "UPSTREAM_EXCEPTION",
      // Message only — never a stack (it can carry file paths) and never request headers.
      detail: error instanceof Error ? error.message.slice(0, 300) : "unknown error",
      ms: Date.now() - started,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
