# Team Management Phase 8 — Orchestrator: Pre-Implementation Audit

_Audit only. No substantive Orchestrator implementation. Stops at the scope gate._

Certified frozen base: **`team-management-phases-1-7-2026.1`** (`main` `f0bda54`).
Branch: `team-management-phase8-orchestrator`.
**Phases 1–7 frozen semantics are not modified by this audit.**

---

## 1. Objective

Answer the management-level question **"what, if anything, should this manager do with
their fantasy team right now?"** by *coordinating and prioritising* already-certified
specialist systems — never by adding a new projection, valuation, or simulation model.

Output is a prioritised assessment resolving to `HOLD` / `WATCH` / `ACTION` (one or a few
ranked actions), every conclusion traceable to specialist evidence.

---

## 2. Specialist ownership map

| Concern | Owner (frozen) | The Orchestrator may… | …and may NOT |
| --- | --- | --- | --- |
| Canonical roster / identity / scoring / week | Phase 1 `buildCanonicalLeagueState` + `lib/canonical/*` | read via the certified contract | recreate provider-native truth, branch on `state_source` |
| Structural facts (inventory, depth pressure, structural flags, legal-lineup, byes) | Phase 2 `lib/team-state/*` | read `TeamManagementState` | add evaluative/recommendation logic here |
| Weekly projections / replacement levels | `lib/weekly/projections/*`, `lib/weekly/replacement.ts` | consume numbers | re-derive, re-scale, ensemble |
| Optimal legal lineup | frozen `buildOptimalLineup` / `maxSlotMatching` | call it to read swaps / totals / empty slots | write a second optimiser |
| Start/Sit (production) | `lib/weekly/start-sit.ts` (`compareStartSit`, MAX_EXPECTED) | surface `StartSitComparison` | override with shadow preference |
| Waiver add/drop evaluation | `lib/weekly/waivers.ts` (`buildWaiverRecommendations`) | consume `WaiverCandidateEval` + `DO_NOT_ADD` | re-score candidates |
| Matchup / win probability (production) | `lib/weekly/matchup.ts` (`buildMatchup`) | read `win_probability`, leverage, swing players | consume shadow ΔWP as an action driver |
| Trade valuation / discovery / negotiation / partner-fit | `lib/trades/*` (`analyzeTrade`, `discoverTrades`, `negotiateTrade`) | ask "is there a rational trade path?" | re-value assets, write a discovery-only valuation |
| Trade ROS / trade depth | frozen `lib/trades/ros.ts`, `lib/trades/depth.ts` | — | touch |
| Season-state / standings / playoff / archetype / urgency | `lib/trades/strategy/*` (`ManagerStrategicProfile`) | reuse the profile for season-urgency | re-derive standings/playoff logic |
| Football Intelligence context | Phase 3 `lib/football-intel/*` (routed) | surface descriptive context | turn `NOT_PREDICTIVE`/`DESCRIPTIVE_ONLY` into numeric influence |
| Start/Sit FI shadow | Phase 4 `ri-startsit-2026.1` **SHADOW_ONLY** | show as a disagreement diagnostic | let it create a production action |
| Matchup Intelligence shadow | Phase 5 `ri-matchup-2026.1` **SHADOW_ONLY** | show calibrated distributions / ΔWP as research | let it trigger a lineup override |
| Roster Health | Phase 6 `roster-health-2026.1` **SHARED_CONTEXT** | use fragility / dependency / surplus as *condition + materiality* | treat "fragile" as "add a player" |
| Schedule & Forward Planning | Phase 7 `schedule-planning-2026.1` **SHARED_CONTEXT** | use bye exposure / future coverage as *condition + urgency* | treat a future hole as a today-action |

**The Orchestrator owns exactly four things:** priority, conflict resolution, actionability
(condition → remedy → cost → act/hold), and synthesis/explanation. If it needs a
calculation none of the above provides, that is an **integration prerequisite** (documented
in §14/§15/§43), never an ad-hoc substitute.

---

## 3. Existing recommendation surfaces — inventory

| # | Surface | Entry | Prod/Shadow/Context |
| --- | --- | --- | --- |
| 1 | Optimal lineup | `buildOptimalLineup` → `LineupResult` | production |
| 2 | Start/Sit close calls | `buildCloseCalls` → `StartSitComparison[]` | production |
| 3 | Weekly Intelligence rollup incl. **`top_actions`** | `buildWeeklyIntelligence` → `WeeklyIntelligence` | production |
| 4 | Weekly `summary` (`most_important_move`, `waiver_priority`, `biggest_weakness`, `watch`) | `buildWeeklySummary` | production |
| 5 | Waiver / free-agent | `buildWaiverRecommendations` → `WaiverResult` (`recommendations[]` + `do_not_add[]`) | production |
| 6 | Matchup + leverage + swing | `buildMatchup` / `buildLeverage` → `MatchupResult` | production |
| 7 | Trade analyze (evaluate a specific proposal) | `analyzeTrade` → `TradeAnalysis` | production |
| 8 | Trade discovery (search) | `discoverTrades` → `TradeDiscoveryResponse` (`results[]`, `TradeDiscoveryResult`) | production |
| 9 | Trade negotiation (offer ladder / counter) | `negotiateTrade` | production |
| 10 | Trade partner-fit | `PartnerFitScore` inside discovery | production |
| 11 | Trade ROS timeline | `lib/trades/ros.ts` `RosRosterValue` | production (frozen) |
| 12 | Trade depth evaluation | `lib/trades/depth.ts` | production (frozen) |
| 13 | Strategic context (season/standings/playoff/archetype/urgency/horizons) | `buildManagerStrategicProfile` → `ManagerStrategicProfile`; `GET …/strategic-context` | production (diagnostic/preference) |
| 14 | Draft recommendation engine | `buildManagerRecommendationResponse`; `GET …/recommendations` | production — **draft only, SNAKE_ONLY; not a management surface** |
| 15 | Roster Health | `buildRosterHealthContext` → `RosterHealthLeagueContext`; `…/roster-health` | SHARED_CONTEXT |
| 16 | Schedule Planning | `buildSchedulePlanningContext` → `SchedulePlanningLeagueContext`; `…/schedule-planning` | SHARED_CONTEXT |
| 17 | Start/Sit FI shadow | `buildStartSitShadow` → `StartSitShadowComparison` (on `WeeklyIntelligence.start_sit_shadow`) | SHADOW_ONLY |
| 18 | Matchup Intelligence shadow | `buildMatchupIntelligence` → `MatchupIntelligence` (on `WeeklyIntelligence.matchup_intelligence`) | SHADOW_ONLY |
| 19 | Team-State `/manage` | `buildLeagueManagementContext` | structural facts, no recs |

**Key observation — surface #3 `top_actions` is already a proto-orchestrator.**
`TopAction { type: "LINEUP"|"WAIVER"|"ALERT"; priority: HIGH|MEDIUM|LOW; message; projected_gain?; net_roster_gain?; detail_route }`,
sorted by `priority` then `projected_gain|net_roster_gain`, capped at 6. It covers **only
current-week lineup + waiver + alerts** — no trades, no roster-health, no schedule-planning,
no K/DST class, no `HOLD`/`WATCH`, no cost/urgency/confidence dimensions, and it will always
emit something if any positive-gain swap exists. Phase 8 must decide: **extend `top_actions`
in place, or supersede it with a richer Orchestrator output and leave `top_actions` as a
compatibility view.** (Recommendation: build the Orchestrator as a new surface; keep
`top_actions` byte-stable for existing clients — see §39, §43.)

---

## 4. Score-scale audit (§4 of the brief — critical)

Every specialist score is on its **own** scale. They are **not** directly comparable.

| Surface | Field | Unit / scale | Better = | Ordinal/cardinal | Has a "do nothing" gate? | Horizon |
| --- | --- | --- | --- | --- | --- | --- |
| Lineup | `projected_points_gained`, `LineupChange.gain` | league fantasy points, this week | higher | cardinal | implicit: `changes_recommended` empty ⇒ already optimal | current week |
| Lineup | `lineup_efficiency` | ratio 0–1 (current ÷ optimal) | higher | cardinal | 1.0 ⇒ optimal | current week |
| Start/Sit | `projection_edge` / `floor_edge` / `ceiling_edge` | league points | `|·|` higher = clearer | cardinal | **yes**: `TOO_CLOSE` when `|edge| < 0.75` or `confidence LOW` | current week |
| Waiver | `net_roster_gain` | league points (add value − drop cost, blended weekly+ROS) | higher | cardinal (weighted) | **yes**: `DO_NOT_ADD` when `net < 0.75` | current + ROS blend |
| Waiver | `starter_impact` | counterfactual optimal-lineup Δ | higher | cardinal | `null` when unresolved | current week |
| Waiver | `score: DecisionScore.total` | **weighted** sum of named components (`WEEKLY_WEIGHTS`) — NOT points | higher | cardinal, engine-internal | components carry `missing_inputs` | mixed |
| Matchup | `win_probability` | probability 0–1 (seeded MC, LOW confidence) | higher | cardinal, low-confidence | omitted below 0.7 coverage | current week |
| Matchup | `projected_margin` | league points | higher | cardinal | `projected_margin_status` | current week |
| Trade | `roster_utility_delta` / `contextual_utility_delta` (per participant) | VOR-denominated utility | higher | cardinal, engine-internal | **yes**: `AcceptanceClass`, `TradeViability = NON_VIABLE`, rationality floor | current + ROS + playoff windows |
| Trade | `TradeViability` | `HIGH|MODERATE|LOW|NON_VIABLE` | higher | **ordinal band** | `NON_VIABLE` | mixed |
| Trade discovery | `my_gain`, `minimum_partner_gain` | same utility unit as evaluate | higher | cardinal | zero results ⇒ no path | mixed |
| Trade strategy | `urgency.score` | **[0, 1]** season urgency | higher | cardinal | n/a (a modifier, capped) | season |
| Trade strategy | `strategic_recommendation` | `STRONGLY_PRIORITIZE … AVOID` | higher | **ordinal band** | `AVOID` | season |
| Roster Health | `fragility.worst_starter_dependency`, `expected_one_loss_damage` | league points lost on a one-player loss | lower | cardinal | `profile = RESILIENT` | weekly & ROS (separate) |
| Roster Health | `league_relative.*` percentiles | **percentile 0–100** | context-dependent | ordinal | — | weekly & ROS |
| Roster Health | `depth_quality_grade` | `STRONG…BARE` | higher | ordinal band | `STRONG` | weekly & ROS |
| Schedule Planning | `estimated_bye_loss` | league points, prorated-ROS | lower | cardinal, **`ROS_PROJECTION` confidence** | 0 when no bye | future weeks |
| Schedule Planning | `structure_confidence` / `value_confidence` | `HIGH…LOW` / `ROS_CONTEXT_ONLY` | — | ordinal band | — | future weeks |
| Team-State | `DepthPressureLevel`, `StructuralFlag.severity` | `broken…none` / `critical…info` | — | ordinal band | `none` / no flag | current |

