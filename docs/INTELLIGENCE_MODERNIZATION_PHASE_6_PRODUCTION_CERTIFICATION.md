# Intelligence Modernization — Phase 6: merge, deployment and production certification

Date: 2026-09-21. Operationalization only: no scoring redesign, no new support, no Phase 7.

## 1. Verdict
**A — PHASE 6 OPERATIONAL IN PRODUCTION.** Every production behavior is either unchanged or changed exactly as the certified scoring correction (D-1) predicts: 67 offensive projections changed, **0 unexplained**, each reproduced to the cent by an independent re-implementation of the old and new scoring paths.

## 2. Git
- Certified branch `intelligence-modernization-phase6-scoring-contract`, tip `2efbd6e` (verified clean, unchanged).
- Prior `main` = production = `31ae6a0` (an automated Football Intelligence data refresh, `fi:2026:w02:bfd77…` → `e1ffe…`; the expected base `9f63275` had moved by exactly this one commit).
- **Drift audit:** the only intervening commit changed 7 `lib/football-intel/data/*` files; zero file overlap with Phase 6 and no scoring/weekly/waiver/trade/canonical/book-ready/analysis-book/provider/schema/cron files touched. No semantic interaction with scoring; no reconciliation needed.
- Merge: `main` diverged, so a fast-forward was impossible. A **merge commit** `9329465` preserves the certified Phase 6 SHAs (no rebase/rewrite, no force). Merged tree = the 21 Phase 6 files + the 7 FI data files, nothing else.
- Follow-up commit: this record plus `test/scoring-return-invariant.test.ts` (test/doc only). Working tree clean.

## 3. Rollback reference
Prior deployment `dpl_Awz56HZQJRYc9oRh7rW1GDL17vS7` @ `31ae6a0`; aliases `bloodline-bowl-sleeper-bridge.vercel.app`, `…-supyo29s-projects.vercel.app`, `…-git-main-supyo29s-projects.vercel.app`. Migrations through `20260921051441 matchup2_shadow_captures` (unchanged). Live fingerprints: bloodline `scoring:v1:29acc6bc…`, devoted & sportys `scoring:v1:d4795fa7…`. Pre-merge production hashes (week 2, stable across 2 rounds): supyo29 lineup `ceb420796dd8` / start_sit `6123db977eb9` / waivers `e1bc7d1f993e` / matchup `b27443a851ce` / leverage `0529c3441da4` / positional_needs `8274e4deb6b8`; bijimac `f92dfb060741` / `4f53cda18c2b` / `e1bc7d1f993e` / `e4de6fd2766f` / `4f53cda18c2b` / `e5996633e34e`; darthmarker `ac0eb1c3e85d` / `a28f8533e79e` / `ad0ea2116094` / `25eb20b9a2f0` / `fe738e76d4aa` / `7951596ceef9`. Rollback = redeploy `dpl_Awz56…` (no schema to reverse).

## 4. Deployment
`dpl_G5RQcghuTTGpFnheW8NJGPrLLKvy` @ `93294655168cc8237f17992c7966a6e22e5f94e6`, READY, all three aliases attached, `aliasError: null`. **No database migration required** (no `supabase/` change in the diff; migration list unchanged).

## 5. Scoring defects (production verification)
| Defect | Production verification | Observed |
|---|---|---|
| D-1 return-yard double count | controlled interleaved run of production code `31ae6a0` vs merged `main` on the same live state; independent path re-implementation | 67 Bloodline returners lowered; exact attribution (§6) |
| D-2 TE/RB/WR premium (season/draft/trade path) | no live league scores a position premium; controlled fixtures + ROS/season tests on merged main | TE premium = exactly 0.5×rec, once, TE-only; live leagues unaffected |
| D-3 position-aware waiver pricing | controlled Waiver 2.0 execution on merged main | TE role-delta rises only under premium; WR unchanged; no live-league change (waivers hash identical in all 3 pairs) |
| D-4 unsupplied-rule visibility | executed on merged main | info-level batch warning only for leagues with such rules; none of the live leagues triggers it; batch status unchanged |

## 6. Numeric production differences (all intentional; separated from drift)
**Live-data drift was excluded** by running production code and merged code interleaved against the same live Sleeper state (twice; both sides self-stable). Result: **67 of 3,305 projections changed (34 WR, 33 RB); every one lowered; every one carried the old kick-return enrichment warning; 0 changed for any other reason; 0 unexplained.**

