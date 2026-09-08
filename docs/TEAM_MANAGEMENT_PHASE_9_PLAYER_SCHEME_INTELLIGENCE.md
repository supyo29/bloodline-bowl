# Team Management — Phase 9: Player × Scheme Interaction Intelligence

**Target version:** `player-scheme-intelligence-2026.1`
**Deployment lanes:** `SHARED_DESCRIPTIVE` (validated observable profiles) + `SHADOW_PREDICTIVE` (any predictive matchup effect, `numeric_fantasy_adjustment = 0`)
**Status:** **PART I COMPLETE — SOURCE AUDIT DONE, AWAITING SCOPE GATE**

This document has two parts, matching every prior Team Management phase:

- **Part I — Source audit + scope gate** (this section, complete). Inspects the
  actual installed schemas, declares the source-timeliness contract, seeds the
  feature registry, and proposes the build scope. **No calculations are
  certified and nothing is wired anywhere.**
- **Part II — Implementation + certification** (not started). Builds the R
  pipeline, the four typed output contracts, the additive read-only API
  surfaces, walk-forward validation, ablation, adversarial suite, the full
  Phase 1–8 regression, and ends with the Section 47 verdict.

---

## 0. Frozen-architecture preservation (spec §1, §44)

Phase 9 is **additive**. No semantics of Canonical League State, Team-State,
Football Intelligence, Start/Sit, Matchup Intelligence, Roster Health, Schedule
Planning, the Orchestrator, production lineup, waivers, trades, trade depth, or
trade ROS are modified.

New areas only:

| Area | Purpose |
| --- | --- |
| `analysis/player_scheme_intelligence/` | R analysis/training (reuses the Phase 3 nflverse raw cache — one fetch, identical sources) |
| `lib/player-scheme-intelligence/` | read-only TS contract + file-backed adapter (committed artifacts, Vercel-safe), imported nowhere in the production path |
| `outputs/player-scheme-intelligence-2026/` | published artifacts + audit JSON |
| `docs/TEAM_MANAGEMENT_PHASE_9_PLAYER_SCHEME_INTELLIGENCE.md` | this report |

Created in Part I: `config.R`, `source_audit.R` (+ its JSON artifact),
`feature_registry.yaml`, `schema.ts`, `read.ts` (returns `null` until Part II),
`index.ts`. `npx tsc --noEmit` is clean. No production file changed.

---

## 1. Source audit — as of 2026-09-08 (spec §2, §3)

Reproducible: `Rscript analysis/player_scheme_intelligence/source_audit.R` →
`outputs/player-scheme-intelligence-2026/source_audit.json`. Inspected the
**actual** Phase 3 cache (`analysis/football_intel/cache/*.rds`), not assumed
fields.

### 1.1 The critical timeliness fact

> **0 rows of any 2026 source are cached. The newest data in every source is
> the completed 2025 season. Today (2026 Week 1, pre-games) every Phase 9
> calculation is `PRIOR_ONLY` for 2026.**

A 2025 man/zone profile shown in September 2026 is **`PRIOR_ONLY`** and must be
labelled as such — never presented as a current 2026 observation (spec §3,
guardrail 2/31). Sources are re-stamped on every `source_audit.R` run.

### 1.2 Per-source contract

| Source | Fields Phase 9 needs | First season | Last available | Availability state | Live class | Update cadence |
| --- | --- | --- | --- | --- | --- | --- |
| **nflverse pbp** | `pass_location`, `pass_length`, `air_yards`, `yards_after_catch`, `run_location`, `run_gap`, `qb_dropback`, `qb_scramble`, `qb_hit`, `sack`, `epa`, `success`, `cpoe`, `xpass`, down/dist/yardline/`goal_to_go`, `wp`, `shotgun`, `no_huddle`, passer/receiver/rusher ids | 2012 | 2025-w22 | `HISTORICAL_CURRENT_THROUGH_2025` → `LIVE_CURRENT` once 2026 games play | **`LIVE_CAPABLE`** | ~24h post-game in-season |
| **nflverse participation** | `offense_formation`, `offense_personnel`, `defense_personnel`, `defenders_in_box`, `number_of_pass_rushers`, `time_to_throw`, `was_pressure`, `route`, `defense_man_zone_type`, `defense_coverage_type` | 2016 | 2025-w22 | `PRIOR_ONLY` for 2026 | **`PRIOR_ONLY_CURRENT_SEASON`** | historically heavy lag; **2026 in-season availability NOT guaranteed** |
| **nflverse FTN charting** | `starting_hash`, `qb_location`, `n_offense_backfield`, `n_defense_box`, `is_no_huddle`, `is_motion`, `is_play_action`, `is_screen_pass`, `is_rpo`, `is_trick_play`, `is_qb_out_of_pocket`, `is_interception_worthy`, `is_throw_away`, `read_thrown`, `is_catchable_ball`, `is_contested_ball`, `n_blitzers`, `n_pass_rushers`, `is_qb_fault_sack` | 2022 | 2025-w22 | `PRIOR_ONLY` for 2026 | **`PRIOR_ONLY_CURRENT_SEASON`** | weekly-ish historically; **2026 in-season cadence uncertain** |
| **nflverse NGS weekly** | `avg_time_to_throw`, `avg_intended_air_yards`, `avg_completed_air_yards`, `avg_air_yards_to_sticks`, `aggressiveness`, `expected_completion_percentage`, `completion_percentage_above_expectation` | 2016 | 2025-w23 | `HISTORICAL_CURRENT_THROUGH_2025` | **`LIVE_CAPABLE`** (weekly) | weekly, short lag |
| **nflverse PFR advanced weekly** | pass: `times_pressured/blitzed/hurried/hit/sacked`, `pocket_time`; rush: YBC/YAC; def: `def_targets`, `def_completions_allowed`, `def_yards_allowed`, `def_adot`, `def_times_blitzed`, `def_pressures` | 2018 | 2025-w22 | `HISTORICAL_CURRENT_THROUGH_2025` | **`LIVE_CAPABLE`** (weekly) | weekly, 1–3 day lag |

