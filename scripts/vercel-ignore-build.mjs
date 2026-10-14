#!/usr/bin/env node
/**
 * Vercel `ignoreCommand` — exit 0 SKIPS the build, exit 1 BUILDS.
 *
 * Conservative by construction: a deployment is skipped ONLY when every changed file matches SKIP_PATTERNS (documentation,
 * tests, offline R/analysis sources, CI workflow files, local tooling config). Anything else — including every data
 * file read from the deployed filesystem (lib/**\/data, data/intelligence-history, ...) — requests a build. Unknown state
 * (no git history, diff failure, empty diff) also builds.
 *
 * Safety is checked against real build output: `node scripts/function-storage-audit.mjs` fails if any file that ends up in a
 * function bundle would be classified as skippable (see `skippableFilesInBundles`).
 *
 * Mutable runtime data (football-intel, role-calibration, intelligence-history, game-distribution, player-scheme) is
 * deliberately NOT skippable until it is externalized from the function bundle.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** [pattern, why]. Patterns are tested against repo-relative POSIX paths. */
export const SKIP_PATTERNS = Object.freeze([
  [/^docs\/.+\.md$/, "documentation (markdown)"],
  [/^[^/]+\.md$/, "root markdown"],
  [/^\.claude\//, "local Claude tooling"],
  [/^\.github\/workflows\//, "CI workflow definitions (not part of the app bundle)"],
  [/^test\/.+\.test\.ts$/, "unit tests"],
  [/^analysis\/.+\.(R|Rmd|md)$/, "offline R analysis sources and notes"],
  [/^_targets\.R$/, "offline R pipeline"],
  [/^artifacts\//, "research artifacts"],
  [/^outputs\//, "generated research outputs (gitignored; never deployed)"],
]);

/**
 * Files matching a skip pattern but that ARE read at runtime must be listed here so they still trigger a build.
 * (Populated from the function-storage audit; the audit fails if this list is incomplete.)
 */
export const RUNTIME_EXCEPTIONS = Object.freeze([
  /^docs\/COMPETITIVE_TRADE_INTELLIGENCE\.md$/,
  /^docs\/TEAM_MANAGEMENT_PHASE_8_ORCHESTRATOR\.md$/,
]);

export function classifyFile(file) {
  const f = file.replace(/\\/g, "/");
  if (RUNTIME_EXCEPTIONS.some((re) => re.test(f))) return { skip: false, why: "read at runtime" };
  for (const [re, why] of SKIP_PATTERNS) if (re.test(f)) return { skip: true, why };
  return { skip: false, why: "not on the skip allowlist (treated as runtime-affecting)" };
}

/** @returns {{build:boolean, reason:string, runtimeFiles:string[]}} */
export function classifyChange(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return { build: true, reason: "no changed-file list (fail-safe build)", runtimeFiles: [] };
  const runtimeFiles = changedFiles.filter((f) => !classifyFile(f).skip);
  if (runtimeFiles.length) return { build: true, reason: `${runtimeFiles.length} runtime-affecting file(s), e.g. ${runtimeFiles[0]}`, runtimeFiles };
  return { build: false, reason: `all ${changedFiles.length} changed file(s) are docs/tests/offline-analysis only`, runtimeFiles: [] };
}

/** Files that are in function bundles but would be skipped: must be empty. */
export function skippableFilesInBundles(bundleFiles) {
  return bundleFiles.filter((f) => classifyFile(f).skip);
}

export function changedFiles(env = process.env, git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) {
  const head = env.VERCEL_GIT_COMMIT_SHA || "HEAD";
  const bases = [env.VERCEL_GIT_PREVIOUS_SHA, `${head}^`].filter(Boolean);
  for (const base of bases) {
    try {
      const out = git(["diff", "--name-only", base, head]).split("\n").map((s) => s.trim()).filter(Boolean);
      if (out.length) return out;
    } catch { /* try next base */ }
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const files = changedFiles();
  const d = classifyChange(files ?? []);
  console.log(`[ignore-build] ${d.build ? "BUILD" : "SKIP"}: ${d.reason}`);
  process.exit(d.build ? 1 : 0);
}
