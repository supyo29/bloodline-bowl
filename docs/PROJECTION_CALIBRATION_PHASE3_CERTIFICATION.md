# Projection Calibration Phase 3 — Game Environment, Game Script & Projection Distribution Calibration

**Verdict: CERTIFIED WITH LIMITATIONS.**
**Shadow classification: B — promising but immature.** Distributions fix gross over-confidence and zero-mass handling but do not beat the production baseline for material (baseline ≥ 3 pts) players on proper scores, and the environment-derived mean (Model C) is worse than the baseline mean. Nothing is promoted; everything is `SHADOW_ONLY`.

Model version: `game-dist-2026.2`. Production recommendation paths read none of the Phase 3 tables.

## 1. Git

Branch `projection-calibration-phase3`, merged with a fresh `origin/main` (`3bd15a0`). Merge conflicts were confined to three generated role-calibration CSVs; main's CI refresh dropped target weeks 2–3 (needed to reproduce the reconstruction) and held fewer 2026 Week-4 observations (27 vs 386 rows), so the superset was kept.

## 2. Existing architecture (reused, not rebuilt)

- Phase 1 ledger (`bridge_calibration_*`, kickoff rule, cases `cc:`) — every analysis row joins a ledger `case_id` + `evidence_digest`.
- Phase 2 role forecasts (`bridge_role_forecasts`, teammate propagation, injury labeling) — every player distribution references a persisted `role_forecast_id`.
- Weekly audit — gains an optional `distribution_calibration` component (omitted from the digest when absent, so existing hashes are unchanged).
- Production uncertainty = normal(median, sd = projected_std_dev or |median|×position CV), clamped at 0; floor/ceiling = P20/P80 (nominal 60%).
- Legacy `nfl_game_weather_snapshots`: 0 pregame-valid rows; untouched.
- FI `interaction_pass_epa_vs_pass_defense`: served family exists but trained on def success-rate; resolved as a **labeled proxy** (never presented as the trained definition).

## 3. Phase 3 architecture

`lib/game-distribution/` — empirical simulator fitted on 2025 only: game-script (team volume ratio *pairs* resampled jointly, preserving opposing-team correlation), role residual pools incl. DNP stratified by position × availability × recency × tier × magnitude (fallback chain, MIN_POOL=40), real-play outcome pools (rush/target/dropback incl. scrambles), shared team efficiency shocks (QB–WR correlation), share normalization (Σ ≤ 1), integer team volumes with `allocateCounts` (Σ player counts ≤ team total), seeded (`seedFrom(version, season, week, game)`), exact linear fantasy scoring so **one football simulation is translated to every league fingerprint** (3 fingerprints: 2 Sleeper, 1 Yahoo).
`lib/game-weather/` — NWS hourly + gridpoint forecast capture, 32-club stadium/roof registry, neutral-site skip, descriptive risk class (not a fantasy adjustment).
Tables (additive, insert-only, immutable triggers, RLS service-role only): `bridge_game_weather_forecasts`, `bridge_game_environment_forecasts`, `bridge_player_distribution_forecasts`, `bridge_distribution_calibration_analysis` (+ `_current` view). DB-enforced PIT: `as_of_at`/`retrieved_at`/`data_cutoff_at < kickoff_at`; trigger rejects `LIVE_CAPTURED`/weather rows when `now() >= kickoff_at` (verified live: a post-kickoff insert is rejected).
Routes: `/api/cron/game-environment` (CRON_SECRET), `/api/game-distribution/report`, `/api/game-distribution/evaluate`. Cadence: Vercel daily cron (plan limit) + `.github/workflows/pregame-capture.yml` every 2 h on game days to freeze the final pre-kickoff state (inert until `CRON_SECRET`/`APP_URL` repo secrets exist; never run in CI yet).

## 4. Fitting vs evaluation (in-sample / out-of-sample)

