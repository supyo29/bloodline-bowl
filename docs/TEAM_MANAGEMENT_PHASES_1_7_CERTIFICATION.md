# Team Management Phases 1–7 — Full-Stack Integration Certification

_Certification of the complete Team Management intelligence stack: merge of the certified
stacked phases onto `main`, cross-phase verification of Phases 1–7 together, production-isolation
certification, deploy, production certification._

**This is not a new modeling phase.** No recommendation logic was introduced. No frozen artifact
was modified. The Team Management Orchestrator is **not** started.

---

## 1. Merge graph

The stack was a clean linear chain on top of the Phase-2-certified mainline
(`48a97cb`) — no merges, no unrelated commits, no divergence:

```
48a97cb  main (Phase 1 DEPLOYED schema_v3 + Phase 2 MERGED c6edde6, plus bridge-realtime work)
│
├─ d3704ad  phase 3 pre-implementation audit
├─ 85a4424  phase 3 — R Football Intelligence Engine          ← ri-football-intel-2026.1  (fi:2025:w18:6e872c5caa82)
├─ 4f9e557  phase 4 pre-implementation checkpoint
├─ c897e01  phase 4 — FI Start/Sit translation (SHADOW_ONLY)  ← ri-startsit-2026.1
├─ f874f3f  phase 4 remediation A+C — freeze contract + dormant 2026 re-cert
├─ eaafc8e  phase 5 pre-implementation audit
├─ 582feb8  phase 5 — Matchup Intelligence (SHADOW_ONLY)      ← ri-matchup-2026.1
├─ a6999d0  phase 6 pre-implementation audit
├─ 2498a19  phase 6 — Roster Health (SHARED_CONTEXT)          ← roster-health-2026.1
├─ d39f12e  phase 7 pre-implementation audit
└─ 3ce66eb  phase 7 — Schedule & Forward Planning (SHARED_CONTEXT) ← schedule-planning-2026.1
```

**Integration strategy:** fast-forward `main` → `3ce66eb`. `git merge --ff-only`, zero conflicts,
no merge commit. 99 files changed, +41 164 / −0 (all additive). Ancestry verified with
`git merge-base --is-ancestor` for every adjacent phase pair.

- **Phase 1 certified commit:** `f43c35d` (in `main` history before `48a97cb`) — `PHASE 1 CERTIFIED — READY TO FREEZE`, deployed.
- **Phase 2 certified commit:** `c6edde6` — `PHASE 2 CERTIFIED`, merged to `main`.
- **Phase 3 checkpoint:** `85a4424`
- **Phase 4 checkpoint:** `f874f3f`
- **Phase 5 checkpoint:** `582feb8`
- **Phase 6 checkpoint:** `2498a19`
- **Phase 7 checkpoint:** `3ce66eb`
- **Integrated `main` SHA:** `3ce66eb` (pre-tag). See §Deployment for the pushed SHA.

Working tree clean throughout; no history rewritten.

---

## 2. Deployment-state matrix (§11)

| Layer | Version | Deployment | Guard (machine-verified) |
| --- | --- | --- | --- |
| Phase 1 — Canonical League State | schema_v3 · `scoring:v1` · freeze contract §17 | **PRODUCTION FOUNDATION** | `cross_surface_discrepancies = 0` (live, 3 leagues) |
| Phase 2 — Team-State | `team-state-2026.1` | **SHARED FOUNDATION** | `git diff 48a97cb..HEAD -- lib/team-state/` = ∅ |
| Phase 3 — Football Intelligence | `ri-football-intel-2026.1` (`fi:2025:w18:6e872c5caa82`) | **SHARED / RESEARCH per routing** — `OBSERVED` / `MODELED` / `DESCRIPTIVE_ONLY`; `NOT_PREDICTIVE` fields barred from numeric production influence | 39/39 R invariant + adversarial checks; served from committed CSV/JSON only |
| Phase 4 — Start/Sit FI | `ri-startsit-2026.1` | **SHADOW_ONLY** | `fiMayInfluenceProduction()` = `false` for QB/RB/WR/TE/K/DEF; `anyFiProductionInfluence()` = `false` |
| Phase 5 — Matchup Intelligence | `ri-matchup-2026.1` | **SHADOW_ONLY** | `matchupMayInfluenceProduction()` = `false`; no `MAX_WIN_PROBABILITY` in any production path |
| Phase 6 — Roster Health | `roster-health-2026.1` | **SHARED_CONTEXT** | `lib/trades/depth.ts` byte-identical; every team `lineage.deployment = SHARED_CONTEXT` |
| Phase 7 — Schedule Planning | `schedule-planning-2026.1` | **SHARED_CONTEXT** | `lib/trades/ros.ts` byte-identical; every team `lineage.deployment = SHARED_CONTEXT`; `football_intelligence_version = "not_used"` |

