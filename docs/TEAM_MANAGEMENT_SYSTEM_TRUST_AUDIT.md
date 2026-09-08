# Team Management System Trust, Utilization & Causal-Influence Audit

_Not a modeling phase. No deployment state changed. No model retrained._
Base: `main` `f9b8717` + this audit branch `team-management-system-trust-audit`.
Machine-readable companion: [`artifacts/system-trust-audit.json`](../artifacts/system-trust-audit.json).

---

## 1. Executive trust summary

The certified Phases 1–8 Team Management stack was audited for **installation,
invocation, output validity, downstream consumption, forbidden-consumer isolation,
evidence traceability, lineage coherence, safe degradation, calibration honesty, and
production parity.**

**Trust vector** (§34 — a dashboard, not one opaque number):

| dimension | result |
| --- | --- |
| canonical_integrity | **PASS** — Phase 1C live: `cross_surface_discrepancies = 0`, `null_required_fields = 0`, `identity_unresolved = 0` (bloodline-bowl, devoted-to-the-game, sportys-alumni) |
| identity_integrity | **PASS** — `identity_unresolved = 0` on all three leagues; no name fallback where a provider id exists |
| lineage_integrity | **PASS** — one `league_snapshot_id` + one scoring fingerprint across weekly / roster-health / schedule-planning / orchestrator per logical request; `all_equal = true` |
| model_loading | **PASS** — every versioned artifact exists, parses, and resolves the expected logical version; content SHA-256 recorded |
| expected_utilization | **PASS** — every layer INVOKED + OUTPUT_VALID + CONSUMED in its intended role across all three leagues (see the utilization matrix) |
| forbidden_influence | **PASS** — `fiMayInfluenceProduction()` ≡ false (all positions), `anyFiProductionInfluence()` ≡ false, `matchupMayInfluenceProduction()` ≡ false; forced ±50 pt shadow adjustments and 99%/1% shadow WP leave every production recommendation byte-identical and never create an Orchestrator ACTION |
| shared_context_read_fan_out | **PASS** — 1 canonical provider read per Orchestrator request (all leagues) |
| calibration_reproduction | **PASS** — Phase 3 (24 invariant + 15 adversarial), Phase 4 (12 adversarial + the reproduced null-finding artifact: `acc_delta ≈ 0`, reversal win-rate ≈ 0.50), Phase 5 (FI + game-context ablation all `< 0.005` incremental → excluded) |
| failure_degradation | **PASS** — 14 controlled failure / stale / counterfactual assertions in `test/system-trust-audit.test.ts` |
| production_parity | **PASS** — post-deploy prod smoke: endpoints 200, `deployment: ADVISORY_ONLY`, 0 shadow-driven actions, production `lineup.optimal_total` / `matchup.win_probability` byte-identical to the Phase 1–7 & Phase 8 certs |
| real_2026_outcome_validation | **NOT_YET_AVAILABLE** — first-year league, 0 played weeks; predictive/strategic value of every evaluative + policy layer remains unproven by design |

**Findings:** 1 × P2 (found **and fixed** in this audit), 2 × P3 (documented), 1 × INFO.
**No P0. No P1.**

---

## 2. Component / model registry

Full machine-readable registry in `artifacts/system-trust-audit.json` → `model_registry`.
Summary (`deployment_state` is **asserted programmatically**, never inferred from filenames):

