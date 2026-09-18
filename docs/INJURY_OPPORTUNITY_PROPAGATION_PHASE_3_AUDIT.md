# Injury → Opportunity Propagation Intelligence — Phase 3 — CHECKPOINT A AUDIT

Status: **CHECKPOINT A — AUDIT ONLY.** No predictive model, no production code, no schema has been implemented in this checkpoint. This document is the required precondition for Checkpoint B.

## 1. Git state

| Item | Value |
|---|---|
| Working branch created for Phase 3 | `injury-opportunity-propagation-phase3` |
| Branch base / HEAD at audit time | `35ba3fe0164529594d1453388cbbbfa47de5f222` (`main`) |
| `origin/main` | `35ba3fe0164529594d1453388cbbbfa47de5f222` |
| Drift (`HEAD..origin/main` / `origin/main..HEAD`) | **None.** Zero commits either direction. |
| Working tree | Clean at branch creation. |
| Repo-wide test baseline at this HEAD | `npm test` → **2032 pass / 0 fail / 4 skipped** (2036 total, 569 suites). This is the Phase 3 regression baseline — later checkpoints must diff against this exact number, not Phase 2's freeze-time number (1953/0/4 at `45da80a`), since eight unrelated commits (Yahoo Bridge Phase 1 work, `player-role-opportunity-phase2` merge/deploy record) landed on `main` since then. |

No concurrency conflicts found. Nothing else is in flight on `main` that touches Phase 1/2 contracts or injury/availability code.

## 2. Frozen-contract verification — Phase 1

Phase 1's shared substrate lives in `lib/canonical/`, not inside `lib/football-intel/` — this matters because it means these primitives are already provider/product-agnostic and Phase 3 can and must reuse them directly rather than re-deriving anything.

| Contract | Location | Verified frozen |
|---|---|---|
| `RecommendationLineage` | `lib/canonical/lineage.ts:142-171` | Yes — additive `role_opportunity_intelligence?` field already present; Phase 3 will need a further additive field, never a rename. |
| `FootballIntelligenceLineage` | `lib/canonical/lineage.ts:83-96` | Yes |
| `RoleOpportunityIntelligenceLineage` | `lib/canonical/lineage.ts:110-124` | Yes — structurally parallel to FI's lineage type by design |
| `SnapshotLineage` | `lib/canonical/lineage.ts:27-55` | Yes |
| Intelligence Freshness Policy (`assessIntelligenceFreshness`, `assessRoleOpportunityFreshness`, shared `compareThroughWeekToReality()`) | `lib/canonical/intelligence-freshness.ts` | Yes — `FRESHNESS_POLICY_VERSION = "freshness-policy:2026.2"` (line 45); FI feature families (`INTELLIGENCE_FEATURE_FAMILIES`, lines 132-145) and Role feature families (`ROLE_INTELLIGENCE_FEATURE_FAMILIES`, lines 719-726) are separate constant lists sharing one evaluator |
| Recommendation Readiness / deployment-influence separation | `lib/canonical/recommendation-readiness.ts` | Yes — `DeploymentPermission`, `OverallReadinessStatus`, explicitly does not import weekly-layer deployment modules |
| NFL Reality Frontier | `lib/canonical/nfl-reality-frontier.ts` + type in `intelligence-freshness.ts:187-196` | Yes — `loadNflRealityFrontier()` treats only an exact Sleeper `status === "complete"` as "week finished," never inferred from calendar date |

**Governing rule Phase 3 must inherit:** every feature family (FI's and Role's) is hardcoded `production_numeric_influence: "PROHIBITED"` in the evaluator itself (`intelligence-freshness.ts:361` and `:772`) — this is enforced independent of any per-module deployment flag. Phase 3's own future feature families must follow the identical pattern: the freshness evaluator, not the module's own deployment flag, is the backstop.

## 3. Frozen-contract verification — Phase 2

Physical location: TS read contract in `lib/player-role-intelligence/{schema.ts, read.ts, lineage.ts, format.ts, index.ts}` + data in `lib/player-role-intelligence/data/{player_game_role.csv, player_role_profile.csv, player_role_change.csv, role_opportunity_manifest.json}`. R build pipeline in `analysis/player_role/`.

Verified present and unmodified at this HEAD:

- **Canonical player-game grain**: one row per `(season, week, game_id, gsis_id, team, opponent, position)`, **only when direct participation evidence exists** (`analysis/player_role/build_player_game.R:6-10`). A roster slot alone never fabricates a row. **This is the single most important frozen fact for Phase 3**: Phase 2's table cannot be joined against itself to find "missing" rows and call that an absence — a missing row is ambiguous between "not on the roster," "on the roster but zero evidence," and "genuinely absent." Phase 3 needs an independent absence substrate (§6 below).
- **Metric denominators** (`build_player_game.R`): `snap_share_derived = offensive_snaps/team_offensive_plays`; `target_share = targets/team_pass_att`; `rush_share = carries/team_rush_att` (QB kneels excluded from numerator **and** denominator); `rz_target_share`/`rz_carry_share` gated at `yardline_100 <= 20`; `route_participation` is an explicit **proxy** (on-field-for-a-pass-play, not a confirmed per-player route run) and is tagged `UNRELIABLE_NON_ELIGIBLE_POSITION` for non-eligible positions.
- **`PlayerRoleProfile` schema** (`lib/player-role-intelligence/schema.ts`): `DimensionProfile { latest, recent, season, prior, prior_role_confidence, discontinuity, n_games_season, opportunity_total, deltas, trends, evidence_state, confidence }`, organized into `RoleDomain = PARTICIPATION | RECEIVING | RUSHING | HIGH_VALUE | RETURNS`. `returns` is **always present** (never null, unlike every offensive domain) — the return-role separation invariant.
- **latest/recent/season/prior semantics + EWMA half-life=2**: `ROLE$RECENT_HALFLIFE_GAMES <- 2` (`analysis/player_role/lib_role_profile.R:20`), backtested across 2012-2025 walk-forward, never >~3% worse than each dimension's own optimum. `latest` = the as-of row's own value only (explicit anti-carry-forward bug fix documented in the source). `recent`/`season` computed strictly **before** the as-of week (leakage-free); `prior` = player's own prior-season EWMA, discontinuity-discounted.
- **Confidence semantics**: `Confidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_SAMPLE"` as a type, but `confidence_level()` (`lib_role_profile.R:154-207`) **caps the reachable output at MEDIUM** — a walk-forward backtest found HIGH-confidence events persisted *less* reliably (43.8%) than MEDIUM (49.1%). This is a frozen, certified, and load-bearing precedent for Phase 3: **do not introduce a Phase 3 confidence tier without the same kind of empirical calibration proof**; assume MEDIUM is Phase 3's ceiling until backtesting says otherwise (per instructions §41).
- **`RoleOpportunityIntelligenceLineage`** (`lib/canonical/lineage.ts:110-124`) and its builder `buildRoleOpportunityIntelligenceLineage()` (`lib/player-role-intelligence/lineage.ts`) — mirrors the FI lineage builder exactly, pure/deterministic, returns `null` if no snapshot.
- **Deployment state**: manifest field `deployment_state: "SHARED_CONTEXT" | "SHADOW_ONLY"` and `eligible_to_influence_production: false` (literal `false` type). Verified zero references to `player-role-intelligence`/`player_role` anywhere under `lib/orchestrator/` (re-confirmed by grep, see §4). Permanent regression test `test/player-role-intelligence.test.ts`, describe block `"production isolation"` (line 307).
- **Versioning**: `roi:<season>:w<week>:<12-hex>`, content-addressed (`analysis/player_role/config.R:76-82`, `digest::digest()` over schema versions + season/week + the full player-game table; `generated_at` excluded from the digest).
- **No HTTP API surface** — deliberate, matches FI's own precedent. Access is library-only (`loadRoleOpportunitySnapshot()`, `getPlayerRoleProfile()`, `getPlayerRoleChanges()` in `lib/player-role-intelligence/read.ts`).

**Explicit textual commitments in `docs/PLAYER_ROLE_OPPORTUNITY_PHASE_2_CERTIFICATION.md` that bind this phase:**

> "Future phases (starting with Phase 3, Injury → Opportunity Propagation) must consume these contracts. They must not independently rebuild snap/target/rushing role logic. Additive extensions are permitted; parallel competing role models are not." (§28)