- **Fit**: 2025 regular season only (priors, pools, σ shocks, PIT recalibration map — fitted on weeks disjoint from its own hold-out weeks). 2025 hold-out PIT coverage ≈ nominal: 50%→0.51, 60%→0.61, 68%→0.68, 80%→0.78.
- **Evaluation**: 2026 Week 3 is **fully out-of-sample** (no 2026 observation touched any fitted parameter). Week 2 is persisted but its ledger coverage is thin (37 analysis rows) and is not used for conclusions.
- Retrospective Week 2/3 rows are `AS_OF_RECONSTRUCTION` (stamped 60 min pre-kickoff from strictly-earlier data), never `LIVE_CAPTURED`.

## 5. Coverage (production database)

| Table / capture | rows | notes |
|---|---|---|
| env `2026.2` AS_OF_RECONSTRUCTION | 34 | 32 games (Wk2+3) + 2 superseded (see §14) |
| player distributions `2026.2` reconstruction | 1,374 | 641 (Wk2) + 657 (Wk3) current + 76 superseded |
| analysis `2026.2` | 1,704 | Wk3 1,565 current-case rows, Wk2 37 |
| LIVE_CAPTURED Week 5 (this session) | 15 env / 473 player dists / 471 role forecasts (+2 dup) | all 15 games pre-kickoff at capture |
| weather snapshots (LIVE, pregame) | 13 | 11 LOW, 1 MODERATE, 1 DOME; 78–150 h pre-kickoff; skipped: 1 neutral site, 1 beyond NWS horizon |
| PIT violations / orphan pd→role / orphan da→case | 0 / 0 / 0 | |

Idempotency: a re-run after the first persistence inserted a handful of rows (the one forecast reconstructed in run 1 was persisted as a side effect, adding an input player to one game); the next re-run inserted **0** rows across env/pd/analysis.

## 6. Week 3 primary population (n = 769: Sleeper-deduped, injury-contaminated excluded, DNP included; 80 DNP)

| | A baseline | B base+dist | C env+dist | D Phase2+dist |
|---|---|---|---|---|
| MAE | 3.64 | 3.64 | 3.87 | 3.65 |
| bias | +0.34 | +0.34 | +1.38 | — |
| mean pinball | 1.222 | 1.183 | **1.159** | 1.166 |
| interval score 80% | 19.60 | 18.93 | **17.37** | 18.38 |
| PIT coverage 50/60/68/80 | .20/.25/.29/.38 | .48/.59/.65/.75 | .49/.59/.68/.78 | .49/.58/.65/.75 |

Production's floor/ceiling (nominal 60%) covers **25%** of outcomes; 24.6% of outcomes exceed P90 and 36.9% fall below P10.

**Material players only (baseline ≥ 3, n = 436):** pinball A **1.561**, B 1.579, C 1.591, D 1.569; interval score 80%: A 23.83, B 24.51, C **23.31**, D 24.03. PIT 60% coverage: A .37, B .72, C .63, D .71 — the simulated distributions are **over-wide** for material players and give back the sharpness gain. Model C mean bias +2.33 here.

## 7. Calibration by position (pinball; PIT 60% coverage)

| Pos | n | A | B | C | D |
|---|---|---|---|---|---|
| QB | 63 | 2.047 (.35) | 2.423 (.76) | 2.363 (.59) | 2.392 (.71) |
| RB | 208 | 1.015 (.24) | 0.982 (.67) | 0.971 (.70) | 0.969 (.67) |
| WR | 312 | 1.219 (.29) | 1.165 (.54) | 1.121 (.52) | 1.147 (.54) |
| TE | 186 | 1.180 (.17) | 1.019 (.50) | 1.026 (.61) | 1.005 (.51) |

QB distributions are materially worse than baseline (too wide; Model C mean MAE 8.10 vs 6.48). By projection magnitude: <5 pts: A .903, B .763, C .679, D .738 (gain is concentrated where production is degenerate); ≥15 pts: A 1.673, B 2.093, C 2.191, D 2.089 (worse for stars). Depth starters: A 1.608 vs B 1.776 (worse); non-starters: A 1.050 vs B 0.930. Fingerprints agree: all three show B/C/D < A overall, same rank order.

