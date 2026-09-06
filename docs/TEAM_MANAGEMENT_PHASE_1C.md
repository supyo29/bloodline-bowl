# Bloodline Bowl Team Management — Phase 1C

**Cross-surface certification & Phase 1 freeze**

Date: 2026-09-06
Branch: `team-management-phase-1b2-legacy-canonical-migration` (continues from
1B.2 commit `8ed4a35`)
Sources of truth: `docs/TEAM_MANAGEMENT_PHASE_1A.md`, `_1B1.md`, `_1B2.md`

Phase 1B.2 ended **CONDITIONAL — FIX BEFORE PHASE 1C** with two entry criteria:

1. Build a cross-surface certification harness that detects incorrect canonical
   fields even when individual consumers do not notice. → **§3, done.**
2. Make an explicit architecture decision for `/api/league` and
   `/api/leagues/:slug`. → **§5, done (Option C).**

Phase 1C is a **certification** phase. No product-model work. No Start/Sit,
Matchup Intelligence, R Football Intelligence Engine, ROS/playoff planning, or
Orchestrator.

---

## 1. Certification objective

Answer, with tests that fail loudly:

- **Do all live/current-state systems agree on the same league, manager, roster,
  player, scoring, lineup, and ownership reality?**  → **YES** (§13:
  `cross_surface_discrepancies = 0`, both real leagues, 7 surfaces).
- **Are the remaining non-canonical current-state paths intentional compatibility
  surfaces rather than uncontrolled second sources of truth?**  → **YES** (§6:
  zero category-7 paths after the identity-route fix; `/api/league` is a
  documented Option-C provider-native surface consumed by no engine).

---

## 2. Surfaces included

| Surface | How invoked | In harness |
|---|---|---|
| **canonical** `buildCanonicalLeagueState` | direct | reference |
| canonical persisted/hydrated snapshot | `hydratePersistedSnapshot` | §12 |
| weekly context `buildWeeklyTeamContext` | direct | ✅ (per-manager, `partial`) |
| weekly intelligence | via weekly context lineage | ✅ (snapshot-id) |
| trade context `buildTradeAnalysisContext` | direct | ✅ (snapshot-id parity) |
| trade analysis | via trade context lineage | ✅ (snapshot-id) |
| lineup / waivers | via `runWithWeeklyContext` → weekly context | ✅ (same context) |
| `/api/scoring` family (`buildScoringBundle`) | `buildScoringBundle(slug)` | ✅ |
| `/api/leagues/:slug/managers/:slug/snapshot` | route `GET` | ✅ |
| `buildSnapshot` (`/api/snapshot` family) | direct | ✅ (league + standings) |
| `/api/leagues/:slug/managers/:slug` (identity + roster) | route `GET` | ✅ (per-manager, `partial`) — **migrated in 1C** |
| `/api/leagues/:slug/managers` (routing list) | route `GET` | ✅ (roster_id ↔ owner ↔ name) |
| `/api/league` + `/api/leagues/:slug` (`buildLeagueBundle`) | `buildLeagueBundle` | ✅ (**Option C** — provider-native, all overlapping facts certified) |

Not in the harness (out of scope — historical / draft-night / debug): `/api/managers`,
`/api/history`, `/api/standings`, `/api/lineups`, `/api/matchups`,
`/api/player-*`, `/api/manager-availability`, `/api/weekly-stats`,
`/api/roster-analysis`, `/api/value`, `/api/transactions` (`?league=`), all
`/api/draft*`, `/api/raw`, `/api/health`.

---

## 3. Cross-surface certification harness design

`lib/canonical/certification/` — `harness.ts` + `extractors.ts`.

**Model.** Each surface's payload is reduced to a provider-neutral `LeagueFacts`:

```
LeagueFacts {
  source, provider_league_id, season, week, status,
  scoring_fingerprint, raw_scoring, roster_positions_raw,
  starting_slots, bench_slots, ir_slots, taxi_slots, team_count,
  teams: Map<roster_id, TeamFacts>,       // omitted / partial for per-manager surfaces
  players: Map<provider_id, PlayerFacts>,
  snapshot_id, partial
}
TeamFacts  { roster_id, owner_user_id, manager_display_name, team_name,
             wins, losses, ties, points_for, points_against,
             starter_ids[], bench_ids[], ir_ids[], all_player_ids[],
             opponent_roster_id }
PlayerFacts{ provider_id, canonical_player_id, position, nfl_team, is_team_defense }
```

`certify(canonical, other, { allow, only })` compares only fields **both** sides
express and returns `Discrepancy[]`. Key rules:

- **Facts, not schemas.** `/api/league` and canonical have wildly different
  shapes; the harness compares the *facts* inside them.
- **Scoring is compared by EQUIVALENCE** — `scoringFingerprint(a) === scoringFingerprint(b)` — not byte identity, so key order / an explicit `0` rule never trips it, but a real value change always does.
- **`partial` surfaces** (weekly context, identity route — one manager) never
  trigger a "team missing" discrepancy; their overlap is still fully compared.
- **`allow`** entries are the *encoded* allowed differences (§ none needed — the
  list is empty for every real surface). A difference that is not in `allow`
  **fails the test** — never a log.
