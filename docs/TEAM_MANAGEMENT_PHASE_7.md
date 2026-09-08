# Team Management — Phase 7: Schedule & Forward Planning Intelligence

**Status: PRE-IMPLEMENTATION AUDIT. Verdict at §35. NO substantive implementation.**

Branch `team-management-phase7-schedule-planning` (off the Phase 6 stack). Phases 3–6 remain
stacked and unmerged — not restructured. Phase 6 (`lib/roster-health/`, `SHARED_CONTEXT`) is
frozen and unchanged; production recommendation behavior unchanged.

---

## 1. Objective

Answer *"what predictable future schedule, bye, roster-availability, and opponent-context
issues are approaching, and how exposed is this roster to them?"* — **forward-looking facts +
evaluative planning context**. It does **not** recommend a trade / drop / add / stream / waiver
claim (future Orchestrator / domain engines).

Allowed Phase 7 output: *"Week 7 projects an uncovered RB/FLEX slot because RB1 and RB3 share
a bye and no remaining active player can legally fill it."*
Not allowed: *"Add Player X before Week 7."*

---

## 2. Existing schedule / bye / ROS ownership audit

| System | File | Kind |
| --- | --- | --- |
| **`SleeperScheduleProvider`** — `GET /schedule/nfl/regular/{season}` → **every regular-season game** (`week, home, away, date, status`); caches the **whole season** on first fetch; `getWeekSchedule(s, w)` derives `teams_on_bye` by 32-club set-difference **only when the week's feed is structurally intact** | `lib/weekly/schedule/sleeper-schedule.ts` | canonical schedule fact |
| **`loadScheduleBundle(season, week)`** — currently fetches `getWeekSchedule` for `[week, week+3]` (`UPCOMING_BYE_LOOKAHEAD = 3`) → `byeTeamsByWeek: Map<week, Set<abbr>>` + current-week `opponentByTeam` | `lib/team-state/build.ts` | Team-State input |
| **`TeamStateScheduleFacts`** (`teams_on_bye_this_week`, `opponent_by_player`, `starters_on_bye`, `status`) | `lib/team-state/schema.ts` | Team-State structural fact |
| **`SHARED_BYE_WEEK`** flag (2+ active players at one slot key share a bye — within the 3-week bundle), `CURRENT_WEEK_BYE_GAP`, `IR_DEPTH_REDUCTION` | `lib/team-state/flags.ts` | Team-State structural fact |
| **`league.playoff`** (`playoff_team_count`, `playoff_start_week`, `championship_week`) from Sleeper `settings.playoff_week_start` / `playoff_teams` | `lib/canonical/schema.ts`, `lib/providers/sleeper/canonical.ts` | canonical league fact |
| **`assembleRosSignals`** — external season points prorated by remaining weeks (`weeksLeftFrac`) + RI ordinal; sets `wp.ros.points` | `lib/weekly/ros.ts` | projection assembly |
| **`lib/trades/ros.ts`** — `RosRosterValue`: per remaining fantasy week runs **`buildOptimalLineup`** with schedule-verified byes (bye → 0), `weekly_totals: [{week, total, empty_slots}]`, `bye_hole_slot_weeks` / `bye_hole_weeks`, `regular_season_usable` vs `playoff_window_usable` split, `stranded_ros_points`, `uncovered_player_ids` (no ROS signal → excluded, never zeroed) | `lib/trades/ros.ts` | **trade-specific ROS logic** |
| `RosScheduleContext` (`playoff_window_available`, `playoff_start_week`), `RosParticipantResult` (`playoff_window_delta`) | `lib/trades/context.ts` | trade ROS |
| **Phase 6 `bye_exposure`** (`current_week_starters_on_bye`, `near_term_shared_bye_weeks` — from the 3-week `SHARED_BYE_WEEK` flags), `RosterHealthInputs` shared read, `evaluateHorizon(..., "rest_of_season")` | `lib/roster-health/*` | roster-health evaluation |
| **Phase 5 Matchup Intelligence** — calibrated opponent score distributions + `dependence_diagnostics`, `ctx.league.week`-bound (current week only) | `lib/weekly/matchup-intelligence/*` | future opponent context (SHADOW) |
| **Phase 3 Football Intelligence** — `team()` offense/defense ratings with `predictive_status`; `fi:2025:w18` (prior-season) | `lib/football-intel/*` | descriptive opponent profile |
| **K/DST weekly** — Sleeper feed omits K XP + DST sacks/PA → both fall back to `pts_std` (LOW/MEDIUM); no schedule-strength model | `lib/weekly/projections/sleeper-weekly.ts` | K/DST-specific |
| Projection schedule inputs — the Sleeper weekly feed already carries each player's `opponent` for **that week** | `lib/weekly/projections/sleeper-weekly.ts` | projection input |

**Headline:** `lib/trades/ros.ts` **already builds a per-future-week legal-lineup timeline**
(`weekly_totals`, `bye_hole_slot_weeks`, playoff window split) — it is **trade-scoped**.
The Sleeper schedule provider **already holds the entire regular-season schedule** in memory
(opponent identity + byes for all 18 weeks); the `UPCOMING_BYE_LOOKAHEAD = 3` in Team-State is
**deliberate conservatism, not a data limit**.

---

## 3. Layer ownership matrix

| Concept | Owner after Phase 7 |
| --- | --- |
| the NFL schedule (games, opponents, byes, dates) | **canonical** (`SleeperScheduleProvider`, unchanged) — Phase 7 consumes the full season, not just 3 weeks |
| the fantasy matchup schedule + playoff config | **canonical** (`league.playoff`, `snap.matchups`, unchanged) |
| current-week structural bye facts | **Phase 2 Team-State** (unchanged) |
| current-week roster-health (weekly + ROS) | **Phase 6** (frozen) — Phase 7 *invokes* `evaluateHorizon` with future-week bye assumptions, lineage explicit |
| ROS trade valuation (`RosRosterValue`, `playoff_window_delta`) | **FROZEN in the trade engine** (spec §AE) — repointing changes trade numbers |
| **per-future-week legal-lineup coverage, bye-loss estimate, future roster-health pressure, schedule-context vector, playoff planning vector, planning-delta** | **NEW — `lib/schedule-planning/`** |
| what to do about future pressure | **future Orchestrator** (not Phase 7) |

**No existing tested schedule metric is duplicated under a new name.** `bye_hole_slot_weeks`
(trade ROS) and Phase 7's `uncovered_slot_weeks` share the same underlying primitive
(`buildOptimalLineup` per week with byes) but the trade version keeps its own tuned window
semantics.

---

## 4. NFL schedule reliability (spec §C)