**A `trade utility_delta = 4.2` and a `waiver net_roster_gain = 4.2` and a
`roster fragility percentile = 42` have no mathematical relationship.** The Orchestrator
must **never rank raw specialist scores against each other**. It must first translate each
candidate action into an explicit, defined, comparable set of *normalised concepts*:

- **`expected_weekly_effect`** — expected change to this manager's best-legal-lineup points
  **per fantasy week over the relevant horizon**, taken from the owning specialist
  (`projected_points_gained` for lineup; `starter_impact` for waiver; participant
  `weekly` component of `roster_utility_delta` for trade; `estimated_bye_loss` avoided for
  a future-bye remedy — with its `ROS_PROJECTION` confidence carried).
- **`risk_reduction`** — reduction in `expected_one_loss_damage` / removal of a
  `SINGLE_POINT_OF_FAILURE` / coverage of an `uncovered_slot_labels` week (Roster Health /
  Schedule Planning / Team-State), in league points where available, else an ordinal band.
- **`urgency`** — timing band (§7), from calendar facts, **not** a score.
- **`confidence`** — propagated specialist confidence (§10), never upgraded.
- **`action_cost`** — transaction friction (§9).
- **`irreversibility`** — can the action be undone before it matters (§23)?

These six are the Orchestrator's comparison basis. Each is defined once, in the Orchestrator
schema, with its source specialist field named.

---

## 5. Management action classes (proposed)

| Class | Meaning | Existing engine support | Approve for v1? |
| --- | --- | --- | --- |
| `HOLD` | no management action justified | derived (absence of material actionable improvement) | **yes — first-class (§6)** |
| `LINEUP` | a currently-legal starting-lineup change should be made | `buildOptimalLineup` (`changes_recommended`, `empty_slots`, `illegal_situations`, `bye_problems`) | **yes** |
| `WAIVER` | an available-player add/drop is worth considering | `buildWaiverRecommendations` (`recommendations[]`), needs the weekly availability layer (FA pool not in Team-State) | **yes** |
| `TRADE` | a trade opportunity / discovery path is worth pursuing | `discoverTrades` + `analyzeTrade` + `ManagerStrategicProfile` | **yes, but gated** — discovery is the expensive path (§14, §41); v1 may run it conditionally (only when a condition has no cheaper remedy) or expose it as `TRADE_EXPLORATION` (a pointer to run discovery), not a concrete pre-computed package |
| `ROSTER_DEPTH` | a structural/quality depth vulnerability warrants attention | Roster Health (`fragility`, `player_dependency`, `single_points_of_failure`, `depth_quality`) + Team-State (`structural_flags`, `depth_pressure`) | **yes — but usually resolves to a `WAIVER`/`TRADE`/`WATCH` remedy, or `HOLD` (§6, §12)** |
| `FUTURE_PLANNING` | a known upcoming bye / schedule issue is important enough to address now | Schedule Planning (`WeekPlan`, `PlanningSummary.next_bye_week`, `weeks_with_uncovered_slots`) | **yes — but v1 most often maps to `WATCH` (§22); only escalates to a remedy class when urgency + materiality + available remedy all clear** |
| `K_DST` | streaming / specialist K or D/ST action | waiver engine already covers K/DEF (`BASE_POS`); lineup covers K/DEF slots; no dedicated streaming model | **as a sub-type of `WAIVER`/`LINEUP`, not a top-level class (§16)** — flag it in reason codes, don't build a K/DST model |

**Do not approve `ROSTER_DEPTH`, `FUTURE_PLANNING`, `K_DST` as independent forced
categories.** They are *conditions*; the Orchestrator's job (§6) is to run each through the
condition→action chain and land on `LINEUP` / `WAIVER` / `TRADE` / `WATCH` / `HOLD`.

Overlap to avoid: "start my backup RB because my RB1 is hurt" is a `LINEUP` action, not a
separate `ROSTER_DEPTH` action; "the RB position is fragile" is a `ROSTER_DEPTH` *condition*
that may produce a `WAIVER` action or a `WATCH`.

---

## 6. HOLD / WATCH / ACTION semantics

Three verdicts, mutually exclusive at the top level (individual items may still be listed):

- **`HOLD`** — no condition currently clears the full chain (§6-chain below) to a material,
  timely, remediable action. Explicitly *not* a failure. Emitted when e.g. the lineup is
  already optimal, every waiver candidate is `DO_NOT_ADD`, discovery finds no rational
  trade, Roster Health `profile = RESILIENT` (or fragile but no viable remedy), and
  Schedule Planning shows only distant / low-value pressure.
- **`WATCH`** — a real condition exists (fragility, a future bye hole, an
  `INJURY_STATUS_UNCERTAIN`, a shadow disagreement) but acting now is premature: not
  urgent, or no good remedy yet, or the situation may resolve itself. Carries the
  condition, the reason it's not yet an action, and the recompute trigger (§23).
- **`ACTION`** — one or more conditions clear the chain. Carries a `primary_action` and
  optional `secondary_actions` (independent, non-dominated — §20).

The chain every candidate condition must pass to become an `ACTION`:

```
CONDITION            a specialist-detected fact (structural flag, fragility, close call, bye hole, DO_NOT_ADD=false candidate, viable trade)
  ↓ MATERIALITY      is the effect big enough to matter?  (§8 — domain-certified thresholds first)
  ↓ URGENCY          does it need attention now, or is it a WATCH?  (§7)
  ↓ AVAILABLE REMEDY does a specialist certify a concrete legal remedy exists?  (lineup swap / waiver candidate / trade package)
  ↓ REMEDY QUALITY   does the remedy's expected effect exceed its cost, at acceptable confidence?  (§9, §10)
  → ACTION / HOLD/WATCH
```

Nothing in this chain invents a prediction — every step reads an existing specialist field.

---

## 7. Urgency model

**Two distinct urgencies — do not conflate:**

1. **Action-timing urgency** (Orchestrator-owned, timing band). What calendar facts exist:
   - `snapshot.league.current_week` — present.
   - `waiver_settings.waiver_day` (`string | null`) — present when the provider exposes it;
     `CanonicalAvailablePlayer.waiver_clears_at` (`string | null`) — per-player, provider-
     dependent, and the FA pool is not materialised today (§13).
   - Schedule Planning `WeekPlan.week` distance from `current_week`, `is_playoff_week`,
     `nfl_schedule_state`.
   - `ManagerStrategicProfile.season` — `weeks_remaining_regular`, `playoff_start_week`,
     `season_stage`, `trade_deadline_week` (**always `null` from Sleeper — never
     fabricated**), `trade_deadline_status`.
   - **Not available anywhere:** per-game kickoff time, lineup lock time. → **Finding P1-1.**
     The Orchestrator therefore *cannot* reliably say "act before tonight's games". It can
     say: `BEFORE_LINEUP_LOCK` (current week, lineup not yet optimal — timing unknown,
     treat as most urgent), `BEFORE_WAIVERS` (needs a waiver claim; `waiver_day` if known),
     `THIS_WEEK`, `NEXT_2_3_WEEKS`, `LATER_THIS_SEASON`, `INFORMATIONAL`.

2. **Season/strategic urgency** — already built: `ManagerStrategicProfile.urgency`
   (`{ score ∈ [0,1], components: { playoff_status, time_pressure, record } }`) plus
   `archetype` and `preferred_horizons` / `horizon_weights`. **Reuse verbatim** to weight
   how much a *future* or *marginal* condition matters (a `MUST_WIN` team in week 13 treats
   a small edge differently than a `FRONT_RUNNER` in week 3).

The Orchestrator's timing band is the primary urgency gate in the §6 chain; the strategic
urgency is a materiality multiplier for non-immediate conditions.

---

## 8. Materiality model

**Prefer the domain-certified gate that already exists over a new universal threshold:**

| Condition source | Existing significance gate to reuse |
| --- | --- |
| Lineup swap | `changes_recommended` only contains numeric-positive `gain`; `TopAction` priority bands `gain ≥ 3` / `≥ 1.25`; Start/Sit `TOO_CLOSE` when `|edge| < 0.75` or `confidence LOW` |
| Waiver | `MIN_NET_TO_RECOMMEND = 0.75` → `DO_NOT_ADD` below it; `priority ∈ {HIGH, MEDIUM, LOW}` already assigned |
| Trade | `AcceptanceClass`, `TradeViability`, rationality floor, `utility_gain_variance` / `imbalance_index` in `TradeSummary`; discovery `minimum_partner_gain` |
| Roster Health | `fragility.profile` (`RESILIENT` = not material); `depth_quality_grade`; `single_point_of_failure` boolean; `league_relative` percentile bands |
| Schedule Planning | `estimated_bye_loss` with `value_confidence`; `structure` degrade grade; `uncovered_slot_labels` non-empty is the structural gate |
| Start/Sit FI shadow / Matchup shadow | already `SHADOW_ONLY` — never material for an action, only for a `WATCH`/diagnostic |

Only where **no** domain gate exists does the Orchestrator define its own, and it does so
**once, transparently, as a named constant with a rationale**, e.g. a future-bye
`estimated_bye_loss` below ~2 pts/wk at `value_confidence ≤ MEDIUM` is `WATCH` not `ACTION`.
No hidden magic numbers; every threshold appears in the Orchestrator config with a comment.

---

## 9. Action-cost model

| Action | Cost representation (all facts already available) |
| --- | --- |
| `HOLD` | zero |
| Free lineup swap | `LOW` — no roster/priority/FAAB consumed; only friction is "remember to set it"; reversible until lock |
| Bench/IR reshuffle | `LOW` |
| Waiver claim / FA add **into an open slot** | `MEDIUM` — consumes waiver priority or FAAB (`waiver_settings.type ∈ {faab, rolling}`, `faab_budget`); `roster.open_active_slots` tells whether a slot is free |
| Waiver / FA add **requiring a drop** | `MEDIUM–HIGH` — `WaiverCandidateEval.drop_player_id` + `drop_cost` (already computed); dropping a useful bench player is a real cost the waiver engine already prices into `net_roster_gain` |
| Trade | `HIGH` — asset cost (assets given), uncertain acceptance (`AcceptanceClass`, `PartnerFitScore`), negotiation friction; irreversible once executed |

**Do not invent FAAB where settings don't support it** — `waiver_settings.type = "unknown"`
⇒ cost is qualitative (`priority slot consumed`). The Orchestrator represents cost as a band
(`ZERO|LOW|MEDIUM|HIGH`) plus the specific consumed resource, and **a 1-point trade
improvement must never outrank a free 1-point lineup swap** (§20 dominance).

---

## 10. Confidence propagation

Preserve, never upgrade. Structured evidence-confidence rather than one number:

```
evidence_confidence = {
  projection_basis:   WEEKLY | ROS_PROJECTION | NONE          (from the owning specialist)
  data_quality:       from WeeklyTeamContext.data_quality / RosterHealthDegradation / PlanningDegradation
  specialist_conf:    the specialist's own Confidence/AcceptanceClass/win_probability_confidence/value_confidence
  horizon:            CURRENT_WEEK | NEXT_3 | ROS | PLAYOFFS
}
```

Rules:
- A `LOW`-confidence specialist input **cannot** yield a `HIGH`-priority action merely
  because it ranks first. Priority is capped by the weakest confidence in its evidence
  chain.
- `optimality_status = PROVISIONAL` on a lineup, `starter_impact_status = UNRESOLVED` on a
  waiver, `TradeViability = LOW`, `value_confidence = ROS_CONTEXT_ONLY` on a bye loss — each
  caps the resulting action's confidence.
- Missing specialist ⇒ the dependent conclusion is **degraded**, not fabricated (§38).

---

## 11. Shadow-system boundary (hard requirement)

`ri-startsit-2026.1` and `ri-matchup-2026.1` are **`SHADOW_ONLY`**
(`fiMayInfluenceProduction()` = false, `matchupMayInfluenceProduction()` = false — verified
in the Phase 1–7 certification).

The Orchestrator:
- **MAY** surface `start_sit_shadow` / `matchup_intelligence` as a `WATCH` item or an
  explanation ("the shadow FI model would start B over A; it is not production-certified"),
  or as a disagreement diagnostic.
- **MUST NOT** create, rank, or justify a production `ACTION` using a shadow output as the
  deciding evidence. If production MAX_EXPECTED says start A and the shadow says B, the
  Orchestrator's `LINEUP` action (if any) is still A.
- **Architectural enforcement:** the Orchestrator's action-generation code takes its
  lineup/start-sit candidates **only** from `LineupResult.changes_recommended` /
  `StartSitComparison` (production). The shadow objects are passed only to the
  explanation/`WATCH` builder, which cannot emit an `ACTION`. A test asserts that swapping
  the shadow payload for an adversarial one never changes `primary_action` /
  `secondary_actions` (§37 case 13–14, §38).

---

## 12. Shared-context boundary

Roster Health and Schedule Planning are **`SHARED_CONTEXT`** — evidence, not remedies.
"QB dependency = 96th percentile" or "Week 10 uncovered FLEX" is a **condition**. The
Orchestrator then runs the §6 chain: is the player actually unavailable? is there an
internal backup (`contingency` / `bestLegalLineup` already answers this)? is a waiver QB
above replacement available (`buildWaiverRecommendations`)? is a trade path viable
(`discoverTrades`)? is it urgent (§7)? Only if a specialist certifies a concrete remedy
does it become an `ACTION`; otherwise `WATCH` or `HOLD`. High fragility never maps directly
to "add a QB".

---

## 13. Waiver-engine completeness

`buildWaiverRecommendations(ctx)` → `WaiverResult` already provides: candidate ranking
(`recommendations[]`, sorted, `priority ∈ {HIGH,MEDIUM,LOW,DO_NOT_ADD}`), paired
`drop_player_id`/`drop_name`/`drop_cost`, `net_roster_gain`, counterfactual
`starter_impact` (+`_status`), `bench_impact`, `bye_coverage_impact`,
`injury_hedge_impact`, `weekly_vor`/`flex_vor`, `immediate_role`/`rest_of_season_role`,
`confidence`, an inspectable `DecisionScore`, `reasons`, per-candidate `ros_signal`, and an
explicit `do_not_add[]` list with reasons. `roster_has_open_spot`, `faab`, `waiver_priority`
are on the result. Free agency comes from `ctx.availability` (canonical identity, this
league only); unresolved identities are never offered.

**Gaps / prerequisites:**
- The FA pool is materialised by the **weekly availability layer** (`ctx.availability`),
  **not** by Team-State (`free_agent_pool: "NOT_MATERIALIZED"`). The Orchestrator's shared
  context must therefore include a `WeeklyTeamContext` (which it needs anyway) — Team-State
  alone cannot answer "is there a waiver remedy". Documented Phase 2 deferral; not a Phase 8
  blocker.
- Waiver evaluation is **current-week + ROS-blend**; there is no "who should I stream at
  DST in week 9" forward view. The Orchestrator should not ask for one (§16).
- No redesign of the waiver engine in Phase 8. Any missing capability is a future
  specialist enhancement, documented here.

---

## 14. Trade-engine completeness

Available: `analyzeTrade` (evaluate a concrete proposal → `TradeAnalysis` with per-
participant `roster_utility_delta`/`contextual_utility_delta`, `AcceptanceClass`,
`TradeSummary.trade_viability`, `phase2_summary` depth/fragility deltas, `phase3_summary`
shadow); `discoverTrades` (`SearchMode ∈ {BEST_AVAILABLE, BUY_PLAYER, SELL_PLAYER,
POSITIONAL_NEED, CONSOLIDATE, FAIR_TRADES, EASY_TO_ACCEPT, BLOCKBUSTER, THREE_TEAM}` →
ranked `TradeDiscoveryResult[]`, every candidate validated by `validateTrade` + scored by
`evaluateTrade`); `PartnerFitScore` (need/surplus complementarity); `negotiateTrade`
(Pareto offer ladder); `ManagerStrategicProfile` + `StrategicTradeAssessment`
(`strategic_recommendation ∈ {STRONGLY_PRIORITIZE…AVOID}`). `TradeSearchProfile` already
computes `needs[]` / `surpluses[]` / `premium_assets` / `expendable_assets` /
`consolidation_candidate` / `fragility_sensitive`.

So the Orchestrator **can** ask "is there a realistic trade path to solve this positional
problem?" via `discoverTrades({ mode: "POSITIONAL_NEED", target_position })` without
reinventing anything.

**Gaps / prerequisites:**
- **Cost / performance (Finding P1-2):** `discoverTrades` is the expensive path
  (`max_generated_packages: 60`, evaluates each with the full `evaluateTrade`; league-wide
  partner scan). Running it unconditionally for every Orchestrator request for every
  manager is not viable at the Phase 1–7 latency budget. v1 must either (a) run discovery
  **only** when a material `ROSTER_DEPTH`/`POSITIONAL_NEED` condition has cleared materiality
  + urgency and has **no cheaper** (lineup/waiver) remedy, or (b) emit a
  `TRADE_EXPLORATION` pointer ("run trade discovery for RB — POSITIONAL_NEED") rather than a
  pre-computed package. Recommendation: **(b) for v1**, with (a) available behind an opt-in
  `include_trade_search` flag.
- `trade_deadline_week` is always `null` from Sleeper (Finding P3-1) — the Orchestrator
  cannot time-gate trades on a deadline; `TradeDeadlineStatus` stays `UNKNOWN`/`OPEN`.
- No redesign of the trade engine in Phase 8.

---

## 15. Current lineup actionability

`LineupResult` already exposes everything needed for a safe concrete action:
`slots[]` (`current_player_id` vs `recommended_player_id`, `is_change`,
`is_starter_set_change`, per-slot `confidence`, `reason`), `changes_recommended[]`
(numeric `gain`, `part_of_reshuffle`), `unresolved_decisions[]` (missing-projection —
**not** confident moves), `optimal_total` (`null` when an UNKNOWN starter would distort it),
`optimality_status ∈ {COMPLETE, PROVISIONAL}`, `known_optimal_subtotal`,
`points_left_on_bench`, `lineup_efficiency`, `empty_slots[]`, `illegal_situations[]`,
`bye_problems[]`, `injury_risks[]`, `unprojected_starters[]`. "Already optimal" is
`changes_recommended.length === 0 && empty_slots.length === 0 && illegal_situations.length === 0`.

**Gaps:** the engine does **not** know per-player game-lock state or handle in-progress
games (no kickoff facts — §7). It handles UNKNOWN projections safely (routes them to
`unresolved_decisions`, marks the lineup `PROVISIONAL`). **Do not extend into live late-swap
in Phase 8** — the architecture doesn't support it.

---

## 16. K / D/ST boundary

K and D/ST are already handled by the general engines: `buildOptimalLineup` fills K/DEF
starting slots; `buildWaiverRecommendations` (`BASE_POS` includes `K`, `DEF`) evaluates K/DST
adds with the same add/drop logic; Roster Health **excludes** K/DST from core fragility and
SPOF (frozen Phase 6 decision); Schedule Planning provides K/DST bye facts but no streaming
recommendation (frozen Phase 7 decision).

**Phase 8 decisions:**
- **No dedicated K/DST streaming model.** Not a top-level action class.
- A K/DST add surfaces as a normal `WAIVER` action with a `K_DST_STREAM` reason code.
- "Should a D/ST stream outrank a marginal RB bench add?" → resolved by the normal
  `expected_weekly_effect` + `action_cost` comparison; a DST with a good matchup that
  raises `starter_impact` more than a bench RB wins on merit, not on a special rule.
- "Does carrying an extra K/DST cost roster health?" → Roster Health already excludes them
  from fragility, so the honest answer is "only the roster slot" — represented as
  `action_cost` (the drop), nothing more.
- Schedule Planning K/DST bye context feeds a `FUTURE_PLANNING` → usually `WATCH`.

---

## 17. Conflict-resolution audit

| Conflict | Principle |
| --- | --- |
| A: waiver says "add RB X"; Roster Health says WR is the more fragile position | Not a conflict — different positions. Both conditions run the chain independently; rank by `expected_weekly_effect` × strategic weight × confidence ÷ cost. The WR fragility may still be a `WATCH` if no WR remedy is material. |
| B: trade says "trade surplus WR"; Schedule Planning says WR depth matters in Week 8 | The trade engine's `phase2_summary` **already** prices the depth hit into `contextual_utility_delta`; Schedule Planning's future coverage is additional negative evidence. If the trade's contextual delta is still positive *and* Schedule Planning shows the Week-8 hole is covered post-trade (re-run `bestLegalLineup` on the hypothetical), it survives; else it's downgraded / suppressed. |
| C: production lineup says A (higher EV); Matchup shadow says B (higher sim WP) | Production wins (§11). The Orchestrator reports the disagreement as a diagnostic; `primary_action` stays A (or `HOLD` if A is already started). |
| D: Roster Health says fragile; waiver says no candidate materially improves it | **`WATCH` / monitor, not a forced action.** This is a core HOLD/WATCH case. |

**No arbitrary weighted sums.** Conflicts are resolved by: (1) hard gates (legality,
shadow-boundary, materiality), (2) dominance/suppression (§20), (3) lexicographic priority
(§18). A weighted combination is used **only** within a single normalised dimension where
the components are the same unit (e.g. summing `expected_weekly_effect` across horizon
weeks with `horizon_weights`), never across dimensions.

---

## 18. Candidate prioritisation architectures

