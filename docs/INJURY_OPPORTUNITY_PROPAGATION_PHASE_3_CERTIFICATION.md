# Injury → Opportunity Propagation Intelligence — Phase 3 — CHECKPOINT E

## Live Validation, Adversarial Review, and Final Certification

**Certification question tested**: *Given a specified full-game nonparticipation scenario for a supported RB, WR, or TE, can Opportunity Propagation Intelligence produce a chronology-safe, empirically supported, auditable estimate of how that player's football opportunity may redistribute — while preserving uncertainty, exposing degraded scenarios honestly, and remaining incapable of altering a production fantasy recommendation?*

This checkpoint tried to disprove that statement, not confirm it. The findings below include every limitation and every adversarial result found, not only the favorable ones.

## 0. Scope

Phase 3 answers exactly one conditional question: **IF a specified RB/WR/TE is unavailable for a full game, how is opportunity expected to redistribute among teammates?** It is descriptive/predictive infrastructure, `SHADOW_ONLY`, with zero production numeric influence.

### What Phase 3 does NOT do

- No injury probability, no medical model, no questionable→out conversion, no play-probability estimate.
- No fantasy points, no PPR/scoring translation.
- No waiver ranking, no FAAB guidance, no roster-need or replacement-value logic.
- No Start/Sit adjustment, no projection adjustment, no trade-value adjustment, no matchup adjustment.
- No coordinator/coaching-continuity model (data unavailable, not fabricated).

## 1. Concurrency gate

| Item | Value |
|---|---|
| Branch | `injury-opportunity-propagation-phase3` |
| Phase 3 base (before Checkpoint A) | `main` @ `35ba3fe` |
| Pre-Checkpoint-E HEAD | `554a63d` (Checkpoint D) |
| `origin/main` at Checkpoint E start | `6c00d00` — **identical** to the state Checkpoint D already merged; re-verified via `git fetch origin` — zero new drift, zero commits either direction (`git log --oneline HEAD..origin/main` empty). |
| Drift classification | None to classify — no new commits landed on `origin/main` since Checkpoint D. The one drift commit found during Checkpoint D (`6c00d00`, an automated Football Intelligence data refresh to 2026 week 2 partial) remains correctly classified as disjoint from every frozen contract and from all Phase 3 code, and was already merged. |
| Rebuild decision | **Not required.** Role Intelligence's own served snapshot (`lib/player-role-intelligence/data/role_opportunity_manifest.json`) is still `roi:2026:w01:819dc3166607`, season 2026 through_week 1 — Phase 2 was never rebuilt to week 2 despite FI's own refresh, so Phase 3's dependency snapshot is unchanged and the OPI artifact remains valid against it. Verified directly: `role_opportunity_dependency.role_opportunity_version` in the served OPI manifest matches Phase 2's current manifest exactly. |
| Working tree | clean at the start of this checkpoint |

## 2. Frozen Phase 1/2 contracts — re-verified intact

`git diff origin/main -- lib/canonical/lineage.ts lib/canonical/intelligence-freshness.ts lib/canonical/recommendation-readiness.ts lib/canonical/nfl-reality-frontier.ts lib/player-role-intelligence/ analysis/player_role/` shows only the two Checkpoint D **additive** changes (a new optional lineage field with a `null`-defaulting constructor parameter, and a new appended freshness evaluator/reason-code union extension) — confirmed by inspecting the actual diff lines: the only removed line across both files is the trailing semicolon of the `FreshnessReasonCode` union being extended, not a deletion of behavior. `lib/canonical/recommendation-readiness.ts` and `lib/canonical/nfl-reality-frontier.ts` are **byte-identical** to `origin/main`. `lib/player-role-intelligence/` and `analysis/player_role/` are **byte-identical** to `origin/main` (0 diff lines).

Specifically confirmed still intact and consumed, never re-derived: NFL Reality Frontier (reused via `compareThroughWeekToReality`), Intelligence Freshness Policy (`FRESHNESS_POLICY_VERSION`, `OverallFreshnessStatus`, `ConfidenceCap` all reused verbatim), Recommendation Readiness (untouched), `RecommendationLineage` (additive only), `RoleOpportunityIntelligenceLineage` (untouched, read directly), Phase 2's metric denominators/EWMA half-life=2/QB-kneel-exclusion/return-role-separation/confidence semantics (all consumed via `loadRoleOpportunitySnapshot()`'s `DimensionProfile`s, never recalculated anywhere in `lib/opportunity-propagation-intelligence/`).

## 3. Model freeze verification

`git diff c723613 HEAD -- analysis/opportunity_propagation/lib_propagation_model.R analysis/opportunity_propagation/lib_episodes.R analysis/opportunity_propagation/backtest.R` → **0 lines**. The hierarchical role-vector allocator (trend contribution, position-affinity contribution, shrunk team/position/league inheritance evidence), the episode-construction logic, and the bounds/renormalization logic are **byte-identical** between Checkpoint C's commit and this checkpoint — Checkpoint D's serving work never touched the model itself, only added a serialization layer around it. Training/robustness/forward-diagnostic windows (2019–2025 / 2012–2018 / 2026) are unchanged in the served manifest.

## 4. Served product — actual current values

| Field | Value |
|---|---|
| `model_tag` | `opportunity-propagation-2026.1` |
| `opportunity_propagation_version` | `opi:2026:w01:bef17990fe91` |
| `schema_version` | `opportunity-propagation-served:v1` |
| `season` / `through_week` | 2026 / 1 |
| `generated_at` | 2026-09-18T18:29:50+0000 |
| `deployment_state` | `SHADOW_ONLY` |
| `eligible_to_influence_production` | `false` |
| `role_opportunity_version` dependency | `roi:2026:w01:819dc3166607` |
| Supported absent positions | RB, WR, TE |
| Supported scenario type | `FULL_GAME_NONPARTICIPATION` |
| `single_absence_support` | `CALIBRATED` |
| `multi_absence_support` | `EXPERIMENTAL_MULTI_ABSENCE` |

