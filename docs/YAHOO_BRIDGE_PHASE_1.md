# Yahoo Fantasy Bridge — Phase 1

**Status:** engineering-complete, deterministic tests green, **live OAuth smoke NOT
yet run** (no credentials in the build environment; requires an interactive Yahoo
consent). Branch `yahoo-bridge-phase1-oauth`. Not merged, not deployed.

Phase 1 goal: a production-quality Yahoo **authentication + discovery**
foundation. It deliberately does **not** build the Yahoo→Roster-Intel
normalization layer, recommendations, polling, or analytics ingestion — but it is
designed so those consume it cleanly later.

---

## 1. Architecture

```
app/api/yahoo/
  auth/start/route.ts        GET  — step 1: config check → CSRF state → 302 to Yahoo
  oauth/callback/route.ts    GET  — step 2: verify state → exchange code → persist   (REGISTERED REDIRECT URI)
  status/route.ts            GET  — safe diagnostic: configured / authorized / token health (no secrets)
  leagues/route.ts           GET  — live: game key + discovered leagues + configured-league validation
  leagues/[leagueId]/route.ts GET — live: one league by id or registry slug + read-only sub-resource probe
  diagnostics/route.ts       POST — deep read-only probe (Bearer REFRESH_SECRET); spends Yahoo quota

app/api/auth/yahoo/{connect,callback,status}/route.ts
                             — DEPRECATED 308 redirects to the /api/yahoo/* equivalents

lib/providers/yahoo/
  config.ts        env loading + validation (never logs values); YAHOO_NFL_GAME_CODE; YAHOO_TARGET_SEASON
  crypto.ts        AES-256-GCM encrypt/decrypt for tokens at rest (YAHOO_TOKEN_ENCRYPTION_KEY)
  oauth.ts         authorize URL, code exchange, refresh, getValidAccessToken (skew + concurrency + retry)
  oauth-state.ts   the CSRF cookie name constant
  token-store.ts   SupabaseYahooTokenStore (encrypted) + InMemory + resolveYahooTokenStore()
  client.ts        YahooFantasyClient — bearer auth, ?format=json, timeout, classified errors, 401→refresh→retry-once
  games.ts         resolveNflGameKey() — DYNAMIC; parseGamesResponse(); buildLeagueKey()
  parse.ts         fantasy_content array/object-hybrid traversal helpers
  discovery.ts     verifyAuthenticatedAccess / discoverUserLeagues / probeLeague / readOnlyLeagueProbe / probeUserTeams
  diagnostics.ts   runLeagueDiscovery() + runDeepProbe() — compose the above
  session.ts       loadYahooSession() — config + store + client, or the exact reason one can't be built
  provider.ts      YahooProvider — unchanged degraded contract; now uses the durable store + real token health
```

The existing **Sleeper** path is untouched. `lib/providers/types.ts`,
`registry.ts`, and every Sleeper file are byte-identical to `main`.

## 2. Environment variables

| Var | Required | Purpose |
|---|---|---|
| `YAHOO_CLIENT_ID` | yes | OAuth app client id (Consumer Key) |
| `YAHOO_CLIENT_SECRET` | yes | OAuth app client secret — **server-side only** |
| `YAHOO_REDIRECT_URI` | yes | Must exactly equal the URI registered with Yahoo: `https://bloodline-bowl-sleeper-bridge.vercel.app/api/yahoo/oauth/callback` |
| `YAHOO_TOKEN_ENCRYPTION_KEY` | yes for durable storage | 32-byte key (base64/hex) or passphrase; encrypts tokens before Supabase |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | yes for durable storage | token table backend (already used by the bridge) |
| `REFRESH_SECRET` | to use `/api/yahoo/diagnostics` | shared bearer secret (already used by `/api/refresh`) |
| `YAHOO_GAME_KEY` | no | operator override, used **only** if the live `/games` call fails |
| `YAHOO_ALLOW_MEMORY_TOKEN_STORE` | no | local dev only — ephemeral in-memory token store |

Names only live in `.env.example`. No secret appears in source, tests, logs, or
responses.

## 3. OAuth flow

