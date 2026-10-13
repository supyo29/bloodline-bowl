# Ordinary ChatGPT web-retrieval compatibility audit — 2026-10-13

**ChatGPT certification: `FAIL` — external limitation, not a bridge defect** (live test 2026-10-13, §9). Ordinary ChatGPT browsing in the tested session only returns URLs already in its own cache. It does not live-fetch unseen URLs on *any* host, so the bridge's requests never reached Vercel.

## 1. Report that started this audit

On 2026-10-13, ordinary ChatGPT (with no Vercel connector) said `/api/ai` and `/llms.txt` were "not accessible through the tool". On the same day, fetches through the Vercel connector returned HTTP 200 for `/api/ai`, `/llms.txt`, `/robots.txt` and `/api/league/bloodline-bowl/state`.

## 2. Production configuration as inspected

| Item | Finding |
|---|---|
| Production deployment | `dpl_4uAXH954nvN9qaziE5zxarNi7AYx`, `main@6a652d9`, READY. The local feature branch was behind and does **not** match production. |
| Deployment protection | `ssoProtection` covers **preview** deployments only. Password protection and trusted IPs are off. Production is public. |
| Vercel firewall / WAF | No firewall config exists for the project (the API returns `404 Seawall Config not found`), so there are no custom rules, managed bot rulesets or challenge rules. Attack-status lookup also returns 404. |
| Next.js `proxy.ts` | Covers `/api/*` only. It applies a route allowlist, CORS (`*`) and a per-IP, per-instance in-memory rate limit of 600/min (standard) or 60/min (Yahoo). There is **no user-agent logic**. `/llms.txt`, `/robots.txt` and `/ai` are not covered by the proxy. |
| User-agent handling anywhere in `app/` or `lib/` | None. The only `User-Agent` reference is an outbound header sent to the NWS weather API. |
| robots.txt | `User-Agent: *`, `Allow: /`. Disallows only `/api/cron/`, `/api/auth/`, `/api/draft/debug`, `/api/raw`, `/api/bridge/`. |
| `X-Robots-Tag` / `noindex` | None. |
| TLS / DNS | TLSv1.3 (TLS 1.2 also accepted), `*.vercel.app` certificate from Google Trust Services WR1, verifies OK. A records only. |
| Runtime logs | Hobby plan keeps runtime logs for **1 hour**. The failed ChatGPT attempts happened earlier, so whether they reached the deployment **cannot be determined after the fact**. |

## 3. Diagnostic matrix (2026-10-13, residential egress plus Anthropic cloud fetcher)

Each path was requested with 8 user agents: a Chrome browser string, `ChatGPT-User/1.0`, `OAI-SearchBot/1.0`, `GPTBot/1.1`, `Claude-User/1.0`, `Google-Extended`, `curl`, and an empty user agent. Requests sent `Accept-Encoding: br, gzip`.

| Path | Status (all 8 UAs) | Content-Type | Raw size | Encoding |
|---|---|---|---|---|
| `/robots.txt` | 200 | text/plain | 260 B | — |
| `/llms.txt` | 200 | text/plain; charset=utf-8 | 17.6 KB (6.2 KB on the wire) | br |
| `/ai` | 200 | text/html | 34 KB | br |
| `/api/ai` | 200 | application/json | 40.6 KB (9.9 KB on the wire) | br |
| `/api/leagues` | 200 | application/json | 5.5 KB | br |
| `/api/league/bloodline-bowl/state` | 200 | application/json | **235 KB** | br |
| `/api/health` | 200 | application/json | 368 B | — |

Additional checks:
- HEAD returns 200.
- `Accept: text/html` on `/api/ai` still returns JSON 200, with no content negotiation that could fail.
- `http://` → 308 to `https://`. A trailing slash → 308 to the canonical path. Neither redirect loops or leaves the host.
- Anthropic's cloud web fetcher (WebFetch, which runs on separate cloud egress) retrieved and parsed both `/api/ai` and `/llms.txt`.

## 4. Root-cause classification

