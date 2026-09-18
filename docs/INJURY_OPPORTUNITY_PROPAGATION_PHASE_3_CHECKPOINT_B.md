# Injury → Opportunity Propagation Intelligence — Phase 3 — CHECKPOINT B

## Historical Full-Game Nonparticipation & Opportunity Redistribution Substrate

Status: **descriptive only**. No predictive model, no scenario engine, no fantasy-facing output, no production code path exists yet. This checkpoint builds the historical event/redistribution substrate Checkpoint C will later train and backtest against.

## 0. Semantic correction, applied throughout

Checkpoint A found no historical source in this repository capable of reliably distinguishing injury from any other cause of nonparticipation. Every event built here is therefore a factual **`FULL_GAME_NONPARTICIPATION`** observation, never an injury inference. `cause = "UNKNOWN"` for every single event this checkpoint produced — **verified 100% UNKNOWN, 0% otherwise** (§7 below) — and an executable test (`test-absence-events-invariants.R`) asserts this cannot silently change. This is honest provenance, not a model failure, per the instructions' own framing.

## 1. Git

| Item | Value |
|---|---|
| Branch | `injury-opportunity-propagation-phase3` |
| Pre-Checkpoint-B HEAD | `7ea2feb` (Checkpoint A commit) |
| Post-Checkpoint-B HEAD | committed in this checkpoint's commit (see below) |
| `origin/main` | `35ba3fe` — **no drift**, zero commits either direction, re-verified by `git fetch origin` immediately before starting this checkpoint |
| Working tree | clean before this checkpoint's changes; all changes below are new files plus one additive `.gitignore` line |
| Concurrency / automated-refresh check | `git diff origin/main -- lib/canonical/ lib/player-role-intelligence/ analysis/player_role/` → 0 lines. Phase 2's manifest (`role_opportunity_manifest.json`) shows `generated_at: 2026-09-18T03:02:41+0000`, `season: 2026, through_week: 1` — an automated content refresh already reflected on `origin/main`, not code drift; the frozen contracts (types, formulas, versioning scheme) are byte-identical to Checkpoint A's audit. |

Repo-wide TypeScript regression, this HEAD plus this checkpoint's additions: **2036 pass / 0 fail / 4 skipped** (2040 total) — exactly Checkpoint A's recorded baseline (2032/0/4) plus the 4 new production-isolation tests added in this checkpoint. Zero pre-existing tests changed behavior.

## 2. Event semantics — exact factual definition

A **`QUALIFIED_FULL_GAME_NONPARTICIPATION`** event is `(season, week, team, gsis_id)` such that **all** of the following hold, in this order:

1. The player's identity resolves to exactly one team for that week in `rosters_weekly` (not `MULTIPLE_TEAM_ASSIGNMENTS`).
2. The player's position is one of `RB`, `WR`, `TE` (never `QB` — see §5).
3. The player has a resolvable **prior** Phase 2 participation history (not `INSUFFICIENT_PRE_EVENT_HISTORY`).
4. The player's roster team for that week equals their own last-known team from Phase 2 participation history strictly before that week — no team change, trade, release, retirement, or free-agency departure (not `TEAM_CHANGE`).
5. The roster status for that week is one of `INA`, `RES`, `PUP`, `SUS` — a roster-status-confirmed nonparticipation-while-still-with-the-team signal (not `SOURCE_GAP` [status unresolved] or `ROSTER_ASSOCIATION_AMBIGUOUS` [status present but not one of these four, e.g. `ACT`/`DEV`]).
6. The player's roster team played a valid, completed NFL game that week (`schedules.rds` has non-null `home_score`/`away_score` for that game) — automatically excludes bye weeks.
7. The player has **zero** Phase 2 `player_game_role` participation row for that `(season, week, team, gsis_id)` — re-verified independently as its own invariant, not merely assumed from the detection join (§7 in `test-absence-events-invariants.R`: 0 of 12,291 qualified events have a matching participation row).
8. The player's chronology-safe **pre-event** Phase 2 role (the `recent` EWMA baseline computed strictly before that week — see §9) clears **at least one** of the published `meaningful_role` threshold variants on **at least one** applicable dimension (never all dimensions; never `latest`, `season`, or a raw single-game value).

