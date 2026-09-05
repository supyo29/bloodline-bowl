# Bloodline Bowl Trade Engine — Phase 3.5 Completion Pass

Phase 1 foundation: **`ri-trade-foundation-2026.2`** (frozen)
Phase 2 contextual layer: **`ri-trade-contextual-2026.2`** (frozen)
Phase 3 calibration/player-intelligence: **`ri-trade-calibrated-2026.2`** (frozen — value contract untouched by this pass)
Phase 3.5 data-enablement layer: **`ri-trade-data-2026.1` → `ri-trade-data-2026.2`** (completion pass)

This pass discovered that, contrary to the prior Phase 3.5 pass's assumption,
**this environment DOES have outbound network access**, and R + `nflreadr` +
`dplyr`/`tidyr`/`jsonlite` **are installed**. That correction is the reason
this pass could go from "framework only" to "framework + real data,"
verified live against the actual Sleeper API and actual nflverse data.

## A. Architecture (actual, as built)

```
Sleeper API (real, read-only)              nflverse (real, via {nflreadr})
        |                                            |
scripts/ingest-sleeper-historical-       analysis/phase35_usage_pipeline.R
  trades.ts                                analysis/phase35_schedule_pipeline.R
   - walks previous_league_id chains         - load_player_stats / load_snap_counts
   - pulls every week's transactions          / load_schedules / load_ff_playerids
   - filters type=="trade", complete          - real gsis<->sleeper<->pfr crosswalk
   - chronological replay for pre-trade       - writes versioned CSV + .meta.json
     ownership (draft -> every txn in order)
        |                                            |
        v                                            v
lib/trades/data/historical_trades_       lib/trades/data/player_usage_weekly.csv
  sleeper.json (versioned, committed)      lib/trades/data/player_schedule_strength_
                                              weekly.csv (versioned, committed)
        |                                            |
        v                                            v
lib/trades/historical-loader.ts          lib/trades/r-data-providers.ts
  -> HistoricalTradeRecord[]                -> createRUsageProviderAsOf(season, asOfWeek)
  -> assertNoLookahead (unchanged,             -> createRScheduleProviderAsOf(season, asOfWeek, ...)
     from Phase 3)                             (structural as-of-week look-ahead guard)
        |                                            |
        +--------------------+-----------------------+
                              v
              lib/trades/intelligence.ts::buildPlayerIntelligence(id, ctx, providers?)
                              |
                              v
                    Phase 3 PlayerIntelligence (diagnostic-only)
                              |
                              v
              *** evaluatePhase3Participant NEVER passes real providers ***
              *** it always uses DEFAULT_PLAYER_INTELLIGENCE_PROVIDERS  ***
              *** (the NULL providers) — see §J                        ***
                              |
                              v
                    SHADOW-ONLY output (unchanged)
```

The real data flows all the way from Sleeper/nflverse into tested,
file-backed TypeScript providers. It stops one hop short of the live
`POST /api/trades/analyze` path **by design** — see §J. Real data today is
for offline historical/backtest research (tests, scripts), not live requests.

## B. Historical Sleeper data (real)

```
Sleeper leagues scanned:                2  (bloodline-bowl, devoted-to-the-game — the
                                             two Sleeper-provider entries in
                                             lib/leagues/registry.ts; the other two
                                             registry entries are Yahoo, out of scope)
Sleeper league-seasons scanned:         3  (bloodline-bowl 2026; devoted-to-the-game
                                             2026 and 2025 — walked via previous_league_id;
                                             bloodline-bowl's previous_league_id is null,
                                             it is a brand-new league with no prior season)
real completed trades found:            1  (devoted-to-the-game, season 2025, week 4)
2-team trades:                          1
3-team trades:                          0
trades with unsupported (non-PLAYER) assets:  0
records with complete pre-trade ownership reconstruction: 1 / 1 (100%)
records with exact transaction timestamps:                1 / 1 (100%)
records with usable historical PROJECTIONS:               0 / 1 (see §I — out of scope this pass)
records with usable historical USAGE data:                pending §E wiring below
```

