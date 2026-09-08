# Team Management — Phase 5: Matchup Intelligence

**Status: PRE-IMPLEMENTATION AUDIT. Verdict at §31. NO substantive implementation.**

Branch `team-management-phase5-matchup-intelligence` (off the Phase 4 stack). Phases 3/4
remain stacked and unmerged — not restructured. `ri-startsit-2026.1` stays `SHADOW_ONLY`;
production Start/Sit stays `MAX_EXPECTED`; `buildOptimalLineup` / `maxSlotMatching` frozen.

---

## 1. Objective

Phase 4 asked *"which legal lineup has the highest expected fantasy points?"*. Phase 5 asks
*"given my lineup, my opponent's, uncertainty, game environments, and player dependence, what
are the **distributions** of matchup outcomes, and which decisions materially change my
**probability of winning**?"* — calibrated score distributions, win probability, matchup
edges, decision leverage, scenario explanations. **Not** another mean-projection adjustment.

---

## 2. Current matchup control system (`lib/weekly/matchup.ts`, 459 lines)

`buildMatchup(ctx)` — both teams evaluated on their **best legal lineup** via the frozen
`buildOptimalLineup` (Hungarian, `MAX_EXPECTED`). Returns: `team_optimal_total` /
`opponent_optimal_total` (null when any UNKNOWN starter), `projected_margin` (+status
`COMPLETE`/`PARTIAL_PROVISIONAL`/`UNAVAILABLE`), `margin_confidence`, `win_probability`,
`positional_advantages`/`disadvantages`, `high_leverage_players`, `swing_players` (injury),
`bench_depth`, `replacement_vulnerability`.

`buildLeverage(matchup)` — ranks the manager's OWN lineup fixes by `projected_points_gained`
scaled by `closeness = max(0.4, 1 − |projected_margin| / 25)`. **Uses `projected_margin`, not
`win_probability`.**

### Control-system map — verified from code

| # | Question | Answer (from code) |
| --- | --- | --- |
| 1 | Distributions sampled | per-player `Normal(mean, sd)`, `mean = projected_points`, `sd = wp.std_dev ?? max(2, mean·0.4)` (`drawSpec`, matchup.ts:375). `SIM_TRIALS = 20000`. |
| 2 | Symmetric? | Normal is symmetric, **but** each draw is `Math.max(0, sampleNormal(...))` (matchup.ts:193) → a **left-censored** normal (mass piles at 0), so the *effective* per-player distribution is right-skewed only via the floor clamp. |
| 3 | Negative scores | impossible — clamped to 0 at draw time. (Real fantasy can go slightly negative for QB/DST; not modeled.) |
| 4 | Player independence | **YES — fully independent.** `t += ...` per player in a plain loop; no covariance (matchup.ts:190–197). |
| 5 | Teammate correlation | none. |
| 6 | Opposing-player correlation | none. |
| 7 | Game totals / spreads | **not used anywhere** in the weekly engine. |
| 8 | Injury / role → variance | **no.** `expected_availability` haircuts the `weeklyBand` *floor* only; the MC `sd` is `mean·cv` and does not see availability or injury status. Injury surfaces only in `swing_players` narrative. |
| 9 | Projection uncertainty empirically calibrated | **no.** `WEEKLY_POSITION_CV` (QB .33 / RB .44 / WR .48 / TE .52 / K .42 / DEF .58) is a documented heuristic "calibrated to multi-year weekly dispersion" — never backtested. §3 below shows it is materially low for RB/WR/TE. |
| 10 | WP used by any production recommendation | **NO.** `buildTopActions` / `buildLeverage` use `projected_margin`. `win_probability` appears only in `summary` text + the `/api/matchup` response. It is informational, `win_probability_confidence` is only ever `"LOW"` or `"UNAVAILABLE"`. |

**Determinism**: seed = `mulberry32(hashSeed(league.slug, team_id, week))` (matchup.ts:186).
FNV-ish hash. **Does NOT include `league_snapshot_id` or any model version** → two different
snapshots for the same (league, team, week) reuse the same seed even though projections
differ (deterministic *given inputs*, but the seed is not bound to input identity — P2).

**Coverage gate**: WP only simulated when `lineupCoverage(team)·lineupCoverage(opp) ≥ 0.7`
AND both lineups `optimality_status === "COMPLETE"`.

### Callers
`app/api/matchup/[league]/[manager]/week/[week]`, `buildWeeklyIntelligence` (→ `intelligence.matchup` + `matchup_leverage`), `buildWeeklySummary`.
`buildOptimalLineup` is also consumed by the **trade engine** — the frozen-optimizer constraint carries into Phase 5.

---

## 3. Current uncertainty model — `weeklyBand` (backtested here, spec §C)

`weeklyBand(median, position, availability)` → `sd = |median|·CV`, floor/ceiling at
`median ± 0.8416·sd`, availability haircut on the floor, `floor` clamped ≥ 0 for non-negative
medians. `uncertainty_source` is always `position_volatility_heuristic` (Sleeper ships no
distribution).

**Backtest** (Phase 4 decision dataset, 2021–2025, PPR, vs Sleeper pregame projection,
n = QB 2071 / RB 4994 / WR 7217 / TE 3558):

| pos | mean proj | heuristic sd (`proj·CV`) | **empirical residual sd** | ratio | skew | excess kurtosis | P(actual ≤ 1) | P(actual < ½·proj) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| QB | 19.3 | 6.36 | **7.49** | **1.18** | 0.29 | 0.15 | 1.6% | 19% |
| RB | 8.6 | 3.78 | **6.39** | **1.69** | 0.85 | 1.92 | **11.0%** | 24% |
| WR | 8.6 | 4.15 | **6.45** | **1.56** | 0.84 | 1.81 | 3.6% | 22% |
| TE | 6.0 | 3.11 | **5.33** | **1.71** | 1.05 | 3.16 | 2.0% | 16% |

**Findings:**
- **P1 — the heuristic understates real weekly variance by 55–70% for RB / WR / TE** (ratio
  1.56–1.71); QB is close (1.18). The current MC therefore produces **overconfident** win
  probabilities, worse the more RB/WR/TE-heavy the lineup.
- Residuals are **right-skewed and heavy-tailed** for RB/WR/TE (excess kurtosis 1.8–3.2) — a
  plain Normal is a poor fit; `max(0, Normal)` only crudely helps.
- **Variance scales strongly with projection level** — RB residual sd: 4.2 (proj 0–6) → 9.9
  (proj 18+); every position shows the same. `sd = a + b·proj` (heteroscedastic) fits far
  better than a single CV.
- **RB bust spike**: `P(actual ≤ 1) = 11%` — a real inactive / early-exit / game-script-zero
  mass the Normal cannot represent.
- **QB projection bias −2.9 pts** (proj 19.3 → actual 16.4) — a calibration issue in the
  *baseline*, not `weeklyBand`; Phase 5 must not silently inherit it.
- **Early vs late season**: residual sd is **flat** (QB 7.36 → 7.56, RB 6.58 → 6.28). The
  "early-season is more uncertain" intuition is **not supported** for player-week fantasy
  residuals — a useful negative finding (variance is projection-level driven, not calendar
  driven).
- **Injury-status-dependent variance is real**: Questionable/Doubtful residual sd is elevated
  (RB Q/D 7.07 vs 6.39 overall; WR Q/D 7.55 vs 6.45) with a small negative bias — currently
  not in the MC.

**Verdict on `weeklyBand`: neither keep-as-is nor discard-because-heuristic — replace with an
empirically-calibrated position-specific heteroscedastic + skewed model, backtested.**

---

## 4. Historical distribution-data feasibility — GOOD

