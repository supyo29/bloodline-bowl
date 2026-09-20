# Intelligence Modernization — Phase 4
## Waiver Intelligence 2.0

Branch `intelligence-modernization-phase4-waiver-2`. **Not merged, not deployed.** Waiver 2.0 is a **SHADOW_ONLY** candidate engine; production waiver output (`waiver-engine-2026.1`) is preserved byte-for-byte. Read-only: it never submits, schedules or implies a claim.

> Sections are filled checkpoint by checkpoint. Checkpoint A (this section set) is the forensic audit and model specification; no Waiver 2.0 math was implemented before it.

## 1. Starting state
- `main` = `origin/main` = `11bc0a6` (Phase 3.5D record). Production: `dpl_BPbtVF6…`/docs on `f9eb8a5`+, health 200.
- Served versions: FI `fi:2026:w02:bfd77c9959a6` (week 2 PARTIAL), Role `roi:2026:w01:819dc3166607`, OPP `opi:2026:w01:bef17990fe91`, Player-Scheme `psi:2025:w18:08123edd58c9`, Start/Sit `ri-startsit-2026.1` (SHADOW_ONLY, frozen).
- Waiver engine `waiver-engine-2026.1`. **Production waiver readiness: `UNAVAILABLE` (`FREE_AGENT_POOL_UNAVAILABLE`)** — the canonical `free_agent_pool` capability is not materialized (`snap.waiver_state == null`); the live `/api/intelligence/.../week/2` returns zero recommendations.
- Book-Ready `book-ready-evidence-2026.1`, registry `intelligence-surface-registry-2026.2`, Analysis Book `analysis-book-2026.1` / `analysis-taxonomy-2026.1` / `analysis-planner-rules-2026.1`.
- Canonical scoring identity: `scoring_fingerprint` on the canonical snapshot lineage (`lib/canonical/scoring-fingerprint.ts`).

## 2. Existing waiver audit (`lib/weekly/waivers.ts`, 578 lines, `waiver-engine-2026.1`)
**What v1 actually optimizes.** For every prefiltered free agent it evaluates the FULL (add, drop) pair on a *counterfactual optimal legal lineup* (the shared Hungarian optimizer, `lib/weekly/lineup.ts`), picks the best legal drop by `(lineup gain − keep value)`, and ranks by `net_roster_gain = Σ weight·component` (`decision-score.ts`): `starter_upgrade·1.0 + weekly_vor·0.6 + bench_utility·0.25 + positional_scarcity·0.35 + bye_coverage·0.8 + injury_hedge·0.7 + rest_of_season_value·0.45 − drop_cost·1.0 − uncertainty_penalty·1.0`. Priority: `net < 0.75` → DO_NOT_ADD; `net ≥ 4` with a starter/bye/hedge reason → HIGH; `net ≥ 2` → MEDIUM; else LOW. It can and does conclude DO_NOT_ADD, refuses a drop that leaves a slot unfillable, and reports `starter_impact_status UNRESOLVED` (never a fake 0) on a projection gap. Free agency comes only from `ctx.availability`, gated on `free_agent_pool_readiness.actionable`.
**Useful certified behavior to preserve/consume (not rebuild):** the (add, drop) pair framing; optimal-lineup counterfactuals and their legality rule; UNRESOLVED-not-zero semantics; the readiness gate; `WeeklyTeamContext` (one snapshot, lineage, scoring, projections, replacement, availability, positional needs, byes); `weeklyVOR` replacement framework (nth-best-available frontier); deterministic `ctx.generated_at`.
**Weaknesses / missing intelligence (documented, not silently fixed in v1):**
1. **Generic player value.** Candidate value is one weekly projection + ROS; nothing models a candidate's role *trajectory* — Role Intelligence, Opportunity Propagation and Football Intelligence are **not consumed** (`football_intelligence_used_for_numeric_ranking` is a literal `false`).
2. **Hard-coded, unvalidated weights** (the table above, plus `clamp(-4,4)` ROS edge, `keep = vor + 1.2·rosEdge + starterProtection`, `MIN_NET 0.75`, HIGH ≥ 4).
3. **Drop cost is one scalar** (`keep`): no future option value, handcuff/contingency value, bye utility, positional depth lost, or re-add probability.
4. **No horizons** beyond "this week" and a single prorated ROS number: a two-week injury fill and a rookie stash are indistinguishable from a season-long asset.
5. **No economics.** FAAB says *"FAAB bid sizing is a later phase"*; no budgets of other managers, no competition, no claim-priority cost, no historical winning bids.
6. **No alternatives/tiers**; a flat ranked top-8.
7. **Replacement value is a single league pool level**, not manager-specific rostered replacement / starter baseline / scarcity.
8. **Uncertainty is one `-1.5` flag**, not a decomposed quantity.
9. **Duplicated logic risk:** the counterfactual lineup helper lives *inside* the v1 closure (not exported); Waiver 2.0 must call the shared optimizer, not copy v1 rules.
10. **No historical validation and no prospective capture** for waivers (unlike Start/Sit in 3.5A).
**Surfaces that touch waivers today:** `GET /api/waivers/{league}/{manager}/week/{week}`, the combined `/api/intelligence`, the Team-Management orchestrator (`lib/orchestrator/candidates.ts`, `gates.ts`), Book-Ready `waiver.status` (a thin converter, UNAVAILABLE per readiness), Analysis Book chapters `waiver.*` / `decision.replacement_value` (capabilities `replacement_level_evidence`, `drop_cost_evidence`, `manager_competition_evidence` currently UNSUPPORTED). Trade/waiver boundary: the trade engine is separate (`lib/trades/*`) and is not touched.
**Answer: today's waiver ranking optimizes the *net immediate-to-near-term lineup and depth value of an add/drop pair on this roster*, using external weekly/ROS projections and hand-set component weights. It is roster-aware but role-blind, market-blind, horizon-blind and price-blind.**