## 8. Tails

Share of ≥ k-point misses that fall inside P10–P90 (A / B / C / D): ≥5 pts (n=208) .19/.66/.62/.67; ≥8 (n=93) .03/.51/.41/.54; ≥10 (n=51) .04/.41/.16/.41. Even the best distribution leaves ~60% of ≥10-point misses outside P10–P90 for C. Production's floor/ceiling effectively cannot contain large misses. Mean miss vs distribution miss: B and D leave the mean unchanged (same MAE as A) and only widen the band; C moves the mean and gets worse.

Six-way error attribution (share of squared error, n=713): role_share 0.33, TD variance 0.20, baseline gap 0.18, yardage efficiency 0.17, volume/script 0.12, turnover 0.01. QB: baseline gap 0.29, TD variance 0.24.

## 9. Manual Week 3 audits (A/B/C P10-P50-P90; actual; PIT)

| Player | actual | baseline | A | B | C | note |
|---|---|---|---|---|---|---|
| Gibbs (RB DET) | 37.9 | 21.1 | 9/21/33 | 0/20/38 | 7/18/33 | above P90 in A and C; TD variance 7.3, role_share 6.6 |
| Purdy (QB SF) | 31.3 | 18.2 | 11/18/26 | 0/16/39 | 0/10/21 | C mean 10.3 (bias); TD 11.2, efficiency 10.4 |
| Darnold (QB SEA) | 26.7 | 13.9 | 8/14/20 | 0/0/47 | 0/2/21 | B median 0 (pZero 0.54) — availability-pool defect for this player, see §14 |
| Kittle / Bowers / Sadiq / Fannin / Higbee (TE) | 23.2 / 22.6 / 20.0 / 20.6 / 16.2 | 10.1 / 10.3 / 5.5 / 7.4 / 1.3 | all above A P90 | B P90 13–27 | C P90 8–15 | TE spikes are TD/share driven; B contains Bowers and Kittle marginally, none fully |
| Jonathan Taylor (RB IND) | 8.2 | 18.3 | 8/18/29 | 0/18/34 | 7/17/31 | PIT A .10 B .19 C .15 — within B/C bands |
| Henderson (RB NE) | 3.4 | 11.9 | 5/12/19 | 0/9/27 | 2/6/15 | A PIT .05; C .28 |
| Mayfield (QB TB) | 5.3 | 12.9 | 8/13/18 | 0/12/28 | 0/12/25 | A PIT .04; B .28 |
| Maye (QB NE) | 0.8 | 14.9 | 9/15/21 | 0/13/33 | 0/9/20 | A PIT .00; B .17 |
| Achane (RB MIA), Jefferson (WR MIN) | 1.7 / 4.2 | 14.4 / 13.8 | — | — | — | **POSSIBLE_IN_GAME_INJURY — labeled separately, excluded from calibration statistics** |

Pattern: the four large positive surprises (Gibbs, Purdy, Darnold, TEs) remain above P90 in nearly every model (PIT ≥ .8); the large busts are inside the B/C bands but at the lower tail. Production's band excludes all of them.

## 10. ATL–GB adversarial audit (game `ge:e8c7ba40…`, kickoff 2026-09-25 00:15Z)

- Pregame: GB pass att mean 38.2 (P5–P95 24–55), rush 23.5; ATL pass 34.4, rush 30.1. Scenario probabilities: BALANCED .43, PASS_HEAVY/SHOOTOUT .18, RUSH_HEAVY/CLOCK_CONTROL .21, LOW_VOLUME .11, HIGH_VOLUME .07 (both teams LOW confidence, no QB change).
- Actual: GB 56 pass / 10 rush (pass > P95, rush < P5, **actual script label: PASS_HEAVY_TRAILING_OR_SHOOTOUT**); ATL 29 pass / 40 rush (rush P75–P90, red-zone rush 12 > P95). The ATL–GB script was a rare but represented scenario, but the extremes of the volume distribution are still too thin: the team volume distribution under-covers the pass/rush split in this game.
- Jordan Love (QB GB): actual 17.5, baseline 12.8; PIT A .87, B .70, C .72 — contained by B/C but not A. Green Bay DST is handled through the environment only (no DST player distribution; K/DST are not targeted).
- Weather/FI for this game: weather `NOT_CAPTURED` (retrospective week: no pregame snapshot exists and none is fabricated); FI `OMITTED_NOT_PREGAME` (FI through-week not earlier than target week).