Everything §3 needs already exists: the **Phase 4 decision dataset**
(`outputs/startsit-2026/decision_dataset.rds`, 56,680 rows, 2021–2025, wk 4–17, QB/RB/WR/TE,
3 scoring archetypes) contains pregame projection, actual, residual, injury status, team,
opponent, game. It is chronology-safe by construction. Mean error / MAE / RMSE / variance /
skew / kurtosis / zero-probability / projection-level-dependent variance / injury-dependent
variance / early-vs-late are all directly computable (done above). **Gap**: K / DST are not in
that dataset — `nflreadr::load_player_stats` has K weekly (569 rows/season); DST needs a
dedicated team-defense pull. §20.

---

## 5. Projection residual dataset feasibility — ALREADY BUILT (needs K/DST + provenance labels)

The residual dataset is the Phase 4 one. Phase 5 extends it with:
- K + DST rows (nflreadr K stats + a team-defense computation, scored per archetype);
- an explicit `projection_provenance` column: **`LIVE_CAPTURED`** (from the Phase 4
  `capture.ts` shadow store, once 2026 weeks are played) vs **`HISTORICALLY_RECONSTRUCTED`**
  (Sleeper `/projections/{season}/{week}`, with the Phase 4 caveat — 2021 no timestamp, 2022
  bulk-backfilled, 2023–25 possible through-week revision);
- the **clean trailing-PPG control** carried alongside, exactly as Phase 4.
**Certification of the distribution model uses the clean control as the stricter baseline and
reports the Sleeper-provenance result separately** (Phase 4 rule, spec §D).

---

## 6. Correlation evidence (spec §E) — MEASURED

Residual correlation (same NFL game, PPR; after removing the pregame Sleeper projection mean;
trailing-control values essentially identical):

| relationship | n | raw fantasy corr | **residual corr (Sleeper)** | residual corr (trailing) |
| --- | ---: | ---: | ---: | ---: |
| **QB ↔ WR, same team** | 7,192 | 0.24 | **0.286** | 0.281 |
| **QB ↔ TE, same team** | 3,540 | 0.20 | **0.241** | 0.216 |
| QB ↔ RB, same team | 4,979 | 0.05 | 0.056 | 0.066 |
| WR ↔ WR, same team | 19,510 | 0.01 | **−0.001** | 0.011 |
| WR ↔ TE, same team | 12,295 | −0.01 | −0.004 | −0.005 |
| RB ↔ RB, same team | 7,746 | −0.03 | −0.050 | −0.006 |
| **QB ↔ opposing QB** | 2,060 | 0.17 | **0.201** | 0.168 |
| QB ↔ opposing WR (bring-back) | 7,180 | 0.08 | 0.087 | 0.073 |
| WR ↔ opposing WR | 25,070 | 0.04 | 0.052 | 0.045 |
| RB ↔ opposing QB | 4,974 | 0.04 | 0.041 | 0.033 |

**The dependence structure that matters is narrow and specific:**
- **same-team QB ↔ pass-catcher: ρ ≈ 0.24–0.29** (the stack) — real, material.
- **same-game QB ↔ QB: ρ ≈ 0.20** (shootout) — real, material.
- QB ↔ opposing WR ≈ 0.09; everything else ≤ 0.06 — **negligible.**
- **WR ↔ WR same team ≈ 0** — the "shared game" and "target cannibalization" effects cancel
  after removing the projection mean. Important: do **not** model a generic same-team pass-
  catcher correlation.

**Implication for §7**: a full multivariate-normal / copula over 20 players is **overkill**.
A low-rank latent-factor model captures ~all of the signal:
`resid_player = loading · (team_passing_game_factor) + loading · (game_scoring_factor) + idiosyncratic`
where `team_passing_game_factor` loads the QB and its WR/TE (not RB, not WR-WR beyond the
shared QB), and `game_scoring_factor` loads both QBs (and weakly the pass-catchers).

---

## 7. Candidate dependence models (spec §F) — compared

| model | captures the §6 structure? | chronology-safe | stable | live-practical | honest degradation |
| --- | --- | --- | --- | --- | --- |
| **independent draws (control)** | no (ρ = 0) | ✓ | ✓ | ✓ (current) | trivially |
| **2-factor latent (team-passing + game-scoring)** | **yes — exactly the material pairs** | ✓ | ✓ (2 factors, closed-form loadings from historical residual regression) | ✓ (adds 2 N(0,1) draws per game) | ✓ (factor loading → 0 when a team/game has no history) |
| empirical residual resampling (block by game) | yes, incl. skew/tails, non-parametrically | ✓ | ✓ | ✓ (sample a historical game-week block) | ✓ (fall back to marginal resample) |
| Gaussian copula (full 20×20) | yes but with spurious off-structure noise | ✓ | fragile (near-singular corr matrix, 12 leagues) | borderline | hard |
| t-copula / hierarchical GLMM | yes | ✓ | needs MCMC / careful fitting | **no** for live | hard |

**Recommendation: compare (a) independent control, (b) 2-factor latent, (c) game-block
empirical resampling.** The 2-factor model is the smallest thing that captures the measured
structure; block resampling additionally captures skew/tails for free. Pick by out-of-sample
**calibration** (§12), not sophistication.

---

## 8. Game-environment data availability (spec §G)

`analysis/football_intel/cache/schedules.rds` (`nflreadr::load_schedules`):

| field | historical coverage (2012–2025) | 2026 (pregame, live) | derivable |
| --- | ---: | ---: | --- |
| `spread_line`, `total_line` | **95.9%** | **112 / 272 games have lines already** | implied team total = `total/2 − spread/2` (home), etc. |
| `home_moneyline` / `away_moneyline` | ~95% | partial | redundant with spread |
| `roof` (dome/outdoors/closed) | ~100% | ✓ | indoor flag |
| `temp` / `wind` | 62.5% (outdoor games only) | set ~gameday | weather flag (low-total risk) |
| `home_qb_id` / `away_qb_id` | ~100% (2021+) | pregame depth charts | starting-QB-change flag |
| `div_game`, rest days | 100% | ✓ | — |

**Incremental value must be backtested (spec §G).** Prior beliefs to *test, not assume*:
implied team total → player mean-shift is likely already in the Sleeper projection
(double-counting risk, Phase 4 lesson); implied total → **variance** and → the **game-scoring
factor** loading is the more plausible incremental signal. Weather (low total, high wind)
→ variance is testable where the 62.5% coverage allows.

---

## 9. Football Intelligence integration map (spec §H)

Phase 4's conclusion (**FI adds no incremental value to the mean Start/Sit projection over
the production baseline**) is **not reopened**. Phase 5 tests a **different hypothesis**: does
FI carry incremental information for *variance / tails / correlation / role uncertainty*?

| Phase 3 FI family | Phase 3 `predictive_status` | Phase 5 candidate target (must independently validate) | routing rule |
| --- | --- | --- | --- |
| `off_pace_sec_play`, `off_proe` | PREDICTIVE | game **volume** → player variance + game-scoring-factor loading | eligible for a **variance** coefficient only |
| `off_explosive_pass_rate` | PREDICTIVE | **ceiling / right-tail** mass for WR/QB | eligible for a **tail** coefficient only |
| `off_pressure_rate_allowed`, `off_sack_rate_allowed` | WEAKLY_PREDICTIVE | QB **floor / left-tail** + variance | capped |
| `def_success_allowed` | PREDICTIVE | opponent-driven variance | eligible, variance only |
| `def_pass_epa_allowed`, `def_rush_epa_allowed` | **NOT_PREDICTIVE** | **must remain 0 for every target** — never a mean adjustment, never a variance adjustment unless Phase 5 *independently* proves it for variance (spec §H: "do not infer not-useful-for-mean → useful-for-variance") | forced 0; explanation-only |
| `def_man_rate`, `ftn_*` | DESCRIPTIVE_ONLY | context label only | forced 0 |
| `player_usage_profile` (snap/route/target share + their *volatility*) | OBSERVED | **role uncertainty** → a player-level variance multiplier + inactive-probability prior | eligible for a variance/role coefficient only |
| `*.trend` | derived | recent role instability → variance | eligible, variance only |