- Canonical `canonical_player_id` and every other surface's provider id must
  resolve to the **same** canonical player (§7).

Tests: `test/certification-live.test.ts` (LIVE, both registered Sleeper
leagues), `test/certification.test.ts` (deterministic — harness self-test +
edge fixtures), `scripts/phase1c-certify.ts` (report generator, exits non-zero
on any discrepancy).

The harness self-test proves it actually catches disagreement: a mutated
`team_name`, a changed scoring value, and a missing team are each asserted to
produce exactly one discrepancy; identical facts produce none.

---

## 4. Field completeness classification

The 1B.2 `team_name` defect (a real field silently null in production) proved
structural validation is insufficient. Every canonical field is classified:

### REQUIRED — must be present and meaningful on any live snapshot

| Field | Source | Certified by |
|---|---|---|
| `league.provenance.provider_id` | provider | live §13 + `certification-live` field test |
| `season`, `week` | provider `/state/nfl` | live |
| `league.status` (≠ `"unknown"`) | provider | live |
| `league.roster_settings.starting_slots` (non-empty) | provider `roster_positions` | live |
| `league.roster_settings.roster_positions_raw` (v3, non-empty) | provider | live |
| `league.scoring_fingerprint` | derived from `raw_scoring` | live |
| `league.raw_scoring` | provider | cross-surface |
| `lineage.league_snapshot_id`, `content_hash`, `roster_fingerprint`, `player_data_version` | derived | §11, live |
| per team: `provider_team_id` (integer-parseable) | provider `roster_id` | live |
| per **claimed** team: a recoverable owner id (`canonical_manager_ids[0]` OR `provider_owner_id`) | provider | live + deterministic |
| per rostered player: `canonical_player_id`, `position` | crosswalk + provider | §7 |

### CONDITIONALLY REQUIRED — present when the upstream fact exists

| Field | Condition | Invariant |
|---|---|---|
| `team.team_name` | the owning **user** (or roster) set one | canonical must equal the provider's value — **must not lose it** (the 1B.2 defect). For `bloodline-bowl` 10/12 teams have one; 2 managers left it blank — legitimately `null`. |
| `manager.display_name` | user has a Sleeper display name | canonical == provider |
| `team.record.*` / `standings.*` | league has started scoring | agree with provider `roster.settings` |
| `matchup` opponent | current week has a matchup row | agree with provider matchups |
| `player.injury_status`, `player.status` | provider reports it | passthrough |

### OPTIONAL — may legitimately be null

`team.faab_remaining` (non-FAAB leagues), `team.waiver_priority`,
`standings.playoff_seed`, `standings.rank` before games, `player.first_name` /
`last_name` for a DST, `draft_picks[].auction_amount` (snake), `waiver_state`
(deferred), `crosswalk_version` (no crosswalk configured).

### PROVIDER-DEPENDENT — shape/availability varies by provider

`identifiers.gsis_id` / `pfr_id` / `espn_id` (crosswalk only),
`identifiers.yahoo_*` (Yahoo only), `eligible_positions` richness,
`playoff_settings.*` (Sleeper computes; Yahoo reports differently),
`provider_owner_id` (Sleeper `owner_id`; Yahoo team-manager guid).

### "Wrong source object" guard

`test/certification.test.ts` includes three fixtures proving `toCanonicalTeams`
reads `team_name` from the correct object: (a) set on the **user** →
picked up (the 1B.2 scenario), (b) set on the **roster** only → fallback works,
(c) departed owner → `provider_owner_id` recoverable, `team_name` null; vacant →
fully null.

---

## 5. `/api/league` and `/api/leagues/:slug` architecture decision

### Decision: **Option C — intentionally provider-native surface.**

**Rationale.** The `LeagueResponse` payload is a deliberate, high-fidelity
mirror of Sleeper's own model: per-player NFL bio (`age`, `years_exp`, `number`,
`active`, `search_rank`, `depth_chart_order`, `depth_chart_position`), the full
`drafts[]` array with every pick, `traded_picks[]`, per-team
`NormalizedDraftPickAsset[]` (future-pick capital with `is_traded` / `is_acquired`
/ `rounds_source`), `keepers`, `division`, `waiver_budget_used`, `key_settings`
prose, `status_description` prose, `metadata.build_ms`. None of this is durable
*league state* that downstream engines need — it is provider presentation
detail and draft-asset bookkeeping.

- **Option A (expand canonical) — rejected.** These fields would bloat the
  canonical model into a Sleeper mirror and violate the change-control rule
  ("must not create alternate live-state normalizers" applies in spirit to
  making canonical a provider clone).
- **Option B (canonical core + enrichment) — rejected *for this endpoint*.**
  The endpoint's *entire value* is the provider-native shape; wrapping it in a
  canonical core would be a contract redesign for no consumer benefit. (Option B
  *was* applied to `/api/leagues/:slug/managers/:slug` in §6 — there the
  canonical core is the point.)
- **Option C — chosen.**

**Conditions for retaining it (all met):**