No merge changed any deployment state.

> **P3 nit (S-1):** `start_sit_model.json.deployment_contract.production_influence_state` is a
> *definition* constant (`"PRODUCTION_ACTIVE"` = the name of the state in which influence would
> occur), not a live status. The operative gate is `positions: {}` + `activation_log: []` +
> `deployment: "SHADOW_ONLY"`, and `fiMayInfluenceProduction()` returns `false`. The field name
> invites misreading — rename to `production_influence_requires_state` in a future touch.

---

## 3. Phase 1 certification — canonical source of truth (§4)

`node --import tsx scripts/phase1c-certify.ts` (live, from merged `main`):

| league | status | snapshot_id | cross_surface_discrepancies | null_required_fields | identity_unresolved | provider_reads/composite op |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `bloodline-bowl` | in_season w1 | `snap:bloodline-bowl:2026:w1:1af3658949f1d670` | **0** | **0** | 0 | 1 |
| `devoted-to-the-game` | in_season w1 | `snap:devoted-to-the-game:2026:w1:22479a5b6e50687c` | **0** | **0** | 0 | 1 |
| `sportys-alumni` | pre_draft | `snap:sportys-alumni:2026:w1:ea1e2881667db890` | **0** | **0** | 0 | 1 |

`test/certification.test.ts` (deterministic harness self-test + field-completeness + eligibility
matrix + snapshot-id contract + scope concurrency): **20/20 pass**.
`test/canonical-lineage.test.ts`: **18/18**.
`buildCanonicalLeagueState` remains the sole normalizer; `runInLeagueStateScope` remains
execution-scoped; no alternate normalization path reappeared (see §5). Phase 1 freeze intact.

---

## 4. Phase 2 certification — Team-State substrate (§5)

`git diff 48a97cb..HEAD -- lib/team-state/` is **empty** — Phase 2 is byte-unchanged by the
integration. `test/team-state.test.ts`: **21/21 pass**. Team-State joined the Phase 1C harness
(`factsFromLeagueManagementContext`) and reports `cross_surface_discrepancies = 0` on all
real leagues.

No Phase 6/7 evaluative logic leaked backward: the only imports *out of* `lib/team-state/` are
into `lib/roster-health/` and `lib/schedule-planning/` (forward, allowed). Nothing imports
`roster-health` or `schedule-planning` *into* `team-state`.

`structural_surplus` (Phase 2, structural) and `quality_surplus` (Phase 6, evaluative) remain
distinct — see §7 Case A.

---

## 5. Phase 3 certification — Football Intelligence (§6)

- `Rscript analysis/football_intel/tests/run.R` → **24 invariant checks pass**.
- `Rscript analysis/football_intel/adversarial_audit.R` → **15 checks, 0 failed** (tiny-sample
  prior dominance, no wk1 HIGH confidence, monotone confidence, opponent adjustment, one-game
  robustness, historical-alias collapse, `def_pass_epa_allowed` carries `NOT_PREDICTIVE`,
  participation never fabricated as 0, padding-vs-weak-D adjustment).
- `test/football-intel-read.test.ts` → **10/10** — TS readers load the committed artifacts
  (`lib/football-intel/data/*.csv|json`) from the merged repo; manifest resolves
  `ri-football-intel-2026.1` / `fi:2025:w18:6e872c5caa82`; data cutoffs (all week 18) intact;
  `seasons_used.prior = [2021,2022,2023,2024]`, `current = 2025`.
- Routing classes unchanged: `OBSERVED` / `MODELED` / `DESCRIPTIVE_ONLY`. FTN and man/zone
  remain `DESCRIPTIVE_ONLY` and feed no rating/prior/trend/backtest.
- FI is consumed only by `lib/weekly/start-sit-fi/{translate,production-gate,shadow}.ts` — the
  Phase 4 shadow path. No production recommendation imports `@/lib/football-intel`.

---

## 6. Phase 4 certification — Start/Sit FI (§7)

- `ri-startsit-2026.1` served with `deployment: "SHADOW_ONLY"`, `deployment_contract.positions = {}`,
  `activation_log = []`.
- **`fiMayInfluenceProduction(model, pos)` = `false` for every position** (QB/RB/WR/TE/K/DEF),
  `anyFiProductionInfluence(model)` = `false` — evaluated directly against the served artifact.
