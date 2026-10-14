/**
 * Vercel splits Next functions into separate lambdas per distinct maxDuration, and every lambda carries its own ~84 MB copy of
 * the Next runtime. Exactly two duration classes are allowed: 60 (ordinary request/bridge/API routes) and 300 (long-running).
 * Adding a third class (or promoting a route to 300) must be a deliberate, reviewed change to this list + docs/VERCEL_FUNCTION_STORAGE.md.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const LONG_RUNNING_300: Record<string, string> = {
  "api/cron/calibration-materialize": "daily materialization of calibration ledgers (cron)",
  "api/cron/capture": "daily league capture across providers (cron)",
  "api/cron/game-environment": "game-environment/script capture + simulation (cron, live mode)",
  "api/cron/matchup2-capture": "Matchup 2.0 capture (cron)",
  "api/cron/projection-snapshot": "projection snapshot build (cron)",
  "api/cron/publish": "published snapshot build (cron)",
  "api/cron/role-calibration": "role-calibration forecast materialization (cron)",
  "api/cron/role-shadow-capture": "W2.P2 Role Shadow prospective capture job (cron-style; already 300)",
  "api/cron/yahoo-health": "Yahoo OAuth token lifecycle health / keep-alive (cron; provider round trips)",
  "api/cron/waiver2-capture": "Waiver 2.0 capture (cron)",
  "api/cron/weekly-audit": "weekly model audit (cron)",
  "api/game-distribution/evaluate": "offline-style evaluation harness",
  "api/role-calibration/evaluate": "offline-style evaluation harness",
  "api/trades/analyze": "trade analysis; previously 90 s, internal budget ~80 s",
  "api/trades/competitive": "competitive trade beam search; previously 90 s",
  "api/mcp": "MCP wrapped trade tools run internal budgets up to 80 s; the platform limit must exceed them so UPSTREAM_TIMEOUT surfaces instead of a kill",
  "api/refresh": "live provider refresh + publish; previously 120 s",
};

function routes(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) routes(p, out);
    else if (e === "route.ts") out.push(p);
  }
  return out;
}

const root = join(process.cwd(), "app");
const found = routes(root).map((p) => {
  const src = readFileSync(p, "utf8");
  const m = [...src.matchAll(/export const maxDuration = (\d+);/g)];
  return { route: relative(root, p).replace(/\/?route\.ts$/, ""), values: m.map((x) => Number(x[1])) };
});

test("every route declares exactly one maxDuration, and it is 60 or 300", () => {
  assert.ok(found.length > 90);
  for (const r of found) {
    assert.equal(r.values.length, 1, `${r.route}: expected one explicit maxDuration`);
    assert.ok(r.values[0] === 60 || r.values[0] === 300, `${r.route}: maxDuration ${r.values[0]} not in {60,300}`);
  }
});

test("300 s is reserved for the documented long-running routes", () => {
  const actual = found.filter((r) => r.values[0] === 300).map((r) => r.route).sort();
  assert.deepEqual(actual, Object.keys(LONG_RUNNING_300).sort());
});

test("every cron path in vercel.json is a 300 s route", () => {
  const vj = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons: { path: string }[] };
  for (const c of vj.crons) assert.ok(c.path.slice(1) in LONG_RUNNING_300, c.path);
});
