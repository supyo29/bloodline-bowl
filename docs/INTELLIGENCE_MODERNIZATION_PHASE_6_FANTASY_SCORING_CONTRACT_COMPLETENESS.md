# Intelligence Modernization — Phase 6: Fantasy Scoring Contract Completeness

Branch `intelligence-modernization-phase6-scoring-contract` (from `main` @ `9f63275`). Written incrementally as the work proceeded. Not merged, not deployed.

## 1. Starting Git / production state
- 2026-09-21 17:01 UTC: local `main` = `origin/main` = `9f63275`; no commits since Phase 5 closeout, so no drift to reconcile.
- Production deployment `dpl_B6Ug24tw1j3E4Y2GcfexS9phSBMJ` @ `9f63275`, READY.
- Production six-surface baseline (interim, live state drifts — the authoritative comparison is an interleaved base-vs-branch run, §25): `bloodline-bowl/supyo29` lineup `43a455e8a754`, start_sit `6123db977eb9`, waivers `e1bc7d1f993e`, matchup `bceafa999db1`, leverage `0529c3441da4`, positional_needs `8274e4deb6b8`. (Two pairs' `matchup` hashes changed between 09:xx and 17:xx UTC with no deployment — live NFL data drift, which is why a same-time comparison is required.)
- Phase 5 prospective captures (291 rows, scoring fingerprints `scoring:v1:29acc6bc…`, `scoring:v1:d4795fa7…`) are immutable evidence and are not touched.

## 2. Current architecture map (audited, not assumed)
| # | Location | Role | Uses `calculateFantasyPoints`? |
|---|---|---|---|
| 1 | `lib/scoring/calculate.ts` | the ONLY arithmetic engine: Σ (stat present × league multiplier). Knows nothing about position, thresholds or tiers | is it |
| 2 | `lib/weekly/scoring.ts` `scoreWeeklyLine` | weekly wrapper (drops ADP/rank keys), used by weekly projections and Waiver 2.0 `ppo` | yes |
| 3 | `lib/projections/league.ts` | season/ROS/draft path: `statLineFromProjection` → engine; owns its own D/ST tier approximation and K distance split | yes |
| 4 | `lib/projections/special-teams.ts` | season K/DEF lines → engine; hardcoded `pts_allow ?? -0.3` default (line 439) | yes |
| 5 | `lib/analytics/historical-scoring.ts`, `weekly-stats.ts` | completed games: Sleeper matchup points (authoritative) else engine on Sleeper raw stats | yes |
| 6 | `lib/scoring/archetypes.ts`, `sensitivity.ts`, `app/api/scoring/calculate` | illustrative / caller-supplied lines | yes |
| 7 | `lib/canonical/scoring-fingerprint.ts` | the one authoritative scoring identity (`scoring:v1:<24hex>`) | n/a |
| 8 | `lib/analytics/historical-scoring.ts#hashScoringSettings` | legacy 32-bit hash, retained for season-model cache keys only | n/a |
Consumers that only read league-scored points (no scoring math): lineup, Start/Sit, matchup, leverage, positional needs, replacement/VOR, trades (season league points + VOR).
Provider `pts_std/pts_ppr/pts_half_ppr` are read only by: the K/DEF weekly fallback (`sleeper-weekly.ts`), the K/DEF ROS fallback, and backtests. Offense never uses them.

## 3. Key architectural fact
`calculateFantasyPoints` multiplies only keys **present** in the stat line. A key in the league's settings, the catalog, or a label table therefore has **no effect** unless something materializes that key. Position bonuses, thresholds, tiers and return yards are all "must be materialized" rules. Phase 6 classifies each by *who materializes it*.

## 4. Duplicate / scattered scoring-logic audit
- **Intentional single arithmetic authority**: all 8 call sites route through `calculateFantasyPoints`. No second multiplier exists (good).
- **Scattered event materialization (drift risk)**: (a) season path approximates D/ST tiers with a normal(σ=7) spread; (b) season path splits K 0-39 FGs 8/42/50% across distance keys; (c) season path drops position bonuses entirely (never emits `bonus_rec_te/rb/wr`); (d) Waiver 2.0 `ppo` prices a position-agnostic "target" and "carry"; (e) weekly enrichment adds `kr_yd` without regard to the provider's own return key. There is **no single owner** of derived scoring events. Phase 6 introduces one (`lib/scoring/derived-events.ts`) and routes the paths above through it.
- Hardcoded assumptions found: `pts_allow ?? -0.3` (special-teams.ts:439); K FG distance split constants (league.ts).

## 5. Provider evidence (live payload inspection, 2026-09-21)
**Weekly projection feed** (`api.sleeper.app/projections/nfl/2026/2`, 3,305 rows) — keys actually present:
- QB: pass_yd/td/int/att/cmp/inc/2pt, pass_sack, pass_cmp_40p, rush_*, fum, fum_lost, `bonus_rush_td_qb`.
- RB/WR/TE: rec, rec_yd, rec_td, rec_tgt, rec_2pt, rec_fd, rec_0_4…rec_40p (target-depth buckets), rush_*, and **`bonus_rec_rb` / `bonus_rec_wr` / `bonus_rec_te` (= rec, exact: 97/98 TE rows equal rec)**. So position reception bonuses **are provider-materialized in weekly projections**.
- RB/WR: **individual kick-return yards are published under `def_kr_yd` (107 offensive rows, e.g. WR Turpin 91.4) plus `def_kr_td`**; punt returns under `pr_yd`/`pr`/`pr_td`. `kr_yd` itself is absent.
- **No threshold-bonus keys** (`bonus_*_yd_*`) and no `*_td_40p/50p` in the projection feed (they exist only in actuals).
- K: fgm, fgm_0_19…fgm_40_49, xpm, xpmiss, fgmiss_30_39/40_49, fga, fgm_yds. Internally inconsistent (Dicker: fgm 2.08 vs distance buckets summing 1.42; fgm_yds/fgm = 27 yd avg). No 50+ bucket, no flat `fgmiss`.
- DEF: sack, int, fum_rec, ff, safe, blk_kick, def_td, tkl_loss, pts_allow (expected 16.5), `yds_allow`, and tier keys that are **plug-in point estimates** (`pts_allow_14_20: 1.0` from a projected 16.5; `yds_allow_300_349: 1.0`). Absent from the feed: sack_yd, int_ret_yd, fum_ret_yd, def_4_and_stop, def_forced_punts, st_ff/st_fum_rec.
**Actuals feed** (`stats/nfl/2025/{6,10,14}`, 1,911 rows) — platform semantics:
- Threshold flags are inclusive (`>=`): rec_yd 99 → no flag, 100 → flag=1. pass 300 ✓, rush 100/200 ✓, rec 100/200 ✓ (one provider anomaly: 1 of 342 rush rows, a 244-yd game, lacked `bonus_rush_yd_100`).
- `bonus_rec_te/wr/rb` == `rec` exactly, and only on that position.
- `bonus_rush_rec_yd_100` = 1 iff rush_yd+rec_yd ≥ 100 and overlaps (stacks with) the single-stat 100 flags.
- Individual returners use `kr_yd`/`pr_yd` in actuals (not `def_kr_yd`).

## 6. Live league scoring contracts (Sleeper; Yahoo leagues are AWAITING_CREDENTIALS)
Non-zero keys in any live league: 55. No live league uses TE premium, threshold bonuses, `*_td_40p/50p`, completions/attempts, or IDP. Live differences that matter: rec 0.5 (bloodline) vs 1.0 (devoted, sportys); pass_int −2 vs −1; fum_rec/int/blk_kick 1 vs 2; Bloodline scores kr_yd, pr_yd, `def_kr_yd`, `def_pr_yd`, `sack_yd`, `int_ret_yd`, `fum_ret_yd`, `fg_ret_yd`, `blk_kick_ret_yd` at 0.04, `pts_allow` linear −0.3, flat FG 3, def_4_and_stop 1, def_forced_punts 1; devoted/sportys use distance-tiered FG (3/3/3/4/5/6), points-allowed tiers (10/7/4/1/0/−1/−4).

## 7. Defects and gaps identified at Checkpoint A (to be fixed / classified in later checkpoints)
1. **D-1 Return-yard namespace / double count (weekly, offense).** Provider publishes individual kick-return yards as `def_kr_yd`; enrichment assumes `kr_yd` is absent and adds season-model `kr_yd`. A league scoring both keys (Bloodline Bowl) prices the same returns twice; a league scoring `kr_yd` only ignores the provider number; a league scoring `def_kr_yd` only (team-defense rule) would credit offensive players.
2. **D-2 Position reception bonuses missing (season/draft path).** `statLineFromProjection` never emits `bonus_rec_te/rb/wr`; season projections, VOR and trade inputs ignore TE premium.
3. **D-3 Waiver 2.0 `ppo` is position-agnostic** (Phase 4 deferral): a TE target and a WR target are priced identically, so TE premium cannot reach role/OPP waiver value.
4. **D-4 Weekly path silently omits league-scored keys the provider does not supply** (threshold bonuses etc.); only the season path warns.
5. **G-1 K/DEF weekly = `pts_std` (league-agnostic)**: all three live leagues. Provider components are partial and inconsistent → classified PROVIDER_LIMITED, exposed (see K/DST section).
6. **G-2 Return role → waiver value** not translated (no yield evidence) → DECISION_LAYER_MISSING with reason.

**Resolution:** D-1 fixed (return-yard namespace/double count) · D-2 fixed (TE/RB/WR premium in season/draft/trade path) · D-3 fixed (position-aware Waiver 2.0 opportunity pricing) · D-4 fixed (silent omission → info warning) · G-1 bounded, measured and exposed (not reconstructed: provider data untrustworthy) · G-2 classified DECISION_LAYER_MISSING with reason (no return-yield evidence).

## 8. Scoring support matrix
Artifacts: `docs/scoring-support-matrix.json` (machine-readable, regenerated by `npx tsx scripts/scoring-support-matrix.ts`, freshness enforced by test) built from `lib/scoring/support-contract.ts`, which classifies each rule from a dated snapshot of REAL provider payloads (`lib/scoring/data/observed-provider-keys.json`) — never from the catalog. Universe: catalog ∪ Sleeper's scoring vocabulary = **147 rules**. Provider stat fields that are not rules (`gp`, snaps, rates, longs) are excluded so they cannot be mislabeled "catalog only".

| Final class | Count | Meaning here |
|---|---|---|
| FULLY_PROPAGATED | 21 | pass yd/td/int/att/cmp/inc/2pt, rush yd/att/td/2pt, rec/rec_yd/rec_td/rec_tgt/rec_2pt, fum, fum_lost, `bonus_rec_te/rb/wr` |
| DECISION_LAYER_MISSING | 15 | provider supplies it weekly but a Bloodline layer omits it: `pass_sack`, `pass_int_td`, `pass_fd`/`rush_fd`/`rec_fd`, `pass_cmp_40p`, `rush_40p`, `rec_0_4…rec_40p`, `bonus_rush_td_qb` (season/draft/trade layer), and `kr_yd`/`pr_yd` (Waiver role pricing) |
| NONLINEAR_PROJECTION_UNRESOLVED | 10 | all 100/200-yd, 300/400 pass-yd, cmp-25, rush-att-20 bonuses: exact on completed games only |
| PROVIDER_LIMITED | 72 | all K and team-D/ST rules (weekly = Sleeper standard points, league-agnostic) + distance-TD bonuses (no play-level distance in any projection feed) |
| EXACT_HISTORICAL_ONLY | 6 | `bonus_fd_*`, `pass_rz_att`, `rush_rz_att` |
| UNSUPPORTED | 23 | IDP and unrecognized keys |
| PROJECTION_APPROXIMATION / CATALOG_ONLY | 0 / 0 | season D/ST-tier and K-distance approximations are recorded per rule in the `season_projection: APPROXIMATED` layer and in `leagueScoringContract().approximations`; the weekly K/D-ST fallback (a weaker link) dominates the final class |
Every rule has per-layer columns (weekly / season / completed-game / waiver-role), linearity, position and whole-game requirements, per-consumer propagation (lineup, Start/Sit, matchup, leverage, positional needs, trade, waiver), exact-vs-approximate flag, and the limitation text.

## 9. Historical-scoring findings
Two sources (`lib/analytics/historical-scoring.ts`): Sleeper's own matchup points for rostered players (authoritative, all rules baked in) else `calculateFantasyPoints` on Sleeper raw stats for unrostered players. The engine is the same one used everywhere, so calculator/historical/projection **do not diverge** in arithmetic. Sleeper actuals natively carry position bonuses, threshold flags, kr/pr yards and K/D-ST events, so exactness holds wherever the provider publishes the event. `deriveCompletedGameThresholdEvents` (exact, inclusive `>=`, stacking) exists for sources that lack the flags but is deliberately **not** wired into the Sleeper path: Sleeper's award is authoritative, and one live provider anomaly (a 244-yd rusher without `bonus_rush_yd_100`) shows the provider's award — not the yardage — is what league scoring applied. Historical rows carry the legacy `scoring_settings_hash` (scoped, unchanged); the canonical fingerprint is associated at the league level (`leagueScoringContext` exposes both). No historical code changed.

## 10. Weekly-projection findings
Offense (QB/RB/WR/TE): provider component stats × league `raw_scoring` via `scoreWeeklyLine` → `calculateFantasyPoints`; `pts_*` totals are never used (test: `pts_ppr:99` ignored). New: `materializeScoringEvents` runs first (provider-first). Provider supply proven from real payloads (§5). League-scored offense rules the provider does not supply are now announced (D-4) by an info-level batch warning `league_scores_keys_provider_does_not_supply` (never changes status; no live league triggers it).

## 11. Nonlinear-scoring treatment
No probabilistic treatment was built: no calibrated per-player yardage distribution exists and inventing one would be a modeling change. Threshold bonuses are exact on completed games and **NONLINEAR_PROJECTION_UNRESOLVED** for projections; a projected 101-yd mean earns no bonus (test). The provider's D/ST tier keys are plug-in point estimates (1.0 on the tier of the projected mean) — a plug-in approximation, disclosed as such; the season model spreads a mean over tiers with a fixed normal(σ=7) (also disclosed). Platform semantics verified against real actuals: inclusive `>=`, binary flags, stacking tiers, combined rush+rec 100 overlaps the single-stat flags.

## 12. Position-specific scoring
Provider-native in the weekly feed (`bonus_rec_te|rb|wr == rec`). One authoritative derivation point: `materializeScoringEvents` — derives the key **only** when the provider omitted it (provider-first ⇒ exactly once), only for the matching position. Wired into: weekly provider (incl. ROS season-feed scoring), season/draft/trade path (D-2), Waiver 2.0 (D-3). Limitation: `pprModeOf` (trade market-format classifier, `lib/trades/competitive/evaluate.ts`) reads only `rec`, so a TE-premium league is classified by its base reception value; not changed (trade-engine ownership boundary).

## 13. Return scoring
Re-certified, not rebuilt. **Defect D-1 found and fixed:** the provider publishes an offensive returner's kick-return yards under the team-defense key `def_kr_yd` (107 rows, e.g. Turpin 91.4/game); enrichment assumed `kr_yd` was absent, so a league scoring both keys (Bloodline Bowl) priced the same yards twice, a `kr_yd`-only league ignored the provider number, and a `def_kr_yd`-only league would credit individuals. Fix: individual lines never carry team-defense return keys; the provider value is renamed to `kr_yd` before enrichment (provider-first; enrichment fires only when genuinely absent). Live effect in Bloodline Bowl: 67 returners (34 WR, 33 RB) −≈1.2–1.3 pts (§25). **Role → value:** classified DECISION_LAYER_MISSING — Role Intelligence carries return *role shares* (`kick_return_role`, `punt_return_role`) but no return-yield evidence exists and Waiver `yield_per_opportunity` has no return dimension; no yards-per-return is assumed. Role evidence stays descriptive.

## 14. K / D-ST (the real contract)
Weekly K/DEF values are Sleeper's **standard** precomputed points (league-agnostic). Phase 6 did not reconstruct them: provider K components are partial and internally inconsistent (fgm 2.08 vs distance buckets 1.42; no 50+ bucket; no flat `fgmiss`), D/ST is missing `sack_yd`, `int_ret_yd`, `def_4_and_stop`, `def_forced_punts`, etc., and tier keys are plug-ins. Instead the limitation is **bounded, measured and exposed** (`scripts/scoring-kdst-materiality.ts`, 2026 wk 2 feed, keyed by canonical fingerprint): applying the league's scoring to the supplied components vs the standard-points fallback —
| League (fingerprint) | D/ST mean \|Δ\| / rank-corr | K mean \|Δ\| / rank-corr | Verdict |
|---|---|---|---|
| devoted-to-the-game & sportys-alumni (`d4795fa7…`, standard-equivalent) | 0.02 / 0.999 | 0.02 / 0.997 | fallback ≈ league scoring (immaterial) |
| bloodline-bowl (`29acc6bc…`) | 1.54 / 0.839 | 1.23 / 0.739 | **material** (flat FG, linear pts-allowed, ret-yard rules) |
The Book-Ready `contract.weekly_basis.k_dst` block states this per league (and "not measured" for unmeasured fingerprints). Season/draft K/DEF use the league-specific season special-teams model. Alternative for a future phase: source weekly K/D-ST from that model (loses opponent adjustment) — not done here.

## 15. IDP
UNSUPPORTED (23 keys). No IDP positions, projection rows, roster slots, or feed requests exist (weekly feed requests QB/RB/WR/TE/K/DEF only); live leagues have IDP keys only at 0. Exact limitation on each block.

## 16. Waiver propagation (D-3)
Path: league `raw_scoring` → `buildWaiverContext.ppoFor(position)` (`materializeScoringEvents` → `scoreWeeklyLine`) → Role delta (`assessRole`), OPP conditional (`oppPointsFor`), expected-vs-realized → asset value → drop cost/net action value. Proof (test): same role growth, TE vs WR — TE role_delta rises only under TE premium by share-delta × volume × 0.5 × 0.66 rec/target; WR unchanged; without the rule TE == WR; fingerprints differ. Weekly level/replacement/starter-baseline flow through weekly projected points (component-rescored for offense). Return-role shifts are not priced (§13); K/DST waiver values inherit the §14 limitation.

## 17. Trade propagation
Trade inputs are season projection points (`translateStatsToLeague`, D-2 fix) and ROS points (weekly provider ROS scoring, now materialized). Proofs (tests): identical season line → TE-premium league differs by exactly 0.5 × receptions (WR unchanged); ROS for the same TE differs by 0.5 × receptions × weeks-left. No premium is hard-coded; `evaluateTrade` was not touched. Proven at the input layer, not through a full `evaluateTrade` run; `pprModeOf` limitation in §12.

## 18. Other consumers
Lineup, Start/Sit, matchup, leverage, positional needs consume weekly projected points and read the fingerprint from canonical lineage; none reimplements scoring (import audit: only 8 sites call the calculator, all through it). They inherit every change and limitation of the projected points (e.g. Bloodline returners, K/DEF fallback). Kicker/DEF slots inherit §14.

## 19. Scoring-fingerprint integrity
Adversarial tests: order-independent; explicit 0 ≡ absent; serialization noise collapses; a change to `bonus_rec_te`, `kr_yd`, `pts_allow_14_20`, `idp_tkl`, `bonus_rec_yd_100`, `rec`, `bonus_rec_wr` each changes it; all 11 synthetic fixtures are pairwise distinct; Yahoo-style numeric ids get their own identity. One authoritative general hash retained; the legacy `hashScoringSettings` remains scoped to season-model cache keys. Non-scoring settings are not hashed (the function takes only scoring).

## 20. Book-Ready
New topic `scoring.league_contract` on the existing query layer (surface `league-scoring-contract`, one registry entry, one unit pair). Blocks: `contract.scoring_fingerprint` (class counts), `contract.weekly_basis.offense`, `contract.weekly_basis.k_dst` (+ measured bound), and one `rule.<key>` block per active rule with value (league multiplier), classification, exact-vs-approximate, family, linearity, per-layer support, and the limitation. All blocks validate; lineage = scoring fingerprint; DESCRIPTIVE_ONLY; may_influence_production=false. A limited rule is never shown as modeled.

## 21. Analysis Book
No chapter id added or renamed (99 unchanged). `scoring.league_contract` registered as a topic and attached as an **enrichment** (never required) to `decision.replacement_value`, `decision.roster_fit`, `decision.market_value`, `trade.player_value`. No chapter state changed (enrichment cannot promote/demote); no chapter was promoted because the catalog contains a rule.

## 22. Adversarial examples (test/scoring-contract-adversarial.test.ts)
No-PPR / half / full PPR (differences exactly rec×step), TE premium (TE-only), unusual QB (6-pt TD, −3 INT, cmp/inc/sack), return-heavy, yardage-bonus (99/100/101, 299/300/400, stacking), tiered D/ST (same line, two tier systems), flat vs distance FG, IDP (UNSUPPORTED), Yahoo numeric ids (unrecognized), negative and zero lines (real zero → `projected`, 0), idempotent materialization, `pts_*` never combined with components, K/D-ST fallback never summed with league event scoring, no phantom distance-TD events.

## 23. Live-league examples (real, 2026-09-21)
Same provider line, different league: rec 0.5 (bloodline) vs 1.0 (devoted, sportys); pass_int −2 vs −1; fum_rec/int/blk 1 vs 2; return yards scored only in bloodline (0.04 kr/pr/def_kr/def_pr/sack/int/fum/fg/blk-return yards); flat FG 3 (bloodline) vs 3/3/3/4/5/6 distance tiers (devoted, sportys); D/ST linear −0.3/pt (bloodline) vs 10/7/4/1/0/−1/−4 tiers (devoted, sportys). No live league uses TE premium, thresholds, or IDP (portable rules are covered by synthetic fixtures). Real example: WR Turpin (DAL) provider `def_kr_yd` 91.4 → Bloodline base 8.48 pts vs Phase 6 7.26 (−1.22 = the removed double count).

## 24. Performance (µs per op, this machine, warm)
calculateFantasyPoints 1.1 · scoreWeeklyLine 1.8 · materialize+score 3.3 (+1.5) · full 3,305-row feed 10.7 ms · fingerprint of a 132-key map 24.5 · `leagueScoringContract` 104 (once/request) · Book-Ready contract evidence 195 (once/request). `ppoFor` caches per position; materialization allocates only when an event applies; no provider calls inside scoring loops.

## 25. Production-isolation / expected-difference analysis (interleaved base `9f63275` worktree vs branch, live Sleeper, week 2, 2 rounds, 3 pairs; both sides self-stable)
| Pair | Result | Attribution |
|---|---|---|
| devoted-to-the-game / darthmarker | **all 6 sections identical** in both rounds | contract unchanged for that league |
| bloodline-bowl / supyo29 | lineup, start_sit, matchup, leverage, positional_needs differ; **waivers identical**; lineup total 113.73 → 112.64 | FLEX Deebo Samuel −1.09 (same players chosen) — D-1 double count removed; downstream sections follow the point change |
| bloodline-bowl / bijimac | lineup, matchup, positional_needs differ; start_sit, leverage, waivers identical; total 111.59 → 110.69 | Hubbard −0.26, Tuten −0.64 (= −0.90) |
League-wide (Bloodline): 67 of 3,305 projections changed — 34 WR + 33 RB — every one negative (≈ −1.2…−1.3), every one carrying the kick-return enrichment warning, none other. Acceptance criteria: (1) previously incorrectly propagated rule ✔ (return yards, double count), (2) mathematically attributable ✔ (= 0.04 × enrichment `kr_yd`), (3) limited to leagues/players the rule applies to ✔ (returners in the league scoring `kr_yd`+`def_kr_yd`; unaffected league identical), (4) fingerprint carried unchanged ✔, (5) tested ✔, (6) no unrelated drift ✔ (both trees ran against the same live state). No other numeric change; TE-premium/threshold/K-DST paths change nothing in any live league.

## 26. Tests
Phase 6 adds 51 tests (30 scoring-contract, 8 Book-Ready, 13 adversarial): calculator, derived events, threshold boundaries, position rules, return scoring, negative/zero, fingerprints, provider normalization, weekly provider scoring, historical semantics, waiver and trade/ROS propagation, no-double-counting, provider-limited behavior, Book-Ready evidence, Analysis Book invariants, matrix freshness. Full suite, `tsc --noEmit`, and eslint on changed files: see the report/§32. No frozen or certified test was weakened or edited; no R/historical-scoring code was touched.

## 27. Phase 5 prospective-capture interaction
The scoring fingerprint function and its identity are unchanged, so Matchup2 capture identity is unbroken; the 291 existing captures are immutable and untouched. Future Bloodline captures naturally carry post-fix baselines (returner baseline points are lower) under the same fingerprint; the gate dedupes per (player, week, fingerprint) so an earlier pre-fix capture of a player-week remains the counted decision — a documented mixing of baseline vintages within one fingerprint that is inherent to correcting a scoring defect (no historical rewriting).

## 28. Sleeper cache warning
Payloads of 2.8–4.1 MB exceed Next's 2 MB data-cache limit → warning + refetch; data is delivered intact (full 3,305-row payloads parse and score; the Phase 5 cron wrote correct rows during the warnings). Recorded as technical debt, not fixed.

## 29. Limitations
- Weekly K/D-ST is Sleeper standard points (bounded/measured, §14): material for Bloodline Bowl.
- Threshold/tier bonuses are not projected (NONLINEAR_PROJECTION_UNRESOLVED); provider D/ST tiers are plug-in estimates; season D/ST tier spread is a fixed-σ approximation.
- Provider-supplied but unmaterialized downstream (DECISION_LAYER_MISSING): sacks-taken, first downs, 40+/target-depth counts in the season/trade layer; return-role value in Waiver.
- IDP unsupported. Yahoo scoring ingestion does not exist (OAuth/discovery only); Yahoo numeric stat ids are unrecognized, never mapped by label.
- Provider-key snapshot is dated 2026-09-21 (weekly projection wk 2; actuals 2025 wk 6/10/14 + 2026 wk 1); re-capture if the feed schema changes. One provider anomaly observed (missing 100-yd flag).
- `pprModeOf` ignores position premiums (market-format classifier).
- Historical rows carry only the legacy scoping hash, not the canonical fingerprint.
- Scoring completeness is a correctness statement, not a prediction improvement.

## 30. Future dependencies
Outcome ingestion for Phase 5 captures (still no scheduled process; explicitly not Phase 6); K/D-ST weekly source decision; a calibrated per-player yardage/points-allowed distribution to price thresholds; Yahoo stat-id → canonical mapping; return-yield evidence for Waiver role pricing; sacks/first-downs in the season layer; canonical fingerprint on historical rows; Phase 7 (temporal identity) and later phases untouched.

## 31. Certification gates
| # | Gate | Result |
|---|---|---|
| 1 | Catalog integrity — every known rule has an explicit state | ✔ 147/147 (matrix + freshness test); unknown key ⇒ UNSUPPORTED |
| 2 | Canonical identity — every meaningful change alters the fingerprint | ✔ adversarial tests (position, return, tier, IDP, threshold) |
| 3 | Arithmetic — supported events scored exactly once | ✔ single calculator; provider-first derivation; idempotence + double-count tests |
| 4 | Historical — exact wherever the source permits | ✔ exact where the provider publishes the event; nothing changed; provider anomaly documented |
| 5 | Projection honesty — exact vs approximate vs provider-limited | ✔ explicit per rule and per block; no threshold value invented |
| 6 | Position specificity | ✔ TE/RB/WR premiums only for their position (tests) |
| 7 | Return scoring — reaches value without double counting | ✔ projections/season (D-1 fixed, live-attributed); ✘→classified: Waiver role→value DECISION_LAYER_MISSING (no yield evidence) |
| 8 | K/DST honesty | ✔ league-agnostic fallback exposed per league with a measured bound |
| 9 | IDP honesty | ✔ UNSUPPORTED (23 keys) with exact reason |
| 10 | Waiver propagation | ✔ proven for position-specific pricing; K/DST + return-role limits stated |
| 11 | Trade propagation | ✔ at the input layer (season + ROS); full `evaluateTrade` not exercised; `pprModeOf` limitation stated |
| 12 | Other consumers | ✔ consume projected points; no scoring reimplemented |
| 13 | Book-Ready | ✔ `scoring.league_contract`; Analysis Book enrichment only |
| 14 | No double counting | ✔ adversarial regression tests |
| 15 | Production safety | ✔ every behavioral difference attributed to D-1; unchanged-contract league identical |

## 32. Verdict
**CERTIFIED WITH DOCUMENTED LIMITATIONS.** Material scoring rules are not silently wrong: every unsupported, provider-limited, unresolved-nonlinear or unpriced rule is classified, exposed on the Book-Ready block, and (for K/D-ST) bounded by measurement. The limitations in §29 stem from provider data that is not trustworthy enough to reconstruct, or from an absent calibrated distribution / return-yield evidence — none can be resolved without fabricating football data. Tests: full suite 2,483 total / 2,479 pass / 0 fail / 4 skipped (baseline 2,432; +51 Phase 6); `tsc --noEmit` clean; eslint clean on all changed files (the remaining repo warnings pre-date Phase 6). Not merged, not deployed. Phase 7: NOT STARTED.
