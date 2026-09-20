# Intelligence Modernization — Phase 3.5C
## Book-Ready Intelligence Retrofit

Branch `intelligence-modernization-phase3-5c-book-ready-retrofit`. **Not merged, not deployed, not tagged.** Additive and read-only: no model, artifact, scoring, lineup, Start/Sit, waiver, matchup or trade value was changed. Contract version `book-ready-evidence-2026.1`.

## 1. Starting state
Branch cut from `main` after the Phase 3.5B merge. `origin/main` drift checked at every checkpoint (none at Checkpoint E; the FI daily bot commits to `main` and is expected to drift later). Frozen: Phase 1 contracts, Phase 2/3 model logic, `ri-startsit-2026.1` (sha256 `85d2ddd5…b293`, pinned by test), Player-Scheme `player_scheme_version` and `content_identity.served_content_id`.

## 2. Scope and non-goals
Delivered: common EvidenceBlock contract, vocabulary, unit registry, identity classes, temporal identity, immutable history store, per-family converters, unified query layer, `/api/evidence`, registry extension, tests. **Not built:** the Analysis Planner (3.5D), Phase 4, any modeling change, any player-team temporal identity (Phase 7).

## 3. Registry (single, extended)
`docs/intelligence-surface-registry.json` → `intelligence-surface-registry-2026.2`. Every one of the 14 surfaces gains a `book_ready` block (query topics, capability state, history class, comparison populations, refresh policy, phase refs). No second registry. `test/book-ready-registry.test.ts` checks declared topics ↔ implemented `TOPICS` in both directions.

## 4. EvidenceBlock contract (`lib/book-ready/schema.ts`)
One block = one metric for one subject at one temporal identity: value + unit, origin (`source_class` preserved, `analysis_class` normalized), independent axes, freshness, lineage, limitations, optional history / comparison / change / components / relationships / chart hints. `validateEvidenceBlock` enforces the rules (non-available blocks carry no value and a reason; descriptive/shadow never predictive; CONDITIONAL declares its condition; SOURCE_CONFLICT states limitations; comparison populations explicit; transitions carry no numeric delta; significance only if model-supplied).

## 5. Vocabulary and independent axes
Analysis classes: OBSERVED, MODELED, PROJECTED, CONDITIONAL, DESCRIPTIVE, SHADOW, RECONSTRUCTED, UNAVAILABLE, UNSUPPORTED, SOURCE_CONFLICT. Model confidence, sample support, freshness, deployment and predictive class are separate fields. Player-Scheme `evidence_class` maps to sample support, never confidence. Schedule `value_confidence = ROS_CONTEXT_ONLY` is a *context flag, not a grade*: no confidence is asserted and a limitation says so (found and fixed by the decision-fixture tests).

## 6. Units and scale
Explicit registry (`units.ts`); unknown keys throw; nothing inferred from names; nothing clamped. Legitimately >1: QB snap share, inheritance ratios. Legitimately negative: air-yards share. FI percentile orientation is per-metric (VALUE_ORIENTED vs INVERTED_VALUE). FI `modeled` is a deviation from league mean, raw kept as a component. `off_proe` is percentage points. Tested against every served Role/FI value.

## 7. Identity quality
RESOLVED / PARTIAL / PLACEHOLDER (`XX`/blank position, id-only) / UNRESOLVED. Placeholder Player-Scheme rows stay queryable with explicit limitations; nothing is invented.

## 8. Source-native categories
Raw category text preserved (`UNDER CENTER`); normalization only where verified. FTN numeric `RAW_*` read codes are `SOURCE_CONFLICT` with no first/second/third-read mapping.

## 9. Predictive-status normalization
PREDICTIVE → SHADOW_PREDICTIVE unless deployment is PRODUCTION_ACTIVE; NOT_PREDICTIVE → EXCLUDED; compound `off:X|def:Y` takes the conservative side; descriptive never becomes `*_PREDICTIVE`.

## 10. Temporal identity
`as_of`, `through_week`, `point_kind` (POINT_IN_TIME_STATE / CURRENT_UNSNAPSHOTTED / SCENARIO / CURRENT), `as_of_kind` (PUBLISHED_STATE vs CURRENT_SNAPSHOT vs SCENARIO_INPUT), `week_state`, `snapshot_id`. `player_team_temporal_identity` is stamped `NOT_MODELED_UNTIL_INTELLIGENCE_MODERNIZATION_PHASE_7` on every block.

## 11. Refresh cadence decision
FI daily (existing workflow). Role weekly after a complete NFL week (heavy R build; manual runbook; lag surfaced as `freshness.refresh_lag_weeks`, reported in `capabilities.refresh_status`). OPP weekly after Role. Player-Scheme seasonal (content-change snapshots). Staleness is a *freshness fact*, kept separate from availability.

## 12. History classes and store
`data/intelligence-history/` — append-only `manifest.json` + content-addressed gz objects, `verifyHistoryStore` + tamper detection. Policy COMPLETE_WEEK (FI/Role/OPP) or CONTENT_CHANGE (Player-Scheme). Snapshot id `surface@version#content12`. Backfill only from genuinely published git states. Current store: 9 entries (4 FI week-1 COMPLETE revisions, 3 Role, 1 OPP, 1 Scheme), 4.4 MB, verifies clean. Classes: FI = RECONSTRUCTABLE_AS_OF (genuine published states); Role = one preserved week plus per-game native observations; OPP = UNSUPPORTED (conditional scenarios); Player-Scheme = CURRENT_ONLY (cumulative, PRIOR_ONLY through 2025).