| Design | Fit for v1 |
| --- | --- |
| Rules/gates first, then rank | **Strong fit.** `is_legal? → evidence_trustworthy? (confidence floor) → material? (§8) → timely or WATCH? (§7) → specialist-certified remedy?` then order survivors. Deterministic, inspectable, matches every existing engine's own gate style. |
| Weighted score across normalised dimensions | Rejected for v1 — needs calibration data that doesn't exist (0 played weeks). Could be a `2026.2` candidate once real management outcomes accumulate. |
| Lexicographic priority (urgency → materiality → confidence → cost) | **Use for the final ordering of survivors.** Transparent, no fabricated trade-off weights. |
| Pairwise dominance | **Use for suppression (§20)** — A dominates B if A ≥ B on materiality *and* confidence *and* cost with no meaningful downside. |
| Hybrid (hard gates + interpretable lexicographic priority + dominance suppression) | **Recommended v1 architecture.** |
| Opaque learned ranking | **Rejected** — no historical decision data (§31). |

---

## 19. No arbitrary "AI GM score"

The Orchestrator does **not** emit `management_score = 87`. Each action carries its
transparent dimensions:

```
priority:            HIGH | MEDIUM | LOW
verdict_class:       LINEUP | WAIVER | TRADE | WATCH
urgency:             BEFORE_LINEUP_LOCK | BEFORE_WAIVERS | THIS_WEEK | NEXT_2_3_WEEKS | LATER | INFORMATIONAL
expected_weekly_effect: { points: number|null, basis: WEEKLY|ROS_PROJECTION, horizon: ... }
risk_reduction:      { points: number|null, kind: SPOF_REMOVED|COVERAGE_ADDED|... } | null
confidence:          HIGH | MEDIUM | LOW  (+ the structured evidence_confidence)
cost:                ZERO | LOW | MEDIUM | HIGH  (+ consumed resource)
reason_codes:        [...]
source_specialists:  [...]
```

Any aggregate priority band is a **pure function of these components** and always ships them.

---

## 20. Action dominance / suppression

- If a **free lineup swap** and a **waiver add (with a drop)** solve the same current-week
  hole, the lineup action **dominates** (lower cost, equal-or-better effect, reversible) —
  the waiver action is moved to `suppressed_actions` with `reason: "DOMINATED_BY_LINEUP"`.
- If a small waiver upgrade and an excellent trade both address QB backup depth, both may
  remain (different cost/feasibility/upside) — shown as `primary_action` (the cheaper,
  higher-confidence one) + a `secondary_action` (the trade, lower confidence, higher cost,
  higher ceiling).
- **Never present multiple redundant actions for one condition.** One condition → at most
  one non-suppressed remedy in `primary`/`secondary`, plus the suppressed alternatives
  listed for transparency.
- Dominance rule: A dominates B iff `A.expected_weekly_effect ≥ B.expected_weekly_effect`
  (within confidence) **and** `A.cost ≤ B.cost` **and** `A.confidence ≥ B.confidence`
  **and** A has no downside B lacks.

---

## 21. Multi-action plans

`ManagementAnalysisContext` exposes enough deterministic transaction state for **single**
independent actions and for **ranked independent** actions. It does **not** cleanly expose
*ordered dependent* multi-step plans ("IR player X → frees slot → claim Y → re-optimise
lineup") because:
- IR-eligibility is knowable (`roster.ir`, `reserve_ir_capacity`, `injury_status`) but the
  *post-IR* waiver evaluation would need a hypothetical roster re-run, which the waiver
  engine supports one-off but not as a chain;
- there is no transaction-sequencing primitive.

**v1 = Scope 2: single best action + ranked independent secondary actions. No multi-step
plans.** Scope 3 (ordered plans) is deferred and requires a dependency-representation design
(documented in §40, §43).

---

## 22. "Do this now" vs "watch this" — the three-state framing

Adopt `ACTION` / `WATCH` / `HOLD` (§6). Concretely: a Schedule-Planning "Week 11 creates a
major TE bye hole" seen in Week 2, with current TE depth adequate and no urgent remedy, is
**`WATCH`** with `recompute_when: ["week_advances", "roster_changes", "week >= 8"]` — not a
Week-2 `WAIVER`/`TRADE`. It escalates to an `ACTION` class only when urgency (§7) + materiality
(§8) + an available specialist-certified remedy all clear.

---

## 23. Opportunity expiration

Each action carries `expires_when`:

| Action | Expiry trigger |
| --- | --- |
| `LINEUP` | player lock (timing unknown — §7 — so "before games start this week") / roster change / new projections |
| `WAIVER` | candidate rostered by someone else / `waiver_clears_at` passes / roster change / new projections |
| `TRADE` / `TRADE_EXPLORATION` | partner roster changes / snapshot changes / `season_stage` changes |
| `WATCH` (future bye) | `current_week` advances toward the bye week / roster change |
| any | `league_snapshot_id` changes materially |

The Orchestrator result is **never** timeless advice — it is stamped to a snapshot and
carries its recompute triggers (§24).

---

## 24. Freshness contract

An Orchestrator result is bound to:
`orchestrator_version`, `league_snapshot_id`, `scoring_fingerprint`, `current_week`,
`team_state_version`, `weekly_projection_lineage`, `ros_projection_lineage`,
`roster_health_version`, `schedule_planning_version`, `football_intelligence_version`,
`trade_engine_versions`, `strategy_version`, `generated_at`, and (when available)
`recent_transactions` cursor.

Staleness rules: roster change ⇒ stale (recompute); any waiver/trade transaction ⇒
recompute; material projection-version change ⇒ recompute; week advance ⇒ recompute.
**Old results are never mutated** — a new result with new lineage is produced. Consistent
with the Phase 4/6/7 immutable-versioned-output pattern.

---

## 25. Production state-source boundary

Production currently reports `state_source: LEGACY_LIVE_PATH` with Phase 1 integrity
`CERTIFIED` and logical facts agreeing (verified in the Phase 1–7 certification). The
Orchestrator:
- consumes the certified canonical / Team-State contracts **only**;
- **does not** branch on `LEGACY_LIVE_PATH`, does not recreate provider-native roster
  truth, does not bypass `buildCanonicalLeagueState`, does not prefer an outer route's
  provider-native view over canonical state;
- treats `state_source` as deployment metadata to *echo in lineage*, nothing more.

**No bridge flag activation is required for Phase 8.** `BRIDGE_PUBLISHED_SNAPSHOT` stays
OFF; the Orchestrator reads the same legacy-live canonical path every other engine reads.

---

## 26. Shared-input assembly / P2 remediation architecture

**Confirmed P2 (from Phase 1–7 cert, and re-confirmed here):** `runInLeagueStateScope`
memoises `buildCanonicalLeagueState` **only**, keyed on read-shape flags. Within one scope,
`buildWeeklyIntelligence`, `buildLeagueManagementContext`, `buildRosterHealthContext`,
`buildSchedulePlanningContext`, `analyzeTrade`/`discoverTrades` each independently rebuild:
the weekly projection batch (RotoWire fetch + league scoring — the dominant cost),
Team-State, replacement levels, the RI ROS signal, and the schedule. Worse,
`buildRosterHealthInputs` calls `buildCanonicalLeagueState` directly while
`buildTradeAnalysisContext` calls `readLeagueState({ wave: 3, includeRecentTransactions })`
— **different read shapes ⇒ different memo keys ⇒ potentially two canonical reads even
inside one scope** (Finding P1-2 / P2-1).

**Proposed remediation — a request-scoped `ManagementAnalysisContext`** built once per
Orchestrator request inside `runInLeagueStateScope`:

- one canonical snapshot (agree on a single read shape: `wave 3` + matchups + recent
  transactions — the superset);
- one `LeagueManagementContext` (Team-State, all managers);
- one `WeeklyTeamContext` per analysed manager (or a league batch) — carrying projections +
  replacement + availability + byes;
- one ROS projection batch / replacement set;
- one `FullSchedule`;
- one `RosterHealthLeagueContext` (already all-managers);
- one `SchedulePlanningLeagueContext` (already all-managers);
- one `ManagerStrategicProfile` per manager (or league);
- `lineage` assembled once.

Specialists are invoked through **thin adapters** that accept the pre-built pieces instead
of re-fetching. **This must not modify any frozen specialist's semantics** — the adapters
pass the *same* inputs the specialists build today (verified by the existing isolation
tests). Where a specialist's public entry only accepts a `leagueSlug`, either (a) add an
*additive* `{ …Override }` option (the pattern Phases 4/6/7 already use — e.g.
`snapshotOverride`, `projectionProviderOverride`) without changing default behaviour, or
(b) call the specialist's already-exported inner builder (`buildRosterHealthInputs`,
`buildWeeklyTeamContext` with `snapshotOverride`, etc.). No rewrites.

Contract: request/execution-scoped, deterministic, lineage-aware, **not** process-lifetime
cached live state.

---

## 27. Candidate Orchestrator input contract

```ts
// references to CERTIFIED outputs — never a parallel representation of facts
interface ManagementAnalysisContext {
  canonical: CanonicalLeagueSnapshot;                 // Phase 1
  teamState: LeagueManagementContext;                 // Phase 2 (all managers)

  weekly: WeeklyTeamContext;                          // per analysed manager (projections, replacement, availability, byes)
  lineup: LineupResult;                               // buildOptimalLineup(weekly)
  startSit: StartSitComparison[];                     // buildCloseCalls
  matchup: MatchupResult;                             // buildMatchup(weekly)
  waivers: WaiverResult;                              // buildWaiverRecommendations(weekly)

  rosterHealth: TeamRosterHealth;                     // Phase 6 slice for this manager
  schedulePlanning: TeamSchedulePlan;                 // Phase 7 slice for this manager
  strategy: ManagerStrategicProfile;                  // trade Phase 6 strategy

  footballIntelRefs?: FootballIntelReadRefs;          // Phase 3, descriptive only
  startSitShadow?: StartSitShadowComparison | null;   // Phase 4 SHADOW_ONLY (explanation only)
  matchupShadow?: MatchupIntelligence | null;         // Phase 5 SHADOW_ONLY (explanation only)

  // trade discovery is NOT pre-run in v1 (§14); a helper to invoke it on demand:
  runTradeSearch?: (mode, opts) => Promise<TradeDiscoveryResponse>;

  lineage: OrchestratorLineage;
}
```

All fields are existing repository types. No new fact is represented twice.

---

## 28. Candidate Orchestrator output contract

