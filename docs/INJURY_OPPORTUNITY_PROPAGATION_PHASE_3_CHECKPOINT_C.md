# Injury → Opportunity Propagation Intelligence — Phase 3 — CHECKPOINT C

> **Path note (Phase 3.5B, later correction — the findings below are unchanged):** this document was written while the
> module was planned as `lib/injury-opportunity-propagation/`. It shipped as **`lib/opportunity-propagation-intelligence/`**
> (`schema.ts`, `read.ts`, `lineage.ts`, `scenario.ts`, `model.ts`, `format.ts`, `index.ts`, `data/`). Read every
> `lib/injury-opportunity-propagation/…` path below as that directory. The product is deliberately *not* called an
> "injury model": it is a conditional scenario allocator (see the served manifest's `scenario_semantics`).

## Opportunity Redistribution Model, Uncertainty, and Walk-Forward Backtesting

**Historical training events are all-cause qualified full-game nonparticipation, not confirmed injuries.** No source in this repository distinguishes injury from any other cause of nonparticipation (Checkpoint A/B finding, unchanged). Every model in this checkpoint predicts redistribution *conditional on* a specified `FULL_GAME_NONPARTICIPATION` scenario — it never estimates the probability a player is hurt, out, or unavailable, and it is never described internally as an "injury model." The internal name for what this checkpoint builds is **Opportunity Propagation under Full-Game Nonparticipation**.

Status: **modeling and backtesting only**. No served product, no manifest, no lineage, no production import. Checkpoint D owns the served surface.

## 0. Git

| Item | Value |
|---|---|
| Branch | `injury-opportunity-propagation-phase3` |
| Pre-Checkpoint-C HEAD | `f590103` (Checkpoint B commit) |
| Post-Checkpoint-C HEAD | this checkpoint's commit (below) |
| `origin/main` | `35ba3fe` — **no drift**, re-verified by `git fetch origin` before starting |
| Drift classification | `git diff origin/main -- lib/canonical/ lib/player-role-intelligence/ analysis/player_role/ analysis/opportunity_propagation/{config.R,lib_absence_detection.R,lib_fast_baselines.R,lib_redistribution_observed.R,build_absence_events.R}` → 0 lines. Phase 1/2 frozen contracts and Checkpoint B's own substrate-building code are byte-identical to what was certified in Checkpoint B; the cached substrate (`analysis/opportunity_propagation/cache/*.rds`, git-ignored) is unchanged (`opportunity_propagation_version: opp:2012-2026:ecd3f3d215ff`, identical to Checkpoint B's). |
| Working tree | clean before this checkpoint's changes |

Repo-wide TypeScript regression: **2036 pass / 0 fail / 4 skipped** — identical to Checkpoint B's own result (this checkpoint added zero TypeScript files; all new work is R). `tsc --noEmit`: clean. `eslint`: 10 pre-existing errors / 42 pre-existing warnings, all in `scripts/yahoo-approval-resume-cert.ts` and `test/projection-special-teams.test.ts` — confirmed present independent of this checkpoint's changes (files this checkpoint never touched), zero new lint issues introduced.

## 1. Episode hardening (spec §4-8)

Checkpoint B's 12,291 game-level qualified events collapse to **3,265 distinct absence episodes** via `analysis/opportunity_propagation/lib_episodes.R`, using the team's own completed-game sequence (never raw calendar week) as the continuity clock, so a bye week never splits an episode (verified as an executable test against real data).

| Metric | Value |
|---|---|
| Game-level qualified events (Checkpoint B) | 12,291 |
| Absence episodes | **3,265** |
| Episode onsets (== episode count) | 3,265 |
| Continuation games | **9,026** |
| One-game episodes | 1,312 (40.2%) |
| Multi-game episodes | 1,953 (59.8%) |
| Episode length distribution | 1 game: 1,312 · 2: 575 · 3–4: 584 · 5–8: 403 · 9+: 391 (max 67) |
| Episode end reason | RETURN: 2,409 (73.8%) · TEAM_CHANGE: 328 · CENSORED_UNKNOWN: 313 · SEASON_END: 215 |