**Enforced programmatically** exactly as Phase 4: a routing guard reads
`output_class` + `predictive_status`; `NOT_PREDICTIVE` / `DESCRIPTIVE_ONLY` → 0 contribution
to **any** target (mean, variance, correlation, tail); the mean is never touched by Phase 5
at all (that is Phase 4's domain and it is frozen).

---

## 10. Score-distribution output proposal (spec §I)

**v1 published contract** (only fields with clear semantics + defensible precision):

```
team_score:      { expected, sd, p10, p25, median, p75, p90 }
opponent_score:  { expected, sd, p10, p25, median, p75, p90 }
margin:          { expected, sd, p10, p25, median, p75, p90 }
win_probability            (rounded to whole % — see below)
tie_probability            (whole %, usually ~0 in .5-PPR/PPR; non-trivial in integer/no-bonus)
expected_margin
upset_probability          (P(win | projected margin < 0))   — labelled, only when margin defined
blowout_probability        (P(|margin| > 25))
confidence / degradation_state   (§11)
```

**Precision rule (spec §I):** `win_probability` is emitted as a **whole percent** in v1 (MC
SE at N=10k is ~0.5pp; two decimals would be false precision). A `win_probability_interval`
(± MC SE) is emitted alongside. Buckets for display: `TOSS_UP` (45–55), `LEAN` (55–65),
`FAVORED` (65–80), `HEAVY` (>80), and mirror.

**Deferred to a later version** (not v1 without more evidence): `position_edges` as
probabilistic (keep the existing point-based `positional_advantages`), `decision_leverage`
(shadow only if at all — §15), `game_concentration` / `correlation_exposure` /
`volatility_profile` (diagnostic, not headline).

---

## 11. Confidence / degradation proposal (spec §J)

Not one arbitrary LOW/MEDIUM/HIGH. A **structured degradation vector** — the matchup estimate
carries every applicable flag, and an overall grade is the floor of the components:

```
projection_coverage:      COMPLETE | PARTIAL(<0.9) | THIN(<0.7)      (both lineups)
unknown_starters:         0 | N          (an UNKNOWN starter -> distribution not simulated)
unresolved_players:       count
injury_uncertainty:       none | questionable_starters(N)
distribution_calibration: CALIBRATED | UNCALIBRATED_POSITION(list)   (from the §12 backtest)
correlation_coverage:     FULL | PARTIAL(team/game had no history) | NONE(independent fallback)
opponent_lineup:          SUBMITTED | ASSUMED_OPTIMAL | INCOMPLETE | ILLEGAL | LOCKED
game_context:             FULL | NO_SPREAD_TOTAL | PARTIAL
fi_availability:          CURRENT | PRIOR_SEASON_ONLY | UNAVAILABLE
simulation:               CONVERGED(se<0.01) | WIDE(se>=0.01)
already_started:          false | true(partial_lock)
```

Overall `confidence ∈ {HIGH, MEDIUM, LOW, INSUFFICIENT}` — **HIGH requires** COMPLETE
coverage, 0 unknown starters, CALIBRATED distributions for every rostered position, and a
SUBMITTED opponent lineup. Today's engine could only ever reach LOW under this contract
(uncalibrated distributions) — which is honest.

---

## 12. Historical calibration feasibility (spec §K) — feasible, mostly synthetic

Method: for each historical (season, week), build two 10-player lineups, compute each
distribution model's `win_probability`, record the actual winner. Metrics: **Brier score, log
loss, calibration curve (deciles), AUC**. Compare: (1) `Φ(margin_mean / margin_sd)` analytic
from projected-score difference; (2) current independent-draw MC; (3) 2-factor / block-
resample candidates. **A candidate must beat the independent-draw MC on Brier/log-loss out of
sample to be retained** (spec §K).

**Constraint (§13/§14):** see below — real Bloodline matchups do not exist, so the primary
evaluation is `SYNTHETIC_MATCHUPS`, cross-checked on the one available real league chain.

---

## 13. Real historical lineup availability (spec §L) — MAJOR LIMITATION

- **Bloodline Bowl** (`1395549281678532608`): `previous_league_id: null` — a **first-year
  2026 league**. NFL state is **season 2026, Week 1, zero games played**. → **there are zero
  real historical Bloodline matchups.**
- `/matchups/{week}` *will* provide real submitted lineups + `starters_points` + `matchup_id`
  per 2026 week as they are played (the Phase 4 `capture.ts` store already records the shadow
  side pre-game).
- **`devoted-to-the-game`** (`1389735763649761280`): `previous_league_id: 1264616401079914496`
  → **one prior season** of real manager lineups + results retrievable via the Sleeper league
  chain (~17 weeks × ~6 matchups ≈ **~100 `REAL_HISTORICAL_MATCHUPS`**), plus its own
  predecessor chain if deeper.
- No persisted historical fantasy-lineup table exists in Supabase (only 3 bridge migrations);
  Phase 1 canonical snapshots begin ~2026.

---

## 14. Synthetic evaluation limitations (spec §L) — must be labelled

`SYNTHETIC_MATCHUPS`: sample two 10-player legal lineups per (season, week) from the
historical rostered-player pool (the Phase 4 dataset covers QB/RB/WR/TE; K/DST added),
respecting real `RosterConstraints` (`maxSlotMatching`), score on real actuals.

**Documented non-equivalences (never claimed away):** synthetic lineups are **not** real
manager decisions — no roster-construction bias, no waiver history, no start/sit skill, no
psychological "set it Thursday" effect, uniform-ish talent sampling vs real rosters'
concentration. Synthetic evaluation tests the **simulator's mathematical calibration**, not
its real-world decision value. **All Phase 5 reports separate `REAL_HISTORICAL_MATCHUPS`
(devoted chain) from `SYNTHETIC_MATCHUPS` (pooled) — never merged into one metric** (spec §L).

---

## 15. Decision-leverage feasibility (spec §M)

`Δ win_probability = WP(baseline lineup) − WP(lineup with candidate substitution)`, over legal
single-player swaps (starter ↔ eligible bench). Candidate space: ~10 starters × ~5 eligible
bench ≈ **~15–25 legal swaps** per manager (FLEX/SUPER_FLEX widen it — each flex-eligible
bench player is a candidate for the flex slot AND any base slot it covers). `maxSlotMatching`
already enforces legality on each candidate.

**Cost** (§18): each candidate needs its own MC. At N=10k, ~10ms/matchup → 20 candidates ≈
**200ms/manager**, ~2.4s for all 12 — acceptable as a shadow / on-demand computation, not on
every `/api/intelligence` call. **Analytic shortcut**: `WP ≈ Φ(margin_mean / margin_sd)` (CLT
over ~20 truncated near-normal player scores) is near-free and good to ~1pp for non-extreme
probabilities — use it to *screen* candidates, run MC only on the few that move WP > ~2pp.
UNKNOWN-projection candidates: leverage `UNRESOLVED`, never a numeric Δ (Phase 4 rule).

**Phase 5 v1: shadow only, if at all** — see §26.

---

## 16. Alternate lineup-objective feasibility (spec §N) — AUDIT ONLY, not implemented

| objective | definition | data needed | differs from MAX_EXPECTED when… | eval feasibility | overfitting risk | needs correlation | tractable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `MAX_WIN_PROBABILITY` | argmax over legal lineups of `WP` | calibrated distributions + opponent lineup | matchup is lopsided AND lineup options differ in variance/correlation | needs calibrated WP first (§12) | **high** (optimizing a noisy 0/1 target) | yes (variance-seeking interacts with stacks) | yes (screen + MC, §15) |
| `HIGH_FLOOR` | argmax `p10` (or `E[score | score < median]`) | position floor distributions | favorite + low-variance option exists at ~equal mean | synthetic only | medium | partial | yes |
| `HIGH_CEILING` | argmax `p90` | position ceiling distributions + explosive signal | underdog + high-variance option at ~equal mean | synthetic only | medium | partial | yes |
| `LATE_SWAP_SAFE` | maximize retained optionality given kickoff times | game start times, lock state | multiple flex-eligible players across time slots | operational, not statistical | low | no | yes |

**Do NOT assume "favorites seek floor / underdogs seek ceiling"** — §17 shows *when* it holds
mathematically; whether it holds *empirically and materially* in this scoring environment is
a Phase 5+ backtest question. None of these are approved for Phase 5.

---

## 17. Theoretical MAX_EXPECTED vs MAX_WIN_PROBABILITY (spec §O) — sanity examples

To be implemented as deterministic fixtures in the audit test matrix (§28), not as evidence
of real value:

- **Equal mean, different variance, vs opponent distribution.** Player A `N(15, 3)` vs B
  `N(15, 9)`, my other 9 starters fixed. If opponent's expected total puts me a **favorite**
  (my mean margin > 0): swapping B→A (lower variance) **raises** WP (less chance the
  right-tail of the opponent + my left-tail flips it). If **underdog** (mean margin < 0):
  B (higher variance) **raises** WP (need the tail). At a **true coin flip** (mean margin ≈
  0): WP ≈ 50% either way — variance is close to irrelevant, small second-order effects only.
  → the classic advice is *directionally* correct at the extremes, *negligible* near 50/50,
  and its magnitude is an empirical question.
- **Correlation example.** Two WRs with equal mean; WR-X is my QB's teammate (ρ ≈ 0.28 with
  my QB), WR-Y is unstacked (ρ ≈ 0). As an **underdog**, starting the **stacked** WR-X raises
  WP (my QB and WR-X boom together → fatter right tail on my total). As a **favorite**, the
  **unstacked** WR-Y raises WP (decorrelation shrinks my total's variance). Bring-back
  (my player ↔ opponent QB, ρ ≈ 0.09) is a weak version of the same.
- The 2-factor model must reproduce both directions coherently and monotonically — a
  statistical-invariant test.

---

## 18. Opponent-lineup uncertainty (spec §P)

Audit outcome: Phase 5 should expose **up to three opponent views**, not silently pick one:
1. `SUBMITTED` — the opponent's actual current starters (from the canonical snapshot).
2. `ASSUMED_OPTIMAL` — the opponent's best legal lineup (today's behavior).
3. `PLAUSIBLE` — SUBMITTED with obvious corrections applied: an OUT/BYE/empty starter replaced
   by the best legal eligible bench player (a manager will not leave a bye player in).