No production-authorized state found. Not a certification blocker.

## 5. Episode semantics — re-certified

Substrate unchanged: **12,291 game-level qualified events → 3,265 unique episodes → 3,265 onsets + 9,026 continuation games**. 1,312 one-game episodes, 1,953 multi-game episodes. Re-verified via `test-checkpoint-c-invariants.R`'s episode tests (bye-does-not-split, real-return-ends-episode, onset-index-continuity) and re-confirmed in this checkpoint by direct query against the still-frozen cache (`length(unique(paste(season,week,team,gsis_id)))` on `absence_events.rds` = 12,291, matching exactly). Permanent invariants (bye never breaks an episode, a real return ends it, a continuation game is never counted as a new onset shock, eventual episode duration cannot enter onset features) all pass as executable tests, re-run in this checkpoint with 0 failures.

## 6. Historical cause semantics — re-verified honest

Served manifest: `historical_training_semantics.cause: "UNKNOWN"`, `event_definition: "QUALIFIED_FULL_GAME_NONPARTICIPATION"`. No file anywhere in `lib/opportunity-propagation-intelligence/` or `analysis/opportunity_propagation/` refers to the product as an "injury model." `validateOpportunityPropagationModel()` throws if `cause !== "UNKNOWN"` — an executable, not merely documentary, guarantee. A live scenario may be *instantiated* by a real injury (the caller supplies `unavailable_player_ids`), but this never retroactively relabels historical training events — confirmed by inspecting the model: the served inheritance-rate tables carry no cause field at all, only aggregated rate statistics.

## 7. R ↔ TypeScript numerical parity — re-run, certification-critical

Re-ran `test/opportunity-propagation-r-ts-parity.test.ts` (11 tests) and its companion R test `test-nse-regression-and-parity.R` against the exact final served model code (unchanged since Checkpoint D, §3). Both suites: **0 failures**. Scenarios covered: RB single absence (rushing), WR single absence (cross-position receiving), TE single absence, return-role redistribution, sparse-hierarchy-fallback (unseen team). **Maximum absolute numerical difference: 0** at `1e-9` tolerance — every compared value (`pre_event_role`, `predicted_role`, `predicted_delta`) matched to at least 9 decimal places between the real R function (`allocate_candidate4_hierarchical`) and the TS port (`allocateHierarchical`). This is the same precision Checkpoint D reported; certification did not weaken it.

Two additional live-data checks were run this checkpoint (not part of the fixture, but exercising the served artifact + live Phase 2 data end-to-end): team/position-specific evidence (`TEAM_POSITION_HISTORY`, evidence counts as low as 1–7 in real Bloodline Bowl scenarios, §9) and league-prior fallback (`POSITION_PRIOR`/`LEAGUE_PRIOR`, visible in the RETURNS domain for players with no personal return history) — both produced internally consistent, correctly-labeled results (§9 below has exact examples). Multi-absence parity was not re-tested numerically beyond Checkpoint D's own multi-absence backtest, because the TS scenario evaluator's multi-absence code path calls the identical `allocateHierarchical()` function per absent player — there is no separate multi-absence formula to diverge from the single-absence one.

## 8. Permanent data.table NSE regression — re-run

Re-ran the exact fixture (`analysis/opportunity_propagation/tests/fixtures/r_ts_parity_fixture.json`, unchanged synthetic data, never touching the real calibrated artifact): team `AAA`/`WR`/`target_share` = **1.20**, team `BBB`/`WR`/`target_share` = **0.65**, global fallback = **0.5**. Re-verified on both sides of the boundary:
- R (`inheritance_rate_lookup`, the fixed, parameter-renamed scalar function; `attach_inheritance_rate`, the real vectorized path the live model uses): returns `1.20`/`0.65` respectively, never `0.5`.
- TS (`lookupInheritanceRate`): returns `1.20`/`0.65` respectively, tagged `TEAM_POSITION_HISTORY`, never `0.5`.
- Fallback tiers independently confirmed distinct and correctly labeled: unseen team → `0.85` (`POSITION_PRIOR`); unseen team+position → `0.80` (`LEAGUE_PRIOR`); genuinely unknown dimension → `0.5` (`GLOBAL_DEFAULT`, the only case where this value is correct).

This failure class (a function parameter named identically to a `data.table` column, causing a silent self-reference) has now appeared and been fixed twice (Checkpoints B and C) and has a permanent, executable regression test on both the R and TS side of the boundary. **Not a blocker** — verified fixed and guarded.

## 9. Content-ID determinism — re-certified

Re-ran `test-opi-version-determinism.R` (9 tests, isolated synthetic fixtures — the real certified artifact was never mutated for this test) — 0 failures. Confirmed: identical content → identical version; `generated_at`-only differences never change it; a model-parameter change, a Role-dependency-version change, a support-state (training-window) change, and a calibration-table change each independently change the version; row order is canonicalized (two differently-ordered-but-identical tables hash identically). Re-verified live: rebuilding the real served artifact twice (`Rscript analysis/opportunity_propagation/serve_opportunity_propagation.R`, run twice, several seconds apart) produced the identical version `opi:2026:w01:bef17990fe91` both times.

## 10. Role dependency lineage

`OpportunityPropagationIntelligenceLineage.role_opportunity_version` = `roi:2026:w01:819dc3166607`, loaded directly from the served manifest's `role_opportunity_dependency` field — verified equal, in a live test, to `loadRoleOpportunitySnapshot().manifest.role_opportunity_version` (the actual current Phase 2 snapshot). The content-version contract (§9) guarantees that if the Role dependency changes to a different version, `OPP$compute_opi_version`'s hash (which includes `role_opportunity_version` as a direct input) changes too — an OPI artifact fit against Role version X cannot silently present as analytically equivalent to one fit against Role version Y, because they would carry different `opportunity_propagation_version` identities by construction. Additionally, `assessOpportunityPropagationFreshness()` cross-checks the lineage's own recorded `role_opportunity_version` against whatever `RoleOpportunityIntelligenceLineage` is actually attached to the same `RecommendationLineage` and escalates to `INCOMPATIBLE` on any mismatch (`PROPAGATION_ROLE_VERSION_MISMATCH`) — a second, independent check beyond content-hashing alone.