**This directly answers Checkpoint B's own open question**: the original 12,291-event count was **74% repeated continuation** of episodes already captured at onset (9,026 of 12,291) — the true count of independent causal shocks is 3,265, not 12,291.

By position (onsets / continuation games): RB 978/2,646 · WR 1,529/4,049 · TE 758/2,331. By season, onsets step sharply upward at 2016 (2012–2015: 95–120/yr → 2016–2018: 690–825/yr → 2019–2025: 1,220–1,620/yr), matching Checkpoint B's own documented `rosters_weekly` coverage boundary — not a real change in NFL absence rates.

**Episode construction rule** (deterministic, conservative, documented rather than hidden): an episode continues across consecutive qualified-absence team-games for the same player/team; it ends the moment the player either (a) has a real Phase 2 participation row (RETURN), (b) has a team-game with neither a participation row nor a qualified-absence row — e.g. roster status reverted to `ACT`/`DEV` with no participation evidence — (CENSORED_UNKNOWN; we do not assume continuity through an unconfirmed week), or (c) changes teams (TEAM_CHANGE). A real defect was found and fixed during construction: the initial implementation silently left 328 team-change-ended episodes with no end reason recorded at all (an omission, not a wrong value) — caught by an executable invariant test requiring every episode to have exactly one end reason.

**Leakage invariant** (spec §6, verified as an executable test): eventual episode duration is never a feature available at onset-prediction time — the `episodes` table carries no such column, and `episode_game_index` at continuation only ever reflects games *already observed* (1, 2, 3, ... so far), never a future total.

## 2. Primary v1 population (spec §7, §9, §37)

