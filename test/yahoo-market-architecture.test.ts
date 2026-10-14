/**
 * ARCHITECTURAL read-only guarantee for the Yahoo Market State path. Waiver analysis stays ADVISORY: nothing reachable from this code can add, drop, claim,
 * trade, cancel or change a lineup. Two independent layers: (1) the transport has no write method at all; (2) static scans prove no module on the path
 * names a write verb or imports the OAuth module (the only place that POSTs, and only to Yahoo's token endpoint).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { YahooFantasyClient } from "../lib/providers/yahoo/client";

const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (f: string): string => strip(readFileSync(f, "utf8"));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });

/** Every module reachable from the Yahoo market read path (market-state side + the Yahoo provider modules it calls). */
const PATH = [
  "lib/market-state/yahoo-build.ts", "lib/market-state/yahoo-load.ts", "lib/market-state/schedule.ts",
  "lib/providers/yahoo/client.ts", "lib/providers/yahoo/fetch.ts", "lib/providers/yahoo/players.ts", "lib/providers/yahoo/pending-claims.ts",
  "lib/providers/yahoo/discovery.ts", "lib/providers/yahoo/parse.ts", "lib/providers/yahoo/games.ts", "lib/providers/yahoo/connections.ts",
  "lib/canonical/yahoo-sleeper-bridge.ts", "lib/canonical/yahoo-bridge-source.ts",
];

describe("the Yahoo transport cannot write", () => {
  it("YahooFantasyClient exposes exactly one request method: get", () => {
    const names = Object.getOwnPropertyNames(YahooFantasyClient.prototype).filter((n) => n !== "constructor").sort();
    assert.deepEqual(names, ["get", "tokenBackend"]);
  });
  it("the client issues only GET (every `method:` literal is GET)", () => {
    const src = read("lib/providers/yahoo/client.ts"); const methods = [...src.matchAll(/method\s*:\s*["'`](\w+)["'`]/g)].map((m) => m[1]);
    assert.ok(methods.length >= 1); assert.ok(methods.every((m) => m === "GET"), `methods: ${methods.join(",")}`);
  });
});

describe("no module on the market path names a write", () => {
  it("none contains a mutating HTTP verb, a write helper call, or a write endpoint", () => {
    for (const f of PATH) {
      const src = read(f);
      assert.doesNotMatch(src, /method\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i, `${f}: mutating HTTP method`);
      assert.doesNotMatch(src, /\b(client|http|api|yahoo)\w*\.(post|put|patch|delete)\s*\(/i, `${f}: write helper call on a client`);
      assert.doesNotMatch(src, /\b(submit|execute|place|perform|make)(Waiver)?(Claim|Add|Drop|Trade|Lineup|Move|Transaction)\b/i, `${f}: names a transaction-executing function`);
      if (f !== "lib/providers/yahoo/client.ts") assert.doesNotMatch(src, /\bfetch\s*\(/, `${f}: raw fetch outside the GET-only client`);
    }
  });
  it("the market modules export read/derive functions only (no add/drop/claim/trade/lineup verbs)", () => {
    for (const f of ["lib/market-state/yahoo-build.ts", "lib/market-state/yahoo-load.ts", "lib/providers/yahoo/pending-claims.ts"]) {
      const names = [...read(f).matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g)].map((m) => m[1]!);
      assert.ok(names.length > 0);
      for (const n of names) assert.doesNotMatch(n, /^(add|drop|claim|submit|trade|cancel|set|put|post|delete|update|write|persist|save|insert)/i, `${f}: export ${n}`);
    }
  });
  it("only the OAuth module POSTs, and only to Yahoo's token endpoint; the market path never imports it", () => {
    const posters = walk("lib/providers/yahoo").filter((f) => /method\s*:\s*["'`]POST["'`]/i.test(read(f))).sort();
    assert.deepEqual(posters, ["lib/providers/yahoo/oauth.ts"], "the only POST in the Yahoo provider is OAuth token exchange / refresh");
    const oauth = read("lib/providers/yahoo/oauth.ts"); const posts = [...oauth.matchAll(/fetchImpl\s*\(\s*([^,]+),\s*\{[^}]*method\s*:\s*["']POST["']/g)].map((m) => m[1]!.trim());
    assert.ok(posts.length >= 1 && posts.every((u) => /YAHOO_OAUTH_TOKEN_URL/.test(u)), `POST targets: ${posts.join(" | ")}`);
    for (const f of PATH.filter((x) => x !== "lib/providers/yahoo/client.ts")) assert.doesNotMatch(read(f), /from\s+["'](?:@\/lib\/providers\/yahoo|\.)\/oauth["']/, `${f}: imports the OAuth module`);
  });
  it("Yahoo write resources are never addressed: no roster PUT path, transaction POST path or add/drop payloads on the market path", () => {
    for (const f of PATH) assert.doesNotMatch(read(f), /\/roster["'`]\s*,\s*\{\s*method|\b(add_player|drop_player)\b|<transaction>|waiver_priority=|faab_bid=/i, f);
  });
  it("the waiver route and the weekly adapter that consume the market stay advisory: no submission path", () => {
    for (const f of ["app/api/waivers/[league]/[manager]/week/[week]/route.ts", "lib/weekly/market-pool-adapter.ts", "lib/weekly/waivers.ts"]) {
      const src = read(f); assert.doesNotMatch(src, /method\s*:\s*["'`](POST|PUT|PATCH|DELETE)/i, f); assert.doesNotMatch(src, /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/, `${f}: a mutating route handler`);
    }
  });
});

describe("connection isolation is enforced in code", () => {
  it("the loader derives the connection ONLY from the registry binding and rejects a mismatched handle", () => {
    const src = read("lib/market-state/yahoo-load.ts");
    assert.match(src, /yahooLeaguesForConnection\(connection_id\)\.some\(/); assert.match(src, /r\.data\.connectionId !== b\.connection_id/); assert.doesNotMatch(src, /["']primary["']|["']maclin["']/, "no hard-coded connection id in the loader");
  });
});