1. **`GET /api/yahoo/auth/start`** — validates config **and** that a durable
   token store is available (we never start a flow we can't finish); mints a
   32-byte `state`; sets it as an `HttpOnly; Secure; SameSite=Lax` cookie scoped
   to `/api/yahoo`; 302 → `https://api.login.yahoo.com/oauth2/request_auth?...`
   with `client_id`, `redirect_uri`, `response_type=code`, `scope=fspt-r`,
   `state`.
2. User approves on Yahoo → `GET /api/yahoo/oauth/callback?code=…&state=…`.
3. Callback: handles `?error=`; requires `code`+`state`; **constant-time**
   compares `state` vs the cookie (`statesMatch`); exchanges the code at
   `https://api.login.yahoo.com/oauth2/get_token` using HTTP Basic
   (`client_id:client_secret`); persists the token via the store; clears the
   cookie; returns `{ ok, status: "CONNECTED", yahoo_guid, access_token_expires_at }`
   — **no token value in the body**.

## 4. Token storage & refresh

* **Storage:** `public.bridge_yahoo_connections` (migration
  `20260910120000_bridge_yahoo_oauth_connections.sql`). One row per
  `connection_id` (default `primary`; a second Yahoo account is a second row, no
  schema change). `access_token` / `refresh_token` are **AES-256-GCM ciphertext**
  (`iv.tag.ciphertext`, base64). RLS enabled, no policies — service-role only,
  same model as every other `bridge_*` table. The encryption key is **not in the
  database**; a DB leak alone yields no usable token. `clear()` blanks the row
  (no hard delete — repo convention).
* **Refresh:** `getValidAccessToken()` returns a valid token, refreshing when
  within **120 s** of expiry or on a forced retry. On a `401` the client forces
  one refresh and retries the request **exactly once** — never a loop; a second
  `401` throws `YahooApiError("AUTH")`.
* **Concurrency:** an in-process `Map` de-dupes concurrent refreshes on a warm
  instance into one network call + one write. Across instances two refreshes can
  race; Yahoo keeps the prior refresh token valid and both mint usable access
  tokens, so the last write wins on already-valid state — no torn token. If Yahoo
  omits `refresh_token` on a refresh, the prior one is retained.

## 5. Yahoo API client behavior

`YahooFantasyClient.get(path)` → `{ data, meta }`. Always appends `format=json`.
12 s timeout. Error classes (`YahooApiError.kind`): `NOT_CONNECTED`, `AUTH`,
`FORBIDDEN` (403 — token valid, not entitled), `NOT_FOUND` (404),
`RATE_LIMITED` (429/999), `SERVER` (5xx), `MALFORMED` (2xx non-JSON), `TIMEOUT`,
`NETWORK`. `meta` carries `http_status`, `duration_ms`, `refreshed`, and Yahoo's
`x-yahoo-request-id` — never a token.

## 6. Dynamic 2026 NFL game key

`resolveNflGameKey(client, 2026)` calls `GET /games;game_codes=nfl;seasons=2026`,
validates `code === "nfl"` **and** `season === 2026`, extracts `game_key` +
`game_id`, and caches for the instance lifetime. **No season game key is
hard-coded anywhere.** League keys are built only as
`buildLeagueKey(gameKey, leagueId)` → `{gameKey}.l.{leagueId}` from a resolved
key, then validated against Yahoo via `/league/{key}/metadata` — not assumed.

## 7. League discovery & validation

* `discoverUserLeagues` — every NFL league the authorized account belongs to,
  via `/users;use_login=1/games;game_codes=nfl;seasons=2026/leagues`.
* `probeLeague` — validates a configured id and returns **Yahoo's own league
  name**; `configured_leagues[].name_matches` compares it to the registry's
  expected name. A different name or a `403`/`404` is reported explicitly, never
  smoothed into a success.
* Registry entries `rogers-park` (287140) and `maclin-on-chicks-xvi` (82713)
  already carry `provider: "yahoo"` and `yahoo_league_key: null`. One authorized
  account may only reach one of them — that is expected, not a failure; the
  architecture supports authorizing a second account later (`connection_id`).

## 8. Security controls

* Client secret: env only; used server-side for HTTP Basic at the token
  endpoint; never in a redirect, response, log, or test.
* Tokens: encrypted at rest; never returned by any route (`/status` reports only
  `expires_at` / `expires_in_seconds` / `healthy`); never logged.
* CSRF: 32-byte random `state`, HttpOnly cookie, constant-time compare, single
  use (cookie cleared in the callback).
* `/api/yahoo/diagnostics` is POST + `REFRESH_SECRET` (timing-safe check,
  header-only) so a crawler can't spend Yahoo quota.
* **Yahoo is READ-ONLY** — there is no code path that POSTs/PUTs/DELETEs to
  Yahoo. Scope requested is `fspt-r`.
* Static test `test/yahoo-security.test.ts` asserts no token field is
  serialized by the status route and the authorize URL never contains the
  secret.

## 9. Testing

Deterministic (no network, no real credentials):

| File | Covers |
|---|---|
| `test/yahoo-crypto.test.ts` | GCM round-trip, tamper/other-key rejection, missing-key refusal, passphrase derivation |
| `test/yahoo-oauth.test.ts` | authorize URL, `state` compare, code exchange (+ HTTP/invalid_grant/malformed/non-JSON), refresh, skew, concurrency de-dupe, no-loop, refresh-token retention, config states |
| `test/yahoo-client.test.ts` | success + meta, `NOT_CONNECTED`, 401→refresh→retry-once, second-401 give-up, 403/404/429/5xx/malformed/timeout classification, no token in error text |
| `test/yahoo-games-discovery.test.ts` | dynamic 2026 resolution + cache, wrong-season / missing-game rejection, override only-on-failure, `{game_key}.l.{id}` construction, multi-league discovery, name verification, inaccessible-league cleanliness |
| `test/providers.test.ts` (existing) | Yahoo degraded contract — still green |
| `test/foundation-live.test.ts` (updated) | pre-auth `/api/yahoo/status` + `/api/yahoo/auth/start`; deprecated-alias redirect |

Full suite after this change: **1862 tests, 1858 pass, 0 fail, 4 skipped**
(pre-existing skips). `tsc --noEmit` clean. `eslint` 0 errors / 29 warnings (all
pre-existing, none in Yahoo files).

## 10. Known limitations

* **Live OAuth not exercised.** No `YAHOO_*` env in the build environment and the
  consent step is interactive. Items needing a live run: the actual 2026 game
  key, the real Rogers Park / Maclin name confirmations, and the sub-resource
  probe shapes. Run against a deployment that has the env set (see §11).
* Cross-instance refresh is last-writer-wins (documented above) — acceptable for
  Yahoo's long-lived refresh tokens; a DB advisory lock could tighten it later.
* Yahoo `fantasy_content` parsing in `parse.ts` is intentionally minimal —
  enough for game-key + league metadata + discovery. The full flattener is a
  later phase (`lib/providers/yahoo/canonical.ts` already defines the target
  `YahooFlat*` shapes and is tested against a fixture).
* The migration is written but **not applied** — apply it before the live run.

## 11. Running the live smoke test (Phase 1K)

1. Ensure the Vercel project (or a local `.env.local`) has `YAHOO_CLIENT_ID`,
   `YAHOO_CLIENT_SECRET`, `YAHOO_REDIRECT_URI`, `YAHOO_TOKEN_ENCRYPTION_KEY`,
   `SUPABASE_*`, `REFRESH_SECRET`.
2. Apply `supabase/migrations/20260910120000_bridge_yahoo_oauth_connections.sql`.
3. Visit `…/api/yahoo/auth/start` in a browser, approve on Yahoo.
4. `GET …/api/yahoo/status` → `authorized: true`, `token_healthy: true`.
5. `GET …/api/yahoo/leagues` → resolved `game_key`, `discovered_leagues`,
   `configured_leagues[].name_matches`.
6. `POST …/api/yahoo/diagnostics` with `Authorization: Bearer <REFRESH_SECRET>`
   → per-league metadata/settings/standings/scoreboard/teams/draft/transactions
   reachability + the authorized user's team/roster.

## 12. Recommended Phase 2

* **Normalization:** implement the `fantasy_content` → `YahooFlatBundle`
  flattener behind `YahooProvider.getLeagueState`, feeding the already-tested
  `yahooBundleToCanonical`. Persist the resolved `yahoo_league_key` back onto the
  registry entries (or a small `bridge_yahoo_leagues` table) once validated.
* **Crosswalk:** the Supabase `nfl_players` crosswalk already has `yahoo_id`;
  wire Yahoo `player_key`/`player_id` through `PlayerCrosswalk` in the flattener.
* **Snapshots:** let the existing capture/publish pipeline treat a Yahoo league
  exactly like a Sleeper one (it is provider-agnostic below the provider layer).
* **Second account:** expose `connection_id` in the start/callback routes so the
  friend's account can authorize Maclin on Chick's XVI independently.