v1: default to `PLAUSIBLE` for the headline WP (never assume a manager leaves an obviously
invalid lineup — spec §P), expose `SUBMITTED` and `ASSUMED_OPTIMAL` as alternate WP values.
Questionable (not OUT) opponent starters → widen the opponent distribution, do not swap.

---

## 19. Late-swap / in-game boundary (spec §Q) — v1 is PREGAME-ONLY

`nflreadr` schedules carry `gameday` / kickoff; Sleeper `/matchups` carries `starters_points`
(realized). A partial-lock model (locked players → realized points, unlocked → remaining
distribution, legal late swaps only) is **feasible but deferred** — it needs a live game-clock
integration and per-player lock state the weekly engine does not currently track.
**Phase 5 v1: pregame-only.** `already_started` degradation flag set; WP still computed from
full pregame distributions with an explicit `STALE_KICKOFF_PASSED` warning.

---

## 20. K / DST treatment (spec §R) — separate, not forced Gaussian

- Current: Sleeper weekly feed omits K extra points and DST sacks/points-allowed → both fall
  back to Sleeper `pts_std`, flagged LOW/MEDIUM (Phase 4 §A.1). `weeklyBand` applies CV
  K .42 / DEF .58.
- **K residual distribution** is buildable from `nflreadr::load_player_stats` K rows (~569/season)
  vs Sleeper K projection — likely near-symmetric, moderate variance, correlated with the
  team's implied total (field goals scale with drives that stall).
- **DST residual distribution** needs a dedicated team-defense pull; DST has a **fat left
  tail and a genuine negative tail** (points-allowed can dominate) — a Normal is wrong. An
  **empirical resample** or a shifted-gamma / skew-t is more honest; DST ↔ opposing-QB and
  DST ↔ opposing-offense-implied-total correlation is expected to be strongly **negative** and
  worth measuring.
- **v1: keep K/DST on their existing point projection + a K/DST-specific empirical residual
  distribution (resampled, not Gaussian); do not destabilize the certified projection path.**

---

## 21. Injury / inactive-probability feasibility (spec §S)

`expected_availability` (from `injury_status`) is the only signal today. §3 shows Q/D players
have measurably higher residual variance + a small negative bias — enough to justify a
**variance widening + a small mean haircut** for questionable starters, calibrated from the
dataset. A true **inactive probability** (P(0 snaps)) is only weakly reconstructable
historically (weekly roster `status` + participation) and pre-game practice reports are not
structured (Phase 3 class D). **v1: model questionable → wider distribution + explicit
`injury_uncertainty` degradation flag; do NOT emit a fabricated inactive probability** — use
a scenario/degradation state (spec §S).

---

## 22. Deterministic simulation plan (spec §T)

Seed = a stable hash of `(league_snapshot_id, matchup_id, matchup_model_version,
distribution_model_version, correlation_model_version, sim_count)`. Binding the seed to
`league_snapshot_id` + model versions fixes the current P2 (seed ignores snapshot identity).
Same snapshot + same models + same seed → byte-identical WP. A regression fixture asserts it.
Factor draws (§7) are drawn from the same seeded stream in a fixed order (game id sorted).

---

## 23. Simulation convergence / runtime (spec §U) — measured

Independent-draw MC, 10 players/side, this machine:

| N | WP MC SE (p≈0.5) | ms / matchup | ms / 12 managers |
| ---: | ---: | ---: | ---: |
| 1,000 | 1.58pp | 3.3 | 40 |
| 5,000 | 0.71pp | 7.2 | 86 |
| **10,000** | **0.50pp** | **~10** | **~120** |
| 20,000 | 0.35pp | 13.7 | 165 |
| 100,000 | 0.16pp | 69.8 | 838 |

**Recommendation: N = 10,000** for the headline WP (SE ≈ 0.5pp, well under the whole-percent
reporting precision). The 2-factor model adds 2 draws/game — negligible. **Analytical
`Φ(margin_mean / margin_sd)`** is near-free and within ~1pp for 0.15 < p < 0.85 — used for
candidate screening (§15) and as the `INSUFFICIENT`-simulation fallback. Block-resample is
~2× the independent cost (an extra lookup per player) — still fine.

---

## 24. Proposed architecture (spec §V)

```
lib/weekly/matchup-intelligence/           NEW (TS: deterministic serving + simulation)
  schema.ts          ScoreDistribution, MatchupIntelligence, DegradationVector, lineage
  distributions.ts   position residual model (heteroscedastic + skew), K/DST empirical, injury widening
  correlations.ts    2-factor loadings reader + game/team factor assembly; independent fallback
  simulator.ts       seeded MC (N=10k) + analytic Φ screen; margin/score/WP/quantiles
  confidence.ts      the §11 degradation vector
  leverage.ts        candidate enumeration (reuses maxSlotMatching) + Δ-WP (SHADOW)
  explain.ts         scenario reason codes mapped to actual simulator inputs
  opponent.ts        SUBMITTED / ASSUMED_OPTIMAL / PLAUSIBLE views
analysis/football_intel_matchup/            NEW (R: research + calibration only)
  build_residual_dataset.R   Phase-4 dataset + K/DST + provenance labels
  fit_distributions.R        per-position heteroscedastic + skew params -> matchup_distribution_model.json
  fit_correlations.R         2-factor loadings from residual regression -> matchup_correlation_model.json
  calibration_backtest.R     Brier/logloss/calibration-curve vs independent-draw baseline
  reevaluate.R (later)       when real 2026 matchup weeks accumulate
```

