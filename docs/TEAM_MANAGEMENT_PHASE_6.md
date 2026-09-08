# Team Management — Phase 6: Roster Health Intelligence

**Status: BUILT + VALIDATED. Verdict at Part II §II.17.**

Branch `team-management-phase6-roster-health` (off the Phase 5 stack). Phases 3/4/5 remain
stacked and unmerged — not restructured. Phase 5 (`lib/weekly/matchup-intelligence/`) is
`SHADOW_ONLY` and unchanged; production recommendation behavior unchanged.

---

## 1. Objective

Phase 2 established **structural Team-State facts** (*what is true*). Phase 6 is the first
**evaluative** layer on top: *what those facts imply about quality, resilience, and risk* —
roster fragility, depth quality (usable vs superficial), which starter losses hurt most,
concentration risk, redundancy, useful bench spots, bye/one-injury resilience, shared-backup
dependency, and the structural-strength-vs-player-quality gap. It does **not** recommend a
trade, drop, add, or waiver claim — those stay with the domain engines and the future
Orchestrator.

---

## 2. Existing roster-health / need / depth logic audit

| System | File | Structural? | Uses projections? | Uses replacement? | Uses FA market? | Scope |
| --- | --- | --- | --- | --- | --- | --- |
| **`DepthPressure`** (`none`/`thin`/`bare`/`broken` + `structural_surplus`) | `lib/team-state/depth.ts` | **Yes, projection-FREE** | no | no | no | Phase 2 fact |
| **`PositionInventory`** (counts per slot key: rostered/active/starting/benched/ir) | `lib/team-state/inventory.ts` | Yes | no | no | no | Phase 2 fact |
| **`StructuralFlag`** (`SINGLE_POINT_OF_FAILURE`, `NO_ACTIVE_BACKUP`, `CURRENT_WEEK_BYE_GAP`, `SHARED_BYE_WEEK`, `IR_DEPTH_REDUCTION`, `UNFILLED_STARTER_SLOT`, …) | `lib/team-state/flags.ts` | Yes | no | no | no | Phase 2 fact |
| **`league_position_summary`** (`teams_broken`/`bare`/`thin`/`surplus` per slot) | `lib/team-state/build.ts` | Yes | no | no | no | Phase 2 fact |
| **`rosterResilience`** → `fragility_score`, `usable_depth_score`, per-position `PositionDepth` (`viable_starters`, `usable_backups`, `replacement_cliff`, `no_cover`, `understaffed`), `flex_pool` (`shallow`, `surplus_over_slots`) | **`lib/trades/depth.ts`** | **No — EVALUATIVE** | **yes** (weekly proj) | **yes** (`ctx.replacement`) | via league-derived FA | **trade-engine only** |
| **`evaluateDepthParticipant`** → `fragility_delta` (before/after a trade) | `lib/trades/depth.ts` | No | yes | yes | yes | trade delta |
| **`computeWeeklyReplacement`** / `weeklyVOR` (position + FLEX replacement line, `nth_best_available` frontier, league FA pool) | `lib/weekly/replacement.ts` | No | yes | yes | **yes** (`LeagueAvailability.free_agents`) | shared (lineup + waiver) |
| **`computeReplacementLevels`** / `applyValueOverReplacement` / tiers / `PositionalScarcity` | `lib/projections/replacement.ts` | No | yes (season) | yes | no (roster-slot theoretical) | season/draft |
| **`positional_needs`** (`need` per base family = `required_starters`; parity-tested vs `PositionInventory`) | `lib/weekly/context.ts` | Yes | no | no | no | weekly |
| **`need_multiplier`** (open→1.25, depth≥2→0.82) | `lib/projections/manager-value.ts` | Yes | no | no | no | **draft board only** |
| **`buildWaiverRecommendations`** (scarcity/replacement/add-drop) | `lib/weekly/waivers.ts` | No | yes | yes | yes | waiver recs |
| **trade partner-fit / discovery / need-position** | `lib/trades/discovery/*`, `lib/trades/context.ts` | No | yes | yes | yes | trade discovery |
| **`buildLineup` VOR** (`replacement_impact`, `replacement_vulnerability`) | `lib/weekly/matchup.ts`, `lib/weekly/lineup.ts` | No | yes | yes | yes | matchup/lineup |
| Team-State `DepthPressureEntry.structural_surplus` (`backup ≥ 2` base / `≥ required+1` flex) | `lib/team-state/depth.ts` | Yes | no | no | no | Phase 2 fact |

**Headline: a deterministic evaluative roster-fragility / depth-quality model already exists
in `lib/trades/depth.ts`** (`fragility_score`, `usable_depth_score`, `replacement_cliff`,
`no_cover`, `flex_pool.shallow`). It is **trade-scoped** (weighted `POS_WEIGHT` RB/WR 1.4 /
K-DEF 0.4, an anti-hoarding `USABLE_BACKUP_CAP = 3`, a `STEEP_CLIFF = 5` driver) and only
invoked by `lib/trades/{evaluate,context,calibration}.ts`.

---

## 3. Ownership matrix — what moves to Phase 6, what stays

