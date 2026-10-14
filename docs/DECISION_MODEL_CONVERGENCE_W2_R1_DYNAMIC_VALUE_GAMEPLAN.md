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

## 8. S4 — dedicated K and D/ST component models (stage report; VAL only — FINAL untouched)

**Label: DIAGNOSTIC.** Qualification labels (QUALIFIED / INSUFFICIENT_FINAL_SAMPLE / NO_RELIABLE_SIGNAL) are assigned only at S7 on the frozen 2026 weeks 1–5 evaluation. Nothing here influences production.

**Design (fixed before fitting: `scripts/w2r1/s4_spec.json`, `s4_regimes.json`; `prereg.json` unchanged, sha256 `6caf1f70…`).** K and D/ST are modelled from COMPONENTS and scored under each league's exact scoring:
K = FG attempts (Poisson, as-of team rate + opponent + implied total ± weather/spread) × distance-bin shares × make probability (league logistic on distance/wind/dome/cold × kicker empirical-Bayes ratio) + XP; D/ST = sacks, interceptions, fumble recoveries (Poisson GLMs on as-of team/opponent rates), rare components at shrunk team rates, yard components = expected count × mean yards, and the full points-allowed DISTRIBUTION (negative binomial around a fitted opponent-scoring mean) so bin scoring is exact. Components are reconstructed from nflverse play-by-play (2022–2026; sacks 98 %, interceptions 100 %, safeties 100 % exact vs nflverse team stats; TD attribution differs from nflverse by definition). Provider "standard points" are NOT used; historically they do not exist, so the control is the prior-4-game mean under the same exact scoring.

**Datasets:** FIT 2022–2024 (weeks ≥ 3 targets), VAL 2025 weeks 3–17 (480 team-games; K 478 after the relevance floor). 2026 outcomes are never loaded (guard in the script).

**VAL results vs control (MAE points; Δ = control − model, 95 % cluster-bootstrap lower bound by game)**
| Regime | K ΔMAE [lo95] | D/ST ΔMAE [lo95] | D/ST bias model/control |
|---|---|---|---|
| Bloodline Bowl (Sleeper) | +0.38 [+0.22] | +0.86 [+0.56] | +0.50 / +0.11 |
| Devoted = Sporty's (identical K/DST scoring) | +0.47 [+0.29] | +0.69 [+0.43] | −0.21 / +0.16 |
| Maclin (Yahoo) | +0.47 [+0.29] | +0.63 [+0.38] | +0.35 / +0.15 |
| Rogers Park (Yahoo, no K) | — | +0.57 [+0.36] | −0.05 / +0.15 |
The component models beat the control in every regime, with the bootstrap lower bound above 0. The control is deliberately weak (no generic provider projection exists historically): these are NOT claims of beating the live provider forecast, and the Bloodline D/ST bias (+0.50) would fail the prereg |bias| ≤ 0.5 / ≤ control+0.15 gate if repeated on FINAL.

