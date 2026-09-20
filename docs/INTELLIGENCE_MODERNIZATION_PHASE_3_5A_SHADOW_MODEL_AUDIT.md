# Intelligence Modernization — Phase 3.5A
## Shadow Model Audit, Evidence Integrity & Tuning Foundation

Status: **complete — see §23 (Checkpoint F) for the final verdict** (branch, not merged/deployed).
Scope: the Start/Sit Football-Intelligence shadow system `ri-startsit-2026.1` (frozen, `SHADOW_ONLY`).
Not in scope: Phase 4, Book-Ready retrofit (3.5C), Analysis Book contract (3.5D), any activation/merge/deploy.

---

## 1. Branch / base / drift

| | |
|---|---|
| Branch | `intelligence-modernization-phase3-5a-shadow-audit` |
| Base | `main` = `origin/main` = `cf4dbb1` (clean tree at start) |
| FI version at start | `fi:2026:w02:351c149735ed` (2026 wk 2, `week_state: PARTIAL`, 1/16 games) |
| Start/Sit model | `ri-startsit-2026.1`, `SHADOW_ONLY`, `deployment_contract.positions = {}`, `activation_log = []` |
| Re-eval manifest at start | `NOT_ELIGIBLE`, 0 weeks, generated `2026-09-08T11:42` (**pre-dates the 2026 FI refreshes**) |
| Baseline TS suite | 2078 tests / 2074 pass / 0 fail / 4 skipped |

Drift log (appended at each checkpoint): see §16.

## 2. Live NFL reality at audit time (2026-09-19)

Sleeper `/schedule/nfl/regular/2026` (the source of the frozen Phase 1 `NflRealityFrontier`):

* Week 1: 16/16 `complete`
* Week 2: 1/16 `complete`, 15 `pre_game` (the Thursday game, 2026-09-17)
* Weeks 3+: all `pre_game`

FI's own `week_completion` agrees (week 2 `PARTIAL`, 1/16). The frontier's `latest_week_with_any_completed_game`
is **2** — that is "any game", not "week complete". The frontier deliberately does not say a week is done.

## 3. Runtime graph — what is actually wired

```
GET /api/{intelligence,lineup,...}  ->  buildWeeklyIntelligence()            lib/weekly/intelligence.ts
                                          -> buildStartSitShadow(ctx)         lib/weekly/start-sit-fi/shadow.ts
                                          -> if getShadowCaptureStore().kind !== "null"  captureShadowDecision(...)
```

* `setShadowCaptureStore` has **zero non-test callers**. The store is always the module-default `NullCaptureStore`,
  so the `kind !== "null"` guard is always false and **`captureShadowDecision` is never called in ordinary runtime**.
  `live_captured_decisions: 0` in the manifest is therefore true *by construction*, not by evidence of absence.
* `ShadowCaptureStore.record()` is synchronous. It cannot front an async database, and the only concrete store
  (`FileCaptureStore`) appends JSONL to `./outputs/...` — not durable on Vercel (read-only / ephemeral FS).
* Production sections (`lineup`, `start_sit`, `waivers`, `matchup`) are computed *before* the shadow block from `ctx`
  and never read `start_sit_shadow`. `applyFiToProductionBatch` has no production caller. `fiMayInfluenceProduction`
  / `anyFiProductionInfluence` are `false` for every position.

## 4. A.1 — What `ri-startsit-2026.1` is

* Formulation: **residual**, per position, ridge; target = `actual − baseline_trailing` (see defect D7).
* Global: `tau_tie_break = 3` pts, `max_total_adjustment_fraction = 0.25`, conf weights `HIGH 1 / MED .5 / LOW .2 / INSUF 0`,
  prior-dominated haircut `0.6`.
* Training window 2021–2022+ (outer folds 2023/24/25, walk-forward), weeks 4–17, archetypes std/half/ppr.

| Pos | λ | Families with nonzero β (routing) | Status stamped |
|---|---|---|---|
| QB | 25 | def_success_allowed −0.348, off_explosive_pass_rate −0.329 (PREDICTIVE) | SHADOW_ONLY_NO_VALUE |
| RB | 25 | off_pace_sec_play −0.069, usage_snap_share +1.412 (PREDICTIVE) | TIE_BREAK_SHADOW_ONLY |
| WR | 8.67 | def_success_allowed −0.548, interaction_pass_epa_vs_pass_defense +0.351 (WEAKLY), off_explosive_pass_rate −0.154, off_pass_epa −0.841, off_proe −0.057 | see model JSON |
| TE | 25 | off_pace_sec_play +0.248, usage_route_participation +0.481, usage_target_share −0.760 | SHADOW_ONLY_NO_VALUE |

Historical decision metrics as *served* (kept verbatim; **not** reinterpreted). The two baselines are never collapsed:

| Pos | rev-win vs **trailing control** | Δpts vs trailing | rev-win vs **Sleeper (production-like)** | Δpts vs Sleeper | large-win | large-loss |
|---|---|---|---|---|---|---|
| QB | 0.519 | +0.013 | 0.472 | −0.020 | 0.346 | 0.321 |
| RB | 0.606 | +0.061 | 0.505 | −0.001 | 0.340 | 0.188 |
| WR | (model JSON) | | (model JSON) | | | |
| TE | 0.416 | −0.044 | 0.484 | −0.005 | 0.133 | 0.230 |

Overall (`decision_backtest`): vs trailing control 51.1% reversal win rate, mean reversal Δ +0.22; vs Sleeper 2023–25
**48.7% reversal win rate, mean reversal Δ −0.29 pts, total −3066 pts**. The FI candidate looks useful *only* against the
naïve control. Against the baseline that resembles production it is a net loser. Nothing in this phase changes that reading.

