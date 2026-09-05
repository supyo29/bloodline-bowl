# Bloodline Bowl Trade Engine — Phase 5 Negotiation Intelligence and Offer Strategy Audit

Frozen after this audit: **`ri-trade-negotiation-2026.2`** (was `ri-trade-negotiation-2026.1`)

Every earlier frozen layer is unchanged: Phase 1 `ri-trade-foundation-2026.2`, Phase 2
`ri-trade-contextual-2026.2`, Phase 3 `ri-trade-calibrated-2026.2`, Phase 3.5
`ri-trade-data-2026.2`, Phase 4 `ri-trade-discovery-2026.2`.

## A. Freeze verification

No file under `lib/trades/{schema,config,evaluate,validate,reconstruct,ros,depth,context,
phase3,intelligence,confidence,calibration,historical,providers,r-data-providers,
historical-loader,data-readiness}.ts` or `lib/trades/discovery/*.ts` was modified in this
audit. Every fix lives under `lib/trades/negotiation/*.ts`, `app/api/trades/negotiate/route.ts`
(unchanged), and `test/trade-engine-phase5.test.ts`. `git diff --stat` against the pre-audit
tree touches exactly: `pareto.ts`, `dependency.ts`, `concessions.ts`, `negotiate.ts`,
`config.ts` (version bump only), `test/trade-engine-phase5.test.ts`, this doc, and the
superseded-by-audit note in `docs/TRADE_ENGINE_PHASE5.md`.

## B. Canonical evaluation verification

