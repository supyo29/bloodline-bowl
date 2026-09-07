# Team Management — Phase 3: R Football Intelligence Engine

**Status: PRE-IMPLEMENTATION AUDIT — scope gate open (spec §28). Not yet built, not yet certified.**

Phase 1 (canonical live-state) is FROZEN and live in production. Phase 2 (Team-State /
Management Context) is CERTIFIED and merged to `main` (`c6edde6`, pushed). This document is
the Phase 3 counterpart of the Phase 1A audit: it establishes the ownership map, the
**real** data-availability picture (probed live against `nflreadr` 1.5.0 / R 4.5.3 in this
environment), the output contract, and a concrete, conservative **v1 feature scope** for
sign-off *before* the modelling pipeline, backtests, and adversarial audit are built.

The Phase 3 build spec (items 1–36) is large and explicitly anti-cargo-cult: *"Phase 3
cannot freeze merely because the R code runs"*, *"do not implement fake placeholders for
data we do not possess"*, *"do not choose a sophisticated model merely for sophistication"*.
Honoring that means the v1 scope must be agreed before implementation. **This document ends
at the §28 scope gate.**

---

## 1. Existing R infrastructure audit — ownership map

### 1.1 What the spec expected vs. what exists

| Spec item (§1) | Reality in this repo |
| --- | --- |
| `services/r-api` | **Does not exist.** No R service, no HTTP R layer. `plumber` is installed but unused. |
| `_targets.R` / target graph | **Does not exist.** `targets` is installed but there is no `_targets.R`, no `_targets/` store, no `tar_*` call anywhere. |
| Calibration engines | `analysis/phase2_calibration.R` (733 lines) — shrinkage-K / formula-family sweep for the projection core, walk-forward over held-out seasons. |
| Market / external projection inputs | `lib/projections/sleeper.ts` (RotoWire via Sleeper) — **benchmark only, never a model input**. `lib/draft/data/market-adp-2026.json`. |
| Player identity / crosswalk | R side: `nflreadr::load_ff_playerids()` (`gsis_id ↔ sleeper_id ↔ pfr_id ↔ espn_id ↔ yahoo_id ↔ pff_id`, 12,492 rows). Name+school deterministic matcher in `analysis/phase3_lib.R` (`build_identity_crosswalk`, tiers `HIGH_CONFIDENCE / MEDIUM / AMBIGUOUS / UNMATCHED`). TS side: `lib/projections/canonical-identity.ts` + the frozen Phase 1 canonical crosswalk. |
| Stored historical data | `analysis/phase3_cache/*.rds` (15 files, git-ignored) — player/team/rosters/snaps/draft/combine/college aggregates, `2012–2025`. |
| Raw NFL data sources present | nflverse via `nflreadr` only. No PFF, no SIS, no TruMedia, no paid feed. |
| Play-by-play present | **Not cached, not used anywhere today.** `nflreadr::load_pbp()` works in this environment (probed: 2025 = 48,771 rows × 372 cols). |
| Player/team feature tables | `outputs/projections-2026/backtest_seasons.csv` (player-season box aggregates). `lib/trades/data/player_usage_weekly.csv`, `player_schedule_strength_weekly.csv` (2025, from `phase35_*` scripts). |
| Config / versioning / test / output conventions | Documented in 1.3 below. |
| Existing opponent-adjustment logic | **Only one, and it is not in the live path:** `analysis/phase35_schedule_pipeline.R` → points-allowed-by-position, percentile-normalized across the week's 32 teams, rescaled to `[-1,+1]`. 2025 only. Explicitly *not* wired as a default provider (`lib/trades/r-data-providers.ts` header). The weekly Matchup engine (`lib/weekly/matchup.ts`) does **no** NFL-defense-strength adjustment — it is best-legal-lineup vs best-legal-lineup + seeded Monte Carlo. |
| Existing scheme / team-context features | **None.** `lib/projections/model.ts` has a "team environment" step but it is team *pace/volume* allocation derived from the team's own box totals, not scheme or opponent context. |

### 1.2 The R stack as it actually is