The one real trade: roster 3 <-> roster 10, players `7049` and `12512`,
`2025-09-27T19:01:46.369Z`. Pre-trade ownership for **every** roster in the
league (not just the two participants) was reconstructed by replaying every
complete `trade`/`waiver`/`free_agent` transaction from the 2025 draft
(`draft_id` resolved live) forward, stopping strictly before this
transaction's sort key. `lineup_status: LINEUP_UNKNOWN` on every record —
Sleeper's roster `starters` field only reflects the CURRENT state, never a
historical point in time, and no historical lineup was invented.

**Do not oversell this**: 1 real trade is the entire population currently
available across both registered Sleeper leagues. Bloodline Bowl has zero
Sleeper trade history because it is a brand-new league.

## C. Usage source (real)

```
Source:            nflverse, via {nflreadr} (already a dependency of this
                    repo's analysis/phase3_fetch_data.R — reused, not
                    reimplemented)
R packages:         nflreadr, dplyr, tidyr, jsonlite (all pre-installed)
Functions used:      load_player_stats(seasons, summary_level="week"),
                    load_snap_counts(seasons), load_ff_playerids()
Metrics (real):     snaps, snap_share, targets, target_share, carries,
                    rush_share (computed here: team-week carry share —
                    nflverse doesn't ship one directly), receptions
Metrics NOT available from these sources (left NA, never fabricated):
                    routes, route_participation, red_zone_targets,
                    red_zone_carries, goal_line_carries, dropbacks,
                    designed_rushes, scrambles (these need nflfastR
                    play-by-play participation data — a heavier pull,
                    deferred; see §K)
Coverage:           6,037 real player-weeks, season 2025, weeks 1-18,
                    positions QB/RB/WR/TE. 6,031 / 6,037 (99.9%) resolved to
                    a real sleeper_id via nflreadr::load_ff_playerids'
                    gsis_id<->sleeper_id crosswalk (no name-only matching).
History depth:      1 season (2025 — the most recent COMPLETE season; the
                    2026 season has played ZERO games as of this pipeline
                    run, so nflreadr returns zero 2026 rows — a real,
                    verifiable fact tied to today's date, not an environment
                    limitation)
Refresh cadence:    manual (`Rscript analysis/phase35_usage_pipeline.R`);
                    append-safe (full season history retained, not
                    latest-week-only)
Output contract:    lib/trades/data/player_usage_weekly.csv +
                    player_usage_weekly.meta.json (data_version
                    "ri-usage-weekly-2026.1")
```

## D. Schedule source (real)

```
Source:             nflverse, via {nflreadr}
Functions used:      load_player_stats (real fantasy_points_ppr allowed by
                    position), load_schedules
Methodology:        points-allowed-by-position, percentile-normalized across
                    that week's 32 teams, rescaled to [-1, +1]. This is the
                    SIMPLER proxy the completion spec explicitly permits when
                    a stronger source isn't available — no EPA-adjusted or
                    DVOA-equivalent defensive metric is computed. Documented
                    as a real limitation, not hidden.
Orientation:        positive = EASIER/favorable matchup for that position
                    that week; negative = harder. Fixed and documented.
Coverage:           2,176 real team x opponent x position x week rows,
                    season 2025, weeks 1-18, QB/RB/WR/TE only (K/DST not
                    modeled). 2,174 / 2,176 (99.9%) resolved a matchup_score.
League-agnostic:    YES — the table has no Bloodline-specific settings baked
                    in (no playoff window, no bye weeks, no season length);
                    the bridge combines these raw rows with league settings
                    (see `lib/trades/r-data-providers.ts`'s
                    `buildTeamPositionResolverFromUsage` + the `asOfWeek`
                    cutoff — the actual league-specific combination step,
                    e.g. remaining-schedule aggregation over a specific
                    league's playoff window, is deferred; see §K).
Historical snapshot support: `createRScheduleProviderAsOf(season, asOfWeek)`
                    — the SAME structural as-of-week cutoff mechanism as
                    usage, so a Week 4 evaluation can never see Week 12's
                    (already-evolved) defensive-strength estimate.
Refresh cadence:    manual (`Rscript analysis/phase35_schedule_pipeline.R`)
Output contract:    lib/trades/data/player_schedule_strength_weekly.csv +
                    .meta.json (data_version "ri-schedule-weekly-2026.1")
```