## 5. A.2 — Chronology map

| Input | Known pre-kickoff? | Classification | Notes |
|---|---|---|---|
| Trailing PPG control | yes (prior weeks only, EW) | TRUE_AS_OF | clean |
| Team off/def FI ratings (`fi_asof_bundle`) | yes, `thr = W−1`, participation lag 2 | RECONSTRUCTABLE_AS_OF | built from primitives truncated at W−1 |
| Player usage as-of | yes, `week <= W−1` (routes `W−3`) | RECONSTRUCTABLE_AS_OF | |
| **Discontinuity flags** (QB/HC/OC/DC change, OL/front/secondary continuity) | **no** | **LEAKAGE_SUSPECT / REVISED_HISTORICAL** | `qb_by_team_season`, `hc_by_team_season`, `returning_share` are computed from the *entire* target season (max dropbacks / most games / total snaps) and applied to every week W of that season → end-of-season facts govern the prior discount at Week 4 (defect D9) |
| Sleeper historical projection | **unknown** | REVISED_HISTORICAL | 2021 no timestamp; 2022 bulk-backfilled; 2023–25 may be revised through the week (`last_modified` retained) |
| Sleeper actuals | n/a (target) | — | never a predictor |
| `ff_playerids` sleeper↔gsis crosswalk | current mapping | CURRENT_ONLY (benign identity map) | |
| Survivorship | — | SELECTION | dataset filters `is.finite(actual)`; players who DNP are dropped *conditional on the outcome* |

Tuning vs evaluation:
* Ridge λ: inner loop (latest prior season) — clean.
* `tau`, `max_frac`: tuned on **2023–2024**, reported on 2025 (`eval2025_trailing`) — clean for that one number.
* **Per-position `production_status` and `decision_metrics` are computed on `full` (2021/23–25), which includes the 2023–24
  tuning window** (defect D8). They are in-sample with respect to `tau`/`max_frac`.
* Served `tau_tie_break`/`max_frac` come from the **trailing-control** tuning (`res_trailing$tuned`). The Sleeper-baseline
  numbers in the model JSON were produced with the Sleeper run's *own* tuned `tau/mf`. The shipped gate is therefore not
  the gate that the "vs Sleeper" row was measured with (defect D10) — verified numerically in Checkpoint D.

## 6. A.3 — Evidence gate (`eligibility.R`) vs its five documented predicates

| # | Documented | Enforced? |
|---|---|---|
| 1 | NFL regular-season week complete | **NO.** `weeks_in_pbp <- sort(unique(reg26$week)); ok_pbp <- TRUE` — any week with ≥1 PBP row "passes". A 1/16 week counts. **(D1, confirmed)** |
| 2 | FI as-of snapshot buildable | Partly: `fi_manifest$through_week >= w−1`. Ignores that `fi_asof_bundle` skips `thr < 2` (so wk 1–2 can never be built). |
| 3 | current-season FI through prior period | Same predicate as #2 (collapsed); a `season==2026` manifest is taken as proof even if week W−1 was itself partial. |
| 4 | actuals present | `any(is.finite(act_ppr))` — one player's stat satisfies a whole week. And the history cache is built for `SS$SEASONS = 2021:2025` (weeks 4–18), so **no 2026 row can ever exist** → predicate 4 and 5 are permanently FALSE. The gate is closed for the wrong reason and could never have opened (D2). |
| 5 | production baseline projection | Reads *Sleeper post-hoc history* `proj_ppr`, not the projection the system actually showed before kickoff, and never checks `last_modified` vs kickoff (D3). |

Per-week predicate visibility: none — only a count is emitted.

## 7. A.4 — Shadow capture audit (answers)

| Question | Answer |
|---|---|
| `captureShadowDecision()` called in ordinary runtime? | **No** — guarded by `kind !== "null"`; nobody sets a store. |
| Default store ever replaced? | **No** (zero non-test callers of `setShadowCaptureStore`). |
| Where would it persist? | `FileCaptureStore` → `./outputs/startsit-2026/shadow_capture/*.jsonl`, git-ignored. |
| Durable on Vercel? | **No.** |
| Repeated GETs duplicate? | Yes — plain `appendFileSync`, no identity. |
| Guaranteed pre-kickoff? | **No** — `kind: "LIVE_CAPTURED"` is hard-coded in `intelligence.ts`; nothing consults game status/kickoff. A Sunday-night request would be labelled pristine. (D4) |
| Live vs reconstructed mixing? | Two labels exist but nothing enforces them, and eligibility.R counts "not LIVE" as reconstructed, including anything malformed. |
| Outcomes attached without rewriting? | `actual_fantasy_points` is a mutable field on the same record — enrichment means rewriting the decision row. (D5) |
| Failure visible? | **No.** `catch { start_sit_shadow = null }` swallows every error — and additionally *discards the shadow comparison from the response*, coupling a telemetry failure to output. (D6) |
| Sufficient to evaluate later? | Mostly. Missing: stable capture id, model-artifact hash, FI generation timestamp, per-game lock evidence, capture class, baseline-projection provenance. |

## 8. A.5 — Re-evaluation manifest

`start_sit_reevaluation_manifest.json` was produced 2026-09-08, before the FI 2026 season data existed
(`fi_snapshot_seen: fi:2025:w18`, `fi_snapshot_is_current_season: false`). It says `0` weeks. That number is
*coincidentally* right today but for a wrong/unproven reason (§6), it is **stale** (never regenerated by the daily FI
refresh), and it carries no per-week reasons. It is not authoritative; it is regenerated in Checkpoint B.