```
analysis/
  lib_ri_projection.R          R port of the production projection core (parity-tested vs TS)
  phase2_calibration.R         shrinkage/formula sweep, walk-forward, bootstrap  -> outputs/*.csv + plots
  phase3_fetch_data.R          reproducible nflverse + cfbfastR pull -> analysis/phase3_cache/*.rds
  phase3_lib.R                 name/school normalization, identity crosswalk, metric_set, paired_boot, brier
  phase3_rookie_role_model.R   rookie opportunity model (draft-capital only) -> lib/projections/data/rookie-draft-2026.json
  phase35_usage_pipeline.R     2025 weekly usage -> lib/trades/data/player_usage_weekly.csv
  phase35_schedule_pipeline.R  2025 weekly schedule strength -> lib/trades/data/player_schedule_strength_weekly.csv
  phase4_snake_recommendation_engine.R / phase5_market_survival.R / phase6_roster_trajectory.R  (draft-only)
```

**Conventions (observed, to be reused — not reinvented):**

- **Reproducible fetch + cache**: every script pulls versioned public data, caches to `.rds`,
  and the modelling harness reads *only* the cache. `--refresh` forces a re-pull. No API keys,
  no scraping.
- **Determinism**: explicit `set.seed()` at every random step (`paired_boot` seed `30303`,
  etc.). Parity assertions against a frozen CSV (`test/projection-r-parity.test.ts`).
- **Versioned model tags**: `ri-<family>-<year>.<n>` (`ri-structural-2026.3`,
  `ri-snake-survival-2026.1`, `ri-trade-strategy-2026.2`). A frozen model is byte-identical
  and tagged; recalibration bumps the tag.
- **R → TS contract**: R writes a committed artifact (`.csv` + a `.meta.json` sidecar with
  `data_version`, `generated_at`, `season`, `weeks_present`, `rows`, `source`,
  `refresh_command`). TS reads the file at request time and **never shells out to R**.
- **Temporal safety as a type, not a convention**: `createRUsageProviderAsOf(season, asOfWeek)`
  filters `week <= asOfWeek` inside every method — a caller structurally cannot read a future
  week (`lib/trades/r-data-providers.ts`).
- **Testing**: `testthat` is installed; today R correctness is asserted indirectly through
  the TS parity test and the `outputs/*.csv` diagnostics. There is **no R-native test suite yet**.
- **Persistence format**: `.rds` for internal caches, `.csv` + `.meta.json` for the TS
  boundary. No Parquet anywhere yet (no `arrow`/`nanoparquet` installed).

### 1.3 Reuse decision (spec §1: "Do NOT duplicate an existing football-context pipeline")

| Component | Decision |
| --- | --- |
| `nflreadr` fetch + `.rds` cache pattern (`phase3_fetch_data.R`) | **Reuse verbatim** — extend with pbp / participation / NGS / PFR / FTN loaders. |
| `nflreadr::load_ff_playerids()` crosswalk + `phase3_lib.R` name normalizers | **Reuse** as the R-side identity spine. |
| `.csv` + `.meta.json` → TS file-reader boundary (`r-data-providers.ts`) | **Reuse the pattern**; Phase 3 gets its own manifest + typed reader. |
| `metric_set` / `paired_boot` / `multiclass_brier` (`phase3_lib.R`) | **Reuse** for evaluation / ablation. |
| `phase35_schedule_pipeline.R` points-allowed percentile | **Supersede, do not delete.** It is a raw proxy the trade engine consumes today; Phase 3 produces the opponent-adjusted successor as a *new* artifact. The trade engine is not repointed in Phase 3 (spec §32). |
| `_targets.R` | **Introduce** — this is the one genuinely missing piece the spec asks for (§21 weekly pipeline, incremental recompute). |
| `plumber` R service | **Do not introduce.** The established boundary is committed file artifacts + a TS reader; a live R service on Vercel is out of the question and unnecessary. |

---

## 2. Data availability audit (probed live, `nflreadr` 1.5.0, this environment)

Every row below was confirmed by an actual load in this environment on 2026-09-06, not from
memory. Season 2025 is complete (canonical live state = season 2026, week 1).

### 2.1 Source inventory

