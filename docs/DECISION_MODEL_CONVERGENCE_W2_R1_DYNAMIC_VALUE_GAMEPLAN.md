# Decision Model Convergence — W2.R1 Dynamic Player Value & Game-Plan Intelligence Foundation

Branch `intelligence-convergence-w2-r1-dynamic-value-gameplan`, base `24cadb8d1761652220af6284f2fc757ec2822e06` (PR #44 merge into the W2 stack). **SHADOW / RESEARCH ONLY.** Nothing here may change a production recommendation.
Status of this document: **opening checkpoint** (environment, baseline, inventory, data audit, preregistration, implementation plan). Model results are added only after the preregistration commit.

## 1. Environment repair and clean baseline
The earlier build failure was environmental: `node_modules` was a symlink outside the project root and Turbopack rejects that. Fix: removed only the symlink and ran `npm ci` from the lockfile (352 packages, no dependency change, `git status` clean afterwards).

| Gate | Result at base `24cadb8` |
|---|---|
| TypeScript | clean |
| lint | 0 errors / 41 warnings (pre-existing) |
| production build | passes |
| full suite | **3,860 tests / 3,856 pass / 0 fail / 4 skipped** (the 4 live-only `draft-live` pre-draft tests) |
Matches the inherited expectation exactly; no diagnosis needed.

## 2. Architecture inventory (what exists, what W2.R1 must reuse, what is new)
| Capability | Existing substrate | W2.R1 stance |
|---|---|---|
| Canonical forecast, injury model, bye/asset hold value | `lib/weekly/forecast/*` (W1: schema, build, injury-model, asset.ts `canonicalAssetValue`/`holdWeeklyValue`, bye.ts) | **Reuse as the only availability authority.** W2.R1 adds NO injury/availability model and never re-discounts. |
| Legal lineup optimization | `lib/weekly/lineup.ts` (`buildOptimalLineup`, Hungarian), `slots.ts` (FLEX/SUPERFLEX matching) | Reuse as the lineup oracle inside the replacement-chain simulator. |
| Replacement baseline | `lib/weekly/replacement.ts` (static `nth_best_available` frontier; verified-pool basis certified) | **Control** for Dynamic VOR; the new simulator replaces it only in shadow. |
| Verified market | `lib/market-state/*` (Yahoo + Sleeper, certified live), `lib/weekly/market-pool-adapter.ts`, `lib/waiver2/*` | Reuse. Provider-neutral; FA/waiver/FAAB/priority/pending claims already canonical. |
| Role & Opportunity | `lib/role-calibration`, `lib/role-shadow`, `lib/player-role-intelligence`, W2.P1 harness (`scripts/w2p1`), W2.P2 shadow capture | Reuse; W2.P1 challenger C2 is the incumbent comparator (B2p). |
| Game environment / distribution | `lib/game-distribution` (Phase 3 shadow), `lib/game-weather` | Reuse as inputs (implied totals, weather); distribution machinery informs quantile outputs. |
| Matchup / scheme | `lib/matchup2`, `lib/player-scheme-intelligence` (spatial, charting prior; **Tier-D interaction research was a clean null**), `lib/football-intel` | Reuse the data substrates; **the prior null is a warning**: W2.R1 must not assume interaction value exists. |
| Injury propagation | `lib/opportunity-propagation-intelligence`, `lib/roster-health` | Reuse/extend into the explicit propagation graph. |
| Waiver / asset value | `lib/waiver2/value.ts` (`assetValue`, drop cost), `lib/weekly/waivers.ts` | Control and consumer; unchanged. |
| K / D/ST | `lib/weekly/forecast/build.ts` flags `K_DST_SOURCE_USES_STANDARD_SCORING_FALLBACK`; `lib/draft/kdst.ts`, `scripts/scoring-kdst-materiality.ts` | **Gap**: no component model exists. New. |
| Dynamic VOR | none (only draft-time VOR in `lib/draft`, and the static weekly frontier) | **New**: roster-cascade simulator + VOR decomposition. |
| Breakout / upside probability | none empirical | **New**: base-rate-first models with out-of-time gates. |
| Game-plan inference (offense/defense/counters) | none as a layer (charting priors only) | **New**, tier-A/B feature discipline below. |

## 3. Historical data audit (read-only, `scripts/w2r1/data_audit.R` → `scripts/w2r1/results/data_audit.json`)
Rows by season (nflverse): player stats, schedules, injuries, snap counts, play-by-play, team stats are complete 2020–2025 and present for **2026 through week 5** (79 completed games; weeks 1–4 = 16 games, week 5 = 15). FTN charting exists **2022–2026** (motion, play action, screen, RPO, blitzers/pass rushers, box, out-of-pocket). Next Gen passing 2020–2026.
**Decisive findings that shape the design**
1. **Participation (formation, personnel, box, man/zone, coverage shell, routes) exists 2020–2025 only; 2026 = 0 rows.** Same-season tactical truth for 2026 is limited to pbp + FTN. Hence the preregistered *tier A* (all seasons, identical definition) vs *tier B* (carryover only for 2026) feature discipline.
2. `pbp` itself lacks formation/personnel/coverage/pressure fields; they come from participation/FTN.
3. **No point-in-time historical fantasy rosters, waiver pools or FAAB** are stored for the registered leagues → retrospective Dynamic VOR validation must use seeded synthetic rosters on each league's real slot structure; real-roster evaluation is prospective only.
4. No stored history of real Sleeper/RotoWire projections → proxy champion (B0p/B1p), as in W2.P1; any gain is an upper bound.
5. 2025 weeks 14–17 were W2.P1's FINAL; they are VAL-contaminated here. The only untouched FINAL is **2026 weeks 1–5** (small N: positions that cannot reach the preregistered sample sizes are labelled `INSUFFICIENT_FINAL_SAMPLE`, never passed).

## 4. Preregistration
`scripts/w2r1/prereg.json` (sha256 `6caf1f70…`) fixes, before any modelling: splits (FIT 2022–24, VAL 2025, FINAL 2026 wk 1–5, PROSPECTIVE wk ≥ 6), scoring regimes and fingerprint compatibility, baselines, the declared candidate ladder (R → +OFF → +DEF → +INT → +SECOND → +PROP) with a fixed inclusion rule, forecast gates T1–T10 (including the ≤ 10 % cap-hit hard fail and the must-beat-Role gate), breakout labels and gates B1–B6 (`NO_RELIABLE_SIGNAL` is a first-class outcome), K/D-ST components and gates, Dynamic-VOR retrospective protocol and gates V1–V4, missing-data rules, rollback criteria, exploratory-only list, performance budget and the freeze protocol.

## 5. Implementation plan (staged; each stage ends green on the full suite + mutants)
| Stage | Deliverable | Notes |
|---|---|---|
| S1 | **Evidence contract** `lib/w2r1/evidence/*`: provider-neutral point-in-time record (identity, scoring fingerprint, timestamps/age, confidence, provenance, missing-evidence reason) + invariants (no feature without provenance; unknown ≠ 0) | pure types + validators + tests |
| S2 | **Roster-state + replacement-chain simulator** `lib/w2r1/roster/*`: starters/bench/IR/PUP/FLEX/SUPERFLEX/K/DST, full legal-lineup re-optimization with/without a player, replacement sources in order (bench → flex-eligible → IR return → verified pool → K/DST streamers), acquisition realism (FA/W, FAAB, priority, pending claims, drop cost) | reuses `buildOptimalLineup` |
| S3 | **Dynamic VOR decomposition** `lib/w2r1/vor/*`: weekly roster, ROS (future byes, injury horizon), hold, streaming-adjusted, scarcity, league, private, market-input; bye invariants; scoring-fingerprint tagging | property tests incl. K/DST |
| S4 | **K and D/ST component models** (exact scoring), spike probabilities, streaming VOR | R feature build + TS evaluator |
| S5 | **Historical tactical dataset + game-plan layers** (R, tier A/B), continuity weighting, OFF/DEF/INT/SECOND/PROP candidates; ablation on FIT/VAL | exploratory vs binding clearly separated |
| S6 | **Breakout/upside study** with negative examples, base-rate-first models, calibration gates | may end `NO_RELIABLE_SIGNAL` per position |
| S7 | **Retrospective harness** (FIT/VAL/FINAL), freeze, one FINAL look, per-position qualification, VOR validation (V1–V4) | FROZEN.json before FINAL |
| S8 | **Shadow persistence** extension (additive to W2.P2), bridge diagnostics route, simple/deep explanation contract, manifest | additive; no migration applied remotely |
| S10 | **Live shadow validation (exit requirement)**: after S1-S9 are green (full suite 0 failures, all W2.R1 mutants killed or justified, tsc/lint/build clean, no P0/P1, leakage/bye/injury/provider-isolation/no-production-influence tests passing), deploy a PROTECTED Vercel preview of this branch on live Sleeper + certified Yahoo data (existing automatic OAuth lifecycle; no manual tokens) exposing additive, clearly-labelled `W2.R1 SHADOW` diagnostics with a CURRENT PRODUCTION vs W2.R1 SHADOW side-by-side; live-smoke every accessible registered league; fix-redeploy-repeat until clean. Authorization note: the preview needs the production env scope exposed to preview again (reverted after each run) — requested when S10 starts. | no production influence; no merge to main |
| S9 | **Mutation suite** (all 20 listed dangerous assumptions), isolation proof (source-scan + byte-identical production surfaces), performance measurement, final doc + verdict | |

## 6. Standing constraints for this phase
No merge, no deploy, no production flag/cron/migration, no remote DB write, W2.P2 kickoff worktree and its scheduled jobs untouched. Any migration is written and tested locally only.

*(Sections for results, position-specific qualification, K/D-ST, breakout, calibration, tests, mutations, limitations and the 29 final answers are appended by later stages.)*

## 7. Early live shadow preview (S1–S3 + S8-minimal) — 2026-10-14

**Not the final W2.R1 model and not the S10 exit gate.** Every response is labelled `W2.R1 EARLY SHADOW — DIAGNOSTIC`, lists layer availability (S1/S2/S3 AVAILABLE; S4/S5/S6 NOT YET QUALIFIED; S7 NOT YET RUN), carries the K/DST notice
(*K/DST Dynamic VOR mechanics are live; K/DST forecast quality is not yet W2.R1-qualified*), exposes **no breakout/upside probability**, and states `production_influence: NONE`.

**Surface (additive, protected, never served from a Vercel production deployment):** `GET /api/w2r1/manifest`; `GET /api/w2r1/{league}/{manager}/{roster|player|drop|add|kdst|compare}?week=&player=&limit=`.
It builds the same canonical weekly context production uses (`runWithWeeklyContext`), adapts it (`lib/w2r1/adapter.ts`: Sleeper OR Yahoo, canonical forecasts only — Wave-1 `expected_points` verbatim, `conditional_active_points` as the underlying value, **no second availability discount**), and runs S1–S3.
Future weeks are an explicit proxy (Wave-1 hold rate; ROS rate as cross-check, disagreement exposed; verified byes; long-term injury horizon; confidence LOW). Sleeper acquisition success is UNKNOWN (inferred pool) and is never counted in the expected VOR; a verified Yahoo FA is certain; a Yahoo waiver claim is unknown.

**Live defects found by this run (treated as defects, not tuned away)**
| # | Severity | Defect | Fix |
|---|---|---|---|
| 1 | **P1 (inherited from PR #44 integration)** | Yahoo roster players kept provider-scoped ids (`player:yahoo:*`): weekly/trades/roster-health built their own default crosswalk and passed it as `crosswalkOverride`, which made the state builder skip the Yahoo→Sleeper bridge. Production lineup/waiver for Yahoo leagues saw 3/17 (Maclin) and 5/15 (Rogers Park) roster players projected while the market pool was bridged. | `resolveLeagueCrosswalk` (lib/canonical/yahoo-bridge-source.ts) is the one crosswalk entry point for all three callers; tests + mutant W33; `waiver2-integration` pin ledger updated with the justification. **Needs to reach the parent W2 branch / main by a separate decision (it changes production Yahoo behaviour for the better).** |
| 2 | P2 (W2.R1) | An acquisition could enter a full active roster; removing an IR player appeared to free an active spot. | adds limited to open active capacity (test + W34) |
| 3 | P2 (W2.R1) | An IR-slot player with no known designation was assumed activatable now and entered every counterfactual lineup. | unknown designation ⇒ not returnable (test + W35) |
| 4 | P2 (W2.R1) | The ROS-per-game future proxy was inconsistent with the current week (a starting QB: 17.2 this week, 2.1 per future week). | primary future proxy = Wave-1 hold rate, ROS rate as cross-check, disagreement flagged `FUTURE_PROXY_DISAGREES_WITH_ROS_RATE` |
| 5 | P3 | Sleeper has no market-state summary: freshness was unknown with no observed time; compare view mapped production waiver recs wrongly. | observed time = league snapshot time (freshness state not asserted); mapping fixed |

**Live validation (week 6, preview `il8bchcks`, code `f64ea5f`; evidence `docs/evidence/w2r1-early-shadow-live-2026-10-14.json`)**
All 4 reachable registered leagues: Maclin (Yahoo, PRIORITY, 2QB), Rogers Park (Yahoo, FAAB, 2 W/R/T), Bloodline Bowl (Sleeper, 2 FLEX), Devoted (Sleeper, 3 FLEX, 2 IR). Sporty's Alumni (Sleeper) was not exercised (no manager registered for it).
- W2.R1's re-optimized lineup equals production's in 4/4 leagues (totals 137.72 / 103.42 / 115.59 / 122.46; 0 starter-set differences).
- Bye stars: weekly 0 with Hold/ROS preserved (Sleeper St. Brown; K on a bye in Devoted). Injured/OUT starter (Rogers Park TE): weekly negative = a verified FA TE fills the empty slot; FLEX cascades, deep bench, IR, empty slots and unknown-value players all exercised; unknown-probability waiver adds appear only as the optimistic bound.
- **Production non-influence, live:** production `/waivers` and `/lineup` outputs for 3 leagues were byte-identical before and after W2.R1 calls.
- Token lifecycle under load: automatic refresh on expired tokens, both connections HEALTHY, no reauthorization; no credential in any output/log.
- Latency: server time cold/warm — Yahoo roster 10–17 s / 4–9 s (context + 140 provider reads dominate; the VOR compute itself is 1.0–1.6 s), Sleeper 3–4 s / 0.5–1 s. The prereg warm budget (1.5 s) is **not met for Yahoo**; context reuse across views is future work.
- Secret scope: Vercel custom environments are unavailable (limit 0), so the only mechanism was preview-wide scope on the six Yahoo/Supabase variables, widened **only for the ~80 s of each redeploy** and restored to production-only immediately (6 windows); env values are baked into the deployment at build time. Superseded secret-bearing previews were deleted. Durable alternative (recommended before a long-lived test environment): a separate Vercel project/team-scoped env group for the shadow environment.

**Known limitations of the early preview:** FAAB bids/competition are not modelled; future weeks are flat; K/DST forecasts are the inherited generic ones; no game-plan, breakout or calibration layers yet; a bench/non-lineup player's weekly VOR can be negative when a roster spot is better used on a verified add (explained per player in `negative_value_reason`).