Confirmed by direct read of every negotiation module: `computePlayerDependency` calls
`buildOptimalLineup`/`computePositionalNeeds` (Phase 1's own primitives) with no separate
value model; `pareto.ts`/`offer-ladder.ts`/`concessions.ts`/`counter-strategy.ts` all read
`my_gain`/`utility_delta`/`phase2.contextual_utility_delta` off `TradeDiscoveryResult` objects
produced by `evaluateCandidate` (Phase 4's, itself calling Phase 1/2's `evaluateTrade`) — never
compute or store an independent numeric trade value. `behavior.ts` has no code path that can
emit a personality string (verified, Section K below). Phase 3 isolation confirmed by the
existing (still-passing) Phase 5J test and re-confirmed structurally: negotiation reads
`phase2.contextual_utility_delta` exclusively, never `phase3_shadow`'s fields, for any numeric
decision.

## C. Defect table

| # | Severity | File | Defect |
|---|----------|------|--------|
| D1 | P1 | `pareto.ts` | `selectOfferTiers()` had `OPENING` and `MAXIMUM_RATIONAL` computed exactly backwards — lowest `my_gain` labeled OPENING, highest labeled MAXIMUM_RATIONAL, the reverse of both terms' meaning. |
| D2 | P1 | `dependency.ts` | `classify()` returned `SURPLUS` for any non-starter *before* ever checking `severityAfter`, so a bench player who is the roster's only viable backup at a fragile position was always misclassified `SURPLUS` regardless of positional-severity evidence. |
| D3 | P2 | `concessions.ts` | `requester_utility_cost` was clamped to `Math.max(0, ...)`, silently destroying negative-cost (win-win) information. |
| D4 | P2 (freeze-critical) | `concessions.ts` | `concession_efficiency = gain / cost` had no minimum-denominator guard; a cost of 0.001 could produce an "exploded" (large but finite) ratio rather than a stable, meaningful number. |
| D5 | P2 | `concessions.ts` | Final sweetener ranking sorted purely by `concession_efficiency ?? -Infinity`, sending every `null`-efficiency candidate (which includes the *best* case — free or win-win) to the bottom of the list. |
| D6 | P2 | `negotiate.ts` | `IMPROVE_OFFER`/`REDUCE_OVERPAY`/`COUNTER_PROPOSAL` did not reject a proposal with more than 2 participants — `.find()` silently picked the first non-requester participant as "the partner," discarding the rest of a three-team proposal's structure without any diagnostic. |
| D7 | P3 (documented, not a defect) | `pareto.ts` | `MAXIMUM_RATIONAL` as a *distinctly labeled* tier is structurally unreachable whenever every frontier candidate has `my_gain > 0` (the enforced production case) — it always collapses into `STRONG_ACCEPT`'s object via the dedup logic. See Section G. |
| D8 | P3 (documented, not a defect) | `walk-away.ts` / `negotiate.ts` | `BETTER_ALTERNATIVE_EXISTS` is declared in the `WalkAwayReason` union but never emitted; `alternative_targets` is hardcoded `[]` in `negotiate.ts`. Confirmed this was an explicit, already-documented deferral from the Phase 5 build, not a regression. |

Zero P0 defects. D1 and D2 are the headline findings — both change observable negotiation
output.

## D. Corrections made

**D1 — `pareto.ts`.** Swapped the two sort directions in `selectOfferTiers()`:

```ts
const opening = [...withPartner].sort((a, b) => b.r.my_gain - a.r.my_gain || a.r.transfers.length - b.r.transfers.length)[0]!.r;
...
const maximum_rational = [...withPartner].sort((a, b) => a.r.my_gain - b.r.my_gain)[0]!.r;
```

`OPENING` is now the highest `my_gain` on the frontier (least generous / cheapest for the
requester — the correct thing to offer first). `MAXIMUM_RATIONAL` is now the lowest `my_gain`
on the frontier (the most the requester should rationally extend while their own utility stays
positive). Verified directly against the audit spec's own worked example (§19): offers at
`my_gain = 5, 2, 0.1, -0.1` (the `-0.1` offer never reaches the frontier — it fails the
requester's positive-utility floor upstream) — the requester should open with the `+5` package
and treat `+0.1` as the maximum rational extension. New direct unit test:
`test/trade-engine-phase5.test.ts` — "selectOfferTiers: OPENING is the highest my_gain,
MAXIMUM_RATIONAL the lowest, on the audit's own worked example."

**D2 — `dependency.ts`.** Reordered `classify()` so the severity-driven CORE/IMPORTANT checks
(`severityAfter === "critical"` / `"weak"`) apply *before* the starter-status shortcut to
SURPLUS:

```ts
if (abs >= DEPENDENCY_THRESHOLDS.core_min_impact || severityAfter === "critical") return { dependency: "CORE", ... };
if (abs >= DEPENDENCY_THRESHOLDS.important_min_impact || severityAfter === "weak") return { dependency: "IMPORTANT", ... };
if (!wasStarter && abs < DEPENDENCY_THRESHOLDS.replaceable_min_impact) return { dependency: "SURPLUS", ... };
```

New regression test constructs exactly the audit's §9 scenario: both locked RB starters sit at
the replacement line (gap < 2), and a non-starter bench RB (marginal impact 0) is the roster's
only depth there. Result: `severity_after_removal: "weak"`, `is_current_starter: false`,
`dependency: "IMPORTANT"` — not `SURPLUS`.

**D3/D4/D5 — `concessions.ts`.** `requester_utility_cost` is now signed and unclamped. A new
exported `computeSweetenerEfficiency(cost, gain)` nulls the ratio whenever
`cost <= MIN_MEANINGFUL_COST (0.05)` — covering the audit's exact `cost = 0.001, gain = 1.0`
worked example (§24) and any negative (win-win) cost (§25) — instead of computing an unstable
or divide-by-zero ratio. `classifySweetener` is exported (previously private) so both are
directly unit-testable without depending on a full canonical-evaluation fixture landing on a
razor-thin cost value by chance. The final ranking now sorts by an explicit class rank
(`CHEAP < EFFICIENT < MEANINGFUL < EXPENSIVE < DO_NOT_ADD`) and only breaks ties within a class
by efficiency, so a `null`-efficiency CHEAP candidate can never be ranked behind a real-ratio
EXPENSIVE one.

**D6 — `negotiate.ts`.** Added an explicit participant-count guard before resolving a partner
from a supplied proposal:

```ts
if (proposal.participants.length !== 2) {
  return base(req, { status: "VALIDATION_FAILED", mode, diagnostics: [{ code: "UNSUPPORTED_PARTICIPANT_COUNT", ... }] });
}
```

A three-team proposal submitted to `IMPROVE_OFFER`/`REDUCE_OVERPAY`/`COUNTER_PROPOSAL` is now
explicitly rejected with a named diagnostic code, never silently narrowed to a bilateral
reading. (Full end-to-end testing of this path requires a resolved league state, the same
limitation the Phase 4 test suite already documents for `discoverTrades`; the fix was verified
by direct code inspection and `tsc`/lint, consistent with that established convention.)

## E. Dependency finding

Section D2 above is the dependency-classification finding. No other defect found in
`dependency.ts`: the leave-one-out mechanics (`buildOptimalLineup` on full vs. stripped roster)
are identical to Phase 1's own approach, `severityAfter` degrades to `null` (never a fabricated
value) if `computePositionalNeeds` throws, and thresholds (`core_min_impact: 6`,
`important_min_impact: 2`, `replaceable_min_impact: 0.5`) are unchanged from the Phase 5 build
and remain purely documented constants, not learned.

## F. Pareto finding

Section D1 above is the headline Pareto finding. Additional checks:

- **Floating-point noise (§13):** `dominates()` uses plain `>=`/`>` comparisons on already
  `Math.round(...,2)`-rounded canonical values (rounded upstream in `evaluateCandidate`), so a
  `5.0000001` vs. `5.0` split cannot occur in production data; no defect found.
- **Thin-frontier tier fabrication (§14):** `selectOfferTiers` only assigns a tier key when the
  candidate object differs by reference from every already-assigned tier — confirmed by the
  existing "never fabricates a tier when the frontier is empty" test and the live smoke test
  (Section M), where the real 2-candidate frontier populated only `OPENING`/`BALANCED`, leaving
  `STRONG_ACCEPT`/`MAXIMUM_RATIONAL` correctly absent rather than duplicated.

## G. Offer ladder finding

The integration test in `test/trade-engine-phase5.test.ts` ("multiple valid offers: OPENING has
the highest my_gain...") was found to be a **vacuous pass** before this audit — its
`if (ladder.OPENING && ladder.MAXIMUM_RATIONAL)` guard never actually executed against the
`bilateralLeague()` fixture, which only ever produces a 2-candidate frontier
(`OPENING`/`BALANCED`, no distinct `MAXIMUM_RATIONAL`). The assertion had been passing for the
wrong reason — it was never running. This is now documented in the test's own comment, and the
real ordering proof lives in the new direct `selectOfferTiers` unit test (Section D1), which is
not subject to a particular fixture's frontier shape.

Separately, tracing D1's fix through to its logical conclusion surfaced **D7**: on a genuine
2-metric Pareto frontier, a candidate with the lowest `my_gain` must — to survive
non-domination — have a partner-utility value at least as high as every other frontier
candidate (otherwise the candidate with equal-or-higher `my_gain` and equal-or-higher partner
value would dominate it). This means whenever every frontier candidate has `my_gain > 0` (the
production-enforced case, since a `my_gain <= 0` candidate is filtered upstream), the
minimum-`my_gain` candidate and the maximum-partner candidate are the *same object* —
`MAXIMUM_RATIONAL` and `STRONG_ACCEPT` necessarily coincide, and the existing dedup logic
correctly surfaces it once, under `STRONG_ACCEPT` (computed first). This is **not a defect** —
fabricating a duplicate `MAXIMUM_RATIONAL` entry would violate the "never fabricate a tier"
invariant — but it does mean `MAXIMUM_RATIONAL` as a *distinctly named* API field will rarely
appear in practice with today's all-positive-`my_gain` frontier. Documented as a known,
non-blocking characteristic of the 4-tier model (Section O).

## H. Offer ladder — worked-example proof (§16–§19)

Direct `selectOfferTiers` unit test reproduces the audit's own numbers: offers at
`my_gain = 5, 2, 0.1`. Result: `OPENING.my_gain === 5`, and `0.1` is reachable through some
populated tier (here, `STRONG_ACCEPT`, per Section G) — and is never labeled `OPENING`, which
was the exact D1 bug. `OPENING.my_gain >= t.my_gain` holds for every populated tier.

## I. Sweetener finding

Sections D3–D5 above. Live proof (Section M) shows a real `CHEAP` sweetener
(`cost=0.43, gain=0.43, efficiency=1`) ranked ahead of a real `MEANINGFUL` one
(`cost=0.58, gain=0.58, efficiency=1`) ahead of a real `EXPENSIVE` one
(`cost=3.33, gain=2.89, efficiency=0.87`) — correct class-then-efficiency ordering in
production output, not just in synthetic fixtures.

## J. Walk-away finding

`analyzeWalkAway`'s core reasons (`NEGATIVE_REQUESTER_UTILITY`, `CORE_ASSET_REQUIRED`) are
reachable and tested (Phase 5F, unchanged, still passing). `BETTER_ALTERNATIVE_EXISTS` is
confirmed **unreachable** (D8): declared in `WalkAwayReason` but never emitted, because
`alternative_targets` is hardcoded `[]` in `negotiate.ts`. Grepped the Phase 5 build doc and
confirmed this was an explicit, already-known deferral (`max_alternative_targets` is configured
but the population logic was never built) — not a new regression introduced by this audit's
fixes. Documented as a P3 remaining limitation (Section O), not fixed here since populating it
requires new search logic outside this audit's fix-scope for confirmed defects.

## K. Counteroffer finding

`buildCounterStrategy`'s `distance()` function and its ranking (`sort by distance asc, then
my_gain desc`) are unchanged this audit and re-verified by direct read — ranking is monotonic
and tested (Phase 5E, still passing: "builds a ranked, distance-scored counter ladder").
`classifyProblem` correctly separates `NO_CONCESSION_NEEDED` / `REQUESTER_OVERPAY` cases
(Phase 5E, unchanged). No defect found in `counter-strategy.ts` beyond what D6 fixes at the
orchestrator layer above it (three-team rejection).

## L. Behavioral evidence finding

`behavior.ts` was re-read in full: every code path that could construct output text builds it
from numeric thresholds only (`behavioralConfidence()`'s trade-count boundaries: `<=2`
INSUFFICIENT, `<=5` LOW, `<=10` MEDIUM, `>10` HIGH) and a fixed set of structural note strings —
grepped for personality/preference language (`aggressive`, `stingy`, `generous` [as a claim, not
a cost-comparison adjective], `likes`, `prefers`, `personality`, `loyal`, `greedy`, `savvy`) and
found zero violations in source. The only "generous" occurrence is in `pareto.ts`'s doc comment,
used purely as a cost-comparison adjective ("least generous, cheapest for them"), not a
personality claim about a manager. `status` can only ever be `INSUFFICIENT_DATA` in this
repository's real data state (0 real per-manager trade histories), confirmed by the still-passing
Phase 5G test and the live smoke test (Section M).

## M. Live league finding

Re-ran `scripts/phase5-real-league-smoke-test.ts` against both real leagues post-fix:

- **Mike Washington** (Devoted to the Game / darthmarker, ACQUIRE): still `SURPLUS` dependency,
  `HIGH` leverage (score=8), `NO_VIABLE_PACKAGE_FOUND` (0 candidates cleared even the RELUCTANT
  floor), `NEGATIVE_REQUESTER_UTILITY` walk-away, `INSUFFICIENT_DATA` behavioral intelligence —
  identical finding to the pre-audit build, confirming the fixes did not alter this correct
  result.
- **A real RB target** (Devoted to the Game): 24 candidates considered, 24 on the frontier.
  `OPENING: my_gain=0.86` (LOW viability), `BALANCED: my_gain=0.28` (LOW viability) —
  **correctly ordered post-fix**: OPENING now has the higher `my_gain`, the reverse of the
  pre-fix build doc's `OPENING: my_gain=0.28` / `MAXIMUM_RATIONAL: my_gain=0.86`. Real
  sweeteners returned in correct class order (Section I).
- **A real WR target** (Bloodline Bowl / supyo29, ACQUIRE): target dependency now reports
  `IMPORTANT` ("removing this player costs 2.9 projected points this week even though they are
  not a current starter — no other viable backup exists") — a live, real-data confirmation of
  the D2 dependency fix actually changing a real classification from what would have been an
  automatic `SURPLUS` pre-fix.

No mutation, no write to Sleeper, read-only throughout — confirmed by the script's own design
(GET-only league-state reads) and by the API route's documented contract (Section N).

## N. API contract audit

`POST /api/trades/negotiate` (`app/api/trades/negotiate/route.ts`, unchanged this audit):
15-request modes validated against `VALID_MODES`, 16KB body cap enforced both via
`Content-Length` and actual byte length, `sanitizeProposal` rejects any malformed shape before
it reaches negotiation logic, `dynamic = "force-dynamic"` (no caching of a per-manager
computation), read-only and stateless per its own doc comment — "Nothing is persisted or sent
to any manager — this endpoint has no write path to Sleeper or anywhere else." D6's new
`UNSUPPORTED_PARTICIPANT_COUNT` diagnostic slots into the existing `VALIDATION_FAILED` status
shape without any contract change.

## O. Phase 3 isolation

Re-verified post-fix: negotiation modules import only `phase2.contextual_utility_delta` (never
`phase3_shadow`) for any numeric decision. The existing Phase 5J test ("extreme (synthetic)
target volatility does not change the offer ladder's canonical utility") still passes unchanged
after all fixes — none of D1–D6 touch how Phase 3 signals are read or ignored.

## P. Remaining limitations (non-blocking)

1. **D7** — `MAXIMUM_RATIONAL` rarely appears as a distinctly-labeled tier in practice (it
   structurally collapses into `STRONG_ACCEPT` whenever every frontier candidate has
   `my_gain > 0`, the enforced case). The underlying value is always computed correctly and
   never fabricated as a duplicate; this is a labeling/API-surface characteristic to be aware
   of, not a defect.
2. **D8** — `BETTER_ALTERNATIVE_EXISTS` is unreachable; `alternative_targets` is not populated.
   Pre-existing, explicitly deferred in the Phase 5 build, unchanged by this audit.
3. Trade-level calibration remains deferred: `TRADE_CALIBRATION_MIN_REAL_TRADES = 50` unchanged,
   1 real historical trade on file (Phase 3.5's finding) — a population-size fact, not a
   negotiation-layer defect.
4. Behavioral intelligence remains structurally `INSUFFICIENT_DATA` for every real manager in
   this repository's current data state — expected, not a defect.

## Q. Regression totals

| Suite | Result |
|---|---|
| `test/trade-engine-phase5.test.ts` (Phase 5, incl. new audit regression tests) | 32 / 32 |
| All `test/trade-engine*.test.ts` + `test/weekly*.test.ts` | 449 / 449 |
| Full repository (`test/*.test.ts`) | 1197 / 1207 pass, 10 fail |
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 18 pre-existing warnings (unrelated files) |

The 10 failures are the same pre-existing, documented live/pre-draft-season network-dependent
tests from every prior phase's baseline (`live: standings`, `live: managers`, `live: snapshot`,
live recommendation/K-DEF-board/draft-snapshot endpoints, `live draft: pre-draft state`) —
confirmed by name against the Phase 4 audit's own baseline. **0 non-live regressions**, matching
the `321/321 trade, 120/120 weekly, 10 pre-existing live failures, 0 non-live regressions`
baseline this audit was measured against (the trade-suite total is now higher than 321 due to
the new Phase 5/5-audit tests added since; the *ratio* — 0 non-live regressions — is what
carries forward unchanged).

## Guiding-principle check

Phase 5, post-audit, answers exactly: given the trades the canonical engine says are rational,
which offer to make first (`OPENING`, now correctly the cheapest-for-requester), which
concession is cheapest (sweetener ranking, now correctly ordered and never NaN/Infinity/negative-
cost-clamped), and where to stop (`MAXIMUM_RATIONAL`, now correctly the farthest-still-rational
extension, not merely "whatever was left in the list"). It answers none of "what will this
manager do" — `behavioral_intelligence` remains structurally incapable of a personality claim
and honestly reports `INSUFFICIENT_DATA` throughout the real league data.

---

PHASE 5 NEGOTIATION INTELLIGENCE AND OFFER STRATEGY AUDIT:
READY TO FREEZE