---

## 9. Defects found (Checkpoint A)

| ID | Sev | Pre-existing | Defect |
|---|---|---|---|
| D1 | **P0** | yes | Partial NFL week counts as complete (`ok_pbp <- TRUE`). |
| D2 | **P1** | yes | Gate can never open: actuals/baseline read from a 2021–25-only cache; wk<4 excluded; FI as-of builder cannot build W<3. |
| D3 | P1 | yes | "Production baseline available" is a post-hoc Sleeper history read, not a pre-kickoff record of what production showed. |
| D4 | **P0** | yes | Capture is never invoked (Null default), and would label any request `LIVE_CAPTURED` regardless of kickoff. |
| D5 | P1 | yes | No immutable identity / no idempotency / outcomes mutate the decision record. |
| D6 | P1 | yes | Capture errors silently swallowed and null the shadow field. |
| D7 | P1 | yes | Model is residual to `baseline_trailing`, **not** to the production baseline it is deployed on top of. The philosophy "what does production get systematically wrong" is not what was fit. |
| D8 | P2 | yes | Per-position verdicts computed on `full` including the `tau/mf` tuning seasons (in-sample). |
| D9 | P2 | yes | Discontinuity/prior-discount flags use whole-season information (future leakage into early-week features). |
| D10 | P2 | yes | Served `tau/mf` tuned on the trailing control; "vs Sleeper" numbers measured with a different tuned gate. |
| D11 | P3 | yes | Survivorship: pairs require a finite actual (DNPs dropped). |

D1–D6 are repaired in Checkpoints B/C. D7–D11 are *model/research* findings: they are documented, not "fixed" in place
(`ri-startsit-2026.1` is immutable) and are addressed by the candidate-v2 protocol (Checkpoint D).

## 10. Fixes implemented

| Defect | Fix |
|---|---|
| D1 partial week counts | `NFL_WEEK_COMPLETE` requires every scheduled game `complete` per the frozen Phase 1 predicate (`buildNflSeasonCompletion`, `isCompleted` shared with `buildNflRealityFrontier`), cross-checked against nflverse schedule + PBP game counts. PBP presence is never used as completion. |
| D2 gate could never open | separate `sleeper_history_2026.rds` cache (`fetch_sleeper_history.R --season=2026`, weeks 1–18; the frozen 2021–25 cache untouched); FI as-of minimum (W ≥ 3) encoded explicitly. |
| D3 baseline | `PRODUCTION_BASELINE_AVAILABLE` requires ≥1 `LIVE_CAPTURED` pre-kickoff record for the week. Sleeper history never satisfies it (2026 wk1 projections carry `last_modified` 2026-09-15 — five days *after* kickoff). |
| D4 capture never called / mislabelled | default store resolves to durable Supabase or `UnconfiguredCaptureStore` (explicit NOT_CONFIGURED); runtime wired in `buildWeeklyIntelligence`; class assigned by lock classifier. |
| D5 identity/immutability | deterministic `capture_id`, deep-frozen records, INSERT-only DB tables (trigger), outcomes in a separate table. |
| D6 silent failure | capture in its own guard, after production output; failure logged + counted in `getCaptureHealth()`; no longer nulls `start_sit_shadow`. |
| new: `--force` hole | `reevaluate.R --force` previously bypassed the gate and stamped `FAILED` into the manifest; now ignored. `guard_model_write()` in train/backtest/finalize refuses to rewrite 2026.1 or fit a candidate unless the gate is ELIGIBLE with per-week evidence. |
| TS trust | `isEligible` refuses a bare count: every claimed week must have all five predicates true in `week_evidence`; legacy manifests can never open the gate. |

D7–D11 are model/research findings — recorded, **not** patched into the frozen model (see §15).

## 11. Persistence design

* Tables `bridge_startsit_shadow_captures` / `_outcomes` (migration `20260919120000_startsit_shadow_evidence.sql`, **applied to prod Supabase `ijpfjdzmaztofawhwepf` 2026-09-19**: new empty tables, RLS on/no policies, rollback SQL in the file).
* Pattern reused: `SupabaseRest.insertIgnoreDuplicates` (`ON CONFLICT DO NOTHING`, returned rows ⇒ CREATED vs DUPLICATE, safe under concurrency), same as the snapshot/ledger stores.
* DB-verified (self-rolling-back block): duplicate insert = 0 rows; UPDATE and DELETE raise; invalid `capture_kind` rejected; 0 rows remain.
* Identity: `ssc:` + sha256(class, season, week, league, manager, scoring fingerprint, model version + artifact fingerprint, FI version + cutoff, baseline version, content hash). Timestamps excluded ⇒ repeated GETs idempotent; a moved projection ⇒ a new record.
* Bounded: 2.5 s store timeout, in-process recent-id short circuit; never throws.

## 12. Live vs reconstructed semantics

`LIVE_CAPTURED` = every involved team's game was `pre_game` in a schedule read taken ≤5 min from the decision, and no involved game's ET date was already past. `LIVE_POST_LOCK` (a game started/finished), `LIVE_UNVERIFIED` (schedule missing/stale/no involved game/bad timestamp), `HISTORICALLY_RECONSTRUCTED` are separately keyed in id, DB column, summary and report. Only `LIVE_CAPTURED` counts toward the gate or per-position decision counts. A bare request claiming `LIVE_CAPTURED` without lock evidence is downgraded. **Kickoff *time* is not in the schedule feed** — same-day games rely on Sleeper `status` (limitation L2).

