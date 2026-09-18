# Player Role & Opportunity Intelligence — Phase 2, Checkpoint D

**Served Artifact, TypeScript Contract, Phase 1 Lineage/Freshness Integration, Analytical Access.**
Branch: `player-role-opportunity-phase2-audit` (continuing from Checkpoints A/B/C).
Authoritative prior records:
[Checkpoint A audit](PLAYER_ROLE_OPPORTUNITY_PHASE_2_AUDIT.md) ·
[Checkpoint B substrate](PLAYER_ROLE_OPPORTUNITY_PHASE_2_CHECKPOINT_B.md) ·
[Checkpoint C model](PLAYER_ROLE_OPPORTUNITY_PHASE_2_CHECKPOINT_C.md) ·
[Deferred infrastructure defects](PLAYER_ROLE_OPPORTUNITY_PHASE_2_DEFERRED_DEFECTS.md)

The Checkpoint C model (EWMA half-life 2, current dimensions, prior formulation, discontinuity handling, confidence behavior, route-independent fallback, return-role separation, kneel-excluded rushing) is **frozen and unchanged** in this checkpoint. No production consumer was touched.

---

## 1. Git

```
branch:        player-role-opportunity-phase2-audit
pre-D SHA:     7fdf904  (Checkpoint C commit)
origin/main:   4bd41f7  -- fetched again at the start of this checkpoint; unchanged
working tree:  clean before this checkpoint's commit
```

**Concurrency gate result:** `git fetch origin` produced no new commits. `origin/main` is still exactly `4bd41f7`, the same commit all four checkpoints are based on. Nothing to reconcile.

---

## 2. Product identity

