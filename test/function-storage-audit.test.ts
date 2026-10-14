import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain ESM script
import { analyze, checkCeilings, CEILINGS } from "../scripts/function-storage-audit.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fsa-"));
  const fdir = join(root, ".vercel", "output", "functions");
  const file = (rel: string, bytes: number) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), "x".repeat(bytes)); };
  file("node_modules/next/a.js", 1000); file("lib/trades/data/competitive_market_calibration.json", 10); file("lib/big/data/big.csv", 5000);
  const mk = (name: string, map: string[]) => {
    const d = join(fdir, name + ".func"); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, ".vc-config.json"), JSON.stringify({ maxDuration: 60, filePathMap: Object.fromEntries(map.map((m) => [m, m])) }));
    return d;
  };
  mk("api/trades/competitive", ["node_modules/next/a.js", "lib/trades/data/competitive_market_calibration.json"]);
  mk("api/other", ["node_modules/next/a.js", "lib/big/data/big.csv"]);
  symlinkSync(join(fdir, "api/other.func"), join(fdir, "api/alias.func"));
  return root;
}

test("resolves symlink aliases, sizes bundles and measures duplication", () => {
  const r = analyze({ root: fixture() });
  assert.equal(r.physicalFunctions, 2);
  assert.equal(r.aliasSymlinks, 1);
  assert.equal(r.duplicatedBytes, 1000);
  assert.equal(r.topDuplicatedDirectories[0].dir, "node_modules/next");
  assert.equal(r.largestFunction.fn, "api/other.func");
  assert.ok(r.totalUncompressedBytes > 6000);
  assert.deepEqual(r.requiredMissing.filter((x: { route: string }) => x.route === "api/trades/competitive"), []);
  assert.equal(r.requiredMissing.some((x: { route: string }) => x.route === "api/trades/analyze"), true);
});

test("ceilings flag too many functions, oversized payloads and near-limit bundles", () => {
  const base = { physicalFunctions: 7, totalUncompressedBytes: 601 * 1048576, functions: [{ fn: "a.func", bytes: 210 * 1048576 }], forbiddenFiles: [{ fn: "a.func", file: "outputs/x.rds" }], requiredMissing: [], skippableFilesInBundles: [] };
  const v = checkCeilings(base);
  assert.equal(v.length, 4);
  assert.equal(checkCeilings({ ...base, physicalFunctions: 6, totalUncompressedBytes: 600 * 1048576, functions: [{ fn: "a", bytes: 1 }], forbiddenFiles: [] }).length, 0);
  assert.equal(CEILINGS.maxPhysicalFunctions, 6);
  assert.equal(CEILINGS.maxTotalUncompressedBytes, 600 * 1024 * 1024);
});
