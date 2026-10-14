/**
 * The one response envelope every Bloodline Bowl MCP tool returns.
 *
 * `status` is the bridge's own status, copied verbatim (READY,
 * PROJECTIONS_PARTIAL, UNAVAILABLE, NON_CURRENT_WEEK_UNSUPPORTED, ...).
 * `actionability` is a conservative connector summary of that status plus the
 * readiness/degradation signals in the body: it can only be lowered, so a
 * degraded bridge response never reads as a confident one because the MCP call
 * itself succeeded.
 */

import { MCP_ACCESS_MODE, MCP_CONTRACT_VERSION, type Actionability, type Deployment } from "./contract";
import type { RouteResult } from "./invoke";
import { byteLength, obj, pick, str, type J } from "./json";

/** Hard cap on one tool result. Exceeding it is an explicit error, never a silent truncation. */
export const MAX_RESULT_BYTES = 120_000;

export interface ProvenanceEntry {
  route: string;
  path: string;
  http_status: number | null;
  upstream_bytes: number | null;
  ms: number;
}

export interface Envelope {
  contract_version: string;
  tool: string;
  access_mode: typeof MCP_ACCESS_MODE;
  status: string;
  status_source: "bridge" | "connector";
  actionability: Actionability;
  request: J;
  identity?: J;
  data: J | null;
  /** Deployment label of every top-level `data` section. */
  deployment: Record<string, Deployment>;
  /** Present only when the caller asked for shadow evidence. Never production predictions. */
  shadow_evidence?: J;
  limitations: string[];
  warnings: unknown[];
  provenance: {
    routes: ProvenanceEntry[];
    request_id?: string;
    league_snapshot_id: string | null;
    scoring_fingerprint: string | null;
    source_generated_at: string | null;
    served_at: string;
    response_bytes?: number;
  };
  error?: { code: string; detail: string; http_status?: number | null; candidates?: unknown[]; bridge?: J };
  next_steps?: string[];
}

const NOT_ACTIONABLE = new Set([
  "UNAVAILABLE",
  "BLOCKED",
  "ERROR",
  "NOT_AVAILABLE",
  "NOT_CAPTURED",
  "NON_CURRENT_WEEK_UNSUPPORTED",
  "INVALID_REQUEST",
  "INVALID_QUERY",
  "AUTH_REQUIRED",
  "UNKNOWN_TOPIC",
  "NOT_CONFIGURED",
  "PROVIDER_UNIMPLEMENTED",
  "INSUFFICIENT",
]);
const CLEAN = new Set(["READY", "OK", "HEALTHY", "AVAILABLE", "CERTIFIED", "COMPLETE", "FRESH", "ACCEPTABLE"]);

/** Bridge status for a route body: `status` when it is a string, else an `{ok:false,error}` code, else HTTP-derived. */
export function bridgeStatus(result: RouteResult): string {
  if (!result.ok) return result.code;
  const body = obj(result.body);
  const s = str(body.status);
  if (s) return s;
  if (body.ok === false) return (str(body.error) ?? "ERROR").toUpperCase();
  return result.http_status >= 200 && result.http_status < 300 ? "OK" : `HTTP_${result.http_status}`;
}

export function deriveActionability(status: string, signals: { limited?: boolean; informational?: boolean } = {}): Actionability {
  const s = status.toUpperCase();
  if (NOT_ACTIONABLE.has(s) || s.startsWith("HTTP_") || s.endsWith("_NOT_FOUND") || s.startsWith("UPSTREAM_")) return "NOT_ACTIONABLE";
  if (signals.informational) return "INFORMATIONAL";
  if (!CLEAN.has(s) || signals.limited) return "LIMITED";
  return "ACTIONABLE";
}

export function provenanceOf(result: RouteResult): ProvenanceEntry {
  return {
    route: result.route,
    path: result.path,
    http_status: result.http_status,
    upstream_bytes: result.ok ? result.bytes : null,
    ms: result.ms,
  };
}