| Condition | Evidence |
|---|---|
| documented as provider-native, not a source of truth for internal engines | this section + the freeze contract §17 |
| no modern recommendation engine consumes it as canonical state | `grep`: `buildLeagueBundle` / `buildLeagueResponse` are imported by **only** `lib/analytics/snapshot.ts` (for future-pick-asset counts — specialised) and the two endpoints themselves. `lib/weekly/*`, `lib/trades/*`, `lib/draft/*`, `lib/canonical/*` never import them. (`lib/projections/manager-value.ts` imports the pure `startingSlots` helper — not state.) |
| certification assertions for every field that overlaps canonical | `factsFromLegacyLeagueResponse` in the harness: `provider_league_id`, `season`, `status`, `raw_scoring`/`scoring_fingerprint`, `roster_positions_raw`, `starting_slots`, `bench_slots`, `ir_slots`, `taxi_slots`, `team_count`, and per team: `owner_user_id`, `manager_display_name`, `team_name`, `wins/losses/ties/points_for/points_against`, `starter_ids`, `bench_ids`, `ir_ids`, `all_player_ids`, and per player `position` / `nfl_team` / `is_team_defense`. |
| disagreements fail tests | `certify()` returns discrepancies; `assert.equal(all.length, 0)`. Live result: **0**. |

**Note.** `normalizeManager` in `buildLeagueResponse` *already* reads
`user.metadata.team_name ?? roster.metadata.team_name` — the same precedence the
1B.2 fix applied to canonical. So `/api/league` and canonical now agree on
`team_name` (certified). The 1B.2 defect existed only in the canonical mapper.

---

## 6. Hidden second-source-of-truth audit

Repository-wide audit of every live/current-state provider read
(`grep -rnE "getLeague\(|getLeagueRosters|getLeagueUsers|getMatchups|getPlayerIndex|getNflState|getLeagueTransactions|getLeagueDrafts|getDraftPicks|fetchSleeper|…Live"`).
Every call site classified:

| Category | Call sites | Verdict |
|---|---|---|
| **1. canonical ingestion** | `lib/providers/sleeper/provider.ts` (29), `lib/providers/yahoo/provider.ts` (2), `lib/canonical/state.ts` (1) | the one authoritative path |
| **1b. identity resolution** | `lib/leagues/resolve.ts` (9) — `resolveManagerInLeague` verifies a manager ↔ roster ↔ draft-slot | plumbing, produces no competing state view |
| **2. provider enrichment** (canonical core owns the overlap; enrichment adds non-overlapping provider detail) | `app/api/leagues/:slug/managers/:slug/route.ts` `getPlayerIndex` (bio only — **migrated in 1C**); `app/api/leagues/:slug/managers/route.ts` `getLeagueRosters/Users/Drafts` (routing table + `draft_slot` map); `lib/leagues/manager-draft.ts` (5); `lib/weekly/schedule/sleeper-schedule.ts` (2, NFL schedule feed); `lib/weekly/projections/sleeper-weekly.ts` (3, projection feed) | certified: `/api/leagues/:slug/managers` and the identity route both show **0** discrepancies vs canonical |
| **3. historical ingestion** | `lib/analytics/season-data.ts` (11), `history.ts` (2), `managers.ts` (6), `lineage.ts` (1); routes `/api/lineups` `/api/matchups` `/api/player-weekly` `/api/player-availability` `/api/manager-availability` `/api/weekly-stats` `/api/standings` `/api/history` `/api/managers` | historical / weekly-actuals — outside live canonical by design (§12, §17) |
| **4. draft-night freshness-critical** | `lib/sleeper/draft-service.ts` (14), `lib/draft/service.ts` (8, `getLeagueRostersLive`), `lib/leagues/manager-draft.ts`; routes `/api/draft*`, `/api/leagues/:slug/*/draft`, `/api/leagues/:slug/*/recommendations` | intentionally UNCACHED — must not route through cached canonical (freeze contract §17) |
| **5. specialised analytics** | `lib/analytics/snapshot.ts` matchup/txn sections + `buildLeagueBundle` for future-pick-asset counts (10); `lib/projections/{service,build,actuals}.ts` (season model); `app/api/{value,roster-analysis,transactions}/route.ts` | distinct analytics contracts (weekly matchup facts, FAAB txn facts, replacement value, draft capital, season projections) — do not re-derive canonical league/roster/scoring/ownership |
| **6. deprecated legacy normalization** | `lib/sleeper/service.ts#buildLeagueBundle` / `resolveLeagueId` (15) → `/api/league`, `/api/leagues/:slug` | retained as **Option C** provider-native (§5); no engine consumes it |
| **7. accidental duplicate current-state normalization** | **NONE** | `/api/leagues/:slug/managers/:slug` was the last one (it re-split rosters into starters/bench/IR from raw Sleeper arrays) — **fixed in 1C**: the split now comes from `snapshot.rosters`; `getPlayerIndex` remains as bio-only enrichment. |

**Machine-readable inventory:** `scripts/phase1c-certify.ts` prints
`provider_reads_one_composite_op = 1` — a representative composite operation
(canonical facts + scoring + weekly + manager surfaces) performs exactly **one**
`buildCanonicalLeagueState` read (the `runInLeagueStateScope` memo), plus the
enrichment/specialised reads that Next's fetch cache dedupes.

---

## 7. Identity certification