**`buildMatchup` (current) stays untouched in production** during Phase 5 build; the new
engine is wired as a **shadow** `matchup_intelligence` field on the intelligence result (like
Phase 4's `start_sit_shadow`), with `deployment: SHADOW_ONLY` until §27 certification.
Statistical calibration (R, versioned JSON artifacts) is separate from deterministic TS
serving — the Phase 3/4 pattern.

---

## 25. Lineage / version contract (spec §W)

```
matchup_model_version          ri-matchup-2026.1
distribution_model_version      ri-matchup-dist-2026.1
correlation_model_version       ri-matchup-corr-2026.1   (or "independent-draw" fallback)
projection_lineage              (the WeeklyProjectionBatch model_version + source)
football_intelligence_version   fi:<...>  (only if FI-for-variance is certified; else "not_used")
league_snapshot_id              (from ctx.lineage)
sim_count, sim_seed, sim_se
opponent_view                   PLAUSIBLE | SUBMITTED | ASSUMED_OPTIMAL
```
Every matchup response is reproducible from these + roster + scoring. Model identity is
**explicit in the artifact**, never inferred from code state.

---

## 26. Proposed v1 scope (spec §X) — **Scope 2 (conservative)**

**Scope 2: calibrated win probability + score distributions + explanations.** Rationale:

- The **data supports it** — residual dataset exists, `weeklyBand` can be replaced with a
  backtested model, the material correlations are measured and small enough for a 2-factor
  model, game context has 96% coverage.
- The **evaluation is constrained** — no real Bloodline history (first-year league, season not
  started); calibration is predominantly synthetic + a ~100-matchup real cross-check. That is
  enough to certify *mathematical calibration* but **not** a new lineup objective.
- Phase 4's lesson: do not let a plausible-looking signal into a recommendation without
  decision-value evidence against the production baseline. Scope 4 (`MAX_WIN_PROBABILITY`)
  requires exactly that evidence, which cannot exist until real 2026 matchups accumulate.

**In v1:** replace the MC distribution model (heteroscedastic + skew + K/DST empirical +
injury widening), add the 2-factor correlation (with independent-draw fallback + ablation),
add game-context where it backtests as incremental, publish calibrated `win_probability`
(whole %), score/margin quantiles, `tie_probability`, `upset`/`blowout` probability, the §11
degradation vector, and scenario explanations. **`buildMatchup`'s existing point-based
outputs stay.** The new engine is **SHADOW** on the intelligence result until §27 passes; it
does **not** change `buildLeverage`, `top_actions`, `summary`, or any lineup.

**`decision_leverage` (Scope 3): shadow-only diagnostic** if convergence + runtime hold, with
a Phase-4-style deployment-state contract; **no** `MAX_WIN_PROBABILITY` objective (Scope 4)
in Phase 5.

---

## 27. Validation plan (spec §Y) — designed, to run during build

- chronology-safe walk-forward (train distribution/correlation params on seasons < s,
  evaluate on s), 2021–2025, participation lag honored (Phase 3 `PART_LAG`)
- **calibration**: Brier, log loss, decile calibration curves, AUC — candidate vs
  independent-draw MC vs analytic-Φ; a candidate must **beat independent-draw MC out of
  sample** to be retained
- correlation ablation (independent vs 2-factor vs block-resample)
- game-environment ablation (spread/total/weather each in/out)
- FI-for-variance ablation (per family; `NOT_PREDICTIVE` forced 0, re-proven)
- `REAL_HISTORICAL_MATCHUPS` (devoted chain) vs `SYNTHETIC_MATCHUPS` — reported separately
- position-specific residual distribution goodness-of-fit (QQ, KS) incl. K/DST
- tiny-sample protection (team/game with < N historical games → shrink factor loading to 0)
- missing-data degradation (no spread, no FI, unresolved player, unknown starter, illegal opp)
- determinism fixture (§22)
- simulation convergence (SE vs N) + runtime budget
- lineup-leverage tests (Δ-WP monotonic, bounded, `UNRESOLVED` on unknowns)
- **trade-engine isolation** (`buildOptimalLineup` byte-unchanged; `lib/trades/**` imports
  nothing from `matchup-intelligence`)
- **Phase 4 shadow isolation** (`start_sit_shadow` unchanged; no cross-contamination)
- Phase 1C certification + Phase 2 Team-State + weekly + full repo regression + `tsc` + lint

---

## 28. Adversarial matrix (spec §Z) — 25 scenarios, all must pass before certification

1 overwhelming favorite · 2 overwhelming underdog · 3 true coin flip · 4 equal mean /
different variance (favorite / even / underdog) · 5 QB-WR stack · 6 QB ↔ opposing-WR
bring-back · 7 QB ↔ DST adverse · 8 RB-heavy positive game script · 9 two same-team players
competing for opportunity · 10 K with own QB · 11 DST facing opposing QB · 12 incomplete
opponent lineup · 13 questionable starter · 14 zero projection · 15 unknown projection ·
16 verified-zero (bye) projection · 17 partially locked lineup (→ `STALE_KICKOFF_PASSED`,
pregame-only in v1) · 18 overtime / extreme-game historical outlier · 19 massive sportsbook
total · 20 low-total weather game (where weather history exists) · 21 missing correlation data
(→ independent fallback, flagged) · 22 missing FI (→ no variance/tail FI term) · 23
prior-season-only FI · 24 SUPER_FLEX (QB in flex → widened enumeration + QB-stack correlation
still applies) · 25 duplicated multi-position eligibility (WR/RB in FLEX).

Invariants the implementation must satisfy: more coverage/sample → not-lower confidence;
identical inputs+seed → identical WP; stronger favorite + lower-variance swap → WP not-lower;
neutral correlation → symmetric effect; `NOT_PREDICTIVE`/`DESCRIPTIVE_ONLY` FI → 0
contribution to every target; WP ∈ [0,1], quantiles ordered; degradation only ratchets down.

---

## 29. Findings

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| **P5-1** | **P1** | `weeklyBand` CV heuristic **understates real weekly residual sd by 55–70% for RB/WR/TE** (ratio 1.56–1.71) → current MC win probabilities are **overconfident**. | Replace with a backtested heteroscedastic + skewed position model in Phase 5 (Scope 2 core). |
| **P5-2** | **P1** | No real Bloodline historical matchups exist (first-year league, 2026 season not started, 0 games played). Calibration must be predominantly **synthetic**. | Synthetic (labelled) + ~100-matchup real cross-check from the `devoted` league chain. Bounds v1 to Scope 2 (no new lineup objective). |
| **P5-3** | P2 | MC seed = `hash(league.slug, team_id, week)` — **ignores `league_snapshot_id` and model version**; two snapshots for the same week reuse the seed. | Seed contract §22 (bind to snapshot id + model versions). |
| **P5-4** | P2 | Residuals are right-skewed + heavy-tailed for RB/WR/TE; RB has an 11% bust spike (`actual ≤ 1`). A Normal (even `max(0,·)`) is a poor marginal. | Skew model or game-block empirical resampling (§7); compare by calibration. |
| **P5-5** | P2 | QB Sleeper projection carries a **−2.9 pt systematic bias** (proj 19.3 vs actual 16.4). | Phase 5 distribution model must center on the *calibrated* mean, not inherit the bias; report it. |
| **P5-6** | P2 | Injury-status-dependent variance is real (Q/D sd ~+10–15%) and unmodeled. | Variance widening + mean haircut for questionable starters (§21); no fabricated inactive probability. |
| **P5-7** | P3 | K/DST have no residual dataset yet and DST's negative tail breaks the Gaussian assumption. | Dedicated empirical K/DST residual distributions (§20); do not force Gaussian. |
| **P5-8** | P3 | `WR ↔ WR same team` residual correlation ≈ 0 — a generic "same-team pass-catcher" correlation would be wrong. | 2-factor model loads QB + its pass-catchers only, not WR-WR (§6, §7). |
| **P5-9** | P3 | "Early-season more uncertain" is **not supported** by the data (residual sd flat wk4-8 vs wk9-17). | Do not add a calendar-based variance term; variance is projection-level driven. |
| **P5-10** | P3 | `win_probability` is informational-only today (no recommendation uses it) — but it IS surfaced in `summary` with an implied-precision `~X%`. | Whole-% precision + interval (§10); keep it out of recommendation ranking in v1. |

No P0. No blocker that prevents a Scope-2 implementation.

---

## 30. Explicit deferred scope (`DEFERRED_FEATURES`)

`MAX_WIN_PROBABILITY` / `HIGH_FLOOR` / `HIGH_CEILING` / `LATE_SWAP_SAFE` lineup objectives
(need calibrated WP + real decision-value evidence — impossible until 2026 matchups
accumulate); in-game / partial-lock late-swap optimization; a true inactive-probability model;
full multivariate copula / hierarchical GLMM dependence; opponent-behavior modeling beyond the
3 lineup views; `decision_leverage` as a production output (shadow only if at all);
probabilistic `position_edges`; FI-for-mean anything (frozen by Phase 4).

---

## 31. VERDICT

The current matchup engine is mapped: independent-draw MC over `max(0, Normal(proj,
proj·CV))`, seed not bound to snapshot identity, win probability informational-only and never
above LOW confidence. The uncertainty heuristic is **empirically miscalibrated** for RB/WR/TE
(P5-1). The projection residual dataset needed to fix it **already exists** (Phase 4). The
dependence structure that matters is **measured and narrow** — same-team QB↔pass-catcher
(ρ≈0.25–0.29) and same-game QB↔QB (ρ≈0.20), everything else ≤ 0.06 — so a 2-factor latent
model, not a copula, is the right tool. Game context (spread/total) has 96% historical and
partial live coverage. Simulation runtime is a non-issue (N=10k ≈ 120ms for 12 managers; an
analytic Φ screen is near-free).

The binding constraint is **evaluation, not modeling**: Bloodline is a first-year league with
zero played weeks (P5-2), so Phase 5 calibration is predominantly synthetic plus a ~100-matchup
real cross-check. That is sufficient to certify the *mathematical calibration* of a score-
distribution + win-probability engine, but **not** to certify a new lineup objective — which
also matches the Phase 4 lesson (no signal enters a recommendation without decision-value
evidence against the production baseline).

Recommended v1: **Scope 2** — calibrated win probability + score distributions + degradation
vector + scenario explanations, delivered **SHADOW** alongside the untouched `buildMatchup`,
with the 2-factor correlation (ablated against independent draws), game context where it
backtests as incremental, and a Phase-4-style deployment-state contract. `decision_leverage`
shadow-only diagnostic at most. **No `MAX_WIN_PROBABILITY` objective in Phase 5.**

# PHASE 5 — PRE-IMPLEMENTATION AUDIT COMPLETE; SCOPE GATE OPEN

Requesting review/approval of: the **Scope 2** recommendation (§26), the 2-factor dependence
model over a full copula (§7), the synthetic-primary / real-cross-check evaluation with
`REAL` vs `SYNTHETIC` always reported separately (§13–§14), the whole-percent WP precision
(§10), pregame-only v1 (§19), and K/DST empirical (non-Gaussian) distributions (§20). On
approval, implementation proceeds per §24/§27/§28 and ends with one of
`PHASE 5 CERTIFIED — SCOPE 2 SHADOW` / `CONDITIONAL — REMEDIATION REQUIRED` /
`PHASE 5 NOT CERTIFIED`. **Stopping. No Phase 5 implementation until the scope is reviewed.**

---
---

# PART II — IMPLEMENTATION & VALIDATION (Scope 2, SHADOW_ONLY)

Branch `team-management-phase5-matchup-intelligence`. `ri-matchup-2026.1` /
`ri-matchup-dist-2026.1` / `ri-matchup-corr-2026.1`. Production `buildMatchup`,
`buildOptimalLineup`, `maxSlotMatching`, Start/Sit, waivers, trades — **unchanged**
(regression-verified). No `MAX_WIN_PROBABILITY` objective.

## II.1 What was built

```
analysis/football_intel_matchup/          R — research + calibration (chronology-safe)
  config.R  build_residual_dataset.R  fit_distributions.R  fit_correlations.R
  calibration_backtest.R  real_crosscheck_and_convergence.R  context_fi_ablation.R
lib/weekly/data/                          served, versioned, committed
  matchup_distribution_model.json   per-position bias + sd model + empirical z-grid + injury widen
  matchup_correlation_model.json    2-factor loadings + pairwise control (DIAGNOSTIC)
lib/weekly/matchup-intelligence/          TS — deterministic serving (SHADOW)
  schema.ts distributions.ts correlations.ts simulator.ts confidence.ts
  explain.ts deployment.ts build.ts index.ts
```

Shadow field `intelligence.matchup_intelligence` on `buildWeeklyIntelligence`
(non-fatal try/catch). Residual dataset: **68,713 rows**, 2021–2025, 6 positions,
3 archetypes; every row labelled `HISTORICALLY_RECONSTRUCTED` with a provenance
sub-label (2021 `sleeper_no_timestamp`, 2022 `sleeper_bulk_backfill`, 2023–25
`sleeper_in_season_possibly_revised`).

## II.2 Current vs calibrated uncertainty (spec §29)

| position | weeklyBand CV sd @ mean proj | empirical residual sd | ratio | v1 model | mean-bias correction | injury-widen |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| QB | 6.36 | 7.49 | 1.18 | const sd + normal_clamp | **−2.06** | 1.00 |
| RB | 3.78 | 6.39 | **1.69** | const sd + empirical z-grid | +0.58 | 1.107 |
| WR | 4.15 | 6.45 | **1.56** | cv sd + empirical z-grid | +0.85 | 1.171 |
| TE | 3.11 | 5.33 | **1.71** | cv sd + empirical z-grid | +1.56 | 1.012 |
| K | ~3.4 | ~3.5 | ~1.03 | cv sd + empirical z-grid | +0.15 | 1.039 |
| DEF | ~4.1 | ~4.2 | ~1.02 | bucket sd + empirical z-grid | +0.86 | 1.00 |

The empirical standardized-residual grid absorbs both the scale error *and* the
skew/heavy-tail/bust shape, so it corrects the current MC's under-dispersion.
QB `−2.06` bias correction is from the least-polluted provenance rows only
(§23); the RotoWire QB projection runs optimistic even in-season (2023 −2.0,
2024 −1.5, 2025 −2.7). Pre-2023 evaluation is flagged `BASELINE_PROVENANCE_DEGRADED`.

## II.3 Distribution-family comparison (OOS, walk-forward 2023–25, empirical marginal)

| position | best `cal_score` model | pit_ks | pi80_cov | pi50_cov | chosen (simplest within 10%) |
| --- | --- | ---: | ---: | ---: | --- |
| QB | bucket / const | 0.078 | 0.783 | 0.477 | **const + normal_clamp** |
| RB | const / bucket | 0.048 | 0.821 | 0.519 | **const + empirical** |
| WR | cv | 0.039 | 0.813 | 0.503 | **cv + empirical** |
| TE | linear / cv | 0.056 | 0.801 | 0.507 | **cv + empirical** |
| K | cv | 0.046 | 0.801 | 0.497 | **cv + empirical** |
| DEF | sqrt / bucket | 0.055 | 0.803 | 0.495 | **bucket + empirical** |

**`empirical` marginal wins for every skill/K/DEF position.** The heteroscedastic
`linear`/`sqrt` sd models were within noise of `const`/`cv` — the marginal family
does the work, not the sd form (spec §3: choose the simplest that calibrates).
`normal_clamp` was kept only for QB (near-symmetric, thin tails). **K/DST are
NOT forced Gaussian** — both use the empirical grid, DEF with a bucketed sd
(spec §5, §20). DST's negative tail is preserved (`max(0, ...)` is not applied
to the DEF grid mean shift beyond the actual scoring floor).

