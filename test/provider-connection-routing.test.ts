/**
 * Cross-league isolation: every Yahoo league must be read through ITS OWN OAuth
 * connection. Reading Maclin through Rogers Park's ("primary") connection gets
 * Yahoo FORBIDDEN (live regression: /api/yahoo/leagues/maclin-on-chicks-xvi 403,
 * /api/transactions/maclin-on-chicks-xvi 502).
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { listLeagueTargets } from "../lib/leagues/registry";
import { resolveLeagueStrict } from "../lib/leagues/resolve";
import { isRegisteredYahooConnectionId } from "../lib/providers/yahoo/connections";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("Yahoo connection routing", () => {
  it("every Yahoo league has its own registered connection, and slug resolution carries it", () => {
    const yahoo = listLeagueTargets().filter((t) => t.provider === "yahoo");
    assert.ok(yahoo.length >= 2);
    for (const t of yahoo) {
      assert.ok(t.yahoo_connection_id && isRegisteredYahooConnectionId(t.yahoo_connection_id), t.key);
      const r = resolveLeagueStrict(t.key);
      assert.ok(r.ok);
      assert.equal(r.ok && r.league.provider_connection_id, t.yahoo_connection_id, t.key);
      assert.equal(r.ok && r.league.external_league_id, t.external_league_id, t.key);
    }
    assert.equal(listLeagueTargets().find((t) => t.key === "maclin-on-chicks-xvi")?.yahoo_connection_id, "maclin");
    assert.equal(listLeagueTargets().find((t) => t.key === "rogers-park")?.yahoo_connection_id, "primary");
  });

  it("no app/lib call site builds a league-scoped provider or Yahoo session without the league's connection", () => {
    const offenders: string[] = [];
    for (const f of [...walk("app"), ...walk("lib")]) {
      const src = readFileSync(f, "utf8");
      // getProvider(<dynamic>) must pass { connectionId } (literal "sleeper" needs none).
      for (const m of src.matchAll(/getProvider\(([^)]*)\)/g)) {
        const args = m[1] ?? "";
        if (f.endsWith("lib/providers/registry.ts")) continue;
        if (/^\s*"sleeper"\s*$/.test(args)) continue;
        if (!/connectionId/.test(args)) offenders.push(`${f}: getProvider(${args})`);
      }
      // loadYahooSession() with no options silently uses the default connection.
      for (const m of src.matchAll(/loadYahooSession\(\s*\)/g)) offenders.push(`${f}: ${m[0]}`);
    }
    assert.deepEqual(offenders, []);
  });
});
