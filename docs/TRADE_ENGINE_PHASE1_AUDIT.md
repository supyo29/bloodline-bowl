# Trade Engine — Phase 1 Foundation Audit

Engine version after audit: **`ri-trade-foundation-2026.2`** (was `2026.1`; bumped
because acceptance-classification and composite-weighting behaviour changed —
see D1/D2 below).

Method: every claim was re-verified by code inspection and by a new deterministic
adversarial suite (`test/trade-engine-audit.test.ts`, 46 tests) plus the existing
`test/trade-engine.test.ts` (19 tests). Nothing below is taken on the word of the
original implementation notes.

---

## A. Architecture verified

**What the system actually does**

1. `POST /api/trades/analyze` (or `analyzeTrade(proposal)`) accepts a generalized
   N-party proposal: `{ league, participants[], transfers[] }` where each
   transfer is `{ from_manager_id, to_manager_id, asset: { type: "PLAYER",
   player_id } }`. 2-team and 3-team trades are the identical code path.
2. `analyzeTrade` loads **one** canonical league snapshot, resolves every
   participant through canonical manager resolution and every asset through the
   snapshot's identifier crosswalk (canonical id / Sleeper id / Yahoo id /
   name-key), and builds ownership + position maps from that single snapshot.
3. `validateTrade` runs against the **pre-trade** canonical roster state and
   returns explicit failure codes (never a silent correction). It also
   reconstructs the post-trade rosters to check no-player-on-two-rosters, size
   limit, and structural fieldability (`maxSlotMatching`, the shared slot matcher).
4. On success, `analyzeTrade` builds **one** shared `WeeklyTeamContext`
   (projections + replacement frontier + resolved roster constraints — the same
   inputs the lineup/waiver engines use) and calls `evaluateTrade`.
5. `evaluateTrade` (pure, deterministic) for **every** participant:
   - `reconstructRosters` builds an immutable `before` and a `after` from the
     original state + **all** transfers at once (not chained);
   - `buildOptimalLineup` (Hungarian assignment) is run **independently** on
     `before` and `after` — the marginal starter value is the recomputed
     lineup delta, not `old − outgoing + incoming`;
   - `weeklyVOR` (shared definition) gives the starter-VOR delta;
   - `computePositionalNeeds` (shared) gives before/after positional needs;
   - a bench/depth proxy = Σ max(0, weekly VOR) of non-starters;
   - a configurable composite `roster_utility_delta`, an acceptance class, and an
     `above_acceptance_floor` flag;
   - `lineup_displacement` (entered / left / moved-to-bench / bench-promotions).
6. A trade-level `trade_summary` separates **rationality** (does every roster
   improve vs its own pre-trade state?) from **fairness / distribution**
   (`utility_gain_variance`, `utility_gain_spread`, `fairness.imbalance_index`),
   and classifies `trade_viability` (HIGH / MODERATE / LOW / NON_VIABLE).

**Against the intended architecture** — matches. `participants` + `transfers` +
`assets`, generalized N-party, no `twoWay`/`threeWay` split, no bilateral-
reciprocity assumption (verified: circular `A→B→C→A` with no A↔C leg, non-circular
routing, multi-asset from/into one manager — all evaluate correctly).

**Hidden bilateral assumptions found:** none. `reconstructRosters` walks the
transfer list once building per-manager `incoming`/`outgoing` sets; nothing
requires equal in/out counts or pairwise exchange.

---

## B. Defects found & fixed

