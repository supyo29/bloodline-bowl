import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain ESM script
import { classifyChange, classifyFile, changedFiles, skippableFilesInBundles } from "../scripts/vercel-ignore-build.mjs";

const RUNTIME_DATA = [
  "lib/football-intel/data/team_profile.csv",
  "lib/role-calibration/data/role_profile_asof.csv",
  "data/intelligence-history/objects/ab/abcdef.gz",
  "data/intelligence-history/manifest.json",
  "lib/game-distribution/data/calibration_priors_2025.json",
  "lib/player-scheme-intelligence/data/receiver_spatial_matrix.csv",
  "lib/player-role-intelligence/data/player_game_role.csv",
  "lib/trades/data/competitive_market_calibration.json",
  "docs/intelligence-surface-registry.json",
  "docs/scoring-support-matrix.json",
];
const RUNTIME_CODE = ["app/api/ai/route.ts", "lib/discovery.ts", "next.config.ts", "vercel.json", "package.json", "package-lock.json", "scripts/vercel-ignore-build.mjs", "supabase/migrations/20260101000000_x.sql", "test/fixtures/book-ready/x.json"];

test("runtime data and code changes request a build", () => {
  for (const f of [...RUNTIME_DATA, ...RUNTIME_CODE]) assert.equal(classifyChange([f]).build, true, f);
});

test("docs / tests / offline analysis only may skip", () => {
  const skip = ["docs/VERCEL_FUNCTION_STORAGE.md", "README.md", "test/foo.test.ts", "analysis/role_calibration/export_role_inputs.R", ".github/workflows/pr-ci.yml", "analysis/notes/readme.md", "_targets.R"];
  for (const f of skip) assert.equal(classifyChange([f]).build, false, f);
  assert.equal(classifyChange(skip).build, false);
});

test("a single runtime file in a mixed change forces a build", () => {
  const r = classifyChange(["docs/x.md", "test/a.test.ts", "lib/football-intel/data/team_profile.csv"]);
  assert.equal(r.build, true);
  assert.deepEqual(r.runtimeFiles, ["lib/football-intel/data/team_profile.csv"]);
});

test("unknown state fails safe to build", () => {
  assert.equal(classifyChange([]).build, true);
  assert.equal(classifyChange(undefined as unknown as string[]).build, true);
});

test("docs read at runtime are exceptions", () => {
  assert.equal(classifyFile("docs/COMPETITIVE_TRADE_INTELLIGENCE.md").skip, false);
  assert.equal(classifyFile("docs/TEAM_MANAGEMENT_PHASE_8_ORCHESTRATOR.md").skip, false);
});

test("changedFiles falls back and returns null when git fails", () => {
  const boom = () => { throw new Error("no git"); };
  assert.equal(changedFiles({}, boom), null);
  const calls: string[][] = [];
  const files = changedFiles({ VERCEL_GIT_PREVIOUS_SHA: "aaa", VERCEL_GIT_COMMIT_SHA: "bbb" }, (a: string[]) => { calls.push(a); if (a[2] === "aaa") throw new Error("shallow"); return "docs/a.md\n"; });
  assert.deepEqual(files, ["docs/a.md"]);
  assert.deepEqual(calls.map((c) => c[2]), ["aaa", "bbb^"]);
});

test("bundle safety helper flags skippable files that ship", () => {
  assert.deepEqual(skippableFilesInBundles(["lib/a.ts", "docs/x.md"]), ["docs/x.md"]);
});