## 11. Weather

Pipeline is live and was exercised on Week 5 (13 pregame snapshots persisted, PIT-guarded; neutral site skipped; one game beyond NWS's horizon recorded as skipped, not guessed). Retrospective 2026 weather is **not** captured or backfilled. Weather and FI are stored as context only; neither drives any mean or width in `game-dist-2026.2`.

## 12. Leakage certification

- DB constraints enforce `as_of/retrieved/cutoff < kickoff` on all three pregame tables and a trigger rejects LIVE rows at/after kickoff (live-tested).
- Priors are 2025-only; role profiles use games strictly before the target week (existing Phase 2 adversarial tests pass; on origin/main two of these fail only because main's CSV refresh dropped target weeks 2–3).
- FI context attached only when `through_week < target week`.
- Injury-contaminated players (possible in-game injury) are excluded from calibration statistics and listed separately.
- Retrospective evidence is labeled `AS_OF_RECONSTRUCTION`.

## 13. Tests

`test/game-distribution.test.ts`: 35 tests (RNG/seed determinism, allocation constraints, distribution/pinball/interval-score/PIT math, scoring translation across fingerprints, injury exclusion, poisoning/leakage, idempotent ids, versioning). Full suite on this branch after merge: **2971 tests, 2908 pass, 59 fail, 4 skipped**; fresh `origin/main`: 2936 tests, 2862 pass, 70 fail, 4 skipped. The branch's failing set is a strict subset of main's (names compared; 0 failures introduced). Typecheck clean; lint has no errors (warnings pre-existing).

## 14. Limitations

1. Model B/D distributions are over-wide for material players (60% interval PIT coverage .71–.72) and lose to production on pinball for material players, QBs, stars and depth starters.
2. Model C environment-derived mean is biased high (+1.4 overall, +2.3 material; QB MAE 8.1 vs 6.5) — environment mean should not be used.
3. Darnold's B median of 0 (pZero .54) shows availability pools can over-weight DNP for low-attendance players; to be reviewed.
4. Single out-of-sample week (Week 3); no live capture has yet been scored (Week 5 is the first). Week 2 ledger overlap is thin.
5. Weather and FI are context only; no historical 2026 weather; retractable-roof status unknown; coordinator registry empty so regime uncertainty is limited to QB changes.
6. K/DST and Yahoo-pooled distributions are not targeted.
7. `game-dist-2026.1` rows (32 env, 1,296 player, 1,598 analysis) are superseded history from before a simulator fix; 2026.2 also holds 2 env + 76 player rows superseded by the one-time forecast-set convergence. Insert-only tables retain them; `_current` views and the report select the latest per case.
8. `pregame-capture.yml` and the Vercel cron have not run unattended; the first scheduled LIVE capture must be observed.
9. Role-calibration CI refresh on main conflicts with the superset inputs kept here; main's CSV windows should be widened to retain reconstruction weeks.

## 15. Production

Migration `20260930180000_game_distribution` applied to `ijpfjdzmaztofawhwepf`; deploy status recorded after merge.

## 16. Phase 4 recommendation

Do not promote any distribution. Phase 4 should (a) tighten material-player widths (condition the role pool on starter status/magnitude, add a width-shrink fit on pinball for baseline ≥ 3 players), (b) drop the environment-derived mean and instead test environment only as a variance/skew input, (c) fix availability pools for low-attendance high-upside players, and (d) score the accumulating LIVE captures (Weeks 5+) before any further modeling.