### D1 — RELUCTANT acceptance class was unreachable
```
Severity:   P2
Component:  lib/trades/config.ts — classifyAcceptance / DEFAULT_TRADE_CONFIG
Failure:    With defaults (neutral_band 1.0, reject -1.0), any delta <= -1
            matched `delta <= reject` (REJECT) before RELUCTANT could ever be
            returned. A documented acceptance class was dead code.
Why it matters: the acceptance vocabulary claimed 6 classes but only produced 5;
            the "mildly negative but not a rejection" band silently didn't exist.
Reproduction: classifyAcceptance(-1.5, DEFAULT) -> "REJECT" (never "RELUCTANT")
            for any input.
Fix:        Replaced with 5 contiguous, strictly-ordered cut points
            (strong_accept > accept > neutral_floor > reluctant_floor >
            hard_reject). `resolveTradeConfig` now throws on a non-monotonic
            override.
Regression test: audit §11/§12 "acceptance is monotonic and every class is
            reachable", "threshold boundaries", "rejects non-monotonic thresholds".
```

### D2 — composite double-counted the starter improvement
```
Severity:   P1
Component:  lib/trades/evaluate.ts + config.ts — roster_utility_delta weights
Failure:    starter_vor_delta (weight 0.35) is ~collinear with
            starter_points_delta (VOR delta ≈ points delta whenever the league
            replacement level is unchanged, which it is for a trade between two
            rostered teams). A pure +3.0 starter-points upgrade produced a
            composite of ~ +3.0 + 0.35·3.0 ≈ +4.05 — a ~35% inflation — which
            in turn made the acceptance thresholds effectively ~35% looser than
            documented for starter-driven trades.
Why it matters: acceptance classification and trade_viability run off the
            composite; a materially misleading STRONG_ACCEPT/ACCEPT could be
            emitted for a trade that only cleared the bar via the double-count.
Reproduction: any starter-upgrade trade — components showed
            starter_points ≈ starter_vor and both were summed.
Fix:        Default `weights.starter_vor` -> 0. starter_vor_delta is still
            computed and exposed as a component (a positional-scarcity lens) and
            as `starter_vor_delta`; a caller may raise the weight to fold
            scarcity into the scalar. starter_points is the composite's honest
            primary term.
Regression test: audit §11/§12 "default composite does NOT double-count",
            "roster_utility_delta equals the documented weighted sum",
            "raising a weight moves utility in the expected direction".
```

### D3 — positional-need pressure triple-counted one hole
```
Severity:   P2
Component:  lib/trades/evaluate.ts — positionalNeedComponent
Failure:    Severity "pressure" was summed over EVERY entry from
            computePositionalNeeds, which emits a base-position entry AND a
            per-flex-label entry AND a STRUCTURAL entry for the same shortage.
            One unfilled RB slot contributed pressure 3 (RB) + 3 (FLEX) + 3
            (STRUCTURAL) = 9, only saved from domination by a ±4 clamp.
Why it matters: positional_need has weight 1.0; a hole fix or a new hole was
            over-weighted by 2–3x (then hard-clamped, which is itself a hidden
            non-linearity).
Reproduction: a trade that opens/closes a base-position hole in a FLEX league.
Fix:        Pressure is summed over the six base positions only. The full need
            list (flex labels + STRUCTURAL included) is still returned in
            `positional_need_changes` for transparency.
Regression test: audit §10 "filling a genuine RB hole reports IMPROVES_NEED".
```

### D4 — largest_beneficiary/largest_negative were participant-order sensitive on ties
```
Severity:   P2
Component:  lib/trades/evaluate.ts — summarize()
Failure:    `results.reduce((a,b) => b.delta > a.delta ? b : a)` keeps the FIRST
            on an exact tie, so permuting the participant array could change
            `largest_beneficiary` / `largest_negative` — trade-level metrics the
            freeze gate requires to be order-invariant.
Why it matters: §15 invariance violation for tied deltas.
Reproduction: two participants with identical roster_utility_delta, swap array
            order -> different largest_beneficiary.
Fix:        Sort by delta then `manager_slug.localeCompare` (deterministic,
            order-independent).
Regression test: audit §15/§16 "swapping participant order AND transfer order
            leaves every numeric result identical" (asserts largest_beneficiary).
```

