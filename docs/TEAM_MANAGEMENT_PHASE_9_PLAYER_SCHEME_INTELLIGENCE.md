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

---

# Part II — Implementation

Scope approved: **all tiers A→E**, with mandatory internal certification gates
(A → certify → B → C → certify descriptive system → D → deep predictive audit →
E). No re-approval between successful tiers; checkpoint reports after A / C / D / E.
Tier D stays `SHADOW_ONLY` with `numeric_fantasy_adjustment ≡ 0` for the whole
phase. API: dedicated `app/api/player-scheme/*`.

## Tier A — PBP-only spatial descriptive profiles ✅ COMPLETE

**Lane:** `SHARED_DESCRIPTIVE`. **Availability:** `LIVE_CAPABLE` (nflverse pbp
only — no participation / FTN / NGS). Commit `c2bd382`.

### Files added
| File | Role |
| --- | --- |
| `analysis/player_scheme_intelligence/lib_spatial.R` | play-level normalized pass/rush datasets + all profile builders |
| `analysis/player_scheme_intelligence/build_tierA.R` | orchestrator: builds profiles as-of (season, week), cut-point audit, reconciliation, artifacts, manifest |
| `analysis/player_scheme_intelligence/tests/test_tierA.R` | 20 R invariant assertions |
| `lib/player-scheme-intelligence/{read,query}.ts` | CSV read adapter + profile/matchup assembly |
| `app/api/player-scheme/{,players/[playerId],teams/[team]/defense,matchups/[playerId]/[opponent]}/route.ts` | dedicated read-only API namespace |
| `test/player-scheme-{read,isolation}.test.ts` | 14 TS contract + isolation tests |
| 10 served CSV + `player_scheme_manifest.json` in `lib/player-scheme-intelligence/data/` | version `psi:2025:w18:08123edd58c9` |

### What it computes (as-of 2025 wk18; windows: career / recent / current_team)
- **QB spatial matrix** — 12 cells (BEHIND_LOS/SHORT/INTERMEDIATE/DEEP ×
  LEFT/MIDDLE/RIGHT): attempts, attempt share, completion %, air yards, Y/A,
  EPA/att (raw + shrunk), success, TD/INT/explosive/first-down rate, YAC, evidence class. **198 QBs** career.
- **QB directional/depth tendencies** + deltas vs the league-QB baseline
  (left/middle/right %, behind-LOS/short/intermediate/deep %, deep-left/middle/right %,
  intermediate-middle %, short-middle %).
- **Receiver target matrix** — same grid, targeted-location basis (not alignment). **1,224 receivers**.
- **RB rush spatial** — direction (L/M/R) + gap (end/tackle/guard), EPA/rush,
  success, YPC, explosive, stuff, TD/first-down rate. **610 RBs**. Direction and
  gap only — never relabeled zone/gap/power/counter.
- **Defense pass vulnerability map** — allowed-target grid on the *same*
  depth×third definitions: target share allowed, comp % allowed, EPA/target
  allowed, success allowed, explosive allowed, TD rate allowed, INT rate
  generated. All 32 defenses × 12 cells × 2 windows.
- **Defense rush-direction profile** + gap.
- **League baselines** — pooled QB matrix per window.
- **Player directory** — gsis/sleeper/pfr/espn/yahoo/name id resolution (2 of
  1,536 unresolved to the ff crosswalk, recorded not dropped).

### Documented denominators (spec §41)
Pass-attempt universe: `play_type=="pass" & sack==0 & qb_spike==0 &
two_point_attempt==0 & !is.na(passer_player_id)`, REG only. Sacks are **not**
attempts (tracked separately). Designed-rush universe excludes kneels, spikes,
**scrambles** (QB dropback plays), `!is.na(rusher_player_id)`. A play with
`pass_location==NA` or `air_yards==NA` is counted in `attempts_total` /
`attempts_uncharted` and lands in **no cell** — never reassigned. `air_yards==0`
→ `SHORT` (documented). `run_location`/`run_gap` are offense-perspective as
shipped by nflverse — **no mirroring**.