`test/certification-live.test.ts` (`players` map comparison) + the 1B.1 GSIS
tests (`test/canonical-lineage.test.ts`) + §13 counts.

| Case | Result |
|---|---|
| normal offensive player | canonical `player:sleeper:<id>` (or `player:gsis:*` with a crosswalk); `/api/league` / weekly / manager-identity all key on the same Sleeper id, harness maps them to the same canonical player — **0 discrepancies** |
| kicker | same; `position: "K"`, `is_team_defense: false` — certified equal across surfaces |
| D/ST | canonical id `player:sleeper:<TEAM>` (e.g. `player:sleeper:HOU`), `identifiers.sleeper_id = "HOU"`, `is_team_defense: true`, `position: "DEF"` — `/api/league` `NormalizedPlayer.position = "DEF"` → harness `is_team_defense` derived and certified equal |
| GSIS-resolved player | with a crosswalk: `player:gsis:*`, `identifiers.sleeper_id` + `gsis_id` both populated; a bare GSIS id resolves to the same canonical player (`test/canonical-lineage.test.ts`) |
| unresolved player | `resolution.method: "unresolved"` surfaced in `unresolved_players`; **never** silently name-matched when a provider id exists — `PlayerCrosswalk.resolve` tries gsis → sleeper → yahoo id BEFORE any name fallback |
| player changed NFL team | `player.nfl_team` from the live player index; `player_data_version` hash changes; certified equal across surfaces (all read the same index) |
| player changed fantasy ownership | `snapshot.rosters` change → `starter_ids`/`all_player_ids` differ → `league_snapshot_id` changes; every surface's ownership view stays in lock-step (certified) |
| missing optional metadata | `first_name`/`last_name` null for a DST — not required (§4) |

**Live counts (§13):** `identity_unresolved = 0` for both leagues; every rostered
player resolves to a stable id. `identity_gsis = 0` in this environment (no
Supabase crosswalk configured — the honest degraded state; production resolves
to `player:gsis:*`). The invariant that matters — *different surfaces refer to
the same canonical player* — holds with **0 discrepancies**.

---

## 8. Scoring certification

`test/certification.test.ts` §4 + `test/canonical-lineage.test.ts` + live §13.

| Consumer | Scoring input | Certified |
|---|---|---|
| canonical `CanonicalLeague` | `raw_scoring` + `scoring_fingerprint` (`scoringFingerprint`) | reference |
| `/api/scoring` family | `canonicalScoringInputs(snapshot).scoring_settings` = `raw_scoring` verbatim | **byte-identical** to `getLeague().scoring_settings` (live) |
| season projection model (`leagueScoringContext`) | `getLeague().scoring_settings` + legacy `scoring_hash` **AND** the canonical `scoring_fingerprint` (added 1B.1) | fingerprint matches canonical (live smoke, 1B.1) |
| weekly context | `raw_scoring` via `snapshotOverride` / the same canonical read; `lineage.projections[].scoring_fingerprint == lineage.snapshot.scoring_fingerprint` | certified in `factsFromWeeklyContext` |
| trade context | `wctx.league.raw_scoring` (same canonical read) | snapshot-id parity with weekly (live) |
| lineup / waivers | via weekly context | same |

- **Semantically equivalent → same interpretation:** reordered keys + an
  explicit `fum_lost: 0` → identical `scoring_fingerprint` (tested).
- **Real change → detected:** `rec: 1` → `rec: 0.5` → different fingerprint,
  different `league_snapshot_id` (tested).
- **Legacy `hashScoringSettings` / `scoring_hash`** remains only as a
  compatibility field + the season model's cache key. It does **not** determine
  any internal scoring logic — `calculateFantasyPoints` is driven by
  `raw_scoring` / `scoring_settings`, never a hash. Retirement is a Phase 2+
  cleanup (freeze contract §17).

---

## 9. Roster / lineup eligibility certification

`test/certification.test.ts` §3 — the canonical slot machinery
(`lib/weekly/slots.ts`) is the single reference.

| Config | `flex_positions` (weekly) | `slotEligiblePositions()` | Match |
|---|---|---|---|
| standard `FLEX` | `["RB","WR","TE"]` | `["RB","WR","TE"]` | ✅ |
| `SUPER_FLEX` | includes `QB` | `["QB","RB","WR","TE"]` | ✅ |
| Yahoo `W/R/T` | `["WR","RB","TE"]` | `["WR","RB","TE"]` | ✅ |
| IR / bench / K / D-ST | canonical `roster_settings.{ir_slots,bench_slots}` + `starting_slots` | same across weekly, trade validation (1B.1 fix), migrated snapshot/identity routes | ✅ |
| missing/unknown eligibility | `canonicalPosition` → `"UNKNOWN"`; player never silently made flex-eligible | ✅ |
| vacant roster | `canonical_manager_ids: []`, empty roster arrays | ✅ (deterministic + live) |

Trade validation was aligned to `tctx.constraints` (slots.ts-derived) in 1B.1;
the migrated `/api/leagues/:slug/managers/:slug/snapshot` and identity route use
`reconstructRosterPositions` + `snapshot.rosters` — **no route hard-codes
eligibility.** `bloodline-bowl` starts `[QB,RB,RB,WR,WR,TE,FLEX,FLEX,K,DEF]` +
BN×5; `devoted-to-the-game` has a different `roster_fingerprint`
(`d50191e1…` vs `58bde6f9…`) — both certified against their own canonical state.

