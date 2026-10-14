/**
 * W2.R1 is the CURRENT Bloodline intelligence stack. Integration is explicit and bounded: production source files may reference W2.R1 only through the
 * reviewed integration points below, and W2.R1 code is READ-ONLY (no provider write, no transaction, no automatic lineup / waiver / drop / trade).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ALLOWED_DIRS = [/^lib\/w2r1(\/|$)/, /^app\/api\/w2r1(\/|$)/, /^test\//, /^scripts\//, /^docs\//, /^node_modules\//, /^\.next\//, /^\.git\//];
/** the ONLY production files that may mention W2.R1, and exactly how */
const INTEGRATION_POINTS: Record<string, RegExp> = {
  "lib/weekly/intelligence.ts": /w2r1/i,           // per-component qualification metadata + detail routes in the weekly intelligence response
  "lib/weekly/context.ts": /w2r1/i,               // qualified D/ST hook (lib/w2r1/context-hook) + context metadata
  "lib/weekly/schema.ts": /w2r1/i,                 // optional `w2r1` metadata field on WeeklyTeamContext
  "lib/public-api/policy.ts": /template: "\/api\/w2r1\//, // route registration only
  "lib/mcp/tools.ts": /w2r1/i,                     // MCP tools exposing the current stack (read-only)
  "lib/mcp/invoke.ts": /w2r1/i,                    // in-process route handler for those tools
  "lib/mcp/compact.ts": /w2r1/i,                   // compact W2.R1 block in the weekly analysis
  "lib/discovery.ts": /w2r1/i,                     // discovery manifest entries
};
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, e).replace(/\\/g, "/");
    if (ALLOWED_DIRS.some((r) => r.test(rel + "/") || r.test(rel))) continue;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) yield* walk(rel); else if (/\.(ts|tsx|mjs|js)$/.test(e)) yield rel;
  }
}

describe("W2.R1 integration boundary", () => {
  it("production source files reference W2.R1 only through the reviewed integration points", () => {
    const offenders: string[] = [];
    for (const root of ["lib", "app"]) for (const f of walk(root)) {
      const lines = readFileSync(join(ROOT, f), "utf8").split("\n").filter((l) => /w2r1/i.test(l));
      if (!lines.length) continue;
      const rule = INTEGRATION_POINTS[f];
      if (!rule || !lines.every((l) => rule.test(l))) offenders.push(f);
    }
    assert.deepEqual(offenders, []);
    assert.ok(!/w2r1/i.test(readFileSync(join(ROOT, "proxy.ts"), "utf8")), "proxy.ts must not reference W2.R1");
  });
  it("W2.R1 modules never import a production-mutating path (FI production gate, transactions, provider writes)", () => {
    const bad: string[] = [];
    const scan = (dir: string) => { for (const e of readdirSync(join(ROOT, dir))) { const rel = join(dir, e); if (statSync(join(ROOT, rel)).isDirectory()) scan(rel); else if (/\.ts$/.test(e) && /applyProductionFi|production-gate|from "@\/lib\/(transactions|yahoo\/write)/.test(readFileSync(join(ROOT, rel), "utf8"))) bad.push(rel); } };
    scan("lib/w2r1"); assert.deepEqual(bad, []);
  });
  it("W2.R1 is served on production deployments: no VERCEL_ENV gate, only the operational emergency stop", async () => {
    const { w2r1Enabled } = await import("@/lib/w2r1/guard");
    assert.equal(w2r1Enabled({ VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv), true);
    assert.equal(w2r1Enabled({ VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv), true);
    assert.equal(w2r1Enabled({ W2R1_DISABLED: "1" } as unknown as NodeJS.ProcessEnv), false);
    assert.doesNotMatch(readFileSync(join(ROOT, "lib/w2r1/guard.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""), /VERCEL_ENV/);
  });
});