| Source (`nflreadr`) | Grain | Seasons (usable) | Refresh | Key(s) | Notes |
| --- | --- | --- | --- | --- | --- |
| `load_pbp` | play | 1999– (EPA/WP model stable ~2006–, `xpass`/`pass_oe` ~2006–) | weekly, in-season | `game_id`, `play_id`; `posteam`/`defteam`; `*_player_id` = gsis | 372 cols. `epa`, `success`, `air_yards`, `yardline_100`, `down`, `ydstogo`, `shotgun`, `no_huddle`, `qb_dropback`, `pass`/`rush`, `xpass`, `pass_oe`, `cpoe`, `wpa`, `series`, `drive`, `home_coach`/`away_coach`, `roof`, `surface`, `temp`, `wind`, `spread_line`, `total_line`. **REG + POST**. |
| `load_participation` | play | **2016–2025** (confirmed 2025 = 45,184 rows; resumed after the 2023 gap) | weekly, lags ~1–2 wk | `nflverse_game_id` + `play_id` → joins pbp | `offense_formation`, `offense_personnel`, `defense_personnel`, `defenders_in_box`, `number_of_pass_rushers`, `route`, `was_pressure`, `time_to_throw`, `defense_man_zone_type`, `defense_coverage_type`, `offense_players`/`defense_players` (gsis id lists). **The scheme backbone.** |
| `load_ftn_charting` | play | **2022–2025 only** (3.x seasons) | weekly | `nflverse_play_id` → joins pbp | `is_play_action`, `is_screen_pass`, `is_rpo`, `is_motion`, `is_no_huddle`, `n_offense_backfield`, `n_defense_box`, `n_blitzers`, `n_pass_rushers`, `qb_location`, `is_qb_out_of_pocket`, `read_thrown`, `is_catchable_ball`, `is_drop`. **Manual charting — richest, shortest history.** |
| `load_nextgen_stats` (`passing`/`rushing`/`receiving`) | player-week | 2016– | weekly | `player_gsis_id` | passing: `avg_time_to_throw`, `aggressiveness`, `avg_air_yards_differential`, `completion_pct_above_expectation`. rushing: `efficiency`, `rush_yards_over_expected`, `rush_pct_over_expected`, `pct_attempts_gte_eight_defenders`, `avg_time_to_los`. receiving: `avg_separation`, `avg_cushion`, `avg_intended_air_yards`, `pct_share_of_intended_air_yards`, `avg_yac_above_expectation`. |
| `load_pfr_advstats` (`pass`/`rush`/`rec`/`def`, `summary_level="week"`) | player-week | **2018–** | weekly | `pfr_player_id` (→ crosswalk) | pass: `times_pressured`, `times_blitzed`, `times_hurried`, `times_hit`, `times_sacked`, `passing_bad_throw_pct`, `def_times_blitzed`. rush: `rushing_yards_before_contact`, `..._after_contact`, `rushing_broken_tackles`. def: `def_pressures`, `def_missed_tackle_pct`, `def_completion_pct` allowed, `def_yards_allowed_per_tgt`, `def_passer_rating_allowed`, `def_adot`. |
| `load_snap_counts` | player-game | 2012– | weekly | `pfr_player_id` | `offense_snaps`, `offense_pct`, `defense_snaps`, `st_snaps`. Already used by `phase3_fetch_data.R`. |
| `load_schedules` | game | 1999– | weekly | `game_id` | scores, `home_coach`/`away_coach`, `spread_line`, `total_line`, `roof`, `surface`, `temp`, `wind`, `home_rest`/`away_rest`, `div_game`, `gameday`. |
| `load_rosters_weekly` | player-week | 2002– | weekly | `gsis_id` | `status`, `team`, `position`, `depth_chart_position`, `years_exp`, `sleeper_id`, `pfr_id`, `espn_id`. Personnel-continuity source. |
| `load_depth_charts` | team-slot(-week) | 2001– (**schema changed 2025** → snapshot `dt`, not `week`) | weekly | `gsis_id` | Already normalized in `phase3_fetch_data.R`. Low reliability post-2025 (ordering noisy). |
| `load_players` / `load_draft_picks` / `load_combine` / `load_ff_playerids` | player | full | static / yearly | gsis / multi | identity + draft capital + athletic testing. |
| `load_espn_qbr` | player-week | 2006– | weekly | name/espn | 73 rows 2025. QB-only, redundant with pbp-derived. **Family C.** |

### 2.2 Feature-family classification

**A — reliable and available now** (sufficient history, clean weekly path, no leakage in-season):