---

## 10. Freshness / scope certification

`test/certification.test.ts` §6 (concurrency) + `test/canonical-lineage.test.ts`
(1B.1 scope tests).

| Invariant | Result |
|---|---|
| repeated consumers in one scope → one canonical read | ✅ (`calls() === 1`; `runInLeagueStateScope` memo) |
| two concurrent scopes for the same slug → no leak | ✅ — each scope with different provider data yields a different `league_snapshot_id`; `AsyncLocalStorage` isolates the memo maps |
| two sequential independent scopes → can observe different provider state | ✅ (`calls() === 2`) |
| an error inside one scope → does not poison a later scope | ✅ (`assert.rejects` then a fresh scope succeeds) |
| nested scopes | ✅ — `runInLeagueStateScope` reuses an active parent scope (composes) |
| draft-night paths independent | ✅ — `lib/draft/*` / `manager-draft.ts` never call `buildCanonicalLeagueState`; `getLeagueRostersLive` is uncached; verified by the draft source-guard suite |
| no process-lifetime live-state cache | ✅ — grep: the only module-scoped cache is `buildBaseProjections` (season model, 6h TTL, 1B.1) — not live league state |

---

## 11. Snapshot identity certification

`test/certification.test.ts` §5 — the documented content-hash contract:

| Change | `league_snapshot_id` |
|---|---|
| none (identical material state) | **same** |
| roster ownership change (starters/all_players reordered) | **new** |
| lineup-only change (starter ⇄ bench) | **new** (lineup state IS in `snapshot.rosters`, which is hashed) |
| scoring change | **new** (+ new `scoring_fingerprint`) |
| **team-name metadata change** | **new** — `team.team_name` is in the hashed body. *Documented decision:* a team-name edit is a material change to canonical state and correctly produces a new id (it changes a certified fact). |
| provider-timestamp-only change (nested `provider_synced_at`) | **same** — stripped before hashing (1B.1) |
| non-material serialization / key-order change | **same** — `stableStringify` sorts keys recursively |

**Content-hash contract (final):** `snapshotContentHash` = `sha256` of the
stable-stringified snapshot **excluding** `captured_at`, `provider_synced_at`
(top-level and every nested `provenance.provider_synced_at`),
`live_provider_status`, `history_persistence_status`, `warnings`, and `lineage`
(derived). **Including** `schema_version`, the full `league` block (incl.
`raw_scoring`, `roster_settings`, `roster_positions_raw`, `scoring_fingerprint`,
`roster_fingerprint`), `season`, `week`, `managers`, `teams` (incl. `team_name`,
`provider_owner_id`, `record`), `rosters` (incl. `starters`/`bench`/`ir`/`taxi`),
`standings`, `matchups`, `recent_transactions`, `draft_picks`, `players`,
`unresolved_players`. `league_snapshot_id = snap:<slug>:<season>:w<week>:<first
16 hex>`.

---

## 12. Historical-boundary certification

`test/canonical-migration.test.ts` "historical continuity" + `test/persistence.test.ts`:

| Invariant | Result |
|---|---|
| old persisted snapshots still hydrate | ✅ — `hydratePersistedSnapshot` backfills `lineage` + `scoring_fingerprint` + `roster_fingerprint` for a schema-v1 payload; v3 fields (`roster_positions_raw`, `provider_owner_id`) stay `undefined` and adapters degrade (reconstruction; departed-owner `user_id` → null on a v1 row) |
| old `content_hash` remains valid | ✅ — stored hashes are kept for dedupe; `listVersions` (metadata only) unaffected |
| v1/v2/v3 readers tolerant | ✅ — all new fields optional in the type; `CANONICAL_SCHEMA_VERSION` pinned test updated to 3 |
| lineage backfill does not rewrite historical identity | ✅ — backfill is deterministic and read-only; no persisted row is mutated |
| current-state certification does not compare historical values as live | ✅ — the harness only ever calls `buildCanonicalLeagueState` (live) as its reference; it never reads `SnapshotStore` |
| history endpoints chronological + compatible | ✅ — `/api/history/:league/week/:week` unchanged (reads `listVersions`) |
| no retroactive history rewrite | ✅ — none performed |

---

## 13. Real Bloodline Bowl certification results

`node --import tsx scripts/phase1c-certify.ts` (live, 2026-09-06):

