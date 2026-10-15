# Decision Model Convergence — W1.P2: Injury-Aware Expected Value

Injury model: `injury-expected-value-2026.1` · Priors: `injury-priors-2025-w1-18.v1` · Forecast contract: `canonical-weekly-forecast-2026.1`
Baseline: W1.P1 certified tip `ab7dce3` (1 commit ahead of `origin/main` @ `201256b`; origin has not advanced).
Branch: `decision-convergence-w1-p2-injury-expected-value`. Not pushed, not merged, not deployed.

The goal of this phase is **not** to penalize injured players. It is to represent the expected fantasy value of an injured
player correctly. A questionable elite player can still be the right start; an officially inactive player must never survive on
a stale projection; and an upstream projection that already priced an injury must not be discounted twice.

## 1. W1.P1 baseline

W1.P1 built the canonical forecast and deliberately preserved production behavior: `expected_points` equalled the source
projection (bye = compat zero), injury was metadata (`applied_to_expected_points: false`), and the lineup optimizer read the raw
`ctx.projections`. Branch baseline test run at `ab7dce3` before any W1.P2 edit: **3113 tests / 2675 pass / 127 fail / 257 cancelled / 54 skipped**
(identical to the W1.P1 report; failing set = sandbox Sleeper `403` + wall-clock-dependent tests).

## 2. Forensic findings

| # | Finding | Status in W1.P2 |
|---|---|---|
| F1 | `context.ts` rewrote a source `"out"` to `"unavailable"`, making `PLAYER_OUT_IN_SOURCE` unreachable. | **Fixed.** `"out"` survives; `projected_points` stays `null`. Only a `"projected"`-with-no-number row is rewritten. |
| F2 | `matchup.ts#drawSpec` turned a null (non-bye) projection into a `(mean 0, sd 2)` draw. | **Fixed, fail closed.** Unknown starters are excluded from the draw list and the win probability is not simulated (`win_probability_unavailable_unknown_starter`). A verified bye / known-unavailable stays a legitimate 0. |
| F5 | `roster-health/inputs.ts` makes its own projection-provider read. | **Seam added, not fully removed** — see §12. |
| F7 (new) | The provider's fixed availability heuristic is badly miscalibrated: Doubtful `0.30` vs **0 of 39** observed active; Questionable `0.78` vs **≈0.58**. | Replaced as the source of `probability_active`; the provider value is kept as provenance (`availability.source_heuristic_availability`). |
| F8 (new) | `lib/weekly/waivers.ts` calls `buildOptimalLineup` directly with `ctx.projections`. A lineup-level migration there would turn an injured star into a drop. | Waivers stay on the source basis; guarded by a test and a mutation check (§13). |
| F9 (new) | `injury_status` provenance: the weekly pipeline only ever sees the Sleeper `injury_status` string; practice participation, official inactives and workload evidence have **no production producer**. | Model accepts them as optional evidence; none is supplied in production today (§15). |

## 3. Upstream projection-semantics findings

**Whether the Sleeper/RotoWire weekly projection already embeds injury risk cannot be established from this repository or sandbox.**
Evidence examined: the provider scores RotoWire stat lines with **no injury logic of its own** (`sleeper-weekly.ts`); it sets `projection_status: "out"`
only when a row has `gp = 0` and no component stats; live Sleeper is unreachable (organization network policy, `403` at the egress proxy — not worked
around); Sleeper keeps **no historical archive** of injury designations or source projections (documented in `lib/analytics/historical-availability.ts`);
no stored history of the actual source projection exists locally; the repo's calibration docs contain no baseline-vs-injury comparison; for K/DST the
provider uses `pts_std` and carries no injury information at all.

Consequently `sleeper_weekly` is registered as `UNKNOWN` (`SOURCE_INJURY_SEMANTICS`) and the model encodes that explicitly (§8). The path to resolving it
(not done here): pair the persisted source baseline with its injury status (matchup2 capture already stores both) against actuals once enough live weeks exist.

## 4. Source injury-status handling

The provider's string is retained verbatim in three places that must agree (validator-enforced): `availability.injury_status`,
`injury_model.source_status`, and the legacy row. For a player with no feed row, the canonical player's status is used and recorded
verbatim. Normalization is a **separate** field (`injury_model.normalized_state`, `availability.normalized_state`) — answering "what did the provider
report?" and "how did Bloodline interpret it?" independently (F1).

## 5. Normalized injury states

