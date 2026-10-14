# MCP Connector — End-to-End Certification (Stages A–D)

**Branch:** `mcp-connector` (from `main` `4d16c94`) · **Date:** 2026-10-13 · **NFL week:** 6
**Preview:** `dpl_BSHWsNteszJBTN66hHr3BTnJrrdD`, `https://bloodline-bowl-sleeper-bridge-o5teri9aj-supyo29s-projects.vercel.app/mcp` (Vercel SSO-protected)

## Verdict

| Scope | Result |
|---|---|
| MCP protocol (2025-era + 2026-07-28) | **PASS** (automated + preview) |
| Bridge integration / parity | **PASS**: tool numbers equal route numbers for the same snapshot (live tests, both leagues) |
| Identity isolation | **PASS**: name resolution exact-only; cross-league and non-member managers rejected |
| Analytics isolation | **PASS**: connector imports no analytics engine; no route imports the connector; shadow output separated and labelled |
| Preview deployment | **PASS**: every workflow step served by real MCP tool calls; zero runtime errors |
| **ChatGPT client** | **`PENDING_CHATGPT_CLIENT_VALIDATION`**: previews are behind Vercel SSO, so ChatGPT cannot reach one; production deploy not authorized |
| Claude client | **PENDING_CLIENT_VALIDATION** (same reason) |
| Grok client | **PENDING_CLIENT_VALIDATION** (same reason) |

Nothing here claims success from curl, HTTP 200 or SDK compatibility alone. The workflow below was run with real MCP JSON-RPC `tools/call` requests against the deployed preview. What is still unproven is a real AI platform connecting to a public URL.

## Phase 9 workflow — preview, real MCP tool calls

| # | Step | Tool | Result |
|---|---|---|---|
| 1 | Connect (2025-06-18 `initialize`) | — | negotiated `2025-06-18`, server `bloodline-bowl 1.0.0` (0.76 s) |
| 1b | Connect (2026-07-28 `server/discover`, no handshake) | — | `supportedVersions: ["2026-07-28"]` |
| 2 | Discover tools | `tools/list` | 18 tools, all `readOnlyHint: true` |
| 3 | List leagues | `bloodline_list_leagues` | 5 leagues; current week 6 (Sleeper NFL state) |
| 4 | Resolve "Devoted to the Game" | `bloodline_list_managers` | → `devoted-to-the-game`; `darthmarker` listed |
| 5–6 | Resolve "DarthMarker" + live roster | `bloodline_get_team` | → `darthmarker`, The JSN Bourne Supremacy, 3-2, rank 4 of 12, 1 GB; 11 starters by slot; opponent Godspeed for Goodspeed |
| 7 | League scoring | `bloodline_get_scoring` | 43 rules, classification `full_ppr`, 4-pt pass TD / 6-pt rush & rec TD |
| 8 | Current-week intelligence | `bloodline_weekly_analysis` | `PROJECTIONS_PARTIAL` → `LIMITED`; summary: start Worthy over Robinson (+4.2), add Trey Smack/drop McPherson (HIGH), projected margin −21.3, win prob ~23% (LOW confidence) |
| 9 | Status + provenance | (same) | routes `league_state`, `intelligence`, `orchestrate` all 200; snapshot `snap:devoted-to-the-game:2026:w6:f1f606f191058f3a`; scoring `scoring:v1:d4795fa723cdd12d9ba3bfb1`; projections `sleeper-weekly-rotowire` (PARTIAL) + `ri-structural-2026.3` (READY); `action_plan` ADVISORY_ONLY; no shadow block (not requested) |
| 10 | Analysis matches the bridge | parity tests + spot check | see "Parity" |
| — | Start/sit, waivers, roster, trades | 4 tools | all served; statuses passed through (`PROJECTIONS_PARTIAL`/`READY`, all `LIMITED`) |
| — | Last week (5) | `bloodline_week_history` | `PERSISTENCE_NOT_CONFIGURED` on **preview** (Supabase env vars are production-scoped). In production `/api/history/devoted-to-the-game/week/5` returns `READY` |
| neg | Week 5 on a weekly tool | `bloodline_start_sit` | `NON_CURRENT_WEEK_UNSUPPORTED`, `next_steps` → week history (no current-week substitution) |
| neg | `supyo29` in Devoted | `bloodline_get_team` | `MANAGER_NOT_FOUND`, `data: null`, candidates listed (no substitution) |
| J1 | "McBride & Prejudice" in "Bloodline Bowl" | `bloodline_get_team` | → `supyo29` (matched on team name) |
| J2–J4 | Bloodline scoring, weekly, start/sit for supyo29 | 3 tools | served; `PROJECTIONS_PARTIAL` → `LIMITED` |
| S | `search` "DarthMarker waivers Devoted to the Game" | `search` | `bb:waivers:devoted-to-the-game:darthmarker` |

