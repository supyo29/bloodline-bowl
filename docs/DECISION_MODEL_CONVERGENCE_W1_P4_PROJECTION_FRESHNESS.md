# Decision Model Convergence — Wave 1, Phase 4: Projection Freshness, Event Invalidation & Multi-League Source Capture

**Verdict: CERTIFIED WITH DOCUMENTED LIMITATIONS (fixture-certified for all five registered leagues; live validation BLOCKED for all five in this environment).**
This is not a production certification. Nothing is pushed, merged or deployed. The migration `20261008120000_projection_freshness_w1p4.sql` is **not applied** anywhere.

> The model cannot be more current than its evidence.

## 1. W1.P3 baseline

Base: `89e22ad` (W1.P3), on top of `68fc482` (W1.P2) and `ab7dce3` (W1.P1). W1.P3 full suite: **3240 tests / 2802 pass / 127 fail / 257 cancelled / 54 skipped**; lint 39 warnings / 0 errors.
The 157 top-level failing names of that run are saved (`p4_base_fail.txt`) and are pre-existing (network-dependent live suites, etc.).

## 2. Registered league inventory (from `lib/leagues/registry.ts`, discovered by test)

| key | display | provider | external id | config status |
|---|---|---|---|---|
| bloodline-bowl | Bloodline Bowl | sleeper | 1395549281678532608 | READY |
| devoted-to-the-game | Devoted to the Game | sleeper | 1389735763649761280 | READY |
| sportys-alumni | Sporty's Alumni | sleeper | 1389404340015370240 | READY |
| maclin-on-chicks-xvi | Maclin on Chick's XVI | yahoo | 82713 | LIVE_VALIDATION_REQUIRED |
| rogers-park | Rogers Park | yahoo | 287140 | LIVE_VALIDATION_REQUIRED |

## 3. Provider inventory

- **Projection source (the only one):** Sleeper's weekly NFL projection feed (RotoWire-backed), segmented by position, via `lib/sleeper/client.ts`. It is *NFL-player* data, not a Sleeper fantasy object, so Yahoo leagues read the same feed through the canonical crosswalk (`getWeeklyProjectionProvider` ignores the league provider).
- **Schedule/kickoff:** Sleeper schedule (identity/status) + ESPN scoreboard (kickoff instant), `lib/nfl-schedule/games.ts` (moved from `lib/calibration/games.ts`, re-exported; see §21).
- **Official inactives:** no supported production source exists. A seam (`OfficialInactiveSource`) is defined; nothing is fabricated.
- **Yahoo:** league/roster state needs OAuth; projections need none.

## 4. Freshness audit (findings)

1. **Effective staleness up to ~120 minutes.** The Sleeper client cached the feed for 30 minutes; a snapshot built from that cache was stamped "observed now"; the snapshot pointer was then served for another 90 minutes. Worst case: 30 + 90 = **~120 minutes of source staleness presented as fresh**.
2. **F6 — no source timestamp.** `source_observed_at` was always `null`; "age" meant age of the snapshot pointer.
3. One **universal** 90-minute window regardless of kickoff, injury relevance or events.
4. Snapshot scope is per league; the underlying client cache is process-wide and path-keyed (shared across leagues, correctly, but invisible).
5. The cron warms **Sleeper leagues only**; Yahoo leagues warm on request.
6. Roster-health makes its own provider read (F5; see §10).

## 5. Old cache policy

`PROJECTION_SNAPSHOT_MAX_AGE_MS = 90 min` compared against `now − pointer.observed_at` (snapshot write/confirm time). Copying old data into a new snapshot reset the age. Removed. A ratchet test forbids its return.

## 6. New dynamic freshness policy (`lib/weekly/freshness/policy.ts`, the single authority)

Pure; clock injected; absolute UTC instants only (no timezone assumption). Version `projection-freshness-2026.1`.