> "No future injury propagation — Phase 2 remains strictly observed/historical (Phase 3's explicit boundary, respected)." (§27 item 7)

> "Phase 3: confirmed not begun. No injury-redistribution logic exists anywhere in this codebase." (§32)

Re-verified true at this HEAD: grep for `injury.*propagat|opportunity.*propagat|redistribut` across `lib/`, `analysis/`, `app/api/` returns nothing outside this new audit doc.

## 4. Inspection of currently deployed Role Intelligence state

- Confirmed via grep: zero references to `player-role-intelligence` or `player_role` under `lib/orchestrator/{build,candidates,capture,conditions,context,dimensions,gates,policy,trace}.ts`.
- Confirmed via file inspection: `app/api/intelligence/[league]/[manager]/week/[week]/route.ts` and `app/api/matchup/[league]/[manager]/week/[week]/route.ts` are the only production routes that carry a `role_opportunity_intelligence` lineage field, and it is `null` there per the Phase 2 certification's live-production proof (§31.9) — i.e., the schema slot exists end-to-end but nothing populates or reads it in a production path today.
- Confirmed no Supabase table stores Role Intelligence data — it is entirely file-backed (`lib/player-role-intelligence/data/*.csv`/`*.json`), rebuilt by the R pipeline and committed.
- Current manifest deployment state: `SHARED_CONTEXT`, `eligible_to_influence_production: false` — confirmed unchanged at this HEAD (`lib/player-role-intelligence/data/role_opportunity_manifest.json`).

**Conclusion: Role Intelligence today is descriptive-only, at rest, correctly isolated from every production recommendation path.** Phase 3 has a clean, unpolluted substrate to build on.

## 5. Availability / injury source matrix