Probed live: `GET /schedule/nfl/regular/2026` → **273 games, all 18 weeks**, every game has
`{week, home, away, date, status}` (`status: "pre_game"` for 272, 1 `canceled`). Byes derivable
per week (weeks 5–14 have 2–6 byes; weeks 1–4, 15–18 have none).

| field | reliability | Phase 7 label |
| --- | --- | --- |
| **opponent identity** (home/away teams) | **known for the entire regular season** as soon as the schedule is released (≈ May) | `SCHEDULE_KNOWN` |
| **bye weeks** | **known for the entire season** (set-difference on a structurally-intact week) | `SCHEDULE_KNOWN` |
| **game date** | known (calendar day) | `SCHEDULE_KNOWN` |
| **kickoff time** | fixed for weeks ~1–5; **flex-scheduled** for many Sun/Mon games from ~week 5 onward → tentative until ~6 days prior | `GAME_TIME_TENTATIVE` (matters only for a late-swap model, deferred) |
| fantasy playoffs / international games | schedule is the same feed; no special handling needed | — |

**The 3-week horizon does NOT apply to opponent identity or byes** (spec §C) — those are
full-season facts. It applies only to *game-time* precision (irrelevant to bye/coverage
planning) and, more importantly, to **projection reliability** (§8), which is the real horizon
constraint.

---

## 5. Fantasy schedule reliability (spec §D)

`snap.matchups` is canonical for the **current week only** (the only week whose roster/ownership
state is consistent). Future fantasy matchup pairings are **not** in the canonical snapshot —
Sleeper's `/matchups/{week}` for a future week returns roster_ids but the pairing can change
with tie-breakers / division scheduling until the week arrives. `league.playoff`
(`playoff_start_week`, `playoff_team_count`, `championship_week`) **is** canonical when Sleeper
provides it (Bloodline: to be confirmed at implementation — some leagues leave it null).

**v1 scope:** Phase 7 plans **roster exposure per NFL week**, not per fantasy-matchup opponent
(the fantasy opponent for Week 8 is not reliably known). Playoff-*week* identification uses
`league.playoff`; playoff-*opponent* is deferred. Consolation / reseeding / two-week rounds →
`PLAYOFF_CONFIG_UNAVAILABLE` / `PLAYOFF_FORMAT_UNMODELED` degradation where the config is thin.

---

## 6. Bye-week intelligence proposal (spec §E)

Per future NFL week `W` in the horizon:
```
active roster (current membership, unchanged)
  minus players whose NFL team is on a bye in W   (schedule-verified)
        ↓
buildOptimalLineup(roster_W, constraints, projections_W)   [FROZEN optimizer]
        ↓
bye_loss(W) = value(no-bye best legal lineup with W's projections)
              − value(bye-adjusted best legal lineup)
uncovered_slots(W) = starting slots the bye-adjusted lineup could not legally fill
```
Outputs per week: `starters_on_bye[]`, `bye_loss_points`, `uncovered_slot_labels[]`,
`shared_bye_collisions` (2+ at one slot key), `cross_position_flex_collision`,
`team_wide_bye_concentration` (Σ bye_loss over a rolling window). **Never a raw count** — every
number is a legal-lineup delta (spec §E).

---

## 7. Future legal-lineup feasibility (spec §F, §R) — feasible