```
================ bloodline-bowl (1395549281678532608) ================
  snapshot_id                     snap:bloodline-bowl:2026:w1:2460db3559266e6a
  season                          2026
  week                            1
  status                          in_season
  managers                        14        (12 rosters + co-owners/commissioner)
  rosters                         12
  rostered_players                183
  vacant_teams                    0
  scoring_fingerprint             scoring:v1:29acc6bcd911df090b5b9b9c
  roster_fingerprint              roster:v1:58bde6f903a48abe18246dcd
  player_data_version             players:v1:d75bf7737fbf6ed3
  identity_resolved               185
  identity_gsis                   0        (no Supabase crosswalk in this env)
  identity_unresolved             0
  provider_reads_one_composite_op 1
  cross_surface_discrepancies     0
  null_required_fields            0

================ devoted-to-the-game (1389735763649761280) ================
  snapshot_id                     snap:devoted-to-the-game:2026:w1:22479a5b6e50687c
  season                          2026
  week                            1
  status                          in_season
  managers                        13
  rosters                         12
  rostered_players                195
  vacant_teams                    0
  scoring_fingerprint             scoring:v1:d4795fa723cdd12d9ba3bfb1
  roster_fingerprint              roster:v1:d50191e13dcb627dfbf64665
  player_data_version             players:v1:95f249436a6669e3
  identity_resolved               195
  identity_gsis                   0
  identity_unresolved             0
  provider_reads_one_composite_op 1
  cross_surface_discrepancies     0
  null_required_fields            0

================ TOTAL ================
  cross_surface_discrepancies     0
  null_required_fields            0
```

**`cross_surface_discrepancies = 0`** across 7 surfaces × 2 real leagues.
Every allowed difference is encoded in the harness (currently: none needed).
Free-agent counts are not reported — `waiver_state` materialisation is a
documented Phase 2 deferral (§18).

---

## 14. Second-league / synthetic coverage

- **Second live league:** `devoted-to-the-game` (real, registered) — a
  materially different league (distinct `scoring_fingerprint` and
  `roster_fingerprint`, different manager set). Certified with **0 discrepancies**,
  reducing overfitting to `bloodline-bowl`.
- **Synthetic coverage** for configs the two live leagues don't exercise:
  `SUPER_FLEX` and Yahoo `W/R/T` eligibility (`test/certification.test.ts` §3);
  departed-manager + vacant-roster (`§4` + `test/canonical-migration.test.ts`);
  `team_name` on the roster object vs the user object (§4); schema-v1 historical
  snapshot (§12).
- **Yahoo:** no Yahoo league is authorised. The Yahoo canonical adapter is wired
  (`roster_positions_raw`, `attachLeagueFingerprints`) and fixture-tested
  (`test/canonical-schema.test.ts`), but Yahoo live certification is a documented
  Phase 2 entry item (§18). This is an accepted limitation, not a defect.

---

## 15. Adversarial audit

Conducted after the harness was green.

| Probe | Result |
|---|---|
| canonical field from the wrong source object | `team_name` guard (§4) — 3 fixtures; live certified |
| stale field masked by a valid schema | `player_data_version` + `content_hash` change on any material metadata change; harness compares values not presence |
| conflicting manager IDs | one resolver (`lib/leagues/resolve.ts`); `owner_user_id` certified equal across canonical / `/api/league` / manager-snapshot / manager-identity / leagues-managers |
| conflicting team names | certified equal across all 5 team-expressing surfaces; `/api/league`'s own `normalizeManager` uses the same user-first precedence |
| ownership disagreement | `starter_ids` / `bench_ids` / `ir_ids` / `all_player_ids` certified equal (canonical vs `/api/league` vs weekly vs manager-identity) — **0** |
| raw provider ID leakage into canonical identity | canonical id is always `player:gsis:*` or `player:sleeper:*` (a namespaced canonical form) — never a bare Sleeper id; provider ids live in `identifiers` |
| missing D/ST mappings | every rostered DST resolved (`identity_unresolved: 0`); `is_team_defense` certified |
| K treatment inconsistencies | K `position: "K"` certified across surfaces; K/DST weekly projection approximation is documented (1B.1) and doesn't affect identity/eligibility |
| scoring hash misuse | `hashScoringSettings` is compatibility-only; no scoring math consumes it (grep + §8) |
| hidden provider fetches | §6 audit — every call site classified; category 7 = empty |
| accidental duplicate normalization | identity route fixed in 1C; harness certifies the result |
| cache / scope leakage | §10 concurrency test — no leak, no poison |
| week / status disagreement | `season` / `week` / `status` certified equal across every surface expressing them |
| historical / live state confusion | §12 — harness never reads persisted snapshots |
| compat adapter becoming a second normalizer | `harness.ts` / `extractors.ts` / `compat/*` do NO I/O and hold NO own logic — pure reshapes; golden `deepEqual` (1B.2) + live certify (1C) |
| endpoint payload change not guarded | every migrated route has a live smoke assertion on its response keys + a cross-surface certify entry |
| unresolved identity silently verified | `resolution.method: "unresolved"` is explicit; `cross_provider_verified` is `false` for a `player:sleeper:*` id; never treated as gsis-verified |

### Findings