Anything failing steps 1–7 is an **excluded candidate** with a deterministic, logged `reason` (§8). Anything failing only step 8 is logged separately as `no_meaningful_role`, not silently dropped.

`cause` is a separate field, always `UNKNOWN` in this repository (no source distinguishes injury from healthy-scratch, discipline, personal reasons, or any other cause).

The instructions' `CANDIDATE_FULL_GAME_NONPARTICIPATION` / `AMBIGUOUS_NONPARTICIPATION` tiers map onto this pipeline as: **candidate** = any row surviving the team-game-validity join (step 6) before roster/role resolution (49,928 rows, §4); **ambiguous** = `ROSTER_ASSOCIATION_AMBIGUOUS` + `SOURCE_GAP` + `MULTIPLE_TEAM_ASSIGNMENTS` (11,732 rows, §8); **qualified** = passes all 8 steps (12,291 rows).

## 3. Historical source coverage — `rosters_weekly` reliability audit (spec §28)

| Measurement | Value |
|---|---|
| Total rows | 599,127 |
| Season range | 2012–2026 |
| Missing `gsis_id` | 135 (0.02%) |
| Missing `team` | 0 |
| Player-weeks with >1 distinct team (genuinely ambiguous identity/team) | 13 of 592,352 (0.002%) |
| **Participation cross-check**: of 274,341 real Phase 2 participation player-weeks, how many have a `rosters_weekly` row at all | 274,319 of 274,341 (99.99%) |
| **Participation cross-check**: of those with a row, does the roster's team match the team the player actually played for | 274,022 of 274,319 (**99.89%**) |
| `status = "INA"` (official game-day inactive) season coverage | **2019–2026 only** — 0 rows in 2012–2018. This is a real, hard coverage boundary in the underlying nflverse/nflreadr roster source, not a defect in this build. |
| `status = "RES"` (IR/reserve) season coverage | **full 2012–2026** (2,394–6,363 rows/season), the only roster-confirmed-nonparticipation signal available before 2019 |
| `status = "PUP"` season coverage | 2016–2021, essentially unused since (1 row in 2023, 0 after) |
| `status = "SUS"` season coverage | 2012–2020, essentially unused since (1 row in 2022, 0 after) |
| Duplicate `(season, week, gsis_id)` keys (candidate ambiguity before resolution) | 6,627 of 598,992 (1.1%) — all resolved to `unresolved = TRUE` (never arbitrarily disambiguated) if they disagree on team; `build_roster_lookup()` in `analysis/opportunity_propagation/lib_absence_detection.R` |

