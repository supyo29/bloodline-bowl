# Phase 10 Evidence Loop — clean-runner runtime & dependency audit

Derived from the source of the Football Intelligence (`analysis/football_intel/**`,
`_targets.R`) and Player × Scheme (`analysis/player_scheme_intelligence/**`)
pipelines and the Phase 10 orchestration scripts — not guessed.

Bootstrap in one command: `Rscript scripts/bootstrap-r-deps.R` (R) + `npm ci` (Node).

## R

| Requirement | Value | Why |
|---|---|---|
| R | **4.5.x** (dev/CI pinned to 4.5.3) | dev workstation; nothing uses a >4.5 feature, ≥4.3 is the practical floor (`\(x)` lambdas in FI/PSI libs) |
| CRAN: `targets` | ≥ 1.5.0 | `_targets.R` graph; `targets::tar_make()` |
| CRAN: `nflreadr` | ≥ 1.4.0 (dev 1.5.0) | every nflverse loader in `fetch_raw.R` / `source_audit.R` |
| CRAN: `dplyr` | ≥ 1.1.0 | ubiquitous |
| CRAN: `tidyr` | ≥ 1.3.0 | `pivot_longer`, `pivot_wider` |
| CRAN: `stringr` | ≥ 1.5.0 | FI libs |
| CRAN: `purrr` | ≥ 1.0.0 | `_targets.R`, FI/PSI libs |
| CRAN: `tibble` | ≥ 3.2.0 | tibble constructors in FI/PSI |
| CRAN: `rlang` | ≥ 1.1.0 | `.data` pronoun, tidy eval |
| CRAN: `jsonlite` | ≥ 1.8.0 | manifest + `source_audit.json` |
| CRAN: `digest` | ≥ 0.6.30 | content-hash version ids (`fi:…`, `psi:…`) |
| CRAN: `yaml` | ≥ 2.3.0 | `_targets.R` `tar_option_set(packages=…)`, `coordinators.yaml` |
| CRAN: `testthat` | ≥ 3.2.0 | `analysis/*/tests/*` |
| ships with R: `MASS` | — | `lib_opponent_adj.R` ridge `solve()` fallback (`MASS::ginv`) |
| ships with R: `stats`, `utils`, `methods` | — | base |

Transitive (installed automatically as `nflreadr` / `targets` Imports; listed so a
minimal runner image includes them): `cachem, cli, curl, data.table, glue,
lifecycle, memoise, rappdirs` and the `targets` graph deps (`igraph, callr,
processx, ps, secretbase, …`).

**Not required** (confirmed unused by the evidence path): `arrow`, `readr`,
`qs`/`qs2`, `future`/`furrr`/`progressr`, `renv`. `nflreadr` 1.5.0 downloads
`.rds` from nflverse GitHub releases and does not need `arrow`.

### OS-level

* `libcurl` (+ headers on a build-from-source runner: `libcurl4-openssl-dev`,
  `libssl-dev`) — `nflreadr` fetches over HTTPS.
* Outbound network egress to `github.com` (release assets) and
  `objects.githubusercontent.com`. No API keys, no auth, no scraping.
* ~1.5 GB free disk for the raw `.rds` cache (`analysis/football_intel/cache/`,
  git-ignored) — `pbp.rds` alone is ~190 MB for 2012–current.
* Wall time: a cold `npm run evidence:certify` is dominated by the nflverse
  download + `tar_make()` rebuild — budget **45–75 min** on a clean runner.

## Node

| Requirement | Value | Why |
|---|---|---|
| Node | **22.x** (dev v22.22.1; CI pinned to 22) | `package.json` has no `engines`; 20+ works, 22 LTS chosen |
| npm | bundled with Node 22 | `npm ci` from `package-lock.json` |
| npm deps | dev-only: `next, react, react-dom, @types/*, eslint, eslint-config-next, tsx, typescript` | `evidence:certify --full-regression` runs `npm test` / `npm run typecheck` / `npm run lint`; the freshness gate is dependency-free `node:*` only |

There are **zero runtime npm dependencies**. `scripts/evidence-freshness-gate.mjs`
and `scripts/weekly-evidence-refresh.sh`'s embedded Node use only `node:fs` /
`node:path` / `node:child_process`.

## What `npm run evidence:certify` needs, end to end

1. `Rscript` on `PATH` with the R packages above → stages 1–7, 9–10.
2. `node` on `PATH` → the freshness gate (stage 8) + report writer.
3. `npm` + `node_modules` (from `npm ci`) → stages 11–13 (`--full-regression`).
4. `git` on `PATH` → the run ledger records `git rev-parse HEAD`.
5. Network egress to the nflverse GitHub releases.

`weekly-evidence-refresh.sh` already checks 1–4 up front (`command -v`) and exits
`127` with a clear message if any are missing.
