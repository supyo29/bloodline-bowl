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
  assert.deepEqual(offenders, ["app/api/evidence/route.ts"]);
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
