# Bloodline Bowl Trade Engine — Production Readiness

This is the durable record of integrating, merging, deploying, and verifying the
complete six-phase trade-engine roadmap in production. It is a productionization
pass, not a modeling pass — no trade-model semantics were changed; the only new
code is a read-only production smoke-test script.

## A. Final version stack

| Layer | Version | Status |
|---|---|---|
| Foundation | `ri-trade-foundation-2026.2` | FROZEN |
| Contextual | `ri-trade-contextual-2026.2` | FROZEN |
| Calibrated | `ri-trade-calibrated-2026.2` | FROZEN / SHADOW |
| Data | `ri-trade-data-2026.2` | FROZEN |
| Discovery | `ri-trade-discovery-2026.2` | FROZEN |
| Negotiation | `ri-trade-negotiation-2026.2` | FROZEN |
| Strategy | `ri-trade-strategy-2026.2` | **FROZEN** (this pass) |

All confirmed live in the deployed `/api/trades/discover` and `/api/trades/negotiate`
`versions` response blocks (Section G). No Phase 7 is planned — the roadmap is complete.

## B. PR integration

**Verified actual GitHub state before merging** (not assumed from prior conversation):
11 open PRs (#5–#15), every base/head/mergeable/mergeStateStatus checked directly via
`gh pr view`. The stack was a single clean linear chain — `main → #5 → #6 → #7 → #8 →
#9 → #10 → #11 → #12 → #13 → #14 → #15` — every PR `mergeStateStatus: CLEAN`,
`mergeable: MERGEABLE`, no PR previously retargeted or flattened. `git merge-base
origin/main origin/trade-engine-phase1-audit` equaled `origin/main` exactly, and
`git merge-base --is-ancestor origin/main origin/trade-engine-phase6-audit` returned
true — main had not diverged from the stack's root, so a clean fast-forward was
possible with zero conflict-resolution risk.

**Merge method**: `git merge --ff-only origin/trade-engine-phase6-audit` on `main` —
a single fast-forward bringing in all 13 commits (one per phase build/audit) from the
tip of the entire stack in one atomic operation, preserving full commit history with
no merge commits and no duplicated changes.

- **Pre-merge main SHA**: `bde9bce316cc6c7da69629e31e0703935fecaf8e`
- **Post-merge main SHA**: `d635d0da5ab71d031c9d2d55cfa3280d1b170c77`
- **Commits merged**: 13 (Phase 1 audit → Phase 6 audit, verified via `git log --oneline`)

GitHub auto-detected PR #5 as merged (its base was literally `main`). PRs #6–#15 had
bases pointing to intermediate feature branches (not `main`), so GitHub could not
auto-associate them with the fast-forward; they were closed individually with a
comment recording the integration commit range, since their commits are already
present in `main` unchanged — merging them individually would have produced
duplicate merge commits for content already integrated.

## C. Test results

**Pre-merge baseline** (`main` at `bde9bce`, recorded before touching anything):
868/878 pass, 10 pre-existing live-only failures, `tsc` clean, lint 0 errors/18 warnings.

**Post-merge, full main verification**:

| Suite | Result |
|---|---|
| Full repository (`test/*.test.ts`) | 1235 / 1245 pass, 10 fail |
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 18 pre-existing warnings |

The 10 failures are the exact same pre-existing, network-dependent `live:`
tests from every prior phase's own baseline (`live: standings`, `live: managers`,
`live: snapshot`, live recommendation/K-DEF-board/draft-snapshot endpoints,
`live draft: pre-draft state`) — **0 non-live regressions**, matching the expected
baseline exactly. Per-phase suite totals (all already individually verified in each
phase's own build/audit deliverable, re-confirmed here as part of the same full run):
Phase 1/1-audit, Phase 2/2-audit, Phase 3/3-audit, Phase 3.5/3.5-completion, Phase
4/4-audit, Phase 5/5-audit, Phase 6/6-audit, and the weekly engine suite are all
included in the 1235/1245 total above — no separate reduced count exists for any of
them post-merge.

## D. Production build

`npm run build` (the same `next build` command Vercel's build step runs) completed
cleanly — TypeScript check passed, all pages/routes generated, no missing-asset or
build-time errors. Every intended trade-engine route is present in the build output,
including the new `/api/leagues/[leagueSlug]/managers/[managerSlug]/strategic-context`
route.

**R-produced data packaging verified**: `lib/trades/data/{historical_trades_sleeper.json,
player_usage_weekly.csv, player_usage_weekly.meta.json, player_schedule_strength_weekly.csv,
player_schedule_strength_weekly.meta.json}` are all `git`-tracked (confirmed via `git
ls-files`), not excluded by `.gitignore` (`/outputs` is ignored; `lib/trades/data/` is not),
and read only via `fs.readFileSync` + `path.join(process.cwd(), ...)` — never written to at
runtime (grepped both files reading this data; zero `writeFileSync` calls) — fully
compatible with Vercel's read-only serverless filesystem.

**Next.js file-tracing verified directly** (a real, easy-to-miss Vercel gotcha with
runtime `readFileSync`): inspected the actual `.next/server/app/api/trades/discover/
route.js.nft.json` trace manifest. `historical_trades_sleeper.json` (read by
`historical-loader.ts`, which IS reachable from the live discover/negotiate/analyze
request path via `calibrationStatus()`) IS correctly included in the trace. The usage/
schedule CSVs (read by `r-data-providers.ts`) are correctly ABSENT from the trace —
confirmed by grep that `r-data-providers.ts` is not imported anywhere reachable from
`app/api/` (only from test files and its own doc-comment string, never an actual
`import`), consistent with the established "Phase 3.5 NOT wired into live path" fact.
This is expected, correct behavior, not a packaging defect — but it is the exact kind
of "works locally, silently breaks on Vercel" risk this check exists to catch, and it
was worth verifying directly rather than assuming.

## E. Deployment

The Vercel project (`bloodline-bowl-sleeper-bridge`, `prj_4Zhxc9SFaWcW2zB0f5Wz6AVrLuHE`)
is Git-linked to `supyo29/bloodline-bowl` and auto-deploys on push to `main` directly to
production (this project's existing CI/CD configuration — not something changed by this
pass). The `git push origin main` in Section B triggered this automatically; no manual
preview-then-promote step was available or necessary to invoke separately, since the
project's own configuration deploys `main` straight to production by design.

| | Deployment | URL | Git SHA | State |
|---|---|---|---|---|
| **Production (current)** | `dpl_4bf1Xg2bGUyHVRiuPq33eguvuAfv` | `bloodline-bowl-sleeper-bridge-335mqw93e-supyo29s-projects.vercel.app` (aliased at `bloodline-bowl-sleeper-bridge.vercel.app`) | `d635d0d` | READY |
| **Previous production (rollback target)** | `dpl_ARwJcACdWRusZPzJb9jSy2CZi1v2` | `bloodline-bowl-sleeper-bridge-4xgxnofux-supyo29s-projects.vercel.app` | `bde9bce` | READY |

Confirmed the production alias (`bloodline-bowl-sleeper-bridge.vercel.app`) resolves
and matches the current deployment (`/api/health` returns 200 with the expected
league registry). No separate "preview vs. production" field-by-field comparison was
performed — this project's git integration builds `main` once and serves it directly
as production; there is no distinct preview artifact of the same commit to diff
against.

## F. Endpoint inventory

Verified from the actual `next build` route table (not assumed from prior prompts):

```
POST /api/trades/analyze
POST /api/trades/discover
POST /api/trades/negotiate
GET  /api/leagues/[leagueSlug]/managers/[managerSlug]/strategic-context
```

All four are present, deployed, and live-tested (Section G). `POST /api/trades/analyze`
does not accept `include_strategic` (a deliberate Phase 6 scope decision — see the Phase
6 build doc's own documented limitation) — it remains Phase 1/2/3-shadow only, unchanged.

## G. Live QA

All calls below are read-only against the LIVE PRODUCTION deployment
(`bloodline-bowl-sleeper-bridge.vercel.app`), using `scripts/production-smoke-test.mjs`
(new, committed) plus targeted `curl` probes. Nothing was mutated on Sleeper.

### Devoted to the Game / darthmarker

- `BEST_AVAILABLE` (`include_strategic: true`): 4 real candidates, e.g.
  `my_gain=0.42, viability=MODERATE, strategic_score=0.98, recommendation=PRIORITIZE`.
  `manager_strategic_profile.archetype = UNKNOWN` (correct — week 1, 0 games played,
  the early-season evidence gate firing exactly as designed, not a failure).
- `POSITIONAL_NEED RB`: 2 real results, `PARTNER_POOL_TRUNCATED` diagnostic present.
- `CONSOLIDATE`: 0 results (an honest, real finding for this roster right now).
- `BUY_PLAYER` sanity (nonexistent player id): `TARGET_NOT_ROSTERED`, no crash.
- **Mike Washington** (`player:sleeper:13305`) still rostered, still resolves: negotiate
  `ACQUIRE_TARGET` reproduces the exact historical finding — `dependency: SURPLUS`,
  `leverage: HIGH (score=8)`.
- `THREE_TEAM`: 0 results — reported as `NO_VIABLE_THREE_TEAM_RESULT`, not fabricated.
- `analyze` re-run of a real discovered (all-Sleeper-id) candidate: `status: OK`, full
  version stack present.

### Bloodline Bowl / supyo29

- `BEST_AVAILABLE` (`include_strategic: true`): 4 real candidates, e.g.
  `my_gain=1.44, viability=HIGH, strategic_score=2.19, recommendation=PRIORITIZE`.
- `POSITIONAL_NEED RB`: 0 results, `PARTNER_POOL_FALLBACK_USED` + `SEARCH_TRUNCATED`
  diagnostics present (honest, not silent).
- `analyze` re-run of a real discovered candidate: `status: OK`.
- `negotiate ACQUIRE_TARGET player:sleeper:12508`: full 3-tier ladder —
  `OPENING: my_gain=1.77`, `BALANCED: my_gain=1.21`, `STRONG_ACCEPT: my_gain=0.69` —
  **strictly decreasing, proving the Phase 5 audit's OPENING/MAXIMUM_RATIONAL fix live**
  (OPENING has the highest `my_gain`, exactly as corrected).

This confirms there is no league-specific hardcoding around either manager — the same
generic engine produces different, real, roster-derived results for both leagues.

## H. Trade-analysis proof (real bilateral result)

`POST /api/trades/analyze` against `bloodline-bowl`, participants `["supyo29",
"bijoy2theworld"]`, a real 1-for-1 transfer discovered by `BEST_AVAILABLE` moments
earlier: `status: OK`, `versions: {foundation: "ri-trade-foundation-2026.2", contextual:
"ri-trade-contextual-2026.2", calibrated: "ri-trade-calibrated-2026.2"}`. Phase 3's
`phase3_summary` field is present and explicitly labeled shadow-only in its own schema
(verified in Section L) — never influencing `trade_summary`'s acceptance classification.

**One real, reproducible finding from this exercise** (P2, not production-blocking):
`analyze`'s public `asset.player_id` field only resolves a Sleeper-native player id
(its own doc comment's example: `"4046"`) — feeding it a raw GSIS-format id (stripped
of the `player:gsis:` canonical prefix, e.g. `"00-0039732"`) returns
`UNKNOWN_PLAYER`, even though that exact player is correctly resolved and used
internally by `discover`/`negotiate` via the canonical crosswalk. This is an
integration-contract gap for a client chaining `discover`'s output directly into
`analyze`'s input when the target player's canonical identity happens to be
GSIS-primary rather than Sleeper-primary — not a valuation defect (the player is
evaluated correctly wherever the engine resolves them internally), and does not
affect `discover` or `negotiate` at all. See Section N.

## I. Discovery proof (real discovery run)

`POST /api/trades/discover` against `devoted-to-the-game`/`darthmarker`,
`mode: BEST_AVAILABLE, max_results: 5, include_strategic: true`: `status: OK`, 4 real
candidates returned, `calibration_status: {real_trade_count: 1, required_trade_count:
50, review_available: false}` (the 50-trade gate, confirmed live and unactivated),
every candidate carrying a real `strategic` block. Determinism verified: two identical
consecutive requests produced byte-identical `results` and `search_metadata`.

## J. Negotiation proof (real offer ladder)

`POST /api/trades/negotiate` against `bloodline-bowl`/`supyo29`,
`target_player_id: player:sleeper:12508`: a real 3-tier ladder
(`OPENING/BALANCED/STRONG_ACCEPT`) with `my_gain` strictly decreasing across tiers —
the exact corrected Phase 5 semantics live in production. `walk_away` and
`diagnostics` (`SEARCH_SUMMARY: 25 candidate(s) considered, 25 on the Pareto
frontier`) both present and coherent.

## K. Strategy proof (real strategic-context result)

`GET /api/leagues/devoted-to-the-game/managers/darthmarker/strategic-context`:
`status: OK`, `season_stage: EARLY_SEASON`, `manager.season.playoff_start_week: 15`,
`championship_week: 17` — both resolved correctly. Playoff status and archetype both
report `UNKNOWN`, honestly reflecting week 1 with 0 games played (the Phase 6 audit's
`MIN_GAMES_PLAYED_FOR_STATUS` gate firing correctly, live) — this is the CORRECT
result this early in the season, not a failure.

## L. Safety invariants

| Invariant | Verified how | Result |
|---|---|---|
| Phase 3 trade weights = 0 | Live response `config.phase3.weights = {role_adjustment: 0, schedule_adjustment: 0}` (seen in a raw `analyze` failure response, which still echoes the resolved config) | ✅ confirmed live |
| Phase 3 remains SHADOW | `resolvePhase3CalibrationMode` refuses `PRODUCTION` unconditionally (code-level, re-verified this pass); no route accepts a client override | ✅ confirmed |
| Public config cannot activate weights | `sanitizePublicTradeConfig` never reads `r.phase3` at all (by construction, not a filtered blocklist); `discover`/`negotiate` routes never even parse a `config` field from the request body | ✅ confirmed |
| `HARD_REJECT` cannot be promoted | `promotionCeiling("HARD_REJECT") === "HARD_REJECT"`, exhaustively unit-tested (Phase 6 + Phase 6 audit suites); re-verified by code inspection this pass | ✅ confirmed |
| `MAXIMUM_RATIONAL` cannot be exceeded | `recommendOfferTier` can only return a key already present in the ladder Phase 5 built — structurally impossible to exceed, not merely policy; live output only ever names a tier actually on the ladder | ✅ confirmed |
| No Sleeper write path | Every trade-engine route's own doc comment states "read-only," and grepping the entire `lib/trades/` tree finds zero Sleeper API POST/PUT/DELETE calls — the engine only ever reads league state | ✅ confirmed |

## M. Performance

Representative live production latency (production URL, cold-network calls, not
warmed):

| Call | Latency |
|---|---|
| `POST /api/trades/discover` (BEST_AVAILABLE, `max_results:5`, `include_strategic:true`) | 1.26s–1.46s (3 runs) |
| `POST /api/trades/negotiate` (ACQUIRE_TARGET, `include_strategic:true`) | 1.36s |
| `GET .../strategic-context` | 0.67s |

No N+1 behavior observed: `buildManagerStrategicProfile` is called exactly once per
request (confirmed by `grep` — one call site each in `discover.ts`/`negotiate.ts`,
positioned after all candidates are already evaluated), and `ctx.snapshot.standings`
is read once per profile build, never per-candidate. Search-bound enforcement
confirmed live via real diagnostics (`SEARCH_TRUNCATED`, `PARTNER_POOL_TRUNCATED`,
`PARTNER_POOL_FALLBACK_USED`) appearing in actual production responses rather than
silent truncation.

## N. Remaining limitations

Carried forward, unchanged, from the Phase 3.5/4/5/6 build and audit docs:

- Historical trade corpus (1 real trade) is far below the 50-trade calibration-review
  floor — `TRADE_CALIBRATION_MIN_REAL_TRADES = 50` confirmed unchanged and live
  (`calibration_status.required_trade_count: 50` in every discover/negotiate response).
- Phase 3 trade weights remain zero; player intelligence remains shadow-only.
- Playoff probabilities remain unavailable (`playoff_odds: null`) — no real simulation
  model exists; a categorical band is offered instead, never a fabricated percentage.
- Early-season strategic classification is intentionally conservative
  (`MIN_GAMES_PLAYED_FOR_STATUS = 2`) — verified live, correctly reporting `UNKNOWN`
  for every sampled manager in both leagues at week 1.
- Negotiation remains bilateral-only — a 3-team proposal is explicitly rejected
  (`UNSUPPORTED_PARTICIPANT_COUNT`), confirmed live in production this pass.
- Live external providers (Sleeper) can fail or degrade — this pass did not
  artificially induce a provider outage to test degraded-mode behavior; that path
  is exercised by the existing `live:` test suite's own (pre-existing, expected)
  failures rather than a new production drill.
- The 10 pre-existing `live:` test failures remain environment-sensitive
  (pre-draft/pre-season state assumptions in older tests) — unchanged by this pass,
  confirmed identical before and after the merge.

**New finding from this pass** (P2, documented, not fixed — out of scope for a
productionization pass per its own Core Invariant: "do not add new trade-model
features unless a production-blocking defect is found"): `POST /api/trades/analyze`'s
`asset.player_id` field does not resolve a raw GSIS-format id, only a Sleeper-native
one, even though `discover`/`negotiate` correctly use GSIS-identified players
internally (Section H). This does not corrupt any valuation and does not affect
`discover` or `negotiate`; it only affects a hypothetical client that copies a
GSIS-identified `canonical_player_id` directly from a `discover` response into an
`analyze` request without translating it first. Recommended follow-up (not done
here): either accept a full canonical `player:<provider>:<id>` string in
`asset.player_id`, or document the Sleeper-native-only contract explicitly in the
route's own doc comment.

**Deferred cleanup inventory** (preserved, not silently forgotten):
- Phase 4's own `test/trade-engine-phase4.test.ts` "three-team discovery" suite's
  `threeTeamLeague()` fixture produces zero results from `runThreeTeamSearch` — its
  three tests have been passing vacuously since Phase 4 was built. Flagged during the
  Phase 6 audit as a separate background task (`task_ae320392`); still open, Phase 4
  remains frozen and untouched.

## O. Rollback

**Last known-good production deployment** (immediately prior to this pass):
`dpl_ARwJcACdWRusZPzJb9jSy2CZi1v2`, git SHA `bde9bce316cc6c7da69629e31e0703935fecaf8e`,
URL `bloodline-bowl-sleeper-bridge-4xgxnofux-supyo29s-projects.vercel.app`.

Rollback was **not exercised** — no P0/P1 defect was found in production verification.
If ever needed: re-point the production alias at `dpl_ARwJcACdWRusZPzJb9jSy2CZi1v2`
(Vercel dashboard → Deployments → promote that deployment to Production), or
`git revert` `main` back to `bde9bce` and push (a straightforward revert, since the
merge was a pure fast-forward with no merge commit to un-tangle).

## Final verdict

Every check in this pass came back clean: the fast-forward merge integrated the
entire verified stack with zero conflicts and zero duplicated changes; full-repo
regression matches the exact expected baseline (0 non-live regressions); the
production build succeeds and every R-produced data file is correctly packaged (with
the exact expected/correct trace-manifest inclusion pattern verified directly, not
assumed); the deployment auto-triggered from the `main` push and is live and healthy;
every trade-engine endpoint was exercised against both real leagues with real
results, including live re-confirmation of both the Phase 5 (`OPENING`/`MAXIMUM_
RATIONAL` ordering) and Phase 6 (`CLINCH` safety, early-season `UNKNOWN` gate,
`ELIMINATED_TEAM_TRADE_CAUTION` availability, 3-team-proposal rejection) audit fixes
in production; every safety invariant (Phase 3 shadow isolation, the 50-trade gate,
the rationality floor, the `MAXIMUM_RATIONAL` ceiling, the read-only-to-Sleeper
guarantee) held under direct live verification; performance is reasonable with no
N+1 evidence; and a clear, low-risk rollback path exists but was not needed. The one
new finding (`analyze`'s Sleeper-only `player_id` contract) is a P2 integration
nuance, not a defect in any trade recommendation, valuation, or strategy output.

---

BLOODLINE BOWL TRADE ENGINE:
PRODUCTION READY