`HEALTHY` (incl. null/`Active`/legacy `Probable`) · `QUESTIONABLE` · `DOUBTFUL` · `OUT` · `INJURED_RESERVE` · `UNAVAILABLE_LIST` (PUP/NFI/SUS/DNR) ·
`OFFICIAL_INACTIVE` · `OFFICIAL_ACTIVE` · `UNKNOWN_STATUS` (any unrecognised string — **never** mapped to healthy) · `NOT_APPLICABLE` (team defense).
`availability_state`: `AVAILABLE | AT_RISK | UNAVAILABLE | UNKNOWN`. Provider-neutral: no Sleeper field is read; a provider with no injury field at all is
`UNKNOWN_STATUS`, not healthy (`source_provides_injury_data: false`).

## 6. Active-probability model

`P(active)` is a **count-based prior with Beta shrinkage** (`injury-priors.ts`), not a hand-set map. Evidence: nflverse final team-week designation +
practice participation, outcome = produced offensive snaps. Training = 2025 W1–18 (1750 injury-reported player-weeks).

| Designation | Evidence | Resulting P(active) |
|---|---|---|
| Out | 0 / 428 active | resolves to **known zero** (§9) |
| IR / PUP / NFI / SUS / DNR | list-based | known zero |
| Doubtful | 0 / 29 active, shrunk toward 0.15 (k=10) | **0.038** |
| Questionable | 206 / 352 pooled; stratified by role tier × practice, shrunk parent-to-child (k=10) | RELEVANT starter (source ≥ 8 pts): **0.709**; FRINGE: **0.537**; practice moves it (RELEVANT: Full **0.855** / Limited **0.689** / DNP **0.657**; FRINGE: 0.537 / 0.537 / 0.496) |
| Healthy / official active | — | 1 (identity) |

Player-specific evidence supported by the structure: practice participation, role tier (explicit, or proxied by source points ≥ 8 at runtime),
official inactive/active, returning-from-injury, explicit workload. Position-specific rates were **not** used (QB n=42 is dominated by backups).
Kicker: Out → 0; Questionable → **no discount** (no kicker in the sample); Doubtful → extrapolated and flagged `ASSUMED_UNVALIDATED`. DST: `NOT_APPLICABLE`.

## 7. Workload model

Workload-if-active is a **separate** variable (`injury_model.workload_if_active` `{expected_fraction, lower_bound, upper_bound, basis}`), never folded into `P(active)`.
Evidence from 2025: for Questionable players who played, snap share relative to their own previous 4 games has median **0.96** (mean 1.00, n=188) and for
non-designated players 1.01 (n=765). That does not justify a default workload discount, so the default is **1.0 with bounds [0.75, 1.10]**
(`INSUFFICIENT_DATA`). A discount applies only when explicit workload evidence is supplied (`ASSUMED_UNVALIDATED`). "Returning from injury" without
evidence is flagged (`RETURNING_FROM_INJURY_WORKLOAD_UNMODELED`), not invented. Nothing in production supplies workload evidence yet.

## 8. Double-counting guard

One formula covers every source-semantics case. With `P = P(active)`, `w` = workload, and `λ` = share of the injury discount the source is believed to already embed:

```
m_s          = 1 − λ(1 − P)        multiplier already inside the source
conditional  = source / m_s        value if active
expected     = conditional × P × w = source × (P / m_s) × w
```

| Source semantics | λ | Result | Basis |
|---|---|---|---|
| `CONDITIONAL_ON_ACTIVE` | 0 | `source × P × w` | `CONDITIONAL_ACTIVE_X_AVAILABILITY` |
| `UNCONDITIONAL` | 1 | `source × w` — **no second discount** | `SOURCE_ALREADY_INJURY_ADJUSTED` |
| `PARTIALLY_ADJUSTED` / `UNKNOWN` | 0.5 (documented midpoint) | only the **remaining** risk applied | `SOURCE_WITH_PARTIAL_INJURY_ADJUSTMENT` |
| unrecognised status / unsupported | — | source kept, confidence degraded | `UNKNOWN_SOURCE_SEMANTICS_NO_ADDITIONAL_DISCOUNT` |
| known unavailable | — | 0, source visible | `OFFICIAL_UNAVAILABLE_KNOWN_ZERO` |

**λ = 0.5 for `sleeper_weekly` is a maximum-uncertainty assumption, not an estimate**, and is the single most consequential unvalidated number in the phase.
It bounds the cost of being wrong for a relevant Questionable player (P=0.709): the model values him at 83.0% of source. If the source is truly conditional the right figure is 70.9% (we under-discount by ~12 points); if it is truly unconditional the right figure is 100% (we over-discount by ~17 points) — instead of being wrong by 0 vs 29 points (or 29 vs 0) from picking an extreme. It is labelled on every forecast (`SOURCE_INJURY_SEMANTICS_UNKNOWN_PARTIAL_DISCOUNT_ASSUMED`, certification `PARTIAL`).
The validator rejects any availability delta on an `UNCONDITIONAL` source.