**Conclusion**: `rosters_weekly` is highly reliable for team association (99.89% agreement against real participation) across the full 2012–2026 window, but the single cleanest per-game nonparticipation signal (`INA`) is **only available from 2019 onward**. 2012–2018 events rely on `RES` alone (predominantly IR placements, which persist across many consecutive weeks rather than being a single-game-specific label) — this is documented in §9's per-season event counts, which show a clear step-change at 2016 (nflreadr's own roster-data coverage improves materially from 2016) and are far sparser in 2012–2015. **Recommendation for Checkpoint C**: treat 2019–2026 as the primary, highest-confidence analysis window; 2012–2018 remains available but should be flagged as lower-confidence coverage in any backtest segment report (instructions §28's explicit "restrict the historical event window" option — recommended as a reporting segmentation, not a hard code restriction, since the data is real and usable, just thinner).

## 4. Candidate detection

| Step | Row count |
|---|---|
| Raw candidates (RB/WR/TE, roster team played a valid completed game, zero Phase 2 participation row) | **49,928** |
| → Excluded (deterministic reasons, §8) | 34,959 |
| → No meaningful pre-event role (passed every other gate) | 2,678 |
| → **Qualified `FULL_GAME_NONPARTICIPATION` events** | **12,291** |

## 5. Position scope

`QB` is **excluded from the absent-player universe entirely**, per instructions §5/§30/§53 and Checkpoint A's own recommendation. Verified as an executable invariant (0 QB rows in `absence_events`). Rationale, restated: QB nonparticipation changes the offensive environment and play-calling globally rather than merely redistributing a role among teammates — it needs a separate model, not a weak special case here.

QB **is** included in the beneficiary candidate pool (RB/WR/TE/QB), but a QB's `rush_share` gain is tracked as a separate named field, `qb_rush_share_delta`, on the domain-accounting record — never folded into an RB/WR/TE beneficiary's `identified_beneficiary_gain`. QB is *not* excluded from any other domain's accounting (a QB essentially never absorbs WR/RB targets or return duties, so this has near-zero practical effect, but the code does not carve QB out of domains the instructions didn't ask for). Verified: 216,355 QB beneficiary-observation rows exist across all domains; 43,271 of those are QB `rush_share` observations, and exactly 3,624 domain-accounting rows (one per RB absence event) carry a non-`NA` `qb_rush_share_delta` — matching the RB absent-event count exactly.

## 6. Role domains propagated

All of Phase 2's non-route domains: `PARTICIPATION` (snap_share), `RUSHING` (rush_share, position_group_rush_share), `RECEIVING` (target_share, position_group_target_share, air_yards_share), `HIGH_VALUE` (rz_carry_share, rz_target_share), `RETURNS` (kick_return_role, punt_return_role) — 10 dimensions total, exactly mirroring `lib/player-role-intelligence/schema.ts`'s `RoleDomain` decomposition. **Routes excluded** from qualification and from every computation in this checkpoint, per Checkpoint A's recommendation (proxy-quality, source-lagged for all of 2026-to-date). Returns are computed and reported as their own domain — verified as an executable invariant that no `RETURNS`-domain row's dimension ever appears among offensive dimensions and vice versa (no cross-contamination).

## 7. Cause coverage

**12,291 of 12,291 qualified events (100%) have `cause = "UNKNOWN"`.** 0% have any other value, because no source in this repository supports one. Verified as an executable test invariant, not merely a default that could silently drift.

## 8. Exclusions (deterministic reasons, all candidates accounted for)