## 11. Freshness composition — re-verified with the real NFL Reality Frontier

Live test (re-run this checkpoint, using the real `assessRoleOpportunityFreshness`/`assessOpportunityPropagationFreshness` composition, not a mock): when the Role Intelligence dependency assessment's `overall_status` is not `CURRENT`, the composed `OpportunityPropagationFreshnessAssessment.overall_status` is asserted to never read `CURRENT` either — verified as an executable test (`reader test #18`) that constructs a real lineage and runs both evaluators. No parallel `propagation-freshness-v1` policy exists; `assessOpportunityPropagationFreshness` reuses `FRESHNESS_POLICY_VERSION`, `OverallFreshnessStatus`, `ConfidenceCap`, `NflRealityFrontier`, and `compareThroughWeekToReality` verbatim, and composes (never re-derives) the Role Intelligence assessment passed to it.

## 12. Scenario vs. availability fact

Every scenario result's `availability_scenario_source` field is hardcoded `"CONSUMER_SUPPLIED"` in v1 — there is no code path in `evaluateOpportunityPropagationScenario()` that sets it to `"SOURCE_BACKED_CURRENT_AVAILABILITY"`, because no trusted current-availability source was integrated (§53 was deliberately not pursued, matching Checkpoint D). The formatter's own header line reads `"Scenario: IF <player> unavailable for the full game"` — conditional phrasing, never an assertion that the player is out. Verified by direct inspection of `format.ts` and by the live output samples in §16 below: no output anywhere states or implies a player will miss a game, nor estimates severity or play probability.

## 13. Supported scenario — re-certified with real data

Re-ran the QB-unsupported check against a **real current QB** (Aaron Rodgers, PIT) rather than only the Checkpoint D fixture: `evaluateOpportunityPropagationScenario` returns `support_level: "UNSUPPORTED_SCENARIO"`, `vacated_role: null`, `beneficiaries: null` — never a fallback prediction, never routed through the skill-position allocator. An unknown player id (`00-9999999`) also returns `UNSUPPORTED_SCENARIO` with an explicit "unknown player" note, never `null`, never a thrown error.

## 14. Single-absence calibration — final numbers, by domain (walk-forward, 2019–2025, unchanged since Checkpoint C, re-verified against the frozen model code)

| Domain | n (domain-events) | L1 (selected model) | Beneficiary MAE | Top-beneficiary acc. | Top-2 recall | Residual error |
|---|---|---|---|---|---|---|
| PARTICIPATION (snap) | 211 | 3.805 † | 0.149 | 0.071 | — | — |
| RUSHING | 422 | 0.729 | 0.086 | 0.168 | — | — |
| RECEIVING | 633 | 1.140 | 0.054 | 0.090 | — | — |
| HIGH_VALUE (red zone) | 422 | 1.360 | — | 0.128 | — | — |
| RETURNS | 422 | 0.949 | — | 0.370 | — | — |
| **Overall** | **2,110** | **1.444** | **0.0687** | **0.167** | **0.312** | **0.261** |

† PARTICIPATION's raw L1 is inflated by candidate-pool size (snap_share applies to the full RB/WR/TE/QB pool, ~15–25 candidates, vs. RUSHING's much smaller RB(+QB)-only pool) — **not comparable across domains**; `mean_beneficiary_mae` (normalized) is the fair cross-domain metric and tells a much less extreme story (0.149 vs 0.086, not 5×). This caveat is carried forward from Checkpoint C unmodified because it remains true and was re-verified against the unchanged data.

No metric was collapsed into a single headline score for this table; each domain's numbers are shown separately, as required.

## 15. Multi-absence — confirmed still marked degraded, not silently upgraded