| tier | time to kickoff | required max SOURCE age |
|---|---|---|
| EARLY_WEEK | > 72 h | 6 h |
| MIDWEEK | 24–72 h | 3 h |
| GAME_DAY_FAR | 6–24 h | 60 min |
| GAME_DAY_NEAR | 90 min–6 h | 30 min |
| FINAL_PREGAME | 15–90 min | 15 min |
| KICKOFF_IMMINENT | < 15 min | 5 min |
| KICKOFF_UNKNOWN | unresolvable | 30 min (conservative, never "far away") |
| GAME_STARTED | ≤ 0 | none — forecast **FROZEN_PREGAME** |

Floor 2 min (rate protection). **Injury tightening** (Questionable/Doubtful/unrecognised, never loosens): ≤6 h → 15 min; ≤24 h → 30 min; ≤72 h → 2 h. A league-wide batch is always treated as injury-uncertain. Fallback retention for a failed refresh: 48 h.
States: `FRESH | STALE | UNKNOWN | FROZEN_PREGAME`. Unknown observation time is `UNKNOWN`, never assumed fresh. An observation *after* kickoff is `UNKNOWN / POST_KICKOFF_OBSERVATION` and can never be a pregame forecast. **Tier values are engineering judgement, not empirically derived** — exposed for tuning against the history this phase starts to collect.
Warning prose is derived from machine fields, e.g. *"Projection last observed 47 min ago. Because kickoff is in 18 min, this forecast is outside the FINAL_PREGAME freshness threshold (15 min)."*

## 7. Source-observation semantics

Four distinct times, never interchangeable: `source_observed_at` (Bloodline fetched the upstream source), `snapshot_created_at` (pointer written), `forecast_composed_at`, and kickoff/event instants. `source_observed_at` is the **oldest READY segment's fetch instant** (conservative), taken from `fetched_at`/`cache_hit` now exposed by the client at the ingestion boundary. It is *not* a claim about when RotoWire changed a value. It is never set from snapshot time. It lives in batch/pointer metadata, not in the hashed projection rows (that would break content-addressed dedupe).

**Regression proof of the ~120-minute fix** (`test/projection-freshness-lifecycle.test.ts`): a snapshot written *now* from a 10-minute-old cached source reports `age = 10 min` and `source_observed_at = t0−10m`; the same data 90 minutes old at the source is **not** served from a snapshot written 80 minutes ago (legacy rule would serve it); the store refuses to let a 100-minute-old source be served on the strength of a fresh pointer; a re-wrapped older payload can never move the pointer's source instant backwards. Mutations M2 and M9 break exactly these.

## 8. Persistence / history architecture

Tables (migration, additive, RLS on, service-role only): `bridge_projection_latest` + `source_observed_at`, `source_observation_id` (nullable; the store tolerates their absence until applied and treats legacy pointers as source-time UNKNOWN); `bridge_projection_source_observations` (headers), `…_observation_rows`, `…_source_latest`, `…_source_events`, `bridge_final_pregame_forecasts`.
**League-independent facts only**: raw stat lines, verbatim injury designation, team/opponent, games-played flag. No league-scored points, no scoring fingerprint — five leagues share one observation.
**Capture (change-only):** same fetch seen again → nothing; payload unchanged since last recorded state → a confirmation *touch* of the latest pointer (no history rows); first observation or ≥24 h since the last FULL anchor → **FULL**; otherwise **DELTA** (only materially-changed players + tombstones for players that left the feed). Materiality: a non-stat field change, a stat key added/removed, or any stat moving ≥ `STAT_EPSILON = 0.05` against the **last recorded** value (sub-epsilon drift accumulates, never lost). Replay is bounded by the daily FULL anchor. Appends are idempotent; capture failure never blocks projections and may be retried.

## 9. Event invalidation

