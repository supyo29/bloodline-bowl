/**
 * MCP connector — analytics isolation (static).
 *
 * The connector is a transport layer: it may call route handlers and identity
 * helpers, but it must not import any analytics engine (so it cannot compute or
 * re-weight a projection, score, replacement value or recommendation), and no
 * existing route may depend on it (so adding it cannot change any production
 * output).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ROUTES } from "../lib/mcp/invoke";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const importsOf = (file: string) => [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);

const ALLOWED_IMPORTS = [
  /^\.\//, // lib/mcp siblings
  /^@\/app\/api\//, // route handlers, invoked in-process
  /^@\/lib\/leagues\/registry$/, // league slugs/names (identity)
  /^@\/lib\/discovery$/, // absolute public URLs for citations (metadata only)
  /^@\/lib\/sleeper\/client$/, // player directory + NFL week (identity), never projections
  /^@\/lib\/mcp\//,
  /^zod$/,
  /^@modelcontextprotocol\/server$/,
  /^mcp-handler$/,
  /^node:crypto$/,
];

describe("MCP isolation", () => {
  it("lib/mcp imports no analytics engine — only route handlers and identity helpers", () => {
    for (const f of walk("lib/mcp")) {
      for (const spec of importsOf(f)) assert.ok(ALLOWED_IMPORTS.some((re) => re.test(spec)), `${f} imports ${spec}`);
    }
  });

  it("from the Sleeper client, lib/mcp uses only the player directory and NFL state", () => {
    for (const f of walk("lib/mcp")) {
      const src = readFileSync(f, "utf8");
      const m = /import\s*\{([^}]+)\}\s*from\s*"@\/lib\/sleeper\/client"/.exec(src);
      if (!m) continue;
      const names = m[1]!.split(",").map((s) => s.trim()).filter(Boolean).sort();
      assert.deepEqual(names, ["getNflState", "getPlayerIndex"], f);
    }
  });

  it("no existing app/ or lib/ module imports the connector (it is purely additive)", () => {
    const offenders = [...walk("app"), ...walk("lib")]
      .filter((f) => !f.startsWith("lib/mcp/") && f !== "app/api/mcp/route.ts")
      .filter((f) => importsOf(f).some((s) => s.startsWith("@/lib/mcp") || s.includes("/mcp/")));
    assert.deepEqual(offenders, []);
  });

  it("every wrapped route is a GET, except the documented read-only competitive trade POST", () => {
    for (const [name, spec] of Object.entries(ROUTES)) {
      if (name === "competitive_trade") {
        assert.equal(spec.method, "POST");
        assert.match(readFileSync("app/api/trades/competitive/route.ts", "utf8"), /READ-ONLY analytics/);
      } else assert.equal(spec.method, "GET", name);
    }
    assert.ok(!Object.values(ROUTES).some((r) => /cron|refresh|auth|yahoo\/oauth|calculate/.test(r.template)), "no operator/auth/write-adjacent routes");
  });

  it("the MCP route exports POST only (stateless: no GET stream, no DELETE session)", () => {
    const src = readFileSync("app/api/mcp/route.ts", "utf8");
    assert.match(src, /export \{ handler as POST \};/);
    assert.doesNotMatch(src, /handler as (GET|DELETE|PUT|PATCH)/);
  });

  it("tool handlers never log arguments beyond identifiers, nor any header or body", () => {
    const src = readFileSync("lib/mcp/tools.ts", "utf8");
    const logs = [...src.matchAll(/console\.(log|info|warn|error)\(([^;]+)\);/g)].map((m) => m[2]!);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(src, /headers\.get\(|authorization/i);
  });
});