| Reason | Count |
|---|---|
| `TEAM_CHANGE` (team mismatch vs. last-known Phase 2 team, or a departure-shaped roster status — `CUT`/`TRD`/`TRC`/`TRT`/`RET`/`UFA`/`RFA`/`NWT`/`EXE`/`E01`/`E14`) | 14,361 |
| `ROSTER_ASSOCIATION_AMBIGUOUS` (roster status present but not `INA`/`RES`/`PUP`/`SUS` — predominantly `ACT`/`DEV`) | 11,408 |
| `INSUFFICIENT_PRE_EVENT_HISTORY` (no prior Phase 2 participation row at all — rookies, or a player with no history before the event week) | 8,184 |
| `UNSUPPORTED_POSITION` (drifted off RB/WR/TE by the event week per the roster's own position field) | 682 |
| `SOURCE_GAP` (roster row present but status unresolved) | 324 |
| **Total excluded** | **34,959** |
| `NO_MEANINGFUL_PRE_EVENT_ROLE` (passed every gate above; role too small on every dimension) | 2,678 |

Every exclusion reason is logged per-row in `analysis/opportunity_propagation/cache/excluded_candidates.rds` — nothing is silently filtered.

## 9. Event counts by season / position / multiplicity

| Season | Qualified events | | Position | Qualified events |
|---|---|---|---|---|
| 2012 | 95 | | RB | 3,624 |
| 2013 | 90 | | WR | 5,578 |
| 2014 | 85 | | TE | 3,089 |
| 2015 | 120 | | **Total** | **12,291** |
| 2016 | 754 | | | |
| 2017 | 689 | | Status | Qualified events |
| 2018 | 823 | | INA | 3,998 |
| 2019 | 1,227 | | RES | 7,868 |
| 2020 | 1,397 | | PUP | 228 |
| 2021 | 1,619 | | SUS | 197 |
| 2022 | 1,321 | | | |
| 2023 | 1,251 | | Multiplicity | Events |
| 2024 | 1,263 | | `multiple_major_absences` | 10,767 (87.6%) |
| 2025 | 1,508 | | `single_major_absence` | 1,524 (12.4%) |
| 2026 (partial, W1 only) | 49 | | | |

**The 2012→2016 step-change (95→754) matches the `rosters_weekly` coverage boundary documented in §3**, not a real change in NFL absence rates — flagged explicitly rather than left to look like a modeling artifact.

**The high multi-absence rate (87.6%) has a structural explanation, not a hidden bug**: `RES` (IR) status, which is 64% of all qualified events, persists across every week a player remains on IR — a single IR placement lasting 8 weeks contributes 8 independent weekly events, and any team with 2+ concurrent IR players (common over a full season) has every one of those overlapping weeks counted as `multiple_major_absences`. This is documented as a known limitation (§15) — Checkpoint C should decide whether to model IR placements as an "absence episode" spanning multiple weeks, or continue treating each week independently (with confidence-weighting rather than treating every multi-absence week as equally novel evidence).

**Meaningful-role threshold sensitivity** (spec §10/§26 — published, not locked): of the 14,969 candidates that passed every non-role gate, **12,291 (82.1%) clear `DEFAULT`, exactly the same 12,291 (82.1%) clear the more permissive `LOW` variant, and 11,185 (74.7%) still clear the stricter `HIGH` variant** — the qualifying population is dominated by players with real, substantial pre-event roles (91% of `DEFAULT`-qualified events also clear `HIGH`), not marginal/noise cases riding a low bar. This is genuine evidence that the threshold choice is not doing fragile, arbitrary work — Checkpoint C can pick from these three published variants (or backtest further ones) with confidence that the choice is not a coin flip.

## 10. Pre-event role — how Phase 2 was consumed (spec §3/§38)

**No share/EWMA/confidence formula was re-derived.** `analysis/opportunity_propagation/lib_fast_baselines.R` is a vectorized, mathematically exact re-expression of Phase 2's own `ewma_through()`/`dimension_series()` (`analysis/player_role/lib_role_profile.R`) — necessary because the literal per-row-loop call pattern (once per event × beneficiary × dimension) was measured at ~1.7s/event, which would have made a full 2012–2026 build take on the order of hours. The file's header documents the exact algebraic derivation (the EWMA ratio-of-cumulative-sums identity) and cites the cross-check that proves it.

**Cross-check results** (`test-fast-baselines-match-phase2.R`, spec §38's explicit requirement): every `recent`/`season`/`n_games_season`/`opportunity_total` value produced by the fast path was compared against Phase 2's real `dimension_series()`/`build_dimension_profile()` on hundreds of real historical player-weeks across 10 dimensions, **both for normal participation rows and for real historical gap weeks (absence candidates)** — **0 mismatches, max floating-point error 3.3e-16 (machine epsilon)**, across thousands of individual checks. Confidence is computed by calling Phase 2's actual `confidence_level()` function directly (not re-derived) on the bulk-computed `n_games_season`/`opportunity_total`.

One real defect was caught and fixed during this work, not merely assumed away: an early version of the vectorized EWMA indexed exponent weights by raw row position instead of the count of *valid* observations, which silently stretched the effective half-life across any NA gap (kick/punt return share, which has frequent bye/no-return NA rows, was the case that exposed it — a 0.05 absolute error before the fix, 3.3e-16 after).

## 11. Vacated opportunity domains

Reported per qualified event × dimension in `absence_events.rds` (long format: one row per `(absence_event_id, domain, dimension)`, carrying `pre_event_recent`, `pre_event_season`, `pre_event_n_games_season`, `pre_event_opportunity_total`, `pre_event_confidence`, `pre_event_evidence_state`) — the chronology-safe pre-event baseline, never the event game's own values.

## 12. Beneficiary observations — cross-position representation (spec §16)

**2,259,749 beneficiary-observation rows** across 12,291 events (one row per `(event, beneficiary, dimension)` where the dimension applies to the beneficiary's position). The candidate pool per event is **every same-team RB/WR/TE/QB player on that week's resolved roster or with an actual event-game participation row** — never restricted to the absent player's own position. A genuine zero-touch teammate is represented with `event_game_value = 0` (a real, observed zero — not a fabricated Phase 2 row; the fabrication rule Phase 2 itself enforces applies to *participation rows*, not to scoring an already-identified real teammate's actual output as zero when they didn't touch the ball).

## 13. Domain/team accounting (spec §17/§18, residual never forced to zero)

`domain_accounting.rds` — 93,285 rows, one per `(absence_event_id, domain, dimension)`, columns: `vacated_opportunity` (the absent player's pre-event value), `identified_beneficiary_gain` (sum of *positive* beneficiary deltas, RB/WR/TE/QB except QB `rush_share`), `n_beneficiaries_observed`, `qb_rush_share_delta` (populated only for `rush_share`), `residual_structural_change = vacated_opportunity − identified_beneficiary_gain − qb_rush_share_delta`.

Verified as an executable invariant: **the residual is genuinely both positive and negative across the dataset** (range −2.99 to 1.0, median −0.157) — it is never clamped, and beneficiaries collectively absorbing *more* than the nominal vacated share (a negative residual) is common, reflecting real game-to-game variance rather than a strict zero-sum transfer, exactly as the instructions anticipated (§17: "some role disappears... the offense may simply throw less").

**Illustrative real example** (Patrick Ricard, BAL, Week 5 2025, `RES` status, `single_major_absence`): `PARTICIPATION/snap_share` vacated = 0.444 (he played 44% of BAL's offensive snaps as a blocking fullback), identified beneficiary gain = 0.459, residual ≈ −0.015 — a case correctly captured via the `PARTICIPATION` domain despite his `RUSHING`/`RECEIVING` shares being near zero (a real blocking specialist, not a ball-carrier), demonstrating the "qualify on *any* domain" design (spec §10) working as intended rather than requiring every dimension to be meaningful.

## 14. Multi-absence handling (spec §19-20)

Every qualified event carries `absence_set_id = "{season}:{week}:{team}"` and `absence_multiplicity ∈ {single_major_absence, multiple_major_absences}`, computed from the actual count of qualified events sharing that set — verified as an executable invariant against the real data (no event's multiplicity label disagrees with its set's true size). The raw substrate makes **no causal attribution to one player** when multiple absences co-occur: each absent player in a multi-absence week gets their own event row with its own vacated/beneficiary accounting computed independently, and Checkpoint C is left to decide how to model the (frequent, per §9) overlapping case rather than this checkpoint silently picking a convention.

## 15. Identity

`gsis_id` throughout, reusing Phase 2's own identity resolution — no new matching subsystem. Unresolved identity is logged and counted, never silently dropped: `MULTIPLE_TEAM_ASSIGNMENTS` (ambiguous roster identity that week) and the `rosters_weekly`-level 135 missing-`gsis_id` rows (excluded upstream, before candidate detection, since `build_roster_lookup()` filters to non-missing `gsis_id`).

## 16. Returns

Computed and reported as domain `RETURNS`, dimensions `kick_return_role`/`punt_return_role`, using the exact same pre-event/event-game/delta mechanics as every offensive domain — structurally isolated (§6's cross-contamination invariant, verified). No offense/returns blending anywhere in the substrate.

## 17. Routes

Not computed, not required, not referenced anywhere in this checkpoint's qualification, beneficiary identification, or accounting logic — an explicit, verified absence rather than a silent gap (`OPP$DIMENSIONS` contains no `route_participation` row at all).

## 18. Data quality

- Duplicate `(season, week, gsis_id)` roster keys: 6,627 of 598,992 (1.1%), all correctly marked `unresolved` rather than arbitrarily disambiguated.
- `player_game_role` × `rosters_weekly` team agreement: 99.89% (§3).
- Zero qualified events have a matching Phase 2 participation row (verified — the core "missing row alone is not an absence" invariant, spec §7, holds because every event additionally requires the roster/schedule confirmation, not the missing row itself).
- Determinism: rebuilding the entire substrate from the same input caches reproduces a byte-identical set of `absence_event_id`s (verified as an executable test, full rebuild).

## 19. Performance

| Stage | Time |
|---|---|
| Load caches (Phase 1 + Phase 2 `.rds`) | 1.4s |
| Full build (candidate detection → classification → role-check → bulk beneficiary/accounting) | 230.6s (~3.8 min) |
| Save internal artifacts | 5.9s |
| **Total** | **~4 minutes**, single run, 2012–2026, 49,928 candidates → 12,291 qualified events → 2,259,749 beneficiary observations |

Internal artifacts (git-ignored, `analysis/opportunity_propagation/cache/`): `absence_events.rds` (0.65MB), `beneficiary_observations.rds` (18.9MB), `domain_accounting.rds` (1.3MB), `excluded_candidates.rds` (0.22MB), `no_meaningful_role_candidates.rds` (0.02MB), `roster_lookup.rds` (2.2MB) — 23.3MB total. Feasible for repeated backtesting (spec §35): a full historical rebuild takes minutes, not hours.

A real performance defect was found and fixed during this checkpoint, not avoided by luck: an initial per-event R-loop architecture (calling data.table joins once per event × beneficiary) was measured at ~1.7s/event — infeasible at full-history scale (would project to ~5.8 hours for 12,291 events). Root causes found and fixed: (1) a data.table NSE gotcha where join-value variable names identical to the target table's column names silently triggered a cartesian self-join instead of a scalar lookup; (2) `base::split()`'s known slowdown with very large group counts (used to build a per-row lookup index). The final architecture batches all beneficiary/accounting computation into a small, fixed number of vectorized data.table joins and rolling joins (§10), independent of the event count.

## 20. Tests

- `test-fast-baselines-match-phase2.R`: 2 `test_that` blocks, exercising thousands of individual value comparisons (>500 and >200 respectively, sanity-gated) against real historical data — **0 failures**.
- `test-absence-events-invariants.R`: 20 `test_that` blocks covering cause=UNKNOWN, QB exclusion, position scope, no-participation-row invariant, bye-week exclusion, multiplicity correctness, referential integrity, delta-equals-difference, residual sign variety, QB rush-only carve-out, team-change exclusion correctness, returns/offense domain isolation, full-rebuild determinism, no-fantasy-points, no-prediction-fields, and exhaustive exclusion-reason vocabulary — **0 failures**.
- `test/injury-opportunity-propagation-isolation.test.ts` (TypeScript, repo's own `npm test`): 4 tests — no production consumer references the substrate, no TS product exists yet (correct for this checkpoint), Phase 2 and `lib/canonical/lineage.ts` untouched — **0 failures**.
- Full repo TypeScript suite: **2036 pass / 0 fail / 4 skipped** (Checkpoint A's 2032/0/4 baseline + this checkpoint's 4 new tests, zero regressions).

## 21. Production isolation

- `git diff origin/main -- lib/weekly/ lib/trades/ lib/orchestrator/ lib/projections/ app/api/` → 0 lines (no file under any production path was touched).
- No `lib/injury-opportunity-propagation/` TypeScript directory exists yet — correct for this checkpoint (Checkpoint D's deliverable, spec §34).
- `lib/canonical/lineage.ts` has no `OpportunityPropagationIntelligenceLineage` type yet — verified as an executable test.
- `lib/player-role-intelligence/schema.ts` (Phase 2, frozen) is untouched — verified as an executable test.
- Full TypeScript regression: 2036/0/4 (§20).

## 22. Limitations (explicit)

1. `cause` is 100% `UNKNOWN` — this repository has no source that can distinguish injury from any other cause of nonparticipation, at any point in this checkpoint or the next. Any future product surface must say so plainly.
2. The `INA` (game-day inactive) signal is only available 2019–2026; 2012–2018 relies on the coarser `RES` (IR) status alone, and 2012–2015 specifically has materially thinner `rosters_weekly` coverage than 2016 onward (a real upstream nflverse/nflreadr limitation, not a defect introduced here).
3. `multiple_major_absences` is 87.6% of qualified events, substantially inflated by IR placements persisting across many consecutive weeks being counted as independent weekly events (§9) — Checkpoint C needs to decide whether/how to treat an IR stretch as one episode rather than N independent observations.
4. `MID_GAME_EXIT` is not modeled at all in this checkpoint (deferred per spec §21/§27 — no play-by-play-level in-game exit timing evidence has been validated in this repository).
5. `RETURN_FROM_ABSENCE` outcome labels (`returned_next_team_game`, etc.) were **not** added in this checkpoint — Checkpoint A's audit flagged this as an open question (§16 item 5 of the audit doc); it was not built here because it adds scope without a clear Checkpoint B consumer, and can be added additively in Checkpoint C if the backtest design needs it, without touching this checkpoint's substrate.
6. `coordinators.yaml` (OC/DC continuity) remains empty, per instructions §24 — not backfilled in this checkpoint. Head-coach and personnel-continuity signals from `analysis/football_intel/lib_continuity.R` remain available for Checkpoint C but were not wired into this checkpoint's substrate (no continuity-based exclusion or discounting was needed for a purely descriptive event table).
7. The `meaningful_role` threshold is a **published, unlocked** set of three variants (§9) — Checkpoint C's backtest, not this checkpoint, should make the final modeling choice.
8. Beneficiary candidate identification uses `roster_lookup ∪ event-game participants` for the team-week — a player who was neither on the resolved roster nor recorded a participation row that week cannot appear as a beneficiary (this is the same roster-reliability boundary documented in §3, not a separate gap).
9. `identified_beneficiary_gain` sums only *positive* deltas; a beneficiary whose role *shrank* that week (e.g. a committee-mate who also lost snaps for unrelated reasons) is fully retained in `beneficiary_observations` with a negative `delta`, but does not offset another beneficiary's gain in the domain-accounting roll-up — a deliberate simplification documented here rather than silently baked in.

## 23. Open questions carried to Checkpoint C

1. Should IR-spanning multi-week absences be collapsed into a single "episode" for training purposes, or modeled as independent weekly observations with some down-weighting for repeated-week evidence? (§9, §14, limitation 3.)
2. Which `meaningful_role` threshold variant (`DEFAULT`/`LOW`/`HIGH`) backtests best, or should Checkpoint C derive its own from this checkpoint's published candidates? (§9, limitation 7.)
3. Given the 2019 `INA`-coverage boundary, should Checkpoint C's primary backtest window be restricted to 2019–2026, with 2012–2018 reported as a secondary/lower-confidence segment? (§3.)

---

**CHECKPOINT B COMPLETE — READY FOR REVIEW**

Do not begin Checkpoint C until this checkpoint is reviewed and the open questions in §23 are answered.