```ts
interface OrchestratorResult {
  orchestrator_version: string;                       // "team-management-orchestrator-2026.1"
  lineage: OrchestratorLineage;
  league_slug: string;
  manager_slug: string;
  roster_id: number;
  league_snapshot_id: string;
  week: number;

  verdict: "ACTION" | "WATCH" | "HOLD";

  primary_action?: OrchestratorAction;
  secondary_actions: OrchestratorAction[];            // independent, non-dominated (may be empty)

  current_conditions: OrchestratorCondition[];        // every specialist-detected fact considered
  future_watch_items: OrchestratorCondition[];        // real but premature (§22)
  suppressed_actions: Array<{ action: OrchestratorAction; reason: string }>;

  confidence: "HIGH" | "MEDIUM" | "LOW";
  degradation: { reasons: string[]; missing_specialists: string[] };
  hold_rationale?: string[];                          // when verdict === "HOLD" — the negative evidence (§30)
}

interface OrchestratorAction {
  class: "LINEUP" | "WAIVER" | "TRADE" | "TRADE_EXPLORATION";
  target_problem: string;                             // the condition it addresses
  originating_specialist: string;
  remedy: { ... concrete: slot swap ids / add-drop ids / discovery mode+position ... };
  expected_effect: { points: number | null; basis: "WEEKLY" | "ROS_PROJECTION"; horizon: string };
  risk_reduction?: { points: number | null; kind: string } | null;
  cost: { band: "ZERO"|"LOW"|"MEDIUM"|"HIGH"; consumes: string | null };
  urgency: "BEFORE_LINEUP_LOCK"|"BEFORE_WAIVERS"|"THIS_WEEK"|"NEXT_2_3_WEEKS"|"LATER"|"INFORMATIONAL";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  evidence_confidence: { projection_basis; data_quality; specialist_conf; horizon };
  priority: "HIGH" | "MEDIUM" | "LOW";
  reason_codes: string[];
  expires_when: string[];
  explanation_chain: Array<{ specialist: string; fact: string }>;   // §29
}

interface OrchestratorCondition {
  code: string;                                       // e.g. QB_SINGLE_POINT_OF_FAILURE, WEEK11_TE_BYE_HOLE
  source_specialist: string;
  facts: Record<string, number | string | boolean | string[]>;
  materiality: "MATERIAL" | "MINOR" | "INFORMATIONAL";
  urgency: string;
  has_available_remedy: boolean;
  disposition: "ACTIONED" | "WATCH" | "NO_MATERIAL_REMEDY" | "NOT_URGENT" | "NOT_MATERIAL";
}
```

The shape above is a **candidate** — the review may adjust it.

---

## 29. Explanation provenance

Every `OrchestratorAction` and every `HOLD` carries an `explanation_chain` of
`{ specialist, fact }` pairs drawn verbatim from specialist outputs, e.g.:

```
Address QB backup depth  →
  [Team-State]        structural_flag NO_ACTIVE_BACKUP {positions:["QB"]}
  [Roster Health]     player_dependency QB league_percentile 96, single_point_of_failure true
  [Schedule Planning] WeekPlan week 10 starters_on_bye:[qb1] estimated_bye_loss 18.4 (ROS_PROJECTION)
  [Waiver]            candidate <id> priority MEDIUM net_roster_gain 3.1 immediate_role "streamer"
  [Strategy]          archetype CONTENDER, urgency 0.42
```

The Orchestrator **synthesises** these; it never fabricates a fact not present in a
specialist output. Provenance is carried programmatically (structured pairs), so the API /
assistant can answer "why?" without re-running any logic in prose.

---

## 30. Negative evidence

The Orchestrator explicitly represents reasons **not** to act, and a `HOLD` must be
*supported* by them (`hold_rationale[]`). Catalogue of negative-evidence codes, each mapped
to a specialist field:

| Code | Source |
| --- | --- |
| `IMPROVEMENT_BELOW_MATERIALITY` | lineup `gain` / waiver `net_roster_gain` below §8 gate |
| `NO_MATERIAL_WAIVER_REMEDY` | all `WaiverResult.recommendations` are `DO_NOT_ADD` or `priority LOW` |
| `NO_VIABLE_TRADE_PATH` | `discoverTrades` returns 0 results / all `NON_VIABLE` |
| `INTERNAL_BACKUP_SUFFICIENT` | `contingency` / `bestLegalLineup` shows the drop-in covers it |
| `CONDITION_NOT_URGENT` | §7 timing band = `LATER`/`INFORMATIONAL` and strategic urgency low |
| `FUTURE_CONCERN_TOO_DISTANT` | Schedule Planning week − current_week large, `value_confidence ≤ MEDIUM` |
| `SPECIALIST_CONFIDENCE_DEGRADED` | `PROVISIONAL` / `UNRESOLVED` / `ROS_CONTEXT_ONLY` / degradation reasons |
| `ACTION_DUPLICATES_OTHER` | dominance (§20) |
| `TRADE_PARTNER_INVALID_OR_UNLIKELY` | `PartnerFitScore.level LOW` / `AcceptanceClass` reluctant |
| `DROP_COST_EXCEEDS_BENEFIT` | waiver `drop_cost > add value` (engine already emits `DO_NOT_ADD`) |
| `ROSTER_ALREADY_OPTIMAL` | lineup `changes_recommended` empty, no empty/illegal slots |
| `ROSTER_HEALTH_RESILIENT` | `fragility.profile = RESILIENT` |

---

## 31. Historical calibration feasibility

`REAL_HISTORICAL_MANAGEMENT_DECISIONS`: essentially none. Bloodline is a first-year 2026
league, 0 played weeks. `devoted-to-the-game` has one prior season chain but no captured
*management-decision* record (what a manager actually did each week vs. the alternatives).
The bridge history/persistence layer captures *snapshots*, not decisions.

Future evaluation once weeks accumulate: action-recommended-vs-held vs realised lineup
improvement; waiver-add realised value vs replacement; trade outcomes; fragility reduction
that paid off; bye holes avoided; unnecessary transactions avoided (a `HOLD` that a manager
overrode and lost value). This needs a **decision-capture mechanism** (analogous to the
Phase 4 `capture.ts` shadow-decision store) — documented as a `2026.2` prerequisite, not
built now.

Separate always: `REAL_HISTORICAL_MANAGEMENT` vs `SYNTHETIC_MANAGEMENT_SCENARIOS`. **No
claim of strategic optimisation from synthetic tests.**

---

## 32. Synthetic management evaluation

Synthetic fixture scenarios are appropriate to certify: deterministic priority ordering,
conflict resolution, HOLD/WATCH/ACTION classification, dominance/suppression, urgency
banding, degradation handling, specialist-disagreement handling, action suppression,
horizon handling, shadow-boundary enforcement, lineage coherence, idempotency. They
**cannot** prove the Orchestrator improves real fantasy outcomes — the v1 certification, like
Phases 3–7, certifies *correct behaviour*, not *predictive/strategic value*.

---

## 33. Live shadow / advisory rollout

**Recommend `ADVISORY_ONLY`** (a new deployment state — semantics defined in §41):

- generates a user-facing management assessment;
- performs **no** transactions — no auto add/drop, no auto trade accept, no auto lineup set;
- does not modify or gate any specialist engine;
- is not `PRODUCTION_ACTIVE` in the Phase-4/5 sense (that term implies numeric influence on
  a production recommendation; the Orchestrator *is* a user-facing recommendation, so the
  term doesn't apply). It also is not `SHADOW_ONLY` (it *is* meant to be shown to the
  user). `ADVISORY_ONLY` = "user-facing recommendation, zero autonomous action, consumes
  frozen specialists read-only".

Autonomous transaction execution is an entirely separate future "action layer" phase, out
of scope.

---

## 34. Versioning / lineage

`team-management-orchestrator-2026.1`. `OrchestratorLineage` carries:
`orchestrator_version`, `deployment` (`ADVISORY_ONLY`), `league_snapshot_id`,
`scoring_fingerprint`, `team_state_version`, `weekly_engine_version`,
`weekly_projection_lineage`, `ros_projection_lineage`, `replacement_model`,
`roster_health_version`, `schedule_planning_version`, `football_intelligence_version`,
`trade_versions` (foundation/contextual/calibrated/data/discovery/strategy),
`start_sit_shadow_version`, `matchup_shadow_version`, `generated_at`, `planning_horizon`.
A policy/threshold change ⇒ new version (`2026.2`); no auto-promotion.

---

## 35. League-wide capability

`RosterHealthLeagueContext`, `SchedulePlanningLeagueContext`, `LeagueManagementContext` are
**already all-managers**. `ManagerStrategicProfile` is per-manager but built from a
league-wide context. So a league-wide Orchestrator run (`OrchestratorResult` per manager
from one shared `ManagementAnalysisContext`) is feasible in v1 for the **cheap** path
(lineup/waiver/roster-health/schedule/strategy). The **expensive** path (trade discovery
per manager) is not viable league-wide in v1 (§14, §41).