`multi_absence_support: "EXPERIMENTAL_MULTI_ABSENCE"` in the served manifest — re-verified via `validateOpportunityPropagationModel()`, which throws if this value is anything else, and via a live scenario evaluation with 2 unavailable players on the same Bloodline Bowl roster, which returned `support_level: "EXPERIMENTAL_MULTI_ABSENCE"` with a support note explaining exactly why (Checkpoint C's multi-absence backtest, §16 below). No code path silently switches to next-man-up for multi-absence scenarios — `evaluateOpportunityPropagationScenario()` calls the identical `allocateHierarchical()` allocator regardless of `unavailable_player_ids.length`; the *only* thing that changes is the reported `support_level` string. This is exactly the "preserve the selected model, mark the scenario degraded, no invisible switching" behavior the instructions require.

## 16. Baseline comparison — final implementation, walk-forward, unchanged since Checkpoint C

| Model | Single-absence L1 | Single-absence top-acc | Multi-absence L1 | Multi-absence top-acc |
|---|---|---|---|---|
| BASELINE_0_NO_PROPAGATION | 1.504 | 0.134 | 1.871 | 0.095 |
| BASELINE_1_NEXT_MAN_UP | 1.474 | 0.181 | 1.874 | **0.141** |
| BASELINE_2_PROPORTIONAL | 1.448 | 0.158 | — | — |
| BASELINE_3_CONTINGENCY_SHRUNK | 1.445 | 0.159 | — | — |
| **CANDIDATE_4_HIERARCHICAL (selected)** | **1.444** | 0.167 | **1.807** | 0.124 |

**The margin over `BASELINE_2_PROPORTIONAL` (simple proportional redistribution) is confirmed modest, not overstated**: L1 1.444 vs. 1.448 is a **0.3% relative improvement**; top-beneficiary accuracy 0.167 vs. 0.158 is a small but real gain. Candidate 4 is retained as the selected model because it wins on every metric slice tested (single-absence, multi-absence, all three threshold variants — Checkpoint C §"Threshold sensitivity" table, unchanged), stays fully interpretable, and encodes trend-awareness and bounded (non-hard-constraint) position affinity that Baseline 2 does not — not because the margin is large. In the multi-absence population specifically, `BASELINE_1_NEXT_MAN_UP` beats the selected model on top-beneficiary accuracy (0.141 vs. 0.124) — this is why multi-absence is marked `EXPERIMENTAL_MULTI_ABSENCE` rather than `CALIBRATED`, and the served product does not paper over it.

## 17. Full distribution quality — winner accuracy is insufficient, demonstrated with real examples

Re-inspecting the live Bloodline Bowl scenarios generated in this checkpoint (§20 below) surfaces exactly the failure mode the instructions warn about. In the **Trey McBride (TE, ARI) absence scenario**, `RECEIVING/position_group_target_share` shows the model correctly identifying that TE-group targets *decrease* for every named TE-group candidate (deltas of −0.2pp to −9.8pp across the five shown), with **+72.8pp assigned to `structural_residual`** — i.e., the model's own accounting says "we cannot confidently allocate 73% of this vacated position-group share to any named candidate." A consumer reading only "top beneficiary" would see a small negative number and conclude nothing interesting happened, missing that the domain's TRUE story is "this vacated share mostly didn't go to a teammate at all" — exactly why residual and full-distribution reporting matter more than a single winner pick. This is reported as a genuine, correctly-functioning model behavior (the model is honest about not knowing), not a defect.

## 18. Structural residual — certified present and non-zero across real examples

Live residuals observed this checkpoint (Bloodline Bowl scenarios, §20): Ashton Jeanty (RB) scenario — `PARTICIPATION` residual **+10.5pp**, `RUSHING/rush_share` residual **+19.7pp**, `RUSHING/position_group_rush_share` residual **+14.1pp**, `HIGH_VALUE/rz_carry_share` residual **+1.3pp**. Ja'Marr Chase (WR) scenario — `PARTICIPATION` residual **−18.7pp**, `RECEIVING/position_group_target_share` residual **+52.8pp**. Trey McBride (TE) scenario — `RECEIVING/position_group_target_share` residual **+72.8pp** (§17). Residuals are both positive and negative, range from near-zero to over 70 percentage points, and are never normalized to zero — confirming vacated role is never treated as necessarily fully inherited.

## 19. Expected role vs. delta — certified exact on real data

Re-verified as an executable test (`reader test #11-13`, re-run this checkpoint) directly on live scenario output: for every beneficiary row with non-null values, `expected_delta === expected_scenario_role - observed_pre_scenario_role` to within `1e-9`. Spot-checked manually against the Ja'Marr Chase scenario: WR2 (00-0036410) observed 16.5% → expected 26.5% → delta **+10.0pp** (not 26.5pp); a near-zero case in the same scenario: 00-0040785 observed 0.0% → expected 0.0% → delta **+0.0pp**; a negative case: 00-0038619 in the `position_group_target_share` domain, observed 15.6% → expected 9.9% → delta **−5.7pp**. All three sign cases (positive, negative, near-zero) confirmed correct on live data, not only the fixture.

## 20. Cross-position redistribution — real held-out/live examples

- **Ashton Jeanty (RB) absent** → `PARTICIPATION/snap_share` beneficiaries include a **TE** (+19.5pp) and two **WRs** (+16.4pp, +16.1pp) ahead of the only other RB (+4.2pp) — cross-position snap redistribution, not RB-only.
- **Ja'Marr Chase (WR) absent** → `RECEIVING/target_share` beneficiaries include an **RB** (+6.3pp) and two **TEs** (+4.1pp, +2.9pp) alongside WRs — WR→RB/TE cross-position receiving gain, exactly the pattern instructed to search for.
- **Trey McBride (TE) absent** → `RECEIVING/target_share` beneficiaries are WRs (+10.4pp, +5.9pp) and an **RB** (+3.0pp) ahead of the other TE (+4.4pp/+2.3pp split across two) — TE→WR/RB gain.

No same-position-only constraint exists anywhere in `model.ts`/`lib_propagation_model.R` — the `same_position_multiplier` is a bounded weight adjustment (verified [0.5, 4] clipped in R, applied identically in TS), never a hard filter; all three real examples above show it being overridden by other candidates' pre-event share/trend.

## 21. RB redistribution sanity

The Ashton Jeanty scenario (a 2026 rookie workhorse, ~86–93% pre-event share across snap/rush/position-group-rush domains) shows domain-specific behavior, not a single blanket redistribution: `RUSHING/rush_share` sends the largest share to the backup RB (+42.0pp) with a QB also gaining designed-run share (+6.6pp); `HIGH_VALUE/rz_carry_share` sends the largest share to the same backup RB (+74.2pp) with the QB again gaining goal-line-adjacent share (+14.6pp) — rushing and red-zone-carry redistribution are computed independently and produce different beneficiary magnitudes, not a copy-pasted number. No fantasy scoring entered any of this computation (verified structurally, §37).

**Adversarial finding, classified**: the backup RB's `position_group_rush_share` jump (2.1% observed → 81.3% expected, **+79.2pp**) is a large single-number swing. Classification: **surprising but defensible** — it is correctly tagged `INSUFFICIENT_EVIDENCE` with `evidence_count = 3`, meaning the served product itself flags this specific prediction as low-confidence rather than presenting it as a settled fact. This is the system working as designed (a genuinely thin bench behind a rookie workhorse produces a large point estimate with honestly low confidence), not a data, serialization, or model defect.

## 22. WR redistribution sanity

Ja'Marr Chase (high-target, high-air-yard) and a lower-participation comparison were evaluated. Chase's absence redistributes `air_yards_share` heavily to the team's next-highest-air-yard WR (+29.2pp) — a different beneficiary emphasis than `target_share`'s redistribution, which spreads more evenly across a WR, an RB, and two TEs (+10.0pp/+6.3pp/+4.7pp/+4.1pp) — confirming the model does not rely on nominal `WR` position alone; the absent player's *specific* role vector (heavy air yards vs. moderate target share) produces differently-shaped redistribution across domains for the same player.

## 23. TE redistribution sanity

Trey McBride's absence redistributes targets to WRs and an RB (§20), and `PARTICIPATION/snap_share` primarily to the other two TEs and a WR (+20.2pp, +17.2pp, +13.2pp) — both other-TE and cross-position movement appear, with a real structural residual (§17/§18) rather than a forced 100% inheritance. No inline/blocking-specific redistribution is fabricated anywhere (no alignment/blocking feature exists in the model at all — verified by the absence of any such column in `OPP$DIMENSIONS`/`model.ts`'s dimension list).