| component | model_version | deployment_state | may_influence_production | expected callers | forbidden / note |
| --- | --- | --- | :--: | --- | --- |
| Canonical League State | schema_v3 · `scoring:v1:<fp>` | PRODUCTION_FOUNDATION | ✅ | every layer | one live reality |
| Team-State | `team-state-2026.1` | SHARED_FOUNDATION | ❌ | roster-health, schedule-planning, orchestrator | no evaluative / recommendation logic |
| Football Intelligence | `ri-football-intel-2026.1` (`fi:2025:w18:6e872c5caa82`) | SHARED / RESEARCH-ROUTED | ❌ | start-sit-fi shadow only | `NOT_PREDICTIVE` / `DESCRIPTIVE_ONLY` fields barred from numeric production |
| Start/Sit FI | `ri-startsit-2026.1` | **SHADOW_ONLY** | ❌ (`fiMayInfluenceProduction ≡ false`) | `lib/weekly/intelligence.ts` | any production lineup/start-sit/waiver/trade/matchup score |
| Matchup Intelligence | `ri-matchup-2026.1` | **SHADOW_ONLY** | ❌ (`matchupMayInfluenceProduction ≡ false`) | `lib/weekly/intelligence.ts` | any production score; no `MAX_WIN_PROBABILITY` objective |
| Roster Health | `roster-health-2026.1` | SHARED_CONTEXT | ❌ | orchestrator context + 2 API routes | trade/waiver scoring (needs a dedicated integration phase) |
| Schedule Planning | `schedule-planning-2026.1` | SHARED_CONTEXT | ❌ | orchestrator context + 2 API routes | trade/waiver/lineup/streaming recs (needs a dedicated integration phase) |
| Orchestrator | `team-management-orchestrator-2026.1` | **ADVISORY_ONLY** | ❌ (`orchestratorMayExecuteTransactions ≡ false`) | 2 `/orchestrate` API routes | autonomous transaction execution |
| production lineup | `post-draft-intel-2026.1` (`buildOptimalLineup`) | PRODUCTION_AUTHORITATIVE | ✅ | weekly intel, matchup, waivers, roster-health, schedule-planning, orchestrator | — |
| production Start/Sit | `post-draft-intel-2026.1` (`compareStartSit`, MAX_EXPECTED) | PRODUCTION_AUTHORITATIVE | ✅ | weekly intel, orchestrator | — |
| waiver engine | `post-draft-intel-2026.1` (`buildWaiverRecommendations`) | PRODUCTION_AUTHORITATIVE | ✅ | weekly intel, **orchestrator (USED_FOR_ACTION)** | — |
| production matchup | `post-draft-intel-2026.1` (`buildMatchup`) | PRODUCTION_AUTHORITATIVE | ✅ (`win_probability` is the production field) | weekly intel, orchestrator (context) | — |
| trade engine | foundation `ri-trade-foundation-2026.2` · discovery `ri-trade-discovery-2026.2` · negotiation `ri-trade-negotiation-2026.2` · strategy `ri-trade-strategy-2026.2` | PRODUCTION (Phase-3 calibrated weights ≡ 0; reopen at 50 real trades) | ✅ (trade recs) | trade API routes, **orchestrator (strategy profile → TRADE_EXPLORATION pointer only)** | Phase 3 numeric adjustment stays 0 until the 50-trade gate |
| trade depth | `lib/trades/depth.ts` (frozen) | PRODUCTION (frozen) | ✅ (trade scope) | trade engine | Roster Health must not replace it |
| trade ROS | `lib/trades/ros.ts` (frozen) | PRODUCTION (frozen) | ✅ (trade scope) | trade engine | Schedule Planning must not repoint / modify it |
| weekly projections | `sleeper-weekly-rotowire` | PRODUCTION_AUTHORITATIVE | ✅ | lineup, start-sit, matchup, waivers, roster-health, schedule-planning | K/DST use Sleeper standard-points fallback |
| ROS projections | `ri-structural-2026.3` (ordinal) + Sleeper season prorated (absolute) | PRODUCTION_AUTHORITATIVE (ordinal use) | ✅ (ordinal) | waivers, trade ROS, roster-health, schedule-planning | RI used ORDINALLY only (absolute-level calibration caveat) |
| replacement framework | `nth_best_available(n=1)` weekly / `position_rank_theoretical` ROS | PRODUCTION_AUTHORITATIVE | ✅ | lineup VOR, waivers, roster-health | — |
| scoring model | `scoring:v1:<fingerprint>` per league | PRODUCTION_AUTHORITATIVE | ✅ | projections + every value-producing layer | no component may assume default PPR |
| K path | `buildOptimalLineup` K slot + waiver K + Sleeper standard-pts fallback | PRODUCTION (no dedicated model) | ✅ (as a normal slot/add) | lineup, waivers, orchestrator (`K_DST` reason code) | no dedicated K streaming model (Phase 8 §16) |
| D/ST path | `buildOptimalLineup` DEF slot + waiver DEF; excluded from Phase 6 core fragility/SPOF | PRODUCTION (no dedicated model) | ✅ (as a normal slot/add) | lineup, waivers, orchestrator (`K_DST` reason code) | no dedicated D/ST streaming model (Phase 8 §16) |

---

## 3. Deployment-state matrix (asserted, not scanned)

```
start_sit_fi:          deploymentContract(served).deployment      = "SHADOW_ONLY"
                       fiMayInfluenceProduction(QB..DEF)           = false  (×6)
                       anyFiProductionInfluence()                  = false
matchup_intelligence:  matchupDeploymentContract().deployment      = "SHADOW_ONLY"
                       matchupMayInfluenceProduction()             = false
roster_health:         RosterHealthLineage.deployment              = "SHARED_CONTEXT" (all teams, all leagues)
schedule_planning:     PlanningLineage.deployment                  = "SHARED_CONTEXT" (all teams, all leagues)
orchestrator:          OrchestratorLineage.deployment              = "ADVISORY_ONLY"
                       orchestratorMayExecuteTransactions()        = false
```

Artifact content SHA-256 recorded in `artifacts/system-trust-audit.json → artifact_identity`;
every artifact `loadable: true`; the served logical version matches the reader.

---

## 4. Utilization states — terminology contract

| state | meaning |
| --- | --- |
| `INSTALLED` | the artifact/module exists and loads |
| `INVOKED` | called during a representative request |
| `OUTPUT_VALID` | produced a well-formed, schema-conformant result (not an error/degraded stub) |
| `CONSUMED` | a downstream layer read the output |
| `INFLUENTIAL` | changing the output can change a downstream **recommendation** (proven by counterfactual, §8 of this doc) |
| `PRODUCTION_AUTHORITATIVE` | its output IS the production recommendation |

Utilization roles carried in `OrchestratorLineage.specialists[*].usage`:
`USED_FOR_ACTION` · `USED_AS_CONTEXT` · `SHADOW_CONTEXT_ONLY` · `NOT_USED` · `UNAVAILABLE`
(+ `FAILED` in the trace view).

---

