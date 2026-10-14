# Vercel Function Storage

Hobby plans cap Function Storage (~10 GB). This document records what drives it, what the repo does about it, and the guard rails.

## What drives storage
- Every distinct lambda carries its **own copy** of the Next runtime (`node_modules/next`, ~84 MB uncompressed, incl. dev runtimes and `.map` files — not removable via `outputFileTracingExcludes`, tested).
- Next/Vercel groups routes into lambdas by **`maxDuration`** and route type (Page / ISR / API), not by traced files. Each distinct `maxDuration` value therefore cost a whole extra lambda.
- Data read from the deployed filesystem (`lib/*/data`, `data/intelligence-history`) is copied into every lambda that statically reaches it.
- Gitignored research caches (`analysis/*/cache`, `outputs/`) are **not** in Git-based Vercel builds; a build from a dirty working tree overstates size (e.g. a 441 MB competitive function) — always audit a clean `git archive`.

## Changes in this branch (`infra/vercel-function-storage`)
1. `lib/trades/competitive/calibration.ts`: `/*turbopackIgnore: true*/` on the dynamic `readFileSync(file)` that made Turbopack trace the whole project into `/api/mcp`, `/api/refresh`, `/api/trades/*`. The default path stays statically scoped to `lib/trades/data`, so `competitive_market_calibration.json` is still bundled (verified in build output and by `test/competitive-calibration-artifact-load.test.ts`).
2. `maxDuration` is normalized to exactly two classes (guarded by `test/function-duration-classes.test.ts`).
3. `scripts/function-storage-audit.mjs` (`npm run storage:audit`, workflow `function-storage.yml`) enforces ceilings after a clean `vercel build`.
4. `vercel.json` `ignoreCommand` -> `scripts/vercel-ignore-build.mjs` (conservative allowlist; tests in `test/vercel-ignore-build.test.ts`).

## maxDuration classes
**300 s** (long-running only):
| Route | Why |
|---|---|
| `api/cron/*` (9: calibration-materialize, capture, game-environment, matchup2-capture, projection-snapshot, publish, role-calibration, waiver2-capture, weekly-audit) | scheduled capture/materialization jobs; were already 300 |
| `api/game-distribution/evaluate`, `api/role-calibration/evaluate` | offline-style evaluation harnesses; were already 300 |
| `api/trades/analyze`, `api/trades/competitive` | trade analysis / beam search; were 90 s with ~80 s internal budgets |
| `api/mcp` | wrapped trade tools run internal budgets up to 80 s; the platform limit must exceed them so `UPSTREAM_TIMEOUT` surfaces rather than a kill (was 120 s) |
| `api/refresh` | live provider refresh + publish (was 120 s) |

**60 s**: every other route, including those previously 30 s (raised, never lowered) and those with no explicit value. No route's effective timeout decreased; the four 90/120 s routes moved *up* to 300 so that no request that used to finish can now be killed. Tightening these to 60 requires reducing the internal tool budgets first.

## ignoreCommand
Skips a deployment only when Vercel supplies a previous successful deployment SHA (`VERCEL_GIT_PREVIOUS_SHA`, present in the clone and diffable) **and every file changed since it** is on the allowlist. No previous SHA (a branch's first deployment), an unknown/shallow previous commit, a diff failure or an empty diff all BUILD; there is no `HEAD^` fallback. Allowlist: `docs/**/*.md` (except two docs traced into bundles), root `*.md`, `.claude/`, `.github/workflows/`, `test/**/*.test.ts`, offline R/analysis sources (`analysis/**/*.R|Rmd|md`), `_targets.R`, `artifacts/`, `outputs/`. Anything else — and any failure to compute the diff — builds. Mutable runtime data (`lib/football-intel/data`, `lib/role-calibration/data`, `data/intelligence-history`, `lib/game-distribution/data`, `lib/player-scheme-intelligence/data`, all other `lib/**/data`) **always builds** until externalized. `function-storage-audit` fails if any file that ships in a function would be classified skippable.

## Ceilings (provisional; do not raise silently)
physical functions <= 6; total uncompressed <= 600 MB; no function >= 80% of the 250 MB function limit; no research caches / `.rds` shipped; required runtime files present in their functions.

## Measured (clean `git archive`, `vercel build --prod`)
| | before (origin/main 90db2da) | after |
|---|---|---|
| physical lambdas | 10 | 6 |
| uncompressed / deployment | 1,048.3 MB | 544.8 MB |
| gzip estimate / deployment | 260.9 MB | 139.1 MB |
| largest function | 158.7 MB | 144.7 MB |
| at 8 retained deployments | 8.39 GB | 4.36 GB |

Remaining duplication (397 MB across lambdas) is ~85% the Next runtime copied 6 times; the rest is mutable runtime data (game-distribution 19.6, player-scheme 18.9, intelligence-history 6.5, role-calibration 5.4, football-intel 3.8 MB).

## Next stage: externalize mutable runtime data
Move the data above to Supabase Storage / object storage with content hashes recorded in the existing manifests (provenance), load at runtime through a cached reader with a pinned-version fallback, then add those paths to the `ignoreCommand` allowlist so data-only refresh commits stop deploying. Keep everything in Git for reproducibility.