| Suspect | Classification | Evidence |
|---|---|---|
| Vercel deployment protection | **RULED OUT** | SSO covers previews only. Production answers anonymous requests. |
| Vercel firewall / bot challenge / managed AI-bot ruleset | **RULED OUT** (current config) | No firewall config exists. All AI-crawler user agents return 200 with no challenge. |
| App middleware blocking by user agent | **RULED OUT** | `proxy.ts` has no user-agent logic and does not cover `/llms.txt`, which also failed. |
| App rate limiter (shared OpenAI egress) | **POSSIBLE, low** | Limit is 600/min per IP per instance and only applies to `/api/*`. It cannot explain the `/llms.txt` failure. |
| Redirects | **RULED OUT** | Canonical URLs return 200 directly. |
| DNS / TLS compatibility | **RULED OUT** from this vantage | TLS 1.2/1.3, valid public CA, A records resolve. |
| Brotli/gzip negotiation, content types | **RULED OUT** | Correct `Content-Type`. Encoding is negotiated, and uncompressed responses are served when asked. |
| Crawler directives (robots, X-Robots-Tag) | **RULED OUT** | Everything public is allowed. No `noindex`. |
| Response size / truncation | **POSSIBLE for downstream routes, not the initial failure** | `/api/ai` (41 KB) and `/llms.txt` (18 KB) are moderate. `/api/league/{slug}/state` at 235 KB may be truncated by browsing tools. |
| ChatGPT-side URL/host policy (shared `*.vercel.app` hostname reputation, not-yet-indexed URL, tool-side refusal) | **NOT TESTABLE FROM THIS ENVIRONMENT — leading remaining hypothesis** | The origin serves every tested client and user agent. The reported error text ("not accessible through the tool") describes a tool refusal, not an HTTP error. No server log from the incident window exists to show whether the request ever arrived. |
| Discovery contract not traversable by verbatim-URL browsing tools | **CONFIRMED (contract property); impact on ChatGPT PROBABLE** | `/api/ai` lists 41 absolute URLs, and **every** one is either a `{placeholder}` template or the bare origin. Concrete league and manager URLs are **relative**, and manager weekly URLs keep `{week}`. A tool that only opens URLs appearing verbatim cannot get from `/api/ai` to live manager data without constructing a URL. This blocks the "follow advertised routes" half of the success criterion even once `/api/ai` itself loads. |

**Conclusion.** No application- or platform-level restriction on this deployment explains the reported failure. All origin-side causes tested are ruled out. The initial "not accessible" result most likely originates on ChatGPT's side, but that is unproven: it requires a reproduction captured during the live log window (§7). Separately, the discovery contract had a confirmed traversal gap for verbatim-URL browsers. That gap is the one repair this audit can defend with evidence.

## 5. Repair (additive only)

| Change | Purpose |
|---|---|
| **New** `GET /api/ai/compact` (`app/api/ai/compact/route.ts`) | About 6 KB link index. Every URL is absolute and concrete: health, the full contract, llms.txt, per-league state/transactions/overview/managers/snapshot, and per-manager home/snapshot/context. Current-week intelligence, lineup, matchup and waiver URLs are filled from Sleeper NFL state, with a 2.5 s bounded lookup. If the week cannot be resolved, the weekly URLs are omitted and the reason is stated; no placeholder is ever emitted. Public-read, CORS `*`, 60 s CDN cache; `current_week.status` RESOLVED|UNAVAILABLE. |
| `/api/ai` | Adds `start_here.compact_index` (absolute URL). No existing field changed. |
| `/api/health` (bare) | Adds `discovery.contract` and `discovery.compact_index` absolute links. Still makes no upstream calls. |
| `/llms.txt`, `/ai`, `/sitemap.xml` | Advertise the compact index with absolute URLs. |
| `lib/public-api/policy.ts` | Classifies `/api/ai/compact` as `public-read`, required by the deny-by-default proxy. |
| Tests | `test/ai-compact-index.test.ts`: every URL is absolute, has no placeholders and no `week/null`; the route is public-read only; it is linked from `/api/ai` and `/api/health`. The discovery-coverage allowlist entry is added. |

Not changed: the existing routes and their shapes, the rate limits, CORS, robots and protected routes. No model, engine, persistence or provider code was touched.

## 6. Regression evidence (local, branch vs `origin/main@6a652d9`)

- `npm test`: main 3085 tests / 2998 pass / **83 fail** / 4 skip. Branch 3088 / 3001 / **83** / 4. The **failure sets are identical.** The 83 failures already exist in this environment (live-data drift); none involve the touched files. The 3 new tests pass.
- `tsc --noEmit` clean. ESLint clean on the touched files. `next build` succeeds (`ƒ /api/ai/compact`).
- Live production bodies, checked beyond the HTTP status:
  - `/api/league/bloodline-bowl/state` returns `status READY`, `live_provider_status READY`, `history_persistence_status READY`, `warnings []`.
  - `/api/intelligence/bloodline-bowl/supyo29/week/6` returns 200 with `status PROJECTIONS_PARTIAL`, an honest non-fully-actionable state.