## 5. Call graph (repository-derived)

```
Canonical (buildCanonicalLeagueState, ONE read per runInLeagueStateScope)
  ├─ Team-State (buildLeagueManagementContext, snapshotOverride)
  ├─ Weekly Intelligence (buildWeeklyIntelligence, snapshotOverride)
  │     ├─ buildOptimalLineup ───────────────► lineup / matchup / waivers  (production)
  │     ├─ compareStartSit                                             (production)
  │     ├─ buildMatchup                                                (production)
  │     ├─ buildWaiverRecommendations                                  (production)
  │     ├─ buildStartSitShadow ──────► start_sit_shadow  (SHADOW_ONLY, post-hoc, try/catch→null)
  │     └─ buildMatchupIntelligence ─► matchup_intelligence (SHADOW_ONLY, post-hoc, try/catch→null)
  ├─ Roster Health (buildRosterHealthContext) ─► evaluateHorizon → bestLegalLineup → buildOptimalLineup
  ├─ Schedule Planning (buildSchedulePlanningContext) ─► buildWeekTimeline → buildOptimalLineup + evaluateHorizon
  └─ Trade context (buildTradeAnalysisContext) ─► buildManagerStrategicProfile

Orchestrator  (lib/orchestrator/context.ts assembles ALL of the above ONCE)
  → deriveConditions + aggregateConditions        (reads Team-State / Roster Health / Schedule Planning / lineup / shadows)
  → generateCandidates
        LINEUP            ← wi.lineup / wi.start_sit         (production)
        WAIVER            ← wi.waivers                       (production)
        TRADE_EXPLORATION ← buildTradeSearchProfile [+ discoverTrades if ?include_trade_search=1]
  → runPolicy: hard gates → lexicographic priority → dominance suppression → verdict

API entry points:
  GET /api/leagues/:slug/orchestrate                       (league, cheap path)
  GET /api/leagues/:slug/managers/:mgr/orchestrate         (?include_trade_search=1, ?include_trace=1)
```

**vs the certified architecture doc** (`docs/TEAM_MANAGEMENT_PHASES_1_7_CERTIFICATION.md` +
`_PHASE_8_ORCHESTRATOR.md`): **matches.** The only production file the whole Phase 3–8 stack
modified is `lib/weekly/intelligence.ts` (+44 lines, two nullable post-hoc shadow fields).
`git diff --stat f0bda54 -- <all frozen surfaces>` = **empty** (recorded in the JSON as
`frozen_surfaces_unchanged: "UNCHANGED"`).

Forbidden accidental flows checked and **absent**:
`lib/weekly/{lineup,matchup,start-sit,waivers}.ts` and `lib/trades/**` import **nothing** from
`start-sit-fi`, `matchup-intelligence`, `roster-health`, `schedule-planning`, or `orchestrator`.
`lib/orchestrator/**` has **zero** slot-eligibility / scoring / projection / identity logic of
its own.

---

## 6. Runtime utilization matrix (live, all three leagues)

| League | managers | ctx assembly | canonical reads | snapshot coherent | Team-State | Roster Health | Schedule Planning | Strategy | shadow (SS / MU) surfaced | forbidden-influence OK |
| --- | --: | --: | --: | :--: | :--: | :--: | :--: | :--: | --- | :--: |
| bloodline-bowl | 12 | ~2.2 s | **1** | ✅ | ✅ | ✅ 12/12 | ✅ 12/12 | ✅ 12/12 | 10 / 2 | ✅ |
| devoted-to-the-game | 12 | ~1.6 s | **1** | ✅ | ✅ | ✅ 12/12 | ✅ 12/12 | ✅ 12/12 | 10 / 2 | ✅ |
| sportys-alumni | 14 | ~1.1 s | **1** | ✅ | ✅ | ✅ 14/14 | ✅ 14/14 | ✅ 14/14 | 0 / 0 | ✅ |

Every layer is **INVOKED + OUTPUT_VALID + CONSUMED** in its intended role on every league.
(sportys-alumni shows 0 shadow-surfaced because its freshly-drafted rosters produce no
FI-driven lineup difference — a legitimate `NOT_USED`, not a dead path.)

Per-manager verdict + model-utilization counts are in
`artifacts/system-trust-audit.json → league_wide_counts`.

---

## 7. Dead-code / dead-model audit

| item | classification |
| --- | --- |
| `ri-startsit-2026.1` served but 0 production influence | **SHADOW_ONLY** (intentional) |
| `ri-matchup-2026.1` served but 0 production influence | **SHADOW_ONLY** (intentional) |
| Phase 3 numeric role/schedule adjustments hardcoded to 0 in `lib/trades/phase3.ts` | **FUTURE_REEVALUATION** (gated on the 50-trade calibration reopen) |
| `ri-structural-2026.3` absolute season projection | **LEGACY_COMPATIBILITY** — RI is consumed ORDINALLY only (documented absolute-level caveat); the absolute number is retained for disagreement/confidence signals |
| `analysis/phase3_cache/*.rds` | build-time inputs to the frozen FI snapshot — not read at serve time (serve reads the committed CSV/JSON) — **INTENTIONAL** |
| `WeeklyIntelligence.top_actions` | **LEGACY_COMPATIBILITY** — a Phase-8-superseded proto-orchestrator kept byte-stable for existing clients |
| **`SHADOW_STARTSIT_DISAGREEMENT` condition (orchestrator)** | **was UNEXPECTED_DEAD_PATH** — the disagreement extractor read non-existent fields. **Finding TA-1, fixed in this audit.** Now reachable (`SHADOW_CONTEXT_ONLY`, still barred from ACTION). |

