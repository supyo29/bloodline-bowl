# Decision Model Convergence — W1.P3: Bye-Aware Asset Preservation

Baseline: W1.P2 certified tip `68fc482` (2 commits ahead of `origin/main` @ `201256b`; origin has not advanced → no drift to assess).
Branch: `decision-convergence-w1-p3-bye-asset-preservation`. Not pushed, not merged, not deployed.

A bye proves one thing: the player cannot score **this week**. It says nothing about how good he is.
This phase makes the system hold both facts at once — *current-week utility 0* and *asset value intact* — and stops the drop side from reading the first as evidence about the second.

## 1. W1.P2 baseline

Re-run on `68fc482` before any W1.P3 edit: **3189 tests / 2751 pass / 127 fail / 257 cancelled / 54 skipped** — identical to the W1.P2 report, and the 157 failing names are identical to W1.P2's set
(sandbox Sleeper `403` + wall-clock-dependent tests). Saved for before/after comparison.

## 2. Forensic inventory of bye-zero logic

W1.P2 said "at least five places". The real count was **9 code files** with their own bye interpretation (17 predicate sites, 4 zero-producer sites). Dependency map:

```
schedule (authoritative)  ──►  context.ts#verified-bye override  ──►  ctx.projections row {projected_points:0, status:"bye", is_bye:true}   [PRODUCER #1]
                                          │
   readers of that row (each previously re-derived "is this a bye?" with a string compare on projection_status):
   lineup.ts (VERIFIED_ZERO, bye_problems, illegal, note)  ·  matchup.ts (3 unknown/known guards)  ·  matchup-intelligence/build.ts (3)
   waivers.ts (weeklyKnown, uncertainty penalty)  ·  context.ts (stillMissing, readiness count)  ·  roster-health/evaluate.ts  ·
   schedule-planning/evaluate.ts  ·  waiver2/roster.ts (SHADOW)
   independent PRODUCERS: trades/ros.ts#rosWeekProjection (per-future-week row)  [#2] · schedule-planning/evaluate.ts (per-week ROS basis `onBye ? 0`)  [#3]
```

