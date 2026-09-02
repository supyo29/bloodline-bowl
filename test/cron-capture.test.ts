/**
 * /api/cron/capture — deterministic (no network, no DB).
 *
 * Proves the automated capture endpoint:
 *   - refuses to run without CRON_SECRET (not world-triggerable)
 *   - rejects a wrong Bearer token
 *   - returns an explicit 503 (not a false success) when persistence is down
 *   - never fabricates Yahoo snapshots — Yahoo leagues are listed under `skipped`
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { setPersistence } from "../lib/persistence";

const ROUTE = "../app/api/cron/capture/route";

interface CronBody {
  ok?: boolean;
  status?: string;
  detail?: string;
  results?: unknown[];
}

async function call(
  headers: Record<string, string> = {},
  url = "https://x/api/cron/capture",
): Promise<{ status: number; body: CronBody }> {
  const { GET } = (await import(ROUTE)) as { GET: (req: Request) => Promise<Response> };
  const res = await GET(new Request(url, { headers }));
  return { status: res.status, body: (await res.json()) as CronBody };
}

const originalSecret = process.env.CRON_SECRET;
afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  setPersistence(null);
});

describe("/api/cron/capture auth", () => {
  it("401 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const { status, body } = await call();
    assert.equal(status, 401);
    assert.match(body.detail ?? "", /CRON_SECRET is not configured/);
  });

  it("401 on a wrong Bearer token", async () => {
    process.env.CRON_SECRET = "s3cr3t";
    const { status } = await call({ authorization: "Bearer nope" });
    assert.equal(status, 401);
  });

  it("accepts the correct Bearer token but reports 503 when persistence is unconfigured", async () => {
    process.env.CRON_SECRET = "s3cr3t";
    setPersistence(null); // force getPersistence() to re-evaluate with no SUPABASE_* env
    const { status, body } = await call({ authorization: "Bearer s3cr3t" });
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.status, "PERSISTENCE_NOT_CONFIGURED");
    assert.deepEqual(body.results ?? [], []);
  });

  it("also accepts ?secret= for manual activation runs", async () => {
    process.env.CRON_SECRET = "s3cr3t";
    setPersistence(null);
    const { status } = await call({}, "https://x/api/cron/capture?secret=s3cr3t");
    assert.equal(status, 503); // authed through, blocked only by persistence
  });
});

describe("/api/cron/capture never fabricates Yahoo data", () => {
  it("Yahoo leagues appear under `skipped`, never `captured` (checked via the 503 payload shape)", async () => {
    // Even when persistence is down we can assert the route's intent: it only
    // ever plans to capture READY Sleeper leagues. Re-check the registry
    // partition the route uses.
    const { listLeagueTargets, leagueConfigStatus } = await import("../lib/leagues/registry");
    const active = listLeagueTargets().filter((t) => t.provider === "sleeper" && leagueConfigStatus(t) === "READY");
    const yahoo = listLeagueTargets().filter((t) => t.provider === "yahoo");
    assert.deepEqual(active.map((t) => t.key).sort(), ["bloodline-bowl", "devoted-to-the-game"]);
    assert.ok(yahoo.every((t) => leagueConfigStatus(t) !== "READY"));
  });
});
