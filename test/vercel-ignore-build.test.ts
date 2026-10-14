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

// Simulated git: `commits` maps sha -> files changed between that sha and HEAD(=head).
function fakeGit(known: Record<string, string[]>) {
  return (a: string[]): string => {
    if (a[0] === "cat-file") { const sha = a[2].replace("^{commit}", ""); if (!(sha in known)) throw new Error("bad object"); return ""; }
    if (a[0] === "diff") { const [sha] = a[2].split(".."); if (!(sha in known)) throw new Error("bad revision"); return known[sha].join("\n") + "\n"; }
    throw new Error("unexpected git " + a.join(" "));
  };
}
const decide = (env: Record<string, string>, known: Record<string, string[]>) => classifyChange(changedFiles(env, fakeGit(known)) ?? []);
const PREV = "a".repeat(40), HEAD = "b".repeat(40);

test("first deployment (no previous SHA) always builds, even if the newest commit is docs-only", () => {
  const known = { [HEAD + "^"]: ["docs/x.md"] };
  assert.equal(changedFiles({ VERCEL_GIT_COMMIT_SHA: HEAD }, fakeGit(known)), null);
  assert.equal(changedFiles({ VERCEL_GIT_PREVIOUS_SHA: "", VERCEL_GIT_COMMIT_SHA: HEAD }, fakeGit(known)), null);
  assert.equal(decide({ VERCEL_GIT_COMMIT_SHA: HEAD }, known).build, true);
});

test("no HEAD^ fallback: git is never asked for HEAD^ / <sha>^", () => {
  const calls: string[][] = [];
  changedFiles({ VERCEL_GIT_COMMIT_SHA: HEAD }, (a: string[]) => { calls.push(a); return ""; });
  assert.equal(calls.length, 0);
});

test("first branch push containing several commits builds (previous SHA absent, runtime change earlier in the range)", () => {
  assert.equal(decide({ VERCEL_GIT_COMMIT_SHA: HEAD }, { [PREV]: ["app/api/x/route.ts", "docs/x.md"] }).build, true);
});

test("subsequent docs-only change after a successful deployment skips", () => {
  const r = decide({ VERCEL_GIT_PREVIOUS_SHA: PREV, VERCEL_GIT_COMMIT_SHA: HEAD }, { [PREV]: ["docs/x.md", "test/a.test.ts", "analysis/foo/a.R"] });
  assert.equal(r.build, false);
});

test("subsequent runtime code change builds", () => {
  assert.equal(decide({ VERCEL_GIT_PREVIOUS_SHA: PREV, VERCEL_GIT_COMMIT_SHA: HEAD }, { [PREV]: ["lib/discovery.ts"] }).build, true);
});

test("subsequent runtime data change builds", () => {
  for (const f of ["lib/football-intel/data/team_profile.csv", "data/intelligence-history/manifest.json", "lib/role-calibration/data/observed_role_game.csv"])
    assert.equal(decide({ VERCEL_GIT_PREVIOUS_SHA: PREV, VERCEL_GIT_COMMIT_SHA: HEAD }, { [PREV]: [f] }).build, true, f);
});

test("mixed docs + runtime change builds", () => {
  assert.equal(decide({ VERCEL_GIT_PREVIOUS_SHA: PREV, VERCEL_GIT_COMMIT_SHA: HEAD }, { [PREV]: ["docs/x.md", "app/page.tsx"] }).build, true);
});

test("invalid, malformed or unknown previous commit builds", () => {
  const known = { [PREV]: ["docs/x.md"] };
  assert.equal(changedFiles({ VERCEL_GIT_PREVIOUS_SHA: "c".repeat(40), VERCEL_GIT_COMMIT_SHA: HEAD }, fakeGit(known)), null); // not in clone (shallow)
  assert.equal(changedFiles({ VERCEL_GIT_PREVIOUS_SHA: "not-a-sha; rm -rf /", VERCEL_GIT_COMMIT_SHA: HEAD }, fakeGit(known)), null);
  assert.equal(decide({ VERCEL_GIT_PREVIOUS_SHA: "c".repeat(40), VERCEL_GIT_COMMIT_SHA: HEAD }, known).build, true);
});

test("empty diff and git failures build", () => {
  assert.equal(changedFiles({ VERCEL_GIT_PREVIOUS_SHA: PREV, VERCEL_GIT_COMMIT_SHA: HEAD }, fakeGit({ [PREV]: [] })), null);
  assert.equal(decide({ VERCEL_GIT_PREVIOUS_SHA: PREV, VERCEL_GIT_COMMIT_SHA: HEAD }, { [PREV]: [] }).build, true);
  assert.equal(changedFiles({ VERCEL_GIT_PREVIOUS_SHA: PREV }, () => { throw new Error("no git"); }), null);
});

test("bundle safety helper flags skippable files that ship", () => {
  assert.deepEqual(skippableFilesInBundles(["lib/a.ts", "docs/x.md"]), ["docs/x.md"]);
});