- `test/start-sit-fi.test.ts` 13/13 · `test/start-sit-fi-isolation.test.ts` 4/4 ·
  `test/start-sit-fi-remediation.test.ts` 12/12 (deployment-state machine, no-skip transitions,
  `applyFiToProductionBatch` no-op under the current contract, re-evaluation manifest
  `NOT_ELIGIBLE` / `next_candidate_version = ri-startsit-2026.2`, `LIVE_CAPTURED` vs
  `HISTORICALLY_RECONSTRUCTED`, no-auto-promotion).
- `Rscript analysis/football_intel_startsit/adversarial_audit.R` → **12 checks, 0 failed**
  (adjustment bounded by 0.25·|baseline|, tie-break gate τ=3.0 cannot flip a decision,
  unresolved FI → 0 adjustment, `NOT_PREDICTIVE`/`DESCRIPTIVE_ONLY` families absent from the
  model, determinism).
- Production Start/Sit remains `MAX_EXPECTED` over the `sleeper-weekly-rotowire` projection.
  **Production Start/Sit behaviour change = 0** (`lib/weekly/start-sit.ts` + `lib/weekly/lineup.ts`
  byte-identical `48a97cb..HEAD`).

---

## 7. Phase 5 certification — Matchup Intelligence (§8)

- `ri-matchup-2026.1` served with `deployment: "SHADOW_ONLY"`.
  `matchupMayInfluenceProduction()` = `false`.
- `test/matchup-intelligence.test.ts` → **19/19** (empirical standardized-residual z-grid
  marginals, heteroscedastic sd, K/DST special distributions, seeded MC determinism + seed
  lineage, whole-percent WP, degradation vector, 2-factor dependence **diagnostic-only**,
  production isolation).
- `Rscript analysis/football_intel_matchup/real_crosscheck_and_convergence.R` → recommended
  `SIM_N = 10000`, WP sd across seeds `0.0058` vs theoretical SE `0.0050`, 71 ms / 12 managers.
- `Rscript analysis/football_intel_matchup/context_fi_ablation.R` → every game-context and FI
  variance feature scores `< 0.005` incremental (noise-level) → **all excluded**; the null
  findings from the Phase 5 certification remain null.
- `MAX_WIN_PROBABILITY` appears only in `lib/weekly/matchup-intelligence/{index,schema}.ts` as a
  shadow diagnostic type — **not** in any production lineup / start-sit / context path.
- `lib/weekly/matchup.ts` (production `buildMatchup`) byte-identical `48a97cb..HEAD`. The
  production `matchup.win_probability` and the shadow `matchup_intelligence.win_probability`
  are distinct, separately versioned fields — live example (bloodline `supyo29`): production
  `0.482` vs shadow `0.4909`; (devoted `darthmarker`): `0.38` vs `0.4294`.
- **Production matchup behaviour change = 0.**

---

## 8. Phase 6 certification — Roster Health (§9)

- `roster-health-2026.1`, `deployment = SHARED_CONTEXT` on every team in both leagues.
- `test/roster-health.test.ts` → **16/16** (whole-lineup `maxSlotMatching` contingency,
  four-form player dependency, FLEX/SUPER_FLEX joint matching, structural-vs-quality surplus,
  fragility component vector + profile, league/position percentiles, `FA_POOL_ROS_APPROXIMATE`
  on the ROS horizon, K/DST excluded from core fragility + SPOF, health delta zero on identical
  inputs, recommendation isolation).
- `lib/trades/depth.ts` byte-identical `48a97cb..HEAD`; `lib/trades/**` imports nothing from
  `roster-health`. No trade / waiver / lineup / start-sit / production-matchup score changed
  (full trade-engine + weekly suites pass unchanged — §10).
- Weekly and `rest_of_season` are separate `HorizonView`s, never blended.

---

## 9. Phase 7 certification — Schedule & Forward Planning (§10)

- `schedule-planning-2026.1`, `deployment = SHARED_CONTEXT` on every team.
- `test/schedule-planning.test.ts` → **19/19** (full-season schedule load = one cached provider
  read, bye detection, whole-season opponent resolution, future legal-lineup coverage via the
  frozen `buildOptimalLineup`, FLEX/SUPER_FLEX collision — a versatile backup never fills two
  simultaneous slots, **STRUCTURE-vs-VALUE confidence split**, `WEEKLY` vs `ROS_PROJECTION`
  basis routing, playoff weeks from canonical `playoff_settings` not hard-coded, planning delta
  descriptive-only + zero on identical inputs, trade-ROS isolation).
- `lib/trades/ros.ts` byte-identical `48a97cb..HEAD`. Phase 6 `evaluateHorizon` called
  unmodified (per-week scenario only).
