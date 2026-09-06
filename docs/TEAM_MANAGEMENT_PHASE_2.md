# Bloodline Bowl Team Management — Phase 2

**The shared Team-State / Management Context layer**

Date: 2026-09-06
Branch: `team-management-phase2-team-state` (from the certified + merged Phase 1
`main`, `f43c35d`)
Sources of truth: `docs/TEAM_MANAGEMENT_PHASE_1A / _1B1 / _1B2 / _1C.md`
Phase 1 status: **CERTIFIED — canonical-state contract FROZEN** (§17 of 1C).

---

## 1. Phase 2 objective

Transform the frozen `CanonicalLeagueSnapshot` into a standardized,
**manager-centric structural context** that every future Bloodline system will
consume — **without making a single strategic recommendation**.

Phase 2 answers **"what is true about this fantasy team right now?"**
It does **not** answer "what should the manager do?".

```
CanonicalLeagueSnapshot  (frozen, Phase 1)
        │  buildTeamManagementState / buildLeagueManagementContext
        ▼
Manager Management Context   ← THIS PHASE (facts + deterministic structural state)
        │
        ▼
future consumers: Football Intelligence · Start/Sit · Matchup · Waivers ·
                  Trades · Roster Health · Schedule/ROS · Orchestrator
```

Explicitly **not** built (per the brief): R Football Intelligence Engine, scheme
tendencies, OL/DL/LB/secondary analytics, player matchup ratings, Start/Sit
scoring, matchup win probability, opponent-adjusted projections, waiver/trade/
roster-move recommendations, ROS/playoff modeling, orchestrator logic.

---

## 2. Existing context audit

Inspected before writing anything (no third parallel manager-context model was
created).

| Existing context | File | What it owns | Overlap with Team-State |
|---|---|---|---|
| `ManagerContext` (`/api/context`) | `lib/canonical/manager-context.ts` | league config, one manager, roster as `CanonicalPlayer[]`, `position_counts`, `empty_starting_slots`, standing, upcoming matchup, waiver context, `bye_week_notes` (stub) | `position_counts`, `empty_starting_slots`, matchup ref — Team-State supersedes with a fuller, per-manager-uniform model |
| `WeeklyTeamContext` | `lib/weekly/context.ts` | lineage, `roster_constraints`, projections, replacement frontier, availability, `ros_signal`, schedule-verified **byes**, **`positional_needs`** (with `severity` + `gap_vs_replacement` — PROJECTION-dependent), `data_quality` | the **structural** half of `positional_needs` (`need` count, `eligible_positions`, the STRUCTURAL legal-lineup check via `maxSlotMatching`); the schedule/bye provider |
| `TradeAnalysisContext` | `lib/trades/context.ts` | one immutable snapshot, `rosters_by_manager` (all managers), projections, replacement, ROS week range, per-week bye map | already reads the canonical snapshot once; `rosters_by_manager` = the multi-manager idea Team-State generalises |
| `RosterResilience` / `PositionDepth` | `lib/trades/depth.ts` | `viable_starters`, `replacement_cliff`, `fragility_score`, `usable_depth_score` — all **projection/replacement-line dependent** | the projection-FREE parts only: `starting_requirement`, `understaffed` (count < requirement), `no_cover` |
| `computePositionalNeeds` | `lib/weekly/context.ts` | projection-aware optimal lineup + `maxSlotMatching` structural need + per-flex-label marginal starter | the `maxSlotMatching` structural fieldability + per-key `need` count |
| `computeStandings` / migrated adapters | `lib/analytics/*`, `lib/canonical/compat/*` | records | Team-State reads `snapshot.standings` directly |

**Frozen primitives reused verbatim** (no re-implementation): `lib/weekly/slots.ts`
(`maxSlotMatching`, `slotEligiblePositions`, `FLEX_ELIGIBILITY`, `isFlexSlot`,
`slotFamily`), `lib/weekly/schedule/registry.ts` (`getScheduleProvider`),
`lib/canonical/*` (snapshot, lineage, fingerprints, `runInLeagueStateScope`).

---

## 3. Ownership matrix — canonical vs Team-State vs domain engines