## 9. Expected-value formula, ledger and basis

`expected_points = source_points + INJURY_AVAILABILITY + INJURY_WORKLOAD` (cents-exact by construction). Both deltas are PRODUCTION ledger lines whose reason carries
status, `P(active)`, semantics, λ and calibration state, e.g. `QUESTIONABLE; P(active)=0.709; semantics UNKNOWN (λ=0.5 assumed); availability PRODUCTION_PROVISIONAL_PRIOR; probability-of-playing discount`.
`source_points` is never overwritten. A **known unavailable** player resolves to a known zero with `value_state: KNOWN_UNAVAILABLE`, source projection visible,
and the ledger shows the explicit negative line. Combinations:

| Case | Result |
|---|---|
| Out + missing source projection | known zero (ledger: `INJURY_AVAILABILITY 0`) |
| Questionable / healthy + missing | unknown (`null`), never 0 |
| Bye + injury designation | bye stays `BYE_VERIFIED`; injury model `NOT_APPLIED`; status string kept |
| Official inactive over a stale Questionable | 0; original status still on record |
| Official active over Questionable | no penalty |
| `injury_mode: "SHADOW"` | computed + SHADOW ledger lines; `expected_points` equals W1.P1 exactly (rollback path) |

`uncertainty.variance` now includes participation risk (Bernoulli mixture `P(σ²+μ²)−(Pμ)²`). `confidence` is injury-evidence strength
(`status_support × semantics_certainty`), **not** a calibrated probability.

## 10. Lineup integration (the behavioral change)

`buildOptimalLineup` gained an optional `forecasts`; the optimizer itself is untouched. Per-player values are read through one view,
`forecast/view.ts#decisionProjectionRows`: canonical rows when forecasts exist, the **legacy rows unchanged** otherwise (the single audited fallback). Passed from
the weekly context's lineup (`buildLineup`), and both matchup lineups. A rostered Out player the feed omitted is a known zero in the view (no provisional hole).
**Recommendations that change:** a Questionable/Doubtful/Out player whose injury-aware value is below the alternative is no longer started (and the reverse is not
true: a questionable star still starts). Reported lineup totals/gains are now injury-aware expected values. Healthy-vs-healthy decisions are unchanged.

## 11. Matchup integration

Matchup lineups, swing notes, bench depth and the simulation read the same decision rows, so margins and win probabilities now reflect injury-aware values
(attributable: `team_optimal_total` equals the canonical `expected_points`; test shows a 20-pt Questionable vs 18-pt healthy flips from favored to not).
No new simulation model, correlation or distribution logic. `replacement_vulnerability` intentionally stays on the source basis (its comparator, the FA replacement
level, is source-based). F2 fixed as above.

## 12. Roster-health / F5

**Partially resolved; the duplicate path remains in one place and is documented.** Added `RosterHealthInputOptions.projectionsOverride` (reuse an assembled context's batch +
forecasts): no provider call, ROS not re-assembled, same batch object (test-proven), `projection_source: "SHARED_CONTEXT"`. `RosterHealthInputs.forecasts` is now always attached (built by the
single builder). **Not done:** the orchestrator builds roster-health inputs *before* any weekly context exists, so it still makes its own provider read. Both reads
go through `CanonicalProjectionSnapshotProvider` (policy `prefer`), so within the 90-minute snapshot window they return the **same snapshot artifact**; the divergences are
post-processing (bye override, kickoff-return enrichment, ROS assembly), not a different injury/freshness source. Roster-health *values* stay on the source basis (it compares
against a source-based replacement pool and a ROS horizon — injury-adjusting one side would mix bases). Reordering the orchestrator is a W1.P4 candidate.

## 13. Tests

New: `injury-expected-value.test.ts` (44), `injury-decisions.test.ts` (18), `injury-calibration.test.ts` (11); architecture +4; W1.P1 tests updated where they encoded the pre-injury
behavior (each assertion changed deliberately, listed in the commit). Coverage includes every case in the spec: healthy, questionable full/limited, doubtful, official OUT/IR/PUP,
source-OUT truth, unknown status, missing + questionable, matchup null, healthy/injured K, DST, Yahoo, ledger reconciliation, determinism, and decision cases A–D plus doubtful,
limited-workload return, official inactive and unknown semantics.

