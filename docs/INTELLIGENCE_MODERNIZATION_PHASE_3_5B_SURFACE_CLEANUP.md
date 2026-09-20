# Intelligence Modernization — Phase 3.5B
## Existing Intelligence Surface Cleanup & Consistency Certification

Scope: audit and repair the intelligence surfaces that already exist so Phase 3.5C (Book-Ready) does not inherit stale
labels, mismatched artifacts, conflicting semantics, unreachable data, duplicated interpretation or documentation drift.
**No new models, no tuning, no production decision changes.** Frozen: `ri-startsit-2026.1` (sha256 `85d2ddd5…6293`), Phase 1
contracts, certified Phase 2/3 model logic. Not in scope: Book-Ready outputs (3.5C), Phase 4. Not merged, tagged or deployed.

Machine-checkable registry: [`docs/intelligence-surface-registry.json`](intelligence-surface-registry.json), verified against the
repository by `test/intelligence-surface-registry.test.ts`.

---

## 1. Starting repo state
| | |
|---|---|
| Base | `main` = `origin/main` = `1c64ecb` (clean), branch `intelligence-modernization-phase3-5b-surface-cleanup` |
| FI | `fi:2026:w02:afa8f98be61e` (through wk 2, PARTIAL 1/16), model tag `ri-football-intel-2026.1` |
| Role & Opportunity | `roi:2026:w01:819dc3166607` (through wk 1) |
| Opportunity Propagation | `opi:2026:w01:bef17990fe91` (through wk 1), depends on the Role version above |
| Player-Scheme | `psi:2025:w18:08123edd58c9` (PRIOR_ONLY) |
| Start/Sit | `ri-startsit-2026.1`, `SHADOW_ONLY`; re-eval `NOT_ELIGIBLE` 0/4 |
| Production | `dpl_3eNgSqQ2…` (docs) over `dpl_AN1qt3wY…` (Phase 3.5A code, `32f2178`) — Phase 3.5A production-certified |
| Automated refresh | daily FI bot commits (`fbf9d26` …) touch only `lib/football-intel/data/*` |
`origin/main` was re-fetched at every checkpoint; drift is logged in §16.

## 2. Surface inventory (15 surfaces)
Statuses use the existing vocabulary (ACTIVE / SHADOW / DESCRIPTIVE_ONLY / RESEARCH_ONLY / SOURCE_CONFLICT …); reachability was traced
from real imports, never inferred from names.

| Surface | Status | Reachability | Deployment |
|---|---|---|---|
| Canonical spine (lineage/freshness/readiness/frontier/scoring id) | ACTIVE | computed at request | frozen Phase 1 |
| Football Intelligence (ratings, usage, coverage, matchup features) | ACTIVE, DESCRIPTIVE_ONLY | **library-only, intentional** | SHARED_DESCRIPTIVE |
| FI receiver progression (FTN read_thrown) | ACTIVE, DESCRIPTIVE_ONLY, **SOURCE_CONFLICT** | route | SHARED_DESCRIPTIVE |
| Role & Opportunity (Phase 2) | DESCRIPTIVE_ONLY | library-only, intentional | SHARED_CONTEXT |
| Opportunity Propagation (Phase 3) | SHADOW | library-only, intentional, no consumer | SHADOW_ONLY |
| Player-Scheme Tiers A–C | DESCRIPTIVE_ONLY, SOURCE_CONFLICT | 5 routes | SHARED_DESCRIPTIVE |
| Player-Scheme Tier D interactions | RESEARCH_ONLY, SHADOW | route | SHADOW_ONLY (adj ≡ 0) |
| Start/Sit FI | SHADOW | embedded + diagnostics route | SHADOW_ONLY |
| Matchup Intelligence | SHADOW | embedded in `/api/intelligence`, `/api/matchup` | SHADOW_ONLY |
| Roster Health | ACTIVE, DESCRIPTIVE_ONLY | routes | SHARED_CONTEXT |
| Schedule Planning | ACTIVE, DESCRIPTIVE_ONLY | routes | SHARED_CONTEXT |
| Orchestrator | ACTIVE | routes | ADVISORY_ONLY |
| Waiver engine | ACTIVE | routes | production (readiness-gated) |
| Trade engine + Competitive | ACTIVE | routes | read-only analytics |

