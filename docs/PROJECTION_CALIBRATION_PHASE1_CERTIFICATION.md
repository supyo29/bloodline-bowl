# Projection Calibration — Phase 1: Calibration Ledger Foundation (certification record)

Date: 2026-09-29. Branch `projection-calibration-phase1`. Phase 1 OBSERVES AND RECORDS; no projection value, weight, coefficient, floor/ceiling, FI/Start-Sit/Waiver/matchup logic or scoring behavior was changed.

## What exists

- Tables (additive, insert-only via trigger): `bridge_calibration_nfl_games` (game identity + authoritative kickoff), `bridge_calibration_football_outcomes` (ONE league-independent football reality per player-game: raw stats + digest), `bridge_calibration_cases` (one league translation per game/player/league/scoring fingerprint; explicit revisions; view `bridge_calibration_cases_current` = latest revision).
- `lib/calibration/*`: player-level kickoff evidence selection, pure case builder, metrics, reports, weather selection, materializer; routes `/api/cron/calibration-materialize` (CRON_SECRET, idempotent) and `/api/calibration/report` (read-only); weekly audit gains a `calibration_ledger` component composed FROM the granular cases (audit digest includes the ledger digest only when present, so pre-ledger audit ids are unchanged).
- Kickoff instants: Sleeper schedule carries dates only, so identity/status come from the Sleeper schedule and the kickoff INSTANT from ESPN's public scoreboard (joined by canonical team codes; a game with no instant fails closed).
- Evidence rule: latest valid projection recorded STRICTLY before that player's own game kickoff; ties: PROJECTION_SNAPSHOT before STARTSIT_CAPTURE, then artifact_id. Never per weekly artifact.

## Coverage (production read-back, current revisions)

### Week 2

NFL games: 16 total / 16 final. Ledger rows (all leagues): 3840. Status counts: `{"ACTUAL_SCORING_UNAVAILABLE": 15, "CERTIFIED": 37, "CERTIFIED_APPROXIMATE_SCORING": 7, "NO_PREKICKOFF_PROJECTION": 3781}`.

| League | Provider | Cases | With actual | With pre-kickoff projection | Certified (graded) | Bias | MAE | RMSE | Floor/ceiling coverage |
|---|---|---|---|---|---|---|---|---|---|
| bloodline-bowl | sleeper | 768 | 765 | 28 | 28 | -2.4625 | 3.8232 | 4.5579 | None (n=0) |
| devoted-to-the-game | sleeper | 768 | 765 | 16 | 16 | 0.2487 | 5.6637 | 7.9007 | None (n=0) |
| sportys-alumni | sleeper | 768 | 765 | 0 | 0 | None | None | None | None (n=0) |
| maclin-on-chicks-xvi | yahoo | 768 | 765 | 0 | 0 | None | None | None | None (n=0) |
| rogers-park | yahoo | 768 | 765 | 0 | 0 | None | None | None | None (n=0) |

Reconciliation of ledger actuals to provider team totals (starters, tolerance 0.05):

| League | Status | Rosters | Within tolerance | Within tolerance excl. K/DST provider-standard delta |
|---|---|---|---|---|
| bloodline-bowl | CHECKED | 12 | 0 | 12 |
| devoted-to-the-game | CHECKED | 12 | 11 | 12 |
| sportys-alumni | CHECKED | 14 | 13 | 14 |
| maclin-on-chicks-xvi | UNAVAILABLE | - | - | - |
| rogers-park | UNAVAILABLE | - | - | - |

### Week 3

NFL games: 16 total / 16 final. Ledger rows (all leagues): 3980. Status counts: `{"ACTUAL_SCORING_UNAVAILABLE": 20, "CERTIFIED": 1213, "CERTIFIED_APPROXIMATE_SCORING": 641, "NO_PREKICKOFF_PROJECTION": 2106}`.

| League | Provider | Cases | With actual | With pre-kickoff projection | Certified (graded) | Bias | MAE | RMSE | Floor/ceiling coverage |
|---|---|---|---|---|---|---|---|---|---|
| bloodline-bowl | sleeper | 801 | 797 | 466 | 465 | 0.2371 | 3.6575 | 4.9726 | 0.2412 (n=452) |
| devoted-to-the-game | sleeper | 801 | 797 | 464 | 463 | 0.2098 | 3.8219 | 5.2739 | 0.2765 (n=463) |
| sportys-alumni | sleeper | 801 | 797 | 464 | 463 | 0.2098 | 3.8219 | 5.2739 | 0.2765 (n=463) |
| maclin-on-chicks-xvi | yahoo | 776 | 772 | 0 | 0 | None | None | None | None (n=0) |
| rogers-park | yahoo | 801 | 797 | 464 | 463 | 0.1512 | 3.4711 | 4.8098 | 0.2641 (n=462) |

Reconciliation of ledger actuals to provider team totals (starters, tolerance 0.05):