| # | Sev | Finding | Status |
|---|---|---|---|
| **C-1** | **P1** | `/api/leagues/:slug/managers/:slug` independently re-split the roster into starters/bench/IR from raw Sleeper arrays (category 7). | **FIXED in 1C** — split now from `snapshot.rosters`; `getPlayerIndex` retained as bio-only enrichment; certified 0 discrepancies live. |
| **C-2** | **P2** | `devoted-to-the-game` has 13 `managers` for 12 `rosters` (a manager/commissioner with no roster). | expected — `CanonicalManager` list is `/users`, not `/rosters`. No dangling *team* reference. Documented; the departed-manager synthesise-entry improvement stays a Phase 2 nicety. |
| **C-3** | **P2** | `identity_gsis = 0` / `crosswalk_version = null` without Supabase configured — the cross-provider-verified identity path is not live-exercised here. | documented limitation; production has the crosswalk; the *within-provider* identity invariant (all surfaces → same canonical player) is fully certified. |
| **C-4** | **P3** | `hashScoringSettings` still shipped; `/api/transactions` `?league=` still a legacy alias; `buildSnapshot` still calls `buildLeagueBundle` for future-pick-asset counts. | tracked for Phase 2+ cleanup; none is a source-of-truth conflict. |
| **C-5** | **P3** | `waiver_state` is always `null` on the canonical snapshot (free-agent pool not materialised). | documented Phase 2 deferral; no surface currently claims a free-agent fact that could disagree. |

**No P0. C-1 (P1) fixed. C-2/C-3 (P2) documented + bounded. No open P0/P1.**

---

## 16. P0 / P1 / P2 / P3 table

| Sev | Item | Disposition |
|---|---|---|
| P0 | — | none |
| P1 | C-1 identity-route category-7 re-split | **FIXED** (commit on branch) |
| P2 | C-2 managers > rosters (co-owner/commissioner) | documented — not a conflict |
| P2 | C-3 no live GSIS crosswalk in this env | documented limitation — prod OK |
| P3 | C-4 `hashScoringSettings` / txn alias / snapshot's `buildLeagueBundle` | Phase 2+ cleanup |
| P3 | C-5 `waiver_state` null | Phase 2 (free-agent materialisation) |

---

## 17. Phase 1 Freeze Contract

**FROZEN as of this document.** Any semantic change to a rule below MUST re-run
Phase 1C certification (`scripts/phase1c-certify.ts` = 0, full regression green)
before merge.

### 17.1 Canonical source of truth
`buildCanonicalLeagueState(leagueSlug)` → `CanonicalLeagueSnapshot` is the sole
authoritative normalized live league state. It is built from exactly one
`FantasyProvider.getLeagueState` call and is immutable once returned.

### 17.2 Provider enrichment rule
Downstream code MAY perform a supplemental provider read ONLY to add
**non-overlapping, provider-native** detail (per-player NFL bio, future-pick
assets, live-draft picks, the NFL schedule feed, the projection feed). It MUST
NOT read the provider to re-derive any fact §17.4 lists as canonical-owned.

### 17.3 Overlap rule
Provider enrichment MUST NOT redefine a canonical-owned field. Where a surface
exposes a canonical-owned fact it MUST source it from the snapshot (directly or
via a `lib/canonical/compat/` adapter). The certification harness enforces this.

### 17.4 Canonical-owned facts (never independently re-derived)
league identity (`provider_league_id`), `season`, `week`, `status`, roster
settings (`starting_slots`, `bench_slots`, `ir_slots`, `taxi_slots`,
`slot_requirements`, `roster_positions_raw`), scoring (`raw_scoring`,
`scoring_fingerprint`), manager ↔ roster mapping, `owner_user_id` /
`provider_owner_id`, `manager.display_name`, `team.team_name`, `team.record` /
standings records, roster split (`starters` / `bench` / `ir` / `taxi` /
`all_players`), player `position` / `nfl_team` / `is_team_defense` /
`canonical_player_id`, current-week matchup opponent, `league_snapshot_id`.

### 17.5 Identity rule
`lib/canonical/players.ts#PlayerCrosswalk` is the sole player-identity resolver.
Resolution order: gsis id → sleeper id → yahoo id/key → name+position+team →
name+position → unresolved. A name fallback MUST NOT run when a provider id is
present. Unresolved identity is surfaced explicitly (`resolution.method`,
`unresolved_players`), never treated as verified.

### 17.6 Scoring rule
`lib/canonical/scoring-fingerprint.ts#scoringFingerprint(raw_scoring)` is the
authoritative scoring identity. `calculateFantasyPoints` (driven by
`raw_scoring` / `scoring_settings`) is the authoritative scoring math. Legacy
`hashScoringSettings` / `scoring_hash` are compatibility fields only and MUST NOT
drive any internal logic.

### 17.7 Snapshot lineage rule
Every engine result that derives from league state MUST carry
`RecommendationLineage` (`lib/canonical/lineage.ts`) echoing
`snapshot.league_snapshot_id` + the projection model versions it used. The
content-hash contract is §11.

### 17.8 Request-freshness rule
`runInLeagueStateScope(fn)` memoizes `buildCanonicalLeagueState` for one logical
operation only (`AsyncLocalStorage`, no TTL, unreachable after `fn` resolves).
Independent operations read fresh. **No process-lifetime cache of live league
state may be introduced.**

### 17.9 Historical boundary
Persisted snapshots, the transaction ledger, and everything under
`lib/analytics/{season-data,history,managers,historical-*}` are historical state,
**outside** live canonical state. `hydratePersistedSnapshot` backfills additive
fields on read; historical rows are never rewritten.

