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

*Sections 3–34 of the requested outline are completed below as each checkpoint lands.*