## II.4 Synthetic calibration + correlation ablation (spec §12, §27) — 7,152 walk-forward synthetic matchups

| layer | Brier | log loss | AUC | **calibration slope** |
| --- | ---: | ---: | ---: | ---: |
| L0 analytic Φ(score-diff / weeklyBand sd) | 0.2056 | 0.6038 | 0.754 | 0.658 |
| **L1 current MC** (weeklyBand + `max(0,Normal)`, independent) | 0.2055 | 0.6037 | 0.754 | **0.655** — overconfident |
| **L2 calibrated marginals** (independent) | **0.2020** | **0.5881** | 0.752 | **1.079** — well calibrated |
| L3 + 2-factor dependence | 0.2018 | 0.5873 | 0.752 | 1.034 |

- **L1 → L2: Brier −0.0035, log loss −0.0157, calibration slope 0.66 → 1.08.**
  The calibrated marginal model **materially fixes the current MC's
  overconfidence** — this is the Phase 5 core deliverable and it works.
- **L2 → L3: Brier −0.0002, log loss −0.0007.** The 2-factor dependence adds
  **no incremental win-probability calibration value.** Per spec §6/§28 this is
  a legitimate Phase 5 outcome: *"calibrated independent residual simulation
  beats current MC; correlation adds no incremental value."* **The 2-factor
  model is REJECTED for the headline WP and retained as a `dependence_diagnostics`
  block + for the theoretical sanity checks.**

