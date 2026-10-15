# W2.P1 — Role & Opportunity: offline qualification pre-registration

Branch `intelligence-convergence-w2-p1-role-opportunity`, base `57a6606` (W1.R2). **Offline qualification only**: nothing here changes a production number, and the strongest verdict this phase can reach is *OFFLINE CERTIFIED — PROMOTION CANDIDATE, LIVE/STAGING GATE PENDING*. The machine-readable protocol is `scripts/w2p1/prereg.json`; its SHA-256 is recorded in `FROZEN.json` and the `final` stage refuses to run if it changed. This document was committed **before** any VAL or FINAL row was scored.

## 1. What the Role system is today (read from code)

```
nflverse pbp + snap_counts  --(R: analysis/player_role)-->  observed_role_game.csv   (OUTCOME side only for any target game)
        |                                                         |
        +--(R: build_role_profile at a synthetic NA target-week row)--> role_profile_asof.csv  (EWMA half-life 2 games, prior season by recency)
injury_reports.csv (final team-week designation)   depth_chart_snapshots.csv (timestamped, 2026 only)
        |
lib/role-calibration/forecast.ts buildRoleForecast  -> RoleForecast {metrics, volumes, opportunity (shares x EWMA team volume), p_absent, depth, teammate_pressure, confidence}
        |
lib/role-calibration/xfp.ts  opportunity -> expected stat line (prior-season position yields) -> xFP under a league scoring
        |
lib/role-calibration/shadow.ts  candidate = baseline + clamp(0.3 * conf_weight * ((1 - p_absent) * xFP - baseline), +/- max(1, 25% baseline))   [SHADOW_ONLY]
        |
lib/weekly/forecast/adapters.ts roleSignalFromShadowCandidate (structural, no import)  -> forecast.role / ledger line ROLE_CALIBRATION [mode SHADOW]
```
- **Production status:** `lib/weekly/forecast/validate.ts` rejects `role` in PRODUCTION mode and any non-base/non-injury PRODUCTION contribution; production code must not import `lib/role-calibration` (pinned by `test/role-calibration.test.ts`). **Nothing in production supplies `shadow.role` today** (`lib/weekly/context.ts` has no shadow wiring), so no Role value is captured in final-pregame records at present.
- **Point-in-time:** profiles are evaluated at a synthetic NA row (only strictly earlier games); volumes use games strictly before the target week; `assertPointInTime` checks input-game ordering; the injury designation is the *final* team-week designation (no publication timestamp exists: evidence quality RECONSTRUCTED_FINAL_DESIGNATION); depth charts exist only from 2026-08-25, so **no 2025 depth feature is used**; 2026 route participation is unpublished (prior-season evidence only).
- **Known overlap with Wave 1 (the double-count to remove):** the existing shadow multiplies xFP by `(1 - p_absent)` *and* is applied on a baseline that W1 already injury-adjusted, so availability would be discounted twice. W2.P1's challenger works on the conditional-on-active value and lets the production injury model apply availability exactly once.
- **Prior real-source evidence:** `docs/PROJECTION_CALIBRATION_PHASE2_CERTIFICATION.md` (2026 week 3, n=769, real source baseline): C1 ΔMAE −0.006, helped 41.3% / hurt 42.5%; no kappa helped. That is the only real-source datapoint in the repo.

## 2. What cannot be measured offline (stated up front)
1. **No history of the real Sleeper/RotoWire source projection exists in the repo.** The baseline is the W1.P2 proxy B0p (mean of the previous ≤ 4 games), and the champion B1p applies the production Wave 1 injury model to it. A proxy knows less about role than a real source, so **any Role gain over B1p is an upper bound** on the gain over the real Wave 1 canonical forecast. Incremental value over the real source (gate G3) is *pending live data*.
2. **No completed 2026 week has both a stat line and an as-of Role profile** in the repo, so true 2026 out-of-time evaluation is not possible; the out-of-time split is inside the 2025 season (weeks 14–17), after fitting on weeks 3–9 and choosing hyperparameters on weeks 10–13.
3. The committed yield table is 2025 (same season): C1's xFP has mild leakage that favors C1.

## 3. Splits, populations, candidates, thresholds
See `prereg.json` (authoritative). Summary: DEV weeks 3–9 (fit), VAL 10–13 (choose among a 4-point ridge grid), FINAL 14–17 (one look). Positions QB/RB/WR/TE; K/DST not applicable. Champion B1p; control C0 (Role-free shrinkage, added after DEV inspection and before VAL/FINAL because the DEV coefficient on the baseline was large and negative — i.e. the proxy baseline simply over-predicts and needs no Role information to be corrected); challenger C2 (per-position ridge on point-in-time Role opportunity features, shrunk by the existing confidence weight and the existing cap, applied *before* the production injury model). Promotion thresholds T1–T10 incl. T2b (C2 must beat C0, the Role-specific increment) are fixed in `prereg.json`.