| Family | Built from | History |
| --- | --- | --- |
| Team offensive EPA/play, pass EPA, rush EPA, success rate, early-down EPA | `load_pbp` | 2006– |
| Neutral pass rate, PROE (pass rate over expected via `pass_oe`/`xpass`), early-down pass rate | `load_pbp` | 2006– |
| Pace (sec/play, neutral), plays/game, shotgun rate, no-huddle rate | `load_pbp` | 2006– |
| Explosive-play rate (pass ≥16, rush ≥12) — off and def | `load_pbp` | 2006– |
| Team defensive EPA/play allowed, pass/rush split, success allowed, explosive allowed | `load_pbp` | 2006– |
| Sack rate (off allowed / def generated), pressure→sack proxy | `load_pbp` (`sack`, `qb_hit`) | 2006– |
| Red-zone / goal-line pass-run tendency (off and def) | `load_pbp` (`yardline_100`) | 2006– |
| Target distribution by position (team level) | `load_pbp` / `load_player_stats` | 2006– |
| Down / distance / script (leading/trailing) situational splits | `load_pbp` | 2006– |
| **Player usage**: snap share, route participation (participation `route`), target share, air-yards share, aDOT, carry share, RZ target/carry share, weighted opportunity | `load_pbp` + `load_participation` + NGS | 2016– (routes); 2006– (targets/carries) |
| NGS separation / cushion / time-to-throw / RYOE / aggressiveness | `load_nextgen_stats` | 2016– |
| Pressure profile (off allowed / def generated), blitz rate, hurry/hit rates | `load_pfr_advstats` | 2018– |
| YBC / YAC (rushing), broken tackles, missed-tackle rate (defense) | `load_pfr_advstats` | 2018– |
| Coverage-allowed by target position (def per-player, aggregate to unit) | `load_pfr_advstats` def | 2018– |
| Game context (spread, total, roof, surface, temp/wind, rest, division) | `load_schedules` | 1999– |

**B — available but requires derivation** (computable, but definitions are ours and need validation):

| Family | Derivation | Caveat |
| --- | --- | --- |
| Personnel groupings (11/12/21/…), light/heavy box rate | `load_participation` `offense_personnel` / `defenders_in_box` | 2016–; string parsing; ~1–2 wk lag in-season |
| Man vs zone faced/played, single-high vs two-high | `load_participation` `defense_man_zone_type` / `defense_coverage_type` | 2016–; **charting confidence varies**; needs a minimum-play threshold |
| Play-action / screen / RPO / motion rate | `load_ftn_charting` | **2022–2025 only** — 3 seasons is thin for a prior; classify usage but flag `LOW` confidence pre-2022 comparisons |
| Inside vs outside run tendency | `load_pbp` `run_location` / `run_gap` | present but **missing on a large fraction of rows** → C for concept-level, B for simple inside/outside |
| Coordinator identity + change flags | `load_pbp` coaches (HC only) + external manual table | nflverse has **head coach only**; OC/DC changes need a small hand-maintained YAML (see §13) |
| OL continuity | `load_snap_counts` (position `T/G/C`) + `load_rosters_weekly` games-started | derivable; noisy for injuries |
| Personnel turnover (skill, front, secondary) | `load_rosters_weekly` year-over-year snap-weighted roster overlap | derivable |
| QB continuity | `load_pbp` starting QB by team-season | trivial, reliable |

**C — partial / weak coverage** (may inform later, must not drive v1 predictions):

- Detailed run *concept* (gap/power/zone/duo) — not in any free source; FTN does not chart it;
  inferring from `run_gap` is too sparse. **Do not label as observed truth (spec §5).**
- Pre-2016 usage/route data — no participation data; snap counts only from 2012.
- Individual LB / DB causal ratings — team-level data cannot defensibly attribute (spec §5, §11).
- Weather-distortion effects — `temp`/`wind` present but sample per team-week tiny.
- `load_depth_charts` ordering as a role signal post-2025 schema change.
- Time-to-pressure — only `time_to_throw` (participation) as a proxy, not true TTP.

**D — unavailable** (do not fabricate, spec §2):

- PFF/SIS grades, pass-block win rate, pressure attribution to specific linemen.
- Route-level coverage matchups (which DB covered which WR on which route).
- Coverage *scheme* naming beyond man/zone + high-safety count.
- Practice participation / injury practice reports as structured data.
- Coordinator play-calling scripts, personnel packages by tendency.
- Any 2026 in-season data before games are played (0 rows until Week 1 completes).

### 2.3 Backtest feasibility

- **Walk-forward horizon**: 2016–2025 for usage/participation features; 2018–2025 for
  PFR-pressure features; **2022–2025 only** for FTN-charting features (→ FTN features can be
  *described* for the current season but **cannot be meaningfully backtested for prior-year
  priors** — this bounds them out of v1 prediction, spec §28.2).
