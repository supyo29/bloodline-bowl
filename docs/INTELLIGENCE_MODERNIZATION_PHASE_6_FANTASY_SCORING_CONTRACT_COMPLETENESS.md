# Intelligence Modernization — Phase 6: Fantasy Scoring Contract Completeness

Branch `intelligence-modernization-phase6-scoring-contract` (from `main` @ `9f63275`). Written incrementally; sections marked *(pending)* are filled at their checkpoint. Not merged, not deployed.

## 1. Starting Git / production state
- 2026-09-21 17:01 UTC: local `main` = `origin/main` = `9f63275`; no commits since Phase 5 closeout, so no drift to reconcile.
- Production deployment `dpl_B6Ug24tw1j3E4Y2GcfexS9phSBMJ` @ `9f63275`, READY.
- Production six-surface baseline (interim, live state drifts — the authoritative comparison is an interleaved base-vs-branch run, §22): `bloodline-bowl/supyo29` lineup `43a455e8a754`, start_sit `6123db977eb9`, waivers `e1bc7d1f993e`, matchup `bceafa999db1`, leverage `0529c3441da4`, positional_needs `8274e4deb6b8`. (Two pairs' `matchup` hashes changed between 09:xx and 17:xx UTC with no deployment — live NFL data drift, which is why a same-time comparison is required.)
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

*(Sections 8–26: support matrix, historical, weekly, nonlinear, position-specific, return, K/DST, IDP, waiver/trade/other propagation, fingerprints, Book-Ready, Analysis Book, adversarial, live-league, performance, isolation, tests, limitations, future dependencies, verdict — pending, filled at their checkpoints.)*