## 13. Current 2026 evidence state (2026-09-19)

NFL: wk1 16/16 complete; wk2 1/16 (PARTIAL); FI `fi:2026:w02:351c149735ed` (wk2, PARTIAL 1/16).

| Week | Result | Reasons |
|---|---|---|
| 1 | rejected | `NO_PRIOR_CURRENT_SEASON_WEEK`, `FI_ASOF_UNBUILDABLE_BEFORE_WEEK_3`, `NO_PRE_KICKOFF_PRODUCTION_BASELINE_CAPTURE` (NFL-complete ✓, actuals ✓) |
| 2 | rejected | `WEEK_PARTIAL_1_OF_16_GAMES`, `FI_ASOF_UNBUILDABLE_BEFORE_WEEK_3`, `ACTUALS_NOT_FINAL_WEEK_INCOMPLETE`, `NO_PRE_KICKOFF_PRODUCTION_BASELINE_CAPTURE` |

Qualifying weeks **0 / 4** (preferred 6) → `NOT_ELIGIBLE`. Before/after: the old manifest also said 0, but for a wrong, unprovable reason and would have counted week 2 the moment a PBP row and one actual existed. Capture counts: LIVE_CAPTURED 0, POST_LOCK 0, UNVERIFIED 0, RECONSTRUCTED 0 (no production runtime has written yet — branch is not deployed; local env has no Supabase credentials, so the store reports `unconfigured`).

## 14. Tuning readiness

**INFRASTRUCTURE_READY_EVIDENCE_INSUFFICIENT.** Pipeline trustworthy; 0 qualifying weeks. Earliest realistic opening: deploy capture → LIVE_CAPTURED baselines accumulate from that week → 4 completed weeks with FI as-of buildable (W ≥ 3) → not before ~Week 7 of 2026 even if deployed immediately.

## 15. Historical reproduction (Checkpoint D) and candidate-v2 plan

Full frozen pipeline rerun in an isolated scratch root; served artifact hash unchanged (`85d2ddd5…`). Record: `analysis/football_intel_startsit/reproduction_audit_2026-09-19.json`.

* Reproduced: same families, λ, τ=3, cap 0.25, identical per-position statuses. β drift ≤0.059 (WR), reversal counts −1.9%. Classified **SOURCE_REVISION / DEPENDENCY_DRIFT** (caches re-fetched 09-08 → 09-16); no leakage introduced, no model defect; frozen model not updated.
* **D10 measured:** the model JSON's "vs Sleeper" row used the Sleeper run's own tuned gate (τ=0.5, cap 0.08). The gate actually served (τ=3, cap .25) vs the production-like baseline: 22,135 reversals, **47.4% win, −0.48 pts/reversal, −10,716 pts** (2025 only: 48.2%, −2,461); QB 46.6 / RB 49.4 / WR 46.8 / TE 46.6%. Versus the trailing control, 2025: 50.6%, +0.40/reversal. FI looks useful only against the naïve control.
* Per position (served metrics, both baselines never merged): QB 51.9%/47.2%, RB 60.6%/50.5%, WR 49.3%/48.8%, TE 41.6%/48.4% (trailing / Sleeper reversal win rate) — model JSON + reproduction file hold the full table.
* Candidate-v2 registry: `analysis/football_intel_startsit/candidate_v2_feature_registry.json` (dormant; every family classified; unsafe classes barred from backtests; Phase 3 propagation `CONDITIONAL_SCENARIO_ONLY`; Phase 2 role signals `RECONSTRUCTABLE_AS_OF` in code but served snapshot is CURRENT_ONLY → deferred to prospective). Residual target must be `actual − captured production baseline` (fixes D7); discontinuity flags must be rebuilt as-of (D9); τ/cap tuned against the production baseline (D10); nested walk-forward on eligible 2026 weeks only; decision metrics primary, MAE supporting. **No `ri-startsit-2026.2` artifact exists or was generated.**

## 16. Git / drift log

Base `cf4dbb1`. `origin/main` re-fetched after each checkpoint (A, B, C, D, E): unchanged at `cf4dbb1`; no drift to reconcile. No force-push, nothing merged/tagged/deployed.

## 17. Tests

* TypeScript `npm test`: **2104 tests / 2100 pass / 0 fail / 4 skipped** (baseline 2078/2074/0/4; +26 new). New: `startsit-evidence-gate` (7), `startsit-capture-integrity` (14), `startsit-candidate-v2-registry` (5).
* R: `analysis/football_intel_startsit/tests` — 44 expectations pass (adversarial matrix 1–10 + reality-unavailable + live-week-1/2 + gate count); `analysis/football_intel/tests` invariants + week-completion pass.
* `tsc --noEmit`: 0 errors. `eslint app lib test`: 0 errors (32 pre-existing-style warnings).
* Two existing assertions were deliberately changed (both encoded the defects): default `captureShadowDecision` ⇒ `LIVE_CAPTURED` (now `LIVE_UNVERIFIED`), and a stale-manifest assertion (`fi_snapshot_is_current_season === false`, `/does not count/`). Count-only eligibility (no per-week evidence) was also tightened.
* Adversarial matrix: 1–10 R; 11–20 `startsit-capture-integrity`; 21–25 isolation tests in the same file.

## 18. Live verification (read-only)

