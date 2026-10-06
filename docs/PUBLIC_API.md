# Public read-only fantasy API

The bridge is a public, credential-free, read-only fantasy-football API for every registered league, regardless of upstream provider (Bloodline Bowl → Sleeper, Rogers Park → Yahoo). Yahoo OAuth stays server-side.

## Where the policy lives
- `lib/public-api/policy.ts` — route allowlist (one entry per `app/api/**/route.ts`), access classes, method rules, registered-Yahoo-league gate.
- `proxy.ts` — enforces it (Next 16 proxy, `/api/*` only): method safety, deny-by-default, CORS, rate limit.
- `test/public-api-policy.test.ts` — fails CI if a route file is not classified.

**Adding a route:** add its template to `PUBLIC_API_POLICY`. Until you do, it is denied (404) and the test fails.

## Access classes
| class | methods | notes |
|---|---|---|
| public-read | GET, HEAD, OPTIONS | all fantasy-data routes (Sleeper, Yahoo, canonical, analysis) |
| public-compute | POST, OPTIONS | stateless analysis over a request body (`/api/trades/*`, `/api/scoring/calculate`); nothing persisted |
| self-guarded | untouched | cron, refresh, Yahoo OAuth start/callback/diagnostics: the route checks its own secret / OAuth state. No CORS. |
| admin | untouched | `/api/yahoo/leagues` (account-wide league discovery) needs `REFRESH_SECRET` |

Also operator-only: `/api/health?deep=1` (bare `/api/health` is public).
Yahoo routes (`/api/yahoo/leagues/:id/...`) serve only **registered** Yahoo leagues; any other id is 404 so the shared OAuth token cannot be used to read other leagues.

## CORS
`Access-Control-Allow-Origin: *`, methods GET/HEAD/OPTIONS (POST on compute routes), headers `Content-Type, Accept`. No `Allow-Credentials`; no cookies are used. Server-to-server callers are unaffected by CORS.

## Rate limiting (best effort)
Per client IP, per instance, fixed 60 s window: **600/min** standard, **60/min** for Yahoo fan-out routes (a full waiver crawl is ~40 upstream calls). 429 + `Retry-After`. Serverless instances do not share memory, so this is a runaway-script safety net, not a hard quota; for a hard global limit add a Vercel WAF rate-limit rule (dashboard → Firewall).

## Caching
Unchanged, set per route: canonical state 45 s, league metadata 60 s, managers/context 30–120 s; drafts, recommendations, Yahoo `players/available` and `provider-availability` are `no-store` so waiver/ownership data is never stale.

## Vercel
Project setting: Vercel Authentication covers **preview** deployments only; production (including `bloodline-bowl-sleeper-bridge.vercel.app`) is not behind SSO, password or trusted-IP protection, and there is no custom firewall config.

## Validate from outside
`BASE=https://bloodline-bowl-sleeper-bridge.vercel.app scripts/validate-public-api.sh`