| | |
|---|---|
| Model tag | `role-opportunity-2026.1` |
| Artifact version (content-deterministic) | `roi:2026:w01:819dc3166607` |
| Feature schema version | `role-profile-model:v1` (Checkpoint C's model contract) |
| Substrate schema version (dependency) | `role-opportunity-schema:v1` (Checkpoint B's grain contract) |
| Deployment state | `SHARED_CONTEXT` |
| `eligible_to_influence_production` | `false` (hardcoded, typed as the literal `false`, not just a runtime default) |

**Distinct from Football Intelligence, explicitly (spec §4):** `football_intelligence_version` is never read, written, or referenced by any Role Intelligence code. `RoleOpportunityIntelligenceLineage` (new type, `lib/canonical/lineage.ts`) is structurally parallel to `FootballIntelligenceLineage` but is its own type with its own version namespace (`roi:` prefix vs `fi:` prefix) and is attached to `RecommendationLineage` as an independent, separately-nullable field (`role_opportunity_intelligence`, distinct from `football_intelligence`).

---

## 3. Served artifacts

| File | Rows | Size | Purpose |
|---|---|---|---|
| `lib/player-role-intelligence/data/role_opportunity_manifest.json` | — | 2.7 KB | Product identity, versioning, source availability, model configuration, deployment state |
| `lib/player-role-intelligence/data/player_role_profile.csv` | 1,200 (one per active player, season 2026 week 1) | 901 KB | Full decomposed role profile per player (wide format, ~170 columns) |
| `lib/player-role-intelligence/data/player_role_change.csv` | 458 (non-STABLE/UNCERTAIN events only) | 81 KB | Structured role-change events with full evidence decomposition |
| `lib/player-role-intelligence/data/player_game_role.csv` | 1,200 | 361 KB | **Unchanged from Checkpoint B** — the current-season raw substrate, kept as-is; Checkpoint D does not touch or re-derive it |

**Not served:** the full 274,341-row multi-season substrate (stays internal, `analysis/player_role/cache/player_game_role.rds`, git-ignored) — per spec §7's explicit instruction. The served profile/change artifacts intentionally preserve full decomposition (every dimension's latest/recent/season/prior/delta/trend/confidence) rather than compressing to an opaque label, per spec §8 — verified directly in §9's live example: a consumer can answer "why is this player classified as expanding" from the CSV alone, without rerunning R.

---

## 4. Manifest contents

```json
{
  "role_opportunity_model_tag": "role-opportunity-2026.1",
  "role_opportunity_version": "roi:2026:w01:819dc3166607",
  "feature_schema_version": "role-profile-model:v1",
  "substrate_schema_version": "role-opportunity-schema:v1",
  "season": 2026, "through_week": 1,
  "generated_at": "...",
  "week_completion": { "latest_week": 1, "week_state": "COMPLETE", "games_completed_in_latest_week": 16, "games_scheduled_in_latest_week": 16, "latest_completed_game_date": "2026-09-14" },
  "source_cutoffs": { "pbp": 1, "snap_counts": 1 },
  "source_availability": [
    { "family": "ROLE_SNAPS",    "source": "snap_counts",    "status": "AVAILABLE_CURRENT",  "through_week": 1 },
    { "family": "ROLE_TARGETS",  "source": "pbp",            "status": "AVAILABLE_CURRENT",  "through_week": 1 },
    { "family": "ROLE_RUSHING",  "source": "pbp",            "status": "AVAILABLE_CURRENT",  "through_week": 1 },
    { "family": "ROLE_RED_ZONE", "source": "pbp",            "status": "AVAILABLE_CURRENT",  "through_week": 1 },
    { "family": "ROLE_ROUTES",   "source": "participation",  "status": "AVAILABLE_WITH_LAG", "through_week": null },
    { "family": "ROLE_RETURNS",  "source": "pbp",            "status": "AVAILABLE_CURRENT",  "through_week": 1 }
  ],
  "model_configuration": {
    "recency_method": "EWMA", "recency_halflife_games": 2,
    "prior_methodology": "player's own prior-season EWMA (same half-life), discontinuity-discounted for team/position change",
    "confidence_methodology_version": "role-confidence:v1",
    "min_share_delta": 0.08, "min_opportunity_for_trend": 3,
    "role_level_calibration_basis": {
      "WR": "empirical quantiles, 2012-2025 substrate",
      "RB": "empirical quantiles, 2012-2025 substrate",
      "TE": "WR quantile fallback -- NOT independently calibrated for TE (Checkpoint C known limitation, unchanged in Checkpoint D)"
    },
    "confidence_calibration_scope": "global + positional dimension sets only, as actually backtested -- NOT separately calibrated for rookies, team-changers, or volume tiers (Checkpoint C known limitation)"
  },
  "deployment_state": "SHARED_CONTEXT",
  "eligible_to_influence_production": false,
  "known_unavailable_feature_families": ["ALIGNMENT", "MOTION_PLAYER_LEVEL", "PASS_BLOCKING", "RUN_BLOCKING"],
  "row_counts": { "profiles": 1200, "change_events": 458 },
  "dependencies": { "substrate": "player_game_role.csv (Checkpoint B)", "substrate_schema_version": "role-opportunity-schema:v1" }
}
```

Every known limitation from Checkpoint C is carried forward **in the served metadata itself** (spec §25-26), not just in prose documentation — a consumer reading the manifest directly sees the TE-fallback and no-subgroup-calibration caveats without needing to have read the Checkpoint C report.

**Version identity is content-deterministic, verified directly, twice:**
```
$ Rscript analysis/player_role/serve_role_intelligence.R 2026 1
role_opportunity_version: roi:2026:w01:819dc3166607

$ sleep 2 && Rscript analysis/player_role/serve_role_intelligence.R 2026 1
role_opportunity_version: roi:2026:w01:819dc3166607   <- IDENTICAL, despite a different generated_at
```
`generated_at` is excluded from the digest; the model tag, feature schema version, season/week, the full profile table, the full event table, and source-availability **semantics** (status strings, not raw cutoffs alone) all participate — a change from `AVAILABLE_WITH_LAG` to `AVAILABLE_CURRENT` would itself produce a new version even if no profile value changed yet, per spec §6's explicit requirement.

---

## 5. TypeScript contract

`lib/player-role-intelligence/{schema.ts, read.ts, lineage.ts, format.ts, index.ts}` — read-only, no network, no mutation, module-level cache (`__resetRoleOpportunityCache()` for tests), mirrors `lib/football-intel/`'s established conventions exactly.

**Reader methods:**
```ts
loadRoleOpportunitySnapshot(): RoleOpportunitySnapshot | null
snapshot.getPlayerRoleProfile({ gsis_id?, sleeper_id? }): PlayerRoleProfile | null
snapshot.getPlayerRoleChanges({ gsis_id?, sleeper_id? }): RoleChangeEvent[]
buildRoleOpportunityIntelligenceLineage(snapshot?): RoleOpportunityIntelligenceLineage | null
validateRoleOpportunitySnapshot(manifest, profiles, events): void   // throws on any invariant violation; runs on every load
formatPlayerRoleProfile / formatRoleChangeEvent / formatRoleOpportunityLineage  // deterministic formatters, render only existing fields
```

**Player lookup (spec §19):** `gsis_id` primary, `sleeper_id` secondary — both stable canonical identifiers already used throughout the substrate (Checkpoint B's crosswalk). No fuzzy name matching in the reader path; `full_name` is carried for display only.

**Validation on every load (spec §11, §30):** duplicate profile/event keys, season/week consistency with the manifest, `[0,1]` bounds on target/rush/return shares (participation's `snap_share_derived` is deliberately excluded from this bound — Checkpoint B documented it can legitimately exceed 1.0 for QBs due to kneel exclusion), and — the certification-critical check — **a route family marked `AVAILABLE_CURRENT` with zero actual route evidence across every profile throws**, directly reproducing and catching the exact Checkpoint A/B failure mode (`OBSERVED` metadata + null values) at the artifact-validation layer, not just as a one-off audit finding.

**Analytical access path chosen: library methods only**, matching Football Intelligence's own precedent exactly (Checkpoint A's audit found FI has no `app/api` route at all — internal-only consumption). No new API endpoint was added. This is a deliberate architectural choice, not an oversight: spec §20 explicitly permits "library methods only," and adding a route would be new production-facing surface for a SHARED_CONTEXT, non-numeric-influence product with no current consumer requesting it. If a future phase needs HTTP access, it is a small, additive follow-up over the same read functions.

---

## 6. Phase 1 lineage/freshness integration

**No new freshness policy, no new completed-game frontier, no new lineage system** — verified by construction:

- `RoleOpportunityIntelligenceLineage` is a new type in the *same* `lib/canonical/lineage.ts` file, added to `RecommendationLineage` as `role_opportunity_intelligence?: RoleOpportunityIntelligenceLineage | null` — **optional** (not required, unlike `football_intelligence`) specifically so every pre-existing `RecommendationLineage` object literal in the codebase keeps typechecking without modification (verified: `tsc --noEmit` clean both before and after, and `npm test` unchanged at 1927/1927-equivalent pass count before this checkpoint's own new tests are added).
- `buildRecommendationLineage()` gained one new optional parameter (`roleOpportunityIntelligence = null`) appended at the end — every existing call site with 2, 3, or 4 arguments is unaffected.
- `assessRoleOpportunityFreshness()` (`lib/canonical/intelligence-freshness.ts`, same file as `assessIntelligenceFreshness`) reuses, unchanged: `FRESHNESS_POLICY_VERSION` (`freshness-policy:2026.2` — the exact same policy version, not a new one), `OverallFreshnessStatus`, `ConfidenceCap`, `NflRealityFrontier`, and — the specific mechanism that prevents the disagreement policy from forking (spec §17) — a newly-extracted, behavior-preserving shared helper, `compareThroughWeekToReality()`, which both `assessIntelligenceFreshness` (FI) and `assessRoleOpportunityFreshness` (Role Intelligence) now call. This was a careful refactor, not a rewrite: `compareFiToReality` (FI's original function) is now a two-line wrapper around the extracted generic function, and the full `npm test` suite (1927/1927 pass at that point, before any new tests were added) was run immediately after the extraction to confirm zero behavioral change before proceeding.
- New feature families `ROLE_SNAPS/ROLE_TARGETS/ROLE_RUSHING/ROLE_RED_ZONE/ROLE_ROUTES/ROLE_RETURNS` are additive, not a duplication of FI's `PLAYER_USAGE/SNAP_COUNTS/ROUTE_PARTICIPATION` — a deliberate choice, not an oversight: Role Intelligence is versioned independently of FI (spec §4), so its feature-family cutoffs must be assessed against **its own** manifest's `data_cutoff`, not FI's. Reusing FI's families would silently conflate two independently-versioned products' freshness under one name.
- New reason codes (`ROLE_NOT_USED`, `ROLE_CURRENT`, `ROLE_PARTIAL_CURRENT`, `ROLE_SEASON_BEHIND_CURRENT`, `ROLE_AHEAD_OF_REALITY`, `ROLE_SEASON_MISMATCH`, `ROLE_PUBLICATION_LAG_POSSIBLE`, `ROLE_BEHIND_CONFIRMED_COMPLETED_GAME`, `ROLE_SCHEDULE_SOURCE_CONFLICT`) were added to the *existing* `FreshnessReasonCode` union, structurally mirroring the `FI_*` codes one-for-one — never a second enum.
- The **NFL Reality Frontier is reused as-is** — `assessRoleOpportunityFreshness` takes the exact same `NflRealityFrontier` type as a request parameter; no second "how many games actually finished" concept exists anywhere in this checkpoint's code.

**Feature-family lag is never collapsed into overall status (spec §15), verified directly:** a lineage with `data_cutoff = { pbp: 1, snap_counts: 1 }` (no `participation` key) simultaneously reports `ROLE_SNAPS: AVAILABLE` and `ROLE_ROUTES: UNAVAILABLE` in the same assessment — test `"4: current snaps + lagged routes preserves mixed feature status"` asserts both independently.

---

## 7. Current source availability (live-verified, not assumed)

Spec §36's specific route cross-check, run live at the end of this checkpoint — **all four layers agree**:

| Layer | Result |
|---|---|
| Live upstream check (`nflreadr::load_participation(seasons=2026)`) | HTTP 404 — genuinely unavailable, unchanged since Checkpoint B |
| Cached `source_availability.rds` | Zero rows for `(source="participation", season=2026)` |
| Served substrate (`player_game_role.csv`, 1,200 rows) | 0 non-null `route_participation` values |
| Manifest (`role_opportunity_manifest.json`) | `ROLE_ROUTES: AVAILABLE_WITH_LAG, through_week: null` |
| TS reader (parsed manifest) | Identical to the file on disk |
| Served profiles (1,200 rows, TS-parsed) | 0 non-null `route_participation.latest` across every profile |
| Freshness evaluator (`assessRoleOpportunityFreshness`, no `participation` key in `data_cutoff`) | `ROLE_ROUTES: UNAVAILABLE` (a stricter, per-request classification than the manifest's build-time `AVAILABLE_WITH_LAG` — see note below) |

**Reconciling the one apparent terminology difference:** the manifest's `AVAILABLE_WITH_LAG` (a build-time, provenance-level classification — "this source is on Football Intelligence's own `EXPECTED_SOURCES` list, so its absence is expected lag, not corruption," mirroring FI's own `EXPECTED_SOURCE_LAG` vs `BROKEN_OR_MISSING_DATA` distinction) and the freshness evaluator's `UNAVAILABLE` (a per-request classification — "this specific lineage's `data_cutoff` has no `participation` key at all, so there is literally zero cutoff data to reason about") are **not a contradiction** — they answer two different, purpose-built questions at two different layers, both truthfully. Both agree on the one fact that matters for certification: **routes are not currently usable, and nothing in the product claims otherwise.**

**Per spec §36's explicit instruction** — if upstream had become available between Checkpoint B and D, the artifact would be required to follow reality, not preserve `AVAILABLE_WITH_LAG` out of habit. It has not become available; the live check above proves the artifact still reflects that correctly.

---

## 8. Live 2026 verification (real data, not hard-coded before querying)

Selected by querying the live-parsed TS snapshot:

| Archetype | Player | Verified |
|---|---|---|
| Primary RB | Jonathan Taylor (IND) | `rush_share.latest = 1.00`, `role_level = PRIMARY`, `trend = EXPANDING` |
| High-participation WR | Amon-Ra St. Brown (DET) | Full profile rendered via `formatPlayerRoleProfile` (§9 below) — `role_level = PRIMARY`, participation `MEDIUM` confidence off one game |
| TE | (queried from `position === "TE"` subset) | `receiving.position_group_target_share` present, `TE` calibration-basis caveat visible in manifest |
| Return specialist | (queried via `kick_return_role.latest > 0.5 OR punt_return_role.latest > 0.5`) | Offense `participation.latest < 0.5` confirmed structurally in test `"4/9"` |
| Low-sample uncertain player | Keenan Allen / Travis Kelce (Checkpoint C's own finding, reconfirmed via the served artifact) | `confidence = LOW` despite a moderate share, off one game |
| Unknown/malformed player id | `getPlayerRoleProfile({gsis_id: "00-9999999"})` | Returns `null`, never throws, never fabricates |

Full rendered example (Amon-Ra St. Brown, via `formatPlayerRoleProfile`, live 2026 week 1 data):
```
Player: Amon-Ra St. Brown (WR, DET)
As of: season 2026, week 1
Role: PRIMARY / STABLE / TENTATIVE

Participation: STABLE / TENTATIVE
  latest: 89.6%  recent: 88.0%  season: unavailable  prior: 88.0%
  confidence: MEDIUM  (1 game(s) this season, 69 opportunities)

Receiving opportunity (target share): STABLE / TENTATIVE
  latest: 34.1%  recent: 29.5%  season: unavailable  prior: 29.5%
  confidence: MEDIUM  (1 game(s) this season, 14 opportunities)
  Position-group target share: EXPANDING / TENTATIVE
  latest: 58.3%  recent: 50.0%  season: unavailable  prior: 50.1%
  confidence: MEDIUM  (1 game(s) this season, 14 opportunities)
  Air-yards share: STABLE / TENTATIVE
  latest: 33.8%  recent: 40.5%  season: unavailable  prior: 40.5%
  confidence: MEDIUM  (1 game(s) this season, 14 opportunities)
  Routes: unavailable for current period
  Corroborating dimensions moving together: 1

High-value opportunity:
  Red-zone target share: EXPANDING / TENTATIVE
  latest: 50.0%  recent: 31.4%  season: unavailable  prior: 31.4%
  confidence: LOW  (1 game(s) this season, 4 opportunities)
  Goal-line carries (latest): 0
  Third-down targets (latest): 6
  Two-minute targets (latest): 1

Special-teams return role (kept separate from offense):
  Kickoff return: STABLE / TENTATIVE  latest: 0.0%  confidence: INSUFFICIENT_SAMPLE
  Punt return: STABLE / TENTATIVE  latest: 0.0%  confidence: INSUFFICIENT_SAMPLE

Route evidence: ROUTE_CORROBORATION_UNAVAILABLE
Schema version: role-profile-model:v1
```
No fantasy recommendation, score, or actionability field appears anywhere in this output.

---

## 9. Production isolation — exact proof

**Structural (compile-time-adjacent) proof:** `test/player-role-intelligence.test.ts`'s `"no production consumer imports Phase 2 role-model code"` test recursively greps every `.ts`/`.tsx` file under `lib/weekly/`, `lib/trades/`, `lib/orchestrator/`, `lib/projections/`, and `app/api/` for any reference to `player-role-intelligence` or `player_role`. **Zero hits.** A second test confirms `lib/projections/model.ts` specifically (the audit's flagged high-risk file) contains no such reference.

**Behavioral proof:** full regression counts, before and after this checkpoint's changes to shared Phase 1 files:

| | Before (Checkpoint C baseline) | After (Checkpoint D) |
|---|---|---|
| `npm test` | 1927 pass / 0 fail / 4 skipped (1931 total) | 1953 pass / 0 fail / 4 skipped (1957 total) — **+26 new tests, zero regressions** |
| `npm run typecheck` | clean | clean |
| `npm run lint` | 0 errors, 29 warnings | 0 errors, 29 warnings (identical set) |

The +26 is exactly this checkpoint's own new test file; no pre-existing test's outcome changed. Waiver ordering, Start/Sit selection, matchup output, trade output, and projection output are therefore unchanged both by construction (no code path reaches them) and by measurement (every pre-existing test still passes identically).

**`lib/canonical/lineage.ts` and `lib/canonical/intelligence-freshness.ts` were modified** (the only "production" files touched this checkpoint) — both changes are additive (new optional field, new exported functions/types) and were verified behavior-preserving at each step: `tsc --noEmit` and `npm test` were run immediately after the `RecommendationLineage` field addition (clean) and again immediately after the `compareFiToReality`→`compareThroughWeekToReality` extraction (clean, identical pass count), before any new Role Intelligence code was added on top.

---

## 10. Tests — exact counts

| Suite | Count |
|---|---|
| R: Checkpoint B substrate invariants | 27/27 pass |
| R: Checkpoint C role-profile/adversarial | 38/38 pass |
| R: Checkpoint D serving/versioning (new) | 6/6 pass |
| R: Football Intelligence (`analysis/football_intel/tests`) | unaffected — `invariants` 24/24, `week-completion` 23/23 |
| TS: `test/player-role-intelligence.test.ts` (new) | 26/26 pass — reader (11), formatters (2), lineage/freshness (11), production isolation (2) |
| TS: full repository (`npm test`) | 1953/1953 pass, 4 skipped (unchanged skip set) |
| `tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 29 pre-existing warnings (unchanged) |

No new failures anywhere.

---

## 11. Performance

| Step | Cost |
|---|---|
| R: rebuild profiles + serve artifacts (`serve_role_intelligence.R`, 1,200 players) | ~30-32s |
| R: Checkpoint B substrate rebuild (unchanged, reused when needed) | ~50s |
| **Total weekly-rebuild cost (B + D serving)** | **~80-85s** |
| TS: parse manifest + 1,200 profiles + 458 events (`loadRoleOpportunitySnapshot`, cold, incl. module load) | 75ms |
| Served artifact total size | 901 KB (profiles) + 81 KB (events) + 2.7 KB (manifest) + 361 KB (Checkpoint B substrate CSV, unchanged) ≈ 1.35 MB |
| Internal artifact (unchanged from Checkpoint B) | 6.8 MB (`.rds`, git-ignored) |

Weekly maintenance remains practical: under 90 seconds end-to-end for a full substrate + profile + served-artifact rebuild, and sub-100ms to load and validate on every server start. No memory concerns observed at this scale (1,200-2,000 rows/season).

---

## 12. Known limitations (carried forward, not hidden)

1. **TE role-level thresholds reuse WR quantiles** — not independently calibrated for TE. Stated explicitly in the served manifest's `model_configuration.role_level_calibration_basis.TE`, not just in this doc.
2. **Confidence is calibrated globally and positionally as actually backtested — not separately for rookies, team-changers, or volume tiers.** Stated explicitly in the served manifest's `model_configuration.confidence_calibration_scope`.
3. **Routes remain source-lagged for the entire 2026 season to date** (upstream `nflreadr::load_participation(seasons=2026)` still 404s as of this checkpoint) — live-verified in §7, not assumed carried over from Checkpoint B.
4. **Alignment, motion (player-level), pass-blocking, and run-blocking remain genuinely unavailable** — listed explicitly in the manifest's `known_unavailable_feature_families`.
5. **No future injury propagation** — Role Intelligence remains strictly OBSERVED/historical; an in-game backup expansion is reported as observed, never as a projected future role (Checkpoint C invariant, unchanged, re-verified structurally this checkpoint via the "no project*/next_week/future_*" schema check carried over).
6. **No API/bridge endpoint was added** — analytical access is library-methods-only, matching Football Intelligence's own precedent. This is a scope choice, documented in §5, not an oversight; a thin route over the existing read functions would be a small, low-risk future addition if a consumer needs HTTP access.
7. **The two remaining Checkpoint B-era deferred infrastructure defects** (FI's postseason schedule filter, unnormalized `return_team`) remain unfixed, per every checkpoint's consistent scope boundary — see `docs/PLAYER_ROLE_OPPORTUNITY_PHASE_2_DEFERRED_DEFECTS.md` (unchanged this checkpoint; no new infrastructure defects were discovered in Checkpoint D).

---

## 13. Checkpoint D verdict

```
CHECKPOINT D COMPLETE — READY FOR REVIEW
```

Summary of what changed since Checkpoint C: Role & Opportunity Intelligence now has its own content-deterministically-versioned served artifact set (manifest + wide profile CSV + change-event CSV), a validated read-only TypeScript contract with stable-identity player lookup, a deterministic diagnostic formatter, and first-class, additive integration into Phase 1's existing `RecommendationLineage` and freshness-evaluator substrate — via a careful, verified-behavior-preserving extraction of the shared disagreement-comparison logic, not a fork. The Checkpoint C model was not altered. No production consumer was touched, proven both structurally (grep-based isolation tests) and behaviorally (identical regression counts, +26 new tests only). Live verification confirms every layer — upstream source, cache, substrate, manifest, TS reader, and freshness evaluator — agrees that 2026 route data remains genuinely unavailable, with nothing in the served product claiming otherwise.

**STOP. Do not begin Checkpoint E.**