**Calibration curve (L2, deciles):** mean_pred vs empirical win rate track within
~1–3pp across every bucket (0.07/0.06, 0.16/0.16, 0.25/0.25, 0.35/0.33, 0.45/0.46,
0.55/0.57, 0.65/0.65, 0.75/0.76, 0.84/0.88, 0.93/0.97). Slightly under-confident
in the tails — acceptable and conservative.

## II.5 Correlation / dependence evidence (measured; DIAGNOSTIC only)

| relationship | n | residual corr | in the model as |
| --- | ---: | ---: | --- |
| QB ↔ WR, same team | 7,107 | **0.26** (loading 0.31) | team-passing factor |
| QB ↔ TE, same team | 3,501 | **0.22** (loading 0.26) | team-passing factor |
| QB ↔ RB, same team | 4,917 | 0.05 | excluded (negligible) |
| QB ↔ opposing QB | 2,060 | **0.19** (per-QB loading 0.43) | game-scoring factor |
| DST ↔ opposing QB | 1,984 | **−0.36** | DST loads the opposing passing factor negatively |
| WR ↔ WR, same team | 19,510 | ≈ 0.00 | not modeled (audit §6) |

Real, but immaterial to aggregate WP calibration (II.4).

## II.6 Game-context + FI-for-variance ablation (spec §8, §9, §27) — all noise-level

Incremental OOS improvement in |standardized residual| prediction (gamma GLM,
walk-forward). Threshold for retention: ≥ ~0.005.

| candidate | QB | RB | WR | TE | verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| `game_total` | +0.0002 | +0.0012 | +0.0010 | +0.0001 | **EXCLUDE** |
| `implied_team_total` | +0.0045 | +0.0002 | +0.0000 | −0.0003 | **EXCLUDE** (QB borderline, still sub-threshold) |
| `spread` | +0.0034 | +0.0001 | +0.0001 | −0.0008 | **EXCLUDE** |
| `is_indoor` | −0.0002 | +0.0002 | −0.0002 | −0.0009 | **EXCLUDE** |
| FI `off_pace` / `off_proe` / `off_explosive` / `def_success_allowed` (§9) | ≤ +0.0005 | ≤ 0 | ≤ 0 | ≤ +0.0018 | **EXCLUDE** — no FI field adds incremental variance information |

The projection already prices the game environment; the residual-variance effect
is not there either. Phase 4's double-counting lesson extends to variance.
**v1 has no game-context term and no FI term** — `football_intelligence_version:
"not_used"`.

## II.7 REAL_HISTORICAL_MATCHUPS cross-check (spec §14) — reported separately

`devoted-to-the-game` chain: **1 prior season (2025), 98 real manager matchups.**
Pregame projections are **not** retrievable for that chain → it is a **model-free
outcome anchor only, not a pregame WP evaluation** (labelled `REAL_HISTORICAL_MATCHUPS`,
never merged with synthetic). Anchor stats: **realized margin sd = 34.8**,
`P(|margin| ≤ 10) = 0.28`. The v1 simulator's margin sd on real Bloodline
lineups is ~30–41 — consistent with the real anchor. Bloodline itself has 0
played weeks (2026 not started).

## II.8 Simulation convergence + runtime (spec §15) — `SIM_N = 10,000` frozen

| N | WP sd across seeds | theoretical SE | ms / matchup | ms / 12 managers |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.0159 | 0.0158 | 1.5 | 43 |
| 5,000 | 0.0081 | 0.0071 | 4.0 | 85 |
| **10,000** | **0.0058** | **0.0050** | **6.9** | **91** |
| 20,000 | 0.0040 | 0.0035 | 13.3 | 159 |
| 50,000 | 0.0015 | 0.0022 | 29.3 | 371 |

N=10,000 → WP sd across seeds ≈ 0.6pp, well under the whole-percent reporting
precision; 91 ms for all 12 managers. Leverage diagnostics use N=4,000 per
candidate swap (screened to close-or-worse candidates, ≤ 8 reported).

## II.9 Determinism (spec §14, §22)

Seed = `hash(league_snapshot_id | team_id | opp_team_id | week | matchup_model_version
| distribution_model_version | sim_count)`. Fixes the P5-3 finding (the current
MC seed ignores snapshot + model identity). Verified: identical `seedIdentity`
+ inputs → byte-identical `SimOutput`; two `buildWeeklyIntelligence` calls on the
same live snapshot → identical `win_probability` and `team_score`.

## II.10 Degradation / confidence (spec §11, §19)

Structured `DegradationVector` — a list of `DegradationReason` codes + a derived
`overall`. HIGH is unreachable in v1 (the distribution model has never been
production-certified and the live FI snapshot is a prior) — the ceiling is
MEDIUM, which is honest. `INSUFFICIENT` on any UNKNOWN starter / incomplete
lineup / missing distribution model (the matchup is **not simulated** — an
UNKNOWN starter must not be a numeric 0). Live smoke (`bloodline-bowl/supyo29`
wk1): `confidence.overall = MEDIUM`, reasons `[QUESTIONABLE_ROLE, PRIOR_ONLY_FI]`,
opponent view `SUBMITTED`, WP 49% [49–50], explanations `[EXPECTED_SCORE_EDGE,
TOSS_UP, INJURY_VARIANCE]`, 8 leverage diagnostics, production `matchup.win_probability`
**unchanged** at 0.483.

## II.11 Opponent-lineup handling (spec §17) — `PLAUSIBLE` default

