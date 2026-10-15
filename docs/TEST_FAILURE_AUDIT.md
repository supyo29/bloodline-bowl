# Test-failure audit (PR #45, stacked on PR #44)

Starting point: the PR #44 head `af72022`: **3,811 tests / 82 failures**. Result on the final head: **3,828 tests / 0 failures / 4 skipped**, identical in two consecutive full passes (plus 6 earlier repetitions after the tie-break fix).
"Pre-existing" is not an explanation: every failure below was dated to a first-bad commit by bisect and given a root cause. Per-test rows (error, stack, flags, first-bad commit, status on `main` / `86e8190` / #44) are in `docs/test-audit/FAILURE_LEDGER.json`; raw TAP of every run is in `docs/test-audit/`.

## Original 82 failures
All 82 fail on `main` (966b51e), on `86e8190` and on #44 — none was introduced by Wave 1, W2 or the Yahoo work. 20 of them were green when the test file ran alone (order-dependent); 62 failed alone too.

| Category | # | Families (first-bad commit → why) |
|---|---|---|
| ARCHITECTURE_CHANGED | 25 | **bridge ×23 + draft-sportys-alumni ×1** (`d8fa055`, 2026-09-24): a deliberate production gate rejects an in-season snapshot with no rostered players (found on a real Rogers Park defect); the shared fixture defaulted to empty in-season rosters and rostered ids absent from `players`. **league-manager-routing-live ×1** (`fed80bf`): Sleeper-native URLs intentionally moved to `sleeper_only_urls` (null for Yahoo). |
| STALE_SNAPSHOT_OR_HASH | 23 | **game-distribution ×11, role-calibration ×2** (`b0f89c7` / `9b4c730`, bot "role-calibration: refresh inputs"): the weekly workflow REPLACES the committed role profiles (now target weeks 5–6) while tests hard-coded week 3. **analysis-book ×8, book-ready ×2** (`55b581f` / `1c52f89`, bots refreshing football-intel / intelligence-history): expectations written against one manifest vintage. |
| TEST_BUG | 23 | **scoring-return-invariant ×12, scoring-contract ×5, scoring-contract-adversarial ×2, weekly-hardening ×1** (`650dcb0`, 2026-09-26): the Sleeper projection-feed cache became process-global and tests mocking `fetch` never reset it. **scoring-contract TE ×1** (`abe494f`): fixture id `"TE"` — letters-only Sleeper ids are team-defense ids by contract. **weekly-intelligence-live ×2**: asserted that `illegal_situations` (legality of the CURRENT lineup, a reported fact) was the recommended lineup's legality. |
| ENVIRONMENT_DEPENDENT | 10 | **player-scheme ×9** (red since each was added): read build reports from gitignored `outputs/`. **foundation-live ×1** (`bc86821`): outcome depended on the machine's Yahoo OAuth env. |
| STALE_ASSERTION | 1 | **discovery-route-coverage** (`53c58d3`): three routes classified in `lib/public-api/policy.ts` but missing from the coverage allowlist. |

PRODUCT_BUG among the 82: **none**. (The weekly-intelligence-live case looked like one and was checked against real rosters: both of BijiMac's QBs and DarthMarker's only K are on bye, so no alternative exists and the engine correctly flags it in `bye_problems`.)

## What was changed
**Test-side (all 82):** per-test cache reset; numeric fixture ids; realistic in-season fixtures; allowlist entries with reasons; tests controlling their own Yahoo env and pinning both honest refusals; updated discovery contract plus the Yahoo-side safety property; the live-lineup test now asserts "no bye starter when a non-bye alternative exists".
**Frozen-data strategy:** moving committed data is not asserted against; tests either (a) take the latest week present and INJECT poisoned outcomes so they still have teeth (mutation-verified), (b) read a frozen, hashed, documented vintage fixture (`test/fixtures/role-calibration-vintage-w3`, `capability-vintage-2026w1`; the LIVE registry is overlaid so registry behavior stays exercised), or (c) derive expectations from the live manifests.
**Player-Scheme hermeticization:** the 12 small reports are tracked under `lib/player-scheme-intelligence/certification/` with `SHA256SUMS`, and `test/player-scheme-certification.test.ts` binds each to the committed manifest's `served_content_sha256`. `npm run test:recertify:player-scheme` rebuilds Tiers A–D in R in a scratch copy pinned to the committed vintage (A/C `2025 18`, B `2025 22`) and **reproduced** the committed reports and served data (excluded, documented because time-varying: timestamps, `source_audit.json`, `player_directory.csv`).
**Byte-identity pins (`waiver2-integration`):** re-baselined with a per-file ledger of the reviewed commits that changed each file; `decision-score.ts` (ranking weights) and the frozen Start/Sit model are still byte-identical to the original pins.
**Pre-draft guarantees:** the four live-gated tests now also run hermetically (`test/draft-predraft.test.ts`, snake + auction, fixture-routed Sleeper; teeth verified by injecting a pick).

## Product finding (P3, fixed)
`publication_audit.latest()` / `recent()` sorted on the millisecond `attempted_at` with a stable sort, so two attempts in the same millisecond returned the OLDER row as "latest" (≈1 in 6 loaded runs of `bridge-refresh`). Memory store now tie-breaks on recording order; the Supabase store orders `attempted_at, finished_at (nullslast), id` — no schema change. A sequence column would be the complete fix and is a production migration, deliberately not done. Regression tests in `test/publication-audit-order.test.ts`.

## Live vs hermetic
`npm test` is hermetic or explicitly gated: network tests skip with a stated reason when offline, so an offline run is green by absence. `npm run test:live` is the strict path: it runs every Sleeper-touching test and **fails if any was skipped as offline** — final run **195 / 195 pass, 0 skipped**. Yahoo is never written to.

## Final numbers (head = PR #45 final commit)
- Full suite: **3,828 tests, 3,824 pass, 0 fail, 4 skipped** (two consecutive passes).
- Skips: the four `draft-live` pre-draft tests, `# SKIP draft status is complete` (the real draft is complete); their guarantees run unconditionally in `draft-predraft.test.ts`.
- Audit mutation suite (`scripts/test-audit/mutation-suite.py`): **10 / 10 killed** (A1–A10, including A4 = lag branch removed and A9 = lag condition inverted, A10 = audit tie-break removed).
- Yahoo Market State mutation suite (PR #44, rerun on the combined head): **37 / 37 killed**.
- `tsc --noEmit`: clean. Lint: **0 errors, 41 warnings** (all pre-existing; the two warnings in touched `lib/persistence/memory.ts`, lines unchanged by this PR, exist identically in the unmodified file). `next build`: success.

## Findings
- **P0 / P1:** none.
- **P2:** none new. (Known, not changed here: Sleeper replacement level still uses unrostered rather than certified players — see PR #44.)
- **P3:** publication-audit tie-break (fixed). The weekly refresh workflow replaces the committed role profile files, so offline re-derivation of past forecasts from committed data is no longer possible (they live in the DB ledger); 41 unrelated lint warnings; 4 intentionally live-gated skips.
