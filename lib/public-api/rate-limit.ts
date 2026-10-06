/**
 * Best-effort fixed-window rate limiter for the public API.
 *
 * Limits are per client IP, per cost tier, per server instance. On serverless an
 * instance's memory is not shared, so this is a safety net against runaway
 * scripts — NOT a hard global quota. A hard global limit needs Vercel's WAF rate
 * limiting or a shared store; see docs. Limits are deliberately generous so
 * analysis clients (including shared-egress AI hosts) are not throttled.
 */

import type { RouteCost } from "./policy";

export const RATE_LIMITS: Record<RouteCost, { limit: number; windowMs: number }> = {
  // Sleeper reads and cached/canonical reads.
  standard: { limit: 600, windowMs: 60_000 },
  // Yahoo fan-out: a full waiver-pool crawl is ~40 upstream requests.
  expensive: { limit: 60, windowMs: 60_000 },
};

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 5_000;

export interface RateResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export function checkRate(ip: string, cost: RouteCost, now: number = Date.now()): RateResult {
  const { limit, windowMs } = RATE_LIMITS[cost];
  const key = `${cost}:${ip}`;
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      if (buckets.size >= MAX_BUCKETS) buckets.clear();
    }
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  const allowed = b.count <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - b.count),
    resetAt: b.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
  };
}

export function resetRateLimits(): void {
  buckets.clear();
}

export function clientIp(headers: { get(name: string): string | null }): string {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || headers.get("x-real-ip")?.trim() || "unknown";
}