Types: `INJURY_STATUS_CHANGE, PLAYER_INACTIVE, OFFICIAL_INACTIVE, TRANSACTION_IR_PUP, TEAM_CHANGE, GAME_POSTPONED_OR_CANCELLED, OPPONENT_CHANGE, KICKOFF_CHANGE, PROJECTION_SOURCE_UPDATE, MATERIAL_PROJECTION_CHANGE, DEPTH_CHART_CHANGE, BYE_CORRECTION`. Scopes, narrow→broad: `PLAYER < TEAM < GAME < SOURCE_SNAPSHOT`; `LEAGUE_DERIVATIVE` orthogonal. Authority: OFFICIAL > PROVIDER_STATUS > DERIVED_FROM_OBSERVATION > MANUAL. Matching is provider-neutral (sleeper_id / yahoo_id / yahoo_player_key / canonical id). An event whose `known_at` is later than a forecast's source observation supersedes it regardless of age; one already incorporated does not.
**Live event sources today:** diffs between consecutive observations (the provider feed is the only live status source) and the official-inactive seam (no production feed). Everything else is contract only.

## 10. Request-scoped consistency (and F5)

Inside a request scope the segment fetch is shared; a league/week/scoring batch resolves **once**; each caller receives a `structuredClone` of a pristine memo (downstream in-place mutation cannot leak into another section); the key includes a content hash of the requested player ids. A forecast-set identity (`identity.ts`) separates league-independent source observation from league-specific scoring fingerprint and lineage.
**F5 decision: NOT fully removed; deferred, with exact reason.** Roster-health's read cannot reuse the weekly-context batch because their requests differ in `request_fingerprint` (the weekly context carries kickoff-return enrichment inputs; roster-health does not), so the scored batches legitimately differ (KR yards add points). Merging them would change roster-health values. What *is* now eliminated: the duplicate **source** work — both reads rest on one upstream fetch and one source observation (test: no second fetch, identical `source_observed_at`, distinct artifact ids, one observation recorded). Removing the remaining duplicate scored read needs an orchestrator reorder (build weekly context first, then derive roster-health from it) — a separate remediation phase.

## 11. League-scoped consistency