Real Bloodline Bowl / `supyo29`, week 2: production sections computed; `shadow_deployment=SHADOW_ONLY`, `eligible_to_influence_production=false`. Sleeper schedule: wk2 1/16 complete ⇒ partial proven not counted. Live capture classification today: **`LIVE_POST_LOCK` (`GAME_NOT_PRE_GAME:BUF:complete`)** — a post-kickoff request did not masquerade as live evidence. Diagnostic route handler returns model/gate/store status; store `unconfigured`, durability false. **Not verified live:** a deployed runtime write to Supabase (no credentials locally; branch not deployed). DB-side behaviour was verified directly (§11); the store code by a PostgREST contract test.

## 19. Production-isolation proof

`scripts/startsit-production-parity.ts` hashes lineup / start_sit / waivers / matchup / matchup_leverage / positional_needs (volatile `*_at` stripped). Base commit `cf4dbb1` vs this branch under four capture modes (default-unconfigured, in-memory store, throwing store, hanging store): **all six hashes identical in every mode**; lineup total 113.58 unchanged. Structural tests: only `lib/weekly/intelligence.ts` (+ readiness/freshness/orchestrator schema type refs, the evidence route and store) import `start-sit-fi`; production engines never reference adjustment fields; R scripts never write `activation_log`; `fiMayInfluenceProduction` false for QB/RB/WR/TE/K/DEF; `anyFiProductionInfluence` false; model artifact sha256 pinned.

## 20. Known limitations

* L1 A deployed Supabase write path is unproven until the branch is deployed with credentials.
* L2 Kickoff time absent from schedule feed; a game that starts but whose Sleeper status lags could be labelled pre-game for minutes (mitigated by ET-date check and 5-min schedule freshness).
* L3 Capture covers only requests actually made (rostered players of registered managers), not a full slate; evidence is partial by construction.
* L4 D7–D11 remain true of `ri-startsit-2026.1` (trailing-target residual, in-sample per-position verdicts, whole-season discontinuity leakage, served-gate mismatch, DNP survivorship) — documented, model frozen.
* L5 Evidence gate depends on Sleeper schedule status + nflverse caches; a stale local nflverse cache fails closed (safe, not silent).
* L6 The evidence gate requires a manual/CI run of `eligibility.R` (with `startsit-evidence-report.ts` for capture counts); it is not yet scheduled.
* L7 The forced re-evaluation experiment temporarily overwrote git-ignored `outputs/startsit-2026/decision_dataset.rds`; restored from the reproduction run.

## 21. Deferred

3.5B (fresh-week evidence accumulation once deployed), 3.5C Book-Ready retrofit, 3.5D Analysis Book contract, Phase 4, wiring `eligibility.R` + evidence report into the FI refresh workflow, outcome-enrichment job (store + API exist, no producer), any v2 fit.

## 22. Verdict

**CERTIFIED WITH DOCUMENTED LIMITATIONS.** All certification gates hold: model frozen and SHADOW_ONLY; a partial week cannot count and every rejection is explained; the capture path is durable-by-design, idempotent, immutable, class-separated and failure-visible; no known leakage remains *in the re-evaluation path* (historical leakage in 2026.1 is documented, not hidden); production output is value-identical; the 2026 sample is not exaggerated (0 weeks) and no v2 was trained. Limitations L1/L3 are the reason this is not an unqualified CERTIFIED.

---

## 23. Checkpoint F — closing the remaining research-integrity gaps

Scope: the dormant/future research pipeline only. `start_sit_model.json` sha256 `85d2ddd501cc10d5b3a699629f80c0c3781fe12fa24fa834f41969cb0186b293` is byte-for-byte unchanged; nothing was trained, activated, merged or deployed; no production state was created.

### 23.1 D9 — exact root cause
`build_decision_dataset.R` called the frozen `build_discontinuity_table(target_season, …)` **once per season** on whole-season data (head coach = most games, starting QB = most dropbacks, OL/front/secondary continuity = total snaps) and applied that single table to every decision week, so a Week-4 row inherited end-of-season facts (e.g. a QB who took over in Week 9). The full-row trace found a **second** leak (D9b): `compute_metric_profile()` derives a pooled game-level SD from the *entire* team-game table it is given (→ `std_error` → `confidence`), including future weeks and seasons. It is harmless live (the table only holds played weeks) but leaked in every historical backtest.

### 23.2 Chronology-safe replacement
* `discontinuity_asof.R`: for a Week-W decision the frozen library receives only `season < S` (complete) and `season == S & week < W` — truncation *before* the call, so leakage is impossible by construction; the frozen library is untouched.
* `fi_asof_bundle(discounts_asof=)`: per-(season, week) discounts and a visibility-truncated `tgf` for the profile SD (D9b). Legacy path retained only for frozen-v1 reproduction.
* `SS$DISCONTINUITY_MODE` defaults to `AS_OF`; `LEGACY_FULL_SEASON_V1_REPRODUCTION` is refused for any candidate version and every dataset writes a provenance sidecar.
* **`UNSAFE_FOR_BACKTEST`, excluded (not approximated):** `offensive_coord_change` / `defensive_coord_change` — `coordinators.yaml` is season-keyed with no effective dates (and currently empty). Forced UNKNOWN ⇒ no discount.

### 23.3 Tests proving future isolation (R, real cached data)
Week 6 of 2024: every value from week ≥ 6 of 2024 and all of 2025 is mutated (fake QBs/coaches/snap players; team-game and usage metrics scrambled) and the Week-6 rows must be `identical()`: the as-of discontinuity table, the prior-discount table, and the **full FI as-of bundle** (team ratings incl. confidence, player usage, interactions). Each has a **positive control** showing the legacy construction *does* change under the same mutation (so the test can detect leakage). Also: W vs W+1 isolation, OC/DC always UNKNOWN, `asof_visible` semantics. The full-row test found D9b.