### 1.3 pbp spatial completeness (the backbone)

Measured on 2012–2025 REG:

| Field | Present | Notes |
| --- | --- | --- |
| `pass_location` (L/M/R) | 92.8% of pass attempts | remainder: throwaways, batted, penalties, spikes |
| `air_yards` | 93.1% of pass attempts | depth bins are derivable with **no charting dependency** |
| `yards_after_catch` | 100% of completions | |
| `run_location` (L/M/R) | 96.2% of rush attempts | direction splits are **strong** |
| `run_gap` (end/tackle/guard) | 70.2% of rush attempts | gap splits are **materially weaker** — evidence-gate harder |

League-wide `air_yards` depth distribution (candidate bins, spec §4):
BEHIND_LOS `<0` = **15.2%**, SHORT `0–9` = **51.5%**, INTERMEDIATE `10–19` =
**21.5%**, DEEP `20+` = **11.8%**. Cut-point sensitivity audit is a Part II
gate before the bins are frozen.

### 1.4 Charting completeness by season (participation, % of all plays)

| Season | man/zone | coverage family | route | formation | box | time-to-throw |
| --- | --- | --- | --- | --- | --- | --- |
| 2016–2017 | **0%** | 0% | ~38% | ~72% | ~74% | ~39% |
| 2018–2022 | ~38% | ~38% | ~37% | ~73% | ~74% | ~38% |
| 2023–2025 | ~49% | ~49% | ~42% | ~80% | **100%** | ~43% |

Consequences baked into the registry:
- man/zone & coverage family: `first_season = 2018`, charted on ≤ half of
  plays → **shrinkage mandatory**, micro-splits gated hard.
- `defenders_in_box`: usable pre-2023 but only fully populated from 2023.
- routes: ~40% coverage → per-route denominators (YPRR, target rate) only where
  trustworthy.

### 1.5 Coordinator / scheme-era identity (spec §20)