`buildOptimalLineup` per future week with: **current roster held constant** (spec §F — "if you
make no moves, Week 8 looks like this"), schedule-verified byes, the week's projections (§8),
known season-long injuries only (`OUT`/`IR` that persist), FLEX/SUPER_FLEX/W-R-T resolved
jointly by the frozen `maxSlotMatching`. **No future injury projection** (spec §F). **No
hypothetical adds/drops** unless an explicit snapshot comparison (§21). Multi-position backups
counted once per week (spec §R). This is the same primitive `lib/trades/ros.ts` already runs
per week and Phase 6's `contingency.ts` uses — proven, cheap.

---

## 8. Projection-horizon audit (spec §G) — THE binding constraint

| horizon | projection source | reliability |
| --- | --- | --- |
| **W = current week** | `SleeperWeeklyProjectionProvider` weekly points | genuine weekly projections |
| **W = current+1 .. current+2** | **no true weekly projection exists yet** — the Sleeper feed only has the current week | must use **prorated ROS** (`ros.points / ros_games_remaining` per playing week) — a *mean*, not a matchup-specific weekly number |
| **W = current+3 .. ROS** | prorated ROS | as above; confidence decays |
| **fantasy playoffs** | prorated ROS + descriptive schedule context | ROS-context only |

**There is exactly ONE future weekly projection (the current week).** Everything beyond is
`ROS_PROJECTION` — the same per-playing-week mean `lib/trades/ros.ts` uses. Phase 7 must:
- label every forward metric `WEEKLY_PROJECTION` (W only) vs `ROS_PROJECTION` (W+1 onward)
- **never interpolate a weekly number across future weeks**
- decay confidence: `HIGH` for W and the bye/coverage *structure* of any week (structure is
  schedule-driven, not projection-driven); `MEDIUM` for W+1..W+3 *value* estimates;
  `ROS_CONTEXT_ONLY` for farther-week *value*
- carry `projection_lineage` (weekly model_version + ros source + RI model_version) on every
  metric (Phase-1 rule).

**Bye-exposure and uncovered-slot STRUCTURE is HIGH confidence for the whole season** (it's
schedule math); only the *point value* of the loss decays with the projection horizon.

---

## 9. Schedule-strength definition (spec §H, §J) — transparent weekly vectors, not one SOS number

Phase 3/4 lesson: football-context sophistication does not automatically improve fantasy
projections; the production ROS projection already prices opponent strength into the mean.
Phase 7 therefore:
- does **NOT** compute a "defense ranks 27th vs RB" number and does **NOT** alter any projection
- exposes a **per-week descriptive schedule-context vector** per starter / slot:
  `{ week, opponent, home_away, implied_team_total (from schedules `total_line`/`spread_line`),
    game_environment (dome/outdoor/wind), fi_opponent_profile (Phase 3 descriptive,
    predictive_status-gated), context_label ∈ {favorable|neutral|difficult|bye|unknown} }`
- the `context_label` is derived from **inputs the production projection may NOT already
  price** (game total, dome/weather) + the Phase 3 `def_success_allowed` **percentile only**
  (the one FI defensive metric that validated in Phase 3), never a points delta
- a season-long roster `schedule_pressure_timeline` = the per-week `projected_lineup_value`
  vector (§10), which is more useful than `SOS = 72` (spec §J):
  ```
  Week 6: 118 (favorable)   Week 7: 109 (bye exposure -6)   Week 8: 114 (neutral)   ...
  ```

**No opaque SOS score.** If a single summary is emitted it is a labelled component
(`mean_projected_lineup_value_next_6`), with the vector always retained.

---

## 10. Football Intelligence boundary (spec §I)

Phase 3 routing contract preserved **programmatically**. Phase 7 may consume FI **only as
descriptive future-opponent context** (opponent offense/defense profile, pressure/pace
tendencies, trend) — `NOT_PREDICTIVE` / `DESCRIPTIVE_ONLY` fields are labelled context, never a
number. **FI does not adjust any projection** (Phase 4 showed no incremental mean value; Phase
5 showed no incremental variance value). If a future Phase 7 revision proposes an FI-driven
schedule adjustment it requires **new target-specific validation** (spec §I). The live FI
snapshot is `fi:2025:w18` (prior season) → `FI_PRIOR_ONLY` degradation on every FI-derived
context field.

---

## 11. Future roster-health integration (spec §K) — reuse frozen Phase 6

```
current LeagueManagementContext + RosterHealthInputs   (Phase 6 shared read — 0 extra reads)
        ↓  for each future week W:
   projections_W  = prorated ROS batch (horizonBatch)
   byes_W         = schedule-verified bye set for W
   evaluateHorizon(inputs_W, roster, teamState, "rest_of_season")   [Phase 6, UNCHANGED]
        ↓
future_week_health[W] = { fragility_profile, worst_dependency, uncovered_slots,
                          depth_quality deterioration vs baseline, quality_surplus lost }
```

Phase 6's `evaluateHorizon` is **pure** given `(inputs, roster, teamState, horizon)` — Phase 7
constructs a per-week `RosterHealthInputs` variant (same weekly batch, ROS-prorated points, the
week's bye set injected so bye players drop out of the legal lineup) and calls it unchanged.
Lineage records `roster_health_version` + the future-week horizon. **Phase 6's frozen model is
never altered** (spec §K).

---

## 12. Week-level planning schema (spec §L)

`lib/schedule-planning/schema.ts` — `PLANNING_MODEL_VERSION = "schedule-planning-2026.1"`.
Per team, per horizon:
```ts
week_timeline: Array<{
  week: number;
  is_current: boolean;
  is_playoff_week: boolean;
  projection_basis: "WEEKLY_PROJECTION" | "ROS_PROJECTION";
  confidence: "HIGH" | "MEDIUM" | "ROS_CONTEXT_ONLY";
  starters_on_bye: string[];
  uncovered_slot_labels: string[];
  bye_loss_points: number | null;
  projected_lineup_value: number | null;
  future_roster_health: { fragility_profile: string; worst_dependency: number | null; single_points_of_failure: string[] } | null;
  schedule_context: Array<{ slot_key: string; opponent: string | null; context_label: string; evidence: Record<string, number|string|null> }>;
  degradation: PlanningDegradation;
}>;
summary: {
  next_bye_week: number | null;
  worst_bye_week: { week: number; bye_loss_points: number | null } | null;
  bye_concentration_window: { start_week: number; end_week: number; total_bye_loss: number } | null;
  weeks_with_uncovered_slots: number[];
  playoff_weeks: number[];
  playoff_exposure: { fragility_profile: string; thin_positions: string[] } | null;
};
```
Not blindly this shape — repo conventions at implementation. Every evaluative field carries
its supporting facts (spec §L, §26 explainability).

---

## 13. Planning-horizon proposal (spec §M) — derived from §8, not arbitrary

| window | weeks | what is certified | confidence |
| --- | --- | --- | --- |
| **near-term** | current .. current+3 | bye/coverage **structure** + value estimates | HIGH (structure) / MEDIUM (value) |
| **medium-term** | current+4 .. current+6 | bye/coverage structure; value = ROS mean | HIGH (structure) / MEDIUM–DEGRADED (value) |
| **ROS** | current+7 .. last regular week | structure + ROS-context vectors | HIGH (structure) / `ROS_CONTEXT_ONLY` (value) |
| **playoffs** | `playoff_start_week` .. `championship_week` | which weeks; roster exposure structure | HIGH (weeks) / `ROS_CONTEXT_ONLY` (value); `PLAYOFF_CONFIG_UNAVAILABLE` if config null |

**The bye/coverage structure is computed for the FULL remaining season** (it is schedule math
and cheap); only the *value* estimates degrade. This is the honest split — a Week-12 bye
collision is a known fact today even though the Week-12 point loss is a rough estimate.

---

## 14. Playoff configuration audit (spec §N)

Canonical `league.playoff`: `playoff_start_week` = Sleeper `settings.playoff_week_start`;
`playoff_team_count` = `settings.playoff_teams`; `championship_week` = derived
(`playoff_week_start + 2` or `+3` by `playoff_round_type`). **Bloodline's exact values to be
read at implementation** — if `playoff_week_start` is null → `PLAYOFF_CONFIG_UNAVAILABLE`,
Phase 7 falls back to **no playoff view** (never a hard-coded "weeks 15–17"). Reseeding /
two-week rounds / consolation / bye seeds are **not modeled in v1** → `PLAYOFF_FORMAT_UNMODELED`.
Week 18 exclusion is respected (`settings.playoff_week_start` and regular-season length come
from canonical, not assumed).

---

## 15. Player playoff-context proposal (spec §O) — vectors, not rankings

For playoff weeks, per starter: `{ week, opponent, home_away, projection_basis: "ROS_PROJECTION",
schedule_context_label, roster_dependency_at_that_week }`. **No premature playoff rankings, no
"start him in the playoffs" ordering.** The vectors are an Orchestrator extension point (§32).

---

## 16. K / DST streaming boundary (spec §P)

Phase 7 exposes, per future week for the currently-rostered K and DST:
`{ week, opponent, is_bye, implied_team_total (K), opponent_offense_profile (DST, FI descriptive),
context_label }`. **No streaming recommendation, no "drop this DST".** K/DST future bye is a
coverage fact (a rostered K on bye with no backup K → `uncovered_slot: K` that week, but per
Phase 6 §18 K/DST are **excluded from the core fragility score** — the fact is surfaced, the
severity is not inflated). The K/DST engines may consume these vectors later.

---

## 17. Free-agent-pool dependency (spec §Q)

| Phase 7 output | needs FA pool? |
| --- | --- |
| bye exposure, uncovered slots, future legal-lineup coverage, future roster-health, schedule-context vectors, planning deltas | **NO — computed entirely from the current roster** |
| "could a free agent cover the Week 7 hole?" | **YES** — deferred; `FA_POOL_UNAVAILABLE` if attempted |

The weekly-horizon FA pool (`LeagueAvailability.free_agents`, Phase 6 §6) exists for the
current week, but future-week FA availability + future FA projections are not reliable → Phase
7 v1 is **roster-held planning only** (spec §Q). It never uses theoretical replacement as an
"available player".

---

## 18. Future slot coverage (spec §R)

Joint matching via the frozen `maxSlotMatching` / `buildOptimalLineup` for every future week —
FLEX, SUPER_FLEX, W/R/T, multi-position eligibility, bye collisions, one-backup-covers-several,
IR players (excluded from active), open roster slots (fewer bodies), K/DST. **Never independent
position counts** (spec §R). Identical to Phase 6's contingency machinery.

---

## 19. Player-team-change handling (spec §S)

The Sleeper schedule feed keys on **NFL team abbreviation**; the canonical player carries
`nfl_team`. If a player's `nfl_team` changes between snapshots, the schedule join produces a
**different opponent vector and different bye week** on the next `buildRosterHealthInputs` /
schedule read — Phase 7 is recomputed from the latest snapshot every run (§20). A planning
delta (§21) across a snapshot where a player changed teams carries `PLAYER_TEAM_UNCERTAIN` /
`LINEAGE_MISMATCH`. **No stale player-opponent schedule survives a team change** — the join is
always fresh, never cached across snapshots.

---

## 20. Week-advance behavior (spec §T)

Phase 7 is **stateless and recomputable** from the latest `CanonicalLeagueSnapshot`. A new NFL
week → a new snapshot → a new planning artifact with a new `league_snapshot_id` in its lineage.
**Historical Phase 7 outputs are never mutated.** No persisted planning state; the endpoint
computes fresh (cached 30–120 s like Phase 6).

---

## 21. Planning-delta feasibility (spec §U) — deterministic, descriptive

`planningDelta(before, after)` — run the deterministic model on two snapshots, diff the
`week_timeline` + `summary`. Typed changes: `WEEK_N_COVERAGE_IMPROVED`,
`WEEK_N_COVERAGE_WORSENED`, `NEW_UNCOVERED_SLOT_WEEK`, `BYE_COLLISION_REMOVED`,
`BYE_COLLISION_ADDED`, `PLAYOFF_FRAGILITY_WORSENED`, `ROS_PROJECTED_LINEUP_IMPROVED`,
`BYE_CONCENTRATION_SHIFTED`. **Descriptive summary only** — never "this move was good" (spec
§U). Both snapshots' full lineage recorded; a projection/schedule-version mismatch →
`comparison_degradation`.

---

## 22. Lineage / version contract (spec §V)

```
planning_model_version        schedule-planning-2026.1
team_state_version            team-state-2026.1
roster_health_version         roster-health-2026.1
weekly_projection_lineage     { model_version, source }
ros_projection_lineage        { source, ri_model_version }
nfl_schedule_source           "sleeper_schedule" + fetch timestamp
football_intelligence_version fi:<...> | "not_used" (descriptive-only where used)
league_snapshot_id
scoring_fingerprint
planning_horizon              { near_term_weeks, medium_weeks, ros_last_week, playoff_weeks }
playoff_config_identity        { playoff_start_week, playoff_team_count, championship_week } | "unavailable"
```

---

## 23. Confidence / degradation model (spec §W)

Structured, Phase-4/5/6 pattern. `PlanningDegradation.reasons[]` +
`overall ∈ {OK, PARTIAL, DEGRADED, INSUFFICIENT}`:
`FUTURE_WEEKLY_PROJECTION_UNAVAILABLE` (always, for W+1 onward) · `ROS_PROJECTION_USED` ·
`GAME_TIME_TENTATIVE` (flex weeks — informational) · `OPPONENT_UNKNOWN` (never, for NFL
opponent; used for fantasy opponent) · `FA_POOL_UNAVAILABLE` · `ROSTER_ASSUMED_STATIC` (always) ·
`PLAYER_TEAM_UNCERTAIN` · `PLAYOFF_CONFIG_UNAVAILABLE` · `PLAYOFF_FORMAT_UNMODELED` ·
`FI_PRIOR_ONLY` · `PROJECTION_HORIZON_MISMATCH` · `SCHEDULE_WEEK_INCOMPLETE` (a week whose feed
failed the structural-intactness check → byes not asserted for that week).
**Week-14 planning never carries the same apparent certainty as Week-2** (spec §W) — the
per-week `confidence` field degrades and `ROS_PROJECTION_USED` is attached from W+1.

---

## 24. Historical evaluation feasibility (spec §X)

| question | testable? |
| --- | --- |
| did identified bye-risk weeks produce larger realized lineup-value losses / uncovered lineups? | **on the `devoted` chain** (~12 teams × 1 prior season of `/matchups` `starters` + points + the historical NFL schedule) — a real cross-check, not certification |
| did projected schedule difficulty correspond to realized fantasy scoring? | **Phase 3/5 already answered a version of this** — team-level opponent-strength has weak predictive value at a multi-week horizon; Phase 7 does not re-litigate it |
| **Bloodline** | **0 played weeks** (2026 season not started) → no real planning history |

`REAL_HISTORICAL_PLANNING` = `devoted` chain only. `SYNTHETIC_PLANNING` = the invariant/
adversarial fixtures. **No overclaim** (spec §X) — v1 certifies deterministic correctness +
schedule/bye math + horizon separation + real-league smoke, not predictive value. Dormant
re-eval `schedule-planning-2026.2` once 2026 weeks accumulate (Phase 4/5/6 pattern).

---

## 25. Synthetic evaluation limitations (spec §Y)

`SYNTHETIC_PLANNING` verifies bye-collision math, joint slot matching, horizon separation,
schedule progression, playoff-week identification, and the invariants (§27). It **cannot**
prove managers benefit strategically. `REAL` vs `SYNTHETIC` reported separately, never merged.

---

## 26. Adversarial matrix (spec §Z) — 25 scenarios, all must pass before certification

1 no byes next 6 weeks (bye-loss = 0) · 2 one starter on bye · 3 two RB starters same bye · 4
QB + SUPER_FLEX QB same bye · 5 WR/FLEX collision · 6 one versatile backup / multiple theoretical
needs · 7 IR player with a future bye · 8 player changes NFL team (opponent vector updates) · 9
roster changes midweek · 10 fantasy opponent changes (not modeled — flagged) · 11 game time TBD
(informational) · 12 playoff schedule present · 13 playoff config absent (no playoff view) · 14
1-QB league · 15 SUPER_FLEX league · 16 K bye (uncovered K slot, not core fragility) · 17 DST
bye · 18 no weekly projection beyond Week N (ROS from N+1, flagged) · 19 ROS available, weekly
unavailable · 20 missing player projection (excluded, not zeroed) · 21 unresolved identity · 22
league in fantasy playoffs (current week ≥ playoff_start_week) · 23 Week-18-excluded league · 24
current roster has an open slot · 25 identical roster, different bye clustering → different
`bye_concentration_window`, same total bye-loss.

---

## 27. Invariants (spec §AA) — defined pre-implementation

- adding a legal high-quality backup → future lineup coverage **not** worse
- removing a bye collision → `bye_loss` **not** higher
- same roster + same schedule + same projections + same model version → **byte-identical** output
- player changes NFL team → future opponent vector **updates** (no stale join)
- no future weekly projection → degraded horizon + `ROS_PROJECTION_USED`, **not** invented value
- ROS projection used → **explicitly labelled** on the metric
- one versatile backup → counted available to **at most one** slot per week (`maxSlotMatching`)
- identical snapshots → **zero** planning delta
- no byes in the horizon → `bye_loss` component **= 0** everywhere
- playoff weeks → **derived from `league.playoff`**, never hard-coded
- bye/coverage **structure** confidence is HIGH regardless of projection horizon (it is schedule math)

---

## 28. Runtime / provider reads (spec §AB) — estimated

One `buildRosterHealthInputs` (Phase 6 shared read — canonical state + weekly batch + RI +
schedule; the schedule provider **already caches the whole season**) + one
`buildLeagueManagementContext` (memoized). Then, in memory: 12 teams × ~14 remaining weeks ×
1 `buildOptimalLineup` solve = **~170 solves** + ~12 future-week `evaluateHorizon` calls per
team for the health pressure (bounded to the near/medium window, not all 14 weeks). Phase 6's
per-team weekly compute was ~7 ms; Phase 7 is roughly `weeks_in_window × that` per team.
**Estimate: ~150–400 ms for the whole league**, **0 extra provider reads per manager/week**
(spec §AB — the schedule and projections are shared). Full-ROS health pressure for every week
is the expensive tail → default to computing per-week health only for the near+medium window
and coverage-*structure* (cheap) for the full ROS.

---

## 29. Proposed v1 scope (spec §AC) — **Scope 3**

**Scope 3: bye exposure + future legal-lineup coverage + weekly projected-lineup vector +
future roster-health pressure + regular-season schedule-context vectors + playoff planning
context.** Justification:
- **Data supports it** — full-season schedule + byes + opponent identity are known now;
  `league.playoff` is canonical; Phase 6 is reusable unchanged; `lib/trades/ros.ts` proves the
  per-week timeline primitive.
- **The one real constraint (projection horizon, §8) is handled by structure/value separation**
  — bye/coverage structure is HIGH confidence for the full season; only value estimates decay,
  and they are explicitly labelled `ROS_PROJECTION` + confidence-graded.
- **Scope 4 is excluded** (spec §AC) — no waiver/trade/streaming recommendations.

---

## 30. Integration strategy (spec §AD) — `SHARED_CONTEXT`

Near-term bye/coverage/health structure is trustworthy evaluative context → `SHARED_CONTEXT`
(like Phase 6), exposed on `/api/leagues/:slug/schedule-planning` + a manager slice. The
farther-week *value* estimates are emitted with `ROS_CONTEXT_ONLY` confidence — not
`SHADOW_ONLY` for the whole layer, because the structural outputs are solid. **Not wired into
trade / waiver / lineup / start-sit / matchup scoring** (spec §AD). A `deployment` field
(`SHARED_CONTEXT`; `PRODUCTION_WIRED` requires explicit later activation).

---

## 31. Trade / ROS compatibility (spec §AE)

`lib/trades/ros.ts` (`RosRosterValue`, `playoff_window_delta`, `bye_hole_slot_weeks`) is
**frozen** — Phase 7 does **not** repoint it (would change trade numbers). Phase 7's
`week_timeline` and the trade engine's `weekly_totals` compute the same primitive
(`buildOptimalLineup` per week with byes) but keep independent window/labeling semantics.
**Documented future parity/migration opportunity:** once the Orchestrator exists, the trade
engine could consume Phase 7's shared `week_timeline` instead of its private ROS loop — a
later, explicit, separately-validated change.

---

## 32. Orchestrator extension point (spec §AF)

Phase 7 supplies **what future pressure exists** (`summary.worst_bye_week`,
`bye_concentration_window`, `weeks_with_uncovered_slots`, `playoff_exposure`,
per-week `future_roster_health`). The Orchestrator later decides **whether to act now**. The
`week_timeline` + `summary` are the stable contract; a `football_context: null` /
`orchestrator_hint: null` extension field is documented (not stubbed), mirroring Phase 2's
`football_context` pattern.

---

## 33. Findings

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| **P7-1** | P2 | `lib/trades/ros.ts` already builds a per-future-week legal-lineup timeline (trade-scoped). | **FREEZE** it (spec §AE); `lib/schedule-planning/` generalizes the concept into a shared layer; document future parity. Isolation tests required. |
| **P7-2** | P2 | Only ONE future weekly projection exists (the current week); everything beyond is prorated ROS mean. | **Structure/value separation (§8, §13)** — bye/coverage structure is HIGH confidence for the whole season; value estimates are labelled `ROS_PROJECTION` + confidence-graded per week. The real horizon limit, handled honestly. |
| **P7-3** | P2 | No real Bloodline planning history (0 played 2026 weeks). | v1 certifies determinism + schedule/bye math + horizon separation + real-league smoke, not predictive value. `devoted` chain = real cross-check. Dormant re-eval `schedule-planning-2026.2`. |
| **P7-4** | P3 | Team-State `UPCOMING_BYE_LOOKAHEAD = 3` is conservative; the full schedule is available. | Phase 7 consumes the full season directly (the schedule provider already caches it). Team-State's 3-week window is unchanged (frozen Phase 2). |
| **P7-5** | P3 | Future fantasy-matchup opponent is not reliably known. | Phase 7 v1 plans per NFL week, not per fantasy opponent; playoff-*opponent* deferred; `OPPONENT_UNKNOWN` for the fantasy dimension. |
| **P7-6** | P3 | Playoff config may be null on some leagues; reseeding/two-week rounds unmodeled. | `PLAYOFF_CONFIG_UNAVAILABLE` / `PLAYOFF_FORMAT_UNMODELED` degradation; no hard-coded playoff weeks. |
| **P7-7** | P3 | Full-ROS per-week roster-health for all 14 weeks is the runtime tail. | Compute per-week health for the near+medium window only; coverage *structure* (cheap) for the full ROS. |

**No P0. No P1.** Nothing blocks a Scope 3 implementation.

---

## 34. Explicit deferrals (`DEFERRED_FEATURES`)

Future fantasy-matchup opponent modeling · playoff-opponent projection · reseeding / two-week
playoff rounds / consolation · late-swap / game-time optimization · future FA-pool / "a free
agent could cover this" · future injury projection · any FI-driven projection adjustment ·
streaming recommendations · repointing `lib/trades/ros.ts` · `roster_health` / planning wired
into any recommendation score · `PRODUCTION_WIRED` deployment · full-ROS per-week roster-health
(near+medium window only in v1).

---

## 35. VERDICT

The forward-looking facts Phase 7 needs already exist and are tested: the **entire 2026
regular-season NFL schedule** (opponents + byes for all 18 weeks) is fetched and cached by the
existing `SleeperScheduleProvider`; `league.playoff` (start week, team count, championship
week) is canonical; the per-future-week legal-lineup primitive is proven in `lib/trades/ros.ts`
and Phase 6's contingency machinery; Phase 6's frozen `evaluateHorizon` is pure and reusable
with future-week bye assumptions. The single real constraint — only the current week has a true
weekly projection — is handled honestly by separating **schedule-driven structure** (bye
collisions, uncovered slots, playoff weeks: HIGH confidence for the whole season) from
**projection-driven value** (loss points, lineup totals: labelled `ROS_PROJECTION`,
confidence-graded, degrading with horizon). `lib/trades/ros.ts` is frozen; Phase 7 builds a
shared `lib/schedule-planning/` layer that generalizes the concept without changing trade
numbers. Runtime is bounded (~150–400 ms full league, 0 extra provider reads). Predictive
validation is deferred (Bloodline has no played weeks) — v1 certifies deterministic
correctness + schedule/bye math + horizon separation + real-league smoke, exactly as scoped.

Recommended v1: **Scope 3** — bye exposure + future legal-lineup coverage + weekly
projected-lineup vector + future roster-health pressure + regular-season schedule-context
vectors + playoff planning context — delivered as a **`SHARED_CONTEXT`** layer
(`schedule-planning-2026.1`) on two additive endpoints, **not wired into any recommendation
score**, with a structured per-week confidence/degradation model and no auto-promotion.
`lib/trades/ros.ts` and Phase 6 stay frozen; no trade / waiver / lineup / start-sit / matchup
recommendation value changes.

# PHASE 7 — PRE-IMPLEMENTATION AUDIT COMPLETE; SCOPE GATE OPEN

Requesting review/approval of: the **Scope 3** recommendation (§29), the **structure vs value
confidence split** as the answer to the projection-horizon limit (§8, §13), planning per **NFL
week** rather than per fantasy opponent in v1 (§5, §P7-5), freezing `lib/trades/ros.ts` and
building a shared layer (§31), reusing Phase 6's frozen `evaluateHorizon` for future-week
health (§11), FI as **descriptive-only** future-opponent context (§10), `SHARED_CONTEXT`
integration with per-week degradation (§30), and synthetic-primary validation with a `devoted`
real cross-check reported separately (§24–§25). On approval, implementation proceeds per
§12/§27/§28 and ends with one of `PHASE 7 CERTIFIED — SHARED SCHEDULE-PLANNING CONTEXT` /
`CONDITIONAL — REMEDIATION REQUIRED` / `PHASE 7 NOT CERTIFIED`. **Stopping. No Phase 7
implementation until the scope is reviewed.**


---

# PART II — IMPLEMENTATION & VALIDATION (Scope 3, SHARED_CONTEXT)

_Branch `team-management-phase7-schedule-planning` (stacked on `48a97cb`). Implementation of the approved Scope 3 per the 35-constraint spec and the §33 sequence._

## II.1 What was built

`lib/schedule-planning/` — a shared forward-planning context, `SHARED_CONTEXT`, model/version
`schedule-planning-2026.1`. Additive only; nothing in `lib/trades/`, `lib/weekly/lineup.ts`,
`lib/roster-health/` or any recommendation engine is modified.

| file | role |
| --- | --- |
| `schema.ts` | The Phase 7 contract. `WeekPlan` splits **STRUCTURE** fields (`nfl_schedule_state`, `starters_on_bye`, `bye_player_count`, `legal_lineup_covered`, `uncovered_slot_labels`, `structure_confidence`) from **VALUE** fields (`projection_basis`, `projected_lineup_value`, `no_bye_lineup_value`, `estimated_bye_loss`, `value_confidence`, `value_source`). `PlanningDegradation` carries **separate** `structure` and `value` grades — never one collapsed confidence. `PLANNING_MODEL_VERSION`, `PlanningLineage`, `PlanningSummary`, `TeamSchedulePlan`, `SchedulePlanningLeagueContext`, `SchedulePlanningDelta`. |
| `schedule.ts` | `loadFullSchedule(season, fromWeek, toWeek)` → `FullSchedule` (per-week bye set + opponent map for the whole remaining season). The `SleeperScheduleProvider` caches the entire regular season on first use, so 18 `getWeekSchedule` calls cost **one** provider read (measured 17 ms). A week whose feed fails the structural-intactness check goes into `incompleteWeeks` and its byes are **not asserted** (spec §2). Home/away is not exposed by the provider → `home_away` is always `null`, recorded in the contract. |
| `evaluate.ts` | `buildWeekTimeline(input)` — the per-team week-by-week planner. For every remaining week: schedule-verified byes → drop bye players via the frozen Phase 6 `rosterWithout` → best legal lineup via the **frozen `buildOptimalLineup`** (joint FLEX/SUPER_FLEX/multi-position matching — a versatile backup fills at most one slot) → uncovered slots + `estimated_bye_loss` (no-bye lineup value − bye-adjusted lineup value) + projected lineup value. Current week uses the true weekly projection (`projection_basis = WEEKLY`); every future week uses **prorated ROS** (`ROS_PROJECTION`, per-player ROS total ÷ remaining playing weeks). Future roster-health pressure for weeks within 6 of current is the **frozen `evaluateHorizon`** run on a per-week inputs clone. FI is **not** consulted for any numeric adjustment (`football_intelligence_version = "not_used"`). |
| `build.ts` | `buildSchedulePlanningContext(leagueSlug)` — one `runInLeagueStateScope`: one `buildRosterHealthInputs` (the shared canonical state + weekly batch + RI + replacement + schedule that Phase 6 / the weekly engine already build), one `buildLeagueManagementContext`, one `loadFullSchedule`. Planning horizon (`last_regular_week`, `playoff_weeks`) comes from **canonical `league.playoff_settings`** — not hard-coded weeks 15–17; absent config → plan through NFL week 18, no playoff weeks, `PLAYOFF_CONFIG_UNAVAILABLE`. Per-team `PlanningSummary` (next/worst bye, tightest bye-concentration window, uncovered-slot weeks, playoff exposure, per-week projected-lineup timeline) + rolled-up degradation. |
| `delta.ts` | `planningDelta(before, after)` — descriptive comparison of two immutable planning snapshots for the same team. Coverage improved/worsened, new/resolved uncovered-slot weeks, bye-collision added/removed, ROS-projected lineup shift (labelled, never a verdict), playoff-fragility shift, bye-concentration shift. Identical inputs → zero changes. Summary text is descriptive only — it never says a move was good or bad. |
| `index.ts` | Barrel. |
| `app/api/leagues/[leagueSlug]/schedule-planning/route.ts` | League-wide endpoint, all 12 teams, `Cache-Control: 30/120`. |
| `app/api/leagues/[leagueSlug]/managers/[managerSlug]/schedule-planning/route.ts` | One manager's slice of the same single-read derivation. |

## II.2 Structure vs value confidence — the core requirement (spec §1, §9)

Every `WeekPlan` resolves the two confidences **independently**:

- `structure_confidence` = `HIGH` for any week whose schedule feed is intact — for the **whole
  regular season and the playoff weeks**, regardless of how far away. It drops to `LOW` only
  when the NFL feed itself is incomplete (`SCHEDULE_WEEK_INCOMPLETE`). Distance from the
  current week never degrades it.
- `value_confidence` = `HIGH` only for the current week (true weekly projection); `MEDIUM` for
  future weeks inside the 6-week window; `ROS_CONTEXT_ONLY` beyond it; `LOW` when a starter's
  projection is missing.
- `PlanningDegradation.structure` and `.value` are graded separately. A distant week with a
  known bye reads `structure: "OK"` / `value: "ROS_ONLY"` — never a single blended grade.

Live example (Bloodline `supyo29`, week 15 playoff): `structure_confidence = HIGH`,
`value_confidence = ROS_CONTEXT_ONLY`, `projected_lineup_value = 134.77` carried with
`projection_basis = ROS_PROJECTION`.

## II.3 Projection hierarchy (spec §8)

`projection_basis` is `WEEKLY` for exactly one week (current) and `ROS_PROJECTION` for every
other. Future weekly values are the player's ROS total prorated over that player's remaining
**playing** weeks (schedule byes removed from the denominator), never the current weekly
number stretched across the season. `value_source` on every week records
`weekly_model_version`, `ros_source` (`sleeper_season_rotowire_prorated`) and `ri_model_version`.
Future weeks always carry `FUTURE_WEEKLY_PROJECTION_UNAVAILABLE` + `ROS_PROJECTION_USED` in
`degradation.reasons`.

## II.4 Frozen reuse (spec §3, §4, §26)

- `lib/trades/ros.ts` — **untouched**. Phase 7 imports nothing from `lib/trades/`; `lib/trades/`
  imports nothing from `lib/schedule-planning/`. `RosRosterValue.weekly_totals`,
  `bye_hole_slot_weeks`, the trade regular/playoff windows and trade ROS scoring are unchanged.
  Isolation-tested (static import graph) + the full trade-engine suite passes unchanged.
- `buildOptimalLineup` / `maxSlotMatching` — used verbatim through `lib/weekly/lineup.ts` and
  the Phase 6 `contingency.ts` primitives. No new optimizer, no new slot normalizer.
- `evaluateHorizon` — called unmodified with `horizon: "rest_of_season"`. Phase 7 owns only the
  per-week **scenario** (which players are on bye that week); the roster-health methodology,
  lineage and degradation are Phase 6's.

## II.5 Planning per NFL week; roster static (spec §5, §6)

Timelines are indexed by NFL week, not by fantasy opponent — every week carries
`ROSTER_ASSUMED_STATIC`. No hypothetical adds/drops/trades/waivers; no future FA pool
(`FA_POOL_UNAVAILABLE` is available as a degradation reason for any consumer that asks for
roster-held-only planning to be made explicit). Fantasy-playoff-opponent modelling is deferred.

## II.6 Runtime (spec §31) — measured, Bloodline (12 teams, 17-week horizon)

| stage | ms | note |
| --- | ---: | --- |
| shared inputs (canonical state + weekly batch + RI + replacement + schedule) | ~1,554 | the same reads Phase 6 / the weekly engine already perform — **inherited unchanged** |
| Team-State context | 25 | shared, one call |
| full-season NFL schedule | 17 | 18 `getWeekSchedule` calls = **one** cached provider read |
| **per-team planning compute (12 teams × 17 weeks)** | **248** | **20.7 ms/team** |
| **extra provider reads per manager / per week** | **0** | |

Phase 7's own added cost is ~265 ms for the full league — within the spec's ~150–400 ms band.
The ~1.5 s is pre-existing shared-read latency Phase 7 does not own. Endpoint is
`Cache-Control: 30/120`; output is deterministic given a fixed snapshot + fixed models
(verified byte-identical across repeated builds on both real leagues).

## II.7 Tests — `test/schedule-planning.test.ts`, 19 / 19 pass

Structure/value separation (spec §1): current-week `WEEKLY` vs future `ROS_PROJECTION`; known
structure stays `HIGH` while value is `ROS_CONTEXT_ONLY`; `SCHEDULE_WEEK_INCOMPLETE` drops
structure confidence without fabricating a bye.

Invariants (spec §30): no byes → every `estimated_bye_loss` is 0 · removing a bye collision
never increases bye-loss · identical inputs → byte-identical timeline · adding a legal strong
backup never worsens future coverage or bye-loss · playoff weeks come from league config, not a
15–17 assumption · future ROS value is explicitly labelled · missing future projection →
degraded, not a fabricated weekly number.

Adversarial matrix (spec §29): same-week QB + SUPER_FLEX bye with one backup → real uncovered
exposure, no double count · multiple RB byes same week → FLEX collision in coverage · a
versatile bench backup is never counted for two simultaneous vacated slots (2 WR byes, 1 legal
filler → exactly 1 uncovered).

Delta (spec §22): identical planning snapshots → zero changes · a new bye collision surfaces as
`BYE_COLLISION_ADDED` with a descriptive (non-verdict) summary.

Isolation (spec §3, §26): `lib/trades/**` never imports `schedule-planning` · `ros.ts` /
`lineup.ts` unchanged · `schedule-planning/**` never imports a recommendation engine · the
frozen `buildOptimalLineup` + `evaluateHorizon` are the compute primitives, no new optimizer.

## II.8 Live smoke — both real leagues

`bloodline-bowl` (12 teams) and `devoted-to-the-game` (12 teams): 17-week timelines,
`planning_horizon` `{current_week: 1, last_regular_week: 14, playoff_weeks: [15,16,17]}` from
canonical `playoff_settings` (start 15, teams 6, championship 17) — **not hard-coded**.
`deployment = SHARED_CONTEXT`, `football_intelligence_version = "not_used"`. Real 2026 NFL bye
weeks resolve correctly (wk5 CAR/KC, wk7 BUF/JAX/LAC/WAS, wk11 six teams, …); week 6's feed is
structurally incomplete and is correctly flagged `SCHEDULE_WEEK_INCOMPLETE` with no asserted
byes. `supyo29` worst bye week 7, `estimated_bye_loss ≈ 29.4` (`ROS_PROJECTION`, `MEDIUM`);
uncovered-slot weeks `[7, 11, 14]`. Determinism verified on both leagues.

## II.9 Regression

`tsc --noEmit` clean · `eslint lib/schedule-planning test app` — 0 errors (0 new warnings) ·
`npm test` **1558 pass / 0 fail / 4 skipped** (+19 schedule-planning; **0 existing tests
changed**) · every trade-engine, weekly, waiver, Phase 4 start-sit-fi, Phase 5
matchup-intelligence and Phase 6 roster-health suite passes **unchanged** ·
**production recommendation behaviour change = 0** (`lib/trades/ros.ts` byte-identical; no
`buildOptimalLineup` / `maxSlotMatching` change; no new normalizer).

## II.10 Findings (Part II)

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| P7-1 (audit) | P2 | a per-future-week legal-lineup timeline already exists in `lib/trades/ros.ts` | **RESOLVED** — frozen; `lib/schedule-planning/` generalises the concept (full 18-week horizon, joint slot matching, per-week bye scenarios, structure/value split, playoff config) without touching trade numbers. Isolation-tested. |
| P7-2 (audit) | P2 | Bloodline has 0 played weeks → no predictive validation | **DOCUMENTED** — v1 certifies determinism + schedule/bye math + horizon separation + real-league smoke. Dormant re-eval `schedule-planning-2026.2` once ≥4 completed 2026 weeks + a `devoted` reconstruction exist (spec §28). |
| P7-3 | P2 | future weekly projections do not exist | **RESOLVED BY DESIGN** — prorated ROS, `projection_basis = ROS_PROJECTION`, horizon-graded `value_confidence`, `FUTURE_WEEKLY_PROJECTION_UNAVAILABLE` + `ROS_PROJECTION_USED` always present. Structure confidence is unaffected. |
| P7-4 | P3 | provider exposes no home/away | `home_away` is `null` in every `ScheduleContextEntry`, recorded as a contract limitation in `schedule.ts`. Opponent identity (the predictive part) is unaffected. |
| P7-5 | P3 | per-team compute 20.7 ms/team | Full-league added compute 248 ms is within the ~150–400 ms target. Memoising repeated `buildOptimalLineup` solves across weeks is a future optimisation if the horizon grows. |
| P7-6 | P3 | week 6 NFL feed structurally incomplete on both leagues right now | Correctly surfaced as `SCHEDULE_WEEK_INCOMPLETE` (no fabricated byes). Self-resolves when Sleeper finalises the feed. |

No P0. No P1.

## II.11 Deferred (`DEFERRED_FEATURES`)

Fantasy-playoff **opponent** modelling (bracket/seeding) · any FI or Phase 3/4/5 numeric
projection adjustment (null findings remain binding — descriptive context only) · K/DST
streaming recommendations (schedule facts only; Phase 6 K/DST fragility exclusions preserved) ·
future free-agent / waiver planning · an aggregate "strength of schedule" scalar (the
week-by-week vector is the output) · `PRODUCTION_WIRED` deployment (requires an explicit future
deployment-state change + `schedule-planning-2026.2` re-certification; no auto-promotion).

## II.12 Freeze criteria (spec §34) — check

- [x] Full-season schedule/bye facts correct (real 2026 byes verified; incomplete weeks flagged, not fabricated)
- [x] Future legal-lineup coverage uses joint slot matching (frozen `buildOptimalLineup`); a versatile backup fills at most one slot (tested)
- [x] Structural confidence separate from value confidence on every week-level output; separate degradation grades
- [x] True weekly and ROS projections never masquerade as the same horizon (`projection_basis`, `value_source`, always-on degradation reasons)
- [x] Future ROS values explicitly labelled + horizon-graded
- [x] Phase 6 `evaluateHorizon` semantics frozen (called unmodified; per-week scenario only)
- [x] Trade ROS semantics frozen (`lib/trades/ros.ts` byte-identical; import graph isolated; trade suite unchanged)
- [x] Playoff weeks from canonical `league.playoff_settings`; absent → degrade, don't infer
- [x] Roster-static assumption explicit (`ROSTER_ASSUMED_STATIC` on every week)
- [x] No fake future FA pool
- [x] Planning deltas non-prescriptive (descriptive summary; no good/bad verdict; identical inputs → zero delta)
- [x] Provider reads shared + bounded (1 canonical state + 1 Team-State + 1 schedule + shared projection inputs; **0** per manager / per week)
- [x] Production recommendation behaviour change = 0
- [x] Phase 1C cross-surface certification green; Phase 2/4/5/6 suites unchanged
- [x] P0 / P1 findings: none

## II.13 VERDICT

Scope 3 is implemented exactly as approved: a `SHARED_CONTEXT` forward-planning layer
(`schedule-planning-2026.1`) covering bye exposure, future legal-lineup coverage, the weekly
projected-lineup vector, future roster-health pressure, regular-season schedule-context vectors
and playoff planning context — on two additive endpoints, wired into **no** recommendation
score. Every week-level output separates schedule-grounded STRUCTURE confidence (HIGH for the
whole season) from projection-driven VALUE confidence (horizon-graded, `ROS_PROJECTION`-labelled).
`lib/trades/ros.ts`, `buildOptimalLineup` and Phase 6 are frozen and isolation-tested; the full
1558-test suite passes with zero existing tests changed and zero production recommendation
behaviour change; both real leagues smoke clean and deterministic. Predictive validation is
deferred (no played weeks) with a documented dormant `schedule-planning-2026.2` re-evaluation.
No P0 / P1 findings.

# PHASE 7 CERTIFIED — SHARED FORWARD-PLANNING CONTEXT FREEZE