## 13. Deltas
Change is computed only against the previous *preserved* state, with the prior snapshot id named; transitions (categorical) carry no numeric delta; no significance unless the model supplies one. Test: with two differing synthetic snapshots each week reads its own content.

## 14. Comparison contract
Comparisons are opt-in and always name an explicit population (`NFL_WR`, `<TEAM>_WR`, `NFL_OFFENSE_TEAMS`, `NFL_DEFENSE_TEAMS`) with n, season, rank/of and percentile with orientation. Percentiles on roster-health are converted to 0–1 only when a population size is supplied; otherwise none is fabricated.

## 15. Decomposition and relationships
Raw values, EWMA horizons, opportunity totals, OPP trace weights and beneficiary/vacated/residual roles exposed as components. Relationship types UPSTREAM_OF, DEPENDS_ON, DESCRIBES, DERIVED_FROM, COMPARABLE_TO, CONDITIONAL_ON. OPP blocks are CONDITIONAL, declare CONDITIONAL_ON + DEPENDS_ON (Role), keep the Phase 2 observed role as a separate OBSERVED component, and never estimate the probability of the condition.

## 16. Availability contract
AVAILABLE, UNAVAILABLE, NOT_APPLICABLE, HISTORY_NOT_SUPPORTED, NOT_YET_REFRESHED, SOURCE_CONFLICT, INSUFFICIENT_SAMPLE, UNSUPPORTED_COMPARISON, EXPECTED_SOURCE_LAG, CURRENT_ONLY — never collapsed. Waivers stay UNAVAILABLE per the readiness contract; trade evaluation is UNSUPPORTED through GET (needs a POST body).

## 17. Retrofit by surface
FI (team metrics, player usage), Role (profile, change), OPP (scenario), Player-Scheme (QB progression / spatial / formation, defense coverage), Start/Sit shadow, Matchup, roster health, schedule planning, waiver and trade foundations. Decision converters run over frozen real production responses (`test/fixtures/book-ready/`, bloodline-bowl/supyo29 week 2) and are verified non-mutating.

## 18. Query layer and route
`lib/book-ready/query.ts`: 15 topics; `getEvidence`, `getCapabilities`; `MAX_BLOCKS = 400`; per-block validation; `performance` (ms, bytes, cost class). `GET /api/evidence?topic=…&params[&history=1][&comparisons=1]` or `?capabilities=1`. History and comparisons are opt-in; ordinary recommendation endpoints are untouched. Discovery lists `book_ready_evidence`. No planner.

## 19. Performance and storage
Local read-only measurement (real artifacts): 0–70 ms per request (first call warms CSV cache), payload 6–150 KB. `fi.team_metric` KC with history+comparisons: 20 blocks, 150 KB, largest case. **Limitation:** lineage is repeated on every block (dominant payload cost); a lineage-dedupe/compact mode is a recommended follow-up. Storage estimate ~12–17 MB per season at current cadence; 4.4 MB now.

## 20. Phase namespaces
INTELLIGENCE_MODERNIZATION_PHASE, TEAM_MANAGEMENT_PHASE, TRADE_ENGINE_PHASE, FOOTBALL_INTELLIGENCE_PHASE, BRIDGE_REALTIME_STATE_STAGE; `formatPhaseRef` prevents "Phase 7" ambiguity.

## 21. Tests
`npm test`: **2197 tests, 2193 pass, 0 fail** (4 pre-existing skips). New: `book-ready-contract`, `-history-store`, `-evidence` (15), `-decision` (5), `-isolation` (4), `-registry` (4). `tsc --noEmit` clean; eslint: 0 errors (3 unused-parameter warnings in new files). R suites unaffected: no R file, model artifact or lib data file changed in this branch (`git diff origin/main...HEAD -- analysis '*.R' lib/**/data` empty).
Two existing text-scan isolation tests (`football-intel-read`, `startsit-capture-integrity`) now skip `lib/book-ready/`, which observes those surfaces read-only; `book-ready-isolation.test.ts` separately enforces that only `app/api/evidence/route.ts` imports it and that it performs no writes/network.

## 22. Live and production validation
- Local read-only validation across QB/RB/WR/TE profiles, FI team (offense and defense), role change, scheme coverage: all `OK`, all blocks valid.
- **Not done: live validation of the deployed `/api/evidence`** — the route is not deployed (merge/deploy forbidden). Production parity: the diff against `origin/main` touches only 5 non-doc/test/store files, all additive (new route, new workflow, registry types, one discovery capability entry, tracing includes); no existing route handler or model file is modified. Fresh pre/post production output hashing should be run after deploy with `scripts/startsit-production-parity.ts` against the 3.5B baseline (six sections, supyo29 + darthmarker, lineup totals 113.78 / 130.62).
- **Not done: `intelligence-snapshot` workflow dispatch** — a workflow must be on `main` before it can be dispatched (GitHub platform rule, same as Phase 10).

## 23. Limitations, follow-ups and verdict
Limitations: Role/OPP/Scheme history is thin (one preserved week / unsupported / current-only) and grows only with the snapshot workflow; FI receiver-side progression is SOURCE_CONFLICT with no topic; Start/Sit captured-record retrieval and lineage-dedupe/compact mode are follow-ups; player-team temporal identity waits for Phase 7; trade evaluation needs a POST-shaped evidence path.

**Verdict: CERTIFIED FOR MERGE REVIEW — code-complete and locally verified; post-deploy live validation, parity hashing and workflow dispatch remain as explicit post-merge gates.** Not merged, deployed or tagged. Phase 3.5D and Phase 4 not started.