### Cut-point sensitivity audit (spec §4) → **FROZEN 0 / 10 / 20**
| Alt grid | Spearman deep% vs default | Spearman int-mid% | Verdict |
| --- | --- | --- | --- |
| c (12/22) — nearest conventional | 0.93 | 0.92 | rank-order stable |
| b (8/16) — aggressive | **0.87** | 0.81 | reshuffles (P3 caveat) |
Frozen the standard round-number bins (transparent, conventional). The raw
per-cell `air_yards` mean + full matrix are served so any consumer can re-bin.

### Validation (Tier A gate — spec §41, §42, §43)
- `tierA_reconciliation.json` **all_pass = TRUE**: QB matrix cells sum to
  `attempts_charted` (max abs gap 0); `charted + uncharted == total`; L/M/R and
  depth shares sum to 1 (err < 1e-16); defense matrix cells sum to
  `targets_charted`; 32 defenses.
- R invariants (20): no fabricated SHORT/MIDDLE; sacks excluded; scrambles
  excluded; chronology-safe as-of cut; determinism (identical frame); tiny-sample
  cells forced `INSUFFICIENT`.
- TS (14): versioned manifest; `deployment=SHARED_DESCRIPTIVE`;
  `fantasy_adjustment_enabled=false`; unresolved id → `UNRESOLVED` (never a
  guess); deep passer (Josh Freeman/Will Levis) ranks above checkdown passer
  (Garoppolo/McCoy) on `deep_pct`; matchup output `numeric_fantasy_adjustment=0`
  / `SHADOW_ONLY` / `SHARED_DESCRIPTIVE`; determinism (version hash == content hash).
- **Isolation:** `npm test` **1617 / 1613 pass / 0 fail / 4 skipped** (+14
  Phase 9, 0 existing changed). No production module imports Phase 9;
  `git status` shows zero changes to any frozen surface. tsc + eslint clean.
- Determinism: seeded, pure aggregation; identical cache → identical version id.

### Findings
| ID | Sev | Finding |
| --- | --- | --- |
| P9-A-1 | P3 | QB depth-share *levels* are cut-point sensitive; an aggressive 8/16 redefinition reshuffles deep% rank-order (ρ=0.87). Mitigated: standard bins frozen + raw matrix served for re-binning. |
| P9-A-2 | P3 | Served data 10 MB (receiver matrix 6.2 MB). Acceptable; revisit (gzip / raise receiver floor from 20 targets) in Tier C if it grows. |
| P9-A-3 | P3 | `current_team` window uses the player's as-of team; a mid-season 2026 trade would need a rebuild to reflect (expected — pipeline re-stamps on each run). |
| P9-A-4 | P3 | 2 of 1,536 directory players unresolved to the ff crosswalk (recorded, not dropped). |

No P0/P1/P2. **Cut-point verdict FROZEN, reconciliation ALL PASS.**

### Runtime
Full Tier A build ≈ 27 s (single pass over 676k pbp rows, 2012–2025).

### Checkpoint — is Tier B safe to proceed?
**Yes.** Tier A has no P0/P1/P2 accounting, identity, or leakage problem; all
gate conditions pass. Tier B (charting-dependent `PRIOR_ONLY` profiles) builds
on the same normalized play spine and reuses the evidence/shrinkage machinery.

## Tier B — charting-dependent PRIOR_ONLY profiles ✅ COMPLETE

**Lane:** `SHARED_DESCRIPTIVE`. **Availability:** per-family `PRIOR_ONLY`
(participation) / `DESCRIPTIVE_ONLY` (FTN) — **none is `LIVE_CAPABLE` for 2026**.
Additive to Tier A: reads nothing from Tier A artifacts, does not modify them.

### Files added
| File | Role |
| --- | --- |
| `analysis/player_scheme_intelligence/lib_charting.R` | participation + FTN join onto the pbp spine; per-family split builders |
| `analysis/player_scheme_intelligence/build_tierB.R` | orchestrator: box-bucket sensitivity audit, reconciliation, artifacts, manifest merge, registry status |
| 10 served CSV in `lib/player-scheme-intelligence/data/` | `qb_coverage_profile`, `qb_coverage_family`, `qb_pressure_profile`, `qb_rusher_count_profile`, `qb_formation_profile`, `qb_concept_profile`, `qb_progression_profile`, `receiver_route_profile`, `receiver_coverage_profile`, `rb_box_profile` |
| `test/player-scheme-tierb.test.ts` | 11 Tier B contract tests |
| `feature_registry.yaml` `built_status:` block | actual built status (spec §21) |