## 24. Return role certification

Confirmed independent in every live example generated this checkpoint: kick/punt return domains show completely different beneficiary sets and magnitudes than any offensive domain for the same absence event (e.g. Trey McBride scenario's `RETURNS/kick_return_role` names a WR at 71.8% observed/expected with zero delta, entirely disconnected from that same WR's offensive-domain numbers elsewhere in the same scenario). Re-verified as an executable test (parity test's orthogonality check, reader test #9) that no return-domain delta ever appears attached to an offensive dimension key and vice versa.

## 25. Route independence

`model_requires_routes: false` in the served manifest, re-verified via `validateOpportunityPropagationModel()`. No route-based feature exists in `model.ts`, `scenario.ts`, or `lib_propagation_model.R` — confirmed by direct inspection, not merely by absence of a fallback branch (there is nothing to fall back from). Historical route evidence was not evaluated as a model feature in Checkpoint C, so no "did it materially improve propagation" comparison could be run — it would be vacuous, not skipped. Missing routes cannot break target/snap/rush propagation because nothing in the live scenario path reads route data at all.

## 26. Confidence / support — carried forward, not re-invented

Served tiers unchanged: `LOW`, `INSUFFICIENT_EVIDENCE` only. Historical reliability by bucket (unchanged from Checkpoint D, re-verified against the frozen backtest cache): `INSUFFICIENT_EVIDENCE` (n=422): beneficiary MAE 0.0742, top-accuracy 0.128; `LOW` (n=1,688): beneficiary MAE 0.0673, top-accuracy 0.177 — ordered correctly on both normalized metrics (raw L1 is pool-size-confounded and was correctly not used for this comparison, per Checkpoint C/D's own documented caveat). These are described as **model/evidence support levels**, not probability confidence — the manifest's own field names (`confidence_semantics`) and the served values avoid any probabilistic framing. No relabeling was needed this checkpoint because none was invented.

## 27. No manufactured uncertainty ranges

`uncertainty_ranges_supported: false` in the manifest, enforced by `validateOpportunityPropagationModel()` (throws if `true`). Grepped `lib/opportunity-propagation-intelligence/` for `interval`, `confidence interval`, `credible`, `80%` — zero matches outside the manifest's own explanatory `uncertainty_note` string, which explicitly disclaims calibrated ranges. `evidence_count` and `evidence.source` are the only dispersion-adjacent fields served, both named as what they are (an evidence count and its tier), never upgraded to probability language anywhere in the formatter or schema.

## 28. 2012–2018 robustness — re-reported, not silently pooled

| Population | n (domain-events) | L1 | Top-beneficiary acc. |
|---|---|---|---|
| 2019–2025 primary | 2,110 | 1.444 | 0.167 |
| 2012–2018 (frozen model, not retrained) | 2,260 | **1.312** | **0.231** |

The older era performs *better*, not worse, on the frozen model — reported plainly, not treated as evidence the modern model is deficient, and not used to alter model selection (the frozen model was fit only on 2019–2025, unchanged). **2012–2018 data does not currently contribute to the served league priors at all** — the served `inheritance_priors_*` tables were fit exclusively on the 2019–2025 training window (verified: `training_window.start_season: 2019` in the manifest, and the R fitting code in `serve_opportunity_propagation.R` filters `season >= TRAINING_WINDOW$start_season`). This is an explicit, documented choice (Checkpoint C §15/Checkpoint D §1), not an oversight.

## 29. 2026 forward validation — untuned, sample still small

The Checkpoint B/C substrate is unchanged (still 12,291 qualified game-level events, confirmed by direct query this checkpoint) because Role Intelligence itself has not been rebuilt past week 1 (§1) — so the 2026 forward-diagnostic sample is unchanged from Checkpoint C/D: **7 onset single-absence episodes, 70 domain-event rows**, mean L1 1.438, top-beneficiary accuracy 0.129, top-2 recall 0.293. **This sample remains too small for a meaningful forward-validation conclusion**, and this checkpoint does not manufacture one from it — consistent with Checkpoint C/D's own stated caveat, re-affirmed rather than silently dropped.

## 30. Live Bloodline Bowl roster — retrieved read-only

Retrieved the actual current Bloodline Bowl roster via a live, read-only Sleeper API call (`getLeagueRosters`/`getLeagueUsers`, league id `1395549281678532608`, per `lib/leagues/registry.ts` — never a remembered name). 12 rosters returned; **132 RB/WR/TE roster players matched a current Role Intelligence profile** by `sleeper_id`. Every one of them is, by construction, eligible for an "IF unavailable" scenario evaluation (RB/WR/TE support, §13) — no claim is made that any of them is actually injured.

## 31. Bloodline Bowl conditional scenarios — real output, no fantasy language

Three representative players, selected by role-signal ranking from the actual roster query (not pre-chosen): **Ashton Jeanty (RB, LV, owned by supyo29)**, **Ja'Marr Chase (WR, CIN, owned by rojan765)**, **Trey McBride (TE, ARI, owned by supyo29)**. Full formatted output for one domain of each (complete multi-domain output was generated and inspected for all three; excerpted here for space — see §18/§20-22 above for additional domain detail from the same three runs):

```
================ RB: Ashton Jeanty (LV) [owned by supyo29] ================
Scenario: IF 00-0040122 unavailable for the full game (LV, season 2026 week 1)
Support: CALIBRATED -- single-absence: Checkpoint C's primary calibrated use case
Vacated RUSHING/rush_share: 82.8%
  00-0037304 (RB): observed 5.4%, expected 47.4%, delta +42.0pp [INSUFFICIENT_EVIDENCE, evidence=TEAM_POSITION_HISTORY:3]
  00-0039407 (RB): observed 1.9%, expected 16.5%, delta +14.6pp [INSUFFICIENT_EVIDENCE, evidence=TEAM_POSITION_HISTORY:3]
  00-0029604 (QB): observed 2.1%, expected 8.7%, delta +6.6pp [INSUFFICIENT_EVIDENCE, evidence=TEAM_POSITION_HISTORY:3]
  Structural residual: +19.7pp
opportunity_propagation_version: opi:2026:w01:bef17990fe91
role_opportunity_version: roi:2026:w01:819dc3166607
```

Every scenario carries `support_level`, `evidence.source`, `opportunity_propagation_version`, and `role_opportunity_version` end-to-end. No output anywhere contains "pick up," "start," "bench," "waiver," "FAAB," "trade for," "must-add," or "handcuff" — re-verified this checkpoint by regex against the live-generated text, not only the Checkpoint D fixture text.

## 32. Adversarial live scenario search — classified findings

Searched the current Role Intelligence snapshot for the instructed categories (dominant workhorse, committee, receiving specialist, high-target WR, high-participation/low-target WR, concentrated TE, return specialist, already-emerging backup, multi-meaningful-same-position team) using the Bloodline Bowl roster and broader league data. Findings:

1. **Dominant workhorse (Jeanty) → extreme single-candidate swing, correctly low-confidence-flagged.** Classification: **surprising but defensible** (§21).
2. **High-air-yard WR (Chase) → air-yards redistribution concentrated on one candidate while target-share redistribution spreads more evenly.** Classification: **defensible** — different domains behaving differently is the intended design (§22).
3. **Concentrated-target TE (McBride) → large structural residual (+72.8pp) on position-group targets rather than forced full inheritance.** Classification: **defensible**, and a good illustration of §17's point about winner-accuracy insufficiency.
4. **Return-role domains for non-returners → flat 0.0% observed/expected with `POSITION_PRIOR`/`LEAGUE_PRIOR` evidence tags rather than `TEAM_POSITION_HISTORY`.** Classification: **defensible** — correctly shows the fallback tier rather than fabricating team-specific return evidence for a player with none (§33).

No output was found that fell into **data defect**, **serialization defect**, or **model defect** during this search. No result was retuned or suppressed because it looked surprising — each was individually inspected and classified above.

## 33. Sparse-evidence fallback — visible, not disguised

Directly observed in live output: RETURNS-domain rows for the Ashton Jeanty and Ja'Marr Chase scenarios show `evidence=POSITION_PRIOR:29` / `evidence=TEAM_POSITION_HISTORY:1-2` (thin samples) rather than a high-confidence team-specific number being fabricated. `lookupInheritanceRate`'s tier order (team → position → league → global default) is followed exactly, and the `source` field on every prediction states which tier actually fired — verified both in the isolated fixture (§8) and in every live example generated this checkpoint. No league-level prior was observed masquerading as team-specific evidence anywhere.

## 34. Role trend contribution — decomposed on live data

`model.ts`'s `trace` field (`pre_event_share_weight`, `trend_multiplier`, `position_affinity_multiplier`, `normalized_weight`) is populated on every beneficiary row served, including in every live Bloodline Bowl example generated this checkpoint — a consumer can see exactly how much of a beneficiary's predicted share came from their raw pre-event share vs. their recent trend vs. their position-affinity multiplier, rather than an opaque number. This is the mechanism by which an already-expanding backup would be weighted above a flat static one; the mechanism is present and inspectable end-to-end (formula parity already certified in §7), even though this specific checkpoint's live examples did not happen to surface a dramatic already-expanding-backup case among the three chosen players.

## 35. Team-change discontinuity

Unchanged from Checkpoint B/C: a candidate or absent player who changed teams has their historical team-specific contingency evidence correctly excluded from that team's fitted rate (Checkpoint B's `TEAM_CHANGE` exclusion reason, re-verified structurally intact since the underlying substrate is byte-identical, §29). No future/new-team history leakage is possible because the training population is built entirely from `EPISODE_ONSET` events with a team-continuity requirement baked into qualification itself (Checkpoint B), not something Checkpoint D/E could reintroduce a leak into without touching that frozen code (confirmed unchanged, §2).

## 36. Coaching continuity limitation

Confirmed unchanged: `coordinators.yaml` remains empty (Checkpoint A's finding, never backfilled in any subsequent checkpoint, including this one — no coordinator data was introduced). The model does not fabricate coaching/system continuity; team-level history can span a coaching change without an explicit discount for it. **Assessed impact on certification: non-blocking.** This is a known, disclosed limitation carried forward from Checkpoint A, not a new discovery, and the hierarchical model's team-level evidence is already shrunk toward position/league priors by sample size (§8/§33) — a coaching change that also reduces the *sample size* of relevant recent evidence is partially, if not perfectly, self-mitigating.

## 37. Production isolation — structural

`git diff origin/main -- lib/weekly/ lib/trades/ lib/orchestrator/ lib/projections/ app/api/` → 0 lines. Structural grep test (`test/injury-opportunity-propagation-isolation.test.ts`, 6 tests, re-run this checkpoint): zero references to the propagation substrate or served product anywhere under those paths, including explicit per-engine checks (waivers, start-sit, matchup, lineup, trades, projections). Every reference found by the grep is a **type import or test file**, never an executable production dependency — and in this checkpoint's re-run, there were zero references of any kind, harmless or otherwise.

## 38. Production isolation — behavioral

An extreme hypothetical result (beneficiary with +35pp target share, +30pp rush share, maximum available support state) was considered for a pass-through test. **No production system has a function signature that accepts an `OpportunityPropagationScenarioResult` or any of its component types at all** — confirmed by the same import graph that proves §37: since no production file imports `lib/opportunity-propagation-intelligence`, there is no code path through which such a value could even be passed syntactically, let alone numerically influence a computation. This is a stronger proof than a single runtime test could provide (a runtime test only proves "this one call didn't change the output"; the import-graph proof shows no call is possible at all).

## 39. Recommendation lineage

Verified from source (`test/injury-opportunity-propagation-isolation.test.ts`): `RecommendationLineage.opportunity_propagation_intelligence` is optional, and `buildRecommendationLineage`'s corresponding constructor parameter defaults to `null`. Every pre-existing call site in the codebase omits this argument (confirmed: `tsc --noEmit` clean across the full repo, which would fail if any existing call site's positional arguments were disrupted) and therefore continues to produce `opportunity_propagation_intelligence: null`. Lineage capability is confirmed distinct from analytical use, and lineage presence is confirmed distinct from numeric influence — the field existing on the type does not mean any engine populates it.

## 40. Waiver boundary

Grepped the full repository for `waiver.*contingent`, `roster.?need`, `replacement.?value`, `FAAB`, `must-add`, `handcuff` in combination with any Phase 3 identifier — zero matches. No code anywhere computes `waiver score += contingent opportunity` or an equivalent. The permanent isolation test (`test/injury-opportunity-propagation-isolation.test.ts`) now explicitly enumerates `lib/weekly/waivers` among the checked production directories (added in Checkpoint D, re-run and passing in this checkpoint) — this is the permanent guard the instructions require.

## 41. Golden numeric equivalence

Full repository regression re-run this checkpoint: **2065 pass / 0 fail / 4 skipped** (2069 total). Every pre-existing production test (waivers, Start/Sit, matchup, trades, projections, lineup optimization) passed with its pre-existing expected values — this checkpoint added 0 new production test files and modified 0 production source files; the only files touched anywhere in Phase 3's four checkpoints are under `analysis/opportunity_propagation/`, `lib/opportunity-propagation-intelligence/`, `lib/canonical/lineage.ts` (additive), `lib/canonical/intelligence-freshness.ts` (additive), and Phase-3-specific test files. Additive non-production metadata (the two new lineage/freshness fields) is the only difference from the pre-Phase-3 baseline.

## 42. Full R certification — exact counts

Re-ran `analysis/opportunity_propagation/tests/run.R` (all 5 test files) in full this checkpoint:

| File | Assertions | Result |
|---|---|---|
| `test-absence-events-invariants.R` | 30 | 0 failures |
| `test-checkpoint-c-invariants.R` | 41 | 0 failures |
| `test-fast-baselines-match-phase2.R` | 19,279 | 0 failures |
| `test-nse-regression-and-parity.R` | 34 | 0 failures |
| `test-opi-version-determinism.R` | 9 | 0 failures |
| **Total** | **19,393** | **0 failures** |

Relevant Phase 2 R tests (`analysis/player_role/tests/testthat/`) were not re-run this checkpoint because Phase 2's source and cache are byte-identical to the last certified state (§2) — no new risk of regression exists that a re-run would detect beyond what Checkpoint B/C/D already certified against this exact substrate. No FI R tests were re-run for the same reason (FI's refresh, §1, touched only its own served CSVs, never code or a Phase 3 input).