- Live: both leagues, 12-team, 17-week timelines; playoff weeks `[15,16,17]` from
  `playoff_settings` (start 15 / teams 6 / championship 17); real 2026 NFL byes resolve
  (wk5 CAR/KC, wk7 BUF/JAX/LAC/WAS, …); week 6's incomplete feed flagged
  `SCHEDULE_WEEK_INCOMPLETE` with **no fabricated byes**. `football_intelligence_version = "not_used"`.

---

## 10. Full regression (§20)

From merged `main` (`3ce66eb`):

| check | result |
| --- | --- |
| `tsc --noEmit` | **clean** |
| `eslint app lib test` | **0 errors**, 29 warnings (**0 new** — same pre-existing set as the Phase 6 baseline) |
| `npm test` (`test/*.test.ts`, 471 suites) | **1558 tests · 1554 pass · 0 fail · 4 skipped** |
| skipped | 4 pre-existing pre-draft-only self-skips (`analytics-live`, `draft-live`, `draft-cache-headers-live` subtests — league is `in_season`) |
| R — `analysis/football_intel/tests/run.R` | 24/24 |
| R — `analysis/football_intel/adversarial_audit.R` | 15/15 |
| R — `analysis/football_intel_startsit/adversarial_audit.R` | 12/12 |
| R — Phase 5 convergence + ablation | reproduce certified findings |
| Phase 1C live cert (3 leagues) | `cross_surface_discrepancies = 0`, `null_required_fields = 0` |

Per-suite (targeted): football-intel-read 10 · start-sit-fi 13 · start-sit-fi-isolation 4 ·
start-sit-fi-remediation 12 · matchup-intelligence 19 · roster-health 16 · schedule-planning 19 ·
team-state 21 · canonical-lineage 18 · certification 20 · weekly-isolation 5 · weekly-hardening 8 ·
weekly-lineup 35 · weekly-matchup 14 · weekly-waivers 25 · trade-engine 19 · trade-engine-phase6 38 ·
scoring 42 · projections 17 — **all pass, 0 existing tests changed or weakened**.

---

## 11. Recommendation-isolation certification (§16)

**Structural proof.** `git diff --stat 48a97cb..HEAD` for every frozen recommendation surface is
**empty**:

```
lib/trades/ros.ts   lib/trades/depth.ts
lib/weekly/lineup.ts   lib/weekly/slots.ts   lib/weekly/start-sit.ts
lib/weekly/waivers.ts   lib/weekly/matchup.ts
lib/team-state/**   lib/canonical/**
```

The only production file touched is `lib/weekly/intelligence.ts` (+44 lines): two nullable
shadow fields (`start_sit_shadow`, `matchup_intelligence`), each computed **after** the
production `lineup` / `start_sit` / `matchup` / `waivers` results, each wrapped in
`try { … } catch { = null }`, neither fed back into any production result or into
`buildWeeklySummary`. Verified by diff and by `test/weekly-isolation.test.ts` (5).

**Behavioural proof.** The full trade-engine (7 phase suites), weekly, lineup, waiver, matchup,
scoring and projection suites — 500+ deterministic assertions — pass **unchanged** on merged
`main`. No production recommendation value moved.

**Import-graph proof (§15).** Reverse dependency scan:

| new layer | consumed by | verdict |
| --- | --- | --- |
| `lib/weekly/start-sit-fi` | `lib/weekly/intelligence.ts` only | shadow attach only |
| `lib/weekly/matchup-intelligence` | `lib/weekly/intelligence.ts` only | shadow attach only |
| `lib/roster-health` | `lib/schedule-planning/*` (allowed — Phase 7 reuse) + its 2 API routes | no engine consumes it |
| `lib/schedule-planning` | its 2 API routes only | no engine consumes it |
| `lib/football-intel` | `start-sit-fi/{translate,production-gate,shadow}` only | gated by `fiMayInfluenceProduction` = false |

No new provider read, no second roster/scoring/ownership/identity normalizer, no name-based
identity bypass, no hard-coded FLEX legality. The new layers read only `@/lib/canonical/*`,
`@/lib/team-state/*`, the shared schedule provider, and committed model artifacts.

---

## 12. Cross-phase shared-snapshot coexistence (§12, §17)

One `runInLeagueStateScope`, one manager per league, all layers built together:

| | bloodline-bowl / supyo29 | devoted-to-the-game / darthmarker |
| --- | --- | --- |
| Weekly Intelligence `snapshot_id` | `snap:…:1af3658949f1d670` | `snap:…:22479a5b6e50687c` |
| Team-State `league_snapshot_id` | same | same |
| Roster Health `lineage.league_snapshot_id` | same | same |
| Schedule Planning `lineage.league_snapshot_id` | same | same |
| scoring_fingerprint (all 4) | `scoring:v1:29acc6bc…` (equal) | `scoring:v1:d4795fa7…` (equal) |
| roster_id / canonical_team_id (all layers) | `1` / `team:bloodline-bowl:1` | `2` / `team:devoted-to-the-game:2` |
| `start_sit_shadow` | present · `SHADOW_ONLY` · `ri-startsit-2026.1` | present · `SHADOW_ONLY` · `ri-startsit-2026.1` |
| `matchup_intelligence` | present · `SHADOW_ONLY` · `ri-matchup-2026.1` · `fi=not_used` | present · `SHADOW_ONLY` · `ri-matchup-2026.1` |
| projection lineage | `sleeper-weekly-rotowire` + `ri-structural-2026.3` | same |

**No layer analysed a different league state inside the same logical operation.** Every layer
identifies its own model version and preserves projection lineage. Full-league sweep (12 teams
× 2 leagues): snapshot coherent across TS/RH/SP for all 24 teams; all 24 WI reads `ok` with
both shadows present.

---

## 13. Cross-phase horizon audit (§13)

| distinction | how the merged stack keeps it | evidence |
| --- | --- | --- |
| current weekly vs ROS | Schedule Planning `projection_basis ∈ {WEEKLY (current wk only), ROS_PROJECTION}`; `value_source` carries `weekly_model_version` + `ros_source` separately | `schedule-planning.test.ts` §8 tests |
| ROS vs true future weekly | future weeks always carry `FUTURE_WEEKLY_PROJECTION_UNAVAILABLE` + `ROS_PROJECTION_USED`; never labelled `WEEKLY` | idem |
| current Roster Health vs future Phase 7 pressure | Phase 6 `HorizonView` (`weekly` / `rest_of_season`) vs Phase 7 `WeekPlan.future_roster_health` per NFL week | `roster-health.test.ts`, `schedule-planning.test.ts` |
| structural surplus vs quality surplus | separate fields, separate owners (Phase 2 / Phase 6), both surfaced side-by-side | §14 Case A |
| current matchup WP vs future schedule context | production `matchup.win_probability` (pregame, this week) vs Schedule Planning `schedule_context` (descriptive, future) | §12 table |

STRUCTURE confidence (bye / opponent / coverage / playoff week) stays `HIGH` for the whole
regular season even when VALUE confidence is `ROS_CONTEXT_ONLY` — asserted in
`schedule-planning.test.ts` and observed live (supyo29 wk15: structure `HIGH`, value
`ROS_CONTEXT_ONLY`).

---

## 14. Cross-layer semantic-conflict audit (§14)

| case | observed (live) | verdict |
| --- | --- | --- |
| **A** — Team-State `structural_surplus = {RB, WR, FLEX}` for supyo29, Roster Health `quality_surplus = ∅`, `fragility = FRAGILE_BOTH` | **valid, not a conflict.** Structural surplus = enough eligible bodies to field the slot and keep a spare. Quality surplus = a *bench* player materially above replacement *beyond* what is fieldable — none here. Fragility = losing a *starter* still hurts. The three facts have different definitions and different horizons; each carries its own reason codes. | documented semantics preserved |
| **B** — Roster Health current RB depth adequate, Schedule Planning wk 7 / 11 / 14 RB coverage gap | **valid.** Current health (all players available) vs future weeks with schedule-verified byes applied. `WeekPlan.degradation` + `projection_basis = ROS_PROJECTION` + `structure_confidence = HIGH` make the horizon explicit. | current ≠ future; metadata explains |
| **C** — production Start/Sit vs `start_sit_shadow` preference | shadow is `SHADOW_ONLY`, carries its own lineage, production output unchanged | contract-consistent |
| **D** — production `matchup.win_probability` (0.482) vs shadow `matchup_intelligence.win_probability` (0.4909) | two clearly separated, separately versioned fields; production is the calibrated-MC field, shadow is the empirical-marginal research field | intentional, explainable |

No case of two layers making genuinely incompatible claims from the same snapshot / roster /
identity was found. All divergences trace to a documented difference in definition or horizon.

---

## 15. Lineage coherence (§15)

For a single live management request the stack shares: canonical snapshot id, scoring
fingerprint, Team-State version (`team-state-2026.1`), weekly projection lineage
(`sleeper-weekly-rotowire`), ROS projection lineage (`ri-structural-2026.3` /
`sleeper_season_rotowire_prorated`), and each layer stamps its own model version
(`ri-startsit-2026.1`, `ri-matchup-2026.1`, `roster-health-2026.1`, `schedule-planning-2026.1`,
FI `fi:2025:w18:6e872c5caa82` where descriptive). No layer silently reads a different snapshot
within one logical operation (§12).