**Spike (weekly top-6) on VAL, simulated component distribution vs tercile base rate (M0):** K Brier skill +2 % to +4 % (lift 1.3–1.5, calibration slope 1.3–1.8: under-confident); D/ST skill −3.6 % to +3 % (slope 0.4–0.8: over-confident; Devoted/Sporty's D/ST is WORSE than the base rate). Top-decile events are 14–21, below the prereg B5 floor of only borderline coverage; **spike probabilities are not display-ready: expected label NO_RELIABLE_SIGNAL for D/ST in at least Devoted/Sporty's, DIAGNOSTIC for K pending S7.**

**Leakage controls:** poison test — 720/720 feature recomputations unchanged when the target game and every later game of the team are replaced by 999; 120/120 kicker-ratio recomputations unchanged when the kicker's current-and-later attempts are poisoned. ORACLE (target-game counts as expectations): D/ST MAE 2.46 vs model 4.62 (Maclin), 1.79 vs 4.33 (Rogers Park); K 1.53 vs 3.74 — the harness is sensitive (≥ 25 % criterion met by a wide margin).

**Tests / mutants:** `lib/w2r1/kdst.ts` (exact-scoring evaluator) is golden-tested against the R implementation on 27 rows (|diff| < 1e-6); 13 tests; mutants W36–W41 (flat FG score, miss penalty, points-allowed continuous key, distribution vs mean, yardage, silent drop of unreconstructable keys) all killed.

**Regime limitations (pinned in test):** `fum_rec_td` (all regimes: may be paid in addition to `def_td`; ≈ 0.03 events/game), `def_st_td` (Sleeper regimes), `blk_kick_ret_yd`/`fg_ret_yd` (Bloodline) are NOT reconstructed and are reported, never silently scored as 0 or 6. Points allowed = opponent-offense points (a provider may differ on rare plays). No kicker-specific wind splits, no field condition.

## 9. S5 — game-plan / tactical intelligence (stage report; validation only — FINAL untouched)

**Conclusion: `NO RELIABLE INCREMENTAL GAME-PLAN SIGNAL` for QB, RB, WR and TE.** Nothing tactical (offensive tendency, defensive response, player fingerprint, Tier-B carryover, interaction, second-order) earned inclusion over a Role-lite + game-context model at any position. Nothing in S5 is W2.R1-qualified.

**Frozen before fitting:** `scripts/w2r1/s5_spec.json` (sha256 `fd9a199a8130b89045c64ed24caafbd28335840a0d15c7f2a609c4d42b76724c`, commit `1c370a7`); `prereg.json` unchanged (`6caf1f70…`).

**Data / features (Tier A everywhere; Tier B only as labelled prior-season carryover)**
- FIT 2022–2024 (14,591 played non-OUT player-games, weeks ≥ 3), VAL 2025 weeks 3–17 (the 3,900 W2.P1 world rows; weeks 14–17 are VAL-contaminated by W2.P1). 2026 is never loaded.
- Tier A (nflverse pbp + FTN charting + schedules/lines + snap counts + injury designations): own Role-lite usage substrate, game context (implied total, spread, pace, dome), 9 offensive-tendency and 9 defensive-response ratios (as-of empirical-Bayes in three continuity modes), position fingerprints, five declared interactions, four second-order features (teammate OUT share, OL OUT, opposing front OUT).
- Tier B (participation: 11-personnel rate, man-coverage rate, two-high rate): prior-season (season−1) carryover only, shrunk by the continuity factor, never in the primary candidate (test-pinned).
- Continuity: head coach (nflverse) and QB (most dropbacks) per team-season; OC/DC are UNKNOWN (the repo's coordinator registry is empty → no extra discount, flagged); personnel continuity UNAVAILABLE.
- Coverage (VAL): Tier-A tactical 97 %, Tier-B carryover 97 %, low-continuity rows 38 %, prior-season-only 0 % and stale 0 % (weeks ≥ 3 targets). Continuity modes are indistinguishable on VAL (CUR / MULTI / CONT within 0.03 MAE at every position): continuity weighting earns nothing.

**Leakage controls:** poison tests pass — player as-of 150/150, team as-of 702/702 (3 modes × 6 metrics × 40 team-games), Tier-B prior-season-only 100/100 — plus ORACLE (target-game actual usage): 28 % (QB), 40 % (RB), 41 % (WR), 44 % (TE) below B1p MAE (≥ 25 % required).

**Validation results (MAE; HALF; n = rows)**
| Pos | n | B1p | W2.P1 C2 | Role-lite (RL) | +context (G1) | +tactical (G2) | +interactions (G3) | +second-order (G4) | tactical mode |
|---|---|---|---|---|---|---|---|---|---|
| QB | 579 | 7.936 | 7.866 | 7.839 | **7.698** | 7.767 | 7.768 | 7.775 | CONT |
| RB | 964 | 5.884 | **5.659** | 5.735 | 5.710 | 5.710 | 5.712 | 5.688 | MULTI |
| WR | 1,476 | 5.060 | **4.721** | 4.795 | 4.800 | 4.802 | 4.802 | 4.807 | MULTI |
| TE | 681 | 4.724 | 4.385 | **4.285** | 4.318 | 4.376 | 4.376 | 4.376 | MULTI |
Ladder (ΔMAE vs previous retained step, 95 % team-week bootstrap lower bound): tactical G2 −0.07 [−0.13] QB, +0.025 [−0.029] RB, −0.007 [−0.038] WR, −0.09 [−0.145] TE; interactions G3 add −0.001…−0.002 (rejected: no interaction beats the additive model); second-order G4 +0.047 [−0.014] RB, otherwise ≤ 0 (rejected); Tier-B G2b is worse than G2 at every position. VAL-LATE (λ chosen on weeks 3–9, scored on 10–17) agrees.

**Incremental value:** over the control B1p only the Role-lite/context steps help (RB +0.149 [0.043], WR +0.265 [0.198], TE +0.439 [0.336], QB G1 +0.238 [0.052]); over the W2.P1 Role candidate C2 only TE (Role-lite +0.099 [0.047]) and QB (G1 +0.169 [0.041]) — RB and WR lose to C2. Holm-adjusted (4 positions, last retained step): vs B1p all p ≤ 0.007; vs C2 TE 0.002, QB 0.027, RB/WR 1.0. None of this is tactical evidence.

**Cap-hit rates (prereg hard fail > 10 %):** 14–44 % across candidates (QB 19–32 %, RB 21–43 %, WR 14–19 %, TE 34–44 %). Every fitted candidate would FAIL the preregistered cap gate on FINAL; this is the same RB/TE weakness W2.P1 carried. The champion itself is biased (−1.1 to −2.4 points: B0p is conditional-on-active while the population includes DNP zeros), so the |bias| ≤ 0.5 gate is structurally unreachable on this proxy-champion setup; the gates were not changed.

**Mutants / tests:** `lib/w2r1/gameplan.ts` primitives (strictly-earlier window, EB rate, continuity, confidence weight, evidence states, Tier-B carryover, interaction term, proportional teammate redistribution, availability-once, layer inclusion, probabilistic wording) with 14 tests; mutants W42–W55 (target-game leakage, future-game leakage, Tier-B as current truth, continuity ignored, missing evidence as certainty, interaction retained without gain, double injury discount, matchup without usage, direct-backup-only, no-evidence as OK, stale ignored, production import, Tier-B in the primary candidate, certain wording) all killed.

**Layers surviving into the frozen S7 candidate:** none of the tactical layers. Role-lite (TE) and Role-lite + context (QB) beat B1p and C2 on VAL but fail the cap-hit gate as built; they are not game-plan evidence and are carried to S7 only if the cap/bias situation is addressed by a pre-declared, non-tactical design change (exploratory until declared). **Verdicts:** QB `DIAGNOSTIC ONLY` (context), RB `NO RELIABLE INCREMENTAL SIGNAL` (Role C2 stronger), WR `NO RELIABLE INCREMENTAL SIGNAL`, TE `DIAGNOSTIC ONLY` (Role-lite beats C2 but cap fail).

## 10. S6 — empirical breakout / upside study (stage report; validation only — FINAL untouched)

**Frozen before fitting:** `scripts/w2r1/s6_spec.json` (sha256 `0ec02582f4a55e88a213570435aade197a6e20a469d551b2891852fb80e9599a`, commit `21f1dcd`); `prereg.json` unchanged. No `FROZEN.json`; 2026 not loaded.

**Population / splits.** Pregame population: a player whose latest PLAYED game was for the team within its previous 3 team games, as-of B0p ≥ 3, designation NONE/QUESTIONABLE/DOUBTFUL (OUT is Wave-1 availability, excluded). A player who does not play stays in with label 0 (no conditioning on playing). FIT 2022–2024 = 11,174 rows, VAL 2025 wk 3–17 = 3,416 rows; time split only (asserted FIT < VAL). VAL-LATE = constants chosen on weeks 3–9, scored on 10–17.

**Labels (PRIMARY, preregistered) and VAL base rates / events:** QB top-12 33.1 % (173 events), RB top-12 20.0 % (174), WR top-12 12.2 % (169), TE top-6 12.4 % (79). Secondary (reported only): top-6 QB 16.8 % / RB 10.2 % / WR 6.4 %; TE top-12 24.1 %; residual 6–8 %; relative 4.5–7.9 %. Tier base rates (FIT) range from 4–7 % (FRINGE) to 23–41 % (STARTER).

**Model ladder (VAL; M0 = tier base rate; retained step must improve log loss ≥ 0.002 and Brier lower bound > 0)**
| Pos | M1a tier+trends | M1b +usage level+context | M1c +shift/experience | M1d +S5 diagnostics |
|---|---|---|---|---|
| QB | +0.3 % skill (not retained) | **+8.3 %** [lo +0.0074], LL +0.037, late +7.0 % — retained | +8.2 % (no gain) | +6.5 % (no gain) |
| RB | −0.4 % | **+6.5 %** [lo +0.0042], LL +0.024, late +6.9 % — retained | +6.9 % (no gain) | +6.7 % (no gain) |
| WR | +0.1 % | +2.2 % [lo −0.0001] — NOT retained | +1.8 % | +1.5 % |
| TE | +0.4 % | **+6.6 %** [lo +0.0026], LL +0.025, late +6.4 % — retained | +4.9 % | +4.9 % |
M2 (calibrated trees) is not fitted at any position (gate not met / no boosted-tree package installed; a single rpart tree is not a calibrated candidate).

**Calibration of the last retained candidate (gates B4/B5):** QB slope 0.71 / ECE 0.060 (over-confident), top-decile lift 1.88 (33 events); RB slope 1.06 / ECE 0.037, lift 2.64 (46 events); WR n/a; TE slope 1.12 / ECE 0.021, lift 3.03 (24 events).
**Alerts (ELEVATED p ≥ 1.5 × base, HIGH ≥ 2.0 × base; precision / recall):** QB 0.52 / 0.46 and 0.71 / 0.14; RB 0.39 / 0.55 and 0.53 / 0.40; TE 0.26 / 0.49 and 0.35 / 0.33; WR no HIGH alerts.

**Verdicts (VAL):** QB `DIAGNOSTIC ONLY` (over-confident, ECE 0.060); RB `DIAGNOSTIC ONLY` (ECE 0.037 > 0.03); WR `NO RELIABLE BREAKOUT SIGNAL`; TE `VALIDATION CANDIDATE` (B1–B5 and VAL-LATE pass, 79 events).
**What the signal actually is (honest reading).** The "breakout-looking" TREND family adds nothing (EXPLORATORY ablation, non-binding: trends over tier +0.3 % / −0.4 % / +0.1 % / +0.4 %). The gain over the 3-tier base rate comes from the continuous usage LEVEL and from game CONTEXT (QB: implied team total alone +5.7 %). So S6 found a better expected-top-N probability, not a detector of players who break out of their own pattern.

**Negative examples / empirical rates (VAL, descriptive top-quintile cohorts; lift vs tier-expected):** TREND cohorts: QB 38 + / 67 − (rate 36 %, lift 1.01), RB 34 / 119 (22 %, 0.96), WR 26 / 214 (11 %, 0.88), TE 22 / 115 (16 %, 0.91): the trend signals did not lift the rate beyond what the tier already implies. LEVEL cohorts lift 1.4–2.2× vs the position base rate but only 1.0–1.4× vs tier-expected. SHIFT (teammate absence) 1.06–1.25.

**Rookies / small samples (VAL; shown probability = w·p + (1−w)·base, w = 1 / 0.6 / 0 for ≥ 4 / 2–3 / < 2 prior games — never 0):** rookies are calibrated at QB/RB/TE (observed/tier-expected 1.13 / 1.06 / 0.91) and over-predicted at WR (0.64); low-history (< 4 games) n = 13–41 per position, too small to certify; recent team change n = 18–50; **injury returns are over-predicted for RB (observed 2.9 % vs shown 14.4 %, 1 event in 35) — flagged**; large snap-trend shifts under-predict at TE (19.7 % vs 10.4 %, n = 61).

**Leakage controls:** poison tests pass (player as-of 150/150, team as-of 702/702, Tier-B prior-season-only 100/100; builder structure test: the as-of window is strictly earlier in all 3 places and labels are computed after, and independently of, every feature). ORACLE (target-game actual usage): QB 17 %, RB 22 %, WR 19 %, TE 26 % Brier improvement over M0 — **the frozen 25 % criterion is met only at TE**; the harness-sensitivity check is therefore partially met (a supplementary oracle using the target-game fantasy points improves Brier 75–85 %, proving a real leak would be glaring). Reported, not relaxed.

**K / D-ST spike (separate from S4 expected points; VAL, FIT-trained; best of simulated-component model and logistic M1 on [expected points, SD] by VAL Brier):** K — Bloodline `NO RELIABLE` (skill +2.1 %, lower bound −0.0001), Devoted/Sporty's/Maclin `DIAGNOSTIC ONLY` (skill +3.4–4.0 %, under-confident slope 2.1–2.3, ECE 0.056–0.058). D/ST — all `DIAGNOSTIC ONLY`: M1 skill +3.2 % to +6.2 % (Rogers Park the best: slope 0.96, ECE 0.031, lift 1.98, late +5.8 %, just over the ECE gate), Devoted/Sporty's lift only 1.09. No K/D-ST spike probability is displayable.

**Tests / mutants:** `lib/w2r1/breakout.ts` (labels, time-split assertion, shrinkage to base rate, gates, banding/alerts, display discipline, negative-example cohort stats) with 16 tests golden-linked to the recorded results; mutants W56–W68 (target-game leak, later-game leak, negatives dropped, base rate omitted, random split, pooled labels, unknown→0, no-history high confidence, raw score displayed, alert threshold altered, calibration gate dropped, production import, minimum-events gate) all killed.

**Surviving into the frozen S7 candidate:** TE M1b (tier + trends + usage level + context) is the only `VALIDATION CANDIDATE`. QB M1b and RB M1b may be carried as DIAGNOSTIC candidates (they will be judged on the frozen final set; QB is over-confident). WR, K and D/ST spike models are not carried. No S6 output is displayed in the live preview.