Scoring path traced for each changed row (Bloodline scoring: `kr_yd`, `def_kr_yd`, `pr_yd` all 0.04): provider `def_kr_yd` (individual returner's kick-return yards, published under the team-defense key) was priced at the `def_kr_yd` rate by the old code **and** the season-model enrichment added a second `kr_yd` on top. New code renames the provider value to `kr_yd` and enrichment (provider-first) no longer fires. Delta = −0.04 × the removed enrichment `kr_yd`, exactly.
| Player | provider `def_kr_yd` | old enrichment `kr_yd` | old pts | new pts | delta | removed duplicate |
|---|---|---|---|---|---|---|
| Deebo Samuel (WR) | 24.94 | 27.3 | 10.84 | 9.75 | −1.09 | 0.04×27.3 = 1.09 |
| Chuba Hubbard (RB) | 4.29 | 6.4 | 11.85 | 11.59 | −0.26 | 0.26 |
| Bhayshul Tuten (RB) | 17.6 | 16.0 | 9.59 | 8.95 | −0.64 | 0.64 |
| Myles Price (WR) | 69.3 | 32.0 | 5.17 | 3.89 | −1.28 | 1.28 |
| Jaylin Noel (WR) | 24.53 | 32.0 | 9.46 | 8.18 | −1.28 | 1.28 |
The old and new points for every one of the 67 rows were re-derived from the raw provider stats by a separate implementation of both paths and matched to within rounding; no provider row had a `kr_yd` key. Controls (Jahmyr Gibbs, Bijan Robinson, Josh Allen) unchanged. Deltas equal the branch-certification deltas exactly (provider inputs had not moved).

## 7. Six-surface results (production alias, before vs after deploy; 2 rounds each, stable)
| Pair | lineup | start_sit | waivers | matchup | leverage | positional_needs |
|---|---|---|---|---|---|---|
| bloodline-bowl / supyo29 | changed (downstream of Deebo −1.09) | changed (downstream) | unchanged | changed (downstream) | changed (downstream) | changed (downstream) |
| bloodline-bowl / bijimac | changed (Hubbard −0.26, Tuten −0.64) | unchanged | unchanged | changed (downstream) | unchanged | changed (downstream) |
| devoted-to-the-game / darthmarker | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged |
Lineup composition is identical (same player in every slot) in both Bloodline lineups; the only change is the three projection values above (supyo29 total −1.09, bijimac −0.90). Changed derived sections follow those point values. No metadata-only or unexplained differences. The stable league (contract does not exercise the correction) is byte-identical on all six surfaces.

## 8. Scoring support matrix
147 rules — 21 FULLY_PROPAGATED, 15 DECISION_LAYER_MISSING, 10 NONLINEAR_PROJECTION_UNRESOLVED, 72 PROVIDER_LIMITED, 6 EXACT_HISTORICAL_ONLY, 23 UNSUPPORTED, 0 PROJECTION_APPROXIMATION, 0 CATALOG_ONLY — identical to the certified matrix on merged `main` (freshness test green); no rule upgraded by deployment.

## 9. K / D-ST
Weekly K and D/ST remain **PROVIDER_LIMITED** (Sleeper standard points, league-agnostic). Re-measured on today's feed with `scripts/scoring-kdst-materiality.ts` — identical to certification: bloodline D/ST mean|Δ| 1.54 / rank-corr 0.839, K 1.23 / 0.739 (MATERIAL_DIVERGENCE); devoted & sportys 0.02 / 0.997–0.999 (IMMATERIAL). Exposed in production: live `scoring.league_contract` `contract.weekly_basis.k_dst` = `PROVIDER_STANDARD_POINTS_NOT_LEAGUE_SPECIFIC` with the measured bound and the unreflected rules, and every K/D-ST `rule.*` block is `PROVIDER_LIMITED` / `PROVIDER_STANDARD_POINTS`. Nothing synthesized.

## 10. IDP
Still **UNSUPPORTED** (23 keys: no IDP players, projections or roster slots). No production evidence to the contrary.

## 11. Nonlinear scoring
No false certainty introduced. Tests at 99/100/101 receiving and 299/300/301 passing: completed games earn the inclusive threshold; projected lines never do (`NONLINEAR_PROJECTION_UNRESOLVED` preserved for all 10 threshold rules). No probability model exists or was added.

## 12. Return scoring
Provider normalization: individual lines never carry team-defense return keys; `def_kr_yd` → `kr_yd` when `kr_yd` absent; both present ⇒ `kr_yd` wins. Enrichment fires only when neither is present. **Exhaustive invariant grid (32 cells: provider {none, def_kr_yd only, kr_yd only, both} × enrichment {absent, present} × league {no return rule, kr only, def only, both})**: every cell prices the return yards exactly once at the individual `kr_yd` rate; the team-defense `def_kr_yd` rule never prices an individual. Downstream: the 67 returner projections, §7 surfaces.

## 13. Position premiums
Projection path, waiver path and trade-input path verified on merged `main` (tests): identical TE/WR line under normal PPR is equal; under TE premium the TE gains exactly `bonus_rec_te × rec`, base PPR retained, premium added once, WR unaffected; provider-supplied key is never re-derived (idempotent); RB/WR premiums likewise. Waiver: same role growth, TE value rises only under premium by share-delta × volume × premium × rec/target. Trade: season and ROS inputs reflect the premium exactly; proven at the input layer only — a full `evaluateTrade` result is not claimed, and `pprModeOf` still classifies format from `rec` alone (unchanged, documented).

## 14. Fingerprint integrity
Adversarial suite green on merged main: order-invariant; explicit 0 ≡ absent; serialization noise collapses; PPR, TE-premium, return-yard, D/ST-tier, IDP, threshold changes each alter it; all 11 synthetic leagues pairwise distinct. One authoritative general hash; legacy `hashScoringSettings` unchanged and scoped. Live fingerprints unchanged by the deploy.

## 15. Matchup2 compatibility
Phase 5 captures untouched: 291 rows, window 14:31:16–14:31:42 UTC, 2 fingerprints, 21 LIVE_CAPTURED / 270 LIVE_POST_LOCK, 0 outcomes, content digest `e0816ec3…` (verified after deploy). **The scoring fingerprint identifies the league's scoring contract, not the implementation version**: the D-1 correction did not change any league's rules, so no fingerprint changed. Future Bloodline captures take their baseline from the corrected weekly projections under the same fingerprint (returner baselines ≈1.1–1.3 pts lower). The baseline record carries its source model version; the projection model version string was not bumped by Phase 6, so pre/post-fix baselines within one fingerprint are distinguishable only by capture timestamp/deployment — recorded as an observation, not altered (no history rewriting).

## 16. Book-Ready (live production)
`scoring.league_contract` live on the existing evidence layer for all three leagues (47/44/44 blocks, validation ok, 0.4–1.6 s). Examples: `rule.rec` 0.5/1.0 → FULLY_PROPAGATED, exact, weekly NATIVE / season SUPPLIED / historical EXACT_NATIVE / waiver PRICED; `rule.kr_yd` 0.04 → DECISION_LAYER_MISSING (weekly DERIVED, waiver role missing); `rule.pts_allow` −0.3 and `rule.fgm` 3 (bloodline), `rule.pts_allow_14_20`, `rule.fgm_40_49` (devoted/sportys) → PROVIDER_LIMITED / PROVIDER_STANDARD_POINTS with limitation text; contract blocks state offense basis `COMPONENT_RESCORED_WITH_LEAGUE_SCORING` and K/D-ST basis `PROVIDER_STANDARD_POINTS_NOT_LEAGUE_SPECIFIC` with the measured bound. Lineage = scoring fingerprint; deployment SHARED_DESCRIPTIVE, `may_influence_production:false`, predictive DESCRIPTIVE_ONLY. No live league scores a TE premium, threshold bonus or IDP rule, so those block types are certified through the fixtures (test suite), not live data. One registry (no second).

## 17. Analysis Book
99 chapter ids unchanged; `scoring.league_contract` remains an optional `enrich` need on `decision.replacement_value`, `decision.roster_fit`, `decision.market_value`, `trade.player_value`; no scoring chapter added; conformity/planner tests green — no chapter promoted or demoted.

## 18. Performance
Local (merged tree): scoreWeeklyLine 1.83 µs → Phase 6 path 3.50 µs (+1.7); full 3,305-row feed 10.9 ms; `leagueScoringContract` ~97 µs once per batch. Support module data is a static JSON import (parsed once); fingerprint hashing is not repeated per player; no provider calls inside scoring loops. Production: contract endpoint 0.4–1.6 s; all sampled requests HTTP 200.

## 19. Tests
Merged `main` before push: **2,483 total / 2,479 passed / 0 failed / 4 skipped** (identical to the certified branch; the FI refresh does not change the count). `tsc --noEmit` exit 0; eslint on changed/relevant files exit 0. Focused: 161 scoring/registry/Analysis Book/Matchup2-capture/Waiver/return tests green. After adding `test/scoring-return-invariant.test.ts` (33 tests: 32-cell return grid + nonlinear boundaries): **2,516 total / 2,512 passed / 0 failed / 4 skipped** (2,483 + 33); `tsc` clean; eslint clean on the new file. The 4 skips are the pre-existing skipped tests, unchanged.

## 20. Fixes made
**None** to production code. Only additions: the return-invariant/boundary test file and this record.

## 21. Remaining limitations
Weekly K/D-ST provider limitation (material for Bloodline Bowl); unresolved nonlinear projection thresholds; IDP unsupported; return-role → waiver value translation incomplete (`DECISION_LAYER_MISSING`); Yahoo scoring ingestion incomplete (numeric stat ids unmapped); the provider-key snapshot is dated 2026-09-21; historical rows carry the legacy `scoring_settings_hash`; Sleeper >2 MB projection payloads exceed the Next data-cache limit (warning + refetch; no such warning appeared on the new deployment's request logs); Phase 5 outcome ingestion not built; sacks-taken/first-downs/target-depth counts not used in season/trade layers; `pprModeOf` ignores position premiums; baseline-vintage distinction within one fingerprint relies on timestamp/deployment.

## 22. Next phase
Phase 6: CLOSED
Phase 7: NOT STARTED