Where the zero was misread as asset value (the audit's real findings):

| Path | What happens | Verdict |
|---|---|---|
| **waivers.ts drop side** (`rosterValue.keep`) | `keep = weeklyVOR(0 pts) + ROS edge×1.2 + starterProtection`. A bye starter's VOR is `0 − replacement` (≈ −8), starterProtection = `max(0, vor)` = 0, ROS edge is capped at +4.8 → `keep` is negative; pair scoring then does `gain − max(0, keep)`, so his ROS value is clamped away and he **ties a fringe bench player on lineup gain; the tie goes to ascending `keep`, which puts the bye star first.** | **ROOT CAUSE — fixed** |
| trades `competitive/private-value.ts` | Prefers RI ROS (bye-safe) but **falls back to weekly VOR when RI is absent** — a bye player then prices from `0`. | **Fixed narrowly** (bye-neutral ROS rate, LOW confidence, or unavailable) |
| roster-health ROS horizon (`horizonBatch`) | Rewrites points but kept `is_bye`, so a current-week bye could zero a player in the *ROS* horizon (latent; reachable via the W1.P2 `projectionsOverride` seam). | **Fixed** (the rewriters reset bye state coherently) |
| waivers add side `injuredStarterPos` | A bye row has `expected_availability = 0`, so a bye starter also triggers the **injury-hedge** credit on top of the bye-hole credit (a double credit). | **Documented, not changed** (add-side scoring is out of scope) |
| trades `depth.ts` (`outProd`), trades `evaluate.ts` weekly lineup | Current-week production/lineup of outgoing players — a *utility* measure, legitimately 0 on bye. | Leave; documented |
| schedule-planning per-week ROS basis | Bye = 0 *for that future week's lineup*. Utility, not asset. | Leave (sanctioned exception) |
| Waiver Intelligence 2.0 (SHADOW) | Already blends a current level with a ROS-per-week future level (better structure), but its near-term `lNow` is still the bye zero; `drop.bye_cover` is roster-level (legitimate). | **Untouched** (SHADOW_ONLY, status unchanged); concepts noted for the Drop/Keep rebuild |
| lineup / matchup / matchup-intelligence | Bye = known current-week 0. Correct. | Unchanged |

## 3. Current-week utility vs asset value

| Concept | Meaning | Source |
|---|---|---|
| **A. Current-week value** | what he contributes this week; **0** on a verified bye | `expected_points` / `weekly_value.current_week_points` |
| **B. Underlying value** | what he'd produce with a game; **not** destroyed by the bye zero | `weekly_value.underlying_points_if_game_played` |
| **C. Hold / asset value** | what I give up by dropping him | `holdWeeklyValue()` — drop side only |
| **D. Drop attractiveness** | decision-layer: hold value + roster construction + replacement + lineup gain | waiver engine; **not** collapsed into a scalar with A–C |

## 4. Canonical schema changes (extends W1.P1/P2; no parallel object)

`CanonicalWeeklyPlayerForecast` gains two blocks (and no new value object):

```ts
weekly_value: {
  current_week_points: number | null;            // always === projection.expected_points
  current_week_state: "PLAYABLE" | "BYE" | "OUT" | "UNKNOWN" | "KNOWN_ZERO";
  underlying_points_if_game_played: number | null; // null = unknown, never a fabricated 0
  underlying_basis: "SOURCE_PROJECTION" | "SOURCE_PROJECTION_PRE_BYE" | "ROS_PER_WEEK_PROXY" | "UNAVAILABLE";
};
asset_context: {
  temporary_unavailability_reason: "BYE" | "INJURY" | null;   // BYE wins if both apply; injury stays in injury_model
  bye_suppressed_current_week: boolean;
  forward_value_available: boolean;
};
```

For a bye, underlying = pre-bye source projection if one exists, else **existing ROS ÷ remaining weeks** (`holdHorizonWeeks(week) = max(1, 18 − week)`, the horizon the waiver engine's ROS edge already used), else unknown. **The ROS proxy is crude and uncalibrated** and is labelled as such.
`lib/weekly/forecast/bye.ts` is the single authority: `isVerifiedBye` (explicit state only — never inferred from a zero), `verifiedByeRow` (the one bye-row producer), `holdWeeklyValue`.
Validator invariants added: bye ⇒ current week known 0 and `BYE`; no bye state on a non-bye player; unknown ≠ 0; known zero ≠ bye; a bye's underlying is never a fabricated 0; `weekly_value` always equals `expected_points`; the bye ledger line is not doubled.

## 5. Bye-neutral counterfactual design

For every drop decision with a bye player on the roster the engine scores the same legal pairs twice — `keepLegacy` (bye zero) and `keep` (bye-neutral hold value) — reusing one lineup solve per pair (cached), and reports for each bye candidate:

```json
{ "player_id": "A", "is_bye": true, "current_week_points": 0, "hold_value_weekly": 13.53, "hold_basis": "ROS_PER_WEEK_PROXY",
  "drop_rank_with_bye_zero": 1, "drop_rank_bye_neutral": 8, "rank_changed_by_bye": true,
  "preferred_drop_with_bye_zero": "A", "preferred_drop_bye_neutral": "B",
  "bye_guardrail_applied": true, "is_recommended_drop": false, "reason": "…" }
```
`reason` is generated from those fields and also pushed into the recommendation's `reasons`, e.g. *"Valuable Bye WR projects 0 this week because he is on a verified bye, but his hold value is intact (13.5/wk (ROS_PER_WEEK_PROXY)); the bye zero is not treated as evidence he should be dropped, so he is protected from this drop."* and, for a marginal player, *"…is on bye, but he is still the preferred drop: even with the bye removed his hold value (…) is the weakest drop-adjusted asset on the roster (bye-neutral rank 1)."*
The field is **absent** when no bye player is a candidate, so non-bye output is byte-identical to W1.P2.

## 6. Waiver / drop integration

Only the **drop side `keep`** changed, and only for verified-bye players: `keep = (VOR(hold) ) + max(0, ROS edge)×1.2 + starterProtection(VOR(hold))` — the identical formula with hold value in place of the bye zero. Non-bye players: `keep` is exactly the old expression (hold basis = their current-week value), so non-bye transactions are numerically unchanged (asserted). The pair-selection rule, add-side scoring, FAAB, lineup math (bye = 0) and readiness gates are untouched. Unknown hold value (no source, no ROS) falls back to the existing unknown-VOR default (−3), i.e. **no protection is invented** and no penalty is invented.
**Not absolute:** a genuinely weak bye player stays droppable (§11); a streaming kicker on bye stays droppable; there is no `if (is_bye) never drop`.

## 7. ROS / hold-value proxy used

Hold value for a bye = pre-bye source projection (rare: the feed omits bye teams) else `rest_of_season_points ÷ (18 − week)`. This is the **existing** ROS projection spread evenly; it ignores schedule, role trend and bye weeks remaining, and inherits ROS's known crudeness. It is a *do-not-erase* proxy, **not a calibrated asset valuation**; no week-by-week trajectory was built (that belongs to the ROS phase).

## 8. Injury interaction

Injury drop-safety from W1.P2 is intact and re-tested: waivers never consume `ctx.forecasts`, so the injury-adjusted current-week value cannot create an injured-star drop (scenario G is identical to W1.P2; waiver output is byte-identical with/without forecasts attached). Bye + injury: BYE owns `current_week_state`; the injury designation stays in `availability`/`injury_model` (mode `NOT_APPLIED`), no injury ledger line is added to a bye (no double penalty). `asset_context` reports `INJURY` for a known-unavailable non-bye player, which is the hook the later injury-hold work will use. A weak injured player can still be dropped. **The numerical injury-drop model is not part of this phase.**

## 9. Replacement / VOR interaction

`computeWeeklyReplacement` answers "who helps this week?" — a bye player's 0 is valid there and is unchanged. The drop side asks "what asset am I giving up?" — there the bye zero is invalid and is replaced by hold value (§6). The distinction is now explicit in code (`keepLegacy` vs `keep`, and `holdWeeklyValue`). The Market-State / raw `availability.players` pool mismatch is **not** addressed (later phase).

## 10. Provider neutrality

No bye module references Sleeper/Yahoo identifiers (test-scanned). A Yahoo-identified valuable bye player is protected identically to a Sleeper-identified one; the canonical state is `is_bye = true` regardless of how the schedule was sourced.

## 11. Regression cases (all in `test/bye-asset-preservation.test.ts`, 47 tests)

Defect reproduced from a **clean W1.P2 checkout** (captured JSON), then fixed. A valuable bye / B marginal bye (still dropped) / C two byes (protect elite, drop fringe) / D bench entirely playing / E open spot (no manufactured drop) / F no useful add (PASS) / G injured valuable / H bye + injury / I known zero ≠ bye / J missing ≠ zero ≠ bye / K streaming kicker on bye (droppable) / L valuable DST on bye. Plus: the permanent **remove-the-bye invariant**, the guardrail-is-not-absolute invariant, diagnostics schema/prose, lineup & matchup unchanged, trade private-value, roster-health, canonical `weekly_value`/`asset_context` invariants (incl. K, DST, Yahoo), architecture/provider-neutrality scans.

## 12. Mutation tests — 13 mutations, 13 killed

M1 guardrail disabled (9 tests fail) · M2 hold = current-week points (11) · M3 every bye undroppable (7) · M4 missing projection as zero (2) · M5 injury-adjusted expected used as drop asset value (4) · M6 bye inferred from a zero (5) · M7 bye penalty applied twice (6) · M8 bye asset context never set (13) · M9 underlying collapses to the bye zero (5) · M10 ROS horizon keeps the bye flag (1) · M11 trade value falls back to bye-zero VOR (2) · M12 waiver lineups consume injury forecasts (3) · M13 diagnostics misreport the rank change (1). Each file was restored and verified. (Suites exercised: bye, injury decisions/EV, canonical forecast + architecture, roster-health, schedule-planning.)

## 13. Numerical before/after (same scenarios; before = clean checkout of `68fc482`)

| Scenario | W1.P2 drop (cost / net) | **W1.P3 drop (cost / net)** | Bye diagnostics / reason |
|---|---|---|---|
| A valuable bye (ROS 230) | **A** (−6.2 / 6) — the bug | **B** (−4.5 / 6) | A hold 13.5/wk; rank 1 → 8; guardrail applied |
| A-cf (same player, bye removed) | B (−4.5 / 1) | B (−4.5 / 1) | unchanged; proves the bye alone caused the bug |
| B marginal bye (ROS 30) | A (−11 / 6) | **A** (−9.24 / 6) | hold 1.8/wk; rank 1 → 1; still the drop |
| C elite + fringe on bye | B (−11 / 6) | **B** (−8.94 / 6) | B hold 2.1 recommended; A hold 13.5 rank 2 → 8 |
| D whole bench plays, all weak | **A** (−6.2 / 8.5) | **B** (−5 / 8.5) | guardrail applied |
| H bye + Questionable | **A** (−6.2 / 6) | **B** (−4.5 / 6) | guardrail applied; no injury penalty stacked |
| K streaming kicker on bye | k1 (−9 / 12.15) | **k1** (−3.71 / 12.15) | hold 5.3/wk; rank 1 → 1; still the drop |
| E open spot · F no add · G injured · I known zero · J missing · L DST | identical | identical | — |

Every changed drop is a bye player; **net roster gain is identical in all 13 scenarios** (the transaction value moves only through the drop partner, and `drop_cost` is reported on the corrected basis). Non-bye scenarios are byte-identical to W1.P2.

## 14. Architecture ratchet results

| Metric | W1.P2 (`68fc482`) | W1.P3 |
|---|---|---|
| Independent bye **predicate** sites (outside the canonical module) | 17 in 8 files | **1** (`waiver2/roster.ts`, SHADOW, documented exception) |
| Independent bye-**zero producers** (code) | 4 in 3 files (`context`, `trades/ros`, `schedule-planning`) | **1** (`schedule-planning`: per-future-week utility, documented exception); `context` and `trades/ros` build via `verifiedByeRow` |
| Files with independent bye logic | 9 | **2** (+ 1 canonical module) |
| Legacy direct projection readers (W1.P1 29 → W1.P2 28) | 28 | **28** (did not increase; the new code lives in the exempt forecast module) |

New permanent tests fail on any new independent bye predicate/producer (verified by planting one).

## 15. Known limitations

- Hold value is a crude ROS spread, uncalibrated; `ROS_PER_WEEK_PROXY` carries no schedule/role/bye-remaining information. Not a Drop/Keep model.
- If a bye player has neither a pre-bye source value nor ROS, hold value is unknown: no protection is invented (and no penalty).
- The add-side injury-hedge credit still fires for a bye starter (bye row `expected_availability = 0`), double-crediting that position alongside the bye-hole credit. Deliberately left (add-side scoring); candidate for the Waiver 3.0 / add-side cleanup.
- Waiver Intelligence 2.0 (SHADOW) and `trades/depth.ts`, `trades/evaluate.ts` weekly measures still see the bye zero as current-week utility; schedule-planning keeps its per-week zero. All documented utility uses; none feed a drop recommendation in production.
- The waiver engine still reads `ctx.projections` directly (consumer stays on the source basis); migrating it to canonical asset value is the Drop/Keep rebuild.
- Replacement/VOR pool vs certified Market State mismatch is unaddressed.
- The `is_bye || status === "bye"` predicate required making batch rewriters reset `is_bye` (two found); any future code that spreads a bye row and rewrites points must do the same — the ratchet cannot catch that.

## 16. W1.P4 handoff

Bye and injury now share one pattern (`weekly_value` + `asset_context` + a hold-value view) that W1.P4's freshness work can invalidate per event (a bye announced, a status change). Open items for W1.P4: event-driven invalidation of `bye_suppressed_current_week`/status, source observation time for the underlying value, the orchestrator ordering (F5 remainder), and capturing source projections to replace the ROS proxy with real underlying values for byes. Gates: typecheck clean; lint 39 warnings / 0 errors (same as baseline); `next build` passes; full suite **3240 tests / 2802 pass / 127 fail / 257 cancelled / 54 skipped** with a failing set identical by name to the W1.P2 baseline.