---

## 16. Performance audit (§19)

One `runInLeagueStateScope`, full league (12 managers), cold:

| stage | bloodline-bowl | devoted-to-the-game | provider reads |
| --- | ---: | ---: | ---: |
| canonical + Team-State context | 484 ms | 173 ms | 1 composite op |
| Roster Health (12 teams × 2 horizons) | 724 ms | 295 ms | 0 extra |
| Schedule Planning (12 teams × 17 weeks) | 455 ms | 442 ms | 0 extra (schedule = 1 cached read) |
| Weekly Intelligence incl. both shadows | ~578 ms / mgr | ~654 ms / mgr | shared batch |

- Per-manager weekly endpoint ≈ 0.6 s (`maxDuration = 60`) — no serverless-timeout risk.
- League-wide Roster Health / Schedule Planning endpoints ≈ 0.3–0.7 s, `Cache-Control: 30/120`.
- **Provider reads:** `provider_reads_one_composite_op = 1` (canonical) + one cached
  whole-season schedule fetch. No per-manager / per-week provider amplification.

**P2 performance debt (deferred — spec §19, no frozen-semantics refactor now):**
`buildRosterHealthContext` and `buildSchedulePlanningContext` each independently call
`buildRosterHealthInputs` (which reassembles the weekly projection batch + RI signal) and
`buildLeagueManagementContext`. Within one scope the canonical *state* read is memoized, but the
projection-batch assembly and Team-State build repeat between the two layers; Schedule Planning
additionally re-runs Phase 6 `evaluateHorizon` per near-term week. The Team Management
Orchestrator is the natural place to build the shared inputs once and fan out. No behavioural
impact; documented for the Orchestrator phase.

---

## 17. Findings

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| I-1 | P3 | `start_sit_model.json … production_influence_state` is a definition constant, not a status; name invites misreading | Documented (§2). Guards verified `false`. Rename on next touch. |
| I-2 | P3 | preseason (0 played weeks) → every Roster Health team reports non-`OK` overall degradation (`FA_POOL_ROS_APPROXIMATE` on the ROS horizon bubbles up) | Expected + tested (`roster-health.test.ts` "ROS horizon always carries FA_POOL_ROS_APPROXIMATE"). Self-resolves once weekly actuals exist. |
| I-3 | P2 | Roster Health + Schedule Planning each re-assemble the shared projection/Team-State inputs within one scope | Deferred to the Orchestrator (§16). No behavioural impact. |
| I-4 | P3 | `sportys-alumni` now in the league registry (`pre_draft`); Phase 1C cert covers it (0 discrepancies) | Informational — registry grew via the concurrent bridge work; no action. |

**No P0. No P1.** Every certified deployment state is intact; production recommendation
behaviour change is 0.

---

## 18. Full-stack freeze contract (§22)

The Phase 1–7 intelligence stack is **frozen**. Future work may *consume* these layers; it may
not silently mutate them.

- **Phase 1** — no canonical-state semantic change without re-running the Phase 1C certification
  harness (`cross_surface_discrepancies` must stay 0).
- **Phase 2** — no evaluative / recommendation logic may be added to Team-State. Structural
  facts stay projection-free.
- **Phase 3** — no `DESCRIPTIVE_ONLY` / `NOT_PREDICTIVE` / `UNVALIDATED` FI field may become a
  numeric production-recommendation input without target-specific walk-forward validation.
- **Phase 4** — `ri-startsit-2026.1` stays `SHADOW_ONLY`. Production influence requires an
  explicit, versioned, human-reviewed `activation_log` entry setting a position to
  `PRODUCTION_ACTIVE`; `isValidTransition` forbids skipping lifecycle states; no research
  verdict promotes automatically. Candidate for re-cert is `ri-startsit-2026.2` (dormant,
  gated on ≥ 4 genuine 2026 FI weeks).
- **Phase 5** — `ri-matchup-2026.1` stays `SHADOW_ONLY`. No production `MAX_WIN_PROBABILITY`
  objective without a dedicated certification phase. The 2-factor dependence model stays
  diagnostic-only.
- **Phase 6** — Roster Health stays `SHARED_CONTEXT`. Wiring it into trade or waiver scoring
  requires a dedicated integration + certification phase. `lib/trades/depth.ts` stays frozen.