- **In-season no-lookahead**: all Family-A sources have a clean "as of end of week N" cut.
  Participation and FTN lag 1–2 weeks — the pipeline must record `data_cutoff` per source and
  the snapshot must expose per-source `through_week` (spec §3), because participation "week N"
  may not exist when pbp "week N" does.

---

## 3. `FootballIntelligenceSnapshot` — output contract (design)

Naming follows repo convention (`snap:` ids, versioned tags, `.meta.json` sidecars).

```
football_intelligence_version   fi:<season>:w<through_week>:<12-hex content hash>   (immutable id)
model_tag                       ri-football-intel-2026.1
feature_schema_version          integer, bumped on any breaking column change
generated_at                    ISO-8601
season                          2026
through_week                    integer (max NFL week fully ingested across ALL required sources)
data_cutoff                     { pbp: "2026-W3", participation: "2026-W2", ftn: "2026-W2", ngs: "2026-W3", pfr: "2026-W3" }
source_versions                 { nflreadr: "1.5.0", pbp_release: "...", ... }
model_versions                  { opponent_adjustment: "...", prior: "...", trend: "...", usage: "..." }
seasons_used                    [2016..2026]  (with decayed weights — see §22)
```

Published as an immutable set of columnar files under a version directory. A new weekly run
writes a **new** `football_intelligence_version` directory; nothing is mutated in place. A
lightweight `football_intelligence_manifest.json` lists the current + prior versions and the
file inventory. Downstream reads the manifest, never re-runs R.

### 3.1 Output tables (each carries `football_intelligence_version`)

| Table | Grain | Purpose |
| --- | --- | --- |
| `team_offensive_profile` | team × through_week | pace, PROE, early-down pass rate, personnel mix, EPA/success (raw + opp-adj + percentile + n + se) |
| `team_defensive_profile` | team × through_week | pass/rush EPA allowed, explosive allowed, pressure generated, blitz rate, RZ defense (raw + opp-adj + percentile + n + se) |
| `offensive_line_profile` | team × through_week | pressure allowed rate, sack rate, YBC, adjusted-line proxy, continuity flag |
| `defensive_front_profile` | team × through_week | pressure rate, pressure-without-blitz, blitz rate, run-stop success, YBC allowed, short-yardage |
| `secondary_profile` | team × through_week | man/zone tendency, high-safety split (where sampled), explosive-pass prevention, coverage-allowed by target position |
| `coverage_allowed_by_position` | team × pos ∈ {RB,WR,TE} × through_week | receiving efficiency allowed to that alignment/position (raw + opp-adj + n + confidence) |
| `player_usage_profile` | player × through_week | position-specific usage vector (§6), all opportunity, no talent/points |
| `player_trend_profile` | player × through_week | current_level, recent_level, trend_direction, trend_magnitude, trend_confidence |
| `team_trend_profile` | team × unit × through_week | same trend shape for team units |
| `coaching_tendency_profile` | team × season | HC/OC/DC identity, continuity vs prior year, tenure |
| `contextual_matchup_feature` | off_team × def_team × pos × week | interaction features (§15): `offense_rating`, `defense_rating`, `interaction_signal`, `n`, `confidence` — **not points** |

Each numeric rating column ships as a struct: `{ raw, opponent_adjusted, league_percentile, n_plays, effective_n, std_error, confidence, prior_weight, recent_weight }` (spec §10, §26 explainability).

---

## 4. Identity strategy

- **Players**: `gsis_id` is the R-side primary key (pbp, NGS, rosters all use it). Join to
  `pfr_id` (PFR advstats, snaps) and `sleeper_id` via `load_ff_playerids()`. Publish
  `gsis_id` + `sleeper_id` + `pfr_id` + `position` + `nfl_team` on every player row. The TS
  adapter resolves `canonical_player_id` via the frozen Phase 1 crosswalk
  (`lib/projections/canonical-identity.ts`) — R does **not** need the canonical id.
- **NFL teams**: `nflreadr` standard abbreviations (`team_abbr`), with the historical alias
  map (`OAK→LV`, `SD→LAC`, `STL→LAR`, `WAS`/`WSH`) applied once at ingest. One team universe.
- **Fantasy independence** (spec §4): the engine takes **no** league / manager / roster input.
  It models NFL football. Team-State does the fantasy join later (§24).

---

## 5. Proposed v1 feature scope (spec §28 gate)