### What it computes (windows career / recent / current_team)
| Family | Source | First season | Rows | Buckets |
| --- | --- | --- | --- | --- |
| QB coverage (man/zone + families) | participation | 2018 | 588 + fam | `MAN`/`ZONE`; `COVER_0/1/2/3/4/6`, `2_MAN`, `OTHER` |
| QB pressure | participation | 2016 | 651 | `PRESSURED`/`CLEAN` |
| QB pass-rusher count | participation | 2016 | 1,292 | `LT4`/`FOUR`/`FIVE`/`SIXPLUS` (5+ = **blitz PROXY**, not charted identity) |
| QB formation | participation | 2016 | 1,534 | `SHOTGUN`/`EMPTY`/`SINGLEBACK`/`I_FORM`/`PISTOL`/`UNDER CENTER`/`JUMBO`/`WILDCAT` |
| QB concepts (FTN) | ftn | 2022 | 1,764 | play_action / motion / no_huddle / rpo / screen / out_of_pocket / throwaway — frequency + efficiency |
| QB progression (FTN) | ftn | 2022 | 1,485 | `FIRST_READ`/`SECOND_READ`/`CHECKDOWN`/`DESIGNED`/`SCRAMBLE_DRILL`/`PRE_SNAP_OR_ZERO` |
| Receiver route | participation | 2018 | 18,019 | targeted-route taxonomy (21 values) |
| Receiver coverage | participation | 2018 | 3,236 | `MAN`/`ZONE` |
| RB box | participation | 2016 | 2,669 | `LIGHT`<6.5 / `NEUTRAL` / `HEAVY`≥7.5 |

For each split: exposure (how often faced), **kept separate from** tendency
(depth/direction distribution) and efficiency (EPA, success, completion, air
yards, sack rate, scramble rate, turnover rate, TTT). Every row carries
`charted_plays` context via the family totals + `coverage_rate_*`,
`evidence_class`, `availability`, `source`.

### Source-timeliness contract (spec §3, §22) — programmatic
Manifest `tier_b.families[]` carries, per family: `source`,
`first_supported_season`, `availability`, `source_season_through` (e.g.
`"2025 w18"`), `current_season_observed: false`. The API `charting.*` blocks
carry the same plus `is_current_season_observation: false`. A consumer **cannot
flatten provenance away** — every charting family object names its own
availability. `current_season_observed` is measured against
`PSI$SEASON_CURRENT` (2026), so it stays `false` even on a 2025-target build.

### Key semantic decisions
- **Denominators are charted plays.** `coverage_rate_mz`, `coverage_rate_pressure`,
  `route_coverage_rate` exposed. Uncharted plays → **no bucket** (never MAN/ZONE/FALSE).
- **`route` is targeted-route only** (participation is one row per play). Field
  is `targeted_route_share` = share of *targets*, not routes run. **YPRR is not
  computable** from this source and is not emitted (spec §10).
- **blitz ≠ pressure.** `qb_pressure` (was_pressure) and `qb_rusher_count`
  (number_of_pass_rushers) are separate families. 5+ rushers is labelled a
  PROXY. FTN `n_blitzers` (true count, 2022+) is retained internally, kept distinct.
- **man/zone is the primary historical split**; detailed coverage families are a
  secondary table, long tail collapsed to `OTHER`. First supported season 2018
  (0% charted 2016–17).
- **FTN families are `DESCRIPTIVE_ONLY`** — barred from becoming a Tier D
  `LIVE_CAPABLE` predictor by the feature registry (`predictive_eligible: false`).
- **Evidence gate** (spec §15): `psi_tierb_evidence` caps a split at `WEAK` when
  the player's own `coverage_rate` < 0.55 **or** opponent diversity < 4, even if
  raw sample is large.

### Box-bucket sensitivity audit (spec §14) → **CAVEAT, raw served**
| Alt grid | Spearman (heavy−light EPA) vs default |
| --- | --- |
| b (light<6.5 / heavy≥8.5) | 0.73 |
| c (light<5.5 / heavy≥7.5) | 0.58 |
RB box-response rank-order **is** cut-point sensitive. Default buckets kept for
presentation; `mean_box_faced` + per-bucket `carries` served so a consumer can
re-bucket. Manifest `box_bucket_verdict: "CAVEAT_RAW_SERVED"`. (P9-B-1, P3.)