### D5 — reconstruction id-list order followed transfer-array order
```
Severity:   P3
Component:  lib/trades/reconstruct.ts
Failure:    incoming[]/outgoing[] (and the bench append order they drive) were
            in transfer-array order. Cosmetic for totals, but on an exact
            projection tie between two acquired players competing for one slot it
            could flip which id surfaced in lineup_displacement.
Fix:        Sort incoming/outgoing id lists.
Regression test: audit §15/§16 + §18 determinism.
```

### D6 — analyzeTrade cross-read consistency guard was too weak
```
Severity:   P2
Component:  lib/trades/analyze.ts
Failure:    analyzeTrade loads a snapshot AND calls buildWeeklyTeamContext (which
            loads its own). The guard for "provider changed state mid-request"
            only compared roster SIZE, so a same-size roster swap slipped through.
Why it matters: a silently inconsistent analysis.
Fix:        Guard compares the sorted player-id set of the primary participant's
            roster across the two reads; mismatch -> TRADE_ANALYSIS_DEGRADED
            (warning). NOTE: the two-read architecture itself is a documented
            Phase-1 limitation (see F below); `evaluateTrade` is unconditionally
            deterministic.
Regression test: covered structurally; the two-read path needs a live provider
            (see §24 note).
```

### D7 — route ignored asset.type
```
Severity:   P3
Component:  app/api/trades/analyze/route.ts
Failure:    `asset.type` was never checked — a DRAFT_PICK / FAAB asset was
            coerced toward PLAYER and produced a confusing "invalid_transfer".
Fix:        Explicit 400 `unsupported_asset_type` naming the offending type.
Regression test: exercised via the route validation block (manual); asset schema
            is otherwise locked to PLAYER by the type.
```

### D8 — analyze.ts hardcoded flex_positions in the validation-only constraints
```
Severity:   P3
Component:  lib/trades/analyze.ts — constraintsFromSnap
Failure:    `flex_positions: ["RB","WR","TE"]` is hardcoded. INERT — it is used
            only by validateTrade's size + structural checks, and the structural
            check (`maxSlotMatching`) derives FLEX eligibility from the slot
            label via `slotEligiblePositions`, never from this field. The
            evaluation path uses the fully-resolved weekly-context constraints.
Fix:        Clarifying comment; no behaviour change.
```

### D9 — no guard for a participant missing from the normalized proposal
```
Severity:   P3
Component:  lib/trades/evaluate.ts
Failure:    `recon.by_manager.get(mid)!` would throw if input.participants and
            normalized.participant_manager_ids disagreed (they never do from
            analyze.ts, but a direct caller could).
Fix:        Defensive skip + TRADE_ANALYSIS_DEGRADED diagnostic.
```

**No P0 defects were found.** The central invariant — every affected roster
independently rebuilt and re-optimized, value = marginal lineup/VOR/need effect —
holds (adversarial fixtures A–E below).

---

## C. Corrections made

| File | Change | Driven by |
| --- | --- | --- |
| `lib/trades/config.ts` | Contiguous ordered acceptance bands; `resolveTradeConfig` asserts monotonicity; `starter_vor` default weight 1.0→0; expanded docs | D1, D2 |
| `lib/trades/evaluate.ts` | Positional pressure over base positions only; order-invariant tie-breaks in `summarize`; `classifyViability` uses `reluctant_floor` + treats REJECT as sinking viability; defensive missing-participant guard | D3, D4, D9 |
| `lib/trades/reconstruct.ts` | Sort incoming/outgoing id lists | D5 |
| `lib/trades/analyze.ts` | Consistency guard compares sorted id sets; clarifying comment on validation-only constraints | D6, D8 |
| `app/api/trades/analyze/route.ts` | Reject non-PLAYER `asset.type` with `unsupported_asset_type` | D7 |
| `lib/trades/schema.ts` | `TRADE_ENGINE_VERSION` → `ri-trade-foundation-2026.2` + changelog | version policy |
| `test/fixtures/trades.ts` | New multi-roster fixture harness (`tradeFixture`, `stdTeam`) — full N-roster canonical snapshot so replacement levels are real | audit tooling |
| `test/trade-engine-audit.test.ts` | New — 46 adversarial tests | audit |
| `test/trade-engine.test.ts` | Updated one config-shape assertion for D1 | D1 |

