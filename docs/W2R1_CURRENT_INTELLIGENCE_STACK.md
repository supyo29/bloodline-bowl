# W2.R1 — the Current Bloodline Intelligence Stack

**Policy (2026-10-14):** W2.R1 is no longer a deployment-level `SHADOW_ONLY` layer. The main Bloodline Bowl service and its MCP serve the newest intelligence stack so that real-world league analysis always exercises it. **Scientific qualification is per-component metadata (confidence and explanation), never a deployment gate.** Deployment is not retroactive qualification: the research record below is preserved exactly.

**Read-only.** The stack informs analysis; it performs no lineup submission, waiver claim, drop, trade, or Yahoo/Sleeper write, and no such code path exists (test-enforced). The user keeps final judgment.

## Component status (authoritative: `lib/w2r1/qualification.ts`)
| Component | Scientific state | How the main model uses it |
|---|---|---|
| D/ST expected points — Devoted to the Game, Sporty's Alumni (one scoring formulation observed in two leagues), Maclin on Chick's XVI | `QUALIFIED_SHADOW` | **Applied** to the current-week D/ST projection in the main weekly context (lineup, start/sit, waivers, matchup, intelligence, MCP) when a frozen pregame capture exists; provider value recorded; byes untouched |
| D/ST — Rogers Park | `EXPLORATORY_POST_DEFECT` (PO-1) | exposed with its state; **not** applied; inherited generic value used and labelled |
| D/ST — Bloodline Bowl | `DIAGNOSTIC_ONLY` (bias gate; scoring-residual caveat) | exposed with caveat; not applied |
| Kicker forecasts (all leagues) | `DIAGNOSTIC_ONLY` | exposed via the W2.R1 views / MCP (`bloodline_dynamic_vor` kdst view); informs analysis, not substituted into the production lineup; K Dynamic-VOR mechanics live |
| Dynamic VOR (Weekly Roster / League / ROS / Hold / Streaming-adjusted / Scarcity, replacement chain, acquisition uncertainty, FAAB/priority context, scoring fingerprint, provenance) | mechanics live; prospective calibration accumulating (not "qualified", not hidden) | `/api/w2r1/{league}/{manager}/{roster,player,drop,add,compare,…}` and MCP `bloodline_dynamic_vor`; compact pointer block in the weekly intelligence / `bloodline_weekly_analysis` |
| Upside likelihood — TE | `INSUFFICIENT_FINAL_SAMPLE` | exposed as a prospective-evaluation output, never as a calibrated probability |
| Upside — QB / RB | `DIAGNOSTIC_ONLY` | exposed as research output |
| Upside — WR; K/DST spike | `NO_RELIABLE_SIGNAL` / `UNAVAILABLE` | no probability returned (the null result) |
| S5 tactical / game-plan layer | `NO_RELIABLE_SIGNAL` (`TACTICAL_SIGNAL: NO_RELIABLE_INCREMENTAL_SIGNAL`) | **no adjustment is manufactured**; the null is returned |
| Role/opportunity (W2.P1 challenger C2) | `DIAGNOSTIC_ONLY` | descriptive Role evidence available; C2 not applied to forecasts (failed preregistered cap/bias gates) |
Invariants preserved: unknown ≠ 0; W1 availability applied exactly once (the D/ST value is the conditional source; any W1 designation handling is W1's, not repeated); bye current-week value stays 0 while asset / ROS / Hold value is preserved; the W1 final-pregame calibration capture records **provider** evidence (it runs before the W2.R1 replacement).

## Integration points (reviewed, bounded)
`lib/weekly/context.ts` (qualified D/ST plan → replaces eligible DEF rows in the projection batch, recomposes the canonical forecasts, attaches `ctx.w2r1`), `lib/weekly/intelligence.ts` (`w2r1_intelligence`: per-component states + detail routes), `lib/mcp/*` (tool `bloodline_dynamic_vor`, compact block, capability catalog; contract `bloodline-mcp-2026.2`), `lib/public-api/policy.ts` (route registration). Everything else under `lib/w2r1` + `app/api/w2r1`. Guarded by `test/w2r1-isolation.test.ts` (integration boundary), `test/w2r1-integration.test.ts` (behaviour) and the pins ledger in `test/waiver2-integration.test.ts`.
Operational stops (default off): `W2R1_DISABLED=1` (disables the `/api/w2r1` routes), `W2R1_DST_DISABLED=1` (disables the D/ST replacement).

## Prospective capture (unchanged machinery)
`lib/w2r1/data/prospective/wkNN/` frozen pregame captures (manifest-hashed, frozen before first kickoff, never rewritten), registered in `index.ts`. Week 6 was frozen 2026-10-14T20:05:52Z. `.github/workflows/w2r1-weekly-capture.yml` (Wed/Thu, runs from `main`) freezes each following week and registers it; if a week has no capture the qualified leagues transparently fall back to the inherited D/ST value and say so (`w2r1_dst_capture_missing`).
Persistence (`supabase/migrations/20261014120000_w2r1_prospective_captures.sql`) is **optional and NOT required by the runtime**: nothing reads or writes that table; it is **not applied** and must not be applied merely because W2.R1 is main-visible. Captures are repository files.

## Research history (preserved, untouched)
`scripts/w2r1/FROZEN.json` (`3685aa7f…`), S7 results (`scripts/w2r1/results/final/*`), PO-1 / PO-2, Week 6 capture, all hashes. The 2026 Weeks 1–5 final set is permanently spent. Future improvements must use prospective Week 6+ evidence or a newly declared protocol. Research verdict: **W2.R1 CERTIFIED WITH DOCUMENTED LIMITATIONS**.