| Fact / derivation | Canonical owns | **Team-State owns** | Weekly / Start-Sit / Matchup own | Trade / Waiver / Roster-Health own |
|---|---|---|---|---|
| rosters, players, scoring map, matchups, standings | ✅ | reads | reads | reads |
| roster settings + FLEX eligibility (`slots.ts`) | ✅ (frozen) | reads | reads | reads |
| player identity + join keys (canonical/sleeper/gsis/nfl team/position) | ✅ | **re-exposes compactly** (`TeamStatePlayer.ids`) | reads | reads |
| **positional inventory** (rostered / active / starting / benched / IR counts per slot key; slot-eligible counts; `starter_slots_covered`) | — | **✅ NEW** | — (weekly re-derives `position_counts` today) | — (trade `depth.ts` re-derives today) |
| **structural legal-lineup check** from ACTIVE players (`maxSlotMatching`) | — | **✅ NEW** (`can_field_legal_lineup`) | `buildOptimalLineup.empty_slots` (projection-aware) | `validateTrade` (its own use) |
| **structural flags** (`NO_ACTIVE_BACKUP`, `UNFILLED_STARTER_SLOT`, `SINGLE_POINT_OF_FAILURE`, `CURRENT_WEEK_BYE_GAP`, `SHARED_BYE_WEEK`, `IR_DEPTH_REDUCTION`, `OPEN_ROSTER_SLOT`, `OVER_ROSTER_LIMIT`, `ILLEGAL_CURRENT_LINEUP`) | — | **✅ NEW** | — | — |
| **structural depth pressure** (`broken` / `bare` / `thin` / `none` + `structural_surplus`, PROJECTION-FREE, reason-coded) | — | **✅ NEW** | — | — |
| **change events** between two snapshots | — | **✅ NEW** (`diffCanonicalSnapshots`) | — | — |
| current matchup opponent (roster id, manager ids, bye) | ✅ | re-exposes | reads | reads |
| schedule-verified byes + this-week NFL opponent | — (schedule provider) | **✅ NEW facts view** (`schedule_facts`) | ✅ owns bye→projection-zero | reads |
| replacement level / VOR / `viable_starters` / `fragility_score` | — | ❌ NEVER | ✅ | ✅ |
| projected points / optimal lineup / `PositionalNeed.severity` / `gap_vs_replacement` | — | ❌ NEVER | ✅ | ✅ |
| player quality / start-sit / win prob / recommendations | — | ❌ NEVER | ✅ | ✅ |

**Boundary rule:** Team-State owns *facts* and *deterministic structural
derivations of facts*. The moment a value needs a projection, a replacement
line, or a quality judgement, it belongs to a domain engine.

---

## 4. Team-State schema

`lib/team-state/schema.ts`. `TEAM_STATE_VERSION = "team-state-2026.1"`.

### `TeamManagementState` (one team)

```
version, lineage: RecommendationLineage        // snapshot id + team_state version
identity   { league_slug, league_snapshot_id, provider, season, week,
             canonical_manager_id, canonical_team_id, roster_id, manager_slug,
             manager_display_name, team_name, provider_owner_id,
             is_co_managed, is_vacant }
league     { scoring_fingerprint, roster_fingerprint, team_count, status,
             starting_slots, slot_requirements, bench_slots, ir_slots, taxi_slots,
             roster_size_limit, flex_slots[{label, eligible_positions, count}],
             playoff{ team_count, start_week, championship_week } }
roster     { players: TeamStatePlayer[], starters[], bench[], ir[], taxi[],
             all_players[], unfilled_starter_slots[], open_active_slots,
             can_field_legal_lineup }
standing   { rank, wins, losses, ties, points_for, points_against,
             games_played, playoff_seed } | null
position_inventory : PositionInventory
structural_flags   : StructuralFlag[]
depth_pressure     : DepthPressure
matchup            : TeamStateMatchup | null
schedule_facts     : TeamStateScheduleFacts
football_context   : null      // extension point — documented, NOT stubbed (§11)
```

### `TeamStatePlayer` (compact, join-key-rich — NOT the full `CanonicalPlayer`)

```
canonical_player_id
ids { sleeper_id?, yahoo_id?, gsis_id?, pfr_id?, espn_id? }   // only resolved keys
full_name, position, eligible_positions[], nfl_team, is_team_defense,
status, injury_status, identity_unresolved,
roster_slot: "starter" | "bench" | "ir" | "taxi",
starting_slot_label: string | null,       // the exact slot this starter fills
nfl_opponent: string | null,              // this week, when schedule READY
on_bye_this_week: boolean                 // schedule-verified only
```

