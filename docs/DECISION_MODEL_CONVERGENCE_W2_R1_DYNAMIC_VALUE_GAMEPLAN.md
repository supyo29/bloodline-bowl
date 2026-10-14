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
| S9 | **Mutation suite** (all 20 listed dangerous assumptions), isolation proof (source-scan + byte-identical production surfaces), performance measurement, final doc + verdict | |

## 6. Standing constraints for this phase
No merge, no deploy, no production flag/cron/migration, no remote DB write, W2.P2 kickoff worktree and its scheduled jobs untouched. Any migration is written and tested locally only.

*(Sections for results, position-specific qualification, K/D-ST, breakout, calibration, tests, mutations, limitations and the 29 final answers are appended by later stages.)*