### 23.4 D10 — exact root cause
`backtest.R` tuned (τ, cap) on the trailing-PPG control, folded those into the served model (τ=3, cap=.25), then reported "vs Sleeper" from a second run with its **own** tuned gate (τ=.5, cap=.08). The served gate was never evaluated against a production-like baseline, and a control-tuned gate was implicitly offered as production evidence. (Measured impact: §15 and the artifact.)

### 23.5 Corrected candidate-tuning semantics — one answer
`candidate_gate.R` (`candidate-gate-method-2026.1`): **tuned** = (τ, cap) chosen on **PRODUCTION_CAPTURED** pairs from the *earlier* eligible weeks; **evaluated** = the *identical* (τ, cap) on *later* held-out weeks against the *same* baseline; the trailing control is reported at that same served gate and **never selects**; τ=0 (never reverse) is always legal, so "no gate helps" is an honest outcome. `assert_gate_identity` fails closed if: tuned baseline ≠ production, evaluated baseline ≠ tuned, τ/cap differ between tune and eval or control, control participated, weeks overlap or are not chronological. `gate_apply` is proven equal to the frozen `backtest.R apply_gate`.

### 23.6 Frozen research principle (code + tests + docs)
Candidates predict **residual decision error in the production baseline**; target = `actual − captured pre-kickoff production baseline` (same scoring fingerprint asserted); selection prioritises reversal win rate vs production, mean reversal Δ, large-loss/large-win frequency, calibration by baseline edge, position, confidence, family ablation, out-of-sample chronology-safe performance; **projection MAE is secondary**. Encoded in the registry (`gate_methodology`, `primary_objective_metrics`, `secondary_metrics`), `CANDIDATE_TARGET`, and tested.

### 23.7 Re-evaluation pipeline safety (proof)
`reevaluate.R` no longer calls the legacy scripts at all. It consumes only exported `LIVE_CAPTURED` records + outcome enrichment and calls `assert_candidate_admissible`, which refuses (each tested): post-hoc/revised or mixed baselines, non-`LIVE_CAPTURED` classes, wrong target, scoring-fingerprint mismatch, non-AS_OF discontinuity, un-excluded UNSAFE features, mixed model/baseline versions, gate not ELIGIBLE / < minimum weeks / weeks lacking full per-week evidence, **any week the NFL reality artifact does not show COMPLETE**, and design families barred by the registry. `--force` is ignored; `guard_model_write` now refuses the legacy scripts for v1 *and* any candidate in a real repo. An **end-to-end test runs the real `reevaluate.R` in a throwaway sandbox** with synthetic evidence: valid evidence ⇒ one gate identity on the production baseline, no model written, never `PASSED`; mixed/post-hoc baseline ⇒ `FAILED`; partial NFL week ⇒ `FAILED`; too few weeks ⇒ dormant; missing evidence ⇒ `FAILED`. (This exercised the ELIGIBLE branch for the first time and caught a manifest-parsing bug, fixed.) `reevaluate.R` evaluates the gate and **fits nothing** — a v2 fit is a separate reviewed step.

### 23.8 Reproduction artifact
`reproduction_audit_2026-09-19.json` now has three separated sections: (1) frozen-v1 as reported (preserved), (2) corrected diagnostic (frozen betas at the served gate vs production-like baseline; legacy vs as-of features), (3) future methodology. Key numbers, frozen betas at served τ=3/cap .25 vs Sleeper 2023–25: legacy features 22,555 reversals, 47.4% win, −10,852 pts; as-of features 22,577, 47.4%, −10,718 pts. **D9 was a real integrity defect but did not manufacture v1's conclusion** (~1% change; 5–15% of team-feature cells moved, usage 0%). v1's betas were still trained on leaked features, so this is a diagnostic, not a re-certification.

### 23.9 Production DB check (read-only, no new state)
`bridge_startsit_shadow_captures/_outcomes`: additive (new tables + one trigger function, no existing object touched); 0 rows; RLS on with 0 policies (Supabase default `anon`/`authenticated` grants exist but are denied by RLS — same posture as the other `bridge_*` tables); INSERT-only triggers present; FK only outcomes→captures; rollback SQL in the migration file.

### 23.10 Regression / isolation
`start_sit_model.json` sha256 unchanged (pinned by test). Production parity (base `cf4dbb1` vs branch, four capture modes): all six section hashes identical, lineup 113.58, `SHADOW_ONLY`, `eligible_to_influence_production=false`. `fiMayInfluenceProduction` false for QB/RB/WR/TE/K/DEF; `anyFiProductionInfluence` false; structural tests show no waiver/trade/matchup/lineup consumer of Start/Sit FI. Results: see §24.

### 23.11 Remaining limitations
* L1 (unchanged, acceptable for branch certification): production runtime persistence is unproven until merge/deploy; schema behaviour verified directly and store HTTP behaviour by contract test.
* L3 capture covers requested rosters only; evidence is partial by construction.
* L2 kickoff *time* absent from the schedule feed (status-based lock).
* L4 v1's coefficients remain trained on leaked/trailing-target data; the model is frozen and SHADOW_ONLY and is **not validated**.
* L8 the captured-evidence export needs Supabase credentials; the candidate gate evaluation has only been exercised on synthetic evidence (no genuine evidence exists yet).
* L9 the candidate gate reuses captured v1 adjustments (cap can only tighten ≤ .25); a v2 fit is undone/unstarted.
* L10 `eligibility.R` / export not yet scheduled in CI.