Only features that satisfy **all seven** §28 criteria (reliable data, backtestable history,
plausible fantasy relevance, adequate sample, out-of-sample incremental value *to be proven*,
weekly-updatable, explainable). Everything else → `DEFERRED_FEATURES` (§ below).

### v1 — IN (pending backtest confirmation of incremental value)

**Team offense (opponent-adjusted, 2006– history):**
1. `off_pass_epa_play`, `off_rush_epa_play`, `off_success_rate`
2. `off_proe` (pass rate over expected), `off_neutral_pass_rate`, `off_early_down_pass_rate`
3. `off_pace_neutral_sec_play`, `off_plays_per_game`
4. `off_explosive_pass_rate`, `off_explosive_rush_rate`
5. `off_pressure_rate_allowed` (2018–), `off_sack_rate_allowed`
6. `off_rz_pass_rate`, `off_rz_td_rate`

**Team defense (opponent-adjusted, 2006– / 2018– for pressure):**
7. `def_pass_epa_allowed`, `def_rush_epa_allowed`, `def_success_allowed`
8. `def_explosive_pass_rate_allowed`, `def_explosive_rush_rate_allowed`
9. `def_pressure_rate`, `def_blitz_rate`, `def_pressure_without_blitz_rate` (2018–)
10. `def_rush_stop_rate`, `def_ybc_allowed_per_rush` (2018–)
11. `def_rz_td_rate_allowed`
12. `coverage_allowed_receiving_epa` by `{RB, WR, TE}` (2018– PFR def aggregated to unit + pbp target EPA by position)

**Player usage (2016– routes, 2006– targets/carries):**
13. QB: dropbacks/g, designed-rush rate, deep-att rate, play-action rate (2022– → describe-only pre-2022), aDOT, pressure-faced rate
14. RB: snap share, rush share, early-down rush share, route participation, target share, RZ carry share, goal-line carry share, weighted opportunity
15. WR: route participation, target share, air-yards share, aDOT, RZ target share, alignment slot/wide split (participation), NGS separation
16. TE: route participation, target share, aDOT, RZ target share, inline/slot split (participation)

**Trend layer (§12):** `current_level`, `recent_level`, `trend_direction ∈ {improving, deteriorating, stable, uncertain}`, `trend_magnitude`, `trend_confidence` for each team-unit rating and each player usage headline — modeled change (state-space / weighted), not a 2-game average.

**Contextual matchup features (§15), interaction-only, no points:**
17. off pressure-allowed × def pressure-generated
18. off blitz-performance × def blitz-rate
19. RB receiving usage × def RB-receiving-allowed
20. TE usage × def TE-coverage-allowed
21. off explosive-pass rate × def explosive-pass prevention
22. off PROE/pace × def pass-funnel (pass vs rush EPA-allowed differential)

### v1 — OUT → `DEFERRED_FEATURES`

| Deferred | Reason |
| --- | --- |
| Run concept (gap/power/zone/duo) tendencies & defense-vs-concept | No reliable free source (§2 class C/D). Inside/outside only, and only as `LOW` confidence. |
| FTN-derived rates (PA/screen/RPO/motion) as **prior-bearing predictive** features | Only 2022–2025 — cannot build a decayed multi-year prior or a real walk-forward backtest. Published as **current-season descriptive** with `availability` flag, not fed to any predictive interaction. |
| Man/zone & high-safety splits as headline ratings | Charting-confidence variance; keep as `B` diagnostic with min-play gates, not a v1 published rating until the sample/shrinkage behaviour is validated in the adversarial audit. |
| Individual OL / LB / DB ratings | Team-level data can't attribute (§5, §11). |
| Coordinator play-calling scripts, personnel-package tendencies | Class D. |
| Weather-distortion adjustments | Class C, sample too small. |
| Any fantasy-point translation / matchup bonus | Spec §16, §32 — Phase 3 emits football signals only. |

---

## 6. Methodology designs (to be implemented after gate)

### 6.1 Historical priors (§8, §22)
Team unit rating enters season as a **decayed blend of prior seasons**, weight
`w_s ∝ λ^(target_season − s)` with `λ` chosen by backtest (candidate grid `{0.35, 0.5, 0.65}`),
truncated at 4 prior seasons (matches the projection core's `RECENCY_BY_GAP` philosophy).
Prior is **down-weighted** by discontinuity: new HC/OC/DC, QB change, OL continuity < threshold
(§13, §14) each multiply the prior's effective sample by a `< 1` factor (grid-searched, not
hand-tuned). As current-season plays accumulate the posterior mean moves from prior→current via
the same `n/(n+k)` shrinkage the repo already uses (`shrink()` in `lib_ri_projection.R`).

