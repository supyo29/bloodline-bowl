/**
 * Shared server-side secret auth for mutation / scheduler endpoints.
 *
 * - Secrets are read from the environment, never returned, never logged.
 * - Comparison is timing-safe (constant-time over sha256 digests, so neither the
 *   value nor its length leaks).
 * - A missing env secret ⇒ the endpoint is DISABLED (401), never open.
 * - No query-string secret for mutation endpoints — it would land in access logs
 *   and browser history. Header only.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export type AuthResult =
  | { ok: true }
  | { ok: false; status: number; code: string; detail: string };

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function constantTimeEquals(a: string, b: string): boolean {
  // Hash both sides to fixed 32-byte buffers so `timingSafeEqual` never throws
  // on a length mismatch and the comparison reveals nothing about `b`.
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Authorize a request against `process.env[envName]`.
 *
 * Accepts the secret in either `Authorization: Bearer <secret>` or
 * `X-<Header>: <secret>` (e.g. `X-Refresh-Secret`). Never reads the query string.
 */
export function authorizeSecret(
  request: Request,
  envName: string,
  opts: { header?: string } = {},
): AuthResult {
  const expected = process.env[envName]?.trim();
  if (!expected) {
    return {
      ok: false,
      status: 401,
      code: "endpoint_disabled",
      detail: `${envName} is not configured; this endpoint is disabled.`,
    };
  }

  const authz = request.headers.get("authorization");
  const bearer = authz?.toLowerCase().startsWith("bearer ")
    ? authz.slice(7).trim()
    : null;
  const custom = opts.header ? request.headers.get(opts.header)?.trim() ?? null : null;
  const provided = bearer ?? custom;

  if (!provided) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      detail: "Missing credentials. Send Authorization: Bearer <secret>.",
    };
  }
  if (!constantTimeEquals(provided, expected)) {
    return { ok: false, status: 401, code: "unauthorized", detail: "Invalid credentials." };
  }
  return { ok: true };
}