No config flag makes a certified capability unreachable
(`?include_trade_search`, `?include_trace` are additive opt-ins; `BRIDGE_PUBLISHED_SNAPSHOT`
OFF does not gate any Team Management path).

---

## 8. Causal influence matrix (controlled counterfactuals)

`test/system-trust-audit.test.ts` — 14 assertions.

| specialist | perturbation | observed downstream effect | matches contract? |
| --- | --- | --- | :--: |
| **Start/Sit FI (Phase 4)** | adversarial deployment contract + extreme model, `applyFiToProductionBatch` | `fi_applied = false`; production batch returned **by reference** (byte-identical); `buildOptimalLineup` total + slot assignment **unchanged** | ✅ SHADOW_ONLY |
| **Start/Sit FI shadow** | shadow-only Orchestrator candidate ("+50 pt disagreement") | `applyHardGates` → `SHADOW_ONLY_EVIDENCE` (fail-closed); `runPolicy` verdict stays `HOLD`, `primary_action = null` | ✅ cannot drive ACTION |
| **Matchup Intelligence (Phase 5)** | shadow WP forced to 0.99 and to 0.01 | production `matchup.win_probability` unchanged; Orchestrator verdict never `ACTION`; disagreement surfaces only as a `SHADOW_DIAGNOSTIC_ONLY` WATCH item | ✅ SHADOW_ONLY, no MAX_WIN_PROBABILITY |
| **Roster Health (Phase 6)** | fragility `RESILIENT → CONCENTRATED_FRAGILITY`, QB dependency p20 → p99, **no waiver/trade remedy present** | conditions change (`QB_DEPTH_VULNERABILITY`, `ROSTER_FRAGILITY` appear); verdict `HOLD → WATCH`; **0 fabricated WAIVER/TRADE candidates** | ✅ evidence not remedy |
| **Schedule Planning (Phase 7)** | distant bye → near-term bye; add uncovered future slot | WATCH ordering changes; verdict stays `WATCH` (no remedy specialist supplied one); **0 fabricated transactions** | ✅ evidence not remedy |
| **production lineup (§12)** | inject a +4.5 pt best-legal-lineup gain → remove it | ACTION/LINEUP appears → disappears (verdict `HOLD`) | ✅ positive influence proven |
| **waiver engine (§12)** | HIGH-priority candidate, 3.5 pt effect → degrade to LOW-priority, 0.4 pt | ACTION/WAIVER appears → suppressed (`IMPROVEMENT_BELOW_MATERIALITY`) | ✅ positive influence proven |

**Every specialist's actual downstream influence matches its deployment contract.**

---

## 9. Forbidden-influence tests (Phase 4 / Phase 5)

- **Phase 4 (§8):** forced `Player B = +50`, `Player A = −50` shadow adjustments. Production
  MAX_EXPECTED lineup, production Start/Sit, waivers, trades, production matchup — **all
  byte-identical.** The Orchestrator cannot create an ACTION from the shadow alone
  (`SHADOW_ONLY_EVIDENCE` hard gate). **No P0.**
- **Phase 5 (§9):** forced shadow matchup WP = 99% and = 1%. Matchup Intelligence shadow
  output changes; production `buildMatchup` unchanged; no `MAX_WIN_PROBABILITY` behaviour
  anywhere; the Orchestrator surfaces the disagreement as a WATCH diagnostic only. **No P0.**

---

## 10. Production-remedy influence tests (§12)

`LINEUP`, `WAIVER`, and `TRADE_EXPLORATION` each demonstrably drive an Orchestrator ACTION
when a certified production specialist supplies the remedy, and the ACTION disappears when
the remedy is removed or degraded below the specialist's own gate. Positive influence is
real, not just forbidden influence blocked.

---

## 11. Evidence tracing + trust/debug view

`GET /api/leagues/:slug/managers/:mgr/orchestrate?include_trace=1` returns an
`OrchestratorTrace` (audit-only, read of state already produced, no secrets):

```
components:        { <name>: { model_version, used, role, production_influence, reason } }
condition_traces:  per condition — code, disposition, materiality, urgency, + per-evidence
                   { originating_component, component_version, utilization_role, source_metric,
                     source_value, horizon, reason_code }
action_traces:     per primary / secondary / suppressed action — the same provenance chain
assembly:          { canonical_provider_reads, snapshot_ids_seen, snapshot_coherent, stage_ms }
forbidden_influence_ok: no surfaced action rests solely on shadow evidence
```

Every Orchestrator verdict is mechanically traceable
`verdict → action → source specialist → source metric/value → canonical snapshot`.
No prose-only reasoning path exists — the natural-language explanation is rendered **from**
the structured `explanation_chain`, not a parallel logic.

---

## 12. Lineage coherence