export function newEnvelope(tool: string, request: J): Envelope {
  return {
    contract_version: MCP_CONTRACT_VERSION,
    tool,
    access_mode: MCP_ACCESS_MODE,
    status: "OK",
    status_source: "connector",
    actionability: "INFORMATIONAL",
    request,
    data: null,
    deployment: {},
    limitations: [],
    warnings: [],
    provenance: { routes: [], league_snapshot_id: null, scoring_fingerprint: null, source_generated_at: null, served_at: new Date().toISOString() },
  };
}

export function failEnvelope(env: Envelope, code: string, detail: string, extra: { http_status?: number | null; candidates?: unknown[]; next_steps?: string[] } = {}): Envelope {
  env.status = code;
  env.status_source = "connector";
  env.actionability = "NOT_ACTIONABLE";
  env.data = null;
  env.error = { code, detail, ...(extra.http_status !== undefined ? { http_status: extra.http_status } : {}), ...(extra.candidates ? { candidates: extra.candidates } : {}) };
  if (extra.next_steps) env.next_steps = extra.next_steps;
  return env;
}

/** Turn a non-2xx bridge route result into an error envelope that keeps the bridge's own code and detail. */
export function routeFailure(env: Envelope, result: RouteResult, nextSteps?: string[]): Envelope {
  env.provenance.routes.push(provenanceOf(result));
  const status = bridgeStatus(result);
  const body = result.ok ? obj(result.body) : {};
  const diagnostics = Array.isArray(body.diagnostics) ? body.diagnostics : [];
  const diagText = diagnostics.map((d) => str(obj(d).message)).filter((m): m is string => !!m).join(" ");
  const detail = result.ok ? str(body.detail) ?? (diagText || `HTTP ${result.http_status}`) : result.detail;
  failEnvelope(env, status, detail, { http_status: result.http_status, ...(nextSteps ? { next_steps: nextSteps } : {}) });
  // Keep the bridge's own structured error fields (codes, diagnostics) so the assistant can explain or fix the request.
  const bridge = pick(body, ["error", "error_kind", "diagnostics", "reasons", "readiness"]);
  if (env.error && Object.keys(bridge).length) env.error.bridge = bridge;
  env.status_source = result.ok ? "bridge" : "connector";
  return env;
}

/** Bridge detail text for any route result (error body `detail`, or the connector's own failure detail). */
export function resultDetail(result: RouteResult): string | null {
  return result.ok ? str(obj(result.body).detail) : result.detail;
}

export function isRouteSuccess(result: RouteResult): result is Extract<RouteResult, { ok: true }> {
  return result.ok && result.http_status >= 200 && result.http_status < 300;
}

/** MCP CallToolResult: the same object as structuredContent and as JSON text (for clients that read only `content`). */
export function toToolResult(env: Envelope): { content: Array<{ type: "text"; text: string }>; structuredContent: J; isError?: boolean } {
  let text = JSON.stringify(env);
  let size = byteLength(text);
  if (size > MAX_RESULT_BYTES) {
    const tooLarge = failEnvelope(
      { ...env, warnings: [], limitations: [] },
      "OUTPUT_TOO_LARGE",
      `The result is ${size} bytes, above the ${MAX_RESULT_BYTES}-byte limit. It was withheld rather than truncated; request detail="summary" or narrow the query.`,
    );
    text = JSON.stringify(tooLarge);
    size = byteLength(text);
    tooLarge.provenance.response_bytes = size;
    return { content: [{ type: "text", text: JSON.stringify(tooLarge) }], structuredContent: tooLarge as unknown as J, isError: true };
  }
  env.provenance.response_bytes = size;
  text = JSON.stringify(env);
  const isError = env.error !== undefined;
  return { content: [{ type: "text", text }], structuredContent: env as unknown as J, ...(isError ? { isError: true } : {}) };
}