### 6.2 Recency weighting within season (§9)
Exponentially-weighted estimate over game-level unit metrics, half-life grid `{2, 3, 4, 5}`
games, **plus** a partial-pool guard so one extreme game cannot move the rating more than a
capped amount (state-space alternative evaluated in the §31 simple-vs-complex bake-off; the
simplest that wins out-of-sample is kept).

### 6.3 Opponent adjustment (§10)
Iterative (ridge-regularized) two-way adjustment on play-level residuals:
`metric_play ≈ off_team_effect + def_team_effect + situation_controls`, solved by penalized
least squares (or `lme4`-style partial pooling if the iterative version fails to converge
stably — `mgcv` is available, `lme4` is not; ridge via `MASS`/base is the fallback). Outputs
`raw`, `opponent_adjusted`, `league_percentile`, `n`, `std_error`. Convergence + reproducibility
asserted as invariants (§30). Situation controls: home/road, spread bucket, dome/outdoor,
neutral-script filter for tendency metrics.

### 6.4 Uncertainty / shrinkage (§11)
Every granular split carries `n_plays` and `effective_n` (down-weighted for recency). Ratings
shrink toward (a) team prior then (b) league mean by `effective_n / (effective_n + k)`.
`confidence ∈ {HIGH, MEDIUM, LOW, INSUFFICIENT_SAMPLE}` derived from `effective_n` vs
published thresholds **and** `std_error` — not cosmetic. A rating below its minimum publication
threshold is emitted with `confidence = INSUFFICIENT_SAMPLE` and the value present but flagged,
never suppressed silently and never replaced with a fabricated league-average (§25).

### 6.5 Trend (§12)
`recent_level` = EW estimate with short half-life; `current_level` = full in-season posterior;
`trend_magnitude` = standardized difference scaled by its own se; `trend_direction` thresholded
on `trend_magnitude / se` with a dead-band → `stable`, wide band → `uncertain`. Backtested:
does a detected `improving` trend predict next-4-week metric level better than "no trend"?

---

## 7. Anti-double-counting (§16, mandatory)
Phase 3 publishes **no** `+x.x matchup points`. Every contextual matchup feature is a football
signal with `offense_rating` / `defense_rating` / `interaction_signal` / `confidence`. The
`docs` section will enumerate expected overlap with (a) the weekly projection opportunity
allocation, (b) the season structural projection, (c) the Sleeper benchmark — and the shadow
evaluation (§33) will measure *incremental* R² over those baselines with `paired_boot`
(`phase3_lib.R`). A feature with no incremental value is deferred, not shipped (§19, §31).

---

## 8. Backtest / evaluation plan (§17–§20, to run during build)
- Rolling-origin walk-forward, week-by-week, 2018–2025 (2016–2025 for route/usage-only
  features). Priors reconstructed "as they would have existed"; no future weeks in any fit.
- Targets (§18): next-week / next-4-week team EPA, success, pressure rate, explosive rate;
  player opportunity stability (snap/route/target share); coverage-allowed realized.
- Baselines (§19, §31): league mean; season-to-date raw mean; EW mean; opponent-adjusted;
  partial-pool. Candidate must beat the best simple baseline out-of-sample (paired bootstrap,
  95% CI) to be retained.
- Calibration (§20): where the engine emits an expected level, reliability curves; rank
  stability of ratings week-to-week; error vs `effective_n`; error vs week-of-season.

---

## 9. Weekly pipeline (§21) & persistence (§23) — design
- Introduce `_targets.R` with source-level targets (pbp, participation, ftn, ngs, pfr, sched,
  rosters), derived-feature targets, model targets, and a final `publish_snapshot` target.
  `tar_make()` recomputes only what changed (new week of a source).
- One documented command: `Rscript -e 'targets::tar_make()'` (wrapped as
  `analysis/run_football_intelligence.R` / an npm script).
- Persist columnar. `arrow` is **not installed** — decision point: install `nanoparquet`
  (single-file, zero-dep) for Parquet, **or** stay with `.rds` + `.csv`+`.meta.json` (repo
  precedent, no new dependency, Vercel-safe because committed). **Recommendation: `.rds` for
  the R-internal store + `.csv`/`.json` for the committed TS boundary**, matching
  `phase35_*`; revisit Parquet only if file size forces it.