## E. Provider integration

```
Provider classes:    createRUsageProviderAsOf(season, asOfWeek) -> UsageProvider
                    createRScheduleProviderAsOf(season, asOfWeek, teamPositionResolver) -> ScheduleProvider
                    buildTeamPositionResolverFromUsage(season, asOfWeek) — derives
                      a player's team+position from the usage table itself, so the
                      schedule provider needs no second identity source
Storage/access:      Reads a committed file under lib/trades/data/ at CALL time —
                    no synchronous R invocation inside a request, matching the
                    completion spec's explicit requirement (§28/§29).
Deployment:          Files are committed to the repo (lib/trades/data/, NOT under
                    the gitignored /outputs — an explicit relocation this pass
                    made; see the "storage decision" note below) and therefore
                    ship in the Vercel deployment bundle like any other tracked
                    file (the same pattern this repo already uses for
                    lib/projections/data/rookie-draft-2026.json).
Cache behavior:      None beyond Node's normal file-read — the files are small
                    (~1.5MB usage, ~0.5MB schedule) and read once per provider
                    construction; no additional caching layer was added.
Freshness rules:      Every provider is constructed with a fixed `asOfWeek`.
                    A resolved row exactly at `asOfWeek` reports `CURRENT`; an
                    earlier week substituted (the "most recent known" case)
                    reports `STALE`; nothing beyond `asOfWeek` can be returned
                    AT ALL — enforced structurally in the filter that builds
                    the provider's internal index, not by caller discipline.
Fallbacks:            If the backing file doesn't exist, every method returns
                    null/[] — identical behavior to NULL_USAGE_PROVIDER/
                    NULL_SCHEDULE_PROVIDER — proven by test.
```

**Storage decision (explicit, per completion spec §29):** the repo's
`.gitignore` excludes `/outputs` wholesale (it holds large, disposable
research artifacts from the separate Roster Intel draft-model project). This
pass therefore writes real Phase 3.5 data to **`lib/trades/data/`** instead —
a new, deliberately TRACKED directory, following the exact precedent already
set by `lib/projections/data/rookie-draft-2026.json` in this repo. This is a
conscious choice, not an oversight: it means these real files are versioned
in git and ship with every deployment, and a re-run of the pipelines
produces a diff a reviewer can see.

## F. Look-ahead proof

Three structural guards, not caller conventions:

1. **Trade inputs**: `assertNoLookahead` (unchanged from Phase 3) — verified
   against the real ingested trade (passes) and the existing synthetic
   violation fixtures (still rejected).
2. **Usage**: `createRUsageProviderAsOf(season, asOfWeek)` — every method
   (`getCurrentUsage`, `getHistoricalUsage`, `getRecentUsageSeries`) is
   backed by an index PRE-FILTERED to `week <= asOfWeek` at construction
   time. Test: a provider built with `asOfWeek=4` asked directly for week 6
   returns `null`, and a 20-week-lookback series request returns only weeks
   `<= 4`.
3. **Schedule**: `createRScheduleProviderAsOf(season, asOfWeek, ...)` — same
   mechanism; a provider built with `asOfWeek=4` asked for week 6 returns
   `null` regardless of what week the caller's own context claims.

No future projections were introduced this pass (§I) — there was nothing to
guard there beyond what Phase 1/2/3 already enforce.

## G. Counterfactual dataset

```
Real snapshots used:    1 (the real ingested trade's pre-trade roster-ownership
                        snapshot — every roster in the league, not just the
                        2 trade participants)
Records generated:      up to 10 in the demonstration test (bounded by
                        maxTrades, deterministic seed 2025)
Seed:                   2025 (arbitrary, documented, reproducible)
Trade shapes:           same-position 1-for-1 swaps only (the existing
                        generator's scope — real Sleeper roster dumps don't
                        carry a position field, so this pass tagged every
                        real player id with a synthetic "ANY" position
                        purely to exercise the generator against REAL
                        player-id data; this is NOT a claim of real
                        position-aware stratified sampling — see §K)
Validity failures:      0 (validateCounterfactualBatch passes on every
                        generated batch)
```

## H. Coverage matrix