Names, first/last split, and `resolution` internals are deliberately omitted —
a consumer that needs them reads the canonical snapshot.

---

## 5. League-level management context

`LeagueManagementContext` — derived from ONE snapshot inside one
`runInLeagueStateScope`:

```
version, lineage
league   { …TeamManagementState.league…, league_slug, league_snapshot_id, season, week }
teams               : TeamManagementState[]     // ascending roster_id
manager_index        : { canonical_manager_id -> teams[] index }
roster_index         : { roster_id -> teams[] index }
ownership            : { owned_by_team: {player_id -> canonical_team_id},
                         league_roster_ids[], free_agent_pool: "NOT_MATERIALIZED" }
matchup_pairs         : [rosterA, rosterB | null][]   // null = bye
league_position_summary: [{ slot_key, total_active, teams_broken, teams_bare,
                            teams_thin, teams_surplus }]   // factual Σ / counts
warnings
```

Works for **every** manager (trade-partner discovery, opponent analysis, waiver
competition, matchup analysis, orchestrator). One provider read → all N states
(tested: `getLeagueState` called exactly once for a 6-team league).

---

## 6. Positional inventory semantics

`PositionInventoryEntry` per slot key (each base position the league uses + each
distinct flex label). **All counts, no judgement.**

| Field | Meaning |
|---|---|
| `slot_key` / `eligible_positions` | e.g. `"FLEX"` → `["RB","WR","TE"]` (from frozen `slotEligiblePositions`) |
| `required_starters` | dedicated starting slots bearing exactly this label |
| `rostered` / `active` / `ir` / `taxi` | eligible players by roster location (`active` excludes IR/taxi) |
| `starting` | players currently ASSIGNED to a slot bearing this **exact** label (a RB in a FLEX slot counts toward `FLEX.starting`, not `RB.starting`) |
| `benched` | active eligible players not currently starting |
| `starter_slots_covered` | from ONE league-wide `maxSlotMatching(starting_slots, active players)` — how many slots of this label the active roster can structurally fill without stealing a player another base slot needs |
| `bench_bodies` | `active − starter_slots_covered` — **"raw bench bodies", explicitly NOT a value claim** |

Also: `rostered_by_position` / `active_by_position` (raw per canonical position).

---

## 7. Structural flag semantics

`StructuralFlag { code, severity, positions[], player_ids[], message, facts }`.
Every flag is a **deterministic structural fact**, reason-coded, with the raw
numbers in `facts`. **Never a recommendation.**