### Validation (Tier B gate — spec §23)
- `tierB_reconciliation.json` **all_pass = TRUE**: man+zone ≤ charted_mz ≤
  eligible; coverage buckets ∈ {MAN,ZONE}; pressured+clean == charted (R-side);
  pressure states ∈ {PRESSURED,CLEAN}; `targeted_route_share` sums to 1 (err
  3e-16); box_share sums to 1 (err 1e-16); box buckets ∈ {LIGHT,NEUTRAL,HEAVY};
  FTN `plays_with_concept ≤ charted_plays` (never fabricate FALSE);
  `no_current_season_participation = TRUE`, `no_current_season_ftn = TRUE`.
- TS (11): manifest advertises `tiers: [A,B]`; every family `PRIOR_ONLY`/
  `DESCRIPTIVE_ONLY` + `current_season_observed:false`; FTN→DESCRIPTIVE_ONLY,
  participation→PRIOR_ONLY; only MAN/ZONE buckets; box partitions;
  `targeted_route_share` sums to 1; tiny-sample & low-charting splits forced
  `INSUFFICIENT`; registry-status artifact has `current_season_status:PRIOR_ONLY`
  for all 9 families and `predictive_eligible:false` for FTN.
- **Isolation:** `npm test` **1628 / 1624 pass / 0 fail / 4 skipped** (+11 Tier
  B, 0 existing changed). Zero frozen-surface changes; no production import.
  tsc + eslint clean.
- Determinism: seeded, pure aggregation; `served_content_sha256` in the manifest.

### Evidence distribution (career+recent+current_team)
| Family | STRONG | MODERATE | WEAK | INSUFFICIENT |
| --- | --- | --- | --- | --- |
| qb_coverage | 331 | 154 | 78 | 25 |
| qb_pressure | 377 | 159 | 85 | 30 |
| receiver_route | 979 | 2,980 | 4,582 | 9,478 |
| rb_box | 621 | 585 | 750 | 713 |
The gate is doing its job — the receiver-route long tail is dominated by
`INSUFFICIENT` micro-splits (1–7 targets on a route), emitted and flagged, never
suppressed or fabricated.

### Findings
| ID | Sev | Finding |
| --- | --- | --- |
| P9-B-1 | P3 | RB box-bucket rank-order is cut-point sensitive (Spearman 0.58–0.73). Mitigated: default buckets + raw `mean_box_faced`/per-bucket carries served; manifest `CAVEAT_RAW_SERVED`. |
| P9-B-2 | P3 | Served data now 20 MB (`receiver_route_profile.csv` ≈ largest). Cannot trim `INSUFFICIENT` rows without breaking `targeted_route_share` reconciliation. Revisit (gzip / per-window split files) in Tier E if it grows. |
| P9-B-3 | P3 | `route` is targeted-only — no routes-run denominator. Documented in schema, manifest, registry; blocks YPRR. Upstream (nflverse participation) limitation, not a defect. |
| P9-B-4 | INFO | participation man/zone unavailable 2016–17 → `qb_coverage`/`receiver_*` `first_season = 2018`. `qb_pressure`/`rb_box`/`formation` supported from 2016. |

No P0/P1/P2. **Reconciliation ALL PASS; provenance programmatically enforced;
Tier A artifacts byte-identical.**

### Runtime
Tier B build ≈ 53 s (participation join + FTN join + 9 families × 3 windows).

### Checkpoint — is Tier C safe to proceed?
**Yes.** No P0/P1; provenance is machine-readable per family; all denominators
reconcile; Tier A intact. Tier C (team offense/defense profiles + numeric
archetype vectors + coordinator/scheme-era mechanism) builds on the same
normalized play + charting spine and does **not** depend on Tier D.

---

## 7. Verdict

**PART I COMPLETE. TIERS A & B COMPLETE & GATES PASSED.**
No Section 47 verdict is issued until Part II implementation + validation +
regression are complete. Phase 9 is **not** wired into Orchestrator ACTION
generation or production projection adjustments, and will not be without a
separate integration/certification decision.