## 24. Final verification (post-Checkpoint F)
* TypeScript `npm test`: **2105 tests / 2101 pass / 0 fail / 4 skipped** (Checkpoint E: 2104; +1 registry test). `tsc --noEmit`: 0 errors. `eslint app lib test`: 0 errors.
* R `analysis/football_intel_startsit/tests`: candidate-method (53 expectations), discontinuity-asof (15, real cached data), evidence-gate (44), reevaluate-e2e (24) — all pass. `analysis/football_intel/tests` invariants + week-completion pass.
* Real-repo guards verified by execution: `train.R`/`backtest.R` refuse (v1 frozen / no legacy candidates); `build_decision_dataset.R` refuses candidates and refuses the legacy discontinuity mode for candidates; `reevaluate.R` is dormant (`NOT_ELIGIBLE`, 0 weeks).
* Model sha256 `85d2ddd5…6293` unchanged and unmodified in git; production parity identical in all four capture modes.

## 25. FINAL PHASE 3.5A VERDICT
**CERTIFIED — RESEARCH INFRASTRUCTURE READY, CURRENT-SEASON EVIDENCE INSUFFICIENT, LIVE PRODUCTION CAPTURE VERIFICATION PENDING DEPLOYMENT.** The shadow model itself is **not validated**: it remains frozen, SHADOW_ONLY and, against a production-like baseline, a net loser at every position.

---

## 26. Deployment & production certification (2026-09-20)

Original findings above are unchanged. This section records the merge, deploy and the production verification that could not be done on an undeployed branch.

### 26.1 Pre-merge concurrency audit
| | |
|---|---|
| Certified branch tip | `32f2178` |
| local `main` / `origin/main` (before) | `cf4dbb1` / `cf4dbb1` (fetched; equal to the merge-base) |
| On `origin/main`, not in branch | none |
| On branch, not in `origin/main` | 7 commits (`93fce87` … `32f2178`) |
| Working tree | clean |
No drift, so no reconciliation. Merge was a **fast-forward** (`git merge --ff-only`), pushed `cf4dbb1..32f2178`. No force-push, no history rewrite, no tag.

### 26.2 Rollback reference (recorded before merge)
Production deployment `dpl_936UzXWbqcpaBXzrJKeFd3vNZPoD` @ `cf4dbb1` (READY; isRollbackCandidate). Aliases: `bloodline-bowl-sleeper-bridge.vercel.app`, `…-supyo29s-projects.vercel.app`, `…-git-main-supyo29s-projects.vercel.app`. `/api/health` 200. Intelligence (bloodline-bowl/supyo29, wk 2): lineup total 113.54, shadow `ri-startsit-2026.1` `SHADOW_ONLY`, FI `fi:2026:w02:351c149735ed`, baseline `sleeper-weekly-rotowire`, `eligible_to_influence_production=false`. `/api/football-intel/startsit-evidence` was 404 (route did not exist). Re-eval manifest `NOT_ELIGIBLE`, 0 weeks. Rollback = promote that deployment.

### 26.3 Deployment
Vercel built on push automatically: `dpl_AN1qt3wYbWJTmw2HwBAcxQVbYjkZ`, state **READY**, `githubCommitSha` = `32f21789db5b113388e34187bf3507d7e3b4160c` (**exact match** to merged main), target production, all three production aliases attached, `aliasError: null`. No manual promotion.

### 26.4 Contract preserved
`start_sit_model.json` sha256 `85d2ddd501cc10d5b3a699629f80c0c3781fe12fa24fa834f41969cb0186b293` — verified before merge, after merge, and unmodified in git. Deployed diagnostic route: `fi_may_influence_production` false for QB/RB/WR/TE, `any_fi_production_influence` false, deployment `SHADOW_ONLY`, evidence gate `evidence-gate-2026.2` `NOT_ELIGIBLE`. `--force` ignored, legacy writers refuse, capture classes distinct (DB `CHECK` enforces the four values).

### 26.5 Live production capture — ordinary runtime, read-only requests
Only `GET /api/intelligence/{league}/{manager}/week/2` was issued (no rows written by hand, no league mutation). The deployed runtime resolved `store.kind = supabase`, `durable = true`. All times UTC, season 2026, week 2, model `ri-startsit-2026.1`, FI `fi:2026:w02:351c149735ed`, baseline `sleeper-weekly-rotowire`:

| Manager (league) | Decision time | Applicable games | Class | capture_id | Scoring fingerprint |
|---|---|---|---|---|---|
| supyo29 (bloodline-bowl) | 05:29:58 | BUF, DET `complete`; rest `pre_game` | `LIVE_POST_LOCK` (`GAME_NOT_PRE_GAME:BUF:complete`) | `ssc:22ea4e73…` | `scoring:v1:29acc6bc…` |
| bijimac (bloodline-bowl) | 05:30:54 | BUF, DET `complete` | `LIVE_POST_LOCK` | `ssc:35692733…` | `scoring:v1:29acc6bc…` |
| darthmarker (devoted-to-the-game) | 05:30:56 | all 16 involved teams `pre_game` | **`LIVE_CAPTURED`** (`PRE_KICKOFF_VERIFIED`) | `ssc:6eef0492…` | `scoring:v1:d4795fa7…` |
| supyo29 (later, see 26.7) | 05:31:41 | as above | `LIVE_POST_LOCK` | `ssc:8e5fe36d…` | `scoring:v1:29acc6bc…` |

The classes came from the real lock state, not from selection: the two Bloodline Bowl rosters include Thursday-game teams (BUF/DET) so they are correctly post-lock, while `darthmarker`'s roster has none, so its record is a **genuine pristine pre-kickoff `LIVE_CAPTURED` record** (Sunday ~01:30 ET, before any Sunday game). Nothing was fabricated.