`analysis/football_intel/coordinators.yaml` currently has **`entries: []`**.
Reliable OC/DC identity is therefore **not available**. Per spec §20 this is
documented, not guessed: Phase 9 scheme-era handling collapses to
team-continuity + starting-QB-change + unit roster-turnover proxies (reusing
Phase 3's `lib_continuity.R` machinery), with a hard coordinator reset applied
**only** where a sourced `coordinators.yaml` entry exists.

---

## 2. Feature registry (spec §40)

`analysis/player_scheme_intelligence/feature_registry.yaml` — 20 feature
families recorded **before** any is built, each with `source`, `availability`,
`live_capable`, `observed_or_modeled`, `first_season`, `current_season_status`,
`sample_definition`, `numerically_predictive_eligible`, `description`.

Summary of `numerically_predictive_eligible`:

| Value | Families | Meaning |
| --- | --- | --- |
| `false` | 18 (all QB/WR/TE/RB/offense/defense descriptive profiles + archetypes + coordinator era) | **`SHARED_DESCRIPTIVE` only** — can never earn a production fantasy adjustment |
| `candidate` | 1 — `player_scheme_interaction_effect` | `SHADOW_ONLY` in 2026.1; promotion needs a **separate** certification meeting spec §35 |

Every descriptive family is `PRIOR_ONLY` for 2026 today; the pbp-backed ones
flip to `LIVE_CURRENT` as 2026 games are ingested, the participation/FTN-backed
ones stay `PRIOR_ONLY_CURRENT_SEASON` until (and unless) nflverse publishes
2026 participation/FTN in-season.

---

## 3. Output contracts (spec §32) — defined, not populated

`lib/player-scheme-intelligence/schema.ts` (tsc-clean):

| Type | Purpose |
| --- | --- |
| `QBSpatialProfile` | 12-cell depth×third matrix (visual-ready, spec §38) + directional tendencies + vs-league baselines + pressure/coverage/concept splits + stability |
| `PlayerTendencyProfile` | position-specific usage/efficiency for QB/RB/WR/TE — field-area matrix, route/coverage/box splits, always-shipped numeric archetype vector |
| `DefenseSchemeProfile` | pass/run D behavior + allowed-target `vulnerability_map` on the **same** depth×third grid + man/zone & coverage historical + pressure profile + scheme era |
| `PlayerSchemeInteraction` | residual-target interaction estimate with `direction`, `estimated_effect`, `uncertainty`, `sample_support`, `evidence_class`, `beyond_baseline`, `validation_status`, and `numeric_fantasy_adjustment` **hard-defaulted to 0** |

Each carries a `PsiSourceLineage` (source, availability state, live class,
`data_cutoff`, seasons used, as-of season/week, `prior_only_current_season`).
`explanation` strings are contractually required to map clause-by-clause to
structured fields (spec §34).

---

## 4. Proposed Part II build scope — **SCOPE GATE**

Following the established phase pattern (audit → **scope gate** → build →
SHADOW/SHARED, never wired → 0 production behavior change), Part II is proposed
in tiers so it can be approved incrementally:

### Tier A — Descriptive spatial profiles (pbp only, `LIVE_CAPABLE`)
- `qb_field_area_matrix`, `qb_directional_tendency` + vs-league baselines
- `receiver_field_area_profile`, `rb_rush_spatial_profile`
- `defense_spatial_vulnerability_map` (opponent-adjusted, chronology-safe)
- QB depth-bin **cut-point sensitivity audit** → freeze bins
- validation suites §41, §42; adversarial §43 cases 1–7, 13–20, 28–29
- R targets, artifacts, TS readers, `GET` API surface (spec §37)
- **Lane: `SHARED_DESCRIPTIVE`.** Highest value, lowest risk, all `LIVE_CAPABLE`.

### Tier B — Charting-dependent profiles (`PRIOR_ONLY_CURRENT_SEASON`)
- `qb_pressure_profile`, `qb_coverage_profile`, `receiver_route_profile`,
  `receiver_coverage_interaction`, `rb_box_interaction`, `qb_concept_profile`
- every output explicitly stamped `PRIOR_ONLY` for 2026
- adversarial §43 cases 8–12, 24–27, 30
- **Lane: `SHARED_DESCRIPTIVE`**, with a hard "not a current observation" banner.

### Tier C — Team offense/defense + archetypes
- `offense_team_profile`, `defense_scheme_profile`, `ol_dl_proxy_layer`
- `player_archetype_vector`, `defense_archetype_vector` (numeric vectors ship
  regardless of label stability)
- coordinator/scheme-era mechanism (documented-limitation form)

### Tier D — The interaction research model (`SHADOW_PREDICTIVE`)
- residual targets (spec §23), hierarchical shrinkage / ridge-interaction /
  empirical-Bayes bake-off (spec §25), opponent adjustment (§28),
  FDR control (§29), walk-forward (§30), **anti-double-counting vs the
  production baseline (§24)**, ablation
- adversarial §43 cases 21–23
- **Lane: `SHADOW_ONLY`, `numeric_fantasy_adjustment = 0`.** Expected outcome,
  by the Phase 4/5 precedent, is a **null or context-only finding** — that is a
  successful result, not a failure.

### Tier E — Certification
- full Phase 1–8 regression (`npm test`, Phase 1C cross-surface, frozen-surface
  byte-identity `f0bda54..HEAD`), latency/artifact-size budget, matchup
  explanation output (§34, §46), Section 47 verdict.

---

## 5. Open questions for the scope gate

1. **Approve the tiered Part II scope above?** (A→E, or a subset.)
2. **Live 2026 participation/FTN:** confirm the expectation that these remain
   unavailable in-season, so Tier B ships `PRIOR_ONLY`-only with no live path.
3. **Interaction model default:** confirm `SHADOW_ONLY` with hard
   `numeric_fantasy_adjustment = 0` for the entire phase (no promotion during
   Phase 9 implementation, spec §35).
4. **API namespace:** dedicated `app/api/player-scheme/...` vs extending
   `app/api/intelligence/...` (spec §37 says do not overload Phase 2
   management endpoints — a dedicated namespace is recommended).

---

## 6. Part I findings

| ID | Sev | Finding |
| --- | --- | --- |
| P9-I-1 | P2 | `coordinators.yaml` is empty → no reliable OC/DC identity. Scheme-era resets limited to sourced entries; documented per spec §20, not guessed. |
| P9-I-2 | P2 | participation man/zone + coverage charted on ≤ 49% of plays and only from 2018 → all coverage splits require shrinkage and hard micro-split gating. |
| P9-I-3 | P3 | `run_gap` present on only 70% of rushes vs 96% for `run_location` → gap-level RB splits get a stricter evidence threshold than direction-level. |
| P9-I-4 | P3 | 0 cached 2026 rows → Tier B/C/D profiles are `PRIOR_ONLY` at launch; the pipeline must re-stamp availability as the season progresses, never silently. |

No P0/P1.

---

## 7. Verdict

**PART I COMPLETE — PROCEED TO SCOPE GATE.**
No Section 47 verdict is issued until Part II implementation + validation +
regression are complete. Phase 9 is **not** wired into Orchestrator ACTION
generation or production projection adjustments, and will not be without a
separate integration/certification decision.