## 3. Registry
Fields per surface (all verified by test): owning module, builder command + entrypoints, served artifacts, manifest + version field,
readers, routes, source data, cutoff field, predictive/descriptive nature, deployment, confidence semantics, freshness owner, lineage
owner, reproducibility class, docs, tests, consumers (checked **both directions** against a real import-graph resolver).
`lib/canonical/intelligence-surface-registry.ts` holds the types; the data is JSON under `docs/` on purpose — repository isolation tests
text-scan `lib/` and `app/` for module paths, and a registry necessarily names every module. Phase 3.5C should extend this registry.

## 4. Builder ↔ artifact ↔ reader parity
| Artifact set | Method | Result |
|---|---|---|
| **FI (all 7 files)** | isolated rebuild (`build_candidate.sh`, workflow's own `fetch_raw.R --refresh`) vs served | `contextual_matchup_feature.csv`, `ftn_descriptive.csv` **byte-identical**. `team_profile`, `unit_coverage_profile`, `player_usage_profile`, `receiver_progression`: schema equal, every numeric difference ≤ **1e-13** → *deterministic float noise* (local `nflreadr` 1.5.0 vs CI 1.5.1). `data_cutoff` PFR 1→2 = *expected upstream drift* (no value effect ≥1e-13). **Only semantic difference: `player_usage_profile.output_class`, 6,584 rows `OBSERVED→MODELED` = the intended fix (§5).** |
| Role, Opportunity Propagation, Player-Scheme (44 files) | hash-pinned (`test/intelligence-artifact-parity.test.ts`); manifest row counts, versions, cutoffs, cross-manifest dependency, lineage builders checked | consistent; a targeted rebuild that rewrites an unrelated artifact now fails a test |
| Start/Sit model + 5 weekly artifacts | hash-pinned; model↔manifest agreement | consistent; frozen hash pinned |
| Tier B/C/D builders | static check | each writes only `manifest$tiers` + its own `tier_x` key → cannot rewrite unrelated tiers |
Nothing was regenerated over the served artifacts; the FI candidate lived only in a scratch root.

## 5. Schema / label semantics findings
| ID | Sev | Finding | Action |
|---|---|---|---|
| S1 | **P1** | `player_usage_profile.csv` labelled **every** row `OBSERVED` even when `observed = NA` (whole `route_participation` family, 1,210 rows; also 5,374 other rows). Deferred defect #3 (Phase 2), still live. | **Fixed** in `lib_usage.R` (`MODELED` when `observed` absent — existing vocabulary), enforced by `validate_snapshot.R` (publish gate), and applied by the reader (`usageOutputClass`) so it is truthful now; the served CSV republishes at the next daily refresh. |
| S2 | P3 | Scale audit: 15 fraction-named columns exceed 1.0 (`snap_share_derived` QB kneel case; `*_opportunity_total` are **counts**; inheritance `*_rate` are **ratios**). All documented/needed. | Permanent test with a reasoned allowlist that fails on any *undocumented* >1 column **and** on stale exceptions. |
| S3 | P3 | FI `league_percentile` is a 0–1 fraction, not 0–100. | Test. |
| S4 | P3 | `DIRECTORY_METADATA_GAP`: Player-Scheme directory has 4 entries with `position = 'XX'` or blank identity (source-native `XX`) while profile files hold real data for them (e.g. 96 receiver rows on a blank identity). | Not papered over, no invented identity; pinned in a test so growth/resolution is noticed; consumers must treat `XX`/blank as UNKNOWN. |
| S5 | info | Cross-surface vocabularies differ for the same concept: FI/Role `confidence` (INSUFFICIENT_SAMPLE/LOW/MEDIUM/HIGH) vs Player-Scheme `evidence_class` (INSUFFICIENT/WEAK/MODERATE/STRONG); `bucket` uses source-native `UNDER CENTER` alongside underscore labels; FI contextual `predictive_status` is the compound string `off:X|def:Y`. | Documented, not renamed (certified/source-native). 3.5C prerequisite. |
| S6 | info | `start_sit_model.json.football_intelligence_version` is the FI snapshot the frozen model was **trained** against (`fi:2025:w18…`), not the live FI version. Same field name as runtime lineage. | Cannot edit the frozen artifact; pinned by test and documented. |
| S7 | P3 | `player_scheme_manifest.tier_d.files` serialised as a bare string (R `auto_unbox`) while other tiers are arrays. No reader consumes it. | Builder fixed (`list(...)`) for the next rebuild; parity test tolerates both. |
| — | ✔ | **FTN read_thrown re-verified end-to-end** (§13). |

## 6. Lineage / version findings
| ID | Sev | Finding | Action |
|---|---|---|---|
| L1 | **P2** | `player_scheme_version` = hash of the **Tier A frames only** (`build_tierA.R`). The 2026-09-19 progression relabel changed served Tier B content but not the version or the top-level `generated_at`. Consumers could not tell served content had changed. | **Fixed** additively: `content_identity` (`served_content_id` = hash of all tiers' `served_content_sha256`, plus per-tier `built_at`/`content_id`) in every Player-Scheme response meta; `player_scheme_version` semantics untouched. Test proves any tier change moves the id. |
| L2 | **P2** | `/api/football-intel/players/{id}/progression` **hand-assembled** its lineage from the manifest instead of using the canonical `buildFootballIntelligenceLineage`, and omitted `generated_at`/`week_completion`. | **Fixed** additively: `lineage.football_intelligence` **is** the canonical lineage; the legacy flat fields are derived from it. Route test asserts equality with the manifest. |
| L3 | ✔ | FI/Role/OPP lineage builders derive from manifests; version embeds season/week; every CSV's `season`/`through_week` equals the manifest; OPP's Role dependency equals the served Role snapshot; Role `row_counts` = CSV rows; data cutoffs ≤ `through_week`. | Permanent tests. |
| L4 | info | Role/OPP are one week behind FI (`w01` vs `w02`) because they are built through the last **complete** week, FI publishes a PARTIAL week. Phase 1 freshness handles this; not a defect. | Documented. |
| L5 | info | Role, OPP and Player-Scheme have no scheduled refresh (only FI does). Player-Scheme is PRIOR_ONLY by design. | Registry `PINNED_STATIC`; deferred (§13). |

## 7. Reachability
* **Fully reachable:** FI progression, Player-Scheme (5), roster-health, schedule-planning, orchestrate, weekly/waiver/lineup/matchup/intelligence, trades.
* **Embedded:** Start/Sit FI shadow and Matchup Intelligence (inside `/api/intelligence`, `/api/matchup`).
* **Library-only by documented design (no route, verified by test):** FI ratings, Role & Opportunity, Opportunity Propagation (also no consumer).
* **Internal artifacts, no runtime reader (by design, asserted):** `start_sit_manifest.json`, `start_sit_validation.csv`, `start_sit_feature_status.csv`, FI `validation_result.json`.
* **R1 (P2) — discovery gap, fixed:** AI discovery (`/api/ai`, "start here for the full service map") advertised 24 capabilities and **none** of: roster-health, schedule-planning, orchestrate (league+manager), the 5 Player-Scheme routes, or the Start/Sit evidence diagnostics — certified, deployed routes invisible to AI clients (confirmed live). **Added 12 capabilities** with truthful nature statements; `test/discovery-route-coverage.test.ts` now fails on any route that is neither advertised nor allowlisted with a reason.
* **R2 — deferred:** the legacy trade POST routes (`/api/trades/analyze|discover|negotiate`) are allowlisted, not advertised: discovery has no request-body schema for them (only competitive trade does).

## 8. Duplicate interpretation findings
| Concept | Finding | Action |
|---|---|---|
| Completed NFL week | one TS owner (`isCompleted`, shared by frontier + per-week completion). R's `week_completion` (nflverse) is the deliberate second source compared by Phase 1 freshness. | none |
| Team alias normalizer | `PSI$normalize_team` is a verbatim **copy** of `FI$normalize_team`. | R drift-guard test (identical on all aliases/odd input). |
| Deployment lifecycle | state machine implemented twice (Start/Sit FI, Matchup Intelligence), identical logic, different names. Both frozen. | Full-matrix parity test; not refactored. |
| Scoring identity | `hashScoringSettings` (legacy) vs `scoringFingerprint` (canonical) — known and documented in Phase 1. | none |
| FI lineage | progression route re-derived it (L2). | fixed |

## 9. Artifact reproducibility
| Artifact | Build command | Isolation | Validation |
|---|---|---|---|
| FI (7 files) | `bash analysis/football_intel/build_candidate.sh <root>` after `fetch_raw.R --refresh` (daily workflow) | candidate root; served dir untouched | `validate_snapshot.R` gate + parity test |
| Role | `analysis/player_role/run_build.R`, `run_role_profile.R`, `serve_role_intelligence.R` | writes `lib/player-role-intelligence/data` | R tests + hash pin |
| Opportunity Propagation | `analysis/opportunity_propagation/run_build.R`, `serve_opportunity_propagation.R` | writes its own data dir | R tests + hash pin |
| Player-Scheme | `build_tierA…D.R` | B/C/D touch only own manifest key | R tests + hash pin |
| Start/Sit | frozen; `analysis/football_intel_startsit` (scratch-only for v1, Phase 3.5A guard) | write guard | hash pin |
Environmental caveat learned: refreshing the shared FI raw cache (needed to rebuild FI) makes other R suites see newer data than their stored substrate — see §14 (two suites had latent fragility).

## 10. Documentation drift
* `FOOTBALL_INTELLIGENCE_REFRESH.md`: manual `git add` example omitted the sixth served file `receiver_progression.csv` (workflow was correct) → fixed + correction note.
* `PLAYER_ROLE_OPPORTUNITY_PHASE_2_DEFERRED_DEFECTS.md` #3: original finding preserved, **later-correction** block added (fixed; entries 1–2 unchanged and still open).
* Phase 3 audit/Checkpoint B/C docs named `lib/injury-opportunity-propagation/`; it shipped as `lib/opportunity-propagation-intelligence/` → path notes added, findings untouched.
* Three parallel phase numberings exist (Team Management 1–9, Trade Engine 1–6, Intelligence Modernization 1–3.5). Comments saying "Phase 4" in `lib/weekly/start-sit-fi` mean **Team Management** Phase 4, not the upcoming Intelligence Modernization Phase 4. Not mass-edited; recorded here as a 3.5C/4 prerequisite.
* Discovery prose (`/api/ai`, `llms.txt`, sitemap) renders from `lib/discovery.ts`, so the R1 fix propagates.

## 11. Capture-volume assessment (Start/Sit evidence)
Measured in production (read-only): **avg record 13.9 KB JSON, ~3.25 KB stored (TOAST-compressed), 16 adjustments/record**, 6 rows, table 120 kB, DB 638 MB.
* *Write amplification:* one write per (manager × distinct decision content). Content changes only when an upstream projection changes (observed once, SF DEF 9.17→9.20). Requests cannot force writes; only registered managers are captured; repeated/cached requests are no-ops (Phase 3.5A proof).
* *Volume:* realistic (3 known managers, ~8 material ticks/day) ≈ 24 rows/day ≈ **80 KB/day ≈ 11 MB/season**. Pessimistic bound (60 managers polled hourly with hourly ticks, every day) ≈ 1,440 rows/day ≈ 4.7 MB/day ≈ 650 MB/season — unrealistic, and still bounded by upstream tick rate.
* *Delta / content-addressed / compaction:* would save storage but risks the chronology guarantee; **deferred, not needed**. Nothing is deleted or compacted; identity semantics unchanged.
* **One near-term operational risk found and fixed:** the *diagnostic* `summary()` (Phase 3.5A) read the full ~14 KB `record` for up to 5,000 rows on an **unauthenticated** route → unbounded read amplification as evidence grows. Now: a narrow column select for counts; heavy JSON only for ≤300 most recent `LIVE_CAPTURED` rows; `per_position_truncated` / `counts_truncated` flags are explicit (never silently partial). Verified by a PostgREST-stubbed contract test; **not verified against the deployed PostgREST** (`decisions:record->decisions` alias syntax) until deployment — on failure the route reports `summary_available:false` with the error rather than a wrong number.
* Retention: none required at this volume; revisit if `record_count` exceeds ~50k.

## 12. Defects fixed
| # | Sev | Defect | Fix |
|---|---|---|---|
| S1 | P1 | usage rows with no observation labelled `OBSERVED` | builder + publish gate + reader + tests |
| L1 | P2 | `player_scheme_version` doesn't identify Tier B/C/D content | `content_identity` |
| L2 | P2 | progression route hand-assembled lineage | canonical lineage, additive |
| R1 | P2 | certified routes missing from AI discovery | 12 capabilities + coverage test |
| C1 | P2 | unbounded diagnostic read (capture summary) | bounded, flagged summary |
| T1 | P3 | `test_tierA.R` silently depended on the FI cache holding no 2026 data | compare over the same as-of window |
| T2 | P3 | OPP absence-event determinism test assumed Role substrate and FI raw cache share a vintage | compare over the stored artifact's window |
| D1 | P3 | doc drift (§10) | fixed with correction notes |
| S7 | P3 | `tier_d.files` bare string | builder fix |

## 13. Defects deferred / documented
* **FTN progression (S-conflict) — reverified, no defect.** No code, artifact, route, doc or discovery text maps numeric `read_thrown` to first/second/third read; served buckets are exactly `RAW_0/1/2` + `CHECKDOWN/DESIGNED/SCRAMBLE_DRILL/OTHER`; route exposes `numeric_read_semantics_status: UNVERIFIED_SOURCE_CONFLICT` with the source conflict; no `lib/weekly` / `lib/trades` / start-sit config consumes progression. **Permanent regression tests** scan the whole repo, the served artifacts and the R builder mappings, so a refresh cannot silently reintroduce old labels.
* Deferred-defects doc entries 1–2 (`fetch_raw.R` postseason `game_type` filter; un-normalised `return_team`): still open, invisible to FI, not touched (frozen builder scope).
* S4 directory metadata gaps (needs an identity crosswalk source), S5 vocabularies, R2 trade POST advertising, L5 refresh cadence for Role/OPP/Player-Scheme, consolidating the duplicate lifecycle/normalizer into one owner.
* Served `player_usage_profile.csv` still carries the old labels until the next daily refresh (reader corrects meanwhile).

## 14. Tests
See §17 for final counts. New TS suites: `intelligence-surface-registry` (10), `intelligence-artifact-parity` (12), `intelligence-semantics` (14), `intelligence-route-lineage` (3), `discovery-route-coverage` (3), `deployment-lifecycle-parity` (2) + 1 capture-summary contract test. New R: FI team-normalizer parity. Two existing R tests were repaired (T1, T2) — both encoded a hidden assumption about cache vintage; neither was weakened (they now compare like-for-like windows).

**R failure classification (honest):** after I refreshed the local FI raw cache, two R suites failed — `test_tierA.R` (1,062 = exactly the 2026 REG non-spike pass plays now in the cache) and OPP absence-event determinism (exactly 2 extra events: 2026 wk2 BUF RB `INA`, WR `RES`, from the completed Thursday game). Both = *environmental / live-source drift caused by the cache refresh exposing latent test fragility*, not defects in certified model code; both fixed as above.

## 15. Live read-only verification (production, GET only)
| Route | Result |
|---|---|
| `/api/ai` | 200; **24 capabilities, none for player-scheme/roster-health/orchestrate** (confirms R1 on the pre-3.5B deployment) |
| `/api/player-scheme`, `/teams/KC/defense` | 200; version `psi:2025:w18:08123edd58c9` == repo manifest; `PRIOR_ONLY`, `SHARED_DESCRIPTIVE`; no `content_identity` yet (pre-3.5B) |
| progression | 200 READY; buckets `CHECKDOWN`, `RAW_1` only; FI `fi:2026:w02:afa8f98be61e` == repo manifest |
| `/api/intelligence` | 200; shadow `ri-startsit-2026.1` `SHADOW_ONLY`, `eligible_to_influence_production=false`; FI version == repo == progression |
| `/api/matchup` | 200; `matchup_intelligence` `SHADOW_ONLY` |
| roster-health / schedule-planning | 200; `SHARED_CONTEXT` |
| orchestrate | 200; `ADVISORY_ONLY` |
| waivers / lineup | 200; `NOT_READY` (documented waiver-readiness contract) / `PROJECTIONS_PARTIAL` |
| `/api/football-intel/startsit-evidence` | 200; store supabase, durable |
The branch is not deployed, so the fixes (discovery, lineage, `content_identity`, bounded summary) are verified by handler-level tests and against the production data; they reach production only on an explicit merge/deploy.

## 16. Production isolation
* `main` (`1c64ecb`) vs this branch, live data, back to back, for two managers in two leagues: **all six production sections (lineup, start_sit, waivers, matchup, matchup_leverage, positional_needs) identical**; lineup totals 113.78 / 130.62 identical; `SHADOW_ONLY`, `eligible_to_influence_production=false`.
* `start_sit_model.json` sha256 unchanged (pinned); `fiMayInfluenceProduction`/`anyFiProductionInfluence` false; isolation tests (start-sit, player-scheme, injury-opportunity, orchestrator) green; no waiver/trade/matchup/lineup file modified.
* Drift log: `origin/main` re-fetched after each checkpoint; see final report.

## 17. Test results
* TypeScript `npm test`: **2150 tests / 2146 pass / 0 fail / 4 skipped** (Phase 3.5A baseline 2105 → +45). `tsc --noEmit`: 0 errors. `eslint app lib test`: 0 errors.
* R: FI invariants + week-completion + team-normalizer parity ✔; Start/Sit evidence-gate/candidate/e2e ✔; Player Role ✔; **Opportunity Propagation ✔ (exit 0, after T2)**; Player-Scheme Tier A/D/read-semantics ✔ (after T1).
* Artifact reproducibility: FI isolated rebuild classified (§4); static artifacts hash-pinned.
* Live read-only verification: §15. Production isolation: §16 (main vs branch, two managers, all six sections identical).
* `start_sit_model.json` sha256 `85d2ddd501cc10d5b3a699629f80c0c3781fe12fa24fa834f41969cb0186b293` unchanged.
* Drift: `origin/main` re-fetched at every checkpoint; no commits landed during the phase (last local base `1c64ecb`).

## 18. Limitations
* Fixes S1 (served CSV labels), L1, L2, R1 and C1 are **not live** until merge/deploy; the served usage CSV corrects itself at the next daily FI refresh.
* The bounded-summary PostgREST alias syntax is verified by a stubbed contract test only, not against the deployed PostgREST.
* FI rebuild parity is float-noise-level, not byte identity, because local `nflreadr` (1.5.0) differs from CI (1.5.1).
* Role/OPP/Player-Scheme have no scheduled refresh; the R suites depend on local raw-cache vintage and need consistent caches.
* Directory metadata gaps (S4), differing evidence vocabularies (S5), duplicated lifecycle/normalizer (§8) are guarded, not consolidated.
* Legacy trade POST routes remain unadvertised (R2). Deferred-defect entries 1–2 remain open.

## 19. Phase 3.5C (Book-Ready) prerequisites discovered
1. Extend the surface registry rather than build a parallel one; give each surface a declared retrieval shape.
2. A single evidence-strength vocabulary mapping (confidence vs `evidence_class`) before percentiles/comparison sets span surfaces.
3. Decide how consumers must treat `XX`/blank directory identities and source-native labels (`UNDER CENTER`, compound `predictive_status`).
4. Scale rules (fraction/count/ratio) from the scale audit must travel with any chart-ready dataset (e.g. inheritance ratios >1, QB snap share >1).
5. Every Book-Ready response should embed the canonical lineage plus `content_identity`-style all-tier identity, not just a Tier-A version.
6. Body schemas for trade POST routes if they are to be advertised.
7. Role/OPP/Player-Scheme refresh cadence before historical series are built on them (series over PINNED_STATIC artifacts are frozen at their last build).
8. Phase numbering: three parallel schemes exist; Intelligence Modernization "Phase 4" is not Team Management Phase 4.

## 20. Certification verdict
**CERTIFIED WITH DOCUMENTED LIMITATIONS.** All gates hold: no served field has knowingly incorrect semantics (S1 fixed; unresolved semantics labelled, FTN conflict permanently guarded); builders and served artifacts agree and unrelated rewrites are now detected; lineage uses canonical owners and every tier's content is identifiable; intended surfaces are reachable and internal ones classified; production behaviour is unchanged (six-section parity); no shadow model activated; `ri-startsit-2026.1` frozen. Limitations in §18 are why this is not an unqualified CERTIFIED. Not merged or deployed.


---

## 21. Merge, deployment & production verification (2026-09-20)

The branch-certification findings above are unchanged. This section records what happened on `main` and in production.

### 21.1 Reconciliation and merge
| | |
|---|---|
| Certified branch tip | `bec37cd` (`5fa68c8`, `689c48a`, `bec37cd`) |
| `origin/main` before merge | `1c64ecb` = merge-base; 0 commits on main not on branch → **fast-forward** `1c64ecb..bec37cd`, no force-push |
| Drift after merge | **`265dabd`** `github-actions[bot]` FI refresh (`fi:2026:w02:afa8f98be61e` → `bfd77c9959a6`): `football_intelligence_manifest.json`, `player_usage_profile.csv`, `team_profile.csv`, `unit_coverage_profile.csv`. Inspected, integrated by fast-forward, affected gates rerun (below). |
| Final commits | `db5f969` = fix commit on top of `265dabd`; `main == origin/main == db5f969`, tree clean |
| Frozen model sha256 | `85d2ddd501cc10d5b3a699629f80c0c3781fe12fa24fa834f41969cb0186b293` verified before merge, after merge, on final main |
Rollback reference (pre-merge): `dpl_EEv5hKawZa7QXRJhkfK4cXjQFvMU` @ `1c64ecb`, discovery 24 capabilities, FI `fi:2026:w02:afa8f98be61e`, `psi:2025:w18:08123edd58c9`.

### 21.2 Deployment
`dpl_6rwGW53L…` READY on `bec37cd`; the bot's `265dabd` deployed as `dpl_3hZZLR4s…`; **final `dpl_7cLpd9UH2LYAoTHjKP5os2THiirx` READY, `githubCommitSha = db5f969d…` (exact match to final main)**, all three production aliases attached, `aliasError: null`.

### 21.3 FI usage label (S1) — verified in three distinct layers
1. **Code deployed correctly:** reader (`usageOutputClass`), builder (`lib_usage.R`) and publish gate (`validate_snapshot.R`) are in the deployed SHA.
2. **Existing served artifact was stale** (as documented): pre-merge `player_usage_profile.csv` had 6,584 rows labelled `OBSERVED` with no observation.
3. **The repository's normal guarded refresh republished it, with no manual edit.** Merging touched `analysis/football_intel/**`, which triggers the refresh workflow (run `35516363277`, success; it builds with the fixed builder and runs the fixed validation gate). Published `265dabd`: **0** `OBSERVED` rows with `observed = NA`; **all 1,210 `route_participation` rows `MODELED`**; 6,584 `MODELED` (no observation) and 4,306 `OBSERVED` (all with real values). Versus the previously served artifact the only change in that file is exactly the 6,584 labels; `team_profile` / `unit_coverage_profile` numeric changes are ≤ 5e-14 (within the certified 1e-13 tolerance); `data_cutoff` PFR 1→2 is upstream drift.
* **Evidence limit, stated plainly:** no HTTP route exposes usage rows, and the CSV (1.7 MB) is too large to pull through the tooling. The deployed artifact identity therefore rests on: Vercel *git* deployment of exactly `db5f969` whose blob (sha256 `8d5b9b289ccbf0e5f9adff3ec82f76dc1b46e42e8ec05dfaa014f2cb74eab030`) has the corrected labels, plus the reader/semantics tests. It was not fetched byte-wise from Vercel.

### 21.4 Player-Scheme content identity (L1)
Production: `content_identity.served_content_id = psc:a7280380b358`, identical across 3 reads; recomputes exactly from the tier ids `A=08123edd58c9 B=5a10eac5bd1d C=39d7b6d7de7d D=37bd7bc3770c` (B/C/D = first 12 hex of the manifest's `served_content_sha256`; A = the version hash). `player_scheme_version` is still `psi:2025:w18:08123edd58c9` (unchanged semantics). A Tier B/C/D change moves the id (test, all three tiers).

### 21.5 Canonical lineage on progression (L2)
Production response embeds `lineage.football_intelligence` = canonical `{version, model_tag, season 2026, through_week 2, generated_at, data_cutoff, week_completion (PARTIAL 1/16), output_classes}`; flat `football_intelligence_version`, `snapshot_through_week`, `ftn_charting_through_week` all equal the embedded values — one lineage answer, no conflict.

### 21.6 FTN progression safety
Production buckets `CHECKDOWN`, `RAW_1` (numeric codes stay `RAW_*`); `numeric_read_semantics_status: UNVERIFIED_SOURCE_CONFLICT`, `output_class: DESCRIPTIVE_ONLY`. Final merged tree search for `FIRST_READ|SECOND_READ|THIRD_*|PRE_SNAP_OR_ZERO` outside test/validator guards: none. Permanent regression tests pass.

### 21.7 AI discovery (R1)
**24 → 36 capabilities (+12, none removed):** `league_orchestrate`, `manager_orchestrate`, `league_roster_health`, `manager_roster_health`, `league_schedule_planning`, `manager_schedule_planning`, `player_scheme_index`, `player_scheme_player`, `player_scheme_matchup`, `player_scheme_team_offense`, `player_scheme_team_defense`, `startsit_evidence_diagnostics`. `/api/trades/competitive` still advertised; **`/api/trades/analyze|discover|negotiate` intentionally not advertised** (no request-body schema; allowlisted with reason).

### 21.8 Surface registry
`docs/intelligence-surface-registry.json` (single registry) validated on final main: 10/10 registry tests (artifacts, readers, builders, docs, tests exist; declared routes exist; reachability agrees with routes; consumers equal the real import graph both directions; library-only surfaces verified route-free; every served data file accounted for). No new unregistered intelligence route appeared through the FI-refresh reconciliation. Static artifacts (Role, Opportunity Propagation, Player-Scheme, weekly models) are byte-unchanged since `1c64ecb`; only code files and FI data changed.

### 21.9 Capture diagnostic against real PostgREST (the principal production-only uncertainty)
* **Query syntax is valid.** Supabase API logs show production issuing (all HTTP 200): a **narrow-column** count query (`select=capture_id,capture_kind,season,week,start_sit_model_version,football_intelligence_version,scoring_fingerprint&limit=5000`) and a **capped detail** query (`select=capture_id,decisions:record->decisions,adjustments:record->adjustments&capture_kind=eq.LIVE_CAPTURED&limit=300`). **No request selects the full `record` column.** Counts correct (7 rows: 2 `LIVE_CAPTURED`, 5 `LIVE_POST_LOCK`; per-position `WR` decisions 2, reversals 0).
* **Defect found and fixed in this deployment task:** the route did not surface the truncation semantics — `record_count` / `per_position_truncated` / `counts_truncated` were computed but dropped by the report builder. Fixed (`db5f969`) with a test; production now reports `record_count: 7`, `per_position_truncated: false`, `counts_truncated: false`.
* Failure mode (query rejection → `summary_available:false`, no fabricated count, recommendations unaffected) remains covered by the stubbed/error-path tests; not exercised in production because the query succeeded.

### 21.10 Artifact parity and the as-of boundary
FI: published artifacts reproduce within tolerance (≤5e-14) — the FI rebuild remains float-noise-level. Static pins valid (12/12 parity tests); Player-Scheme B/C/D builders still write only their own manifest keys.
**As-of invariant (strengthened, not merely relaxed):** *data beyond an artifact's certified substrate window is not an artifact mismatch; a change inside the same window still fails determinism.* Proven, not assumed: (a) Player-Scheme Tier A test asserts its `S=2025, W=18` equals the served manifest's `current_season`/`as_of_week` (`stopifnot`); (b) OPP determinism derives its boundary from the **Role substrate** (`player_game_role` max season/week) and asserts it equals the Role manifest lineage, the OPP manifest lineage and OPP's declared Role dependency `through_week`; (c) a **negative control** proves that removing one in-window event makes the sets differ; (d) events beyond the window are asserted absent from the stored artifact.

### 21.11 Production parity
Pre-merge live reference (`dpl_EEv5…`) vs final (`dpl_7cLp…`), volatile `*_at`/`age_seconds` stripped, two managers in two leagues: **lineup, start_sit, waivers, matchup, matchup_leverage, positional_needs all identical**; lineup totals 113.78 and 130.62 unchanged; shadow `SHADOW_ONLY`, `eligible_to_influence_production=false` — identical even though FI moved `afa8…`→`bfd7…` (production sections do not consume FI). No projection movement occurred between the observations, so no drift needed to be separated out. No fantasy transaction, lineup or trade was submitted.

### 21.12 Duplicate-semantics guards
Lifecycle matrix parity 2/2 (full 6×6 transition matrix identical between Start/Sit FI and Matchup). Team-alias normalizer parity 3/3 (R). Not consolidated.

### 21.13 Test counts (final main `db5f969`)
* TypeScript `npm test`: **2151 tests / 2147 pass / 0 fail / 4 skipped**; `tsc` 0 errors; `eslint` 0 errors.
* Targeted TS: registry 10, discovery coverage 3, artifact parity 12, semantics 14, route lineage 3, lifecycle parity 2, capture integrity 16, start-sit isolation 4, player-scheme isolation 3, injury-opportunity isolation 6, orchestrator isolation 3 — all pass.
* R (0 failures each): Football Intelligence 52 expectations; Start/Sit 136; Player Role 71; Opportunity Propagation 19,396; Player-Scheme 28 successes across 16 blocks.

### 21.14 Remaining limitations
* Usage-label verification is by deployed-commit blob + guarded publish + reader, not a byte fetch from Vercel (no route exposes the rows).
* The PostgREST failure path was not exercised in production (the query succeeded).
* Role, Opportunity Propagation and Player-Scheme still have no scheduled refresh; local R suites depend on cache vintage.
* Carried forward, **not** solved here (Phase 3.5C): common evidence vocabulary and `confidence` ↔ `evidence_class` mapping; `XX`/blank directory identity treatment; source-native categories (`UNDER CENTER`); compound `predictive_status`; scale rules for ratios/shares that may exceed 1; Role/OPP/Player-Scheme refresh cadence; phase-number namespace collision; historical / chart-ready output design. Legacy trade POST advertising and deferred-defect entries 1–2 also remain open.

### 21.15 Final verdict
**A. PHASE 3.5B FULLY PRODUCTION-CERTIFIED.** Corrected usage semantics are live (republished by the guarded refresh); all-tier Player-Scheme content identity is live; canonical lineage is live on the progression route; discovery coverage is live without exposing unsafe routes; the bounded diagnostic works against real PostgREST and now reports truncation explicitly; parity and regression gates pass; production decision math is unchanged; `ri-startsit-2026.1` is frozen and `SHADOW_ONLY`. One documented evidence limit (§21.3) does not leave any known incorrect label in production.