## 3. The Waiver 2.0 decision object
The unit is the **transaction**, not the player:
`WaiverAction = { manager, candidate, drop (or open spot), cost{faab range, priority}, gross_add_value, drop_cost, acquisition_cost, risk_penalty, net_action_value, horizons{next_week, next_3, ros, playoffs, stash}, value_by_kind{starter, bench_option, contingency}, role{level, trajectory, evidence}, opportunity{OPP conditional}, schedule{…}, market{scarcity, competition, faab}, uncertainty{components…}, archetype, alternatives[], tier, confidence, lineage }`. `PASS` is a first-class action ("no waiver claim"). Full specification of each family follows in later sections.

## 4. Model specification (frozen before implementation)
**Units.** Everything is expressed in **league-scoring fantasy points per week** (canonical scoring already inside the weekly projections) and summed over an explicit horizon; ratios/shares from Role are converted to points only through a *declared* opportunity→points conversion (`config.ts`), never silently.
**Feature families:** (F1) production projection level (consumed from v1's projection batch); (F2) Role level & trajectory (consumed from Role Intelligence: recent/season/prior, delta, trend, confidence, evidence state); (F3) conditional Opportunity Propagation (only when a teammate's unavailability is *established by an availability designation*); (F4) schedule (byes, games remaining, playoff window, FI opponent environment routed by `predictive_status`); (F5) roster context (optimal-lineup counterfactual, marginal starter, position-room depth, byes/injury exposure); (F6) replacement pools (free-agent nth-best, rostered replacement, starter baseline, scarcity); (F7) market (competitor need, budgets, visible winning bids, alternatives); (F8) uncertainty components.
**Composite (decomposable, illustrative weights are *declared priors*, status `PRIOR_UNVALIDATED`):**
`net_action_value = gross_add_value − drop_cost − acquisition_cost − risk_penalty`, where `gross_add_value = starter_value(horizon) + option_value + contingency_value(established only)`; every term is a sum of named components with raw evidence attached. **No weight is claimed validated**: the historical evaluation suite is defined first (§20) and finds the pool history unusable, so Waiver 2.0 stays SHADOW_ONLY and captures prospective evidence (§21).
**Evaluation targets (defined before any fitting):** net roster value, starter improvement, bench optionality realized, replacement-value gain, correct breakout identification, false-breakout avoidance, drop regret, FAAB efficiency, opportunity captured per FAAB, alternative-player regret.

## 5. Deployment strategy
Production `waiver-engine-2026.1` is untouched and remains the only waiver output any production route serves. Waiver 2.0 lives in `lib/waiver2/`, is reachable **only** through Book-Ready (`/api/evidence` `waiver2.*` topics, `deployment: SHADOW_ONLY, may_influence_production: false`), and no production module imports it (isolation-tested). Activation would require a separate certification with prospective evidence. No auto-promotion.

## 6. Book-Ready / Analysis Book integration map (spec)
New Book-Ready topics `waiver2.actions`, `waiver2.market`, `waiver2.replacement` (request-scoped, gated on the canonical pool readiness, native EvidenceBlock contract); registry surface `waiver-intelligence-2`; Analysis Book: replace named unsupported capabilities `replacement_level_evidence`, `drop_cost_evidence`, `manager_competition_evidence` in **existing** chapters (`decision.replacement_value`, `waiver.drop_cost`, `waiver.manager_competition`, plus enrichment of `waiver.availability_faab`, `waiver.upside_uncertainty`, `decision.roster_fit`). Chapter ids do not change; no second waiver taxonomy.

## 7. Historical-evaluation feasibility (spec)
Free-agent pool history is not preserved anywhere (the pool is not even materialized today), so as-of waiver evaluation is **UNSAFE_FOR_BACKTEST** for alternatives/regret; realized claims in `recent_transactions` are **RETROSPECTIVE_ONLY**; canonical roster snapshots are **RECONSTRUCTABLE_AS_OF** only where the snapshot store has them. See §20–21 for the resulting design (evaluation harness + prospective capture).