| Concept | Owner after Phase 6 | Reason |
| --- | --- | --- |
| `DepthPressure` / `PositionInventory` / `StructuralFlag` / `league_position_summary` | **Phase 2 Team-State (unchanged)** | pure structural facts; Phase 6 *consumes* them (spec §B) |
| `computeWeeklyReplacement` / `weeklyVOR` / `computeReplacementLevels` / tiers / scarcity | **shared (unchanged)** | tested replacement framework; Phase 6 consumes it (spec §A: don't duplicate) |
| `positional_needs` (weekly), `need_multiplier` (draft) | **unchanged** | domain-specific; not roster-health |
| `lib/trades/depth.ts` `rosterResilience` / `fragility_score` / `evaluateDepthParticipant` | **FROZEN in the trade engine** | moving it risks trade-recommendation changes (spec §A.7, §S). Phase 6 generalizes the *concepts* into a shared layer; the trade engine keeps its own tuned numbers until an explicit later phase repoints it. |
| Legal **whole-lineup** contingency (`remove player → re-run `maxSlotMatching` → Δ value`) | **NEW — Phase 6** | `trades/depth.ts` does per-position + a separate flex count, not joint matching; a proper contingency needs `maxSlotMatching` (spec §G, §M) |
| `player_dependency` (Δ legal-lineup value per starter), roster `fragility` / `resilience` as a **shared** signal, `quality_surplus`, `bench_utility` (contingency value), league-relative percentiles, health `degradation` vector, snapshot health-delta | **NEW — `lib/roster-health/`** | the evaluative layer this phase builds |

**No existing tested metric is duplicated under a new name.** `structural_surplus` (Phase 2)
and `quality_surplus` (Phase 6) are kept distinct (spec §K).

---

## 4. Player count vs player quality (spec §D)

Phase 2 correctly says "5 RBs". Phase 6 distinguishes:
- **starter quality** = Σ VOR of the current best legal starters at a position
- **usable backup** = a benched, slot-eligible player projecting **≥ the league replacement
  line** (`computeWeeklyReplacement` / ROS equivalent) — the same "viable" test
  `trades/depth.ts` already uses
- **replacement-level filler** = projecting below the line (counts for Phase 2 `PositionInventory`,
  contributes **0** to Phase 6 depth quality)
- **redundancy** = usable backups beyond what is realistically fieldable given `maxSlotMatching`

Raw counts are never a quality proxy. A "5 RB" roster with 1 usable backup scores the same
depth quality as a "3 RB" roster with 1 usable backup.

---

## 5. Projection horizon audit (spec §E)

| metric | horizon | source | lineage field |
| --- | --- | --- | --- |
| current-week fragility, one-loss contingency, this-week bench utility | **weekly** | `SleeperWeeklyProjectionProvider` (RotoWire) | `projection_lineage.weekly` |
| depth quality, quality surplus, starter quality, player dependency (season-relevant) | **rest-of-season** | external ROS = `RosSignal.points` (Sleeper season prorated); RI season model **ordinally** only (`ri_position_rank`/`ri_vor`/`ri_tier`) — its absolute level has a known calibration caveat (`projections-ri.ts`) | `projection_lineage.ros` |
| structural resilience, bye exposure, IR burden | **projection-free** (Team-State) | — | — |

**Horizons are never silently mixed.** Every Phase 6 metric declares its horizon; the two
horizons produce two views (`current_week_health`, `rest_of_season_health`) rather than one
blended number. RI is consumed as an ordinal cross-check / confidence signal, never numerically
ensembled (the Phase-1 Intelligence-I rule, still in force).

---

## 6. Replacement-level audit (spec §F)

Three distinct replacement concepts, **not conflated**:

| concept | definition | availability | Phase 6 use |
| --- | --- | --- | --- |
| **league-theoretical** | projection at rank `starters_in_league + cushion` of the full pool | always (`computeReplacementLevels`, `replacement.ts` `position_rank_fallback`) | the floor for "viable backup"; league-size + FLEX aware; K/DEF get their own rank |
| **actual free-agent** | `nth_best_available` free agent (`LeagueAvailability.free_agents` — everyone in the projection feed not on any of the 12 rosters; Sleeper has no waiver windows so waivers ≈ FA) | **weekly: yes** (already used by `weeklyVOR`); **ROS: partial** | the "what you'd actually get" replacement for one-loss contingency |
| **bench-internal** | best legal benched player the optimizer would promote | always (`maxSlotMatching`) | the contingency re-optimization result itself |

**`waiver_state` is `null`** (Phase 1C C-5) and Team-State declares `free_agent_pool:
"NOT_MATERIALIZED"` — but the **weekly engine already derives a real FA pool** from
"rostered by nobody in this league", which is the correct approximation for a 12-team league.
Phase 6 uses that at the weekly horizon and **documents** that the ROS-horizon FA replacement
is league-theoretical (no reliable ROS projections for the long tail of free agents), not a
true live-waiver-market model.

---

## 7. Contingency-simulation feasibility (spec §G, §AB)

`baseline = value(maxSlotMatching(starting_slots, all legal active players))`. For each
candidate removal `X`: `contingency(X) = baseline − value(maxSlotMatching(slots, players − X))`.

- **one-player loss, every starter + top ~5 bench players**: ~15 solves/team × 12 teams =
  ~180 `maxSlotMatching` (Kuhn's bipartite, ~15 candidates × ~10 slots → microseconds each).
  **Trivially cheap.**
- **simultaneous two-player loss**: `C(15,2)` ≈ 105 pairs/team → ~1,260 solves. Still < 100ms.
  But it multiplies interpretation complexity for marginal insight.
- **FLEX / SUPER_FLEX**: `maxSlotMatching` already handles these correctly (it is the frozen
  Phase-1 primitive; a versatile backup is matched to at most one slot).

**v1: one-player-loss contingency** for every starter + top bench (spec §G). Two-player loss
is `DEFERRED` (combinatorial, low marginal value).

---

## 8. Starter-dependency proposal (spec §H)

`dependency(player) = contingency(player)` from §7, exposed in **four** interpretable forms
(never one opaque 0–100 score):

```
raw_point_loss           baseline_value − post_removal_value        (league-scored)
pct_lineup_loss          raw_point_loss / baseline_value
replacement_gap          player_projection − best_legal_replacement_projection
league_percentile        rank of raw_point_loss across all starters in the league
```

League/scoring-aware by construction (`baseline_value` is in the league's canonical scoring).
`raw_point_loss` is the primary; `league_percentile` gives cross-team context (§16).

---

## 9. Roster-fragility proposal (spec §I)

Fragility is **not one number** — a component vector, plus two summary views:

```
worst_starter_dependency        max over starters of raw_point_loss      (single point of failure)
expected_one_loss_damage        mean over starters of raw_point_loss     (broadly thin)
top3_weighted_dependency        weighted mean of the 3 highest           (concentration)
tail_dependency                 p90 of the dependency distribution
single_points_of_failure[]      starters whose removal drops a slot below the replacement line
```

A catastrophic single point of failure (`worst` high, `mean` low) and a uniformly thin roster
(`worst` moderate, `mean` high) are reported as **different conditions**, not averaged away.
`resilience` is the inverse framing: `min slot value retained after any one loss`.

---

## 10. Depth-quality proposal (spec §J)

Per position key (from the **canonical `starting_slots`** — a 1-QB and a SUPER_FLEX league
have different QB depth requirements, spec §J):

```
starter_quality        Σ VOR of the best `required` legal starters
best_backup_vor         VOR of the best usable backup (≥ replacement line)
second_backup_vor       VOR of the 2nd usable backup
replacement_cliff       marginal_starter_projection − best_backup_projection    (reuses trades/depth semantics)
usable_backup_count     benched, slot-eligible, ≥ replacement line
depth_quality_grade     STRONG | ADEQUATE | THIN | BARE     (deterministic bands off the above)
```

Backup *requirement* is position-specific: base positions want ≥ 1 usable backup; FLEX-heavy
positions (RB/WR in a 3-WR + FLEX league) want more; K/DST want 0 (§18).

---

## 11. Structural surplus vs quality surplus (spec §K)

- **`structural_surplus`** (Phase 2, unchanged): `backup_count ≥ 2` (base) / `≥ required + 1`
  (flex) — a **count** fact.
- **`quality_surplus`** (Phase 6, NEW): benched, slot-eligible players projecting **materially
  above the replacement line** (default: VOR ≥ a position-relative threshold, §17) **beyond
  what `maxSlotMatching` could field**. A count-surplus of five replacement-level WRs is **not**
  a quality surplus.

Both are emitted; neither overwrites the other. `quality_surplus` per position + a
`tradeable_surplus` list (the specific benched players who are surplus — as a *signal*, not a
"trade him" recommendation, §19).

---

## 12. Bench-utility proposal (spec §L)

Deterministic contingency value only — **no speculative breakout probabilities** (spec §L):

```
starter_replacement_value    max over starters of (post-loss lineup value with THIS bench player available
                             − post-loss lineup value without him)   — "how much damage does he prevent"
multi_slot_coverage          # of distinct starting-slot families this player is the best/only usable backup for
bye_coverage                 slots this player covers whose starter has a bye within the reliable horizon (§15)
bench_utility_grade          HIGH | MODERATE | LOW | DEAD_WEIGHT
```

A bench player whose `starter_replacement_value ≈ 0` and `multi_slot_coverage = 0` is
`DEAD_WEIGHT` regardless of raw projected points.

---

## 13. Multi-position eligibility (spec §M)

**Handled exclusively through `maxSlotMatching`.** A player eligible for RB and FLEX inflates
Phase 2's independent per-position counts but the contingency simulation matches him to **one**
slot. `multi_slot_coverage` (§12) records that one versatile backup *appears* to back several
slots but cannot fill them simultaneously — and `shared_backup_dependency` flags when the
**same** bench player is the best legal backup for ≥ 2 slot families (a Phase 2
`SINGLE_POINT_OF_FAILURE`-adjacent condition, now quantified: `Σ dependency if that one backup
is also lost`).

---

## 14. Injury / availability treatment (spec §N)

Deterministic scenarios only. `OUT` / `IR` / `SUSPENDED` / bye → the player is **excluded**
from the baseline legal lineup (they cannot start), so their contingency is already reflected
and `IR_burden` (§ below) counts trapped capacity. `DOUBTFUL` → treated as OUT for the
baseline with a `QUESTIONABLE_ROLE`-style flag. `QUESTIONABLE` → kept in the baseline but
their slot's `single_point_of_failure` check is run **as if they were out** (a "one-injury
resilience" scenario), flagged. **No injury probabilities** (spec §N) — Phase 6 says "if X
is unavailable, …", never "X has 27% to miss".

`IR_burden` = Σ (ROS VOR of IR players) + (IR slots used / IR slots available) — how much
roster capacity/value is trapped.

---

## 15. Bye-risk boundary (spec §O)

Phase 6 exposes only:
- **current-week bye fragility**: starters on bye this week + the contingency of covering them
- **near-term known bye collision**: `SHARED_BYE_WEEK` within the schedule feed's reliable
  horizon (Phase 2 uses ~3 weeks; Phase 6 inherits that bound — `UPCOMING_BYE_LOOKAHEAD`)

Phase 6 does **not** build the full Future Schedule / ROS strength-of-schedule model — that is
the next phase. Bye metrics are `schedule_facts`-gated with a `SCHEDULE_HORIZON_LIMITED`
degradation reason beyond the reliable window.

---

## 16. League-relative benchmarking (spec §P)

Every headline dimension gets a **within-this-league, this-snapshot, same-horizon, same-scoring**
percentile: `starter_quality_pct`, `depth_quality_pct`, `fragility_pct` (inverted so higher =
healthier), `bench_utility_pct`, `worst_dependency_pct`. Computed from the single
`LeagueManagementContext` (all 12 teams, one snapshot). **No cross-league percentiles**
(the two registered leagues have different size/scoring). The raw value is always emitted
alongside the percentile.

---

## 17. Position-relative benchmarking (spec §Q)

A 4-point QB backup gap ≠ a 4-point TE backup gap. Phase 6 normalizes point gaps by the
**position's own league VOR spread** (`PositionalScarcity.value_over_replacement_range` from
`projections/replacement.ts`, or the weekly-pool equivalent): `normalized_gap = point_gap /
position_vor_iqr`. `depth_quality_grade` bands and `quality_surplus` thresholds are
position-relative, not absolute points.

---

## 18. K / DST treatment (spec §R)

- **K**: exclude K-backup fragility from the core roster-health score. A healthy roster
  carrying one kicker is not penalized; carrying two kickers is not rewarded (no evidence).
  Filter Phase 2 `NO_ACTIVE_BACKUP` noise for K in the Phase 6 view.
- **DST**: `dst_depth` reported **separately** (streaming/schedule utility is real but belongs
  to the future streaming model). One DST is fine; multiple DSTs → a small `dst_streaming_depth`
  note, not a health bonus.
- Rationale documented; both are `EXCLUDED_FROM_CORE_FRAGILITY` with the flag visible.

---

## 19. Trade / waiver boundary (spec §S) — reusable signals, zero recommendation change

Phase 6 emits **signals** the trade/waiver engines *could* consume later:
`position_fragility[pos]`, `quality_surplus[pos]`, `player_dependency[]`, `bench_utility[]`,
`tradeable_surplus[]`, `shared_backup_dependency`. It does **not** call any recommendation
engine, and **no trade/waiver recommendation number changes** during Phase 6 (verified by
re-running the trade + waiver deterministic suites). `lib/trades/depth.ts` stays frozen — a
later phase (Orchestrator / Trade Engine v-next) decides whether to repoint it onto the
shared signals.

---

## 20. Output-schema proposal (spec §T, §U)

`lib/roster-health/schema.ts` — `ROSTER_HEALTH_VERSION = "roster-health-2026.1"`. Per team:

```ts
{
  roster_health_version, lineage,
  team_id, roster_id, manager,
  horizon_views: {
    current_week: { starter_quality, depth_quality, fragility, resilience, position_health, bench_utility },
    rest_of_season: { ...same shape... }
  },
  position_health: { QB: {...}, RB: {...}, WR: {...}, TE: {...}, K: {...}, DEF: {...} },   // §10
  player_dependency: PlayerDependency[],        // §8, sorted desc by raw_point_loss
  quality_surplus: QualitySurplus[],            // §11
  contingency_scenarios: ContingencyScenario[], // §7 — { removed_player_id, replaced_by, slot, value_loss, evidence }
  shared_backup_dependency: SharedBackupDependency[],  // §13
  ir_burden: { trapped_ros_vor, ir_slots_used, ir_slots_available },
  bye_exposure: { current_week_starters_on_bye, near_term_collisions },  // §15
  league_relative: { starter_quality_pct, depth_quality_pct, fragility_pct, bench_utility_pct },  // §16
  degradation: DegradationVector,               // §22
  explanations: HealthExplanation[]             // §21
}
```

Plus a league-level `RosterHealthLeagueContext` (all 12 teams from one snapshot) and an
optional `RosterHealthDelta` (§23). Every evaluative field carries the supporting facts that
explain it (§21).

---

## 21. Explainability (spec §U)

Every `HIGH`/`critical` result carries a traceable chain mapped to actual inputs:
```
RB fragility: HIGH
  → RB1 (proj 18.4) unavailable
  → maxSlotMatching promotes RB3 (proj 7.1) to the RB slot
  → best-legal-lineup value falls 6.1 pts (baseline 121.3 → 115.2)
  → only one remaining legal RB/FLEX backup ≥ replacement line (8.9)
```
No opaque health scores. `contingency_scenarios[].evidence` holds `{ baseline_value,
post_removal_value, promoted_player_id, promoted_projection, remaining_usable_backups }`.

---

## 22. Degradation model (spec §V)

Structured, Phase-4/5 pattern:
`MISSING_WEEKLY_PROJECTION` · `MISSING_ROS_PROJECTION` · `UNKNOWN_PLAYER` ·
`UNRESOLVED_IDENTITY` · `INCOMPLETE_LINEUP` · `REPLACEMENT_POOL_UNAVAILABLE` ·
`SCHEDULE_HORIZON_LIMITED` · `INJURY_STATUS_UNKNOWN` · `PROJECTION_HORIZON_MISMATCH` ·
`DEPARTED_MANAGER` · `VACANT_TEAM` · `FA_POOL_ROS_APPROXIMATE`.
Overall grade = floor of components; a metric computed with a degraded input is emitted
**flagged**, never as clean certainty (spec §V, §AA).

---

## 23. Snapshot health-delta feasibility (spec §W)

`RosterHealthDelta(before, after)` — run the deterministic model on two
`CanonicalLeagueSnapshot`s and diff every numeric field, with a typed change list
(`FRAGILITY_INCREASED`, `DEPTH_QUALITY_IMPROVED`, `NEW_SINGLE_POINT_OF_FAILURE`,
`QUALITY_SURPLUS_GAINED`, …). Deterministic, cheap (2× the base cost). It **describes** a
roster-state change ("WR quality up, RB fragility up"); it does **not** say "this trade is
good" (spec §W). The delta requires both snapshots' lineage recorded so a consumer can detect
differing projection/scoring inputs.

---

## 24. Historical evaluation feasibility (spec §X)

| input | availability |
| --- | --- |
| `REAL_HISTORICAL_ROSTERS` — real weekly rosters + starter absences + realized lineup loss | **Bloodline: none** (first-year league, 2026 season not started, 0 played weeks). **`devoted` chain: 1 prior season** (~12 teams × 17 weeks of `/matchups` `starters` + points). |
| pregame projections as-of a historical week | Sleeper historical feed (Phase 4/5 provenance caveat: 2021 no timestamp, 2022 bulk-backfill, 2023–25 in-season) |
| realized starter absences | `nflreadr::load_rosters_weekly` `status` + participation (who actually played) |
| realized lineup loss when a starter missed | actual bench-player points that week vs the absent starter's season mean |

**Predictive question** ("does higher measured fragility predict larger realized lineup loss
when starters miss?") is **testable but data-thin** — it needs played weeks with injury events
in a league whose rosters we can reconstruct. Feasible on the `devoted` chain (~100
team-weeks with absences) as a **cross-check**, not a certification. Full predictive
validation waits for real 2026 weeks — a dormant re-eval like Phase 4/5 (`roster-health-2026.2`).

---

## 25. Synthetic evaluation limitations (spec §Y)

`SYNTHETIC_ROSTERS`: draw 12 legal rosters (respecting `starting_slots`, bench size, positional
composition of a real 12-team league, availability, and the historical player-projection
distribution), score with real canonical scoring. Synthetic evaluation verifies **mathematical
behavior** — monotonicity invariants (§27), slot handling, FLEX/SUPER_FLEX legality, fragility
logic, percentile sanity. It **cannot** prove real managers benefit strategically (spec §Y).
`REAL_HISTORICAL_ROSTERS` (devoted) and `SYNTHETIC_ROSTERS` reported **separately, never merged**
(Phase 5 rule).

---

## 26. Adversarial matrix (spec §Z) — 25 scenarios, all must pass before certification

1 elite starters / terrible bench · 2 average starters / strong bench · 3 elite RB + no backup
· 4 five replacement-level RBs · 5 shallow WR room · 6 deep WR room · 7 1-QB league · 8
SUPER_FLEX league · 9 TE-premium scoring · 10 one versatile backup covering multiple slots ·
11 open bench slot · 12 over-roster-limit · 13 IR-heavy roster · 14 multiple same-bye starters
· 15 K without backup (→ not a fragility driver) · 16 two kickers (→ no health bonus) · 17 one
DST · 18 multiple DSTs · 19 vacant team · 20 departed manager · 21 unresolved player · 22
missing projection · 23 player traded midweek · 24 starter moved to IR · 25 two equal rosters,
different concentration risk (→ different `worst_starter_dependency`, same `expected_one_loss_damage`).

---

## 27. Invariants (spec §AA) — deterministic, defined pre-implementation

- remove a starter, replace with a **worse** player → resilience **not** higher
- improve the best legal backup, hold else constant → depth quality **not** lower
- add a **replacement-level** bench player → `quality_surplus` gain **≈ 0** (bounded)
- add a **high-quality** legal backup → fragility **not** higher
- one backup eligible for N slots → counted available to **at most one** at a time (`maxSlotMatching`)
- same snapshot + same projections + same model version → **byte-identical** output
- higher-quality legal replacement → **lower** `dependency.raw_point_loss` for the starter it backs
- no projection for a player → that player's contribution is degraded/flagged, **not** fabricated
- `Σ player_dependency` is **not** claimed to equal any roster total (per-removal, not additive)
- `fragility_pct` inverted consistently (higher = healthier) everywhere it appears

---

## 28. Runtime / performance (spec §AB)

One `buildLeagueManagementContext` (Phase 2 — **one** `getLeagueState`) + **one** weekly
`WeeklyProjectionBatch` (all rostered + FA, via one provider read) + **one** ROS batch.
Then, in-memory: 12 teams × (~10 starters + ~5 bench) `maxSlotMatching` solves ≈ **~180
microsecond-scale solves** + percentile passes. **Estimated < 50 ms for the whole league**,
zero extra provider reads beyond the Phase-2 + projection reads the weekly engine already
does. `runInLeagueStateScope` memoization applies. Exhaustive one-player contingencies are
comfortably live-affordable; two-player is deferred (§7).

---

## 29. Proposed v1 scope (spec §AC) — **Scope 3**

**Scope 3: starter quality + depth quality + player dependency + roster fragility/resilience +
quality surplus + deterministic snapshot health-deltas.** Justification:

- **The data exists** — production weekly + ROS projections, the tested replacement framework
  (with a real league-derived FA pool at the weekly horizon), Phase 2 structural facts,
  `maxSlotMatching`. No remediation blocker.
- **The contingency simulation is cheap** (§28) and the delta contract is a free 2× (§23) —
  so Scope 3 costs little more than Scope 2 and matches the Phase 5 snapshot-diff precedent.
- **Scope 4 is explicitly excluded** (spec §AC): no predictive roster-management recommendations.
- Predictive validation of the metrics is **deferred** (§24) — v1 certifies deterministic
  correctness + mathematical behavior + real-league smoke, not "managers win more".

---

## 30. Integration strategy (spec §AD) — shared evaluative context, NOT wired

`lib/roster-health/` is a **shared evaluative context consumable by future engines but not
wired into any recommendation scoring**. Exposed on the intelligence result as
`roster_health` (like Phase 4 `start_sit_shadow` / Phase 5 `matchup_intelligence`) and as a
league endpoint (`/api/leagues/:slug/roster-health`). **No trade / waiver / lineup / start-sit
recommendation value changes during Phase 6.** A Phase-4/5-style `deployment` state
(`SHARED_CONTEXT` — informational; `PRODUCTION_WIRED` requires explicit later activation).

---

## 31. Lineage / version contract (spec §AE)

```
roster_health_model_version     roster-health-2026.1
team_state_version              team-state-2026.1
replacement_model_version       (weekly frontier + season replacement config identity)
projection_lineage              { weekly: {model_version, source}, ros: {source, ri_model_version} }
league_snapshot_id              from ctx.lineage.snapshot
scoring_fingerprint             from ctx.lineage.snapshot (must match)
generated_at
```
Any `RosterHealthDelta` records **both** snapshots' full lineage; a projection/scoring input
mismatch between the two is surfaced, not silently diffed.

---

## 32. Validation plan (spec §AF)

deterministic unit tests · 25-scenario adversarial matrix · **Team-State structural parity**
(Phase 6 `usable_backup_count == 0` ⟺ Phase 2 `NO_ACTIVE_BACKUP`; `shared_backup_dependency`
⟺ Phase 2 `SINGLE_POINT_OF_FAILURE`) · projection-lineage checks · replacement-level checks ·
FLEX/SUPER_FLEX legality via `maxSlotMatching` · contingency monotonicity invariants (§27) ·
synthetic roster behavior · **real-league smoke on Bloodline + `devoted`** (`REAL` vs
`SYNTHETIC` separate) · performance / provider-read count (must be 0 extra reads) ·
**trade isolation** (`lib/trades/**` unchanged, trade suite passes) · **waiver isolation** ·
**Phase 5 isolation** (`matchup-intelligence` untouched) · **Phase 4 isolation** (`start-sit-fi`
untouched) · **Phase 1C certification** (`cross_surface_discrepancies = 0`) · full repo
regression · `tsc` · lint.

---

## 33. Findings

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| **P6-1** | P2 | An evaluative fragility/depth model **already exists** (`lib/trades/depth.ts` — `fragility_score`, `usable_depth_score`, `replacement_cliff`). | **Freeze it in the trade engine**; Phase 6 generalizes the *concepts* into a shared `lib/roster-health/` layer with a **whole-lineup `maxSlotMatching` contingency** the trade version lacks. No duplication of the tested numbers; the trade engine keeps its own tuned constants. |
| **P6-2** | P2 | No real Bloodline historical rosters (first-year league, 0 played weeks). Predictive validation of the metrics is not possible now. | v1 certifies **deterministic correctness + mathematical behavior + real-league smoke**, not predictive value. `REAL` cross-check = `devoted` chain (~100 team-weeks). Dormant re-eval (`roster-health-2026.2`) once 2026 weeks accumulate. |
| **P6-3** | P2 | `waiver_state` is `null` / `free_agent_pool: NOT_MATERIALIZED` (Phase 1C C-5) at the ROS horizon. | Weekly horizon uses the real league-derived FA pool (`LeagueAvailability.free_agents`, already used by `weeklyVOR`). ROS-horizon FA replacement is **league-theoretical** and flagged `FA_POOL_ROS_APPROXIMATE` — not presented as a live-waiver-market model. |
| **P6-4** | P3 | Bye/schedule facts reliable only ~3 weeks out (Phase 2 `UPCOMING_BYE_LOOKAHEAD`). | Phase 6 exposes current-week + near-term-known bye only; `SCHEDULE_HORIZON_LIMITED` flag; the full ROS-schedule model is the next phase (spec §O). |
| **P6-5** | P3 | ROS projection = external Sleeper prorated; RI season model has a known absolute-level caveat. | RI consumed **ordinally** only (rank/tier/VOR), never numerically ensembled (Phase-1 rule). ROS metrics flagged with their source. |
| **P6-6** | P3 | K/DST produce Phase 2 `NO_ACTIVE_BACKUP` noise. | Excluded from core fragility; DST depth reported separately; rationale documented (spec §R). |

**No P0. No P1.** Nothing blocks a Scope 3 implementation.

---

## 34. Explicit deferrals (`DEFERRED_FEATURES`)

Two-player-loss (combinatorial) contingency · true inactive/injury probabilities · predictive
validation that fragility/bench-utility improve real outcomes (needs 2026 played weeks) · any
roster-management **recommendation** (Scope 4) · repointing `lib/trades/depth.ts` onto the
shared signals · full ROS strength-of-schedule / streaming models · speculative
breakout/upside probabilities for bench players · `roster_health` wired into any recommendation
score.

---

## 35. VERDICT

The evaluative inputs Phase 6 needs already exist and are tested: production weekly + ROS
projections, the shared replacement/VOR framework (with a real league-derived free-agent pool
at the weekly horizon), Phase 2's structural Team-State facts, and the frozen `maxSlotMatching`
primitive. A deterministic fragility/depth model already lives in `lib/trades/depth.ts` —
Phase 6 does **not** duplicate it but generalizes its concepts into a shared `lib/roster-health/`
layer, adding the genuinely missing pieces: a **whole-lineup contingency simulation** (remove
one player → re-run `maxSlotMatching` → Δ legal-lineup value), **player dependency** in four
interpretable forms, **quality surplus** (kept distinct from Phase 2's `structural_surplus`),
**contingency-based bench utility**, **league-relative and position-relative benchmarking**, a
structured **degradation vector**, and a deterministic **snapshot health-delta** contract.
Runtime is a non-issue (< 50 ms for the whole league, 0 extra provider reads). The binding
limitation is **evaluation**: Bloodline is a first-year league with no played weeks, so v1
certifies deterministic correctness + mathematical behavior + real-league smoke — not
predictive value — with a dormant re-eval once 2026 weeks exist, exactly as Phases 4 and 5
were scoped.

Recommended v1: **Scope 3** (starter quality + depth quality + player dependency + fragility/
resilience + quality surplus + snapshot health-deltas), delivered as a **shared evaluative
context** (`roster_health` on the intelligence result + a league endpoint), **not wired into
any recommendation score**, with a `SHARED_CONTEXT` deployment state and no auto-promotion.
`lib/trades/depth.ts` stays frozen; no trade/waiver/lineup/start-sit/matchup recommendation
value changes.

# PHASE 6 — PRE-IMPLEMENTATION AUDIT COMPLETE; SCOPE GATE OPEN

Requesting review/approval of: the **Scope 3** recommendation (§29), the decision to freeze
`lib/trades/depth.ts` and build a *shared* layer rather than repoint it (§3, §33 P6-1), the
whole-lineup `maxSlotMatching` contingency as the core primitive (§7), the two-horizon
(weekly + ROS) split with no blending (§5), `structural_surplus` vs `quality_surplus` kept
distinct (§11), K/DST excluded from core fragility (§18), synthetic-primary math validation
with a `devoted` real cross-check reported separately (§24–§25), and shared-evaluative-context
(not shadow-in-recommendations, not wired) integration (§30). On approval, implementation
proceeds per §20/§32 and ends with one of `PHASE 6 CERTIFIED — SHARED ROSTER-HEALTH CONTEXT` /
`CONDITIONAL — REMEDIATION REQUIRED` / `PHASE 6 NOT CERTIFIED`. **Stopping. No Phase 6
implementation until the scope is reviewed.**

---
---

# PART II — IMPLEMENTATION & VALIDATION (Scope 3, SHARED_CONTEXT)

Branch `team-management-phase6-roster-health`. `roster-health-2026.1`. `lib/trades/depth.ts`
**frozen and unchanged**; no trade / waiver / lineup / start-sit / matchup recommendation
value changed (isolation-tested).

## II.1 What was built

```
lib/roster-health/
  schema.ts       ROSTER_HEALTH_VERSION, HorizonView, PlayerDependency, RosterFragility,
                  PositionHealth, QualitySurplus, BenchUtility, RosterHealthDelta, degradation
  inputs.ts       ONE shared league-wide read: buildCanonicalLeagueState + one weekly
                  projection batch (all rostered) + RI season signal + assembleRosSignals
                  + buildLeagueAvailability + computeWeeklyReplacement. ROS replacement =
                  position-rank-theoretical (always FA_POOL_ROS_APPROXIMATE).
  contingency.ts  bestLegalLineup / contingency / rosterWithout / horizonBatch — reuses the
                  FROZEN buildOptimalLineup (Hungarian max-weight, joint FLEX/SUPER_FLEX);
                  maxSlotMatching is NOT modified.
  evaluate.ts     evaluateHorizon(inputs, roster, teamState, horizon) -> HorizonView
                  (starter quality, per-player dependency, depth quality, quality surplus,
                  bench utility, fragility component vector, degradation)
  benchmark.ts    league- + position-relative percentiles (same league/snapshot/scoring/horizon)
  delta.ts        rosterHealthDelta(before, after) — descriptive typed change list
  build.ts        buildRosterHealthContext(leagueSlug) — orchestrates all 12 teams in ONE
                  runInLeagueStateScope; 0 extra provider reads per manager
app/api/leagues/[leagueSlug]/roster-health/route.ts                      (league surface)
app/api/leagues/[leagueSlug]/managers/[managerSlug]/roster-health/route.ts (manager slice)
```

**Not wired** into `buildWeeklyIntelligence` (per-manager) — roster health is a *shared*
context, derived once at the league level (spec §22, §30). `deployment: "SHARED_CONTEXT"`.

## II.2 Horizons kept strictly separate (spec §5)

`weekly` uses `SleeperWeeklyProjectionProvider` points + the real league-derived free-agent
replacement (`computeWeeklyReplacement`). `rest_of_season` uses external season points
prorated (`assembleRosSignals`, RI ordinal only) + a **position-rank-theoretical** replacement
line. Every `HorizonView` carries its horizon; **nothing is averaged across horizons**. Every
ROS view carries `FA_POOL_ROS_APPROXIMATE` in its degradation vector (invariant-tested).

## II.3 Contingency primitive (spec §3, §7)

`contingency(removedId)` = `baseline.optimal_total − buildOptimalLineup(roster − removedId).optimal_total`,
using the frozen optimizer for both horizons (ROS via a synthesized batch). FLEX / SUPER_FLEX
/ multi-position eligibility are resolved jointly — a versatile backup is matched to at most
one slot (invariant test: "SUPER_FLEX QB2 backs both QB and SUPER_FLEX but is not counted
twice"). One-player-loss only; two-player is deferred (spec §7).

## II.4 Player dependency — four interpretable forms (spec §8), no opaque score

`raw_point_loss` · `pct_lineup_loss` · `replacement_gap` · `league_percentile` (+ `position_percentile`).
`single_point_of_failure` = starter, 0 remaining usable backups, positive loss — **K/DST
excluded** (spec §14, §18). Live (`bloodline-bowl/supyo29`): Trevor Lawrence unavailable →
best-legal-lineup value falls **14.4 pts (12.7%)**, league dependency percentile 96, SPOF (no
QB backup). Trey McBride 12.2 pts (10.8%), percentile 95, SPOF.

## II.5 Roster fragility — component vector (spec §9)

`worst_starter_dependency` · `expected_one_loss_damage` · `top3_weighted_dependency` ·
`tail_dependency_p90` · `single_points_of_failure[]` · `min_slot_value_retained_after_any_one_loss`.
Derived label `profile ∈ {RESILIENT, CONCENTRATED_FRAGILITY, DISTRIBUTED_FRAGILITY,
FRAGILE_BOTH}` — components always retained. `CONCENTRATED` (one catastrophic SPOF, otherwise
moderate) and `DISTRIBUTED` (broadly thin, no single catastrophe) are distinct, as the spec
requires. K/DST are excluded from the fragility components (invariant-tested).

## II.6 Depth quality (spec §10) & quality surplus (spec §11)

`PositionHealth` per slot key: `starter_quality_vor` (Σ VOR of the best `required` legal
starters), `best_backup_vor`, `second_backup_vor`, `replacement_cliff`, `usable_backup_count`
(≥ replacement line), `nominal_backup_count`, `depth_quality_grade ∈ {STRONG, ADEQUATE, THIN,
BARE}`. **`quality_surplus` ≠ Phase 2 `structural_surplus`** — the Phase 2 fact is echoed as
`team_state_structural_surplus` and never overwritten; `quality_surplus` requires bench
players a position-relative threshold above replacement (invariant test: five
replacement-level RBs → `team_state_structural_surplus: true`, `quality_surplus: false`,
grade ≠ STRONG).

## II.7 Bench utility (spec §12) & multi-slot (spec §13)

Deterministic contingency usefulness only — `starter_replacement_value` (max damage this
bench player prevents, computed as the difference in a starter's contingency loss with vs
without this bench player), `multi_slot_coverage` (# slot families where he is the best usable
backup — cannot be simultaneously available to all), `bye_coverage_slots`, `bench_utility_grade
∈ {HIGH, MODERATE, LOW, DEAD_WEIGHT}`. **No breakout/upside probabilities.**

## II.8 League- & position-relative benchmarking (spec §16, §17)

Percentiles computed only across the 12 teams of the same league / snapshot / scoring /
horizon. `starter_quality_pct`, `depth_quality_pct`, `fragility_pct` (inverted — higher =
healthier), `bench_utility_pct`, `worst_dependency_pct`; per-player `league_percentile` +
`position_percentile`. Raw values always retained. No cross-league percentiles.

## II.9 Snapshot health-delta (spec §19, §20)

`rosterHealthDelta(before, after)` — a typed change list (`FRAGILITY_INCREASED`,
`DEPTH_QUALITY_IMPROVED`, `NEW_SINGLE_POINT_OF_FAILURE`, `QUALITY_SURPLUS_GAINED`,
`CONCENTRATION_INCREASED`, …) + a **purely descriptive** summary. Carries both snapshots'
lineage; a projection/scoring-model mismatch → `comparison_degradation: ["LINEAGE_MISMATCH"]`,
the diff still emitted, flagged. Invariant test: identical states → 0 changes.

## II.10 Degradation (spec §22, §27)

Structured `RosterHealthDegradation` — `reasons[]` + `overall ∈ {OK, PARTIAL, DEGRADED,
INSUFFICIENT}`. `MISSING_WEEKLY_PROJECTION` / `MISSING_ROS_PROJECTION` / `FA_POOL_ROS_APPROXIMATE`
/ `CONTINGENCY_PROVISIONAL` (an UNKNOWN starter) / `SCHEDULE_LIMITED` / `VACANT_TEAM` / … A
metric computed on a degraded input is emitted flagged, never as clean certainty
(invariant-tested).

## II.11 Runtime (spec §28, §30) — measured

| stage | ms |
| --- | ---: |
| shared reads (canonical state + weekly projections + RI + schedule + Team-State) | ~2,250 (the same reads the weekly engine already performs) |
| **per-team roster-health compute (12 teams × 2 horizons)** | **82 ms** (6.8 ms/team) |
| **extra provider reads for per-manager calcs** | **0** |

82 ms is slightly above the 50 ms target; per spec §30 this is retained (no material live
impact — the endpoint is `Cache-Control: 30/120`, and the compute is pure in-memory over one
shared batch). Determinism verified (same snapshot + same models → byte-identical output).

## II.12 Invariants + adversarial (spec §28, §29) — 16 / 16 pass

`test/roster-health.test.ts`:
- higher-quality replacement → lower dependency loss
- stronger legal backup → fragility not higher
- adding a replacement-level bench player → no large quality-surplus gain
- five replacement-level RBs → not STRONG depth; `structural_surplus` echoed, `quality_surplus` false
- elite RB + no backup → high dependency + `single_point_of_failure`
- K without backup → not a SPOF, not in fragility components
- SUPER_FLEX QB2 → real contingency loss, not double-counted
- ROS horizon → always `FA_POOL_ROS_APPROXIMATE`
- missing projection → degraded, not fabricated certainty
- `rosterWithout` clears the starting slot; determinism
- delta: identical states → 0 changes
- isolation: `lib/trades/**` never imports `roster-health`; `roster-health/**` never imports a
  recommendation engine; `buildOptimalLineup` / `maxSlotMatching` / `lineup.ts` unchanged

`REAL_HISTORICAL_ROSTERS`: not available (Bloodline first-year, 0 played weeks). `SYNTHETIC_ROSTERS`:
the 16 fixture-based tests above + the live smoke on Bloodline (12 teams). **No predictive
claim is made** — v1 certifies deterministic correctness + mathematical behavior + real-league
smoke (spec §24, §25).

## II.13 Regression (spec §32, §34)

`tsc` clean · `eslint app lib test` 0 errors, 29 warnings (**0 new**) · `npm test`
**1535 pass / 0 fail / 4 skipped** (+16 roster-health; 0 existing tests changed) ·
Phase 1C cross-surface certification **`cross_surface_discrepancies = 0`** · Phase 2 Team-State
+ weekly + **trade** + waiver + Phase 4 start-sit-fi + Phase 5 matchup-intelligence suites all
pass unchanged · **production recommendation behavior change = 0** (`lib/trades/depth.ts`
byte-identical; no `buildOptimalLineup` / `maxSlotMatching` change; no new canonical/slot
normalizer).

## II.14 Findings (Part II)

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| P6-1 (audit) | P2 | evaluative fragility model already in `lib/trades/depth.ts` | **RESOLVED** — frozen; `lib/roster-health/` generalizes the concepts + adds the whole-lineup `maxSlotMatching` contingency, four-form dependency, `quality_surplus`, deltas. Isolation-tested. |
| P6-2 (audit) | P2 | no real historical Bloodline rosters | **DOCUMENTED** — v1 certifies determinism + math + smoke, not predictive value. Dormant re-eval `roster-health-2026.2` once 2026 weeks + `devoted` reconstruction exist (spec §25). |
| P6-3 (audit) | P2 | ROS FA pool not materializable | **RESOLVED** — ROS replacement is position-rank-theoretical, **always** `FA_POOL_ROS_APPROXIMATE` (programmatic, invariant-tested). Weekly uses the real league FA pool. |
| P6-7 | P3 | per-team compute 82 ms vs 50 ms target | Retained per spec §30 (no material live impact; cached endpoint; 0 extra provider reads). Memoizing repeated `buildOptimalLineup` solves is a future optimization if needed. |
| P6-8 | P3 | `single_point_of_failure` initially flagged the only K | **FIXED** during implementation — K/DST excluded from the SPOF flag and the fragility components (spec §14, §18). |

No P0. No P1.

## II.15 Deferred (`DEFERRED_FEATURES`)

Two-player-loss contingency · true inactive/injury probabilities · predictive validation
(needs 2026 played weeks) · repointing `lib/trades/depth.ts` onto the shared signals · full ROS
strength-of-schedule / streaming models · bench breakout/upside probabilities · `roster_health`
wired into any recommendation score · `PRODUCTION_WIRED` deployment (requires explicit later
activation).

---

## II.16 Freeze criteria (spec §34) — check

1 whole-lineup contingencies legal + deterministic ✓ · 2 dependency behaves monotonically ✓
(invariant) · 3 depth quality distinguishes count from quality ✓ (invariant) · 4 structural
vs quality surplus separate ✓ · 5 K/DST do not distort core health ✓ (invariant) · 6
weekly/ROS never blend ✓ · 7 ROS approximation explicitly degraded ✓ (invariant) · 8
benchmarks same-league/same-horizon ✓ · 9 health deltas factual not prescriptive ✓ · 10
trade/waiver/lineup/start-sit/matchup recommendation behavior change = 0 ✓ · 11 no alternate
canonical/slot normalizer ✓ (reuses frozen `buildOptimalLineup` + `maxSlotMatching`) · 12
provider reads bounded/shared ✓ (0 extra per manager) · 13 Phase 1C certification green ✓ ·
14 P0/P1 resolved ✓.

## II.17 VERDICT

`lib/roster-health/` derives evaluative roster quality / fragility / depth / player-dependency
/ quality-surplus / snapshot-deltas from Phase 2 Team-State facts + production projections +
the existing replacement framework + the frozen `buildOptimalLineup`, with weekly and
rest-of-season horizons kept strictly separate, the ROS replacement approximation always
programmatically flagged, K/DST excluded from core fragility, `quality_surplus` kept distinct
from Phase 2's `structural_surplus`, league- and position-relative benchmarking across the 12
teams of one snapshot, a structured degradation vector, and a deterministic descriptive
snapshot health-delta. It is a **shared evaluative context** (`SHARED_CONTEXT`, no
auto-promotion) exposed on two additive endpoints and consumed by nothing. `lib/trades/depth.ts`
is frozen; **no production recommendation value changes** (regression-verified). Per-manager
compute is 0 extra provider reads and ~7 ms; determinism and all 16 invariant/adversarial/
isolation tests pass. Predictive validation is deferred (Bloodline has no played weeks) —
v1 certifies deterministic correctness + mathematical behavior + real-league smoke, exactly
as scoped.

# PHASE 6 CERTIFIED — SHARED ROSTER-HEALTH CONTEXT FREEZE

Do not begin Phase 7.