---

## 10. TS / Team-State integration contract (§24) — design
A new **read-only** `lib/football-intel/` module:
```
loadFootballIntelligenceManifest(): { version, generated_at, through_week, files, ... }
getPlayerUsageProfile(canonical_player_id | gsis_id): PlayerUsageProfile | { resolution: "UNRESOLVED" }
getTeamProfiles(nfl_team, through_week): { offense, defense, ol, front, secondary }
getContextualMatchup(off_team, def_team, position, week): ContextualMatchupFeature | { availability: "NOT_AVAILABLE" }
```
Pure file reads + the frozen crosswalk, same pattern as `r-data-providers.ts`, structural
`through_week` cutoff. **Team-State is not modified in Phase 3** (spec §24, §32) — the contract
is defined and unit-tested against fixture snapshots; wiring it into Team-State/consumers is
Phase 4+. The fact/evaluation boundary is untouched.

---

## 11. Guarantees to be enforced (§27, §30, §36)
Deterministic (seeded, versioned), immutable snapshots, no future-data leakage (structural
`data_cutoff`), explicit uncertainty on every rating, opponent adjustment + priors +
small-sample shrinkage each with dedicated invariant tests, simple-vs-complex bake-off with
documented selection, **zero** change to weekly/trade/waiver/start-sit/projection/matchup/
win-probability outputs (asserted by re-running every existing deterministic fixture),
`testthat` R suite + TS read-contract suite.

---

## 12. Findings so far (pre-build)

| ID | Sev | Finding |
| --- | --- | --- |
| P3-A1 | P2 | Spec assumes `services/r-api` + `_targets.R`; neither exists. Ownership map (§1) redirects to the real `analysis/*.R` + committed-artifact pattern. `_targets.R` will be introduced. |
| P3-A2 | P1 | FTN charting (play-action / screen / RPO / motion) is **2022–2025 only**. It cannot carry a decayed multi-season prior or a real walk-forward backtest → **deferred from v1 prediction**, published as current-season descriptive with an `availability` flag. Not a fake placeholder — a real, marked limitation. |
| P3-A3 | P2 | nflverse ships **head coach only**. OC/DC change flags (§13) require a small hand-maintained `analysis/data/coordinators.yaml`. To be built with sourced entries + a `source_url` per row; absent entry ⇒ `continuity = UNKNOWN`, never assumed. |
| P3-A4 | P2 | `load_participation` had a real gap (missing 2023-era updates) and only recently resumed; it lags pbp by 1–2 weeks in-season. The snapshot's per-source `data_cutoff` / `through_week` (§3) is therefore load-bearing, not decorative. |
| P3-A5 | P2 | Run-concept classification (gap/power/zone) has **no reliable free source**. Deferred; only inside/outside at `LOW` confidence. Prevents the §5 "observed truth from weak proxies" failure. |
| P3-A6 | P3 | No `arrow`/Parquet in the R env. Recommend staying on `.rds` + `.csv`/`.meta.json` (repo precedent) rather than adding a dependency. |
| P3-A7 | P3 | No R-native test suite exists yet. Phase 3 introduces the first (`testthat` under `analysis/tests/`). |

No P0s. No implementation has begun.

---

## 13. Verdict

**PHASE 3 — PRE-IMPLEMENTATION AUDIT COMPLETE. SCOPE GATE OPEN (spec §28).**

The R infrastructure is audited, the data availability is classified against **live probes**
in this environment, the output contract and methodology are designed, and a conservative v1
feature set (items 1–22 above) with an explicit `DEFERRED_FEATURES` list is proposed.

Per the spec's own §28 ("After the data audit, define a concrete v1 feature set") and §1
("Produce an ownership map **before implementation**"), and consistent with how Phase 1A was
an audit checkpoint before 1B, **implementation is paused here for scope confirmation.**

**Requested decision:** approve the v1 IN / OUT scope in §5 (or adjust), and confirm the §9
persistence recommendation (`.rds` + `.csv`/`.json`, no new R dependency). On approval, the
build proceeds: `_targets.R` graph → source loaders → derived features → priors → recency →
opponent adjustment → uncertainty → trends → snapshot publish → TS read adapter → walk-forward
backtest + ablation → adversarial audit (§29) → statistical invariants (§30) → full regression
→ Phase 3 certification with one of the three final verdicts.