### 17.10 Draft-night freshness
`lib/sleeper/draft-service.ts`, `lib/draft/*`, `lib/leagues/manager-draft.ts`
and the `/api/draft*` / `recommendations` routes use uncached `*Live` provider
reads and MUST NOT be routed through `buildCanonicalLeagueState`.

### 17.11 Compatibility rule
`/api/league` and `/api/leagues/:slug` are **intentionally provider-native**
surfaces (Option C). They are documented as NOT a source of truth for internal
engines; every fact they share with canonical is certified. Any other
provider-native payload added later MUST meet the same §5 conditions.

### 17.12 Change-control rule
Future phases MAY extend `CanonicalLeagueSnapshot` **additively** (optional
fields, `CANONICAL_SCHEMA_VERSION` bump, reader tolerance via
`hydratePersistedSnapshot`). They MUST NOT create an alternate live-state
normalizer. A new current-state surface MUST source canonical-owned facts from
the snapshot and be added to the certification harness.

---

## 18. Exact regression results

- `npx tsc --noEmit` — **clean** (exit 0).
- `npx eslint app lib test` — **0 errors**, 18 warnings (all pre-existing on the
  1B.1 checkpoint; none introduced across 1B.1/1B.2/1C).
- `npm test` (full repository suite, `node --test`) —
  **1304 pass · 0 fail · 4 skipped**.
  - 1B.1 checkpoint: 1259 · 0 · 4. 1B.2: 1278 · 0 · 4. 1C: +26
    (`test/certification.test.ts` 20 subtests across 6 suites +
    `test/certification-live.test.ts` 6).
  - 4 skipped = the pre-draft-only live guarantees that self-skip while the
    league is `in_season` (unchanged since 1B.1; not weakened).
- Targeted suites all green: canonical (`canonical-schema`, `canonical-lineage`,
  `canonical-routing`, `canonical-migration`), weekly (`weekly-*`), lineup
  (`weekly-lineup`), waivers (`weekly-waivers`), trades (`trade-engine-*`),
  projections (`projections*`), scoring (`scoring*`), REST/API
  (`foundation-live`, `league-manager-routing*`, `available-player-*`),
  analytics (`analytics*`), persistence/history (`persistence`,
  `transaction-*`, `historical-*`), certification (`certification*`).
- Live smoke (real Bloodline Bowl + Devoted to the Game, network available) —
  `scripts/phase1c-certify.ts` exit 0; `certification-live` 6/6; all `*-live`
  suites green.

**No test was weakened to make certification pass.**

---

## 19. Remaining intentionally deferred items (post-freeze, Phase 2+)

1. **Yahoo live certification** — once a Yahoo league authorises. Adapter wired,
   fixture-tested.
2. **`waiver_state` / free-agent pool materialisation** on the canonical
   snapshot (C-5).
3. **Retire `hashScoringSettings` / `scoring_hash`** once the season projection
   model + `/api/leagues/:slug/projections` consume `scoringFingerprint` (C-4).
4. **`/api/transactions` (`?league=`) → alias of the canonical
   `/api/transactions/:league`** (C-4).
5. **`buildSnapshot`'s `buildLeagueBundle` dependency** — remove once canonical
   models future draft-pick assets, or accept it permanently as specialised
   analytics (C-4).
6. **Departed-manager synthesised `CanonicalManager` entry** — small nicety to
   drop `provider_owner_id` from the adapters (C-2).
7. **`/api/managers`, `/api/history`, `/api/standings`, `?league=` weekly-actuals**
   — remain on the historical/analytics stack by design; add *consistency*
   (not migration) certification if a future phase composes them with live data.

None blocks Phase 2.

---

## 20. Recommendation for Phase 2

Phase 1 delivers **one trustworthy live league reality**:
`CanonicalLeagueSnapshot`, built once per operation, immutable, lineage-stamped,
certified across every live surface with **zero cross-surface discrepancies** on
two real leagues, and bounded by a frozen contract (§17).

Phase 2 (the Matchup Model / R Football Intelligence Engine / ROS / Orchestrator)
should:

- consume `buildCanonicalLeagueState` via `runInLeagueStateScope` — never a
  provider directly for league state;
- carry `RecommendationLineage` on every output (§17.7);
- add any new current-state surface to `test/certification-live.test.ts`;
- treat the season projection model and the weekly projection provider as the
  two authoritative, separate projection sources (do not merge them);
- run `scripts/phase1c-certify.ts` as a CI gate (exit 0 required).

---

## Verdict

# PHASE 1 CERTIFIED — READY TO FREEZE

- Cross-surface certification harness built and **green** — 7 live surfaces,
  2 real leagues, **`cross_surface_discrepancies = 0`**, `null_required_fields = 0`.
- `/api/league` architecture **decided** (Option C — provider-native, no engine
  consumes it as state, every overlapping fact certified).
- Hidden-second-source audit complete — **zero category-7 paths** (the last one,
  the identity route, fixed in 1C).
- Identity, scoring, eligibility, freshness/scope, snapshot-identity, and
  historical-boundary all certified.
- No open P0 or P1. `tsc` clean, `eslint` 0 errors, **1304 / 0 / 4** regression,
  no test weakened.
- Phase 1 freeze contract documented (§17).

**The canonical-state contract is FROZEN.** STOP. Do not begin Phase 2.