| Signal | League | Season | Position | Real rows | Resolved |
|---|---|---|---|---|---|
| Historical trades | devoted-to-the-game | 2025 | n/a | 1 | 1/1 (100%) |
| Historical trades | bloodline-bowl | 2026 | n/a | 0 | n/a |
| Historical trades | devoted-to-the-game | 2026 | n/a | 0 | n/a |
| Usage | (league-agnostic, real NFL) | 2025 | QB/RB/WR/TE | 6,037 | 6,031/6,037 (99.9%) |
| Schedule | (league-agnostic, real NFL) | 2025 | QB/RB/WR/TE | 2,176 | 2,174/2,176 (99.9%) |
| Usage/Schedule | (any) | 2026 | any | 0 | n/a (season not yet played) |

No per-Bloodline-Bowl-roster coverage breakdown is reported — that requires
combining these league-agnostic real tables with a real, current Bloodline
Bowl roster snapshot, which is straightforward (`buildTeamPositionResolverFromUsage`
+ a real snapshot's `players_by_id`) but was not built as a standalone report
this pass; it's a direct extension of what's already tested.

## I. Readiness table (see `lib/trades/data-readiness.ts` for the versioned source)

| Signal | Status | Coverage | Historical sample | Redundancy | Leakage risk | Recommendation |
|---|---|---|---|---|---|---|
| `availability` | SHADOW_ONLY | live, every request | 0 real trade outcomes | MODERATE | LOW | Diagnostic-only until real trade outcomes exist. |
| `volatility` | SHADOW_ONLY | live, every request | 0 real trade outcomes | MODERATE | LOW | Same. |
| `usage_trend` | INSUFFICIENT_DATA | **6,037 real 2025 player-weeks** | 1 season, 2 leagues | LOW | LOW | Real data now exists; still far short of the 2-season/3-league floor, and 0 real trade outcomes to validate an adjustment against. |
| `role_stability` | INSUFFICIENT_DATA | same 6,037 rows | same | MODERATE | LOW | Same blocker as usage_trend. |
| `schedule_strength` | INSUFFICIENT_DATA | **2,176 real 2025 rows** | 1 season | LOW | LOW | Real data now exists; real cross-signal check shows LOW correlation with usage (not redundant on this evidence), but 0 real trade outcomes to validate against. |
| `historical_trade_outcome` | INSUFFICIENT_DATA | **1 real trade** | 2 leagues, 2 seasons scanned | NONE | LOW | **Still the hard blocker.** 1 trade vs. a 50-trade floor is a population problem, not a pipeline problem. |

**Ablation finding**: no outcome-validated ablation was possible (needs real
trade outcomes; none computed this pass — see §K). A real, non-outcome
correlation WAS computed as a signal-sanity check:
`scripts/phase35-real-correlation-check.ts` — real target_share vs. real
matchup_score, n=6,037, Pearson=0.107, Spearman=0.088; real rush_share vs.
matchup_score, Pearson=0.009. Interpretation: a player's own usage volume
does not already track schedule ease — this is mild evidence AGAINST
redundancy between usage and schedule, not evidence FOR either signal's
predictive value (that still requires real outcomes).

## J. Shadow invariant

**Proven exactly, and more strongly than before**: the production
`evaluatePhase3Participant` function was not modified this pass at all.
`DEFAULT_PLAYER_INTELLIGENCE_PROVIDERS` is still the `NULL_*_PROVIDER` pair —
verified directly by test (`assert.equal(DEFAULT_PLAYER_INTELLIGENCE_PROVIDERS.usage, NULL_USAGE_PROVIDER)`).
The real R-backed providers built this pass are reachable ONLY by a caller
that explicitly imports `createRUsageProviderAsOf`/`createRScheduleProviderAsOf`
and passes them to `buildPlayerIntelligence` directly — nothing in the
`POST /api/trades/analyze` request path does this. Therefore:

```
phase3.shadow_utility_delta  === phase2.contextual_utility_delta   (unconditionally, unchanged)
phase3.shadow_acceptance     === phase2.contextual_acceptance      (unconditionally, unchanged)
```

holds not because of a weight being zero, but because the live path
literally never touches the new real data. This is the most conservative
possible integration and was a deliberate choice: real 2025 data presented
as "current" player intelligence in a live 2026 trade analysis would be
actively misleading, not merely premature.

## K. Regression results

```
Trade-engine suite (all files)                                244 / 244 pass
  Phase 1  65 / 65     Phase 2  60 / 60     Phase 3+audit  68 / 68
  Phase 3.5 (framework)  37 / 37     Phase 3.5 completion (NEW)  14 / 14
Weekly engine suite                                           120 / 120 pass (unchanged)
Full repository suite                                        1122 tests, 1112 pass, 10 fail
tsc --noEmit                                                  clean
eslint                                                        0 errors, 18 pre-existing warnings (none in trade/R files)
```

The 10 failures are the identical pre-existing `live:`/`LIVE` network tests
as every prior baseline. `grep '^not ok' | grep -vi live` → **0**.

Baseline before this pass was `1108 / 1098 / 10`. This pass adds **14 new
tests** (all passing), **0 non-live regressions**.

## Limitations / Future work (explicit, not hidden)

- **No real trade outcomes computed.** `HistoricalTradeRecord.outcome` is
  `null` for the one real trade. Computing a real outcome (realized
  post-trade points, weeks started, etc.) needs real 2025 weekly scoring
  joined against the reconstructed post-trade rosters — a natural next step,
  not attempted this pass.
- **Routes/route-participation and red-zone/goal-line usage are NOT
  available** from `load_player_stats`/`load_snap_counts` alone — that needs
  nflfastR play-by-play participation data, a materially heavier pull
  deferred to a future Part B.2.
- **Schedule methodology is a real but simple proxy** (points-allowed
  percentile), not an EPA-adjusted or DVOA-equivalent metric.
- **League-specific schedule aggregation** (remaining-schedule quality over
  a SPECIFIC league's actual playoff window/byes, combining the real
  league-agnostic table with a real snapshot) was not built as a standalone
  function this pass — the pieces exist (`buildTeamPositionResolverFromUsage`,
  Phase 2's `ctx.ros.weeks`/`playoff_weeks`) but weren't wired together.
- **Counterfactual generation used a synthetic "ANY" position tag** on real
  player ids, not real per-player positions from the Sleeper roster dump
  (which doesn't carry one) — a real position resolver would need the
  canonical player table, not just the raw historical roster snapshot.
- **2026 data is entirely absent** because the season has played zero games
  — this is a calendar fact, not a pipeline defect, and will resolve itself
  as the season progresses; re-running both R scripts with `season_arg <- 2026L`
  once games exist requires no other code change.

## L. Final verdict

```
PHASE 3.5 REAL DATA ENABLEMENT:
NOT READY FOR CALIBRATION
```

This is a different, better-grounded "not ready" than the prior pass: real
pipelines now exist, run successfully, and produce real, validated data —
6,037 real usage player-weeks, 2,176 real schedule rows, and 1 real
completed trade with a fully reconstructed pre-trade roster snapshot for
every team in its league. But the question this phase must answer is **"do
we have enough data to calibrate," not "are the feeds working"** — and the
answer is still no:

- **The hard blocker remains historical trade volume**: 1 real trade against
  a documented 50-trade floor. This is a population-size fact about two
  small, real fantasy leagues, not something more engineering fixes.
- **No real trade outcome exists yet** to validate ANY signal against,
  regardless of how much usage/schedule data accumulates.
- **2026 (live) usage/schedule data is entirely absent** because the season
  has not been played.

Per the guiding principle carried through both Phase 3.5 passes — prefer
`NO SIGNAL` over `BAD SIGNAL`, `WEIGHT = 0` over `UNJUSTIFIED CALIBRATION` —
this verdict is the honest application of that principle to a materially
improved, now-real data foundation, not a shortfall in the work done.

**Recommended next step** (not implemented here): compute a real outcome for
the one ingested trade; re-run the R pipelines against 2026 data as the
season plays out; keep re-scanning both Sleeper leagues for new trades over
time; build the league-specific schedule aggregation function; consider a
Part B.2 nflfastR participation pull for routes/red-zone data. Do not begin
Phase 4 or move any weight off `0` until real trade-outcome volume exists.