**Mutation testing — 12 mutations, 12 killed** (each applied, tests run, file restored byte-for-byte): M1 all Questionable → full projection (23 tests fail); M2 all Questionable → zero (15);
M3 OUT collapsed into a generic status (9); M4 null → 0 in drawSpec (1); M5 injury contribution removed from ledger (15); M6 discount applied twice (8); M7 double-counting guard bypassed (2);
M8 lineup ignores forecasts (9); M9 official-inactive ignored (3); M10 unknown status guessed healthy (2); M11 DEF through the individual model (8); M12 waiver lineups consume forecasts (1).
M12 initially **survived** — my drop-safety scenario had an open roster spot (no drop was ever chosen) and then the mutation didn't model the real call sites; both were fixed and re-run.

## 14. Calibration results (`scripts/injury-calibration.ts`, committed report)

Reproducible from committed data; the test recomputes the shipped counts and the report. **Limits first:** single season; designation is the *final* team-week status (no timestamp);
outcome is "produced offensive snaps"; there is **no stored history of the Sleeper source projection**, so point accuracy uses a **proxy source** (mean of the player's previous ≤4 games, conditional-on-active by
construction, λ=0). That tests the injury arithmetic; it cannot show how much injury risk Sleeper already embeds. My exploratory tabulation looked at all of 2025 and at 2026 base rates
before the structure (tier threshold 8, k=10, λ=0.5) was fixed; parameters were not fitted to the evaluation windows, but the 2025 temporal split is **not a pure holdout for design choices** — only the
2026 W1–4 evaluation (fit on 2025 only) is out-of-time.

| Probability of playing (designated players) | n | Brier new | Brier legacy 0.78/0.30/0.03 | Brier climatology |
|---|---|---|---|---|
| 2025 W10–18 (fit W1–9) | 456 | **0.111** | 0.132 | 0.195 |
| 2026 W1–4 out-of-time (fit 2025) | 124 | **0.113** | 0.146 | 0.175 |
| …excluding trivially-separable Out, 2025 holdout | 220 | **0.230** | 0.272 (worse than climatology 0.248) | 0.248 |
| …excluding Out, 2026 out-of-time | 64 | **0.219** | 0.282 | 0.246 |

Calibration buckets (2025 holdout, new model): 0.4–0.6 → mean P 0.577 vs observed 0.510 (n=104); 0.6–0.8 → 0.683 vs 0.654 (n=104). **2026 out-of-time:** 0.6–0.8 → 0.681 vs **0.526** (n=19).
The model is **still over-optimistic on Questionable** (2026 excl. Out: mean P 0.52 vs observed 0.44) — better than the legacy heuristic (0.71) but not calibrated. Sample too small to say more.

| Points vs actual (proxy source, 2025 holdout) | n | MAE source proxy | MAE injury-adjusted | MAE legacy-heuristic | bias source → adjusted |
|---|---|---|---|---|---|
| Questionable + Doubtful | 213 | 4.76 | **3.36** | 3.77 | +2.77 → +0.31 |
| Doubtful only | 12 | 7.78 | 0.43 | 2.33 | (n too small to trust) |

Pairwise start/sit proxy (2025 holdout, 179 pairs vs nearest healthy same-position player, |ΔB| ≤ 2): unadjusted false-start 44.7% / false-bench 11.7% / accuracy 43.6% →
adjusted false-start **5.0%** / false-bench **25.1%** / accuracy **69.8%**. **The false-bench rate roughly doubles** — benching more Questionable players also benches some who play well; that is the cost of the discount and is asserted in the test rather than hidden.

Status of each component: **P(active) Questionable/Doubtful/Out = production with provisional prior** (empirical, held-out checked, single season); **workload = insufficient data** (default 1.0 with bounds);
**source-injury semantics = assumed, unvalidated** (λ=0.5); Kicker Questionable = insufficient data (no discount); Official inactive/active = rule-based, not statistical.

## 15. Known limitations

- Sleeper source semantics are unknown; λ=0.5 is an assumption. This is the biggest risk and the first thing to resolve with live captured data.
- No production producer for practice participation, official inactive/active lists, role tier or workload evidence. The model supports all of them; production runs on the designation string + a source-points role proxy only. Until game-day inactive data is wired, "official OUT" in production means a source `Out`/`IR`/… designation.
- Evidence is final-designation, not time-stamped; no state-over-the-week history (the structures carry `observed_at` and can take updates; nothing invents a timestamp). W1.P4.
- Single-season priors; Doubtful and 2026 cells are thin; Questionable P(active) is somewhat over-optimistic out-of-time.
- Point/decision metrics use a proxy source, not the real Sleeper projection.
- A source-reported `gp = 0` with no designation stays an unknown value (not inferred to be zero).
- Roster-health values and the trade/ROS/schedule-planning/waiver engines remain on the source basis (deliberate; §10, §12). The orchestrator's separate roster-health provider read remains.
- `confidence` is evidence strength, not a calibrated probability.