### 26.6 Durability
Direct SQL on the production project, after the requests had completed: rows exist with `record_schema_version=2`, deterministic `ssc:` ids, correct model/FI/baseline/scoring fields, `decision_timestamp` and `captured_at` set, `lock_evidence` (with per-game statuses) present, 16 adjustments each, `decisions` present (0/1), `model_fingerprint` `ade8f9e3de21c1f1`, `fi_generated_at` present, and `actual_fantasy_points` **null** (0 rows with actuals, 0 outcome rows). Runtime logs for the deployment: no errors/warnings.

### 26.7 Idempotency (deployed path, actual row counts)
* supyo29: 3 identical requests → **1 row**; original `decision_timestamp` preserved.
* darthmarker and bijimac: repeated, including cache-busted requests that re-executed (~1 s vs ~0.15 s cached) → **still 1 row each**.
* The only extra row (`ssc:8e5fe36d…`) is a *different decision context*: a diff of the two supyo29 records shows exactly one changed field, SF DEF `baseline_projection` 9.17 → 9.20 (a live projection update) → new `content_hash` → new id. This is the designed behaviour, not a duplicate.
* Final: 4 rows = 1 `LIVE_CAPTURED` + 3 `LIVE_POST_LOCK`, 4 distinct ids.

### 26.8 Recommendations unchanged / production parity
Pre-merge production reference (supyo29 wk2, `dpl_936U…`) vs post-deploy (`dpl_AN1q…`), volatile `*_at` and `age_seconds` stripped: lineup, start_sit, waivers, matchup, matchup_leverage, positional_needs **all identical**; lineup total 113.54 both; shadow adjustments identical. One apparent waivers hash difference was traced to a single freshness counter (`readiness.canonical.age_seconds` 3 vs 2), i.e. live-data noise, not code. Repeated requests (with and without capture) returned identical recommendations, including darthmarker's. Capture failure/timeout isolation was proven deterministically (tests 17/17b) and by the earlier throwing/hanging-store parity; no credentials were broken in production.

### 26.9 Live eligibility state
NFL reality: week 1 16/16 COMPLETE; week 2 1/16 PARTIAL; week 3 not started. FI `fi:2026:w02:351c149735ed` (wk 2, PARTIAL 1/16). Qualifying weeks: **none** (min 4, preferred 6). Rejected: week 1 (no prior current-season week; FI as-of unbuildable before wk 3) and week 2 (`WEEK_PARTIAL_1_OF_16_GAMES`, FI as-of floor, actuals not final). Week 2 now satisfies `PRODUCTION_BASELINE_AVAILABLE` (a real pre-kickoff capture exists) but is still rejected. Counts: LIVE_CAPTURED 1, LIVE_POST_LOCK 3, LIVE_UNVERIFIED 0, HISTORICALLY_RECONSTRUCTED 0. Re-evaluation status **NOT_ELIGIBLE**. No v2 trained.

### 26.10 Database verification (production `ijpfjdzmaztofawhwepf`)
Migration list shows exactly one new migration, `startsit_shadow_evidence` (applied version `20260919161844`; the repo file is named `20260919120000` because `apply_migration` re-stamps versions — same SQL). Not reapplied. Schema matches the design (16-column captures table, outcomes table); `capture_kind` CHECK on the four classes; `PRIMARY KEY (capture_id)` (deterministic uniqueness), outcomes `PRIMARY KEY (capture_id, source)` + FK to captures; RLS **on** for both, **0 policies**, no RLS-bypass for `anon`/`authenticated`; `BEFORE UPDATE OR DELETE` triggers on both. In a block that always rolled back, against a real production row: kind UPDATE blocked, record UPDATE blocked, DELETE blocked, orphan outcome rejected by FK. No existing table/object was altered by this work.

### 26.11 Regression on merged main
TypeScript `npm test`: 2105 tests / **2101 pass / 0 fail** / 4 skipped; `tsc --noEmit` 0 errors; `eslint` 0 errors; R: candidate-method, discontinuity-asof, evidence-gate, reevaluate-e2e all pass; Football Intelligence R invariants + week-completion pass. Includes Phase 1 frozen-contract, production-isolation and capture tests. No test was weakened.

### 26.12 Limitations after deployment
* **L1 — CLOSED for its stated scope:** the deployed production runtime durably persists correctly classified, immutable, idempotent evidence with no recommendation change. Precision: from outside, a same-instance short-circuit cannot be distinguished from a database `ON CONFLICT`; database uniqueness/immutability were verified directly in production, and no duplicate appeared under repeated and cache-busted requests.
* L3 (partial coverage) stands. New note: `PRODUCTION_BASELINE_AVAILABLE` is satisfied by a *single* pre-kickoff record; it says a baseline exists, not that coverage is adequate for evaluation.
* New (design observation, not changed): capture identity covers the whole decision content, so **any one player's projection tick creates a new full record per manager** (seen: 9.17→9.20). Volume/retention should be reviewed before a busy Sunday; this is a follow-up, not a defect in correctness.
* Capture-health counters are per serverless instance (the diagnostic route showed zeros on a different instance than the one that wrote); the database is the source of truth.
* L2 (status-based lock, no kickoff time), L4 (v1 provenance; model not validated), L8–L10 unchanged.

### 26.13 Verdict
**A. FULLY PRODUCTION-CERTIFIED INFRASTRUCTURE.** Phase 3.5A production certification complete. Research infrastructure is deployed and operational; current-season evidence remains insufficient for model tuning. `ri-startsit-2026.1` remains frozen and SHADOW_ONLY.
