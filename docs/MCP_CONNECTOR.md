# Bloodline Bowl MCP Connector

Remote, read-only [Model Context Protocol](https://modelcontextprotocol.io) server that lets ChatGPT, Claude, Grok and other MCP clients call the Bloodline Bowl bridge as **tools**, without ordinary web browsing or a web-retrieval cache.

| | |
|---|---|
| Endpoint | `https://bloodline-bowl-sleeper-bridge.vercel.app/mcp` (alias of `/api/mcp`). **Not live until this branch is merged and deployed.** |
| Transport | Streamable HTTP, stateless. Supports MCP `2026-07-28` (per-request, no handshake) and 2025-era clients (`2025-11-25`, `2025-06-18`, `2025-03-26`) |
| Auth | None. `PUBLIC_READ_ONLY` serves only data the public `/api/*` routes already serve anonymously |
| Tools | 16 `bloodline_*` tools + `search`/`fetch` (ChatGPT deep research) |
| Writes | None. No tool submits lineups, claims, trades or messages |
| Contract | `bloodline-mcp-2026.1` (`lib/mcp/contract.ts`) |
| Code | `app/api/mcp/route.ts`, `lib/mcp/*`, tests `test/mcp-*.test.ts` |

---

## 1. Architecture decision record

**ADR-MCP-1: Host the MCP endpoint inside the existing Next.js/Vercel project, invoking route handlers in-process.**

**Context.** ChatGPT's ordinary browsing never contacted the bridge in the 2026-10-13 retrieval test (requests never reached Vercel; see `docs/AI_RETRIEVAL_COMPATIBILITY_AUDIT.md`). Shrinking responses (`/api/ai/compact`) cannot fix a fetch that never happens. MCP tool calls are made by the AI platform's servers directly to our endpoint, so there is no cache in between.

**Options considered.**

| Option | Verdict |
|---|---|
| A. MCP route in the existing project, calling route handlers **in-process** | **Chosen** |
| B. MCP route in the existing project, calling the public routes over HTTP | Rejected: double function invocations, extra latency, consumes the public rate limit, and cannot reach SSO-protected previews |
| C. Separate MCP service sharing the bridge over HTTP | Rejected: a second deployment, second set of secrets, and the same HTTP drawbacks; no isolation benefit because the MCP layer holds no state or credentials |
| D. Hand-written JSON-RPC (no SDK) | Rejected: two protocol eras (2026-07-28 and 2025-era) must both work; the official SDK already handles negotiation |

**Decision.**
- `mcp-handler@2.2.0` + `@modelcontextprotocol/server@2.1.0` + `zod@4.6.5`, pinned exactly. These are the official Vercel adapter and the MCP TypeScript SDK v2, all released at least 2 weeks earlier. `mcp-handler` 2.x serves 2026-07-28 natively and falls back to stateless Streamable HTTP for 2025-era clients. No Redis, no session store.
- Every tool calls the **same exported handler** (`GET`/`POST` from `app/api/**/route.ts`) a public client reaches, with the same params (`lib/mcp/invoke.ts`). Results therefore cannot diverge from the routes (proven by `test/mcp-parity-live.test.ts`).
- `/mcp` is a rewrite to `/api/mcp`. `proxy.ts` classifies both identically, as `public-compute`: POST/OPTIONS allowed, GET/DELETE return 405 (the stateless server has no SSE stream). It applies the same rate limit as the rest of the API, plus the MCP CORS headers.
- No new database, no new analytics, no credentials in the MCP layer.

**Consequences.**
- One deployment; the MCP endpoint ships and rolls back with the bridge.
- The `/api/mcp` function bundles the wrapped routes' code and data files (`outputFileTracingIncludes` mirrors `/api/evidence`). `maxDuration` is 120 s, because trade discovery can take about 60 s cold.
- MCP calls trigger the same route-level side effects as HTTP calls. This means the existing insert-only shadow telemetry captures (for example the Waiver 2.0 / market-state capture installed by the evidence route). The connector adds no new side effects.

---

## 2. Tool catalog and contracts

Every `bloodline_*` tool returns the **envelope** (`lib/mcp/envelope.ts`) as both `structuredContent` and JSON text:

```jsonc
{
  "contract_version": "bloodline-mcp-2026.1",
  "tool": "bloodline_start_sit",
  "access_mode": "PUBLIC_READ_ONLY",
  "status": "PROJECTIONS_PARTIAL",      // the bridge's own status, verbatim
  "status_source": "bridge",            // or "connector" for identity / input errors
  "actionability": "LIMITED",           // ACTIONABLE | LIMITED | NOT_ACTIONABLE | INFORMATIONAL
  "request": { "league": "...", "manager": "...", "resolved_week": 6, "week_source": "league_state" },
  "identity": { "league_slug": "...", "manager_slug": "...", "matched_on": "team_name", ... },
  "data": { ... },                      // task-specific, compacted
  "deployment": { "slots": "PRODUCTION", "action_plan": "ADVISORY_ONLY", ... },
  "shadow_evidence": { ... },           // only when include_shadow=true; SHADOW_ONLY, labelled
  "limitations": ["weekly_projections: PARTIAL", ...],
  "warnings": [{ "code": "k_dst_weekly_approximated", "severity": "warning", "message": "..." }],
  "provenance": { "routes": [{ "route", "path", "http_status", "upstream_bytes", "ms" }],
                  "league_snapshot_id", "scoring_fingerprint", "source_generated_at", "served_at",
                  "request_id", "response_bytes" },
  "error": { "code", "detail", "http_status", "candidates", "bridge": { "diagnostics": [...] } },
  "next_steps": ["..."]
}
```

**Status rules.**
- `status` is copied from the bridge (`READY`, `PROJECTIONS_PARTIAL`, `DEGRADED`, `UNAVAILABLE`, `BLOCKED`, `NON_CURRENT_WEEK_UNSUPPORTED`, `VALIDATION_FAILED`, `NOT_CAPTURED`, ...).
- `actionability` can only be lowered by readiness and degradation signals, never raised. `PROJECTIONS_PARTIAL`, `DEGRADED`, `READY_WITH_LIMITATIONS` and LOW-confidence win probabilities are `LIMITED`. Unavailable, blocked, not-found and timeout results are `NOT_ACTIONABLE`.
- Results over 120 KB are withheld with `OUTPUT_TOO_LARGE`, never truncated.

| Tool | Wraps (route) | Inputs | Deployment labels |
|---|---|---|---|
| `bloodline_capabilities` | `/api/evidence?capabilities=1` | — | catalog of every surface's deployment, refresh lag, versions |
| `bloodline_list_leagues` | `/api/leagues` + NFL state | — | DESCRIPTIVE |
| `bloodline_get_league` | `/api/league/{league}/state` | league | DESCRIPTIVE (standings, matchups, settings) |
| `bloodline_list_managers` | `/api/league/{league}/state` | league | DESCRIPTIVE |
| `bloodline_get_team` | `/api/context/{league}/{manager}` | league, manager | DESCRIPTIVE (roster, record, standing, opponent) |
| `bloodline_get_scoring` | `/api/leagues/{league}/scoring` (Sleeper); canonical snapshot rules (Yahoo) | league | DESCRIPTIVE |
| `bloodline_weekly_analysis` | `/api/intelligence/.../week/{w}` + `/orchestrate` | league, manager, week?, include_shadow? | PRODUCTION; `action_plan` ADVISORY_ONLY; shadow on request |
| `bloodline_start_sit` | `/api/lineup/.../week/{w}` | league, manager, week?, detail? | PRODUCTION |
| `bloodline_matchup_analysis` | `/api/matchup/.../week/{w}` (+ intelligence for shadow) | league, manager, week?, include_shadow?, detail? | PRODUCTION; shadow on request |
| `bloodline_waiver_analysis` | `/api/waivers/.../week/{w}` | league, manager, week?, detail? | PRODUCTION |
| `bloodline_analyze_roster` | `/roster-health` + `/schedule-planning` + `/strategic-context` | league, manager | SHARED_CONTEXT |
| `bloodline_trade_evaluation` | `POST /api/trades/competitive` mode `evaluate`/`negotiate` | league, manager, counterparty, give[1-5], receive[1-5], mode? | PRODUCTION (read-only analytics) |
| `bloodline_trade_discovery` | `POST /api/trades/competitive` mode `discover`/`strategy_path` | league, manager, mode? | PRODUCTION (read-only analytics) |
| `bloodline_week_history` | `/api/history/{league}/week/{w}` | league, week, manager? | DESCRIPTIVE (captured results) |
| `bloodline_player_analysis` | `/api/evidence` `fi.player_usage` + `role.player_profile`, `/api/leagues/{l}/projections/{id}` | player, league?, position?, nfl_team? | evidence blocks' own labels; projection PRODUCTION |
| `bloodline_evidence` | `/api/evidence?topic=...` | topic, params?, detail? | evidence blocks' own labels |
| `search` | (no route; maps a question to document ids) | query | — |
| `fetch` | runs the matching `bloodline_*` tool | id | that tool's labels |

**Reconciliation with the requested catalog.** All 16 proposed names were kept, with these decisions:
- `bloodline_trade_discovery` uses the competitive engine (`/api/trades/competitive`), which `/api/ai` advertises. The legacy `/api/trades/discover` is unadvertised and is not wrapped.
- The orchestrator (team-management action plan) is folded into `bloodline_weekly_analysis` as `action_plan`, labelled ADVISORY_ONLY.
- Season position (`playoff.status`, `playoff_odds_band`, archetype) is in `bloodline_analyze_roster`. **`playoff_odds` is null by design**: no playoff-probability model exists, and the connector never invents one.
- `search`/`fetch` were added because ChatGPT deep research and read-only connector modes call only tools with exactly those names.

**Identity resolution** (`lib/mcp/identity.ts`).
- `league` accepts a slug, an exact league name, or a registered league id. `manager` accepts a slug, Sleeper username, display name or exact team name, matched after normalization (case, punctuation and accents only). The directory comes from the league's own canonical snapshot (`/api/league/{league}/state`, cached for 30 s per instance).
- There is no fuzzy matching, no default manager and no commissioner fallback. Zero matches returns `*_NOT_FOUND` with the real candidates. Several matches (for example a co-managed team name, or two managers with the same display name) returns `*_AMBIGUOUS` with candidates.
- The resolved slug then goes to the route, which performs its usual strict league ≠ manager membership check.
- Players resolve by exact full name (optionally narrowed by `position`/`nfl_team`) or by Sleeper id. Gsis-keyed canonical ids are mapped through the snapshot's own `identifiers.sleeper_id`.

**Weeks.** With no `week`, the league's canonical `current_week` is used, falling back to Sleeper NFL state, the same source as the weekly engine's gate. An explicit `week` is passed to the route **unchanged**. The weekly routes reject a non-current week with `NON_CURRENT_WEEK_UNSUPPORTED`, and the connector adds `next_steps: bloodline_week_history`. It never substitutes the current week for a historical request.

---

## 3. Response size (measured, Devoted to the Game / darthmarker, week 6)

| Question | Raw route(s) | MCP tool result | Reduction |
|---|---|---|---|
| Weekly analysis | `/api/intelligence` 92.3 KB + `/orchestrate` 13.9 KB = 106 KB | 18.8 KB | −82% |
| League overview | `/api/league/{l}/state` 247 KB (`/api/leagues/{l}` 250 KB) | 8.2 KB | −97% |
| Roster outlook | roster-health 30.6 + schedule 39.5 + strategic 1.6 = 71.7 KB | 11.9 KB | −83% |
| Waivers | `/api/waivers` 33.2 KB | 10.2 KB | −69% |
| Team / roster | `/api/context` 21.7 KB | 5.2 KB | −76% |
| Matchup | `/api/matchup` 18.4 KB | 8.8 KB | −52% |
| Scoring | `/api/leagues/{l}/scoring` 15.5 KB | 8.9 KB | −42% |
| Player | evidence 32.4 + 56.9 KB + projection 3.9 KB = 93 KB | 14.2 KB | −85% |
| Start/sit | `/api/lineup` 9.9 KB | 9.2 KB | −7% (player names added; already compact) |
| Trade discovery | `/api/trades/competitive` 4.2 KB | 5.4 KB | +28% (identity + envelope; already compact) |

Size is cut by dropping duplicated lineage copies, raw roster and player dumps, and per-component score breakdowns (available with `detail: "full"`). Status, confidence, limitations, units and lineage are **never** dropped.

---

## 4. Authentication and authorization design

**Today: `PUBLIC_READ_ONLY` (shipped in this branch).** No sign-in. Every tool serves data the bridge already serves anonymously on `/api/*`. Knowing a manager slug grants nothing new: the same data is one public URL away. There is no user-private data, so there is nothing to authorize. Clients connect with "No authentication".

**Authenticated mode: designed, not built (Stage E).** Needed only if manager-private data (for example Yahoo leagues that require the owner's token, or future private notes) is exposed, or so a user doesn't have to say who they are.

- **Protocol.** MCP authorization uses OAuth 2.1, with the MCP server as a protected resource. Implement with `withMcpAuth` (mcp-handler) and `/.well-known/oauth-protected-resource` (RFC 9728) pointing to an authorization server. Client registration uses Client ID Metadata Documents (2026-07-28 deprecates Dynamic Client Registration). ChatGPT, Claude and Grok each run the OAuth redirect themselves.
- **Authorization server.** Use an existing provider such as Supabase Auth (already in the stack) or another OIDC IdP. No custom password system.
- **Identity linking.** A signed-in user proves ownership of a manager identity. For Sleeper this means claiming a manager and verifying it through an out-of-band step, such as setting a one-time code in the Sleeper team name or display name and having the bridge confirm it via the public Sleeper API, or a commissioner-approved invite. For Yahoo it is the user's own Yahoo OAuth (the Phase 1 bridge OAuth work). A slug alone never proves ownership.
- **Mapping table.** A new `mcp_identity_links` table holds `subject`, `league_slug`, `manager_slug`, `verified_via`, `verified_at`, `revoked_at` and audit timestamps. RLS denies everything except the service role. It is auditable, and revocation is a single update.
- **Scopes.** `bloodline:read:public` (today's data) and `bloodline:read:manager` (linked managers only). Commissioner access is never implied.
- **Defaults.** In authenticated mode, `manager` becomes optional and defaults to the caller's single linked manager. If several are linked, the server asks rather than picks. Another manager's data stays available only at public scope.
- **Secrets.** Tokens are validated per request, never logged and never placed in tool results. Refresh tokens stay with the authorization server.

Effort: about 1–2 weeks, including the migration, the ownership-verification flow and tests. Not started.

---

## 5. Security review

| Area | Status |
|---|---|
| Write operations | None. `ROUTES` contains only GET handlers plus the documented read-only `POST /api/trades/competitive` (asserted in `test/mcp-isolation.test.ts`). No cron, refresh, auth or calculator routes are reachable. |
| Credentials | The MCP layer reads no secrets and returns none. Wrapped routes use their own server-side configuration exactly as over HTTP. |
| Input validation | Zod schemas on every tool (length caps, week 1–18, 1–5 trade assets, evidence param keys `^[a-z_]{1,32}$`). The SDK rejects invalid input before the handler runs. The routes re-validate. |
| Identity | Exact matching only; ambiguity and absence are errors; the route still enforces membership (`lib/leagues/resolve.ts`). |
| Rate limiting | Same proxy limit as `/api/*` (`standard`, 600/min per IP). **Note:** AI platforms call from shared egress IPs, so many users share one bucket. That is acceptable at current scale; revisit if usage grows (for example a per-tool cost class or per-`Mcp-Session`/user keys after auth). |
| Timeouts | 45 s per wrapped route (80 s for trades), `maxDuration` 120 s. A timeout returns `UPSTREAM_TIMEOUT`, never a partial result. |
| Output bounds | 120 KB cap with `OUTPUT_TOO_LARGE`; `detail: "full"` subject to the same cap. |
| Error messages | Exception messages are capped at 300 characters, no stacks, no headers. Bridge diagnostics are passed through (they contain only league data). |
| Logging | One JSON line per call (`evt: "mcp_tool_call"`): request id, tool, league, manager, week, status, actionability, latency, response bytes and upstream route statuses. No tokens, headers or bodies (asserted in tests). |
| CORS | `*` with no credentials (same as the public API), plus MCP protocol headers so browser-based MCP clients work. |
| Prompt-injection surface | Tool output contains provider-sourced strings (team names, player names). They are data; tool descriptions instruct nothing beyond the API's own semantics. |
| Dependencies | +3 runtime packages (`mcp-handler` and its `chalk`/`commander` CLI deps, `@modelcontextprotocol/server`/`core`, `zod`). `npm audit` reports existing high-severity advisories in dev tooling (`brace-expansion`, `braces`, `js-yaml` under eslint); none are introduced by this change. |

---

## 6. Connecting

All clients connect to the same URL. The remote server must be publicly reachable. Preview deployments of this project are behind Vercel SSO, so AI platforms can connect only to production, or to a preview with protection bypassed.

### ChatGPT

Requirements: availability depends on plan and workspace policy and changes often. Per OpenAI's documentation, full MCP apps and developer mode are available on **Business and Enterprise/Edu**, where a workspace admin must allow it. **Plus/Pro** availability is reported as read/fetch-only or unclear. All Bloodline tools are read-only (`readOnlyHint: true`), so they need no write permission. **Check this in the actual account before relying on it.**

1. Turn on **Developer mode**: *Settings → Security and login → Developer mode* (on Business: the admin enables "Developer mode / Create custom MCP connectors" under *Workspace Settings → Permissions & Roles*). The location has moved during 2026; if it's missing, the plan or workspace doesn't allow it.
2. Open **ChatGPT Plugins** (chatgpt.com/plugins) → **+** → **Add custom MCP server**.
3. Name: `Bloodline Bowl`. Description: `Fantasy football intelligence for my leagues`.
4. Connection: **Public endpoint**, URL `https://bloodline-bowl-sleeper-bridge.vercel.app/mcp`.
5. Authentication: **None**. Review the warning → **I understand and want to continue** → **Create**.
6. Check that 18 tools are listed.
7. In a **new** chat, type `@` and pick Bloodline Bowl, then ask a question.
8. After a server update that changes tools: open the connection → **Refresh**, then start a new chat.

### Claude (claude.ai, Claude Desktop, mobile)

Custom connectors work on Free (one connector), Pro, Max, Team and Enterprise. On Team/Enterprise, an Owner adds it for the org.

1. **Customize → Connectors** (or *Settings → Connectors*) → **+** → **Add custom connector**.
2. Name `Bloodline Bowl`, URL `https://bloodline-bowl-sleeper-bridge.vercel.app/mcp`. Leave OAuth Client ID/Secret empty.
3. In a chat, enable it from the tools menu and ask a question.

Claude Desktop does **not** read remote servers from `claude_desktop_config.json`; add them in Settings. Claude Code: `claude mcp add --transport http bloodline-bowl https://bloodline-bowl-sleeper-bridge.vercel.app/mcp`.

### Grok

- **grok.com (paid plans):** **grok.com/connectors → New Connector → Custom**, paste the URL, no authentication. (Third-party sources describe this flow; confirm it in the account.)
- **xAI API (Responses API):**
  ```python
  client.responses.create(
      model="grok-4.3",
      input=[{"role": "user", "content": "Analyze darthmarker in Devoted to the Game this week."}],
      tools=[{
          "type": "mcp",
          "server_url": "https://bloodline-bowl-sleeper-bridge.vercel.app/mcp",
          "server_label": "bloodline",
          "server_description": "Read-only fantasy football intelligence for Bloodline Bowl leagues",
      }],
  )
  ```
  xAI supports only Streamable HTTP/SSE (this server is Streamable HTTP). `require_approval` and `connector_id` are not supported by xAI. Check the current model name in xAI's docs.

### Other MCP clients

Any Streamable HTTP MCP client works. To inspect the server: `npx @modelcontextprotocol/inspector@latest` → Streamable HTTP → the URL → Connect → List Tools.

---

## 7. Guide for Mark (Devoted to the Game)

1. Connect **Bloodline Bowl** using the ChatGPT steps above (or the Claude steps if ChatGPT's plan doesn't allow custom connectors).
2. Tell the assistant who you are once. Better still, add it to ChatGPT's *Personalization → Custom instructions*:
   > In fantasy football, I am **DarthMarker** (manager slug `darthmarker`, team "The JSN Bourne Supremacy") in the league **Devoted to the Game** (`devoted-to-the-game`). Use the Bloodline Bowl connector for anything about my team.
3. Questions that work well:
   - "Analyze my fantasy football team this week."
   - "Who should I start this week?"
   - "Who should I target on waivers?"
   - "Find trades that would help me, and tell me how confident the bridge is."
   - "Why did my team lose last week?" (uses `bloodline_week_history`)
   - "How do I compare to the rest of Devoted to the Game?"
   - "What are this league's scoring rules?"
4. Read the caveats it reports: *partial projections*, *low-confidence win probability*, *shadow-only*. These are the bridge being honest. **Playoff odds:** the bridge reports standings position and a playoff position band, not a percentage.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No "Developer mode" or "Add custom MCP server" in ChatGPT | Plan or workspace policy. Ask the workspace admin, or use Claude. |
| Connector created but tools don't appear | Open the connection → **Refresh**, start a new chat. |
| `MANAGER_NOT_FOUND` / `MANAGER_AMBIGUOUS` | Use the exact slug from `bloodline_list_managers`. A co-managed team name is ambiguous by design. |
| `NON_CURRENT_WEEK_UNSUPPORTED` | Weekly tools serve only the current week; use `bloodline_week_history`. |
| `NOT_CAPTURED` from history | That week has no stored snapshot (yet). |
| `LIMITED` actionability | Read `limitations`; partial projections, provider gaps or LOW confidence. |
| `UPSTREAM_TIMEOUT` | A provider or engine was slow; retry. |
| 405 on GET | Expected. The server is stateless (POST only). |
| 401/403 on a preview URL | Preview deployments are behind Vercel SSO; use production. |

Every result's `provenance.request_id` appears in the Vercel runtime log line `mcp_tool_call`.