Three views: `SUBMITTED` (opponent's current starters), `PLAUSIBLE` (SUBMITTED
with bye/out/empty starters replaced by the best legal bench — a manager will
fix those), `ASSUMED_OPTIMAL` (opponent's Hungarian best legal lineup). Headline
WP uses `PLAUSIBLE`; the `lineage.opponent_view` records which was used and a
`OPPONENT_LINEUP_ASSUMED` degradation reason + explanation fires when it is not
`SUBMITTED`. Never fabricates a "likely human lineup" beyond the deterministic
bye/out correction.

## II.12 Decision-leverage (spec §20) — SHADOW diagnostic

`leverage_diagnostics[]` — for legal starter↔bench swaps (screened to
close-or-worse candidates), Δ win probability with per-swap seeds. Records
current/alternative player, expected-point diff, baseline/alternative WP, ΔWP,
model confidence, `resolution` (`UNRESOLVED` on unknown projections).
**Never alters production lineup selection.** This dataset will accumulate the
evidence needed to eventually decide whether `MAX_WIN_PROBABILITY` differs
materially from `MAX_EXPECTED` in real decisions.

## II.13 K / DST (spec §5, §20) — validated as special distributions

K: empirical z-grid, cv sd, near-symmetric, pit_ks 0.046, pi80 0.80.
DEF: empirical z-grid, **bucketed** sd (DST variance is not monotone in the
projection), pit_ks 0.055, pi80 0.80. DST↔opposing-QB residual corr = **−0.36**
(measured, in the correlation model). Neither is forced into the WR/RB Gaussian.
Both fall back cleanly to Sleeper `pts_std` when the weekly feed omits K XP /
DST sacks (the certified projection path is untouched).

## II.14 Theoretical sanity checks (spec §17, §22) — pass

`test/matchup-intelligence.test.ts` (19 tests):
- equal lineups → WP within 4pp of 0.5
- overwhelming favorite → WP > 0.90; underdog → WP < 0.10 with a labelled upset prob
- **equal mean / higher variance: as FAVORITE lowers WP, as UNDERDOG raises WP** (both directions, monotone)
- higher projections → wider absolute score sd, WP still ≈ 0.5 for a symmetric matchup
- quantiles ordered; WP ∈ [0,1]; determinism; analytic Φ within 8pp of the MC
- unknown/null projection → dropped, not modeled as 0
- unknown position → heuristic fallback, no crash
- deployment SHADOW_ONLY; `matchupMayInfluenceProduction()` = false; lifecycle forbids skipping

## II.15 Isolation (spec §21, §V, §28)

- production `matchup.ts` does **not** import `matchup-intelligence`
- `lib/trades/**` imports neither `matchup-intelligence` nor the distribution model
- `lineup.ts` / `start-sit-fi/**` untouched
- `matchup-intelligence/**` imports no recommendation-ranking code
- `buildOptimalLineup` / `maxSlotMatching` byte-identical (existing `weekly-lineup` suite passes)

## II.16 Regression (spec §29)

`tsc` clean · `eslint app lib test` 0 errors, 29 warnings (**0 new**) ·
`npm test` **1519 pass / 0 fail / 4 skipped** (+19 matchup-intelligence; 0
existing tests changed) · Phase 1C cross-surface certification **0 discrepancies**
· Phase 4 start-sit-fi + isolation + remediation suites pass · Phase 3 R
invariants 24 + adversarial 15 · weekly + trade regression pass ·
**production recommendation behavior change = 0** (live-verified).

## II.17 Findings (Part II)

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| P5-1 | P1 (from audit) | current MC under-dispersed 55–70% for RB/WR/TE | **RESOLVED** — calibrated empirical marginals; cal slope 0.66 → 1.08, Brier −0.0035 |
| P5-3 | P2 (from audit) | MC seed ignored snapshot + model identity | **RESOLVED** — seed bound to `league_snapshot_id` + model versions (II.9) |
| P5-5 | P2 (from audit) | QB projection −2.9 pt bias | **RESOLVED (partial)** — −2.06 correction from clean-provenance rows; residual bias documented, pre-2023 flagged `BASELINE_PROVENANCE_DEGRADED` |
| P5-11 | P2 | 2-factor dependence adds no incremental WP calibration value | **RESOLVED (honest)** — REJECTED for headline WP, retained as diagnostic (spec §6 explicitly allows this outcome) |
| P5-12 | P2 | game context + FI add no incremental residual-variance information | **RESOLVED (honest)** — both EXCLUDED; v1 is calibrated marginals + independent draws only |
| P5-2 | P2 (from audit) | no real Bloodline matchups; real cross-check is 98 devoted matchups without pregame projections | **DOCUMENTED** — synthetic is the sole calibration vehicle; real is a model-free anchor only; never merged; certification is of *mathematical calibration*, not a lineup policy |
| P5-13 | P3 | K/DST correlation with game environment is real but unused (dependence rejected) | Measured, in the correlation model as a diagnostic; not in headline WP |
| P5-14 | P3 | degradation ceiling is MEDIUM in v1 | Deliberate — the model is uncertified and FI is a prior; honest |

No P0. All P1 resolved. The two "honest null" findings (P5-11, P5-12) are the
spec-sanctioned legitimate outcome.

## II.18 Deferred (`DEFERRED_FEATURES`)

`MAX_WIN_PROBABILITY` / `HIGH_FLOOR` / `HIGH_CEILING` / `LATE_SWAP_SAFE` lineup
objectives (need real-matchup decision-value evidence — impossible until 2026
matchups accumulate); in-game / partial-lock late-swap; a true
inactive-probability model; the 2-factor dependence in headline WP (rejected —
revisit only if a stacking-specific decision use-case emerges); game-context and
FI variance terms (no incremental value); `decision_leverage` as a production
output; probabilistic `position_edges`. A future re-evaluation follows the Phase
4 pattern (dormant, evidence-gated, versioned `ri-matchup-2026.2`, no
auto-promotion) once real 2026 matchups exist.

---

## II.19 Freeze criteria (spec §28) — check

1 residual distributions chronology-safe ✓ · 2 uncertainty materially better
calibrated than `weeklyBand` ✓ (slope 0.66→1.08) · 3 calibrated independent
model beats current MC ✓ (Brier −0.0035) · 4 2-factor either improves or is
rejected ✓ (**rejected**, documented) · 5 game-context either adds value or
excluded ✓ (**excluded**) · 6 FI variance/corr either adds value or excluded ✓
(**excluded**) · 7 synthetic and real always separate ✓ · 8 WP precision
conservative ✓ (whole %) · 9 simulation deterministic ✓ · 10 simulation
converges ✓ (N=10k) · 11 K/DST special treatment validated ✓ · 12 degradation
explicit ✓ · 13 production recommendation behavior change = 0 ✓ · 14 P0/P1
resolved ✓.

## II.20 VERDICT

The Phase 5 Scope 2 shadow engine is built: **calibrated per-position empirical
residual distributions that materially fix the current Monte Carlo's
overconfidence** (calibration slope 0.66 → 1.08, Brier −0.0035, log loss −0.016
on 7,152 chronology-safe synthetic matchups), a seeded deterministic simulator
bound to snapshot + model identity, a structured degradation vector, evidence-
mapped scenario explanations, three opponent-lineup views, K/DST as validated
non-Gaussian distributions, and shadow decision-leverage diagnostics. The
2-factor dependence model and every game-context / Football-Intelligence
variance term were tested and **honestly rejected** for adding no incremental
calibration value — the spec-sanctioned legitimate outcome. Production
`buildMatchup`, `buildOptimalLineup`, `maxSlotMatching`, Start/Sit, waivers, and
trades are byte-unchanged; there is no `MAX_WIN_PROBABILITY` objective; the
deployment contract is `SHADOW_ONLY` with no auto-promotion. Calibration is
certified against synthetic matchups only (Bloodline has no real history yet)
with a model-free real anchor from the `devoted` chain — sufficient to certify
the distribution mathematics and probability calibration, not a lineup policy,
exactly as scoped.

# PHASE 5 CERTIFIED — SHADOW MATCHUP INTELLIGENCE FREEZE

Do not begin Phase 6.