Scored values are league-scoped (pointer key = league + season + week + scoring fingerprint + request fingerprint). Test with the five registry leagues: 1 upstream fetch set, 1 observation, identical `source_observed_at` across all five; the same WR (6 rec, 80 yd, 0.5 TD) scores differently per scoring (Bloodline Bowl PPR 17.0 / Devoted half-PPR 14.0 / Sporty's 1.5-per-reception 20.0 / Maclin and Rogers Park standard 11.0 — each asserted exactly in the test); Maclin and Rogers Park share a scoring fingerprint yet keep separate pointers; league A's read never returns league B's artifact.

## 12. Sleeper behavior

All three Sleeper leagues: fixture-validated end to end (shared observation, own scoring, own pointer). Cron warms their league-scored artifacts. Live: BLOCKED.

## 13. Yahoo behavior

Yahoo leagues read the same NFL feed; no Sleeper id is required by generic freshness/event logic (Yahoo-keyed and Yahoo-only players are matched by `yahoo_id`/`yahoo_player_key`/canonical id; M6 breaks this). Their league-scored artifact needs authenticated Yahoo state; the cron does **not** attempt it (unvalidated here) and now reports them under `skipped` instead of omitting them. They warm on first request. Live: BLOCKED.

## 14. Final-pregame capture

Final = the valid (`observed_at ≤ kickoff`) observation with the greatest `observed_at`. Demonstration (`test/final-pregame.test.ts`, mirrored on the Supabase store):

| observation | T−24h | T−3h | T−45m | T−10m | T+5m |
|---|---|---|---|---|---|
| outcome | recorded | recorded | recorded | **recorded (final)** | REJECTED_POST_KICKOFF |

→ frozen record = **T−10m** (`seconds_before_kickoff = 600`); a late older candidate is `REJECTED_OLDER_OBSERVATION`; identical later content only `CONFIRMED`s (extends `confirmed_through`, keeps first-observed). Records are league-scoped and carry source/model/scoring provenance. DB `CHECK` constraints against post-kickoff rows exist in the migration but were **not exercised against a real Postgres**.

## 15. W1.P2 λ-data strategy

W1.P2 still uses the λ = 0.5 assumption for sources of unknown injury semantics; **λ and the priors are untouched** (the files are byte-identical to `89e22ad`). What W1.P4 adds is the evidence to estimate it: per-observation provider projection + verbatim injury designation, with transitions as events. For a player who moves Healthy → designated X within a week, with pre-designation projection `S_pre`, post-designation `S_X` and prior active probability `p_X` (existing priors), the source embeds risk in proportion λ̂ = (1 − S_X/S_pre) / (1 − p_X): λ̂≈0 means the source projects conditional-on-active, λ̂≈1 unconditional. Aggregating over many transitions per designation (and checking against realised outcomes via the existing calibration ledger and the frozen final-pregame rows) yields a real estimate. **No estimate is made in this phase**; it needs a season of accumulated history.

## 16. Storage implications (estimate — assumptions, not measurements)

Assume ~1,800 players per weekly feed, ~300 B/row → a FULL anchor ≈ 0.54 MB. Upper bound ~150 upstream fetches/week (request-driven; there is no scheduler). A naive store-every-fetch design ≈ 150 × 0.54 = ~81 MB/week ≈ **1.5 GB/season**. Change-only design: ≤1 FULL/day (7 × 0.54 = 3.8 MB) + ~60 DELTAs × ~50 changed rows × 300 B ≈ 0.9 MB → **~4.7 MB/week ≈ 85 MB/season** (×~1.5 Postgres/index overhead ≈ 130 MB), ~17× smaller. Events: ~2 per material change ≈ 6,000/week ≈ 1.8 MB/week ≈ 32 MB/season. Final pregame: ~500 rows × 5 leagues × 18 weeks × ~1.2 KB ≈ 54 MB/season (one frozen row per league/player/week; confirmations update in place). Unchanged re-observations cost one pointer update and zero history rows. Test-proven: 4 observations of a 40-player feed with 2 changes + 1 tombstone write 43 rows, not 160.

## 17. Tests

New (94): `freshness-policy` 26, `projection-observation-history` 14, `final-pregame` 8, `projection-observation-supabase` 7, `projection-freshness-lifecycle` 13, `multi-league-freshness` 7, `freshness-events` 11, `freshness-architecture` 8; plus `test/fixtures/fake-rest.ts` (deterministic PostgREST stand-in with the 1,000-row page cap). Updated (deliberately): `canonical-weekly-forecast`, its architecture test, `projection-architecture-guard`.
**Full suite: 3334 tests / 2896 pass / 127 fail / 257 cancelled / 54 skipped** (W1.P3: 3240 / 2802 / 127 / 257 / 54). The top-level failing set is **identical by name to the W1.P3 baseline (157 names; 0 new, 0 fixed)**. `tsc --noEmit` clean; lint **39 warnings / 0 errors** (= baseline); `next build` passes.
W1.P2 regressions (injury EV, OUT semantics, null=unknown, contribution ledger, priors/λ untouched): `injury-*` and `calibration-ledger` suites pass. W1.P3 regressions (bye current-week zero, valuable bye asset protected, marginal bye droppable, bye/injury separation, no stale `is_bye`): `bye-asset-preservation` passes; `bye.ts`, `view.ts`, `lineup.ts`, waiver code unchanged. Legacy direct-reader count: **28 → 28** (ratchet only shrinks).

## 18. Mutations (`scripts/w1p4-mutation-suite.py`; files restored byte-for-byte; baseline 140/140 green)

| | mutation | result | killed by |
|---|---|---|---|
| M1 | restore universal 90-minute TTL | KILLED (4) | near-kickoff, early-week, unknown-kickoff, 120-min regression |
| M2 | snapshot/pointer time replaces source time in the age gate | KILLED | store-rejuvenation regression |
| M3 | failed refresh treated as fresh | KILLED | failure-semantics + warning tests |
| M4 | post-kickoff observation may replace final pregame | KILLED | T−N demo (memory + Supabase) |
| M5 | batches shared across different scoring | KILLED | scoring-isolation test |
| M6 | generic logic requires a Sleeper id | KILLED | Yahoo neutrality tests |
| M7 | one player event invalidates everything | KILLED (4) | targeted-scope tests |
| M8 | identical observations recorded repeatedly | KILLED | history + Supabase row-count tests |
| M9 | snapshot-created time presented as source time | KILLED | 120-min regression |
| M10 | wall clock inside the policy | KILLED (13) | injected-clock tests |

10/10 killed, 0 survivors, no waivers.

## 19. Live validation results by league

`scripts/projection-freshness-smoke.ts` (read-only: memory store, no snapshot store, no writes). In this environment Sleeper returns **403 at the egress proxy** (`/state/nfl`), so nothing past NFL state is reachable.

| league | provider | live |
|---|---|---|
| Bloodline Bowl | sleeper | LIVE_VALIDATION_BLOCKED |
| Devoted to the Game | sleeper | LIVE_VALIDATION_BLOCKED |
| Sporty's Alumni | sleeper | LIVE_VALIDATION_BLOCKED |
| Maclin on Chick's XVI | yahoo | LIVE_VALIDATION_BLOCKED |
| Rogers Park | yahoo | LIVE_VALIDATION_BLOCKED |

Blocked is neither a pass nor a fail. Nothing live is claimed.

## 20. Fixture validation results by provider (`test/multi-league-freshness.test.ts`, `projection-freshness-lifecycle`)

| league | provider | fixture validation | freshness | canonical identity | scoring isolation | **result** |
|---|---|---|---|---|---|---|
| Bloodline Bowl | sleeper | PASS | shared obs, tier-gated | same canonical ids | own pointer/points | LIVE_VALIDATION_BLOCKED (fixture PASS) |
| Devoted to the Game | sleeper | PASS | same | same | own | LIVE_VALIDATION_BLOCKED (fixture PASS) |
| Sporty's Alumni | sleeper | PASS | same | same | own | LIVE_VALIDATION_BLOCKED (fixture PASS) |
| Maclin on Chick's XVI | yahoo | PASS (NFL feed path) | same | no Sleeper id needed | own (shares fingerprint with Rogers Park, separate pointer) | LIVE_VALIDATION_BLOCKED (fixture PASS) |
| Rogers Park | yahoo | PASS (NFL feed path) | same | same | own | LIVE_VALIDATION_BLOCKED (fixture PASS) |

Fixture scoring uses representative per-league scoring objects, **not** each league's real settings (which need live state).

## 21. Known limitations

- Live validation blocked for all five leagues; real league scoring, Yahoo OAuth state and the real ESPN kickoff source are unvalidated live. Yahoo league-scored artifacts are not cron-warmed.
- Migration not applied; DB CHECK constraints and PostgREST filter semantics were tested only against the in-memory `FakeRest`.
- No scheduler: observations occur on request or cron, so a quiet league produces few observations; tier values are untuned judgement.
- No production official-inactives feed; the 90-minute pregame inactive list is not ingested.
- F5 scored-batch duplication remains (§10).
- The cron is still Sleeper-only (now explicit via `skipped`).
- Refactor note: `lib/calibration/games.ts` content moved to `lib/nfl-schedule/games.ts` (re-exported) so `lib/weekly` need not import `lib/calibration`, preserving that earlier phase's import ratchet unweakened.
- Deferred to later phases: Role & Opportunity promotion, Game Environment, Market State / replacement convergence, K/DST weekly model, forward ROS (bye hold value is still the ROS÷weeks proxy), Waiver Engine 3.0, Drop/Keep rebuild, trade convergence.

## 22. Wave 1 completion status

W1.P1–W1.P4 are code-complete and individually tested on one lineage (`ab7dce3 → 68fc482 → 89e22ad → W1.P4`). They are **ready for integration review and a preview/staging deployment** (with the migration applied there and the live smoke re-run from an environment that can reach Sleeper, ESPN and Yahoo). They are **not production-certified**. No merge or deploy was performed.