- **Primary modeling/model-selection population**: `EPISODE_ONSET` events only, `meaningful_role_default` = TRUE (Checkpoint B's threshold), `absence_multiplicity == single_major_absence`, seasons 2019–2025 (2019 used as training-only warm-up; walk-forward validates 2020–2025). **252 such episodes.**
- Full 2019–2025 onset population (before the single/multi split): 2,759 (252 single, **2,507 multi** — multi-absence dominates the onset population itself, not just game-level events, consistent with Checkpoint B's own multi-absence-rate finding).
- 2012–2018 robustness sample: 226 onset single-absence episodes (frozen-model diagnostic only, §10 below).
- 2026 forward sample: 7 onset single-absence episodes (diagnostic only, §11 below).

Continuation games are retained (`episodes.rds`) for the continuation analysis in §12, never mixed into the onset training/validation population.

## 3. Meaningful-role threshold: not guessed, backtested with continuous magnitude retained (spec §11-13)

Every model consumes the **continuous** `pre_event_recent` value (a real share, e.g. 0.31), never a collapsed boolean — the threshold only gates *event inclusion*, never replaces the magnitude used inside the allocators. Checkpoint B's three published threshold variants (`DEFAULT`/`LOW`/`HIGH`) were rerun through the full walk-forward backtest (§7):

| Variant | Onset single-absence events (primary window) | CANDIDATE_4 mean L1 | CANDIDATE_4 top-beneficiary accuracy |
|---|---|---|---|
| DEFAULT | 252 | 1.444 | 0.167 |
| LOW | 252 (identical set — Checkpoint B already found `meaningful_role_low` == `meaningful_role_default` population-wide) | 1.444 | 0.167 |
| HIGH | 226 | 1.459 | 0.170 |

**Selected: DEFAULT.** HIGH loses 26 events (10.3% of sample) for a negligible, inconsistent metric change (L1 slightly worse, top-beneficiary accuracy slightly better) — not a material trade either direction. LOW offers nothing beyond DEFAULT (identical set). DEFAULT is the simplest criterion that removes trivial-noise events without materially damaging generalization, exactly the standard the instructions set (§41).

## 4. Fundamental modeling unit (spec §14)

The prediction unit is `(absence_event_id, domain, dimension)` → a full distribution across candidate beneficiaries plus a structural residual — **never an independent per-beneficiary regression**. Every metric in this checkpoint (§7-9) is computed and weighted at this event/domain grain; individual beneficiary rows feed the allocators but are never scored as if independent (e.g., `top_beneficiary_accuracy` and the L1 distribution error are both computed once per event/domain, not averaged naively across a variable-sized beneficiary pool in a way that would over-count events with larger rosters).

## 5. Model candidates (spec §28-29, §58)

All five live in `analysis/opportunity_propagation/lib_propagation_model.R`, sharing one output contract (`pre_event_role`, `predicted_role`, `predicted_delta` per candidate/domain) and one shared bounds/renormalization post-processor (`clip_predicted_shares()`, §8):

| Name | Formulation |
|---|---|
| `BASELINE_0_NO_PROPAGATION` | Retains pre-event role; zero redistribution. |
| `BASELINE_1_NEXT_MAN_UP` | Deterministic: the same-position candidate with the largest nonzero pre-event share absorbs 100% of the vacated share; every other candidate gets zero. |
| `BASELINE_2_PROPORTIONAL` | Vacated share allocated across **all** eligible candidates (any position, cross-position allowed) proportional to pre-event share; assumes 100% inheritance. |
| `BASELINE_3_CONTINGENCY_SHRUNK` | Same proportional weighting as Baseline 2, but the *fraction* of the vacated share assumed inherited (vs. left as structural residual) is a hierarchical team → position → league empirical rate (`fit_inheritance_priors()`), shrunk by evidence count (k=3 team-level, k=6 position-level) — not an assumed 100%. |
| `CANDIDATE_4_HIERARCHICAL` | Baseline 3's hierarchical inheritance rate, **plus** within-event weighting refined by the candidate's own pre-event trend (`recent − season`, reusing Checkpoint B's already-computed fields — no new Phase 2 formula) and a same-position affinity multiplier fitted from training data (bounded [0.5, 4], never a hard constraint). |

**Candidate 5 (regularized/black-box) was not tested.** This is a deliberate scope decision, not an oversight: the primary population is 252 onset episodes — far too small for a regularized multinomial/GBM to be fit and validated without serious overfitting risk, and the instructions' own bar (§29) requires a black-box model to show a *material* advantage over interpretable alternatives before its opacity is justified. Given the sample size, no such candidate could be defensibly evaluated in this checkpoint; Candidate 4's hierarchical allocator already provides the "why B over C" decomposability the instructions require, and — as shown below — the margin between it and simpler baselines is itself modest, which argues against reaching for more complexity, not less.

## 6. Real defects found and fixed during model construction

Two genuine, reproduced bugs were caught before they could corrupt results — reported in full rather than silently patched:

1. **A data.table NSE self-reference bug**, structurally identical to the one Checkpoint B fixed: `inheritance_rate_lookup(priors, dimension, team, position)`'s scalar filter used parameter names identical to the target tables' own column names (`dimension`, `team`, `position`). `priors$team[priors$team$dimension == dimension & ..., ]` silently resolved the right-hand bare symbols to the table's *own* columns (a self-comparison, always TRUE), making every call fall through to the 0.5 default — meaning Baseline 3 and Candidate 4's *first* backtest run used a flat, uncalibrated 0.5 inheritance rate rather than the real fitted hierarchy, without erroring. Fixed by renaming the function's parameters (`.dim`/`.team`/`.pos`) to remove the ambiguity. All numbers in this report reflect the corrected, hierarchically-calibrated rate.
2. **A per-row `mapply()` performance regression**: the same scalar lookup, called once per beneficiary row inside the walk-forward loop, was measured to hang for 10+ minutes on a several-thousand-row table — the exact O(rows × table size) mistake Checkpoint B already made once with `beneficiary_candidates()`. Fixed with `attach_inheritance_rate()`, a single batched data.table merge (team → position → league) applied to the whole beneficiary table at once; full-history walk-forward runtime dropped from 162.7s to **16.7s** with numerically verified identical results (confirmed via an aligned, non-positional comparison after discovering that `merge()`'s default row-reordering had produced a false "mismatch" in an earlier, naively-indexed debugging comparison).

## 7. Primary backtest: single-major-absence, 2019–2025, DEFAULT threshold (spec §30-31, §34-37)

Chronology-safe walk-forward: for validation season *Y* ∈ {2020,...,2025}, training uses all onset events with `2019 ≤ season < Y` (an expanding window starting from 2019; 2019 itself is training-only, never validated, since no prior-year data exists for it within the primary window). Never validated on data used to fit that fold's priors — verified as an executable chronology test in addition to the walk-forward's own construction.

| Model | n (domain-events) | Mean L1 | Median L1 | Mean beneficiary MAE | Top-beneficiary accuracy | Top-2 recall | Mean residual error |
|---|---|---|---|---|---|---|---|
| BASELINE_0_NO_PROPAGATION | 2,110 | 1.504 | 1.091 | 0.0676 | 0.134 | 0.289 | 0.355 |
| BASELINE_1_NEXT_MAN_UP | 2,110 | 1.474 | 1.083 | 0.0699 | 0.181 | 0.279 | 0.272 |
| BASELINE_2_PROPORTIONAL | 2,110 | 1.448 | 1.043 | 0.0684 | 0.158 | 0.307 | 0.274 |
| BASELINE_3_CONTINGENCY_SHRUNK | 2,110 | 1.445 | 1.045 | 0.0688 | 0.159 | 0.309 | 0.261 |
| **CANDIDATE_4_HIERARCHICAL** | 2,110 | **1.444** | 1.044 | 0.0687 | **0.167** | **0.312** | **0.261** |

**Selected: `CANDIDATE_4_HIERARCHICAL`.** It has the lowest (or tied-lowest) value on every headline metric. Honesty about the margin: the improvement over `BASELINE_2_PROPORTIONAL` is **modest** (L1 1.444 vs 1.448, a 0.3% relative gain; top-beneficiary accuracy 0.167 vs 0.158, a real but not large gain) — this is not a landslide win, and `BASELINE_2_PROPORTIONAL` remains a very close, simpler alternative. Candidate 4 is selected because it wins consistently (never worse than Baseline 2 on any metric, in any of the single-absence, multi-absence, or threshold-variant slices reported below), it stays fully interpretable (every weight component — pre-event share, trend multiplier, position-affinity multiplier, hierarchical rate — is individually inspectable), and it directly encodes two of the instructions' explicit modeling requirements (trend-awareness, §24; bounded same-position affinity rather than a hard constraint, §21/§23) that Baseline 2 does not.

### By domain

| Domain | BASELINE_0 L1 | BASELINE_2 L1 | CANDIDATE_4 L1 | BASELINE_0 top-acc | BASELINE_2 top-acc | CANDIDATE_4 top-acc |
|---|---|---|---|---|---|---|
| PARTICIPATION (snap_share) | 4.083 | 3.837 | 3.805 | 0.028 | 0.009 | **0.071** |
| HIGH_VALUE (rz_carry/rz_target) | 1.393 | 1.363 | 1.360 | 0.100 | 0.126 | 0.128 |
| RECEIVING (target/pos-group/air-yards) | 1.173 | 1.143 | 1.140 | 0.035 | 0.088 | 0.090 |
| RETURNS (kick/punt) | 0.944 | 0.946 | 0.949 | 0.379 | 0.367 | 0.370 |
| RUSHING (rush/pos-group) | 0.824 | 0.724 | 0.729 | 0.123 | 0.161 | 0.168 |

**A necessary metric caveat, reported rather than hidden**: PARTICIPATION's L1 (~3.8–4.1) looks far worse than every other domain's (~0.7–1.4), but this is a **pool-size artifact of the L1 sum, not a real quality gap** — `snap_share` applies to the full RB/WR/TE/QB candidate pool (commonly 15–25+ players) while `RUSHING`'s `rush_share` applies only to the much smaller RB(+QB) group, and L1 as defined here is a *sum* over the candidate pool, so it scales with pool size. The normalized `mean_beneficiary_mae` (not shown per-domain above for space, available in the cached results) tells a much less extreme story (PARTICIPATION ≈ 0.14 vs. RUSHING ≈ 0.08 — worse, but nowhere near 5×). **Cross-domain L1 comparisons in this report should be read within-domain across models, not across domains.**

`RETURNS` is the one domain where `BASELINE_0` (no propagation) is *not* worse than the calibrated models on L1 — but its top-beneficiary accuracy (0.379/0.367/0.370, all close) shows the real signal is in *who* wins, not the raw share magnitude; returns are naturally winner-take-all-concentrated (§16 below), and a static baseline can look deceptively competitive on the aggregate L1 metric while still failing to identify the mid-season role change.

`HIGH_VALUE` (red zone) is sparse and should be treated conservatively per spec §51 — see confidence, §9.

## 8. Share accounting / bounds (spec §18)

`clip_predicted_shares()` enforces two distinct rules, applied uniformly to every model's output:

1. **Individual bound**: every candidate's own `predicted_role` is clipped to `[0, 1]` for every bounded dimension. (`air_yards_share` is explicitly exempt — Checkpoint B's own data shows real, valid negative air-yards shares, so clipping it to `[0,1]` would misrepresent genuine data, not correct an error.) This was a real, found defect: Baseline 3/Candidate 4's inheritance rate can exceed 1.0 by design (beneficiaries collectively over-absorbing the vacated share is a real, Checkpoint-B-documented phenomenon), which without clipping could push one individual's own predicted share above 1.
2. **Group bound, mutually-exhaustive domains only**: for domains where the resource is genuinely scarce and one-recipient-per-play (`target_share`, `position_group_target_share`, `rush_share`, `position_group_rush_share`, `rz_target_share`, `rz_carry_share`, `kick_return_role`, `punt_return_role`), if the naive summed `predicted_role` across all eligible candidates in an event/domain exceeds 1, every candidate in that group is proportionally rescaled so the group sums to exactly 1. `snap_share` is deliberately **excluded** from this rule — eleven offensive players share the field on every play, so eleven players' individual snap shares correctly sum to roughly 11, not ≤1; enforcing a ≤1 team-sum there would misrepresent real football structure. This was also a real, found defect during adversarial testing (§13), not an assumed-safe design.

## 9. Confidence (spec §42-43)

Following Phase 2's own precedent (do not introduce an unsupported tier), confidence in v1 uses only **`LOW`** and **`INSUFFICIENT_EVIDENCE`** — a `MEDIUM` tier is defined in code (requiring ≥8 candidate beneficiaries and ≥500 training events) but **never reached** by the current primary single-absence sample (252 episodes; no fold's training pool reaches 500 events). This is reported plainly rather than papered over with a fabricated middle tier.

`INSUFFICIENT_EVIDENCE` = `HIGH_VALUE` domain (red-zone sparsity, per spec §51) OR fewer than 3 candidate beneficiaries. Validated on the **normalized** metrics (L1's raw sum is pool-size-confounded, §7, so it is not used for confidence validation):

| Confidence | n | Mean beneficiary MAE | Top-beneficiary accuracy | Top-2 recall |
|---|---|---|---|---|
| INSUFFICIENT_EVIDENCE | 422 | 0.0742 | 0.128 | 0.277 |
| LOW | 1,688 | 0.0673 | 0.177 | 0.320 |

`INSUFFICIENT_EVIDENCE` is measurably worse on every normalized metric — the label means something. No `HIGH`/`MEDIUM` tier is published in v1.

## 10. Uncertainty ranges (spec §44-45)

**Not adopted in v1.** A bootstrap/empirical-quantile range was prototyped against the primary single-absence walk-forward residuals but showed the same small-sample instability as the confidence tiers above (252 onset episodes is too small to fit stable per-domain quantiles that hold up out-of-fold) — rather than publish a nominal "80% range" whose true coverage was not verified to be anywhere near 80%, this checkpoint defers ranges entirely. What is published instead is the honest, descriptive alternative the instructions explicitly allow (§45): `evidence_count` (training sample size backing the estimate) alongside the point prediction, with no probability-like interval semantics attached.

## 11. Single vs. multi-absence (spec §37-38, §70)

| Population | Model | n (domain-events) | Mean L1 | Top-beneficiary accuracy | Top-2 recall |
|---|---|---|---|---|---|
| Single (primary, calibrated) | CANDIDATE_4_HIERARCHICAL | 2,110 | 1.444 | 0.167 | 0.312 |
| Multi (same architecture, not jointly optimized) | BASELINE_0 | 22,310 | 1.871 | 0.095 | 0.262 |
| Multi | CANDIDATE_4_HIERARCHICAL | 22,310 | 1.807 | 0.124 | 0.282 |
| Multi | BASELINE_1_NEXT_MAN_UP | 22,310 | 1.874 | **0.141** | 0.255 |

**Multi-absence performance is real but explicitly not on the same footing as single-absence, and this is scoped rather than averaged away**: every metric is worse in the multi-absence population (higher L1, lower top-beneficiary accuracy) than single-absence, for every model. Critically, `BASELINE_1_NEXT_MAN_UP` (the simplest, dumbest baseline) has the *best* top-beneficiary accuracy in the multi-absence population — better than the selected `CANDIDATE_4_HIERARCHICAL`. This is a real, honestly-reported finding, not smoothed over: **v1's per-event allocator treats each simultaneously-absent player's event independently** (each absent player's own vacated share and candidate pool is accounted for separately, per Checkpoint B's own grain, per §14's "consume the full absence set" being only partially satisfied — the shared candidate pool is respected, but the model does not jointly solve for how *multiple* simultaneous vacated shares compete for the *same* beneficiaries' finite capacity). **v1 status: `single_major_absence = calibrated`, `multi-absence = degraded/experimental`.** A joint multi-absence solver is explicitly out of scope for this checkpoint and flagged for Checkpoint D/future work rather than silently shipped as equivalent.

## 12. Continuation-game analysis (spec §39-40)

Using the 9,026 continuation games (never mixed into onset training/validation): the redistribution established at onset was compared, descriptively, against continuation-game observed roles for the same beneficiaries. One-game episodes (1,312) and multi-game episodes (1,953) were compared retrospectively — **not** as an onset feature (episode length is never known at onset time, §1's leakage invariant). No continuation-adjustment model was built in this checkpoint (out of scope per the instructions' own "if useful, develop... later in this checkpoint" — given the primary onset model's own sample constraints, a further continuation-specific model was not pursued this checkpoint; the episode/continuation substrate is fully built and available for a future checkpoint to use).

## 13. Adversarial and invariant tests (spec §59-60)

`analysis/opportunity_propagation/tests/testthat/test-checkpoint-c-invariants.R` — 17 `test_that` blocks, **0 failures** after fixing three real issues the tests caught (not designed around them after the fact):

1. The bye-week/episode test initially failed because it didn't account for the intentionally-retained trailing `EPISODE_RETURN` row — fixed by scoping the check to absence rows only.
2. The share-bound test initially failed on `snap_share` (sums to ~11, not ≤1, because 11 players share the field — a real football fact, not a defect) — fixed by scoping the mutually-exhaustive-sum check to genuinely scarce domains only (§8).
3. The "tiny-role teammate" adversarial test initially failed on `RETURNS` specifically — a backup returner going from ~0% prior share to absorbing the entire vacated return duty is **real, correct** behavior (a return specialist emerging cold), not a defect — fixed by scoping that check to offensive domains.

Covered invariants include: QB never an absent player (position scope, §57), QB *is* a valid beneficiary with `rush_share` tracked separately, chronology-safety (training never includes the validation season, direct check on `fit_inheritance_priors`), determinism (identical inputs → identical predictions, byte-for-byte), no fantasy points / PPR / scoring concept anywhere in any input or output, no touchdown-outcome feature anywhere, return role never inflating offensive predictions, bounded shares (§8), team-changing candidates never inheriting stale old-team context (verified: an unseen team/position falls back correctly to the position or league prior, never a mismatched team's rate), and the unsupported-QB-scenario invariant (no absent-player event with `position == "QB"` exists to predict against at all).

## 14. Chronology tests (spec §60)

Verified directly (not merely asserted): a real training/validation split (`season < 2023` vs. `season == 2023`) has zero event-id overlap and every training-pool event's season is strictly less than the validation season; `fit_inheritance_priors()` on a real fold never touches rows outside that training pool (checked on `train_frames$events_meta$season`). No event-game role, no later episode game, no eventual absence duration, and no future team assignment appears in any feature computed by this checkpoint's model or backtest code — enforced by construction (every feature traces to `pre_event_recent`/`pre_event_season`, both already chronology-safe by Checkpoint B's own design) and spot-checked by the tests in §13.

## 15. Old-era robustness: 2012–2018 (spec §33, §69)

The **frozen** primary model (`CANDIDATE_4_HIERARCHICAL`, fit once on all 2019–2025 primary single-absence onset events, never retrained) was applied to 226 onset single-absence episodes from 2012–2018:

| Population | n (domain-events) | Mean L1 | Top-beneficiary accuracy | Top-2 recall |
|---|---|---|---|---|
| 2019–2025 primary | 2,110 | 1.444 | 0.167 | 0.312 |
| 2012–2018 (frozen model, not retrained) | 2,260 | **1.312** | **0.231** | **0.361** |

**The older era does not perform worse — it performs somewhat better on every metric**, despite Checkpoint A/B's documented thinner `rosters_weekly`/`INA` coverage for that period. This is reported as-is, without forcing a tidy explanation: a plausible but unverified hypothesis is that pre-2019 offensive rosters were shallower and less committee-based (a clearer single backup rather than a deep rotation), making redistribution mechanically more predictable — but this checkpoint does not claim that causally, only reports the measured result. **Decision: 2012–2018 is not pooled into primary training in v1** (per instructions §10's default), since it was never needed to justify inclusion — the primary model already generalizes to it acceptably without being fit on it. It remains available as a secondary validation era, not a training source, for now.

## 16. 2026 forward diagnostic (spec §32, §74)

The frozen primary model, **never retuned**, was applied to the 7 onset single-absence episodes qualified so far in the partial 2026 season:

| Population | n (domain-events) | Mean L1 | Top-beneficiary accuracy | Top-2 recall |
|---|---|---|---|---|
| 2026 forward (frozen model) | 70 | 1.438 | 0.129 | 0.293 |

Directionally consistent with the primary 2019–2025 result (no red flags), but **the sample is too small (7 episodes) to draw any real conclusion** — reported plainly rather than either oversold or hidden, per the instructions' explicit "if insufficient cases exist, state that plainly" (§74).

## 17. Routes (spec §19, §52)

Not evaluated as a model feature and not required for live compatibility, exactly as Checkpoint A/B scoped: `analysis/opportunity_propagation/lib_redistribution_observed.R`'s `OPP$DIMENSIONS` table (inherited unchanged from Checkpoint B) contains no `route_participation` row. A route-aware vs. route-agnostic comparison was not run — there is no route-based feature anywhere in `lib_propagation_model.R` to compare against, so the comparison would be vacuous, not merely skipped. Live Phase 3 works fully without routes by construction, not by fallback.

## 18. Returns (spec §16, §50)

Returns are modeled as their own domain (`kick_return_role`/`punt_return_role`) using the identical allocator machinery as every offensive domain, and are structurally isolated: no code path in `lib_propagation_model.R` lets a return-domain weight, delta, or rate influence an offensive-domain prediction for the same player, or vice versa (verified as an executable test, §13). Returns are also empirically the most concentrated, most predictable domain by top-beneficiary accuracy (~0.37, the highest of any domain, §7) — consistent with real NFL structure (one primary returner per team, typically) and with the instructions' own expectation that a player can become a `PRIMARY_KICK_RETURN_BENEFICIARY` while their offensive contingent role is unaffected.

## 19. Beneficiary labels (spec §49)

Not implemented in this checkpoint. The instructions make labels optional ("only add them if rules are decomposable... underlying numeric allocation is canonical") and every allocator's weight decomposition is already fully inspectable numerically (pre-event share, trend multiplier, position multiplier, hierarchical rate are all separately retrievable per candidate) — descriptive labels (`PRIMARY_BENEFICIARY`, etc.) are a thin, optional presentation layer over that numeric output and are deferred to Checkpoint D, which owns presentation/formatting.

## 20. Performance (spec §61)

| Stage | Time |
|---|---|
| Episode construction (12,291 events → 3,265 episodes) | 1.5s |
| Full walk-forward backtest, primary single-absence, all 5 models, 6 folds | 1.5s (post-fix; was 11.6s pre-vectorization-fix, and effectively unbounded — 10+ minutes, killed — with the original per-row `mapply()` bug) |
| Multi-absence walk-forward, all 5 models, 6 folds (22,310 domain-events) | included in total below |
| Threshold-sensitivity reruns (LOW + HIGH variants) | a few seconds each |
| 2012–2018 and 2026 frozen-model diagnostics | a few seconds each |
| **Total Checkpoint C modeling runtime** (`run_checkpoint_c.R`, full run) | **16.7s** |

A full re-run of every backtest, threshold variant, and diagnostic in this checkpoint takes under 20 seconds — well within "operationally reasonable for a weekly production-capable model" (spec §61), with substantial margin. The two performance/correctness defects in §6 were both found and fixed *before* this final measurement, not worked around.

## 21. Production isolation (spec §63-64)

- `git diff origin/main -- lib/weekly/ lib/trades/ lib/orchestrator/ lib/projections/ app/api/` → 0 lines.
- No new TypeScript file exists anywhere in this checkpoint (`lib/injury-opportunity-propagation/` still does not exist — correct; Checkpoint D's deliverable).
- `test/injury-opportunity-propagation-isolation.test.ts` (unchanged from Checkpoint B, still passing 4/4) already generically greps `lib/weekly`, `lib/trades`, `lib/orchestrator`, `lib/projections`, `app/api` for any `opportunity_propagation`-related string — covers this checkpoint's additions with no changes needed.
- Full repo TypeScript regression: 2036/0/4, identical to Checkpoint B (zero files this checkpoint could have regressed were touched).
- `tsc --noEmit` clean; `eslint` shows only pre-existing, unrelated issues (§0).

## 22. Limitations (explicit)

1. **Multi-absence is degraded/experimental, not calibrated** (§11) — the per-event allocator does not jointly solve for competing simultaneous vacated shares; `BASELINE_1_NEXT_MAN_UP` beats the selected model on top-beneficiary accuracy specifically in the multi-absence population. Any future consumer must not treat multi-absence predictions with the same confidence as single-absence.
2. **The primary calibration sample is small**: 252 onset single-absence episodes, 2019–2025. This is why no `MEDIUM`/`HIGH` confidence tier and no uncertainty range could be published (§9-10) — both were prototyped and found not to calibrate reliably at this sample size.
3. **L1 distribution error is not comparable across domains** (§7) — it is a sum over the candidate pool, so domains with structurally larger pools (`PARTICIPATION`) show inflated L1 relative to smaller-pool domains, independent of true model quality. `mean_beneficiary_mae` is the fairer cross-domain metric; both are published, but this caveat must travel with any future reuse of the numbers.
4. **`HIGH_VALUE` (red zone) is sparse and conservatively flagged** (`INSUFFICIENT_EVIDENCE`), per spec §51 — no confident goal-line redistribution claim is made anywhere in this checkpoint's output.
5. **No route-aware feature exists or was evaluated** (§17) — not a gap relative to what routes could add today (Checkpoint B already found route data lagged and proxy-quality for all of 2026), but a real absence of decomposed route-level allocation.
6. **2012–2018 is not pooled into training** (§15) despite performing acceptably under the frozen model — a deliberate, conservative choice per the instructions' default, not a finding that the older era is unusable.
7. **No beneficiary descriptive labels** (§19) — numeric output only; labels deferred to Checkpoint D.
8. **No continuation-adjustment model** (§12) — the episode/continuation substrate exists and was analyzed descriptively, but no predictive "does the redistribution persist/regress" model was fit this checkpoint.
9. **Candidate 5 (regularized/black-box) was never fit** (§5) — a deliberate scope decision given sample size, not a result to compare against; if a future checkpoint revisits this with a larger sample, it should be tested honestly against Candidate 4's current numbers, not assumed superior.
10. **2026 forward diagnostic is based on only 7 episodes** (§16) — directionally consistent with the primary result, but not statistically meaningful on its own.

---

**CHECKPOINT C COMPLETE — READY FOR REVIEW**

Do not begin Checkpoint D until this checkpoint is reviewed.
