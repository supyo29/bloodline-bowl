# Intelligence Modernization Phase 5 — Matchup Intelligence 2.0

Branch `intelligence-modernization-phase5-matchup-2`, based on `origin/main` @ `0b21f2f`. Checkpoints are committed as they complete; **nothing is merged or deployed** until certified and explicitly instructed.

Target question: *how does this specific offensive player/team profile interact with this specific opponent's defensive structure, tendencies and personnel in this game context?* — interaction, not opponent rank.

---

## 1. Starting state (recorded before any change)

| Item | Value |
|---|---|
| Local HEAD / `origin/main` | `0b21f2f1172d4d651a5ac610e795e1fb1884c2f7` (identical), working tree clean |
| Production | code `596f7c6` (`dpl_3EVi6bNxxxeSrJPTpZ1HzJ4xpAJe`), docs `0b21f2f`; health 200 |
| Football Intelligence | `fi:2026:w02:bfd77c9959a6` (week_state PARTIAL: 1 of 16 week-2 games completed at build time) |
| Role & Opportunity | `roi:2026:w01:819dc3166607` |
| Opportunity Propagation | `opi:2026:w01:bef17990fe91` |
| Player-Scheme | `psi:2025:w18:08123edd58c9` (`player-scheme-intelligence-2026.1`), tier content ids A `08123edd…`, B `5a10eac5…`, C `39d7b6d7…`, D `37bd7bc3…`; every family `PRIOR_ONLY` for 2026 (data through 2025 w18) |
| Start/Sit | `ri-startsit-2026.1`, SHADOW_ONLY |
| Waiver Intelligence 2.0 | SHADOW_ONLY, lifecycle unchanged |
| Scoring fingerprints | `scoring:v1:29acc6bcd911df090b5b9b9c` (Bloodline Bowl), `scoring:v1:d4795fa723cdd12d9ba3bfb1` (Devoted, Sporty's) |
| Book-Ready registry | `intelligence-surface-registry-2026.3`, contract `book-ready-evidence-2026.1` |
| Analysis Book | contract `analysis-book-2026.1`, taxonomy `analysis-taxonomy-2026.2`, planner rules `analysis-planner-rules-2026.1` |
| Existing matchup routes | `/api/matchup/[league]/...`, `/api/matchups`, `/api/player-scheme/matchups`, `/api/evidence?topic=matchup.shadow` |
| Existing matchup lifecycle | `matchup-intelligence-2026.1`: `SHADOW_ONLY` (`lib/weekly/matchup-intelligence/deployment.ts`) |
| Production parity baseline | Section hashes (lineup, start_sit, waivers, matchup, matchup_leverage, positional_needs) recorded for 4 league/manager pairs, stable across two reads (kept in the certification appendix) |

## 2. Forensic audit of existing "matchup" intelligence (Checkpoint A)

The word "matchup" names **four different things** in this repository. None models how a player's role meets a defense's structure.

### 2.1 What exists

| Surface | Path | What it models | Deployment | Consumers |
|---|---|---|---|---|
| **Production matchup** `buildMatchup` | `lib/weekly/matchup.ts` (459 lines) | *Fantasy head-to-head*: each fantasy team's best legal lineup, projected margin, Monte-Carlo win probability from independent left-censored normals, positional advantages, swing players | ACTIVE (informational; win probability feeds no recommendation, per its own audit) | `/api/matchup`, weekly intelligence, `buildLeverage` (uses margin, not win probability), Orchestrator conditions |
| **Matchup Intelligence v1** | `lib/weekly/matchup-intelligence/*` (9 files, 1,582 lines), model `analysis/football_intel_matchup/` | Calibrated *fantasy lineup score distributions*, win probability, a degradation/confidence vector, scenario explanations; a 2-factor dependence kept as diagnostic only | SHADOW_ONLY (`matchup-intelligence-2026.1`); never influences production | `/api/evidence` `matchup.shadow`, freshness/readiness modules, Orchestrator |
| **FI contextual matchup** | `lib/football-intel/read.ts` `contextualMatchup`, `contextual_matchup_feature.csv` (6,048 rows) | *Team-level* pair signals for 32×31 offense/defense pairs: pass EPA vs pass defense, rush vs rush, pressure allowed vs generated, explosive vs prevention, PROE/pace vs funnel, red-zone; plus `receiving_usage_vs_coverage_{RB,WR,TE}` (defense-only: EPA allowed to that position group) | MODELED, predictive status routed per component (`off:PREDICTIVE\|def:NOT_PREDICTIVE` etc.); confidence mostly LOW/INSUFFICIENT_SAMPLE at week 2 | Start/Sit FI shadow translation (opponent defense rating), Book-Ready `fi.team_metric`, Waiver 2.0 (opponent readings) |
| **Player-Scheme** (Phase 9) | `lib/player-scheme-intelligence/*`, `buildMatchupAlignment` | *Descriptive* tendency overlap: player target-area shares × defense allowed-EPA by depth×third (12 cells), man/zone, coverage families, pressure, box, run gap/direction, route/coverage charting, QB spatial; **Tier D research**: 7 (position×family) interaction tests | Tiers A–C `SHARED_DESCRIPTIVE`; Tier D `SHADOW_ONLY`, `numeric_fantasy_adjustment = 0` | `/api/player-scheme/*`, Book-Ready `scheme.*` |

### 2.2 What existing Matchup Intelligence actually claims to know
- **Production `buildMatchup` and v1 know nothing about defensive structure.** They take *projected fantasy points* for two lineups and turn them into margins/distributions. A defense influences them only through whatever the upstream projection already contains. The lineup-level uncertainty model is generic (position CV heuristics in production; calibrated in v1).
- **FI** knows opponent-adjusted *team-level* offense/defense ratings and how strongly each is validated. Its "matchup" is a team-pair product of two ratings. It does not know which player is affected.
- **Player-Scheme** knows *observed tendencies* of individual players and defenses on a common spatial grid and, for man/zone, coverage family, pressure and box, from participation charting — but it is `PRIOR_ONLY` in 2026 (through 2025 w18) and its only "interaction" is a descriptive overlap score that explicitly "does not account for role, opponent strength, or the production projection baseline".
- **Tier D established a clean null** (Phase 9): for the 7 tested (position × family) pairs against a *production-like baseline* (self form + opponent-position strength), walk-forward 2022–2025: 5 `EXPLANATORY_ONLY` (would beat a naive baseline but not the production-like one; delta MAE vs production-like baseline ∈ [−0.0033, +0.0074] fantasy points, FDR reject = false everywhere), 2 `REJECTED` (te_spatial, rb_box), **0 `PREDICTIVE_INCREMENTAL`**.

### 2.3 Useful components, duplication, proxies, gaps
- **Reusable as-is:** FI team profiles/percentiles and predictive-status routing; Player-Scheme defense/receiver/RB/QB profiles and evidence classes; Role profiles (target share, route participation, RZ/GL shares, snap share); the schedule frontier; Book-Ready/Analysis Book plumbing; the Phase 9 chronology-safe R harness (`lib_interaction.R`).
- **Duplicated FI logic (not to be re-derived):** opponent-adjusted team ratings, pressure/blitz/explosive team rates. Phase 5 consumes them.
- **Generic opponent-strength proxies in use:** Start/Sit FI translation reads a defense rating for the opponent (rank-like); Waiver 2.0 reads defense percentile readings; FI's `receiving_usage_vs_coverage_*` is a group-level EPA allowed. These are exactly the "how good is this defense" answers Phase 5 must not be mistaken for.
- **Descriptive evidence that already touches numeric scoring:** none found that alters a production number; FI's routed predictive status is what allows some team ratings into Start/Sit *shadow*. Phase 5 must preserve this separation.
- **Unavailable desired features (verified against the repository's data):** receiver alignment (slot/perimeter/inline), cornerback assignments/shadowing, defensive front alignment (4-3/3-4/odd/even), personnel groupings (offense 11/12/21 vs defense base/nickel/dime), coordinator identity by week (only `coordinator_known` + `scheme_reset_hint` per season), per-game player targets against specific coverage in the *current* season, game-script splits, individual LB/S coverage responsibility, player-level offensive-line pass-block grades. Each stays UNSUPPORTED with a stated reason.
- **Chronology risks:** all Player-Scheme charting is season-aggregated through 2025 w18 — safe for 2026 live use (strictly prior data), but the *career/recent windows include the same season's later weeks* for any historic-season row and are therefore RETROSPECTIVE_ONLY unless rebuilt as-of (the Tier D harness rebuilds as-of by construction). FI 2026 is through week 2 and PARTIAL. Participation-derived fields (man/zone, coverage family, pressure, box) lag in-season and are not guaranteed in 2026.
- **Stale semantics:** FI `through_week 2` with only 1 of 16 week-2 games complete at build time — mixed vintage must be shown, not blended.

## 3. Deployment strategy
Any numeric matchup adjustment begins `SHADOW_ONLY` under the existing Matchup lifecycle vocabulary. **Phase 5 v1 introduces no fitted numeric adjustment** (§6): the Phase 9 clean null means there is no evidence-supported weight, and the task forbids assigning arbitrary weights. Production matchup behaviour is untouched; `numeric_adjustment` is `null` on every Matchup 2.0 output, with the reason stated.

## 4. Phase 5 specification (Checkpoints B–H)

**Objects.** `MatchupEvaluation` per (offense subject × defense subject × game): player-vs-defense (QB/RB/WR/TE), team offense-vs-defense, and its sub-families (receiver-role-vs-coverage, OL-vs-front is *team/unit level only*). Position-specific families, not one score.

**Evidence origin taxonomy (every component carries exactly one):** `OBSERVED_DEFENSIVE_TENDENCY`, `OBSERVED_PLAYER_PROFILE`, `MODELED_GAME_EXPECTATION`, `DESCRIPTIVE_CONTEXT`, `UNSUPPORTED`. A defense's historical man rate is observed; "expected coverage this week" is only ever the defense's baseline labelled MODELED (no game-specific input exists to condition on, and that is stated).

**Feature classes (registry, every family):** reconstruction class `TRUE_AS_OF | RECONSTRUCTABLE_AS_OF | RETROSPECTIVE_ONLY | UNSAFE_FOR_BACKTEST`, predictive class `PREDICTIVE_CANDIDATE_UNVALIDATED | DESCRIPTIVE_CONTEXT | UNSUPPORTED`, live availability, whether it may enter fitted claims. Unsafe features stay in live descriptive analysis but are excluded from any fitted claim.

**Evaluation targets (fixed before any fitting).** Baseline = the *production-like pregame baseline* defined in Tier D (`fp ~ self-form + opponent-position-allowed`), the same baseline against which Phase 9 tested — never a different one. Target = fantasy-point residual versus that baseline. Primary measures: ΔMAE vs baseline, directional win rate, points gained/lost when the adjustment is material, large-win/large-loss rate, calibration by adjustment magnitude and position, by-season stability, ablations; MAE/RMSE secondary. Walk-forward, as-of, BH false-discovery control (existing harness).

**Shadow/deployment plan.** No numeric composite is shipped. Structured evidence (advantages/disadvantages/neutral factors, scenario sensitivity, uncertainty) is `SHARED_DESCRIPTIVE`; prospective pre-game captures accumulate for a future validation with pre-declared minimum samples.

**Book-Ready integration map (existing stable chapter ids only).** `matchup.coverage_interaction`, `matchup.pressure_protection`, `matchup.red_zone_defense`, `defense.run_fits`, `game.offense_vs_defense.rush`, `game.fronts` (box only — front *alignment* stays unsupported), `game.line_play` gain Matchup 2.0 evidence needs. `matchup.cornerback_assignment`, `defense.slot_boundary`, `why.alignment`, `defense.personnel`, `team.game_script` remain UNSUPPORTED.


---

# Certification record (Checkpoints B–H)

Branch commits: A `docs`, B context, C/D/E families + engine, F Book-Ready + Analysis Book, G evaluation + capture, H adversarial + live certification. Drift checked (`git fetch`, 0 commits behind `origin/main`) after every checkpoint.

## 3. Matchup definition and objects
`MatchupEvaluation` (`lib/matchup2/contract.ts`): offense subject × defense subject × game; ordered `components[]` (each with origin, history class, predictive class, direction, value + unit, `z` and `rank_among_defenses`, evidence tier, window, raw `inputs`, scenario `sensitivity`, `uncertainty`, `limitations`); `advantages` / `disadvantages` / `neutral_factors` / `undetermined`; a **descriptive** `structural_verdict` (FAVORABLE / UNFAVORABLE / MIXED / NEUTRAL / INSUFFICIENT_EVIDENCE — a summary of directions, not a score); the **generic** defense reading reported separately with `player_specific_vs_generic` (AGREE / DISAGREE / NOT_COMPARABLE); `unsupported[]`; merged `uncertainty[]`; source `vintage[]`; `lineage`; deterministic `content_identity`. Objects: player-vs-defense (QB/RB/WR/TE), team offense-vs-defense (`evaluateTeam`, with the canonical `DefenseProfile`), receiver-role-vs-coverage (man/zone, area, route-family profile). OL-vs-front exists at TEAM level only (§14).

## 4. Architecture
`source.ts` (interfaces) → `source-files.ts` (certified readers: Player-Scheme, Football Intelligence, Role) → `context.ts` (league context of all 32 defenses built **once** and memoized per source; per-game context with deterministic identity) → `families.ts` (position-aware components) → `engine.ts` (player + team evaluation) → `defense.ts` (defensive profile) → Book-Ready family + `/api/evidence` topics. Read-only, no recomputation of any upstream model. Player-specificity mechanism: every component is computed for **this** defense and for **all 32** using the same player profile, so `z`/`rank` state how extreme this defense is *for this player*; a directional label additionally requires the value to clear a declared materiality floor in the family's own unit (`thresholds.ts`, non-fitted), because z alone cannot say whether the player is sensitive to the dimension (found and fixed during Checkpoint E: a QB with a 0.01 EPA pressure split had the same z ordering as one with a 0.8 split).

## 5–6. Coverage model and shells
Observed tendency: man/zone rate with league rank among 32, evidence tier from charted-play counts. Coverage-family buckets are **source-native** (`cover_0/1/2/3/4/6`, `two_man`) and are never blended or renamed. Only one shell source exists, so `source_conflict` is `null` (no conflicting source to expose). Expected game coverage is a separate component `coverage.game_expectation`, `MODELED_GAME_EXPECTATION`, equal to the defense's baseline because **no game-specific conditioning input exists** (offensive formation/personnel, opposing QB, alignment, coordinator tendency are all unavailable) — flagged `BASELINE_ONLY_EXPECTATION/HIGH`, direction always UNDETERMINED, excluded from the verdict and from captured decision evidence.

## 7–8. Alignment and receiver interaction
There is **no receiver-alignment data** (slot/perimeter/inline/backfield/left-right). Target *location* (depth × field third) is not alignment and is labelled as such. Receiver interaction uses what exists: man/zone splits (participation-charted) and the 12-cell target matrix. `defense.slot_boundary` and `why.alignment` stay UNSUPPORTED.

## 9–11. Routes, areas, explosives
`area.pass` = share-weighted difference between the defense and a league-average defense over the **player's own volume cells** (cell-level league means; both sides must be ≥ WEAK evidence and cover ≥ 50% of the player's volume). `explosive.area` is the same construction on explosive rate (pass ≥ 16 yd, rush ≥ 12 yd) and is deliberately separate from volume: the defense profile exposes concession by depth (target share, EPA, explosive rate vs league) so "concedes underneath volume while preventing deep explosives" is a first-class finding (tested with a fixture and visible on real defenses). Route families are **player-side only** (targeted-route shares); no defense-side route-allowed table exists, so the route interaction is not computed (direction UNDETERMINED by design).

## 12–13. Pressure and QB response
`qb.pressure.response` = (defense pressure rate − league) × (QB EPA pressured − EPA clean), with the QB's sack rate, time to throw and air yards clean-vs-pressured exposed; `qb.pressure.rusher_count` uses the 5+ rusher proxy; `team.pressure.line` combines FI's offensive pressure-allowed and defensive pressure-generated ratings (team/unit level, each side's FI predictive status shown). Causality is not claimed (pressure rate reflects the opposing QB); no split is invented where none exists.

## 14–16. Run fronts, offensive run profile, trenches
Supported granularity, exactly: run **direction** LEFT/MIDDLE/RIGHT (from `run_location` — **not** "inside/outside"), run **gap** END/TACKLE/GUARD, and **box** (heavy/light/neutral, defenders in box). The RB's own direction/gap/box usage meets the defense's concession on the same axes (player usage, never team tendency as a substitute). Unsupported and stated: front alignment, zone/gap/power/counter, short-yardage and goal-line splits, yards before contact, line yards, player-level OL/DL evidence. Trench interaction exists at team level only.

## 17. Linebacker / safety
Unit-level FI `coverage_allowed_epa_{RB,WR,TE}` only, labelled `GENERIC_PROXY_ONLY`; UNVALIDATED; INSUFFICIENT_SAMPLE at week 2 so it is UNDETERMINED for real players today. No named-defender coverage claim exists anywhere.

## 18 (task 18). Cornerback assignments — limitations
The system knows nothing about who covers whom: no shadow/side/slot-CB/travel/injury-replacement data exists, and a depth chart does not establish assignment. `matchup.cornerback_assignment` stays **UNSUPPORTED**; every player summary carries an explicit `unsupported.cornerback_assignment` block; a test asserts no component id mentions cornerback or slot.

## 19–20. Personnel and formation
Not supported on either side (no offensive or defensive personnel-grouping data; QB formation buckets such as `UNDER CENTER` exist in Player-Scheme but are not personnel and are not mapped). `defense.personnel` stays UNSUPPORTED; raw formation labels are untouched.

## 21–22. Red zone and game script
`scoring.red_zone` shows the player's red-zone role next to the defense's FI red-zone TD-rate-allowed rating; it is neutral unless the role is material, derives no touchdown expectation, and never uses last week's touchdowns. Game-script probabilities do not exist (no spreads/totals feed), so **no script is asserted**; scenario sensitivity is exposed for coverage mix, pressure rate and box rate (±1 SD counterfactuals labelled as such). `team.game_script` stays UNSUPPORTED.

## 23. Injuries and personnel absence
Availability enters only as known state: `evaluatePlayer(…, {injury_status})` adds `PLAYER_INJURY_STATE` uncertainty (HIGH for Out/IR/Doubtful/…, MEDIUM otherwise) and changes the content identity, but never changes a component value, predicts an injury, or redistributes opportunity — conditional redistribution belongs to Opportunity Propagation and applies only when availability establishes the condition.

## 24–25. Coach/scheme continuity and historical matchups
Coordinator identity by week is not served (only per-season `coordinator_known` and `scheme_reset_hint`); a reset hint adds `SCHEME_RESET_HINT` uncertainty on either side and a starting-QB change adds `QB_CHANGE`. Player-vs-coach/defense history is **UNSUPPORTED** (`unsupported.coach_history`, registry family `history.player_vs_defense` = UNSAFE_FOR_BACKTEST): no per-game role/scheme-at-the-time store exists, so any historical head-to-head would leak later seasons. Nothing implies a two-game sample is predictive.

## 26–27. Feature classification and composite model
Every family is classified in `registry.ts` (origin, availability, history class, predictive class, fit eligibility); families that cannot be rebuilt as-of are `fit_eligible: false`, and descriptive/unsupported families are never predictive candidates. **No composite adjustment exists.** Reason (also on every output): Phase 9 Tier D found 0 PREDICTIVE_INCREMENTAL among 7 families and the Phase 5 study (below) found 0 among 6 more; assigning weights without an evaluation target and a beating result is prohibited. `matchup2.player.summary` carries an explicit UNAVAILABLE `composite_adjustment` block stating this. Raw components remain available regardless.

## 28–29. Chronology and evaluation
Suite defined before fitting (script header): baseline = Tier D Baseline 1 (self-form expanding mean shifted one game + league-centred opponent-position-allowed, reconstructable production-like); target = fantasy-point residual vs that baseline; profiles for season S use seasons ≤ S−1; coefficients train on seasons < S; test seasons 2022–2025; paired t-test, BH-FDR (α 0.10, across the 6 new hypotheses), sign stability across folds, calibration quintiles, and decision-style measures on the top decile of |shift|. **Same baseline for tuning and reporting** — nothing was tuned.

| Family (new, Phase 5) | n | ΔMAE vs naive | ΔMAE vs production-like baseline | p | Class |
|---|---|---|---|---|---|
| wr_man_zone | 5,275 | +0.097 | +0.0001 | 0.465 | EXPLANATORY_ONLY |
| te_man_zone | 2,016 | +0.091 | −0.0019 | 0.965 | REJECTED |
| rb_man_zone_receiving | 1,783 | +0.240 | −0.0090 | 0.773 | EXPLANATORY_ONLY |
| wr_explosive_area | 6,097 | +0.065 | +0.0020 | 0.030 | EXPLANATORY_ONLY (fails FDR) |
| te_explosive_area | 2,830 | +0.002 | +0.0003 | 0.412 | REJECTED |
| rb_run_gap | 3,857 | +0.074 | −0.0010 | 0.630 | EXPLANATORY_ONLY |

Together with Tier D (qb_spatial, qb_coverage, qb_pressure, wr_spatial, te_spatial, rb_direction, rb_box) that is 13 families, **0 predictive-incremental**; every ΔMAE vs the production-like baseline is within ±0.01 fantasy points. Decision-style measures (top-decile shifts): directional win rates 0.45–0.56, mean points gained −0.02…+0.07, large win/loss rates 0 — no useful discrimination. A null result is a successful research outcome; the families remain valuable as **explanatory context**, and their components are classed `EVALUATED_NO_INCREMENTAL_VALUE`, each stating its own result in its limitations.

**Chronology adversarial test (R):** every epa/explosive value of season ≥ 2024 was reversed/flipped in all four input frames; the season-2024 features were identical (`future_mutation_invariance: true`). TypeScript side: only the prior-season aggregate windows (`recent`, `career`) are admissible — rows under any other window label are ignored (tested); evidence is a pure function of the supplied artifacts. **Caveat (stated, not hidden):** the baseline is a reconstructable production-like estimate, not the historical production projection (whose provenance is untrustworthy 2019–2025), so a *future* validation must be re-run against the actual production baseline captured prospectively (§26).

## 26. Prospective evidence
Historical per-week matchup state was never preserved, so capture goes forward (`lib/matchup2/capture.ts`, table `bridge_matchup2_shadow_captures` + outcomes, migration `20260921120000` **validated locally with PGlite — not applied to production**). Classes are derived: `LIVE_CAPTURED` needs a server-derived baseline projection *and* the player's own game verifiably `pre_game` in a schedule read at decision time; `LIVE_POST_LOCK`; `LIVE_UNVERIFIED`; `HISTORICALLY_RECONSTRUCTED` (never counts); `ILLUSTRATIVE` (never built or persisted). Identity = the decision context (player, opponent, week, versions, scoring fingerprint, baseline, components, lock verdict) and **excludes** read times, provenance and request ids. The only writer is the auth-gated scheduled job `/api/cron/matchup2-capture` (daily 14:15 UTC, **not enabled until deployed**): public evidence requests carry no baseline and have no write path (an import-graph test proves the cron route is the only caller). Gate (fixed before any data): minimum 8 live weeks / 300 eligible decisions / 100 players / all 4 positions; preferred 14 / 1,500 / 250 / 4; **one decision per (player, season, week, scoring fingerprint)** so correlated daily captures cannot inflate counts; every eligible record also needs an attached outcome; meeting a threshold makes the sample reviewable by a human only and never changes the lifecycle. Dry run of the real scheduled function (in-memory store, no database write): 3 leagues, 291 records, 160 players (WR 117, RB 90, QB 42, TE 42), **21 `LIVE_CAPTURED` + 270 `LIVE_POST_LOCK`** (Monday-night games were still pre-game, everything else already played), 4 s; an immediate second run produced 291 `DUPLICATE_IDENTICAL`; gate `NOT_ELIGIBLE` (no outcomes yet).

## 27. Book-Ready
Ten topics on surface `matchup-intelligence-2` (registry capability PARTIAL by design): `matchup2.player.{coverage, pass_area, pressure, run, scoring, summary}` (required `gsis_id`; opponent derived from the schedule unless `opponent` is given) and `matchup2.defense.{coverage, front, pressure, explosive}` (required `team`; league-rank comparison against `NFL_DEFENSES`). Every block is a shared EvidenceBlock: shadow deployment, analysis class DESCRIPTIVE / MODELED / UNAVAILABLE / UNSUPPORTED (never SHADOW_PREDICTIVE), sample-support tier, structured uncertainty, lineage (context identity + source vintages), explicit units (`matchup2.epa_target`, `epa_play`, `epa_rush`, `rate_delta`, `z`, `rank`, …). The summary emits unsupported items and the composite as explicit UNAVAILABLE blocks. Capabilities (`/api/evidence?capabilities=1`) expose the `matchup2` block (lifecycle, `numeric_adjustment: null`, capture health).

## 28. Analysis Book
Chapter ids unchanged (no taxonomy or planner-rule version change). `matchup.coverage_interaction` no longer depends on the unsupported `receiver_scheme_profile` capability (requires `matchup2.player.coverage`, enriches with the summary): PARTIAL → **SOURCE_LAG** (Player-Scheme is prior-season only — an honest reason, not a missing need); `defense.run_fits` UNSUPPORTED → **PARTIAL** (`matchup2.defense.front` flagged `PROVIDER_LIMIT_PARTIAL`: direction/gap/box only); `matchup.pressure_protection`, `matchup.red_zone_defense`, `defense.explosive_prevention`, `defense.coverage/man_zone/shell/pressure`, `game.pressure`, `game.offense_vs_defense.rush` gain enrichment. Remaining UNSUPPORTED (verified by test): `matchup.cornerback_assignment`, `defense.slot_boundary`, `why.alignment`, `defense.personnel`, `defense.front`, `game.fronts`, `team.game_script`. The single surface registry gained `matchup-intelligence-2` and consumer entries on the three upstream surfaces; no second registry.

## 29. Performance
Real data (321 players × 32 defenses = 9,951 pairs): **5.6 ms/pair**; warm single-player evaluation **7.4 ms**; a full team (10 players against one defense context, built once) **61 ms**; Book-Ready `matchup2.player.summary` 145 ms cold / 22 blocks / 66 KB, `player.coverage` 34 ms / 12 KB, `defense.front` 5 ms / 26 KB. A pre-existing cost was found and fixed: every Player-Scheme reader call re-parsed its CSV (270 ms per player); a per-file mtime-keyed parse cache (performance only, behaviour unchanged, 42 existing Player-Scheme tests pass) makes resolution 9 ms and the full scheduled capture 3–4 s instead of 80 s.

## 30. Production isolation and parity
Import graph (tested): only the Book-Ready adapter layer and the persistence capture path import `lib/matchup2`; nothing in `lib/weekly` (including production `matchup.ts` and Matchup Intelligence v1), canonical, orchestrator, trades, Waiver 2.0, team-state, roster-health, schedule-planning or providers does; the substrate performs no I/O beyond reading served artifacts and depends on no consumer. Production parity: baseline (`0b21f2f` worktree) vs this branch, **interleaved twice per pair, three league/manager pairs, all six sections — lineup, start_sit, waivers, matchup, matchup_leverage, positional_needs hashes identical in every run** (upstream Sleeper drift affected neither side because both ran against the same live state). Trade and scoring engines are untouched. Additive edits to shared modules: two exports/behaviour-preserving changes in `lib/player-scheme-intelligence/read.ts` (a run-gap reader and the CSV cache), registry/units/query registrations, `vercel.json` cron entry.

## 31. Tests
Full suite: **2,432 tests, 2,428 pass, 0 fail, 4 skipped** (previous 2,384). 48 new: `matchup2-context` (4: determinism, registry classification, team codes, production isolation), `-engine` (16: coverage, pressure, run, unit coverage, explosives vs volume, evidence honesty, unsupported, observed-vs-modeled, descriptive separation, uncertainty, determinism/reuse, team/profile), `-bookready` (8, including live `/api/evidence` on real players and defenses), `-evaluation` (5: evidence, derived predictive class, chronology ×3), `-capture` (7: lock, classes, identity, dedupe ×10 variants, eligibility/gate, stores, cron auth + single-writer), `-adversarial` (8). One existing Analysis Book expectation was updated because the intended state changed (`matchup.coverage_interaction` PARTIAL → SOURCE_LAG); no frozen test was weakened. `tsc` clean; eslint clean for all changed files. The R evaluation ran (`analysis/matchup2/evaluate_phase5.R`, ~2 min); no existing R/model file changed.

## 32. Limitations (explicit)
No numeric matchup adjustment exists, by evidence. No cornerback assignment, receiver alignment, front alignment, personnel, run-scheme, short-yardage/goal-line, defender-level coverage, game-script probability, coach history or in-season 2026 charting. All Player-Scheme evidence is prior-season only (through 2025 w18) and FI is week 2 PARTIAL (mixed vintage shown, never blended). Unit coverage is INSUFFICIENT_SAMPLE at week 2 for real players. Team codes in the Player-Scheme directory differ from FI's and are normalized (KCC→KC, …); the directory is a 2025 roster and Role supplies the 2026 team when available. The evaluation baseline is production-like, not the historical production projection. Two requested real-example categories had no qualifying real case today (a QB neutral despite an extreme pressure z; a receiving RB with usable unit-coverage evidence) — covered by synthetic tests only, and reported as such. The market/NFL week 2 games were already played when certification ran, so the dry-run captures are mostly `LIVE_POST_LOCK`.

## 33. Future dependencies (Phase 6/7)
Chronology-safe **player-team temporal identity** (Phase 7 in the Book-Ready contract) is required before any per-game historical matchup evidence; per-week snapshots of Player-Scheme/FI/Role (the immutable history store) become the substrate for re-running this evaluation against the *actual* production baseline; alignment/assignment/personnel data would need a new source; the prospective capture needs ≥ 8 live weeks and outcome attachment (a separate, not-yet-built step) before the gate can even be evaluated.

## 34. Certification verdict
Gates: **Player specificity** PASS (role- and cell-level inputs; opposite readings for two roles against one defense, 25.8% of 3,339 comparable real pairs disagree with the generic defense reading). **Structural interaction** PASS (generic quality is reported separately and never determines the result). **Position specificity** PASS (tested component sets). **Evidence honesty** PASS (origin labels; modeled expectation baseline-only and excluded; descriptive families never predictive). **Source honesty** PASS (CB assignment, alignment, front, personnel, coach history explicit UNSUPPORTED). **Chronology** PASS (future-mutation invariance proven; only prior-season windows admissible). **Baseline integrity** PASS (one baseline for definition and reporting; no fitted adjustment). **Book-Ready** PASS. **Analysis Book** PASS (existing ids; honest upgrades; unsupported chapters stay unsupported). **Shadow safety** PASS (no production import; parity identical; lifecycle SHADOW_ONLY).

**Verdict: CERTIFIED WITH DOCUMENTED LIMITATIONS.** Matchup Intelligence 2.0 is a certified *evidence* layer, not a predictive model: it structures how a player's role meets a defense's structure, exposes what is unknown, and begins prospective evidence collection — but the walk-forward evidence shows none of the tested interaction families adds predictive value beyond a production-like baseline, so it ships without a numeric adjustment. Not merged, not deployed; the capture migration is unapplied and the cron is not enabled. Phase 6 not started.
