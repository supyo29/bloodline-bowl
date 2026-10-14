/** W2.R1 is SHADOW ONLY: no production code path may import it, and its outputs carry the shadow label. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ALLOWED = [/^lib\/w2r1(\/|$)/, /^app\/api\/w2r1(\/|$)/, /^test\//, /^scripts\//, /^docs\//, /^node_modules\//, /^\.next\//, /^\.git\//];
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, e).replace(/\\/g, "/");
    if (ALLOWED.some((r) => r.test(rel + "/") || r.test(rel))) continue;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) yield* walk(rel);
    else if (/\.(ts|tsx|mjs|js)$/.test(e)) yield rel;
  }
}

describe("W2.R1 production isolation", () => {
  it("no production source file (lib/, app/, proxy.ts) references W2.R1", () => {
    const offenders: string[] = [];
    for (const root of ["lib", "app"]) for (const f of walk(root)) if (/w2r1/i.test(readFileSync(join(ROOT, f), "utf8"))) offenders.push(f);
    assert.deepEqual(offenders, []);
    assert.ok(!/w2r1/i.test(readFileSync(join(ROOT, "proxy.ts"), "utf8")), "proxy.ts must not reference W2.R1");
  });
  it("W2.R1 modules never import a production-mutating path (FI production gate)", () => {
    const bad: string[] = [];
    const scan = (dir: string) => { for (const e of readdirSync(join(ROOT, dir))) { const rel = join(dir, e); if (statSync(join(ROOT, rel)).isDirectory()) scan(rel); else if (/\.ts$/.test(e) && /applyFiToProductionBatch|production-gate/.test(readFileSync(join(ROOT, rel), "utf8"))) bad.push(rel); } };
    scan("lib/w2r1"); assert.deepEqual(bad, []);
  });
});