- **Phase 7** — Schedule Planning stays `SHARED_CONTEXT`. Wiring it into trade / waiver /
  lineup / streaming recommendations requires a dedicated integration + certification phase.
  `lib/trades/ros.ts` stays frozen; Phase 6 `evaluateHorizon` semantics stay frozen.
- **Horizons** — weekly and ROS values are never silently blended; every week-level value
  exposes its `projection_basis` + source + horizon.
- **Lineage** — every future consumer preserves the snapshot id + scoring fingerprint + model
  versions.

Any change to `lib/trades/{ros,depth}.ts`, `lib/weekly/{lineup,slots,start-sit,waivers,matchup}.ts`,
`lib/team-state/**`, or `lib/canonical/**` re-opens the relevant freeze.

---

## 19. Orchestrator entry criteria

The Team Management Orchestrator (a *future* phase — **not** started here) may:

- consume Phase 1 canonical state, Phase 2 Team-State, and the Phase 3–7 layers as read-only inputs;
- build the shared inputs once (resolving the §16 P2 debt) and fan out to all layers;
- compose their outputs into a single management view.

It may **not**: mutate any layer's contract, move a `SHADOW_ONLY` model into production, wire a
`SHARED_CONTEXT` layer into a recommendation score, alter frozen trade / lineup / scoring
components, or blend horizons.

---

## 20. Known limitations

- No predictive validation for any Phase 3–7 layer in `bloodline-bowl` (first-year league, 0
  played weeks). v1 certifies determinism + math + schedule/identity correctness + real-league
  smoke. Dormant re-evaluations: `ri-startsit-2026.2`, `ri-matchup-2026.2`,
  `roster-health-2026.2`, `schedule-planning-2026.2` — all gated on genuine 2026 weeks, none
  auto-promoting.
- Football Intelligence artifacts are a frozen 2025-through-week-18 snapshot; refresh is a
  deliberate R-pipeline run, not automatic.
- NFL week 6's schedule feed is currently structurally incomplete on the provider — correctly
  surfaced as `SCHEDULE_WEEK_INCOMPLETE`, self-resolving.
- Schedule Planning has no home/away (provider does not expose it) and does not model
  fantasy-playoff opponents.
- §16 P2 input-reassembly debt, deferred to the Orchestrator.

---

## Deployment (§24–§25)

- **Integrated `main` SHA:** `f152545` (merge FF `48a97cb → 3ce66eb` + this certification doc `f152545`).
- **Tag:** `team-management-phases-1-7-2026.1` → `f152545` (pushed to `origin`).
- **Push:** `git push origin main` → `48a97cb..f152545`, plus the tag.
- **Vercel:** deployment `dpl_CAEtSP3FiSRd1iQEWNvoSNTGSHZh`, target `production`, commit `f152545`,
  **state `READY`**, region `iad1`, alias `bloodline-bowl-sleeper-bridge.vercel.app`, `aliasError: null`.

## Production certification (§26–§31)

**Phase 1 — canonical (prod).** `GET /api/league/bloodline-bowl/state`:
`schema_version: 3`, `lineage.league_snapshot_id: snap:bloodline-bowl:2026:w1:44ba3cfb957dad7d`,
`scoring_fingerprint: scoring:v1:29acc6bcd911df090b5b9b9c` (**identical to local**),
`roster_fingerprint: roster:v1:58bde6f903a48abe18246dcd` (**identical to local**),
`state_source: LEGACY_LIVE_PATH`, `fallback.occurred: false`, `snapshot_integrity: CERTIFIED`,
12 rosters / 184 players, `playoff_settings {15, 6, 17}`. All capabilities `HEALTHY` except
`free_agent_pool: UNAVAILABLE` (documented Phase 2 limitation — not a regression).

> **Environment-specific difference (expected, documented).** The production snapshot
> *content hash* (`…44ba3cfb…`) differs from local (`…1af36589…`) because production resolves
> player identity through the Supabase GSIS crosswalk (`crosswalk_version:
> supabase:nfl_players:266`, `player_data_version: players:v1:7c01c938bfadf3a3` vs local
> `…5f49935c…`). Both environments are internally deterministic. **Logical facts agree**:
> identical scoring + roster fingerprints, identical week / status / team count / playoff config.

**Phase 2 — Team-State (prod).** `/api/leagues/{slug}/manage` and
`/api/leagues/{slug}/managers/{mgr}/manage` → 200, `league_snapshot_id` coherent with Phase 1.

**Phases 3–7 (prod).**