For one logical Orchestrator request (`artifacts/system-trust-audit.json → lineage_coherence`):

| | bloodline-bowl / supyo29 | devoted-to-the-game / darthmarker |
| --- | --- | --- |
| weekly ↔ roster-health ↔ schedule-planning ↔ orchestrator `league_snapshot_id` | all equal | all equal |
| scoring fingerprint | `scoring:v1:29acc6bc…` | `scoring:v1:d4795fa7…` |
| weekly projection lineage | `sleeper_weekly / sleeper-weekly-rotowire` | same |
| ROS projection lineage | `roster_intel_season / ri-structural-2026.3` | same |

No hidden cross-snapshot synthesis. The Orchestrator asserts coherence
(`metrics.snapshot_coherent`) and degrades loudly (`STALE_SNAPSHOT` hard gate) on mismatch.

---

## 13. Identity · scoring · slot legality

- **Identity (§18):** Phase 1C `identity_unresolved = 0`, `identity_gsis = 0` (local) on all
  three leagues; every player-bearing output in the new layers keys on `canonical_player_id`
  and never falls back to a name where a provider id exists (the new layers do no identity
  resolution of their own — they consume the canonical map).
- **Scoring (§19):** every value-producing layer consumes the league's
  `scoring:v1:<fingerprint>` via the shared `WeeklyProjectionBatch` / `RosSignal`; no new
  component references a hardcoded PPR constant (grep-verified). The scoring fingerprint is
  identical across every layer in one request (§12).
- **Slot legality (§20):** the Orchestrator imports **no** slot machinery. `lib/roster-health`
  and `lib/schedule-planning` route every legal-lineup question through the frozen
  `buildOptimalLineup` → `maxSlotMatching` / `slotEligiblePositions`. `test/weekly-lineup.ts`
  (35), `test/roster-health.test.ts` (16), `test/schedule-planning.test.ts` (19) exercise
  the adversarial FLEX / SUPER_FLEX / W-R-T scenarios — all pass unchanged.

---

## 14. Calibration-status registry (§21 — evidence-honest, not one "CERTIFIED")