Future league-wide use ("which team needs RB most", "who has excess WR quality", "which
manager has the most urgent Week-8 issue") is enabled by the per-manager
`current_conditions[]` + `OrchestratorCondition.code` aggregation — **without** duplicating
trade-discovery logic (that stays in `lib/trades/discovery`).

v1 recommendation: build `buildOrchestratorContext(leagueSlug)` (all managers, shared) +
`orchestrateManager(ctx, managerSlug)`; expose both a per-manager and a league endpoint
(§43). Keep trade discovery opt-in.

---

## 36. Cross-manager symmetry

Given identical `TeamManagementState` + identical projections + identical schedule +
identical standings, `orchestrateManager` **must** produce an identical `OrchestratorResult`
regardless of `manager_slug` / `roster_id` identity. Manager identity enters only through
roster, standings, schedule, matchup, and team-specific state — never as a special case. No
personal assumptions, no per-manager tuning. A synthetic test asserts two managers with
swapped-but-identical states get structurally identical results (§37 fairness case, §38
invariant).

---

## 37. Adversarial matrix (for the eventual implementation)

1. roster already optimal, resilient, no byes → **`HOLD`**
2. obvious free lineup improvement (`gain ≥ 3`) → **`ACTION` / `LINEUP` / HIGH / BEFORE_LINEUP_LOCK**
3. tiny lineup improvement (`gain 0.2`) → **`HOLD`** or `LINEUP`/LOW with `IMPROVEMENT_BELOW_MATERIALITY` noted
4. severe QB fragility (SPOF, 96th pct) but every waiver QB `DO_NOT_ADD` and no trade path → **`WATCH`**
5. severe QB fragility + a `priority MEDIUM+` waiver QB above replacement → **`ACTION` / `WAIVER`**
6. future Week-10 bye hole seen in Week 2, current depth fine → **`WATCH`** (`recompute_when` week ≥ 8)
7. future Week-3 bye hole seen in Week 2 → higher urgency; if a remedy is material → `ACTION`, else `WATCH`
8. strong waiver candidate but the required drop is an equally valuable bench player → waiver engine emits low `net_roster_gain` / `DO_NOT_ADD` → **`HOLD`** with `DROP_COST_EXCEEDS_BENEFIT`
9. trade improves a starter but `phase2_summary` shows a severe depth hole → downgrade / `AVOID`; likely `WATCH` or suppressed
10. trade solves current fragility but worsens playoff weeks (Schedule Planning playoff coverage) → surface both; do not auto-recommend; `secondary_action` at LOW confidence at most
11. waiver and trade both solve the same problem → both may show (§20) — cheaper/higher-confidence is `primary`
12. free lineup swap and a transaction both solve the current hole → lineup **dominates**, transaction suppressed
13. Start/Sit shadow disagrees with production → production action unchanged; disagreement is a diagnostic `WATCH` item
14. Matchup shadow ΔWP favours B over the MAX_EXPECTED A → **no** lineup override; diagnostic only
15. Roster Health fragile, remedies all poor → **`WATCH`**
16. Schedule Planning flags a future problem, current health strong → **`WATCH`**
17. Team-State `structural_surplus` true but Roster Health `quality_surplus` false → not a conflict; no "trade away" action generated (the surplus isn't real quality) — condition `disposition: NOT_MATERIAL`
18. `quality_surplus` at a position that also has a future bye collision → the surplus *covers* the collision → `HOLD` / informational (surplus is doing its job)
19. K/DST stream opportunity (good matchup, above-replacement DST available) → `ACTION` / `WAIVER` with `K_DST_STREAM` reason
20. opponent lineup incomplete (`opponent_lineup` provisional) → matchup confidence degraded → any matchup-driven `WATCH` marked LOW confidence
21. missing weekly projection for a starter → `lineup.optimality_status = PROVISIONAL` → actions depending on the total marked LOW / degraded
22. missing ROS projection → Schedule-Planning / Roster-Health ROS conclusions degrade, not fabricate
23. degraded Roster Health (`overall != OK`) → roster-depth conditions carried but capped at `WATCH`
24. degraded Schedule Planning (`SCHEDULE_WEEK_INCOMPLETE`) → that week's structural conclusion suppressed, value conclusion degraded
25. unresolved player on roster (`identity_unresolved`) → surface as a data-quality `WATCH`; never recommend trading/dropping an unresolved id
26. open roster slot (`open_active_slots > 0`) → a waiver add needs no drop → cost `LOW`; may lower the materiality bar slightly
27. IR-eligible player on the active roster (injured, `reserve_ir_capacity > ir.length`) → surface an `IR_MOVE` opportunity (frees a slot) as a `LINEUP`-class action, cost `ZERO`
28. multiple good independent actions (lineup + waiver + IR move) → all three in `primary` + `secondary_actions`, lexicographically ordered
29. contradictory specialist recommendations → §17 resolution; if unresolvable → `WATCH` with both sides shown
30. nothing material anywhere → **`HOLD`** with a populated `hold_rationale`

---

## 38. Invariants (hard, for the eventual implementation)

- No material actionable improvement anywhere ⇒ `HOLD` is producible (never forced to invent an action).
- A `SHADOW_ONLY` output can never be the deciding evidence for an `ACTION` (adversarial test: swap the shadow payload, `primary_action`/`secondary_actions` unchanged).
- An illegal transaction is never recommended (every remedy is validated by the owning specialist: `buildOptimalLineup` legality, `validateTrade`, waiver add/drop legality).
- An unavailable player is never recommended as available (waiver candidates come only from `ctx.availability`; unresolved ids excluded).
- Same inputs ⇒ byte-identical `OrchestratorResult` (deterministic; seeded MC inside matchup is already seeded).
- Same snapshot ⇒ every consumed specialist's lineage `league_snapshot_id` is identical (coherence — already true from the Phase 1–7 cert; the Orchestrator asserts it and degrades loudly on mismatch).
- One backup cannot cover two simultaneous needs (inherited from `maxSlotMatching` / Phase 6 / Phase 7).
- A higher-confidence dominating action never ranks below an equivalent weaker one.
- A distant future issue never outranks an immediate material problem absent an explicit strategic reason.
- A tiny improvement never triggers a costly transaction (dominance + materiality gate).
- One specialist missing/degraded ⇒ the dependent conclusion degrades; other conclusions unaffected; no fabricated evidence.
- Roster snapshot changes ⇒ prior `OrchestratorResult` is stale; a new one is produced (not mutated).
- `verdict = HOLD` ⇒ `hold_rationale` is non-empty.
- The Orchestrator writes nothing to any specialist; production recommendation behaviour change = 0 (isolation test, §39).

---

## 39. Specialist regression contract

Phase 8 must not touch specialist semantics. Required at implementation time:
- `lib/weekly/{lineup,slots,start-sit,waivers,matchup}.ts` unchanged;
- Phase 4 `lib/weekly/start-sit-fi/**` unchanged; Phase 5 `lib/weekly/matchup-intelligence/**` unchanged;
- Phase 6 `lib/roster-health/**` unchanged; Phase 7 `lib/schedule-planning/**` unchanged;
- `lib/trades/**` unchanged (incl. frozen `ros.ts`, `depth.ts`);
- `lib/team-state/**`, `lib/canonical/**` unchanged;
- `WeeklyIntelligence.top_actions` output **byte-stable** for existing clients (the
  Orchestrator is a *new* surface; if `top_actions` is later re-pointed at the Orchestrator
  it is a separate, tested change).
- Allowed: additive `{ …Override }` options on specialist *builders* (the established
  Phase 4/6/7 pattern), used only to pass already-built shared inputs — with a test proving
  the default path is unchanged.
- Full `npm test` unchanged pass count + Phase 1C `cross_surface_discrepancies = 0`.

---

## 40. Candidate v1 scope

| Scope | Content | Verdict |
| --- | --- | --- |
| 1 | Synthesise `current_conditions` + `future_watch_items` + `HOLD`/`WATCH`/`ACTION` verdict, **no concrete ranked transactions** | too thin — the specialists already produce concrete remedies; not surfacing them wastes certified capability |
| **2** | **Scope 1 + prioritise existing concrete `LINEUP` / `WAIVER` actions, + `TRADE_EXPLORATION` pointers (opt-in concrete trade search), + dominance/suppression + `secondary_actions`** | **RECOMMENDED v1** |
| 3 | Scope 2 + ordered multi-step dependent plans (IR→slot→claim→re-optimise) | **deferred** — needs a transaction-sequencing / dependency representation that doesn't exist (§21) |
| 4 | Scope 3 + autonomous execution | **explicitly rejected** |

Scope 2 rationale: every existing specialist output needed for concrete lineup + waiver
actions is complete (§13, §15); trade discovery is complete but expensive (§14) so it is
opt-in / pointer-form in v1; multi-step plans need new plumbing.

---

## 41. Deployment recommendation

**`ADVISORY_ONLY`** — new state, defined:

```
ADVISORY_ONLY:
  - user-facing management recommendations are generated and surfaced
  - ZERO autonomous action: no lineup set, no add/drop, no trade offer/accept
  - consumes frozen Phases 1–7 read-only; changes no specialist output
  - not SHADOW_ONLY (it IS shown to the user); not PRODUCTION_ACTIVE
    (no numeric influence on any specialist's production recommendation)
  - promotion to any future autonomous "action layer" requires a separate
    certified phase + explicit versioned deployment change; no auto-promotion
```

A lifecycle constant + a `orchestratorMayExecuteTransactions()` guard that **always returns
false** in v1 (mirroring `fiMayInfluenceProduction`).

---

## 42. Performance / provider-read estimate

Measured today (Phase 1–7 cert, full league, cold, one scope): canonical + Team-State
~170–480 ms; Roster Health ~300–720 ms; Schedule Planning ~440–460 ms; Weekly Intelligence
incl. shadows ~0.6 s/manager; `provider_reads_one_composite_op = 1` + one cached schedule.

Orchestrator per-manager **cheap path** (no trade discovery), with the shared
`ManagementAnalysisContext` (§26): dominated by the **one** weekly-projection assembly +
**one** Team-State + **one** Roster Health + **one** Schedule Planning + **one** strategy
profile, then near-free synthesis. Estimate **~1–2 s/manager cold, well under the 60 s
lambda budget**, and materially *faster* than today's naive sum because the shared context
removes the duplicate projection/Team-State/schedule assembly (the P2). **Provider reads: 1
composite canonical read + 1 schedule fetch per request, 0 per specialist.**

**Expensive path** (`include_trade_search`): + `discoverTrades` (~seconds, league-wide
partner scan) per requested position — opt-in only, never in the default league-wide run.

No process-lifetime caching. Request-scoped only.

---

## 43. API strategy

- **Do not overload Phase 2 `/manage`** (its contract is "structural facts, no
  recommendations" — adding an Orchestrator verdict there breaks that contract).
- **Do not reuse `/recommendations`** — that path is the SNAKE_ONLY **draft** engine.
- **New surfaces:**
  - `GET /api/leagues/:slug/managers/:manager/orchestrate` — one manager's
    `OrchestratorResult`. `?include_trade_search=1` opt-in for the expensive path.
  - `GET /api/leagues/:slug/orchestrate` — all managers (cheap path only), for league-wide
    views and future trade-discovery seeding.
  - `Cache-Control: 30/120` (same as roster-health / schedule-planning), `maxDuration: 60`.
- Additively, `WeeklyIntelligence` MAY later gain an optional `orchestrator?:
  OrchestratorResult | null` field (like `start_sit_shadow` / `matchup_intelligence`) — a
  separate, tested change, not part of v1.

---

## 44. Full-system explanation quality

The `explanation_chain` (§29) + `current_conditions[]` + `suppressed_actions[]` +
`hold_rationale[]` + `OrchestratorCondition.disposition` give a downstream assistant/API
enough **structured** evidence to answer, without re-running logic in prose:
- "Why are you recommending this?" → `primary_action.explanation_chain` + `reason_codes`.
- "Why not make a trade?" → `future_watch_items` / `suppressed_actions` with
  `NO_VIABLE_TRADE_PATH` / `TRADE_PARTNER_INVALID_OR_UNLIKELY` / `DROP_COST_EXCEEDS_BENEFIT`.
- "Why is this waiver more important than my Week-8 bye issue?" → compare the two
  `OrchestratorCondition`s' `urgency` + `materiality` + `expected_effect`.
- "Why hold?" → `hold_rationale[]` (the negative-evidence codes).

---

## 45. Findings

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| P8-1 | **P1** | **No game-kickoff / lineup-lock fact anywhere in the canonical model or schedule provider.** The Orchestrator cannot say "act before tonight's games"; action-timing urgency is limited to week-grain + `waiver_day`. | Accept the limitation. `urgency` band `BEFORE_LINEUP_LOCK` means "current week, lineup not yet optimal" without a clock. A future schedule-provider enhancement (kickoff times) is a documented prerequisite for finer urgency — **not** a Phase 8 blocker. |
| P8-2 | **P1** | **Shared-input reassembly + divergent canonical read-shapes.** `buildRosterHealthInputs` uses `buildCanonicalLeagueState` directly; `buildTradeAnalysisContext` uses `readLeagueState({wave:3,…})` — different memo keys ⇒ up to 2 canonical reads in one scope; and projections/Team-State/schedule are rebuilt per specialist. | **Resolve in Phase 8** via the request-scoped `ManagementAnalysisContext` (§26) built on one agreed read shape, with **adapters only** (no frozen-semantics change, isolation-tested). This is the §26 architecture and a v1 deliverable. |
| P8-3 | P2 | **`WeeklyIntelligence.top_actions` is an overlapping proto-orchestrator** (current-week lineup+waiver+alerts only, always emits something, no HOLD/cost/urgency). | Build the Orchestrator as a **new** surface; keep `top_actions` byte-stable. Optionally re-point `top_actions` at the Orchestrator in a later, separately-tested change. |
| P8-4 | P2 | **Trade discovery cost** — `discoverTrades` (league-wide partner scan, 60 packages × full evaluate) is not viable unconditionally or league-wide per request. | v1: `TRADE_EXPLORATION` pointer by default; concrete search behind `?include_trade_search=1`. Documented in §14, §40, §42. |
| P8-5 | P2 | **No management-decision capture** — historical calibration of Orchestrator decisions is impossible (0 played weeks; snapshots captured, decisions not). | Document a `capture.ts`-style decision store as a `2026.2` prerequisite (§31). v1 certifies behaviour, not strategic value. |
| P8-6 | P3 | **`trade_deadline_week` always `null`** from Sleeper — no deadline-based trade urgency gate. | `TradeDeadlineStatus` stays `OPEN`/`UNKNOWN`; documented (§7, §14). Not fabricated. |
| P8-7 | P3 | **FA pool not in Team-State** (`free_agent_pool: "NOT_MATERIALIZED"`, Phase 2 deferral) — waiver remedies require a `WeeklyTeamContext`. | The Orchestrator context includes `WeeklyTeamContext` anyway (§13, §27). No action. |
| P8-8 | P3 | **`DecisionScore.total` (waiver) is a weighted engine-internal number**, easy to mistake for points. | The Orchestrator uses `net_roster_gain` / `starter_impact` (points) for `expected_effect`, never `DecisionScore.total`; the latter is passed through only inside `explanation_chain`. Documented in §4. |

**No P0.**

---

## 46. Explicit deferrals (`DEFERRED_FEATURES`)

- Ordered multi-step dependent plans (Scope 3) — needs transaction-sequencing design.
- Autonomous transaction execution (Scope 4) — separate future phase.
- Any calibrated / learned priority weighting — needs `REAL_HISTORICAL_MANAGEMENT` data.
- Finer-than-week action-timing urgency — needs kickoff/lock facts (P8-1).
- Deadline-aware trade urgency — needs a resolvable deadline (P8-6).
- League-wide concurrent trade discovery — cost (P8-4).
- Re-pointing `WeeklyIntelligence.top_actions` at the Orchestrator — separate change.
- Management-decision capture + `orchestrator-2026.2` re-evaluation — data-gated.
- K/DST streaming model — deliberately not built (§16).
- FI numeric influence of any kind — barred (Phases 3–5 null findings binding).

---

## 47. Recommendation

Proceed to a **Scope 2**, **`ADVISORY_ONLY`** Orchestrator
(`team-management-orchestrator-2026.1`):

- a request-scoped `ManagementAnalysisContext` that assembles the canonical snapshot +
  Team-State + weekly (projections/replacement/availability/byes) + ROS + schedule +
  Roster Health + Schedule Planning + strategy profile **once** (resolving P8-2), through
  **adapters that do not change any frozen specialist's semantics**;
- a **hard-gates → lexicographic-priority → dominance-suppression** synthesis producing
  `HOLD` / `WATCH` / `ACTION` with transparent per-action dimensions (no "GM score"),
  full `explanation_chain` provenance, and a supported `hold_rationale`;
- concrete `LINEUP` and `WAIVER` actions from the production specialists; `TRADE_EXPLORATION`
  pointers by default with opt-in concrete `discoverTrades`;
- shadow systems surfaced as diagnostics only, architecturally barred from driving an
  `ACTION`; `SHARED_CONTEXT` layers used as condition + materiality + urgency evidence, never
  as direct remedies;
- new `/orchestrate` endpoints (per-manager + league), `top_actions` left byte-stable;
- synthetic-only certification (the §37 adversarial matrix + §38 invariants + §39 regression
  + lineage coherence), with predictive/strategic value explicitly **not** claimed and a
  documented `2026.2` decision-capture re-evaluation path.

Scope 3 and Scope 4 are rejected for v1. No frozen Phase 1–7 semantics change.

---

# PHASE 8 — ORCHESTRATOR PRE-IMPLEMENTATION AUDIT COMPLETE; SCOPE GATE OPEN

Requesting review/approval of: the **Scope 2 / `ADVISORY_ONLY`** recommendation (§40–§41,
§47); the **normalised comparison basis** replacing raw cross-engine score ranking (§4); the
**hard-gates + lexicographic-priority + dominance** architecture (§17–§20); the
**`HOLD`/`WATCH`/`ACTION`** framing with first-class HOLD and supported `hold_rationale`
(§6, §22, §30); the **request-scoped `ManagementAnalysisContext` with adapters-only** as the
P8-2 remediation (§26–§27); the **shadow-boundary architectural enforcement** (§11); the
**trade discovery as opt-in / pointer-form** in v1 (§14); the **new `/orchestrate` API
surface** leaving `top_actions` byte-stable (§43); and the **synthetic-only, non-predictive**
certification standard with a data-gated `orchestrator-2026.2` (§31–§32).

**Stopping. No Orchestrator implementation until the scope is reviewed.**

---
---

# Part II — Implementation & Certification (`team-management-orchestrator-2026.1`)

_Scope 2, `ADVISORY_ONLY`, approved from the audit above. Branch
`team-management-phase8-orchestrator`. No Phase 1–7 frozen semantics changed._

## II.1 Implementation architecture

```
Phase 1 CanonicalLeagueSnapshot ─┐
Phase 2 Team-State ───────────────┤
Phase 3 Football Intelligence ────┤   buildManagementAnalysisContext(leagueSlug)
Phase 4 Start/Sit FI  (SHADOW) ───┤     ├─ ONE runInLeagueStateScope
Phase 5 Matchup Intel (SHADOW) ───┼──▶  ├─ ONE canonical provider read (superset shape, primes the scope memo)
Phase 6 Roster Health (SHARED) ───┤     ├─ ONE Team-State league context   (snapshotOverride)
Phase 7 Schedule Plan (SHARED) ───┤     ├─ ONE Roster Health league context
existing Weekly / Lineup / …  ────┤     ├─ ONE Schedule Planning league context
existing Waiver engine ───────────┤     ├─ ONE trade-analysis context  → strategy profiles
existing Trade discovery ─────────┘     └─ per-manager Weekly Intelligence  (lazy, memoised, snapshotOverride)
                                              │
                                   deriveConditions → aggregateConditions (§32)
                                              │
                                   generateCandidates  (production specialists only)
                                     LINEUP  ← wi.lineup / wi.start_sit
                                     WAIVER  ← wi.waivers
                                     TRADE_EXPLORATION ← trade search profile [+ discoverTrades if opted in]
                                              │
                                   runPolicy:  hard gates → lexicographic priority → dominance suppression → verdict
                                              │
                                   OrchestratorResult  (immutable, lineage-stamped)  → captureOrchestratorResult (NullCaptureStore default)
```

**Files** — `lib/orchestrator/`: `schema.ts` (contract + `ORCHESTRATOR_DEPLOYMENT =
"ADVISORY_ONLY"` + `orchestratorMayExecuteTransactions()` ≡ `false` + decision-capture
schema), `context.ts` (`ManagementAnalysisContext`), `dimensions.ts`, `conditions.ts`,
`candidates.ts`, `gates.ts`, `policy.ts`, `capture.ts`, `build.ts`, `index.ts`.
**API** — `GET /api/leagues/:slug/orchestrate` and
`GET /api/leagues/:slug/managers/:mgr/orchestrate` (`?include_trade_search=1`).

## II.2 P8-2 resolution (request-scoped context)

`buildManagementAnalysisContext` runs everything in **one** `runInLeagueStateScope` and
primes the scope memo with a single canonical read in the superset shape
(`includeMatchups + includeRecentTransactions + reportPersistence`). Every specialist that
accepts `snapshotOverride` (Team-State, Weekly Intelligence) is handed the primed snapshot;
Roster Health / Schedule Planning hit the same memo key. Measured:

| | context assembly | canonical provider reads | Team-State builds | RH builds | SP builds | trade-ctx builds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| bloodline-bowl | 1.76 s | **1** | 1 | 1 | 1 | 1 |
| devoted-to-the-game | 1.28 s | **1** | 1 | 1 | 1 | 1 |

The audit's P8-2 (up to **2** canonical reads from divergent read-shapes) is **resolved** —
`canonical_provider_reads = 1`. **Bounded residual (documented, not a rewrite):** Roster
Health and Schedule Planning each still re-assemble the weekly projection batch + RI signal
in memory from the (memoised) snapshot — RH ≈ 350–700 ms, SP ≈ 450–540 ms of the assembly.
Eliminating it needs a frozen Phase 6/7 builder change (`buildRosterHealthInputs` accepting
pre-built inputs), which §9 forbids for Phase 8. Zero extra provider reads; deferred to a
future dedicated refactor phase.

`test/orchestrator-isolation.test.ts` asserts `metrics.snapshot_ids_seen.size === 1` and
`snapshot_coherent === true`.

## II.3 Dimension normalisation (§14 / §15)

No raw specialist score is compared across domains. Each candidate is translated in
`dimensions.ts`:

| dimension | keeps | example source |
| --- | --- | --- |
| `expected_weekly_effect` | `{ value, unit: "fantasy_points", source, basis }` — **not** rescaled | `lineup.projected_points_gained`, `waiver.starter_impact` / `net_roster_gain` |
| `risk_reduction` | cardinal points **or** `{ direction, magnitude_class, source }` | `roster_health.fragility`, `waiver.bye_coverage_impact` |
| `urgency` | `NOW \| THIS_WEEK \| BEFORE_WAIVERS \| NEAR_TERM \| FUTURE \| INFORMATIONAL` (band) | current-week defect / `waiver_day` / Schedule-Planning week distance |
| `confidence` | `HIGH \| MEDIUM \| LOW`, **capped by the evidence floor** | specialist `Confidence` / `PROVISIONAL` / `ROS_CONTEXT_ONLY` |
| `cost` | `{ band: ZERO\|LOW\|MEDIUM\|HIGH, consumes }` | free swap / FAAB / waiver priority / roster asset |
| `irreversibility` | `REVERSIBLE \| PARTLY_REVERSIBLE \| IRREVERSIBLE` | lineup vs waiver-with-drop vs trade |

`value === null` where a dimension cannot be quantified — never fabricated.

## II.4 P8-1 enforcement (no fabricated intra-day precision)

`classifyUrgency` produces only week-grain bands. `NOW` is emitted **only** for a current
*structural* defect (illegal lineup / empty starter slot / a starter on a schedule-verified
bye) and always carries `EXACT_LOCK_TIME_UNAVAILABLE`. A waiver claim carries
`WAIVER_DAY_UNKNOWN` when the provider does not expose `waiver_day`. The Orchestrator never
emits "before tonight", "before the 7:20 kickoff", "before Player X locks", or "you have N
minutes". Tested (`orchestrator.test.ts` "P8-1: urgency never finer than week").

## II.5 Shadow prohibition (§11) — enforced in code

`gates.ts::shadowGate` fails any candidate whose entire evidence set is
`start_sit_shadow` / `matchup_shadow` (`SHADOW_ONLY_EVIDENCE`). `candidates.ts` never
sources a candidate from a shadow output — shadow disagreements become
`SHADOW_DIAGNOSTIC_ONLY` conditions in `conditions.ts` and can only ever be `future_watch_items`.
`orchestrator.test.ts` "swapping the shadow payload never changes primary/secondary actions"
+ the live test's per-action non-shadow-evidence assertion prove it.

## II.6 Validation results

| check | result |
| --- | --- |
| `npx tsc --noEmit` | **clean** |
| `eslint app lib test` | **0 errors**, 29 warnings (**0 new** — same pre-existing set) |
| `npm test` | **1588 tests · 1584 pass · 0 fail · 4 skipped** (0 existing tests changed; +33 orchestrator tests) |
| `test/orchestrator.test.ts` | 24/24 — deployment guard, dimension units, P8-1 urgency, confidence propagation, 5 hard gates, HOLD (already-optimal + no-waiver + resilient), ACTION (obvious lineup fix / fragility+waiver), tiny-edge → not-ACTION, WATCH (fragility-no-remedy / distant bye), INSUFFICIENT_EVIDENCE vs HOLD, dominance (free swap > costly waiver), independent actions co-surface, shadow-swap invariance, cross-manager symmetry, byte-identical determinism, §37 matrix rows, illegal-never-recommended, distant-doesn't-outrank-immediate |
| `test/orchestrator-isolation.test.ts` | 3/3 — weekly lineup/matchup/waivers **byte-identical** direct vs via-context; roster-health + schedule-planning identical; one coherent snapshot, 1 canonical read |
| `test/orchestrator-live.test.ts` | 6/6 — bloodline + devoted advisory smoke, lineage coherent, no shadow-driven ACTION, HOLD carries rationale, deterministic |
| Phase 1C live (3 leagues) | `cross_surface_discrepancies = 0`, `null_required_fields = 0` |
| frozen surfaces `git diff --stat f0bda54..HEAD` | **empty** for `lib/trades/{ros,depth}.ts`, `lib/weekly/{lineup,slots,start-sit,waivers,matchup,intelligence}.ts`, `lib/weekly/start-sit-fi/**`, `lib/weekly/matchup-intelligence/**`, `lib/roster-health/**`, `lib/schedule-planning/**`, `lib/team-state/**`, `lib/canonical/**`, `lib/football-intel/**` |
| `WeeklyIntelligence.top_actions` | untouched — byte-stable; the Orchestrator is a separate surface |

**§40 specialist recommendation behaviour change = 0** — proven structurally (empty diff) and
behaviourally (`orchestrator-isolation.test.ts`: production `lineup.optimal_total`,
`matchup.win_probability`, and every waiver `net_roster_gain` / `priority` are identical
whether reached directly or through the shared context).

## II.7 Live advisory smoke (preseason, week 1–2, 0 played weeks)

| | verdict | primary | watch |
| --- | --- | --- | --- |
| bloodline-bowl / supyo29 | **WATCH** | — (lineup gain below materiality; every waiver immaterial; QB depth is a WATCH; week-7 uncovered slot NOT_URGENT) | ROSTER_FRAGILITY, WEEK_7_UNCOVERED_SLOT, QB_DEPTH_VULNERABILITY |
| devoted-to-the-game / darthmarker | **ACTION** | LINEUP / HIGH / THIS_WEEK — a bench player outprojects a starter (+ WAIVER secondary) | ROSTER_FRAGILITY, WEEK_7_UNCOVERED_SLOT, SHADOW_MATCHUP_WP_DISAGREEMENT (diagnostic), QB_DEPTH_VULNERABILITY |
| bloodline-bowl league (12) | 3 × WATCH, 9 × ACTION (all LINEUP / WAIVER — unset preseason lineups) | — | — |

Every live ACTION is backed by a production-certified specialist remedy (lineup engine /
waiver engine). No verdict was forced; the preseason mix of WATCH/ACTION was preserved.
Deterministic on repeat. Runtime: ~1.5 s / manager cold, ~7 s full 12-team league,
`?include_trade_search=1` ~2.1 s — all well within the 60 s lambda budget.

## II.8 Decision capture (§36)

`OrchestratorDecisionRecord` schema is defined and `captureOrchestratorResult` is wired into
`orchestrateManager`. The default `getOrchestratorCaptureStore()` is a `NullCaptureStore`
(no-op) — persistence infrastructure was not approved for Phase 8, so nothing is written
unless an operator calls `setOrchestratorCaptureStore(...)`. `MemoryCaptureStore` exists for
tests. `acted_upon` is always `"UNKNOWN"` (manager compliance is never fabricated). This
record is the basis for the future `2026.2` re-evaluation.

## II.9 Findings (implementation)

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| P8-1 | P1 (from audit) | no certified player-lock / kickoff fact | **Enforced honestly** — week-grain urgency + `EXACT_LOCK_TIME_UNAVAILABLE` / `WAIVER_DAY_UNKNOWN`; no small authoritative adapter exists to add exact lock (§5), so intra-day urgency stays deferred. Scope 2 does not depend on it. |
| P8-2 | P1 (from audit) | shared-input reassembly + divergent read-shapes | **Resolved** for provider reads (1 canonical read/request). In-memory projection re-assembly by RH + SP remains as a bounded, documented residual (II.2) — a frozen-semantics refactor phase, not Phase 8. |
| P8-3 | P2 | `WeeklyIntelligence.top_actions` overlaps the Orchestrator | Left byte-stable. A future migration (re-point `top_actions` at the Orchestrator, or deprecate it) is a separate tested change — documented, not done. |
| P8-4 | P2 | trade discovery cost | Handled — pointer by default, concrete `discoverTrades` behind `?include_trade_search=1`; never run league-wide. |
| P8-5 | P2 | no durable decision capture | Additive interface + schema shipped; `NullCaptureStore` default (II.8). |
| P8-9 | P3 | RH/SP each re-assemble the weekly batch within one scope | Same as the P8-2 residual — measured (II.2), deferred. |

**No P0. No unresolved P1** (P8-1 is a data limitation enforced correctly, not a defect;
P8-2's provider-read half is resolved and the residual is documented per §8 / §48).

## II.10 Freeze contract — `team-management-orchestrator-2026.1`

The Orchestrator is frozen at **`ADVISORY_ONLY`**. Future work may consume it; it may not:

- execute any transaction — `orchestratorMayExecuteTransactions()` must stay `false`; any
  autonomous "action layer" is a separate certified phase with an explicit versioned
  deployment change, never an auto-promotion;
- compare raw specialist scores across domains — every candidate goes through
  `dimensions.ts`;
- let a `SHADOW_ONLY` output (Phase 4/5) be the deciding evidence for an `ACTION`;
- turn a `SHARED_CONTEXT` fact (Phase 6/7) directly into a remedy — a remedy must come from a
  production specialist;
- change any Phase 1–7 specialist's semantics, or `lib/trades/{ros,depth}.ts`, or
  `WeeklyIntelligence.top_actions`;
- claim intra-day timing precision without a certified lock/kickoff fact;
- introduce a learned ranking model or an opaque `management_score` without calibrated
  historical management-decision data;
- implement Scope 3 (multi-step dependent plans) or Scope 4 (autonomous execution).

A policy / threshold / dimension change requires a new version (`2026.2`). The frozen v1
constants live in `lib/orchestrator/{gates,dimensions,policy}.ts` with inline rationale.

## II.11 `2026.2` re-evaluation (deferred, data-gated)

Once genuine 2026 management-decision + outcome evidence accumulates (via a wired capture
store), `2026.2` may evaluate: unnecessary-transaction avoidance, realised lineup gain,
waiver value, trade-exploration usefulness, fragility reduction that paid off, bye-hole
avoidance, HOLD quality, and WATCH→ACTION timing. v1 is **not** retrained or rewritten
retroactively. **`2026.1` certification is non-predictive** — it certifies deterministic
correctness, safe specialist coordination, gating, conflict resolution, dominance, lineage,
isolation, explanation provenance, and performance. It does **not** claim the policy has been
empirically proven to improve fantasy outcomes.

## II.12 Deployment

Merged to `main` (see final SHA below), deployed to Vercel production. `ADVISORY_ONLY`:
the endpoints recommend; they never execute. `BRIDGE_PUBLISHED_SNAPSHOT` stays OFF — the
Orchestrator reads the same legacy-live canonical path as every other engine.

---

## §48 Freeze criteria — met

- one request-scoped coherent management context exists ✔ (`ManagementAnalysisContext`, 1 canonical read, coherent snapshot asserted)
- P8-2 shared-input duplication resolved/bounded without semantic rewrites ✔ (provider reads resolved; in-memory residual documented)
- P8-1 exact-lock limitation enforced honestly ✔ (`EXACT_LOCK_TIME_UNAVAILABLE`, week-grain bands, `NOW` only for structural defects)
- raw specialist scores never cross-compared ✔ (`dimensions.ts`; tested)
- shadow systems cannot drive ACTION ✔ (`shadowGate`; tested with adversarial swap)
- shared context cannot invent remedies ✔ (`conditions.ts` produces conditions only; remedies come from `candidates.ts` production specialists)
- concrete actions originate in certified production specialists ✔ (LINEUP ← lineup/start-sit; WAIVER ← waiver engine; TRADE_EXPLORATION ← discovery/search profile)
- HOLD / WATCH / ACTION all work ✔ (tested + live)
- dominance / suppression coherent ✔ (tested)
- negative evidence retained ✔ (`suppressed_actions`, `hold_rationale`, condition `suppression_reasons`)
- lineage coherent ✔ (`OrchestratorLineage` with per-specialist `SpecialistUsage`; isolation test)
- one canonical reality maintained ✔
- APIs additive ✔ (`/orchestrate`; `/manage` + `top_actions` untouched)
- deployment `ADVISORY_ONLY` ✔ · zero autonomous execution ✔ (`orchestratorMayExecuteTransactions()` ≡ false)
- specialist recommendation behaviour change = 0 ✔ (empty diff + isolation test)
- all P0/P1 implementation defects resolved ✔ (no P0; P8-1 enforced, P8-2 provider-read half resolved + residual documented)

---

# PHASE 8 CERTIFIED — ADVISORY TEAM MANAGEMENT ORCHESTRATOR FREEZE

`team-management-orchestrator-2026.1`, `ADVISORY_ONLY`. Merged & deployed. Scope 2 only —
no multi-step dependent plans, no autonomous execution. STOP.
