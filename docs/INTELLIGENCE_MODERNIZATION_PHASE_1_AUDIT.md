# Intelligence Modernization — Phase 1 Audit (Checkpoint A)

**Status: AUDIT ONLY. No production code has been changed by this document.**
Branch: `intelligence-modernization-phase1`, based on `main` @ `b56061e` (see Git State below).

This document is the required pre-implementation deliverable before any Phase 1
contract/evaluator/consumer-integration work begins. Every claim below was
verified against the repository as it exists today (2026-09-17), not against
prior session memory or older documentation — several things stated in older
docs have already changed (e.g. `nflreadr` is now `1.5.1`, not `1.5.0`; FI has
already published a `2026:w01` snapshot with a `week_completion` block that
did not exist a few days ago).

---

## 0. Git state at the start of this audit

```
branch:            intelligence-modernization-phase1
based on main @:   b56061eef3c1102d5df72298efb5e5e35aec5ad4
origin/main:       b56061eef3c1102d5df72298efb5e5e35aec5ad4   (no drift after sync)
working tree:      clean
```

**Concurrency finding:** `origin/main` had moved from `f1258a0` (this session's
prior work) to `b56061e` between sessions. Investigated before doing anything
else: `b56061e` is `github-actions[bot]`'s own commit, "football-intel:
refresh 2026 week 1 (COMPLETE, 16/16 games)" — the daily Football Intelligence
refresh workflow deployed in the prior phase running live in production for
the first time and safely republishing (`fi:2026:w01:2d953dc8544b →
ab802a853780`). This is expected, non-conflicting automated work, not a
concurrent human change. Fast-forwarded local `main` to match before branching.

No other branch shows evidence of concurrent modification to the files this
phase will touch (`lib/canonical/`, `lib/weekly/`, `lib/trades/`,
`lib/orchestrator/`, `lib/football-intel/`).

---

## 1. Current architecture map (as implemented, not conceptual)

```
Sleeper / Yahoo (live HTTP)
        |
lib/providers/{sleeper,yahoo}/*  ->  provider.getLeagueState(ctx)
        |
lib/canonical/state.ts :: buildCanonicalLeagueState()
        |   - schema.ts: CanonicalLeagueSnapshot (CANONICAL_SCHEMA_VERSION = 3)
        |   - lineage.ts: SnapshotLineage (content-hashed, deterministic id)
        |   - scoring-fingerprint.ts, league-fingerprints.ts, player-data-version.ts
        |   - players.ts: PlayerCrosswalk (gsis_id > provider id > name+pos+team > name+pos > unresolved)
        |   - freshness.ts: Freshness (usability) vs source_status (reachability)
        |   - persisted via lib/persistence/supabase/*
        v
lib/weekly/context.ts :: buildWeeklyTeamContext()
        |   - pulls scoring_rules/raw_scoring, roster, waiver_state from the canonical snapshot
        |   - getWeeklyProjectionProvider() -> SleeperWeeklyProjectionProvider (lib/weekly/projections/registry.ts)
        |     re-scores Sleeper's raw stat line against the LEAGUE'S OWN scoring rules
        |     (does not trust Sleeper's precomputed pts_*, except K/DEF fallback)
        |   - getScheduleProvider() -> SleeperScheduleProvider (independent of the R engine's
        |     schedules.rds; hits Sleeper's own schedule feed; UNAVAILABLE, not fabricated,
        |     if the week's game count looks incomplete)
        |   - buildRecommendationLineage() -> RecommendationLineage on ctx.lineage
        v
   +---------------------------+---------------------------+
   |                           |                           |
lib/weekly/lineup.ts    lib/weekly/waivers.ts       lib/weekly/matchup.ts
(buildOptimalLineup,     (buildWaiverRecommendations)  (buildMatchup, buildLeverage)
 Hungarian assignment)   replacement.ts (VOR),          Monte Carlo win-prob sim
   |                     decision-score.ts                   |
   |                                                          |
lib/weekly/start-sit.ts                                       |
(compareStartSit)                                              |
   |                                                          |
   +--------------- lib/weekly/intelligence.ts ----------------+
                          |            \
                          |             \
              (SHADOW, additive)    (SHADOW, additive)
                          |             \
          lib/weekly/start-sit-fi/*   lib/weekly/matchup-intelligence/*
          reads lib/football-intel/    reads lib/weekly/data/matchup_*.json
          (R Football Intelligence)    (from analysis/football_intel_matchup/)
                          |             \
                          v              v
                   lib/orchestrator/*  (ADVISORY_ONLY; never executes transactions)
                   gates.ts: shadowGate() hard-fails any candidate whose evidence
                   reduces to start_sit_shadow/matchup_shadow only (SHADOW_ONLY_EVIDENCE)
                          |
                          v
        app/api/{lineup,waivers,matchup,intelligence}/[league]/[manager]/week/[week]/route.ts

lib/trades/*  --- separate top-level consumer of lib/canonical/ (schema, lineage) and of
                  lib/weekly/'s already-materialized VOR/lineup/context outputs, but has
                  ZERO import of lib/football-intel anywhere (verified by grep). Its own
                  UsageProvider/ScheduleProvider seam is wired to NULL_* implementations —
                  explicitly reserved for future role/schedule intelligence, unused today.
                  Already carries RecommendationLineage/SnapshotLineage on its own output.
```