---

## D. Test matrix

| Audit category | Result | Notes |
| --- | --- | --- |
| §2 N-party routing (circular, non-circular, multi-asset) | **PASS** | 3 tests; no bilateral pair required |
| §3 Atomicity (all transfers vs original state, not chained) | **PASS** | reconstruction test |
| §4 Ownership & validation (11 failure codes + alias bypass) | **PASS** | 12 tests inc. alias self-transfer, pre-trade-state ownership |
| §5 Pre/post reconstruction immutability | **PASS** | `before` proven immutable across repeated reconstruction |
| §6 Optimal-lineup recalculation (Fixtures A–E) | **PASS** | A: +1 not +15 · B: bench-only ≈0 starter · C: bench-loss ≈0 · D: RB2→FLEX→bench chain = +11 · E: multi-eligibility via shared matcher |
| §7 Shared lineup/slot logic reused (no local reimpl.) | **PASS** | code inspection: `buildOptimalLineup`, `maxSlotMatching`, `slotEligiblePositions`, `weeklyVOR`, `computePositionalNeeds` all imported from `lib/weekly` |
| §8 VOR consistency + exposed alongside projection delta | **PASS** | same-projection WR↔RB swap keeps both components independent |
| §9 Bench/depth value coherence | **PASS (with documented limitation)** | outgoing starter is NOT double-counted as bench loss; metric = Σ max(0,VOR) of non-starters — coarse, see F |
| §10 Positional-need impact is roster-specific | **PASS** | critical→adequate at RB for the specific roster; WR depth cost also surfaced |
| §11 Utility delta auditable | **PASS** | `roster_utility_delta` == documented weighted sum of components (exact) |
| §12 Acceptance classification (monotonic, all classes, boundaries) | **PASS** | monotonic across 15 deltas; all 6 classes reachable; epsilon-stable `>=` |
| §13 Acceptance floor independent per participant | **PASS** | C below floor ⇒ `all_teams_above_acceptance_floor=false` despite positive total |
| §14 Fairness vs rationality distinct | **PASS** | even / uneven-all-positive / one-loser distinguished by imbalance_index + rationality flags + viability |
| §15 Participant + transfer order invariance | **PASS** | every numeric result + `largest_beneficiary` + variance identical under permutation |
| §16 Trade direction | **PASS** | reversing the ownership operation changes the roster result |
| §17 Nonparticipant isolation + repeat eval | **PASS** | non-participant roster byte-identical before/after; 5× repeat eval identical |
| §18 Determinism | **PASS** | byte-identical `participants` across 5 runs |
| §19 Degraded states surfaced | **PASS** | missing starter projection ⇒ `starter_points_delta=null`, status UNRESOLVED, `STARTER_PROJECTION_UNAVAILABLE` + `TRADE_ANALYSIS_DEGRADED`; `PROJECTIONS_PARTIAL` propagated |
| §20 API contract | **PASS** | malformed JSON / missing participants / missing transfers / non-PLAYER asset all rejected with codes; `analyzeTrade` degrades to `CONTEXT_UNAVAILABLE` / `VALIDATION_FAILED` with no stack leak; response is versioned |
| §21 Versioning | **PASS** | `trade_version` in every response; bumped to `2026.2` for D1/D2 |
| §22 Regression (existing suites) | **PASS** | `pass 933 / fail 10` — the 10 are pre-existing network `live:` tests, identical to a clean checkout; `tsc` + `lint` clean |
| §23 Adversarial 3-team fixtures | **PASS** | win-win-win, hidden loser, bench illusion, consolidation, positional hole, order trap, duplicate-asset laundering — all covered |
| §24 Real Bloodline Bowl smoke test | **NOT TESTED** | this environment has no network path to the Sleeper provider (the entire pre-existing `live:` suite fails identically); `analyzeTrade`'s graceful-degradation path IS covered (§20). Run `POST /api/trades/analyze` against the deployed bridge to complete this. |