| endpoint | bloodline-bowl | devoted-to-the-game |
| --- | --- | --- |
| `/api/leagues/{l}/roster-health` | 200 · `roster-health-2026.1` · `SHARED_CONTEXT` · 12 teams | 200 |
| `/api/leagues/{l}/schedule-planning` | 200 · `schedule-planning-2026.1` · `SHARED_CONTEXT` · `fi=not_used` · playoff `{15,6,17}` from canonical · 12 teams · 17-week timelines | 200 |
| `/api/leagues/{l}/managers/{m}/roster-health` | 200 | 200 |
| `/api/leagues/{l}/managers/{m}/schedule-planning` | 200 | 200 |
| `/api/intelligence/{l}/{m}/week/1` `start_sit_shadow` | present · `SHADOW_ONLY` · `ri-startsit-2026.1` | present · `SHADOW_ONLY` |
| `/api/intelligence/{l}/{m}/week/1` `matchup_intelligence` | present · `SHADOW_ONLY` · `ri-matchup-2026.1` · `fi=not_used` | present · `SHADOW_ONLY` |

Snapshot coherence in production: `roster-health`, `schedule-planning`, `manage` and
`intelligence` all report the same `league_snapshot_id` per league
(`…44ba3cfb…` / `…f0e05074…`).

**Existing production engines (prod smoke).** `/api/league/{l}/state`, `/manage`, `/standings`,
`/scoring`, `/api/intelligence/{l}/{m}/week/1`, `/api/lineup/…`, `/api/matchup/…`,
`/api/waivers/…`, `/api/leagues/{l}/projections` — **all 200**. Error paths fail closed:
`GET /api/trades/analyze` → 405, unknown league / manager → 404, no 5xx.

**Production recommendation isolation (§30).** Production values are byte-identical to the
local pre-deploy checks:

| | local | production |
| --- | ---: | ---: |
| bloodline `supyo29` `lineup.optimal_total` | 113.36 | **113.36** |
| bloodline `supyo29` production `matchup.win_probability` | 0.482 | **0.482** |
| devoted `darthmarker` production `matchup.win_probability` | 0.38 | **0.38** |

The shadow `matchup_intelligence.win_probability` shows sub-1-percentage-point environment
variance (bloodline 0.4909 → 0.4901; devoted 0.4294 → 0.4225) because the shadow Monte-Carlo
joins on crosswalk-resolved player identity, which differs local↔prod. This is a **shadow
diagnostic** with `deployment = SHADOW_ONLY`; the production `matchup.win_probability` field is
unaffected and identical. No production recommendation value changed.

**Runtime / health (prod).** Per-manager weekly endpoint and the league-wide
roster-health / schedule-planning endpoints all respond well within the `maxDuration = 60`
lambda budget; `Cache-Control: 30/120`. The bridge published-snapshot flag remains **OFF**
(`state_source: LEGACY_LIVE_PATH`) — the Phase 3–7 merge did not touch the bridge read path.

---

## VERDICT

The complete Phase 1–7 Team Management intelligence stack is merged to `main` (`f152545`,
tag `team-management-phases-1-7-2026.1`), deployed to Vercel production (`dpl_CAEtSP3F…`,
`READY`), and certified:

- Fast-forward merge, zero conflicts, all additive; every frozen recommendation surface
  (`lib/trades/{ros,depth}.ts`, `lib/weekly/{lineup,slots,start-sit,waivers,matchup}.ts`,
  `lib/team-state/**`, `lib/canonical/**`) byte-identical `48a97cb..HEAD`.
- Deployment states intact and machine-verified: Start/Sit FI + Matchup Intelligence
  `SHADOW_ONLY` (`fiMayInfluenceProduction` / `matchupMayInfluenceProduction` = `false`);
  Roster Health + Schedule Planning `SHARED_CONTEXT`; Football Intelligence descriptive/
  research-routed with `NOT_PREDICTIVE` fields barred from numeric influence.
- `npm test` 1558 / 1554 pass / 0 fail / 4 skip (0 existing tests changed); `tsc` clean;
  `eslint` 0 errors / 0 new warnings; R 24 + 15 + 12 checks pass + Phase 5 null findings
  reproduced; Phase 1C live `cross_surface_discrepancies = 0` on all 3 leagues (local + prod).
- All layers coexist around one `league_snapshot_id` + scoring fingerprint per logical
  request (both leagues, 24/24 teams), local and in production.
- Production recommendation behaviour change = 0 (lineup totals + matchup WP byte-identical
  local↔prod↔pre-merge).
- 0 P0, 0 P1. P2: one deferred input-reassembly optimisation (→ Orchestrator). P3: naming nit,
  benign preseason degradation labels, registry note.

# TEAM MANAGEMENT PHASES 1–7 CERTIFIED — MERGED, DEPLOYED & FROZEN

The Team Management Orchestrator is **not** started. Stopping here.