| League | Status | Rosters | Within tolerance | Within tolerance excl. K/DST provider-standard delta |
|---|---|---|---|---|
| bloodline-bowl | CHECKED | 12 | 0 | 12 |
| devoted-to-the-game | CHECKED | 12 | 12 | 12 |
| sportys-alumni | CHECKED | 14 | 14 | 14 |
| maclin-on-chicks-xvi | UNAVAILABLE | - | - | - |
| rogers-park | UNAVAILABLE | - | - | - |

Where a roster misses tolerance the entire gap is the K/DST approximation (Sleeper standard points vs the league's custom K/DST scoring): with that delta removed every checked Sleeper roster in both weeks reconciles (Week 2: 12+12+14 of 12+12+14; Week 3: 12+12+14 of 12+12+14). Devoted-to-the-game and Sporty's Alumni reconcile exactly in Week 3.

## Adversarial checks (production)

- Hindsight violations across all current cases: 0 (`projection_recorded_at >= kickoff_at`).
- ATL-GB (Thu 2026-09-25T00:15Z): Jordan Love and Green Bay DST (Bloodline Bowl) use Start/Sit capture `ssc:fe60cbcb...` recorded 2026-09-24 04:40Z. Other leagues have no earlier evidence -> `NO_PREKICKOFF_PROJECTION` (the 09-26 23:48Z snapshot is NOT used). GB DST is `CERTIFIED_APPROXIMATE_SCORING` (provider-standard K/DST).
- Sunday/Monday cases select per-kickoff snapshots (09-27 14:17Z for 1pm games, 09-27 19:59Z for the 4pm/SNF/MNF games).
- Certified cases without an artifact: 0; certified error != actual - projected: 0; uncertified cases carrying an error: 0; K/DST marked exact: 0; unresolved identities: 0.

## Known limitations

- Week 2 has NO durable projection snapshots (the snapshot tables date from 2026-09-26); Week 2 pre-kickoff evidence exists only via Start/Sit captures, so Week 2 graded coverage is small (44 certified cases). Nothing was reconstructed.
- Yahoo: projection evidence exists for rogers-park only (Week 3, approximate: Yahoo scoring has unmapped stat(s)); maclin-on-chicks-xvi has no projection snapshots (canonical snapshot integrity REJECTED for 5 unmapped Yahoo scoring stats). Yahoo actuals are scored with the Yahoo league's canonical scoring from provider-neutral football stats, marked `LEAGUE_EXACT_WITH_UNMAPPED_STATS`/approximate. Yahoo team-total RECONCILIATION IS NOT AVAILABLE for Weeks 2/3 (no retrievable/persisted Yahoo week totals) -> Yahoo parity is NOT certified. `/api/player-weekly` for Yahoo leagues now returns a clear 400 `provider_not_supported` instead of an opaque 500. Follow-up: persist Yahoo weekly matchup snapshots so ledger reconciliation is possible.
- K/DST: projections and actuals are Sleeper standard points, flagged `PROVIDER_STANDARD_APPROXIMATION`; never league-exact.
- Weather: `nfl_game_weather_snapshots` has 30 rows, all season 2025; no 2026 forecasts exist. The ledger can reference a pre-kickoff snapshot (retrieved < kickoff) but none exists for 2026; nothing manufactured.
- Start/Sit-capture evidence carries a baseline only (no floor/ceiling/std/availability/injury); those cases have `range_status=RANGE_UNAVAILABLE`.
- `PLAYED_PARTIAL_EXIT` is reserved; Sleeper stats cannot distinguish an in-game exit from a low-snap role (`PLAYED_LOW_SNAP_SHARE` is a descriptive flag only). Team for players with stats but no projection comes from the crosswalk identity (current team).
- Canonical ids are whatever the projection crosswalk provided (sleeper-form and gsis-form ids coexist; see Temporal Identity phase note). The ledger does not change identity.

## One-time data remediation (recorded for audit)

The first Week 2 materialization wrote 1,405 `UNRESOLVED_IDENTITY` cases (+281 `unresolved:*` football outcomes): Week 2 has no snapshot rows, so no identity map existed. The first fix (borrow crosswalk identities from another week) was incomplete — Start/Sit capture identities suppressed the fallback — and a re-run recreated the same cohort. Each cohort was removed with a single atomic, assertion-guarded transaction (user-approved): predicate = season 2026, week 2, `unresolved:%`, exact `generated_at`, revision 1, status `UNRESOLVED_IDENTITY`; expected 1,405 cases / 281 outcomes asserted before and after (abort otherwise); only the two named immutability triggers disabled and re-enabled inside the transaction; Week 3 and other rows asserted unchanged; immutability re-verified afterwards (UPDATE and DELETE blocked). Root cause fixed with regression tests (`resolveWeekIdentities`). A third fix added a provenance-enrichment revision: 370 pre-existing Week 2 cases (from capture-only identities) were superseded once by explicit revision 2 rows carrying name + provider ids. No production endpoint permits deletion; insert-only design is unchanged.