- Security: `POST /api/ai/compact` returns 405 from the proxy. Protected routes (cron, refresh, admin Yahoo) are unchanged.

## 7. Required external validation (not performable here)

1. Run this from a fresh, ordinary ChatGPT conversation with no connectors, during a window when Vercel runtime logs can be watched (Hobby keeps 1 h): "Fetch https://bloodline-bowl-sleeper-bridge.vercel.app/api/ai/compact and tell me Bloodline Bowl's current week and supyo29's weekly intelligence status."
2. Watch the project logs during the attempt:
   - If **no request arrives**, the block is on ChatGPT's side. The remaining lever is a custom domain, which needs owner approval and a purchase.
   - If a request arrives with a non-200 status, re-open this audit.
3. Record PASS or FAIL here. Until then the status is `PENDING_EXTERNAL_VALIDATION`.

## 8. Remaining risks

- The `*.vercel.app` shared-hostname reputation hypothesis is untested. A custom domain is the only way to test it, and it requires approval.
- `/api/league/{slug}/state` (235 KB) may be truncated by browsing tools. The compact index steers agents to the smaller manager snapshot instead.
- Rollover lag: the compact index's current week is CDN-cached for 60 s plus 60 s stale-while-revalidate (Sleeper state itself revalidates every 300 s, the same source the engine gates on). Right at the week rollover, the weekly URLs can briefly point at the previous week; those routes then answer `NON_CURRENT_WEEK_UNSUPPORTED` explicitly.
- The current week comes from Sleeper NFL state. All registered managers are in Sleeper leagues today. Yahoo-league weekly URLs are not emitted.

## 9. Live ChatGPT results (2026-10-13, after deploying `df7276d`)

Run by the owner in fresh, ordinary ChatGPT conversations with no connectors.

| Test | ChatGPT result | Reached Vercel? |
|---|---|---|
| `/api/ai/compact` (new) | Failed — "Cache miss" | **No** |
| `/api/ai` | Returned a ~2-week-old cached copy | **No** (no live request) |
| `/llms.txt`, `/api/leagues/bloodline-bowl/managers/supyo29`, `/api/intelligence/bloodline-bowl/supyo29/week/6` | Not accessible | **No** |
| `https://httpbin.org/anything/bb-probe-7f3k9q2` (unseen, third-party) | Failed — "Cache miss" | n/a |
| `https://httpbin.org/get` (well-known, third-party) | Succeeded; the body shows `ChatGPT-User/1.0` from an earlier fetch | n/a |

**Log evidence.** The Vercel request log (`vercel logs --environment production --json`) was checked during the test window:
- **Freshness:** a marked probe sent at 19:57:32 UTC appeared within seconds.
- **Coverage:** the log records CDN cache hits as well as function invocations.
- **Result:** a per-path search of the 60-minute retention window found no requests to any tested path apart from the auditor's own traffic.
- **Limit:** the log has no user-agent or IP fields, so attribution is by timing.

**Finding: CONFIRMED for the tested ChatGPT mode.** Retrieval depends on ChatGPT's own cache. It failed on an unseen URL at an unrelated domain in exactly the same way, so the cause is not this hostname, `*.vercel.app`, or the bridge. The working `/get` control shows the cache is filled by fetches made at some other time, through a path outside this session's control. That fits `/api/ai` having been cached about two weeks ago.

**Not concluded.** This does not show how every ChatGPT mode behaves (for example agent or deep-research modes), or when or how the cache gets populated.

**Decisions.**
- No further bridge changes.
- No custom domain: hostname reputation is ruled out as the cause of this failure.
- AI access continues through the working Vercel connection.
- `/api/ai/compact` stays deployed. It is harmless, it makes every link followable once a client does fetch, and it is listed in `sitemap.xml` for crawlers.

**Optional future checks** (no code needed):
1. Re-run the ChatGPT prompt for `/api/ai/compact` after some days, to see whether it appears in ChatGPT's cache.
2. Try ChatGPT agent or deep-research mode, which may live-fetch.