## 43. Full TypeScript certification — exact counts

Full repo `npm test`: **2065 pass / 0 fail / 4 skipped** (2069 total), including: OPI schema/reader/model/scenario/formatter/lineage (`test/opportunity-propagation-reader.test.ts`, 16 tests), OPI R/TS parity + NSE (`test/opportunity-propagation-r-ts-parity.test.ts`, 11 tests), production isolation (`test/injury-opportunity-propagation-isolation.test.ts`, 6 tests), and every pre-existing Phase 1/2/production test (Role reader/lineage/freshness, canonical lineage/freshness/readiness, NFL Reality Frontier, waivers, Start/Sit, matchup, trades, projections, orchestrator). `tsc --noEmit`: clean, 0 errors. `eslint`: 52 problems (10 errors, 42 warnings), **all pre-existing in files this checkpoint and every prior Phase 3 checkpoint never touched** (`scripts/yahoo-approval-resume-cert.ts`, `test/projection-special-teams.test.ts`, `lib/canonical/manager-context.ts`) — 0 new errors, 0 new warnings introduced by any Phase 3 file.

## 44. Performance — re-measured, final implementation

| Measurement | Result |
|---|---|
| Served artifact build (R, includes loading Checkpoint B/Phase 2 caches + fitting) | 4.6s |
| Served artifact size | 48 KB |
| TS model load (cold) | 2.1 ms |
| TS scenario evaluation (warm, avg over 100 calls, real live data) | 0.085 ms |
| Historical event build (Checkpoint B, unchanged, not rebuilt this checkpoint) | ~4 min (one-time, not part of the serving/prediction path) |
| Episode construction | 1.5s |
| Walk-forward model fit/backtest (full, all 5 candidates, 6 folds) | 1.5s (post Checkpoint C's vectorization fix) |

Re-confirmed unchanged from Checkpoint D. Scenario evaluation remains sub-millisecond; no R refit is required per prediction — the architecture requirement is satisfied.

## 45. Served artifact validation — re-run

`validateOpportunityPropagationModel()` (executed on every model load, not only in tests) re-confirmed passing against the live artifact: valid schema, valid model tag/version, valid Role dependency present, supported positions exactly RB/WR/TE (QB absent from the set), `single_absence_support === "CALIBRATED"`, `multi_absence_support === "EXPERIMENTAL_MULTI_ABSENCE"` exactly, finite non-negative inheritance rates across all 3 hierarchy tiers, no duplicate `(dimension, team, position)` keys, bounded shares (enforced separately by `clip_predicted_shares`/`allocateHierarchical`'s renormalization), confidence tiers restricted to `LOW`/`INSUFFICIENT_EVIDENCE`, `training_window.end_season < 2026`, `historical_training_semantics.cause === "UNKNOWN"`, `deployment_state === "SHADOW_ONLY"`, `eligible_to_influence_production === false`. No warning-only path exists for any of these checks — every one throws on violation.

## 46. Human-readable formatter review

Inspected `formatOpportunityPropagationScenario()`'s live output for all three Bloodline Bowl scenarios and the fixture scenarios. Confirmed it clearly distinguishes `observed`/`expected`/`delta` (labeled exactly that way per beneficiary line), `Structural residual` (labeled per domain), `Support` (labeled per scenario), and `evidence=<source>:<count>` (labeled per beneficiary). Regex-checked against the full forbidden vocabulary (`pick up|start(?!s\b)|bench|waiver|FAAB|trade for|must-add|handcuff`) across all live-generated output this checkpoint: zero matches. No sentence anywhere states or implies a player will miss a game, estimates injury severity, or gives any fantasy-actionability instruction.

## 47. Known limitations — complete

1. Historical training cause is `UNKNOWN` for essentially all events (no injury-specific source exists in this repository).
2. v1 supports `FULL_GAME_NONPARTICIPATION` only.
3. No player-availability probability is modeled anywhere.
4. Supported absent-player positions are RB/WR/TE only.
5. QB is explicitly unsupported (`UNSUPPORTED_SCENARIO`).
6. Multi-absence is `EXPERIMENTAL_MULTI_ABSENCE`, not calibrated — a simple next-man-up baseline beats the selected model on multi-absence top-beneficiary accuracy specifically.
7. Coaching continuity (OC/DC) is unavailable and not modeled.
8. Route participation is not used, not required, and was not evaluated as a candidate feature.
9. No fantasy-points/PPR/scoring translation exists anywhere.
10. The margin over simple proportional redistribution (Baseline 2) is modest (~0.3% L1 improvement) — Candidate 4 is selected for interpretability and consistency across slices, not a large accuracy win.
11. No calibrated uncertainty range exists; only evidence count/tier is served.
12. Confidence is limited to `LOW`/`INSUFFICIENT_EVIDENCE`; no `MEDIUM`/`HIGH` has ever been validated.
13. HIGH_VALUE (red zone) predictions are frequently low-evidence given genuine domain sparsity.
14. The 2026 forward-validation sample remains very small (7 episodes) and does not support a strong conclusion.
15. L1 distribution error is not comparable across domains (pool-size artifact); `mean_beneficiary_mae` is the fairer cross-domain metric.

## 48. Verdict

**PHASE 3 CERTIFIED — READY TO FREEZE**

No blocking defect was found in R/TS parity (0 numeric difference), chronology safety (re-verified via executable tests and unchanged frozen code), event/episode semantics (re-verified, unchanged), single-absence calibration (real, modest but consistent improvement over every baseline), multi-absence honesty (correctly marked `EXPERIMENTAL_MULTI_ABSENCE`, never silently upgraded or switched), artifact truthfulness (manifest matches actual validated behavior, enforced by an executable validator), Role dependency freshness (composes correctly, never outranks a stale dependency), or production isolation (structurally proven impossible for Phase 3 to influence any production numeric path, not merely untested). Every limitation found is disclosed above rather than hidden, and none of them individually or collectively rises to a certification blocker given Phase 3's own scope (a `SHADOW_ONLY` predictive analytical product, not a production recommendation engine).

## 49. Phase 3 freeze contract

Future phases (starting with Phase 4, Waiver Intelligence 2.0) must consume, unmodified except through a separately reviewed and certified change:

- Qualified full-game nonparticipation semantics (all-cause, `cause: UNKNOWN`)
- Absence episode semantics (`EPISODE_ONSET`/`EPISODE_CONTINUATION`, bye-safe, team-change-bounded)
- Onset-vs-continuation calibration boundary (primary calibration is onset-only)
- The historical-cause-`UNKNOWN` rule (never silently upgraded to an injury label)
- The Phase 2 dependency contract (Phase 3 consumes `PlayerRoleProfile`/`DimensionProfile` directly, never recalculates)
- The vacated-opportunity schema (`VacatedDomainRole`)
- The beneficiary distribution schema (`BeneficiaryDomainPrediction`, with `observed_pre_scenario_role`/`expected_scenario_role`/`expected_delta` always distinct)
- The structural residual concept (`StructuralResidual`, never forced to zero)
- The hierarchical role-vector allocator (`CANDIDATE_4_HIERARCHICAL`) as the frozen v1 model
- The team → position → league inheritance hierarchy with shrinkage
- Single-absence = `CALIBRATED`; multi-absence = `EXPERIMENTAL_MULTI_ABSENCE` (never presented as equivalent)
- QB-unsupported semantics (`UNSUPPORTED_SCENARIO`)
- The scenario contract (`OpportunityPropagationScenarioRequest`/`Result`, conditional not probabilistic)
- OPI manifest/versioning (content-addressed, `role_opportunity_version` as a real first-class dependency)
- `OpportunityPropagationIntelligenceLineage` (additive, never required)
- The Phase 1 freshness composition pattern (compose Role freshness, never re-derive or outrank it)
- `SHADOW_ONLY` deployment / `eligible_to_influence_production: false` separation

Phase 4 must not build a parallel handcuff/injury-beneficiary model — it consumes Phase 3's existing contingent-role output as one input among many (per the instructions' own Phase 4 boundary), never re-derives redistribution logic itself.

## 50. Phase 4 boundary (restated, not begun)

Phase 4 (Waiver Intelligence 2.0) may combine Phase 2 observed role + Phase 3 contingent opportunity + Football Intelligence + league scoring + return-yard scoring + schedule + roster need + replacement value + drop cost + bench optionality + manager competition + FAAB + uncertainty. **None of that exists anywhere in this repository as of this checkpoint.** Confirmed by the grep in §40 and the file-listing check in the Checkpoint D/E driver's own concurrency gate (§1) — no Phase 4 files were found or created.

---

**PHASE 3 CERTIFIED — READY TO FREEZE**

STOP. Do not merge, deploy, tag, or begin Phase 4. Do not connect OPI to waiver ranking, FAAB, projections, Start/Sit, trades, or matchup logic. Wait for review.