**Deterministic tests added/run:** 46 new (`trade-engine-audit`), 19 existing
(`trade-engine`), 65 total for the trade engine, all passing. Full repo suite:
933 pass / 10 pre-existing-live fail.

---

## E. Example audited outputs

### E1 — audited 2-team trade (Fixture A: marginal ≠ standalone)

X starts a 14-pt player at FLEX. X trades a 2-pt bench junk player for an
incoming 15-pt WR.

```
participants.X:
  before.optimal_starter_points  = <locked 8> + 14   (FLEX = X_flex 14)
  after.optimal_starter_points   = <locked 8> + 15   (FLEX = IN_wr 15)
  starter_points_delta           = +1.0        (NOT +15 — standalone value is irrelevant)
  starter_points_delta_status    = "RESOLVED"
  lineup_displacement            = { entered:["IN_wr"], left:["X_flex"],
                                     moved_to_bench:["X_flex"], bench_promotions:[] }
  roster_utility_components       = { starter_points: 1, starter_vor: ~1, bench_value: <=0, positional_need: ~0 }
  acceptance                     = "NEUTRAL"
```

### E2 — audited 3-team trade (complementary needs, all improve)

`A→C: A_rb4` · `C→B: C_te2` · `B→A: B_wr4` (no A↔B or A↔C-only leg).

```
trade_summary:
  all_teams_improve                 = true
  all_teams_above_acceptance_floor  = true
  largest_beneficiary               = "C"        (deterministic slug tie-break)
  largest_negative                  = null
  utility_gain_variance             = ~1.7
  utility_gain_spread               = ~3.2
  trade_viability                   = "HIGH"
  rationality.every_participant_rational = true
  fairness.imbalance_index          = 0.22       ("distributed relatively evenly")
participants: A ≈ +5.25, B ≈ +3.25, C ≈ +6.5
```

Change one team's hole depth → same structure, `imbalance_index` rises to ~0.53,
still `every_participant_rational: true`, still `HIGH` — a clear winner does not
make it "unfair".

### E3 — rejected malformed trade

```
POST /api/trades/analyze
{ "league":"bloodline-bowl", "participants":["supyo29","johndoe"],
  "transfers":[{ "from_manager_id":"supyo29", "to_manager_id":"johndoe",
                 "asset":{ "type":"PLAYER", "player_id":"<johndoe's player>" } }] }
->
HTTP 422
{ "status":"VALIDATION_FAILED",
  "trade_version":"ri-trade-foundation-2026.2",
  "validation":{ "ok":false, "failures":[
    { "code":"PLAYER_NOT_OWNED_BY_SENDER",
      "message":"Player \"…\" is not on supyo29's roster before the trade …",
      "subject":"…" } ] },
  "normalized":null, "participants":{}, "trade_summary":null }
```

Duplicate-asset laundering `A→B:X, B→C:X` → `DUPLICATE_TRANSFER` **and**
`PLAYER_NOT_OWNED_BY_SENDER` (B never owned X pre-trade — ownership is checked
against the frozen pre-trade state).

### E4 — adversarial fixture: hidden loser

3-way where C ships its **starting** TE (18) for a weak RB (8):

```
participants: A ≈ +6.75, B ≈ +9.25, C ≈ -4.75
trade_summary:
  rationality.every_participant_rational = false
  largest_negative                       = "C"
  all_teams_above_acceptance_floor        = false
  trade_viability                         = "NON_VIABLE"   (C below the reluctant band)
  fairness.imbalance_index                = 0.67
```

The engine identifies C as damaged even though the raw incoming/outgoing player
counts are balanced and the trade's total utility is strongly positive.

---

## F. Remaining limitations