Two more R subsystems exist alongside the main Football Intelligence engine,
each with its own committed served artifact and its own TS reader — see the
table in §2.

---

## 2. Deployment-state matrix

| Layer | Version identifier | Deployment state | Current consumers | Can it affect a served recommendation today? |
|---|---|---|---|---|
| Canonical league snapshot | `SnapshotLineage.league_snapshot_id` (`snap:<slug>:<season>:w<week>:<hash16>`), schema v3 | Production | Every engine below | Yes — it's the substrate everything reads |
| Scoring fingerprint | `scoring:v1:<hash>` (`lib/canonical/scoring-fingerprint.ts`) | Production, authoritative as of Phase 1B.2 | Canonical snapshot, `/api/scoring`, lineage | Yes |
| Legacy scoring hash | `hashScoringSettings` (`lib/analytics/historical-scoring.ts`) | Production, but scoped to season-projection cache keys only, intentionally not migrated | Season projection cache | Only for that cache key, not general lineage |
| Weekly projections (production) | Sleeper RotoWire feed, re-scored | Production | lineup, waivers, matchup, start-sit | Yes — this is the actual production number source |
| NFL schedule (TS layer) | `SleeperScheduleProvider` (independent of R's `schedules.rds`) | Production | bye detection, waivers, trades, schedule-planning | Yes, for byes only; no SOS model exists |
| Injury status | Sleeper's single `injury_status` string | Production | `CanonicalPlayer.injury_status`, trade availability classification, waiver injury-hedge (position-level only) | Yes, but coarse — no practice-report tiering, no per-player beneficiary logic |
| Football Intelligence (R engine) | `fi:<season>:w<week>:<hash12>`, currently `fi:2026:w01:ab802a853780` | **SHADOW_ONLY** everywhere it's imported | `lib/weekly/start-sit-fi/*` (3 files) only | **No** — zero production callers; `applyFiToProductionBatch` exists but is never called; `fiMayInfluenceProduction()` hardcoded to require `PRODUCTION_ACTIVE`, which nothing has reached |
| Start/Sit FI shadow | `START_SIT_FI_CONTRACT_VERSION` | SHADOW_ONLY (deployment.ts lifecycle: SHADOW_ONLY → ... → PRODUCTION_ACTIVE; today at SHADOW_ONLY) | `lib/weekly/intelligence.ts` (advisory field), orchestrator (blocked by `shadowGate`) | No |
| Matchup Intelligence shadow | matchup deployment contract, default SHADOW_ONLY | SHADOW_ONLY | `lib/weekly/intelligence.ts` (advisory field) | No |
| Player × Scheme Intelligence | `player_scheme_manifest.json` | Tiers A–C: SHARED_DESCRIPTIVE (read-only API); Tier D: SHADOW_ONLY, adj≡0 | `app/api/player-scheme/*` (read-only inspection routes) | No numeric influence; descriptive exposure only |
| Rookie role model (R) | draft-capital based | **Production** | `lib/projections/rookie-model.ts`, feeds `lib/projections/model.ts` | **Yes** — this is the one R-derived signal that IS wired into production, via projections, not via Football Intelligence |
| Orchestrator | `OrchestratorDeployment = "ADVISORY_ONLY"` (fixed type, `orchestratorMayExecuteTransactions()` always `false`) | ADVISORY_ONLY | Reads all of the above; never writes | No — read-only view over already-certified specialist output |
| Waiver result lineage | context-level `RecommendationLineage` (via `ctx.lineage`) | Present at context level | Exposed in route's `context_meta`, not on `WaiverResult` itself | N/A (observability gap, not a safety gap — see §4) |

---

## 3. Freshness propagation matrix

| Source | Latest available (verified live, 2026-09-17 04:04 UTC) | Refresh mechanism | Freshness metadata carried | Downstream consumers | Behavior when stale | Behavior when missing |
|---|---|---|---|---|---|---|
| PBP | 2026 season, week 1 (complete) | Daily GH Actions (`fetch_raw.R --refresh`) | `manifest.data_cutoff.pbp`, `week_completion` | FI engine internals | N/A — through_week only ever reflects played games | N/A (backbone source, always present if any season has aired) |
| NGS (passing/rushing/receiving) | week 1 | Same daily refresh | `manifest.data_cutoff.ngs_*` | FI engine internals | Classified `EXPECTED_SOURCE_LAG` vs `BROKEN_OR_MISSING_DATA` in `validate_snapshot.R`, non-blocking if lag, blocking if regression | Same source-lag classification applies to full absence |
| PFR advanced (pass/def) | week 1 | Same daily refresh | `manifest.data_cutoff.pfr_*` | FI engine internals | Same as above | Same as above |
| Snap counts | week 1 | Same daily refresh | `manifest.data_cutoff.snap_counts` | FI engine internals, (not waivers — confirmed no import) | Same as above | Same as above |
| **Participation** | **Absent for 2026 entirely, confirmed live** (404 from nflverse, re-verified this run) | Same daily refresh | Absent key in `data_cutoff` → explicitly classified `EXPECTED_SOURCE_LAG` (fixed in the prior certification round) | FI engine internals (route/personnel/man-zone features) | N/A | Never fabricated; dependent metrics (e.g. `def_blitz_rate`) fall back to prior-only via the week-1-safety fix from the prior phase |
| FTN charting | week 1, DESCRIPTIVE_ONLY | Same daily refresh | `manifest.data_cutoff.ftn_charting`, `output_class: DESCRIPTIVE_ONLY` | Nowhere in production TS (no importer found for `ftn_descriptive.csv` outside FI's own read adapter and its tests) | N/A | Descriptive tables can be empty without failing the build |
| FI manifest version / week_completion | `fi:2026:w01:ab802a853780`, `week_state: COMPLETE`, 16/16 games | Daily workflow; version hash covers all 5 served tables + full `week_completion` (fixed in prior phase) | Full manifest, read via `lib/football-intel/read.ts` | Start/Sit FI shadow only | **No consumer currently checks this against "real-world now" at all** — see Failure Mode 1 below | N/A (manifest always present once first published) |
| Canonical league snapshot | Live, captured per-request (Sleeper fetched fresh unless cached upstream) | Live HTTP on `buildCanonicalLeagueState()` call | `SnapshotLineage` (season/week/generated_at/content_hash) | Every weekly/trade engine | `lib/canonical/freshness.ts` computes a `Freshness.status` with age thresholds per `RefreshMode` | Fails closed per existing canonical contract (not re-audited in depth this pass — pre-existing, certified) |
| Scoring settings | Live, per-league | Live HTTP, no separate cache observed at this layer | `scoring_fingerprint` | Canonical snapshot, waivers/trades via context | A fingerprint mismatch is detectable (`ProjectionLineageEntry.scoring_fingerprint` is documented to "MUST equal the snapshot's") but **nothing currently asserts this comparison** — see Failure Mode 11 below | N/A |
| NFL schedule (TS) | Live, per-request | `SleeperScheduleProvider`, direct HTTP | Reports `UNAVAILABLE` if fewer than `MIN_GAMES_FOR_COMPLETE_WEEK` games in the response | Bye detection, waivers, trades | Explicit `UNAVAILABLE`, byes not fabricated | Same |
| Injury status | Live, per-player, single status string | Sleeper players feed | `Provenance.provider_synced_at` per entity | Trade availability classification, waiver injury-hedge | No staleness threshold specifically for injury data found; relies on overall canonical snapshot freshness | No per-player "as_of" for injury specifically — inherits snapshot-level timestamp only |
| Role/opportunity (player_usage_profile.csv) | week 1 (FI) | FI daily refresh | Same FI manifest metadata | **Nothing in production** — only wired into the Start/Sit FI shadow model config | N/A | N/A |

---

## 4. Identified failure modes (concrete, verified against current code — not hypothetical)

**FM-1 — Provider "current week" vs. FI "through_week" are different concepts and nothing reconciles them.**
Live-verified right now: Sleeper's `/v1/state/nfl` reports `week: 2` (the NFL's own internal week counter, which advances on a fixed schedule cadence, typically Tuesday) while Football Intelligence correctly reports `season: 2026, through_week: 1, week_state: COMPLETE` (Week 2's first game, Thursday Night Football, is scheduled for tonight and has not been played). **This is correct behavior, not staleness** — but there is no code anywhere that would tell a consumer *why* it's correct. A naive freshness check comparing "provider's league week" to "FI's through_week" would wrongly flag this as `STALE`. This is exactly the class of bug Phase 1 exists to prevent, demonstrated with real, current data rather than a hypothetical.

**FM-2 — Stale FI snapshot vs. current league snapshot, or vice versa: no comparison exists.**
Nothing today reads `CanonicalLeagueSnapshot.season/week` and `FootballIntelligenceManifest.season/through_week` together and asserts anything about their relationship. Currently harmless only because FI cannot influence production at all (§2) — but the Start/Sit FI *shadow* path (`lib/weekly/start-sit-fi/shadow.ts`) does combine them for its diff output, with no cross-check.

**FM-3 — Partial current week is not distinguished from stale week in any consumer-facing type.**
FI's own manifest now carries `week_completion` (added in the prior phase), but no TypeScript type or evaluator reads it. `lib/weekly/start-sit-fi/shadow.ts` carries `football_intel_data_cutoff` but not `week_completion`.

**FM-4 — Source lag (participation absent, others present) is tracked inside the R pipeline but not surfaced to any TypeScript consumer at feature-family granularity.**
`manifest.data_cutoff` is the closest thing, and only `lib/football-intel/read.ts` (via `throughWeek(source)`) exposes it — no consumer calls that method today.

**FM-5 — Source regression (a source's cutoff going backward) is validated at FI-build time (`validate_snapshot.R`) but that gate has no analog once the snapshot is committed and being read by TypeScript.** If a future manual/emergency edit to the served CSVs ever bypassed the R pipeline's gates, nothing downstream would notice.

**FM-6 — A recommendation is never required to declare which snapshot/version(s) produced it, in one place, at the result level.** `RecommendationLineage` exists and is populated at the *context* level for weekly/trade engines, but: (a) it is not attached to `WaiverResult` itself (confirmed — context-level only, per the waiver audit); (b) it has no slot for Football Intelligence identity at all (its `projections[]` array models weekly/season projection sources, a different shape, with roles `weekly_absolute | season_ordinal | special_teams | benchmark` — none of which is "football_intelligence"); (c) it has no slot for an overall freshness verdict.

**FM-7 — Scoring-fingerprint mismatch is documented as detectable but nothing detects it.** `ProjectionLineageEntry.scoring_fingerprint` doc comment says a mismatch vs. the snapshot's own fingerprint "is a defect a consumer can detect" — no code currently performs that comparison.

**FM-8 — Mismatched/wrong-league contamination is prevented by construction (per-request scoping, `runInLeagueStateScope`) at the canonical layer, not re-derived here** — this is a pre-existing, certified property (System Trust Audit), not a new gap, but Phase 1's freshness evaluator must not weaken it by, e.g., caching a freshness result keyed only on operation type without the league/snapshot id.

**FM-9 — "Snap share" and "route participation" are different signals and nothing currently prevents conflating them if/when a future consumer reaches for player-usage data.** `player_usage_profile.csv` has both; only the Start/Sit FI shadow model reads it today, correctly scoped, but there is no typed guard preventing a future direct read from substituting one for the other.

**FM-10 — Injury freshness has no explicit `as_of`/source distinct from the general canonical snapshot timestamp**, and there is no injury→opportunity propagation anywhere (confirmed absent in the waiver audit) — this is Phase 3's problem to solve, but Phase 1's contract should have a typed place to eventually carry "injuries: { as_of, source }" even while leaving it `null`/`UNKNOWN` today.

None of FM-1 through FM-10 currently produce an incorrect *numeric* production recommendation, because Football Intelligence cannot reach production output today (§2). The risk is entirely in (a) the Start/Sit FI *shadow* diagnostics potentially mispresenting staleness as currency or vice versa, (b) the total absence of any lineage/freshness statement on waiver results, and (c) the fact that the one "sanctioned" FI-to-production integration point (`applyFiToProductionBatch`) has no freshness gate in front of it at all today — so the moment someone flips its deployment-state config to `PRODUCTION_ACTIVE` for any position, there is currently *nothing* that would also check whether the FI snapshot behind that flip is fresh enough to trust. That is the most concrete, forward-looking risk this phase must close.

---

## 5. Recommended ownership boundary

**Decision: extend the existing `lib/canonical/lineage.ts` contract; do not build a parallel lineage system.**

Rationale: `RecommendationLineage`'s own module doc already states its goal
covers "every current and future management engine output (weekly, trade,
waivers, lineup, start/sit, matchup, ROS, **Football Intelligence**,
orchestrator)" — Football Intelligence was already an intended consumer of
this contract, it just isn't populated yet. Building a second, parallel
"IntelligenceContext" type next to it would immediately create the exact
"mixture of versions, unclear ownership" failure mode this phase is meant to
eliminate.

**Concrete boundary:**
- `lib/canonical/lineage.ts` (or a sibling module in the same directory, e.g.
  `lib/canonical/intelligence-lineage.ts`) **owns identity**: it gains a new,
  additive, optional field on `RecommendationLineage` —
  `football_intelligence: FootballIntelligenceLineage | null` — carrying FI's
  own version/season/through_week/week_completion/data_cutoff, populated from
  `lib/football-intel/read.ts`'s manifest when an engine actually consults FI,
  and explicitly `null` (never fabricated) when it doesn't.
- A **new** module, plausibly `lib/canonical/intelligence-freshness.ts` (naming
  to be finalized in Checkpoint B against however the repo's existing
  `lib/canonical/freshness.ts` is styled — that file already owns "is the
  canonical snapshot fresh," so extending its neighborhood rather than
  inventing a new top-level directory keeps ownership legible), **owns
  freshness policy**: the single `assessIntelligenceFreshness(context,
  operation)` evaluator. It is the *only* place that ever compares a
  provider's week counter, FI's through_week/week_completion, and
  feature-family data_cutoff against each other. No recommendation engine
  (waivers, start-sit, matchup, trades) re-implements this comparison itself.
- **Consumers** (waivers, start-sit, matchup, trades) own nothing about
  freshness policy — they call the evaluator, attach its typed result to
  their existing `RecommendationLineage`-carrying output, and act on
  `usable`/`confidence_cap`/`prohibited_features` exactly as the evaluator
  says. This mirrors the existing pattern where `lib/weekly/context.ts`
  already centralizes lineage-building once and every engine just consumes
  `ctx.lineage` — the freshness evaluator slots into the same seam.

---

## 6. Proposed types/interfaces (design sketch — not implemented in Checkpoint A)

```ts
// lib/canonical/lineage.ts (additive)
export interface FootballIntelligenceLineage {
  version: string;              // fi:2026:w01:ab802a853780
  model_tag: string;
  season: number;
  through_week: number;
  week_state: "PARTIAL" | "COMPLETE";
  games_completed_in_latest_week: number;
  games_scheduled_in_latest_week: number;
  data_cutoff: Record<string, number>;   // per-source, as published
  generated_at: string;
}

export interface RecommendationLineage {
  snapshot: SnapshotLineage;
  projections: ProjectionLineageEntry[];
  football_intelligence: FootballIntelligenceLineage | null;   // NEW, additive
  engine_versions: Record<string, string>;
}
```

```ts
// lib/canonical/intelligence-freshness.ts (new)
export type IntelligenceOperation =
  | "START_SIT" | "WAIVER" | "TRADE" | "MATCHUP"
  | "ROSTER_PLANNING" | "ANALYSIS_ONLY";

export type OverallFreshnessStatus =
  | "CURRENT" | "PARTIAL_CURRENT" | "DEGRADED" | "STALE" | "INCOMPATIBLE";

export interface FreshnessReason {
  code: string;              // e.g. "PARTICIPATION_SOURCE_LAG", "FI_SEASON_BEHIND_LEAGUE"
  severity: "INFO" | "WARN" | "BLOCK";
  affects: string[];         // feature-family identifiers
}

export interface IntelligenceFreshnessAssessment {
  overall_status: OverallFreshnessStatus;
  usable: boolean;
  confidence_cap: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_SAMPLE" | null;
  reasons: FreshnessReason[];
  prohibited_features: string[];
  lineage: RecommendationLineage;
  freshness_policy_version: string;   // e.g. "freshness-policy:2026.1" — versioned separately from FI's own version
}

export function assessIntelligenceFreshness(
  lineage: RecommendationLineage,
  operation: IntelligenceOperation,
): IntelligenceFreshnessAssessment;

export function summarizeLineageForHumans(
  assessment: IntelligenceFreshnessAssessment,
): string;
```

Feature-family identifiers (initial, extensible enum/string union, NOT
free-text): `PBP_TEAM_EFFICIENCY`, `PASS_RUSH_PFR`, `NGS`, `SNAP_COUNTS`,
`ROUTE_PARTICIPATION`, `FTN_DESCRIPTIVE`, `PLAYER_USAGE`, `SCHEDULE`,
`INJURY`, `SCORING`. This directly encodes the required principle "a lagging
route-participation source must not invalidate current PBP."

`freshness_policy_version` is deliberately a separate string from
`football_intelligence_version` — the versioning-boundary requirement from
the task: FI's version means "what data produced this snapshot," the policy
version means "which rules were applied to judge freshness," and they must
never be conflated.

---

## 7. Proposed files to modify/create (Checkpoint B, not this checkpoint)

**New:**
- `lib/canonical/intelligence-freshness.ts` — the evaluator, types, human-readable summarizer
- `test/intelligence-freshness.test.ts` — unit + adversarial tests (18 scenarios per the task's list)

**Modified, additive only:**
- `lib/canonical/lineage.ts` — add `FootballIntelligenceLineage`, extend `RecommendationLineage` with the new optional field, extend `buildRecommendationLineage()`'s signature additively (default `null`)
- `lib/weekly/waivers.ts` — attach a `WaiverResult.intelligence_assessment` (or fold into an existing lineage field) — no ranking-logic change
- `lib/weekly/start-sit-fi/shadow.ts` — call the evaluator instead of (or alongside) its own ad hoc freshness fields; no production-lineup change
- `lib/weekly/matchup-intelligence/*` — same pattern for matchup shadow output
- `lib/football-intel/read.ts` — possibly add a small typed accessor for the full manifest (not just `throughWeek()`) so the evaluator doesn't need to know CSV/JSON parsing details — TBD in Checkpoint B, may be unnecessary if `loadFootballIntelligence().manifest` already suffices (it does — `manifest` is already a public field).

**Not touched:** `analysis/football_intel/*` (R engine internals), `lib/orchestrator/gates.ts`'s `shadowGate` (already correctly restrictive — Phase 1 should not weaken it), any certified Phase 1–8 Team Management contract, `lib/trades/*` core valuation logic.

---

## 8. Risks

1. **Scope creep into Phases 2–9.** The freshness evaluator will be tempted to "just also" model role/opportunity or injury propagation. Explicitly out of scope — those phases get typed `null`/`UNKNOWN` placeholders only.
2. **Breaking the existing `shadowGate` invariant.** Any change near `lib/orchestrator/` must not make it easier for shadow-only evidence to reach an ACTION. Checkpoint C must add tests proving this invariant is unchanged.
3. **Additive-but-not-really.** Adding a required (non-optional) field to `RecommendationLineage` would break every existing call site listed in the trade-engine audit (`lib/trades/context.ts`, `competitive/api.ts`, etc.) and in weekly. The new field must be optional/nullable and every existing construction site left otherwise untouched.
4. **False precision in the evaluator itself.** The evaluator must not synthesize a `generated_at` or a `data_cutoff` value it doesn't have — every "unavailable" branch must produce a typed `UNAVAILABLE`/`null`, never a fabricated default (the task's explicit "no false precision" list, several of which map directly to existing repo idioms already respected elsewhere, e.g. `PlayerCrosswalk`'s `unresolved` state, `Freshness` vs `source_status` split, `ProjectionLineageEntry.status`).
5. **R/TS boundary correctness.** The evaluator must read the manifest exactly as `lib/football-intel/read.ts` already parses it — re-deriving cutoff/completion logic independently in TS would create a second source of truth for the same facts (violates §5's ownership-boundary decision).
6. **Performance.** `buildWeeklyTeamContext` already loads FI lazily only where needed (start-sit-fi); the freshness evaluator must not force-load the FI manifest on every waiver/start-sit call if FI isn't otherwise being consulted for that operation. `loadFootballIntelligence()` is memoized (module-level cache in `read.ts`) so repeated calls are cheap once warm, but the FIRST call still does file I/O — the evaluator should only call it when `operation` requires FI-derived feature families at all (e.g. `TRADE`/`ANALYSIS_ONLY` for a plain ROS query may not need it).

---

## 9. Test plan (Checkpoint B/C)

Directly the 18 freshness-evaluator scenarios and 3 consumer-test groups
specified in the task instructions, plus:
- Determinism: identical `RecommendationLineage` input → byte-identical
  `IntelligenceFreshnessAssessment` (mirrors the existing `compute_version`
  determinism test pattern from the daily-refresh work).
- A dedicated regression test asserting `shadowGate`'s behavior is
  bit-for-bit unchanged before/after Checkpoint C (run `test/orchestrator.test.ts`
  and `test/system-trust-audit.test.ts` before touching anything, diff their
  pass/fail output after).
- Full existing suite (`npm test`, `npm run typecheck`, `npm run lint`),
  `Rscript analysis/football_intel/tests/run.R`,
  `Rscript analysis/football_intel/adversarial_audit.R`, and any
  canonical/live certification harness that exists and is safe to run
  read-only (to be identified precisely in Checkpoint B/D — `scripts/system-trust-audit.ts`
  was referenced by the start-sit/matchup audit agent and is a candidate).

---

## 10. Roadmap — Phases 2–9 (documented only, NOT implemented in Phase 1)

**Phase 2 — Player Role & Opportunity Intelligence.** A dedicated engine
distinguishing OBSERVED vs. PROJECTED role change, injury-contingent role,
stable/declining role, built from snaps/routes/targets/target-share/air-yards/
carries/red-zone/goal-line/two-minute/third-down/alignment/return-role
signals — several of which (snap share, target share via `player_usage_profile.csv`)
already exist in Football Intelligence today but are wired only into the
Start/Sit FI shadow, confirmed unused elsewhere.

**Phase 3 — Injury → Opportunity Propagation.** Model which teammates
actually inherit vacated work, with redistribution uncertainty — confirmed
in this audit that ZERO beneficiary/handcuff/"next man up" logic exists
anywhere in the repo today (waiver audit, item 7).

**Phase 4 — Waiver Intelligence 2.0.** Combine observed role, expected role
growth, injury-created opportunity, talent/efficiency, ROS value, matchup,
schedule, roster need, replacement value, drop cost, FAAB market, manager
competition, uncertainty. This audit found today's waiver engine already has
solid replacement-level/VOR/drop-candidate/bye-detection machinery but zero
matchup adjustment, zero FAAB bid sizing (explicit placeholder string), zero
manager-competition modeling, and zero role/opportunity signal reaching it.

**Phase 5 — Matchup Intelligence 2.0.** Move from team-level "good/bad
defense" to player-specific interaction features (pressure by edge/interior,
blitz vs. four-man, slot vs. boundary coverage, etc.) — the existing
`analysis/football_intel_matchup/` shadow engine and `contextual_matchup_feature.csv`
are early building blocks, already correctly kept SHADOW_ONLY / DESCRIPTIVE_ONLY
where evidence hasn't earned predictive use.

**Phase 6 — Fantasy Scoring Contract Completeness.** This audit found the
scoring catalog (`lib/scoring/catalog.ts`) is comprehensive (including return
yardage, IDP, defensive tiers), and return yardage is confirmed fully wired
end-to-end, but several categories (IDP, defensive point/yard tiers) were
only survey-level verified as reaching projections/historical scoring —
individually proving each category reaches waiver/trade valuation (vs. only
the shared projected-points total) is Phase 6's job, not Phase 1's.

**Phase 7 — Temporal Identity / Team Membership.** Player identity plus
effective-time team/depth-chart membership, to prevent stale team
assignments from producing wrong opponent/matchup joins. `PlayerCrosswalk`
and `player_data_version` today are point-in-time, not interval-aware.

**Phase 8 — FI Live Re-certification and Selective Activation.** Feature-family-by-feature-family
promotion from SHADOW_ONLY toward PRODUCTION_ACTIVE, with baseline
comparison/calibration and explicit reversibility. This audit's Phase 1
freshness contract is the prerequisite gate this phase will sit behind: no
feature family should ever be promotable to PRODUCTION_ACTIVE without the
freshness evaluator being consulted first.

**Phase 9 — Weekly Model Audit & Calibration.** Automated post-week
generation of role changes, prior/current disagreements, defense-profile
shifts, injury-opportunity shifts, matchup misses, waiver outcomes, stale/missing
sources, calibration results — a natural consumer of this phase's
`IntelligenceFreshnessAssessment` history once it exists.

---

## 11. Summary — Phase 1 audit conclusions

- The core Football Intelligence philosophy (opponent-adjusted, prior-informed,
  recency-weighted, uncertainty-aware, source-aware, versioned,
  descriptive/model-output separated, safe against tiny samples) is intact and,
  per this session's own prior certification, functioning correctly in
  production — including a live, already-running daily refresh.
- **No production recommendation is currently influenced by Football
  Intelligence at all** — the risk is not "stale FI is silently changing
  numbers today," it's "there is no infrastructure to prevent that outcome
  the moment any shadow layer is promoted, and there is no lineage exposed
  on waiver results despite waivers being explicitly flagged as the
  highest-value decision to protect."
- A real, live example of the exact ambiguity this phase must resolve was
  captured during this audit (FM-1: provider week 2 vs. FI through_week 1,
  correctly current, with nothing in the codebase that could explain why).
- The right architectural home for the new contract already exists in
  embryonic form (`lib/canonical/lineage.ts`'s `RecommendationLineage`,
  which explicitly names Football Intelligence as an intended future
  consumer) — Phase 1 should extend it, not replace or duplicate it.
- No architectural conflict was found that would block proceeding to
  Checkpoint B. Recommend continuing.
