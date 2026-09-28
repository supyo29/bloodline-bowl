import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

test("Phase 7: production projection consumers cannot bypass the canonical provider boundary", () => {
  const allowedRawSleeperProjectionReaders = new Set([
    "lib/weekly/projections/sleeper-weekly.ts", // one concrete live provider
    "lib/projections/sleeper.ts", // external benchmark/diagnostic adapter
    "lib/sleeper/client.ts", // transport implementation itself
  ]);
  const rawProjectionSymbols = [
    "getWeeklyProjectionSegments",
    "getSeasonProjectionSegments",
    "getWeeklyProjectionArray",
    "getSeasonProjections",
    "getWeeklyProjections",
  ];

  const violations: string[] = [];
  for (const base of ["lib", "app"]) {
    for (const file of walk(join(ROOT, base))) {
      const rel = relative(ROOT, file).replaceAll("\\", "/");
      const src = readFileSync(file, "utf8");
      if (!src.includes("@/lib/sleeper/client") && !src.includes("./sleeper/client")) continue;
      if (!rawProjectionSymbols.some((symbol) => src.includes(symbol))) continue;
      if (!allowedRawSleeperProjectionReaders.has(rel)) violations.push(rel);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `raw Sleeper projection transport leaked outside the canonical provider boundary: ${violations.join(", ")}`,
  );
});

test("Phase 7: only the registry constructs the concrete weekly projection provider", () => {
  const allowed = new Set([
    "lib/weekly/projections/registry.ts",
    "lib/weekly/projections/sleeper-weekly.ts",
  ]);
  const violations: string[] = [];
  for (const file of walk(join(ROOT, "lib"))) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    const src = readFileSync(file, "utf8");
    const constructsConcreteProvider =
      /import\s+\{?\s*SleeperWeeklyProjectionProvider/.test(src) ||
      /new\s+SleeperWeeklyProjectionProvider\s*\(/.test(src);
    if (!constructsConcreteProvider) continue;
    if (!allowed.has(rel)) violations.push(rel);
  }
  assert.deepEqual(violations, []);
});

test("Phase 7: registry always wraps the live weekly provider with the durable canonical layer", () => {
  const src = readFileSync(join(ROOT, "lib", "weekly", "projections", "registry.ts"), "utf8");
  assert.match(src, /new CanonicalProjectionSnapshotProvider\(new SleeperWeeklyProjectionProvider\(\)\)/);
});
