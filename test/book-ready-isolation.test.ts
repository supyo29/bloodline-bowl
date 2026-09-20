/** Phase 3.5C — isolation: Book-Ready is additive and read-only; nothing in production paths imports it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === "node_modules" || f === ".next" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
const importsBookReady = (s: string) => /from\s+["'](?:@\/lib\/book-ready|(?:\.\.?\/)+book-ready)[^"']*["']|import\(["']@\/lib\/book-ready/.test(s);

test("only app/api/evidence/route.ts imports lib/book-ready from app/ or lib/ (outside book-ready itself)", () => {
  const offenders = [...walk("app"), ...walk("lib")].filter((f) => !f.startsWith("lib/book-ready/")).filter((f) => importsBookReady(readFileSync(f, "utf8")));
  // the analytical route, and the Analysis Book EXECUTOR (the single planner module that reads evidence; test/analysis-book-isolation.test.ts)
  assert.deepEqual(offenders, ["app/api/evidence/route.ts", "lib/analysis-book/executor.ts"]);
});
test("no file outside lib/book-ready (and the one route) mentions book-ready in ANY form: import, require, dynamic import, string path", () => {
  const offenders = [...walk("app"), ...walk("lib")].filter((f) => !f.startsWith("lib/book-ready/") && f !== "app/api/evidence/route.ts" && f !== "lib/analysis-book/executor.ts" && f !== "lib/analysis-book/capability.ts").filter((f) => /book-ready|book_ready/.test(readFileSync(f, "utf8")));
  // the registry TYPES and discovery manifest describe the capability; neither may import runtime code
  assert.deepEqual(offenders.filter((f) => !["lib/canonical/intelligence-surface-registry.ts", "lib/discovery.ts"].includes(f)), []);
  for (const f of ["lib/canonical/intelligence-surface-registry.ts", "lib/discovery.ts"]) assert.doesNotMatch(readFileSync(f, "utf8"), /from\s+["'][^"']*book-ready/, f);
});
test("the Analysis Book capability reader names book_ready ONLY as the registry JSON key (no import, no module path)", () => {
  const src = readFileSync("lib/analysis-book/capability.ts", "utf8"); assert.doesNotMatch(src, /book-ready/); assert.doesNotMatch(src, /from\s+["'][^"']*book/);
});
test("recommendation routes never reach the query layer: lib/weekly, lib/trades, lib/lineup and the recommendation routes do not reference it", () => {
  for (const f of [...walk("lib/weekly"), ...walk("lib/trades"), ...walk("app/api/intelligence"), ...walk("app/api/lineup"), ...walk("app/api/waivers"), ...walk("app/api/matchup")]) assert.doesNotMatch(readFileSync(f, "utf8"), /book-ready|book_ready/, f);
});
test("book-ready contains no writes to production stores or network calls", () => {
  for (const f of walk("lib/book-ready")) { const s = readFileSync(f, "utf8"); assert.doesNotMatch(s, /\bfetch\(|supabase|\.insert\(|\.upsert\(|writeFileSync|process\.env\.[A-Z_]*(KEY|TOKEN|SECRET)/i, f); }
});
test("frozen Start/Sit model is byte-identical (sha256 pin)", () => {
  const h = createHash("sha256").update(readFileSync("lib/weekly/data/start_sit_model.json")).digest("hex");
  assert.equal(h, "85d2ddd501cc10d5b3a699629f80c0c3781fe12fa24fa834f41969cb0186b293");
});
test("route is GET-only", () => {
  const s = readFileSync("app/api/evidence/route.ts", "utf8"); assert.match(s, /export async function GET|export function GET|export const GET/); assert.doesNotMatch(s, /export (async )?function (POST|PUT|PATCH|DELETE)/);
});
