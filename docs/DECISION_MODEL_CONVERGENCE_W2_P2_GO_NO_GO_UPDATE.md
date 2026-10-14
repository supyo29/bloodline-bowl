# W2.P2 — updated GO / NO-GO FOR PRODUCTION SHADOW CAPTURE (post PR #42 merge)

Date 2026-10-13. Stack: `intelligence-convergence-w2-p1-role-opportunity` @ `86e8190` (PR #42 merged into it; **`main` untouched at `966b51e`**). Nothing deployed, no production migration, `ROLE_SHADOW_CAPTURE` unset, no production cron, **production was only read** (SELECT on catalogs, `list_migrations`, `get_advisors`).

## Verdict: **NO-GO today** (unchanged). W2.P2 code is ready; the blockers are outside it and now precisely known.

## 1. Production grants — read-only inspection (project `ijpfjdzmaztofawhwepf`)
| | result |
|---|---|
| The 8 older tables (`bridge_league_snapshots`, `bridge_transaction_ledger`, `bridge_capture_runs`, `bridge_published_snapshot`, `bridge_publication_audit`, `bridge_yahoo_connections`, `bridge_startsit_shadow_captures`, `bridge_startsit_shadow_outcomes`) | **`anon` AND `authenticated` hold SELECT/INSERT/UPDATE/DELETE (and, via the default ACL `arwdDxtm`, TRUNCATE/REFERENCES/TRIGGER/MAINTAIN)** — grants ARE present in production |
| RLS on those 8 | enabled on all 8, `FORCE` off, **0 policies** on every one |
| Roles | `anon`, `authenticated`: `rolbypassrls = false` → RLS with no policy is default-deny for every row operation through PostgREST |
| All 20 newer bridge tables (Phase 3.5+/projection/calibration/role/game) | RLS on, 0 policies, **no anon/authenticated privileges** (revoked) |
| Default ACL in `public` | still grants `arwdDxtm` to anon/authenticated/service_role on every NEW table (so every future migration must revoke explicitly — the W2.P2 and W1.R1 migrations do) |

**Assessment:** the rows are protected today, only by RLS-without-policies. This is defense-in-depth missing, not a live exposure: a future permissive policy, an `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, or any non-PostgREST path using TRUNCATE (RLS does not gate TRUNCATE) would expose them. Highest sensitivity: **`bridge_yahoo_connections` (OAuth tokens)**. Supabase advisors list these tables only as INFO `rls_enabled_no_policy`. Recommended (NOT applied): one additive migration `revoke all … from anon, authenticated` on the 8 tables, applied with its own authorization. Not a blocker for W2.P2 (its table already revokes). Advisors also show unrelated pre-existing items (6 SECURITY DEFINER views, 3 anon-executable SECURITY DEFINER functions, mutable search_path) — out of scope, not touched.

## 2. Production migration state vs the stack
Production has applied through `game_distribution` (20261004210113). **Missing in production: `20261008120000_projection_freshness_w1p4`, `20261009120000_w1r1_final_pregame_revisions`, `20261013180000_role_shadow_captures`.** Wave 1 therefore needs 6 new tables (`bridge_projection_source_{observations,observation_rows,latest,events}`, `bridge_final_pregame_{forecasts,revisions}`), 2 new columns on `bridge_projection_latest`, and replaces the `projection_artifact_kind` CHECK on the data-bearing `bridge_calibration_cases` (drop + re-add, guarded by `to_regclass`; additive-widening).

**Deploy-order test (local, schema reset to the pre-Wave-1 version, Wave 1 code run on real data):** the decision request still succeeds (forecasts served), and the capture failure is **visible** (`final_pregame_capture_failed … PGRST205` + context warning). Waiver endpoint stays fail-closed. So an out-of-order deploy degrades (no calibration evidence is captured) rather than breaks — but it silently loses irreplaceable pre-kickoff evidence, so **apply migrations before the code deploy**. Evidence: `docs/evidence/w2p2-local-staging-deploy-order.json`.

## 3. Wave 1 spot checks on real data (local Docker; real providers read-only) — 5/5 PASS
- **Waiver drop:** the real context is fail-closed (14/14 managers: pool UNAVAILABLE). With ONLY a synthetic pool grafted onto real rosters/forecasts: 14 real bye stars and 9 real injured stars on rosters, 12 real add/drop decisions, **0 recommended drops of a bye/injured star** for an 11-pt free agent.
- **Trade valuation:** real bye star priced `availability_delta = 0` (not a one-week zero charge); real OUT (non-bye) star priced finite from ROS availability (+1.47 availability delta, +1.14 permanent).
- Limits: the free-agent pool is synthetic (provider pool is uncertified); Yahoo leagues not exercised (no OAuth). Evidence: `docs/evidence/w2p2-local-staging-live4-waiver-trade.json`; script `scripts/staging-local/live4-waiver-trade-spot.ts`.

## 4. True wall-clock kickoff crossing — **SCHEDULED, NOT YET OBSERVED**
Real clock, nothing injected. TNF kickoff = **2026-10-16T00:15Z (Thu 2026-10-15 19:15 CDT)** (matches the stored data). Local DB seeded (48 TNF revisions, 456 Role-shadow decisions; repeat sample idempotent). One-shot scheduled tasks sample: Oct 14 12:00, Oct 15 12:00, 18:42 (T-33), 19:02 (T-13), 19:10 (T-5), 19:20 (T+5), 19:40 (T+25), then 20:15 final sample + `kickoff-boundary-verdict.ts` + commit/push of the evidence to branch `w2p2-kickoff-spotchecks` only. Verdict is PASS / FAIL / INCONCLUSIVE (INCONCLUSIVE if no PRE sample ≤30 min before and POST ≤60 min after). **Requires the Mac awake, the Claude app open and Docker (colima) running** — a missed sample makes the result INCONCLUSIVE, never a false PASS. Until it reports, "frozen revisions are immutable across the real kickoff" rests on the injected-clock evidence (541 revisions, post-kickoff byte-identical) plus DB triggers proven in stage 1.

## 5. What still blocks Wave 1 from `main`
1. **Production schema**: 2 Wave 1 migrations unapplied (above). Needs your authorization; order = migrations first, then code.
2. **Kickoff crossing** (item 4) not yet observed on the real clock.
3. **Not testable locally**: Yahoo leagues (OAuth), a real active-scoring window, and a certified free-agent pool (provider). Wave 1 hosted-staging checklist cannot be fully closed without hosted infra or those credentials.
4. **Review/merge decision**: 10+ unmerged stacked commits (W1.P1 → W2.P1 → W2.P2 → #42) land on `main` together; full-suite baseline has 83 pre-existing failures (identical 113 names on main and the stack tip) that should be triaged or accepted explicitly.
5. Not blockers: the grants hygiene on the 8 older tables (separate, optional migration); W2.P3 stays BLOCKED (G3 INSUFFICIENT_EVIDENCE).

## 6. Path to GO for production shadow capture
(a) kickoff verdict PASS; (b) you authorize landing Wave 1 + applying its 2 migrations; (c) you authorize the W2.P2 migration; (d) you authorize `ROLE_SHADOW_CAPTURE=1`; (e) you authorize cron `30 12 * * *`; then ≥6 weeks accumulation and ONE logged G3 DECISION look.