## 16. Deferred

- **W1.P3 — bye-aware asset preservation:** the bye compat zero and drop/keep value are untouched; injury and bye are kept distinct so P3 can build on both.
- **W1.P4 — freshness & event invalidation:** status-over-the-week updates, game-day inactive ingestion, source observation time, orchestrator reorder (F5 remainder).
- Estimating λ from captured source projections; recalibrating priors on 2026+ live outcomes; position-specific kicker/DST modeling; migrating waiver/trade consumers to a current-week-vs-asset-value split.

## 17. Before / after numerical examples (real golden run, before = `ab7dce3`)

| Player (case) | Source | W1.P1 expected | **W1.P2 expected** | Status → state | P(active) | Basis / reason |
|---|---|---|---|---|---|---|
| g-qb (healthy QB) | 22.4 | 22.4 | **22.4** | none → HEALTHY | 1 | unchanged, bit-for-bit |
| g-rb-q (Questionable RB) | 14.6 | 14.6 | **12.11** | Questionable → QUESTIONABLE | 0.709 | partial adj. (λ=.5): 14.6×0.709/0.8545; ledger −2.49 |
| g-qb-q-star (Questionable star QB) | 22 | 22 | **18.25** | Questionable | 0.709 | ledger −3.75; still the top-valued injured player |
| g-rb-q-fringe (Questionable, source 5) | 5 | 5 | **3.49** | Questionable | 0.537 | fringe role tier |
| g-wr-doubtful | 15 | 15 | **1.11** | Doubtful | 0.038 | ledger −13.89 |
| g-wr-out | 9.1 | 9.1 | **0** (KNOWN_UNAVAILABLE) | Out | 0 | source 9.1 retained; ledger −9.1 |
| g-rb-ir | 10 | 10 | **0** | IR | 0 | stale source retained |
| g-k-out (kicker) | 7.9 | 7.9 | **0** | Out | 0 | K/DST fallback warning preserved |
| g-wr-out-missing | — | null | **0** | Out (player status) | 0 | known zero without a source row |
| g-te-yahoo-q (Yahoo, no sleeper_id) | 9 | 9 | **7.47** | Questionable | 0.709 | same model |
| g-k-q (Questionable kicker) | 8.2 | 8.2 | **8.2** | Questionable | — | no calibration sample → no discount |
| g-def-injstr (DST w/ stray status) | 5.5 | 5.5 | **5.5** | — | — | team entity, `NOT_APPLICABLE` |
| g-wr-cov (unknown status "COV") | 11 | 11 | **11** | unrecognised → UNKNOWN_STATUS | null | source kept, confidence 0.25 |
| g-te-q-missing | — | null | **null** | Questionable | — | unknown, **not zero** |
| g-rb-bye-q (bye + Questionable) | — | 0 | **0** | BYE_VERIFIED | null | bye untouched; status string kept |
| g-rb-out-src (source `gp=0`) | — | null | **null** | `PLAYER_OUT_IN_SOURCE` (F1) | — | status survives (was "unavailable") |

Exactly nine players changed `expected_points`; all 15 others are identical (asserted). The legacy `ctx.projections` (what waivers/replacement read) is unchanged for all 24 players except
`g-rb-out-src.projection_status` (`unavailable` → `out`, the F1 fix). Decision example (single WR slot): Questionable source 15 vs healthy 14 → legacy starts the injured player,
W1.P2 starts the healthy one (12.45 < 14); Questionable star 22 → 18.25 > 14 → still starts; Out star 22 vs healthy 5 → starts the healthy player.

## 18. Gates

Typecheck clean · lint 39 warnings / 0 errors (identical to baseline; none in changed files) · `next build` passes · full suite **3189 tests / 2751 pass / 127 fail / 257 cancelled / 54 skipped**;
the 127-failure set is **identical by name** to the pre-change branch baseline (error causes identical in class: sandbox Sleeper `403`; only which endpoint raced first varies).
Legacy direct projection readers (ratchet): **29 → 28** (`lib/weekly/lineup.ts` retired from the list; `matchup.ts` still has direct reads for its source-basis comparisons).