**Phase 1 defects:** none outstanding — D1–D9 are fixed.

**Deliberate Phase 1 limitations (documented, not defects):**

1. **Bench/depth value is coarse.** `bench_value = Σ max(0, weekly VOR)` of
   non-starters. It does not model whether depth is *usable* (positional
   redundancy — a 5th WR still contributes), nor bye-week / injury coverage.
   Weight 0.25. Phase 2 depth modeling territory.
2. **Positional-need severity uses the shared model's thresholds.**
   `computePositionalNeeds`' "adequate" bar is the waiver replacement line, so a
   low-scoring-but-above-replacement starter (e.g. a 6-pt RB2 among 18-pt
   teammates) is "adequate", not "weak". This is the existing model, reused
   deliberately (§7 says don't reinvent). The trade engine faithfully surfaces
   whatever it reports and never substitutes a generic label.
3. **`analyzeTrade` performs two league-state reads** (its own snapshot + the one
   `buildWeeklyTeamContext` builds). `evaluateTrade` is unconditionally
   deterministic; `analyzeTrade` is deterministic *given a stable upstream
   snapshot*, with a `TRADE_ANALYSIS_DEGRADED` guard on mismatch. A single-read
   refactor (`assembleWeeklyContextFromSnapshot`) is a clean Phase 2 opener.
4. **Weekly horizon only.** All value is this-week projected points. No
   rest-of-season, schedule, or playoff-week weighting (explicitly out of scope).
5. **§24 real-data smoke test not run here** — no provider network in this
   environment. Structural degradation is covered; run once against the deployed
   bridge.

**Phase 2 opportunities (do NOT implement now):**

- Single-read context assembly (removes limitation 3).
- Rest-of-season value layer (weight ROS points into the composite for
  contender/rebuilder-agnostic "future value").
- Usable-depth model (positional redundancy, bye/injury coverage) to replace the
  coarse `bench_value`.
- A configurable "starter-need" severity lens specific to trades (steeper than
  the waiver replacement line) layered *on top of* the shared model, not
  replacing it.
- Trade-level "who should propose this" / counteroffer scaffolding — the
  per-participant `above_acceptance_floor` + `roster_utility_delta` are already
  the right primitives.

---

## Final freeze gate

Every gate item verified:

- N-party representation genuine ✓ · 2-team ✓ · 3-team ✓ · arbitrary routing ✓
- transactions atomic ✓ · duplicate-asset transfer impossible ✓ · ownership
  validation correct ✓ · pre-trade state immutable ✓
- every post-trade roster reconstructed correctly ✓ · optimal lineups
  independently recalculated ✓ · shared slot/eligibility logic reused ✓ ·
  starter deltas reflect displacement ✓
- VOR consistent with the existing model ✓ · bench/depth metric coherent (coarse
  but mathematically sound, limitation documented) ✓ · positional needs
  roster-specific ✓
- utility math auditable ✓ · acceptance thresholds configurable ✓ · acceptance
  monotonic ✓ · fairness and rationality distinct ✓ · no participant sacrificed
  for a positive total ✓
- participant-order invariant ✓ · transfer-order invariant ✓ · repeated analysis
  does not mutate league state ✓ · degraded states surfaced ✓ · API contract
  stable ✓ · output deterministic ✓ · existing Bloodline functionality passes
  regression ✓

```
PHASE 1 TRADE FOUNDATION AUDIT:
READY TO FREEZE
```

### Recommended Phase 2 focus (not implemented)

1. **Single-read context assembly** — refactor `buildWeeklyTeamContext` to expose
   `assembleWeeklyContextFromSnapshot(snapshot, manager)` so `analyzeTrade` uses
   exactly one league-state read. Smallest change, removes the only
   determinism caveat.
2. **Rest-of-season value layer** — the largest correctness gap for real trade
   advice (a weekly-only model undervalues buy-low / sell-high and schedule).
3. **Usable-depth model** — replace the coarse `bench_value` proxy.
