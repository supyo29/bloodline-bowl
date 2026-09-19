# Intelligence Modernization — Phase 3.5A
## Shadow Model Audit, Evidence Integrity & Tuning Foundation

Status: **in progress** (Checkpoint A committed; later sections are appended per checkpoint).
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