**Preview vs production numbers.** Preview numbers differ slightly from production (margin −21.29 vs −21.41). The preview has no Supabase credentials, so the weekly engine reads live projections instead of the durable projection snapshot (`SUPABASE_HIT` in production). This is an environment difference, not a connector difference. Within one environment the connector is byte-faithful (next section).

## Parity (automated, live; `test/mcp-parity-live.test.ts`)

For `devoted-to-the-game/darthmarker` and `bloodline-bowl/supyo29`, with the tool call and the direct route call in the same process for the same snapshot:
- start/sit: status, optimal/current totals, every slot's recommended/current player id and projection, decision count. **Equal.**
- waivers: availability status and every recommendation's (player, net roster gain, priority, confidence), in order. **Equal.**
- weekly: status, the full `summary` object, projected margin, win probability and confidence, both optimal totals. **Equal**; no `SHADOW_ONLY` label inside production data.
- scoring: every rule key and points value. **Equal.**
- identity: names resolve to the right manager; a cross-league manager and a non-current week are rejected.

## Tests

| Suite | Result |
|---|---|
| `test/mcp-*.test.ts` (protocol, contract, isolation, live parity) | 46/46 pass |
| Full `npm test` | 3135 tests: 3048 pass, 83 fail, 4 skipped. The 83 failing tests are **exactly the same names** as on unmodified `main`, recorded before any change (live-data and credential dependent). Zero new failures. Two existing tests were updated deliberately: the proxy matcher test now includes the `/mcp` alias, plus a new test that `/mcp` is policed exactly like `/api/mcp`. |
| `tsc --noEmit` | clean |
| `eslint` (MCP files) | clean (repo has 39 pre-existing warnings, 0 errors) |

## Performance (preview, cold → warm mixed)

| Tool | Latency | Result size |
|---|---|---|
| initialize | 0.76 s | — |
| list_leagues | 0.36 s | 1.5 KB |
| get_team | 0.24 s | 5.2 KB |
| get_scoring | 0.25 s | 8.9 KB |
| weekly_analysis | 8.6 s (cold), 4.1 s | 18.8 KB (vs 106 KB raw) |
| start_sit | 0.4–0.6 s | 9.1 KB |
| waiver_analysis | 2.1 s | 10.2 KB |
| analyze_roster | 1.6 s | 11.9 KB (vs 71.7 KB raw) |
| trade_discovery | 2.9 s | 5.4 KB |

The full size comparison is in `docs/MCP_CONNECTOR.md` §3.

## Observability (verified on the preview)

Each call writes one runtime log line, for example:
`{"evt":"mcp_tool_call","request_id":"6dfd03d2-…","tool":"bloodline_weekly_analysis","league":"bloodline-bowl","manager":"supyo29","week":6,"status":"PROJECTIONS_PARTIAL","actionability":"LIMITED","ms":3863,"response_bytes":17787,"upstream":["league_state:200:0ms","intelligence:200:1655ms","orchestrate:200:2207ms"]}`
Zero `error`/`fatal` runtime logs during the certification run.

## What remains (and why)

1. **Real AI-client validation (ChatGPT, Claude, Grok).** Requires a public URL. Either merge and deploy to production (needs your authorization), or temporarily allow the preview through Vercel *Deployment Protection* (for example a protection bypass, or disabling preview SSO for the branch). Then follow `docs/MCP_CONNECTOR.md` §6, connect, ask the §7 questions, and confirm each request in the Vercel logs (`mcp_tool_call`).
2. **ChatGPT plan check for Mark.** Whether his plan exposes Developer mode / custom MCP servers is unknown. This is the decisive item for the ChatGPT path; Claude is the fallback.
3. **Authenticated mode (Stage E).** Designed in §4, not built. Public read-only mode exposes nothing beyond the public API.
4. **History on preview.** Not a defect: production has the persistence configuration.