| Code | Severity | Fires when |
|---|---|---|
| `UNFILLED_STARTER_SLOT` | critical | canonical roster has an empty starting slot (`slots[].is_empty`) |
| `ILLEGAL_CURRENT_LINEUP` | critical | `maxSlotMatching` on ACTIVE players leaves a starting slot unfillable |
| `NO_ACTIVE_BACKUP` | warning | a base key with `active_eligible === required_starters` (zero spare). *Fires for K/DEF/QB on most rosters — that is factually true; a consumer (Roster Health) decides which gaps matter.* |
| `SINGLE_POINT_OF_FAILURE` | warning | one active player, if removed, leaves 2+ slot keys unfillable (or 1 key + covers 2+ position families) |
| `CURRENT_WEEK_BYE_GAP` | warning | removing this week's schedule-verified bye starters makes a slot unfillable from remaining active players |
| `SHARED_BYE_WEEK` | info | 2+ active players eligible for a key share the same NFL bye week (looks up to 3 weeks ahead — the schedule feed's reliable horizon), dropping below the requirement |
| `IR_DEPTH_REDUCTION` | info | an IR player is depth a currently-bare position lacks |
| `OPEN_ROSTER_SLOT` | info | active roster spots unused |
| `OVER_ROSTER_LIMIT` | warning | active players exceed active capacity |

No flag ever says "add", "drop", "trade", or names a target.

---

## 8. Needs / surplus semantics — `DepthPressure` (implemented)

`DepthPressureEntry` per slot key. **DETERMINISTIC. PROJECTION-FREE. Structural
slack only — NOT player quality.**

| `level` | `reason_code` | Rule |
|---|---|---|
| `broken` | `BELOW_REQUIREMENT` | `maxSlotMatching` leaves this label unfilled, OR `active_eligible < required` |
| `bare` | `NO_BACKUP` | meets the requirement, `backup_count === 0` |
| `thin` | `SINGLE_BACKUP` | base key, exactly 1 eligible active backup |
| `thin` | `FLEX_POOL_SHALLOW` | flex key, backup pool `< required_starters` |
| `none` | `ADEQUATE` | 2+ eligible active backups |
| (any) | `SURPLUS` | `structural_surplus` — `backup_count ≥ 2` (base) / `≥ required+1` (flex) |

`backup_count` (base) = `active_eligible − required_starters`.
`backup_count` (flex) = `flex_eligible_active − Σ(base demand of eligible positions) − flex_slot_count`.

Naming is deliberately `depth_pressure` / `structural_surplus`, **never**
"RB NEED = HIGH". *"5 RBs" is `structural_surplus` because 5 > (2 starters + 2
buffer) — a COUNT fact — not a claim that the RBs are good.*

`DepthPressure` also exposes `pressured_keys` (worst-first list of non-`none`
keys) and `surplus_keys` — factual lists, not advice.

---

## 9. Change-event schema

`diffCanonicalSnapshots(from, to) → TeamStateDiff`. Runs from two snapshots
directly (no Team-State build needed). **Factual only — never "good/bad".**

```
TeamStateChange { type, roster_id, canonical_team_id, player_id, player_name,
                  before, after, from_snapshot_id, to_snapshot_id }
TeamStateDiff   { from_snapshot_id, to_snapshot_id, week_changed,
                  scoring_changed, roster_config_changed, changes[] }
```

Types: `PLAYER_ADDED`, `PLAYER_DROPPED`, `PLAYER_OWNERSHIP_CHANGED`,
`PLAYER_MOVED_TO_STARTER`, `PLAYER_MOVED_TO_BENCH`, `PLAYER_MOVED_TO_IR`,
`PLAYER_RETURNED_FROM_IR`, `PLAYER_INJURY_STATUS_CHANGED`,
`PLAYER_NFL_TEAM_CHANGED`, `MANAGER_NAME_CHANGED`, `TEAM_NAME_CHANGED`,
`SCORING_CHANGED`, `ROSTER_CONFIG_CHANGED`, `MATCHUP_CHANGED`, `WEEK_ADVANCED`,
`LEAGUE_STATUS_CHANGED`. All deterministic; identical snapshots → `changes: []`.

---

## 10. API / Bridge management surfaces

Additive. Nothing existing changes.

| Route | Returns |
|---|---|
| `GET /api/leagues/:leagueSlug/manage` | `{ context, ...LeagueManagementContext }` — every manager's Team-State from one snapshot |
| `GET /api/leagues/:leagueSlug/managers/:managerSlug/manage` | `{ context, version, lineage, league, manager_state, opponent_state, league_position_summary, matchup_pairs }` — one manager + opponent, same single snapshot |

Both `Cache-Control: public, s-maxage=30, stale-while-revalidate=120`. The
manager route reuses the certified strict resolver (`resolveManagerRoute`) then
picks the team by verified `roster_id` — never a fallback.

Live smoke (both real leagues): `200`, `warnings: []`, `opponent_state` present,
snapshot id matches the certification snapshot.

---

## 11. Future Football Intelligence extension point

`TeamManagementState.football_context` is `null` in Phase 2 — **documented, not
stubbed with fake data.** A future R Football Intelligence Engine attaches:

```ts
football_context: {
  version: string;
  generated_at: string;
  player_profiles: Record<canonical_player_id, { player_profile_id, … }>;
  team_profile_id: string;
  opponent_profile_id: string | null;
}
```

The join keys it needs are already present on every `TeamStatePlayer.ids`
(`canonical_player_id`, `sleeper_id`, `gsis_id`), plus `nfl_team` and `position`,
and on `matchup.opponent_team_id`. Adding `football_context` changes nothing
above it.

---

## 12. Start/Sit + Matchup extension points

A future **Start/Sit** model reads from `TeamManagementState`:
`league.starting_slots` + `flex_slots` (eligibility), `roster.players` with
`roster_slot` / `starting_slot_label` (current assignment) + `eligible_positions`
(alternatives) + `injury_status` / `status` / `on_bye_this_week`,
`matchup.opponent_*`, `league.scoring_fingerprint`. It does NOT need Team-State
to rank anything — Team-State gives it every eligible player per slot; the model
scores them.

A future **Matchup** model reads two `TeamManagementState`s from the SAME
`LeagueManagementContext` (`manager_state` + `opponent_state`), each with
`can_field_legal_lineup`, `roster.players` (alternatives), the matchup pairing,
and one shared `lineage.snapshot.league_snapshot_id`. It computes win
probability; Team-State does not.

---

## 13. Trade / Waiver compatibility

Audited (per the brief — **not** refactored this phase):

- **Safe shared facts identified:** `position_inventory.required_starters`
  == `WeeklyTeamContext.positional_needs[*].need` (parity-verified live on both
  leagues — `0` mismatches); `slotEligiblePositions` is already the one shared
  FLEX authority (frozen); `snapshot.rosters` split is identical (Phase 1C
  certified).
- **Not migrated:** `lib/trades/depth.ts` (`RosterResilience`) and
  `WeeklyTeamContext.positional_needs.severity` stay put — they are
  projection/replacement-line dependent and a refactor would risk
  recommendation-number drift. **No trade or waiver recommendation changed
  because Phase 2 exists.**
- **Future migration path (documented, not done):** weekly's
  `computePositionalNeeds` could consume `position_inventory` for its structural
  half and keep its projection half; a parity test (structural fields equal)
  would gate it. Same for trade `depth.ts`'s `starting_requirement` /
  `understaffed`.

---

## 14. Performance / provider-read results

| Operation | Provider state reads |
|---|---|
| `buildLeagueManagementContext(slug)` — all N manager states | **1** `getLeagueState` (tested: `calls === 1` for a 6-team league) + 1–4 NFL-schedule feed reads (week + 3-week lookahead), shared across all teams |
| `GET /api/leagues/:slug/manage` | 1 (canonical) — inside `runInLeagueStateScope` |
| `GET /api/leagues/:slug/managers/:slug/manage` | 1 (canonical) — builds the whole league context, returns one slice |

No process-lifetime cache. `runInLeagueStateScope` memoizes within the request.
Independent requests read fresh. `buildTeamManagementState` is pure/synchronous.

---

## 15. Phase 1C certification results

`scripts/phase1c-certify.ts` (now includes the `team-state` surface):

```
bloodline-bowl       cross_surface_discrepancies = 0   null_required_fields = 0
devoted-to-the-game  cross_surface_discrepancies = 0   null_required_fields = 0
TOTAL                cross_surface_discrepancies = 0   null_required_fields = 0
```

Team-State is certified against canonical on: league id/season/week/status,
scoring fingerprint, starting slots + bench/IR/taxi counts, team count, and per
team: `owner_user_id`, `manager_display_name`, `team_name`, records,
`starter_ids` / `bench_ids` / `ir_ids` / `all_player_ids`, and per player
`position` / `nfl_team` / `is_team_defense` / `canonical_player_id`.
`test/certification-live.test.ts` fails loudly on any disagreement.

---

## 16. Deterministic test results

`test/team-state.test.ts` — **21 subtests across 8 suites, all pass**:

- inventory counts pure; healthy positions flag-free; `structural_surplus` on a
  genuinely deep position
- `NO_ACTIVE_BACKUP` when a base key exactly meets its requirement
- `UNFILLED_STARTER_SLOT` + `ILLEGAL_CURRENT_LINEUP` + `can_field_legal_lineup: false`
- SUPER_FLEX (QB backs the flex slot), Yahoo `W/R/T` eligibility
- `IR_DEPTH_REDUCTION`, `OPEN_ROSTER_SLOT`
- departed manager keeps `provider_owner_id`; vacant roster flagged vacant
- K / D-ST identified + carry join keys; GSIS-resolved player exposes both
  `sleeper_id` and `gsis_id`
- `CURRENT_WEEK_BYE_GAP` only with a verified schedule; UNVERIFIED → no bye flags
- league context: all manager states + matchup pairs + ownership from ONE
  snapshot; every team's lineage → the same `league_snapshot_id`
- one `getLeagueState` for the whole league context
- change detection: starter swap, add/drop/ownership move, scoring/week/team-name/
  roster-config change, injury-status change, `MATCHUP_CHANGED`, identical → `[]`
- lineage propagation + `football_context: null`

---

## 17. Live Bloodline Bowl smoke results

`bloodline-bowl` (`snap:bloodline-bowl:2026:w1:2460db3559266e6a`):
- `/api/leagues/bloodline-bowl/manage` → 200, 12 teams, `warnings: []`.
- supyo29: 10 starters / 5 bench / 1 IR, `can_field_legal_lineup: true`,
  `open_active_slots: 0`, `team_name: "McBride & Prejudice"`.
- inventory: QB/TE/K/DEF each `rostered: 1` → `depth_pressure: bare (NO_BACKUP)`;
  RB `rostered: 6` / WR `6` / FLEX pool `13` → `structural_surplus`.
- `structural_flags`: `NO_ACTIVE_BACKUP` ×4 (QB, TE, K, DEF) — factually true.
- matchup: opponent roster 6. `football_context: null`.
- `/api/leagues/bloodline-bowl/managers/supyo29/manage` → 200, `opponent_state`
  present.
- **weekly `positional_needs.need` == Team-State `required_starters`** for every
  base position — parity OK.

## 18. Second-league results

`devoted-to-the-game` (`snap:devoted-to-the-game:2026:w1:22479a5b6e50687c`) —
materially different league (distinct `scoring_fingerprint`, `roster_fingerprint`):
- `/manage` → 200, 12 teams, `warnings: []`.
- darthmarker: same shape; `NO_ACTIVE_BACKUP` ×4; opponent roster 10; parity OK.
- Certified 0 cross-surface discrepancies.

Yahoo: no authorised Yahoo league (Phase 1C limitation). The Team-State builder
is provider-agnostic (reads only canonical + `slots.ts` which handles Yahoo
flex labels) and covered by the synthetic `W/R/T` test.

---

## 19. Adversarial audit findings

| Probe | Result |
|---|---|
| state logic becoming recommendation logic | Team-State has ZERO projections / quality / targets. `depth_pressure` is a backup COUNT; `structural_surplus` is `count > requirement + buffer`. No "add/drop/trade". |
| duplicated canonical normalization | reads `snapshot.rosters` / `.players` directly; frozen `maxSlotMatching` / `slotEligiblePositions`. Certified 0 discrepancies. |
| hard-coded positions | `leagueSlotKeys` / `slot_requirements`-driven; SUPER_FLEX / W-R-T via frozen `FLEX_ELIGIBILITY`. Tested. |
| player-quality assumptions as depth facts | `bench_bodies` explicitly "NOT a value claim"; every depth level carries a reason code + raw counts. |
| per-manager provider reads | one `getLeagueState` for all N states (tested). |
| lineage omissions | every state + context carries `RecommendationLineage` (snapshot id + `team_state` version). Tested. |
| hidden stale state | `buildLeagueManagementContext` inside `runInLeagueStateScope`; no module cache. |
| incorrect need/surplus labels | K/DEF/QB `NO_ACTIVE_BACKUP` fires broadly — **factually correct** (they have no backup); documented as "consumer decides which gaps matter". Not a defect. |
| SUPER_FLEX / IR / vacant / departed / K / DST / open slots / dup positions / lineup legality / byes / ownership transitions / snapshot comparison / manager lookup | all covered by deterministic tests, all pass |
| compat adapter as second normalizer | Team-State is a DERIVATION layer, not a compat adapter — it never reshapes canonical into a legacy shape |
| week / status disagreement | certified equal to canonical |
| unresolved identity silently verified | `TeamStatePlayer.identity_unresolved` is explicit; join keys only include ids that actually resolved |

### Findings

| # | Sev | Finding | Status |
|---|---|---|---|
| **P2-1** | P2 | `SHARED_BYE_WEEK` only looks 3 weeks ahead (the schedule feed's reliable horizon). A shared bye 4+ weeks out is not flagged. | documented limitation; the full multi-week Schedule/ROS model is a later phase. |
| **P2-2** | P2 | Free-agent facts are `NOT_MATERIALIZED` — canonical `waiver_state` is still `null` (Phase 1C C-5). A consumer needing the FA pool calls the weekly availability layer. | documented deferral; no Team-State field claims a FA fact that could disagree. |
| **P3-1** | P3 | `NO_ACTIVE_BACKUP` at K/DEF is noisy (fires for ~every team). | intentional — Team-State states the fact; noise-filtering is the consuming model's job. Documented in §7. |
| **P3-2** | P3 | `computePositionalNeeds` (weekly) + `depth.ts` (trade) still re-derive structural facts Team-State now owns. | documented migration path (§13); NOT done this phase to protect recommendation numbers. |

**No P0. No P1.**

---

## 20. P0 / P1 / P2 / P3 table

| Sev | Item | Disposition |
|---|---|---|
| P0 | — | none |
| P1 | — | none |
| P2 | P2-1 `SHARED_BYE_WEEK` 3-week horizon | documented; Schedule/ROS phase |
| P2 | P2-2 free-agent pool not materialised | documented deferral |
| P3 | P3-1 K/DEF `NO_ACTIVE_BACKUP` noise | intentional; consumer filters |
| P3 | P3-2 weekly/trade structural re-derivation | migration path documented |

---

## 21. Intentionally deferred work

1. Migrate weekly `computePositionalNeeds` + trade `depth.ts` structural halves
   onto `position_inventory` (parity-gated). (P3-2)
2. Materialise the free-agent / waiver pool on the canonical snapshot, then add
   `ownership_context.free_agents`. (P2-2)
3. `SHARED_BYE_WEEK` / bye-planning across the full remaining season — Schedule/ROS
   phase. (P2-1)
4. Populate `football_context` — R Football Intelligence Engine phase. (§11)
5. Yahoo live certification of `/manage` — once a Yahoo league authorises.
6. Retire `hashScoringSettings` (carried over from Phase 1C C-4).

None blocks the systems Phase 2 was built to feed.

---

## 22. Recommendation for Phase 3

Phase 2 delivers the substrate: a certified, projection-free, manager-uniform
structural view of every team, built once per operation, lineage-stamped, with
documented extension points for Football Intelligence, Start/Sit, and Matchup.

Phase 3 (the first *analytical* consumer — Start/Sit, Matchup, or Roster Health)
should:

- consume `LeagueManagementContext` / `TeamManagementState`, never canonical or a
  provider directly for structural facts;
- keep projections in the weekly / season providers (the two authoritative,
  separate sources — do not merge);
- carry `RecommendationLineage` (snapshot id + its own engine version);
- add its surface to `test/certification-live.test.ts`;
- run `scripts/phase1c-certify.ts` as a CI gate (exit 0);
- treat every `structural_flag` / `depth_pressure` level as an INPUT to score,
  never as the answer.

---

## Verification

- `npx tsc --noEmit` — **clean**.
- `npx eslint app lib test` — **0 errors**, 18 warnings (all pre-existing on the
  Phase 1 checkpoint; none introduced).
- `npm test` (full repository suite) — **1325 pass · 0 fail · 4 skipped**
  (Phase 1C: 1304 · 0 · 4; +21 `test/team-state.test.ts`).
- `scripts/phase1c-certify.ts` — exit 0, `cross_surface_discrepancies = 0` on
  both real leagues (team-state surface included).
- Live smoke: `/api/leagues/:slug/manage` + `/api/leagues/:slug/managers/:slug/manage`
  → 200 on `bloodline-bowl` and `devoted-to-the-game`, `warnings: []`, weekly
  parity OK.
- Targeted suites green: canonical / certification / weekly / lineup / waivers /
  trades / scoring / projections / REST-API / analytics / persistence.

**No existing deterministic test was weakened.**

---

## Verdict

# PHASE 2 CERTIFIED — READY TO FREEZE

- The shared Team-State / Management Context layer is built, **projection-free**,
  and **certified against canonical with zero cross-surface discrepancies** on
  two real leagues.
- Facts are cleanly separated from evaluations — every structural flag and depth
  level is deterministic, reason-coded, and carries its raw supporting numbers;
  no recommendation logic exists in the layer.
- It works for every manager from one provider read; lineage propagates; the
  Football Intelligence / Start-Sit / Matchup extension points are documented,
  not stubbed.
- No P0 or P1. No existing recommendation behaviour changed. `tsc` clean,
  `eslint` 0 errors, **1325 / 0 / 4** regression, `phase1c-certify` exit 0.

STOP. Do not begin Phase 3.