| component | calibration status |
| --- | --- |
| Football Intelligence | **OBSERVED/MODELED CERTIFIED** (chronology-safe walk-forward: 7 offensive metrics beat baselines P ≥ 0.997) **+ DESCRIPTIVE_ONLY** subset (FTN, man/zone) **+ `def_pass_epa_allowed` NOT_PREDICTIVE** |
| Start/Sit FI | **SHADOW_ONLY / NULL_FINDING_REPRODUCED** — `decision_backtest` (this audit): 2025 eval `acc_delta ≈ +0.0004`, sleeper baseline `−0.0004`, reversal win-rate `≈ 0.50`. FI adds no Start/Sit value over the production baseline. **/ REQUIRES_2026_REEVALUATION** |
| Matchup Intelligence | **MATHEMATICALLY_CALIBRATED_ONLY** (empirical standardized-residual z-grid fixes the current MC's overconfidence: calibration slope 0.66 → 1.08) **/ SHADOW_ONLY / 2-factor dependence REJECTED / REQUIRES_2026_LIVE_CAPTURE** |
| Roster Health | **DETERMINISTIC_CERTIFIED** (math + invariants + isolation) **/ REAL_PREDICTIVE_VALUE_UNPROVEN** |
| Schedule Planning | **STRUCTURAL_MATH_CERTIFIED** (schedule / bye / coverage / playoff-week = HIGH confidence) **/ FUTURE_VALUE_DEGRADED** (`ROS_PROJECTION`, horizon-graded) |
| Orchestrator | **POLICY_CORRECTNESS_CERTIFIED** (gates, priority, dominance, HOLD/WATCH/ACTION, isolation) **/ STRATEGIC_OUTCOME_UNPROVEN / REQUIRES_DURABLE_DECISION_CAPTURE** |
| weekly projections | **PRODUCTION** (RotoWire-backed); K/DST use Sleeper standard-points fallback |
| ROS projections | **RI ORDINAL_ONLY** (absolute-level calibration caveat) + Sleeper season prorated absolute |

---

## 15. Reproduced historical validation

| suite | result |
| --- | --- |
| Phase 3 — `analysis/football_intel/tests/run.R` | **24/24 invariants** |
| Phase 3 — `analysis/football_intel/adversarial_audit.R` | **15/15** (prior dominance at wk1, no wk1 HIGH confidence, opponent adjustment, one-game robustness, historical-alias collapse, `NOT_PREDICTIVE` label, no fabricated participation) |
| Phase 4 — `analysis/football_intel_startsit/adversarial_audit.R` | **12/12** (adjustment bounded by 0.25·baseline, tie-break gate cannot flip, unresolved FI → 0, determinism) |
| Phase 4 — null finding (from `start_sit_model.json.decision_backtest`) | **reproduced** — `acc_delta ≈ 0`, reversal win-rate `≈ 0.50` (coin flip) |
| Phase 5 — `analysis/football_intel_matchup/context_fi_ablation.R` | FI + game-context incremental value all `< 0.005` → **all EXCLUDED** (null finding holds) |
| Phase 6 — `test/roster-health.test.ts` | 16/16 |
| Phase 7 — `test/schedule-planning.test.ts` | 19/19 |

Key checks were **re-run**, not accepted from prior reports.

---

## 16. 2026 re-evaluation readiness (§23 — nothing promoted)

| pipeline | current_status | 2026 weeks done | min | next candidate | eligible |
| --- | --- | --: | --: | --- | :--: |
| Start/Sit FI | `NOT_ELIGIBLE` (`fi:2025:w18` prior-only snapshot does not count) | 0 | 4 | `ri-startsit-2026.2` | ❌ |
| Matchup Intelligence | live-calibration capture path documented | 0 | — | `ri-matchup-2026.2` | ❌ |
| Roster Health | deterministic v1 frozen; `roster-health-2026.2` documented | 0 | — | `roster-health-2026.2` | ❌ |
| Schedule Planning | structural v1 frozen; `schedule-planning-2026.2` documented | 0 | — | `schedule-planning-2026.2` | ❌ |
| Orchestrator | `NullCaptureStore` default; schema + `MemoryCaptureStore` adapter tested | 0 | — | `orchestrator-2026.2` | ❌ |

The Start/Sit re-evaluation manifest (`eligibility.R` → `start_sit_reevaluation_manifest.json`)
loads, parses, and correctly reports `NOT_ELIGIBLE` with the reason and cadence intact.

---

## 17. Decision-capture audit (§24)

`OrchestratorDecisionRecord` preserves: verdict, primary + secondary + suppressed actions
(class, target condition, remedy kind, priority, urgency, expected effect, confidence, cost
band, reason codes), condition + watch codes, hold rationale, all specialist versions,
`league_snapshot_id`, scoring fingerprint, season, week, and `acted_upon` (always `"UNKNOWN"`
— compliance is never fabricated). `MemoryCaptureStore` is exercised by tests;
`captureOrchestratorResult` is wired into `orchestrateManager` and is a no-op under the
default `NullCaptureStore`. **Real outcome calibration requires an operator to wire a durable
store** — documented as the `orchestrator-2026.2` prerequisite.

---

## 18. Failure-injection audit (§25)

| injected failure | result |
| --- | --- |
| waiver engine missing | no WAIVER action generated (`REQUIRED_SPECIALIST_UNAVAILABLE`); LINEUP still works |
| weekly + Team-State both missing | `INSUFFICIENT_EVIDENCE` (**not** a false `HOLD`) |
| stale / incoherent snapshot | every action fails closed (`STALE_SNAPSHOT`); verdict never `ACTION` |
| Roster Health / Schedule Planning unavailable | recorded in `degradation.missing_specialists`; the LINEUP/WAIVER path still produces an ACTION; roster-depth conclusions degrade, not fabricate |
| shadow (Phase 4/5) build throws | caught in `lib/weekly/intelligence.ts` → field `null`; production output unaffected |

No 500 cascade; graceful degradation everywhere it is intended.

---

## 19. Stale-output audit (§26)

An `OrchestratorResult` is stamped with `league_snapshot_id`, scoring fingerprint, week, and
every specialist version, and is **immutable** — a new snapshot produces a new result, never a
mutation of the old one. `metrics.snapshot_coherent` gates the whole policy: a roster change
that produces a new snapshot id makes the prior advice detectably stale (the `STALE_SNAPSHOT`
hard gate fires if a stale slice ever reaches the policy). No process-lifetime cache.

---

## 20. HOLD / WATCH / dominance audits (§28–§30)

- **HOLD (§28):** the deterministic suite proves an already-optimal + resilient + no-waiver
  roster returns `HOLD`, and that introducing one material production remedy at a time flips
  it to `ACTION`. **The policy is not biased toward activity.** (See finding **TA-3** for why
  the live week-1 snapshot shows a low HOLD rate — unset preseason lineups, not bias.)
- **WATCH (§29):** severe fragility with no remedy → `WATCH`; a distant bye → `WATCH`; a
  shadow disagreement → `WATCH` diagnostic. Adding a certified material remedy transitions
  `WATCH → ACTION`. The condition→remedy boundary holds.
- **Dominance (§30):** a free lineup fix dominates an equivalent costly waiver for the same
  condition (waiver → `suppressed_actions`); a materially weaker duplicate waiver is
  suppressed; independent actions for different problems both surface (bounded at 3
  secondary). Suppression reasons are recorded.

---

## 21. Live production utilization + parity (§31–§32)

Post-deploy prod smoke (`bloodline-bowl-sleeper-bridge.vercel.app`, deploy of `4bd6793`):

- `/orchestrate` endpoints 200; unknown manager/league → 404 (fail-closed); `?include_trace=1`
  returns the `OrchestratorTrace`.
- `deployment: ADVISORY_ONLY`; `orchestrator_version: team-management-orchestrator-2026.1`.
- **`trace.assembly`**: `canonical_provider_reads = 1`, `snapshot_coherent = true`,
  `forbidden_influence_ok = true`.
- **`trace.components`** (supyo29, WATCH): every component `production_influence = false`;
  `start_sit_shadow: SHADOW_CONTEXT_ONLY` (**TA-1 fix confirmed live** — was `NOT_USED`),
  `SHADOW_STARTSIT_DISAGREEMENT` now appears in the condition traces as
  `SHADOW_DIAGNOSTIC_ONLY`; `matchup_shadow: NOT_USED` this run (no WP disagreement — legitimate).
- **Production-engine additivity:** the trust-audit + Orchestrator code touched only
  `lib/orchestrator/**` (Phase 8) + additive files; `git diff --stat f0bda54..HEAD` for every
  production engine is empty; `orchestrator-isolation.test.ts` proves the weekly
  lineup/matchup/waiver results reached through the shared context are byte-identical to a
  direct build; `top_actions` shape unchanged. (Absolute prod numbers move day-to-day with
  the live Sleeper feed — the isolation claim is invariance to the new code, not a fixed value.)
- Existing production engines (`roster-health`, `schedule-planning`, `lineup`, `waivers`,
  `intelligence`) all 200.

Local-vs-production behaviour matches the documented architecture. Environment difference:
the prod canonical snapshot content-hash differs from local (Supabase GSIS crosswalk) — a
documented, expected identity-resolution difference; logical facts (scoring/roster
fingerprints, week, team count, playoff config) agree.

---

## 22. Performance

| path | cost |
| --- | --- |
| Orchestrator context assembly (all leagues) | 1.1–2.2 s · **1 canonical provider read** · 1× each of Team-State / Roster Health / Schedule Planning / trade context |
| one manager cold (`buildManagerOrchestration`) | ~1.5 s |
| one manager `+?include_trade_search=1` | ~2.1 s |
| full 12-team league | ~7 s |

All within the `maxDuration = 60` lambda budget. **Bounded residual (P2, carried from Phase 8):**
Roster Health + Schedule Planning each re-assemble the weekly projection batch + RI signal
in memory from the memoised snapshot (0 extra provider reads). Eliminating it needs a frozen
Phase 6/7 builder change — deferred to a dedicated refactor phase.

---

## 23. Findings

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| **TA-1** | **P2** | Orchestrator `extractShadowDisagreements` read `reversals` / `summary.reversal_count` — fields absent from `StartSitShadowComparison` (`lineup_differs` / `lineup_deltas` / `start_sit_deltas`). The `SHADOW_STARTSIT_DISAGREEMENT` diagnostic condition was **unreachable** — INVOKED + OUTPUT_VALID but never CONSUMED. | **FIXED in this audit** (`lib/orchestrator/conditions.ts`, + a regression assertion). Post-fix: the Phase-4 shadow disagreement surfaces as `SHADOW_CONTEXT_ONLY` for 10/12 managers in bloodline + devoted — still architecturally barred from an ACTION (unchanged). |
| **TA-2** | **P3** | A `WAIVER` `OrchestratorAction` inherits the waiver engine's `priority`, which the certified `DecisionScore` derives from current-week impact **+ ROS value + scarcity + bye-coverage + injury-hedge**. So a `HIGH`-priority WAIVER action can carry a small current-week `expected_weekly_effect` (~0.3–0.7 pts). | **Documented as a semantic note.** This is transparent (the dimension shows the small number) and correct (deferring to the certified `PRODUCTION_AUTHORITATIVE` waiver gate per Phase 8 §18), **not activity bias**. A future 2026.2 could annotate "high ROS value, low current-week impact". |
| **TA-3** | INFO | 0 `HOLD` across devoted-to-the-game (12) and sportys-alumni (14) in the current week-1 snapshot (bloodline-bowl: 3 `WATCH` / 9 `ACTION`). | **Not a defect.** Investigated per manager: nearly every manager has an unset preseason lineup with a material (>1.25 pt) best-legal gain, OR a HIGH-priority waiver. The policy **produces `HOLD` when the roster is actually optimal** (proven deterministically) and produced `WATCH` for the 3 bloodline managers below materiality. The live rate is a property of the preseason snapshot, not the policy. Preserve. |
| **TA-4** | P3 | The audit's generic artifact key-scan reports `deployment: null` for `start_sit_reevaluation_manifest.json` (`current_model_version`, not `model_version`) and `football_intelligence_manifest.json` (`model_tag`; FI has no single deployment state — it is routed). | **Documented — a scan limitation, not a model defect.** Deployment states are asserted programmatically (`deploymentContract` / `matchupDeploymentContract` / lineage fields); those assertions PASS. |

**No P0. No P1.** No model null finding is reclassified as a defect — Start/Sit FI's null
result, Matchup Intelligence's rejected 2-factor dependence, and the FI/context ablation
exclusions are all **preserved as legitimate findings**.

---

## 24. Full regression

| check | result |
| --- | --- |
| `npx tsc --noEmit` | **clean** |
| `npm run lint` (`app lib test`) | **0 errors**, 29 warnings (**0 new**) |
| `npm test` | **1602 tests · 1598 pass · 0 fail · 4 skipped** (0 existing tests changed; +14 trust-audit tests, +1 TA-1 regression) |
| Phase 1C live (3 leagues) | `cross_surface_discrepancies = 0`, `null_required_fields = 0`, `identity_unresolved = 0` |
| Phase 3 R (invariants + adversarial) | 24 + 15 pass |
| Phase 4 R adversarial + null finding | 12 pass + null reproduced |
| Phase 5 R ablation | features excluded (null holds) |
| frozen surfaces `git diff --stat f0bda54..HEAD` | **empty** — no model semantics changed |

---

## 25. Known limitations

- **Real-world outcome validation is not yet possible** — first-year league, 0 played weeks.
  Every evaluative (Phase 6/7) and policy (Phase 8) layer is deterministically/mathematically
  certified but its *predictive / strategic* value is **unproven**.
- Start/Sit FI and Matchup Intelligence are `SHADOW_ONLY` with reproduced null / rejected
  findings — they add research context, not production value, today.
- Durable Orchestrator decision capture is **not wired** (schema + in-memory adapter only) —
  the basis for `orchestrator-2026.2` outcome scoring must be provisioned by an operator.
- The Phase 6/7 in-memory projection re-assembly residual (P2) is carried, not resolved.
- Exact intra-day action-timing (P8-1) remains unavailable — no certified lock/kickoff fact.

---

## 26. Ongoing audit recommendation

Re-run this audit (`node --import tsx scripts/system-trust-audit.ts` +
`test/system-trust-audit.test.ts`) whenever a model version, a deployment state, or a
consumer relationship changes, and once ≥ 4 genuine 2026 weeks exist (to feed the calibration
and decision-capture pipelines). Keep `?include_trace=1` as the standing "why did the system
recommend this?" debugging surface.

---

# TEAM MANAGEMENT SYSTEM TRUST AUDIT PASSED — UTILIZATION, LINEAGE & CAUSAL BOUNDARIES CERTIFIED

Every intended model is installed, versioned, invoked, produces valid output, and is consumed
in its intended role. Forbidden consumers cannot reach the shadow layers — proven by forced
±50 pt / 99%–1% counterfactuals leaving every production recommendation byte-identical.
Production remedies demonstrably drive Orchestrator ACTIONs; shadow and shared-context layers
demonstrably cannot. Lineage is coherent (one snapshot, one scoring fingerprint per request);
stale/degraded inputs fail safely; calibration status is reported honestly per evidence level;
the running production system matches the documented architecture. 1 × P2 (fixed in-audit),
2 × P3 (documented), 1 × INFO. No P0, no P1.

Real-world 2026 outcome validation remains `NOT_YET_AVAILABLE` by design.

STOP. No new football modeling.

---

# Addendum — Phase 9 (Player × Scheme Intelligence) trust-registry extension

Added 2026-09-08 alongside `player-scheme-intelligence-2026.1` (spec §31). Phase 9
is **additive** and does not change any finding above; the frozen surfaces this
audit certified are byte-identical.

## Phase 9 utilization vector

| Layer | Version | INSTALLED | INVOKED | OUTPUT_VALID | CONSUMED | INFLUENTIAL | PRODUCTION_AUTHORITATIVE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tier A spatial profiles | `qb-spatial-2026.1` | ✅ | ✅ (`build_tierA.R`) | ✅ (`tierA_reconciliation.json` all_pass) | `/api/player-scheme/*` read-only | ✗ | **✗** |
| Tier B charting profiles | `player-tendency-2026.1` | ✅ | ✅ (`build_tierB.R`) | ✅ (`tierB_reconciliation.json` all_pass) | `/api/player-scheme/*` read-only | ✗ | **✗** |
| Tier C team + archetype | `defense-scheme-2026.1` | ✅ | ✅ (`build_tierC.R`) | ✅ (`tierC_reconciliation.json` all_pass) | `/api/player-scheme/*` read-only | ✗ | **✗** |
| Tier D interaction research | `player-scheme-interaction-2026.1` | ✅ | ✅ (`build_tierD.R`) | ✅ (`tierD_reconciliation.json` all_pass) | `/api/player-scheme/matchups/*` research metadata | **✗** | **✗** |

## Forbidden-influence check

- `player_scheme_interactions.csv`: `numeric_fantasy_adjustment` is a literal
  `0` on every row; `deployment = SHADOW_ONLY` on every row.
- No code path reads any Phase 9 value into a projection, lineup, Start/Sit,
  waiver, trade, matchup, Roster Health, Schedule Planning, or Orchestrator
  ACTION. Grep-asserted in `test/player-scheme-isolation.test.ts` and
  `test/player-scheme-tierd.test.ts` across
  `lib/{weekly,trades,roster-health,schedule-planning,orchestrator,team-state,canonical,projections,football-intel}`.
- Football Intelligence artifacts are not modified by Phase 9
  (`tier_c.does_not_modify_football_intel = true`; FI manifest byte-identical,
  asserted).
- `npm test` 1643 / 1639 pass / 0 fail / 4 skipped — **0 existing tests changed**.

## Deployment states

`SHARED_DESCRIPTIVE` for Tiers A/B/C (current availability `PRIOR_ONLY` — no 2026
cache); `SHADOW_ONLY` with `numeric_fantasy_adjustment = 0` for Tier D. Tier D
research finding: **no player × scheme family beats the production-like baseline
out-of-sample** — a clean null, preserved (spec §27).

**PHASE 9 TRUST-REGISTRY EXTENSION — DESCRIPTIVE UTILIZATION CERTIFIED, SHADOW BOUNDARY ENFORCED.**