| Source | Fields | Season coverage | Cadence | Known lag/limitation | Identity |
|---|---|---|---|---|---|
| Sleeper current player object | `status`, `injury_status`, `active` | Current snapshot only, overwritten in place | Real-time-ish (Sleeper's own refresh) | **No historical archive via public API.** `lib/analytics/historical-availability.ts` module docstring: "Sleeper's public API has NO historical archive for injury designations, official game-day inactive lists, or practice reports... this module never reads `injury_status`... unconditionally reported as `"unsupported"`." | Sleeper `player_id` |
| Sleeper `/league/{id}/rosters` `reserve` array | Season-end IR snapshot | Current season only | Season-end snapshot, no per-week timeline | `evidence_granularity: "season_end_snapshot"`, confidence `low` (`historical-availability.ts`) | Sleeper `player_id` |
| Sleeper weekly stats (`gp`/`gms_active`) | Game participation, bye weeks | Whatever seasons ingested | Weekly | Reliable for "did this player accrue a stat line," not for injury cause | Sleeper `player_id` |
| `analysis/football_intel_startsit/cache/sleeper_history.rds` (`player.injury_status` off `/projections`,`/stats`) | Point-in-time injury tag attached to a projection row | `SS$SEASONS`, weeks 4–18/19 | As-fetched, can be revised by Sleeper mid-week | "Sleeper may revise a week's projection THROUGH that week... never the sole certification baseline" (source comment) | Sleeper `player_id` |
| Yahoo (`lib/providers/yahoo/`) | None extracted today | n/a | n/a | No injury/availability extraction exists — not a usable source without new work | Yahoo id (crosswalk exists, unused for this) |
| nflreadr `rosters_weekly` (`analysis/football_intel/cache/rosters_weekly.rds`) | `status`, `depth_chart_position`, per (season, week, team, gsis_id) | All `FI$PBP_SEASONS` (2012–2026) | Batch (`Rscript fetch_raw.R`), manual/on-demand | Fetched but **currently unconsumed downstream** anywhere in `analysis/player_role/` or `analysis/football_intel/` | `gsis_id`, crosswalk-joinable |
| nflreadr `snap_counts` (`analysis/football_intel/cache/snap_counts.rds`) | Per-player-game offense/defense/ST snap counts | 2012–2026 | Batch | This is the actual participation ground truth already powering Phase 2 | `gsis_id` |
| nflreadr `participation` | Formation/personnel, route-participation proxy | 2016–2026 | Batch | Upstream nflverse gap for all of 2026-to-date (re-confirmed at Phase 2 merge via live HTTP 404) | `gsis_id` |
| `ff_playerids` (nflreadr) | Cross-provider id crosswalk | n/a | Batch | This is the join key Phase 3 will use to connect nflverse evidence to Sleeper/Yahoo-facing product output | gsis/sleeper/pfr/espn/yahoo |
| Supabase `public.nfl_players` | Canonical crosswalk, no availability fields | n/a | Synced separately, read-only | Identity-only | gsis/sleeper/yahoo/espn/pfr |
| `analysis/football_intel/coordinators.yaml` | OC/DC by team/season | n/a (hand-maintained) | Manual | **File is currently empty (`entries: []`).** Head coach is available automatically via `nflreadr::load_schedules()`; OC/DC continuity is UNKNOWN for every team/season until this file is populated. | team/season string keys |
| Supabase `public.bridge_transaction_ledger` | Real transaction log (adds/drops/trades/IR moves as normalized transactions) | Since Bridge went live | Per-transaction, timestamped | Reflects fantasy-platform transactions, not NFL-team inactive designations — a different signal (roster-management action, not medical/participation status) | league-scoped, provider transaction id |

**Bottom line: there is no historical injury-designation, practice-report, or official-inactive-list source anywhere in this repository.** The only reliable, historically-deep signal is **participation evidence itself** (snap_counts / PBP / Phase 2's `player_game_role`) — i.e., Phase 3's absence events must be defined by "expected to play, but zero participation evidence," not by any injury-designation label. This directly matches the instructions' own preference (§25-26) for `FULL_GAME_ABSENCE` as the cleanest causal event, and rules out building on injury-designation history at all for v1 — there isn't any to build on.

## 6. "Absence event" — feasibility and recommended v1 definition

Phase 2's grain (`player_game_role`) **only contains rows with participation evidence** — it structurally excludes the missed-game side of the ledger (verified, `build_player_game.R:6-10`). No absence table exists anywhere in the repo today. This is a genuine, confirmed gap, not an oversight to route around.

**What's buildable without a new external source:** a roster-membership signal to disambiguate "not rostered this week" from "rostered but zero role evidence." Candidates:
- `rosters_weekly.rds` (nflreadr) — real weekly team roster with a `status` field, already fetched, currently unused. This is the strongest available candidate: join `(season, week, team, gsis_id)` from `rosters_weekly` against `player_game_role`'s participation rows. A player present in `rosters_weekly` for team T in week W but absent from `player_game_role` for that same (season, week, team) is a candidate absence.
- Sleeper's `reserve` array — too coarse (season-end snapshot only), usable only as a secondary corroboration signal, never as the primary label.

**Recommended v1 event taxonomy** (of the instructions' full list): implement **`FULL_GAME_ABSENCE` only**. Rationale:
- It is the only event type for which a reliable historical label is constructible today (roster-present + zero-participation-evidence, cross-checked against the team having played a normal game that week per the NFL Reality Frontier).
- `MID_GAME_EXIT`, `LIMITED_RETURN`, `ROLE_LIMITATION` all require play-by-play-level in-game timing evidence (e.g., last offensive snap number per player per game) that has not been built or validated anywhere in this repo; deferring these matches the instructions' explicit guidance (§27) to not mix ambiguous partial-game evidence into full-game-absence training.
- `SUSPENSION` and `INACTIVE_NON_INJURY` are not distinguishable from `FULL_GAME_ABSENCE` with current sources (no injury-designation feed exists to separate cause) — v1 should model **all-cause offensive absence** and explicitly not claim to know *why* a player was absent, consistent with §3 of the instructions ("model football availability and opportunity redistribution, not medicine"). The event's `cause` field, if included at all, should be `UNKNOWN` by default rather than defaulting to "injury."
- `IR_PLACEMENT` / `RETURN_FROM_ABSENCE` are derivable as a labeling refinement on top of a `FULL_GAME_ABSENCE` sequence (a run of consecutive absences bounded by a return week) rather than a separate detection problem — defer to Checkpoint B design, likely modeled as a property of an absence *run*, not a new primitive event type.

**Minimum pre-event role thresholds (instructions §26):** must be backtested in Checkpoint B/C, not assumed. Starting candidates to test: `snap_share_derived >= 0.10` OR `target_share/rush_share >= 0.08` in the pre-event baseline (`recent` EWMA) as a floor for "this absence created a meaningfully vacated role"; trivial absences (garbage-time/inactive-for-depth backups) below threshold should be excluded from the training set and reported as excluded, not silently dropped.

**Multi-absence prevalence:** not yet measured — Checkpoint B must report the actual count of weeks with 2+ simultaneous same-team absences meeting the minimum-role threshold, since the instructions require documenting a v1 cap explicitly rather than assuming independence.

## 7. Role domains that can be propagated (v1 recommendation)

Given available data:

| Domain | Propagate in v1? | Basis |
|---|---|---|
| Participation (snap share) | Yes | `offensive_snaps`/`team_offensive_plays`, reliable across full season range |
| Rushing (rush share, position-group rush share, RZ carry share) | Yes | Direct PBP-derived, QB-kneel-excluded, already in Phase 2 |
| Receiving (target share, position-group target share, RZ target share) | Yes | Direct PBP-derived |
| Air yards share | Defer to v1.1 | Available but lower priority than target share for a first cut |
| Routes | **No, not in v1** | Explicitly proxy-quality and source-lagged for all of 2026-to-date per Phase 2's own certification; instructions §10 explicitly say routes must not be required for live operation |
| Returns (kick/punt) | Yes, but **strictly separate model/domain** | Phase 2 already isolates this cleanly; instructions §10/§43 require orthogonality — a receiver's absence must never be allowed to redistribute return opportunity and vice versa |
| QB (any domain) | **Exclude from v1** | Per instructions §30/§53 — backup-QB effects are not analogous to skill-position redistribution; audit recommends explicit exclusion, not a special-cased weak model |

## 8. Candidate beneficiary identification (v1 recommendation)

Reuse Phase 2 role state directly (never recompute):
- Primary candidate pool: same team, active roster that week, `PlayerRoleProfile` present (any domain non-null), restricted initially to same-position-group **plus** the top-N (by recent role, e.g. `recent` EWMA target/rush share) cross-position teammates in adjacent domains (WR/TE/RB overlap for receiving; RB/QB overlap for rushing) — this satisfies the instructions' explicit requirement (§12) that beneficiaries must not be limited to same-position depth chart order, while keeping the candidate set tractable and auditable.
- Feature signal for "already emerging before the injury": Phase 2's own `trend_recent_vs_prior`/`trend_latest_vs_recent` and `role_state.role_trend` are already the exact instrumentation instructions §17 calls for — no new trend computation needed.
- Team continuity gating: use `lib_continuity.R`'s head-coach and starting-QB/snap-weighted-returning-share signals (already computed from raw caches) to discount cross-season historical contingency evidence when there's been a coaching or major-roster discontinuity. **OC/DC continuity cannot be used yet** — `coordinators.yaml` is empty; Checkpoint B/C must either populate a minimal set of entries or treat OC/DC continuity as permanently UNKNOWN (which the existing code already defaults to safely — "an absent entry => continuity UNKNOWN => NO prior discount").

## 9. Historical coverage estimate

Cannot be stated precisely without running the Checkpoint B join (rosters_weekly × player_game_role), which is out of scope for an audit-only checkpoint. What can be stated:
- Underlying source coverage: `snap_counts`/`pbp` span 2012–2026; `rosters_weekly` spans the same range once actually read; Phase 2's `player_game_role.csv` (already built) is the participation-evidence side of the join.
- Recommendation: Checkpoint B's first deliverable must be the actual measured absence-event count (total, by position, by season, by type, excluded-and-why) — do not estimate it here; report it as data once built.

## 10. Identity / canonical mapping

Reuse the existing crosswalk exactly as Phase 2 does: `gsis_id` as primary key, `ff_playerids.rds` / `lib/canonical/players.ts` + `SupabaseCrosswalkSource` for cross-provider resolution. No new identity work needed — this is fully solved infrastructure.

## 11. R vs TypeScript ownership (recommendation)

Follow the exact Phase 1/Phase 2 precedent, since it has proven itself twice:
- **R** (`analysis/injury_opportunity_propagation/` — new directory, mirroring `analysis/player_role/`'s file layout: `config.R`, `build_absence_events.R`, `lib_redistribution_model.R`, `backtest.R`, `run_build.R`, `tests/testthat/`) owns: absence-event construction, the redistribution model, backtesting, calibration. It consumes Phase 2's already-built `player_game_role.rds`/`player_role_profile` R-side artifacts (or the CSVs, whichever the existing R pipeline already loads Phase-2-side) plus `rosters_weekly.rds`, `pbp.rds`, `lib_continuity.R` outputs — never re-derives snap/target/rush shares.
- **TypeScript** (`lib/injury-opportunity-propagation/` — new directory, mirroring `lib/player-role-intelligence/`'s `{schema.ts, read.ts, lineage.ts, format.ts, index.ts}` + `data/*.csv`/`*.json`) owns: the read contract, lineage builder (`OpportunityPropagationIntelligenceLineage`), freshness integration, deterministic formatting, scenario access functions. No HTTP API in v1, matching both prior phases' precedent, unless Checkpoint D finds a concrete internal consumer need.

## 12. Modeling recommendation (for Checkpoint C, not decided here)

Per instructions §38, start simple and test empirically rather than defaulting to ML:
- **Baselines to implement first** (instructions §37): A (no redistribution), B (next-man-up proportional-to-largest), C (proportional redistribution within position group), D (team-specific historical contingency average where evidence exists).
- **Candidate model** to test against baselines: a hierarchical shrinkage/empirical-Bayes redistribution (team/player contingency history → team-position history → league-position prior, shrunk by evidence count) — chosen over gradient boosting or a black-box model specifically because instructions §38 requires the model to expose *why* beneficiary X gains more than beneficiary Y, and a hierarchical shrinkage estimator is directly interpretable (each beneficiary's expected share is literally a weighted blend of named, auditable evidence pools). Defer nearest-neighbor role-archetype and regression approaches to a later iteration only if the simple hierarchical model underperforms baseline C by a nontrivial margin in backtesting.
- Confidence must remain empirically capped, following Phase 2's precedent exactly (§3 above) — do not introduce a Phase 3 HIGH tier without the same walk-forward calibration discipline that led Phase 2 to retire it.

## 13. Backtest design (for Checkpoint C, proposed)

Walk-forward only, chronology-safe: for an absence in week W, only Role Intelligence and continuity/coordinator data available strictly before W may be used as features; Phase 2's own `recent`/`season` EWMA baselines are already leakage-free by construction (computed strictly before the as-of week), which makes them a natural, already-safe feature source. Evaluate against actual week-W beneficiary role shares (not fantasy points) using MAE/RMSE, top-beneficiary precision, and a full-distribution error metric (e.g. L1 distance between predicted and actual share allocation) per domain, segmented by position (RB/WR/TE), absence count (single vs. multi), and evidence availability (team-specific history present vs. absent). QB-triggered events excluded from all segments per §7.

## 14. Uncertainty design (initial proposal)

Confidence should be a function of: (a) historical contingency sample size for this specific team/player pair, (b) role-archetype similarity between absent player and candidate beneficiary, (c) team/coaching continuity, (d) number of simultaneous absences (more simultaneous absences → wider uncertainty), (e) whether the beneficiary itself has sufficient Phase 2 evidence (`evidence_state`/`n_games_season`/`opportunity_total` — reuse directly, never recompute). Output should expose `expected`, `lower`, `upper`, `confidence`, `evidence_count` per beneficiary per domain, as instructed (§21). Calibration of the credible range must itself be backtested (§58) before being trusted, exactly as Phase 2 did for its confidence tiers.

## 15. Known limitations (explicit)

1. No historical injury-designation, practice-status, or official-inactive-list source exists anywhere in this repo — Phase 3 v1 can only model **all-cause full-game offensive absence**, not injury-specific scenarios. This is a materially narrower scope than the instructions' full aspirational taxonomy (§3, §18-19), and must be stated plainly in any Phase 3 product output, not silently implied away.
2. Because there's no injury-designation feed, the `QUESTIONABLE`/`DOUBTFUL`/`LIMITED` scenario-conditionality machinery described in instructions §18-19 **cannot be built for v1** — there is no availability-probability input to condition on. V1 can only answer "if this player does not play, what's the expected redistribution" (a `CONFIRMED_OUT`-shaped scenario), not the full scenario tree. This must be surfaced as an open question for Checkpoint B review, not silently narrowed.
3. `rosters_weekly.rds`'s `status` field is fetched but never validated for accuracy/lag by any existing code — Checkpoint B must audit it directly (sample known real absences and confirm the field actually flags them) before trusting it as the absence-detection backbone.
4. OC/DC continuity data (`coordinators.yaml`) is empty — coaching-continuity discounting can only use head coach and QB/personnel-continuity signals in v1; OC/DC discontinuity rules from instructions §16 cannot be implemented until that file is populated (out of scope for Phase 3 unless a lightweight manual backfill is approved separately).
5. Route participation remains proxy-quality and lagged for 2026 — routes are excluded from v1 redistribution domains entirely, per instructions §10's own allowance.
6. Mid-game exits, limited-role events, and return-from-absence events are all deferred per §27/§28 of the instructions — v1 covers `FULL_GAME_ABSENCE` only.
7. Multi-simultaneous-absence prevalence is unmeasured as of this audit; Checkpoint B must report it and Checkpoint C must decide (and document) a support cap if evidence is sparse.
8. Historical coverage counts (event counts by position/season/type) are unmeasured as of this audit — deferred to Checkpoint B, which will run the actual join.

## 16. Open questions for review before Checkpoint B

1. Is all-cause `FULL_GAME_ABSENCE` (no injury-cause distinction) an acceptable v1 scope, given no injury-designation source exists? (Recommended: yes — this is what the data supports.)
2. Is it acceptable that v1 has no `QUESTIONABLE`/probabilistic scenario tree (only a binary "if absent" scenario), given no availability-probability model exists or is in scope? (Recommended: yes, with explicit product-level disclosure.)
3. Should the empty `coordinators.yaml` be backfilled with a minimal manual entry set as part of Phase 3, or left UNKNOWN (safe default, no prior discount) for v1? (Recommended: leave UNKNOWN for v1; backfilling is a separate, reviewable scope decision.)
4. Confirm exclusion of QB-triggered absences from v1 scope entirely (recommended, per §7 above and instructions §30/§53).
5. Confirm `rosters_weekly.rds`'s `status` field as the primary absence-detection signal, pending the accuracy audit in Checkpoint B (§15 item 3) — is a fallback needed if it proves unreliable, and if so what (Sleeper `reserve` as weak corroboration only)?

## 17. Files likely to change / be created in later checkpoints

**New (Checkpoint B+):**
- `analysis/injury_opportunity_propagation/{config.R, build_absence_events.R, lib_redistribution_model.R, backtest.R, run_build.R}`
- `analysis/injury_opportunity_propagation/tests/testthat/*.R`
- `lib/injury-opportunity-propagation/{schema.ts, read.ts, lineage.ts, format.ts, index.ts}`
- `lib/injury-opportunity-propagation/data/{absence_events.csv, opportunity_propagation_manifest.json, ...}`
- `test/injury-opportunity-propagation.test.ts`
- `docs/INJURY_OPPORTUNITY_PROPAGATION_PHASE_3_CHECKPOINT_B.md`, `_CHECKPOINT_C.md`, `_CHECKPOINT_D.md`, `_CERTIFICATION.md`

**Additive-only touches to frozen files (never a rewrite):**
- `lib/canonical/lineage.ts` — add `OpportunityPropagationIntelligenceLineage` type + an additive optional field on `RecommendationLineage`, mirroring how `role_opportunity_intelligence` was added in Phase 2.
- `lib/canonical/intelligence-freshness.ts` — add a new feature-family constant set (e.g. `PROPAGATION_INTELLIGENCE_FEATURE_FAMILIES`) and an `assessOpportunityPropagationFreshness()` function reusing `compareThroughWeekToReality()`, following the exact Phase 2 precedent (never fork the disagreement policy).

**Untouched, verified by regression at every checkpoint (never modified):**
- `lib/weekly/**`, `lib/trades/**`, `lib/orchestrator/**`, `lib/projections/**`, `lib/player-role-intelligence/**` (Phase 2, consumed read-only), `lib/football-intel/**` (Phase 1, consumed read-only).

---

**CHECKPOINT A COMPLETE — READY FOR REVIEW**

Do not implement Checkpoint B until this audit is reviewed and the open questions in §16 are answered.
