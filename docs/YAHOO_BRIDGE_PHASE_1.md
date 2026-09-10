# Yahoo Fantasy Bridge — Phase 1

> ## ⚠️ TEMPORARY PRODUCTION CERTIFICATION DEPLOYMENT — NOT YET MERGED TO MAIN
>
> Production (`bloodline-bowl-sleeper-bridge.vercel.app`) is currently serving a
> **manually promoted** Vercel deployment of the `yahoo-bridge-phase1-oauth`
> branch. `main` is still at `896e22b` and does **not** contain any Yahoo code.
>
> **Operational consequences:**
> * The **next deployment of `main`** (any unrelated change) will replace this
>   promoted deployment and the `/api/yahoo/*` routes will 404 again until
>   re-promoted or merged.
> * Do **not** assume the Yahoo routes survive a future production deploy.
> * A Vercel **Rollback** to the `main` deployment also removes them.
> * **Phase 1 should be merged to `main` only after final Yahoo live
>   certification succeeds** (Fantasy API access granted + the resume-cert script
>   passes). Until then it stays a branch-only, promoted-for-cert deployment.
> * Rollback target if the promoted deployment misbehaves: the most recent
>   `main` production deployment in the Vercel dashboard → Rollback.

**Status:** OAuth end-to-end **verified live in production** (token issued +
refreshed + persisted encrypted in Supabase; `access_state` reports `CONNECTED`).
**Externally blocked:** every Yahoo Fantasy Sports API call currently returns
**HTTP 403** — the likely cause is that Yahoo has not yet provisioned
application-level Fantasy API access for this Client ID (separate from the OAuth
app being approved). Branch `yahoo-bridge-phase1-oauth`; **not merged**.

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
* **`refresh_seq` column:** present in the schema as a reserved
  optimistic-concurrency guard; **not yet incremented** by the app (PostgREST
  cannot do `col = col + 1` without a stored function, and the in-process dedupe
  + Yahoo's tolerance of parallel refreshes already prevent a torn token). Wiring
  an atomic increment via an RPC is a small, safe future hardening — not Phase 2.

### 4a. Refresh-readiness — verified by deterministic test (no live token touched)

`test/yahoo-oauth.test.ts` + `test/yahoo-token-store.test.ts` cover, with mocks:

| property | test |
|---|---|
| refresh fires within the 120 s skew, not before | "returns the existing token when comfortably fresh (no fetch)" / "refreshes when within the skew window" |
| rotated ciphertext is persisted | token-store "a rotated refresh_token is persisted as new ciphertext" (asserts new envelope, not plaintext) |
| concurrent refreshes dedupe | "de-dupes concurrent refreshes into ONE network call + ONE write" |
| a replacement refresh_token is stored; an omitted one keeps the prior | "keeps the prior refresh_token if Yahoo omits it on refresh" + token-store rotation test |
| no infinite loop / retry storm | "returns REFRESH_FAILED (never loops)" + client "second-401 give-up" |

**Live refresh:** do **not** invalidate the live connection to test this. The
natural opportunity is the first request made > (token lifetime − 120 s) after
authorization — the Supabase row's `last_refreshed_at` / `updated_at` advance and
`token_expires_at` moves forward. To verify later:
`GET /api/yahoo/status`, note `token_expires_at`; wait until < 120 s remain; make
any `/api/yahoo/*` call; `GET /api/yahoo/status` again — `token_expires_at` is
later and `token_healthy` stayed `true` throughout. (In production, `/api/yahoo/status`
itself performs the refresh via `getValidAccessToken`, so simply polling it
across the boundary demonstrates the refresh.)

## 5. Yahoo API client behavior

`YahooFantasyClient.get(path)` → `{ data, meta }`. Always appends `format=json`.
12 s timeout. Error classes (`YahooApiError.kind`): `NOT_CONNECTED`, `AUTH`,
`FORBIDDEN` (403 — token valid, not entitled), `NOT_FOUND` (404),
`RATE_LIMITED` (429/999), `SERVER` (5xx), `MALFORMED` (2xx non-JSON), `TIMEOUT`,
`NETWORK`. `meta` carries `http_status`, `duration_ms`, `refreshed`, and Yahoo's
`x-yahoo-request-id` — never a token.

### 5a. Access-state taxonomy (`lib/providers/yahoo/access-state.ts`)

The OAuth **connection** and the Fantasy API **grant** are separate failures and
the diagnostics never conflate them. `access_state` is the single canonical
field on `/api/yahoo/status`, `/api/yahoo/leagues`, `/api/yahoo/leagues/{id}`,
and `/api/yahoo/diagnostics`:

| `access_state` | meaning |
|---|---|
| `NOT_CONFIGURED` | OAuth app env vars missing |
| `STORAGE_UNAVAILABLE` | configured, but no durable encrypted token store |
| `NOT_CONNECTED` | configured + storage ok, no Yahoo account authorized |
| `TOKEN_EXPIRED_OR_INVALID` | had a token; cannot present/refresh a valid one → re-auth |
| `CONNECTED` | **OAuth healthy AND** the Fantasy API answered (or was not probed) |
| `FANTASY_API_FORBIDDEN` | OAuth healthy; Fantasy API returned **HTTP 403** — app-level Fantasy access likely not provisioned |
| `RATE_LIMITED` | OAuth healthy; Fantasy API 429/999 |
| `NETWORK_ERROR` | OAuth healthy; timeout / transport error / Yahoo 5xx |
| `MALFORMED_RESPONSE` | OAuth healthy; Fantasy API body unparseable |

`describeAccessState("FANTASY_API_FORBIDDEN")` →
*"Yahoo OAuth is connected, but the Fantasy Sports API returned HTTP 403.
Application-level Fantasy API access may not yet be provisioned for this Client
ID."* A 403 is **never** surfaced as "OAuth failed" / "token invalid" / "not
connected", and a persistent 401 (`TOKEN_EXPIRED_OR_INVALID`) is classified
distinctly from a 403 (`FANTASY_API_FORBIDDEN`) and a 429 (`RATE_LIMITED`).

On any non-`CONNECTED` state the discovery/diagnostics code **stops cleanly**:
no `discoverUserLeagues`, no per-league probes (they would all fail the same
way), the game key stays `null` (never guessed), all league arrays stay empty,
and the response is `Cache-Control: no-store` so a 403 is never cached as league
state.

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

Yahoo-specific test files: `yahoo-crypto`, `yahoo-oauth`, `yahoo-client`,
`yahoo-games-discovery`, `yahoo-security`, **`yahoo-access-state`** (taxonomy +
OAuth-ok/Fantasy-403), **`yahoo-token-store`** (encrypt-on-write / rotation).
Full suite after this change: **1892 tests, 1888 pass, 0 fail, 4 skipped**
(pre-existing skips). `tsc --noEmit` clean. `eslint` 0 errors / 29 warnings (all
pre-existing, none in Yahoo files).

## 10. Known limitations

* **Fantasy API returns 403.** OAuth is live and healthy; the Fantasy Sports API
  itself refuses every request (likely: app-level Fantasy access not yet
  provisioned by Yahoo). So the 2026 game key, the real Rogers Park / Maclin name
  confirmations, and the sub-resource probe shapes are **still unverified against
  live data** — `scripts/yahoo-approval-resume-cert.ts` finishes this the moment
  access is granted.
* Cross-instance refresh is last-writer-wins (documented above) — acceptable for
  Yahoo's long-lived refresh tokens; a DB advisory lock / `refresh_seq` RPC could
  tighten it later.
* Yahoo `fantasy_content` parsing in `parse.ts` is intentionally minimal —
  enough for game-key + league metadata + discovery. The full flattener is a
  later phase (`lib/providers/yahoo/canonical.ts` already defines the target
  `YahooFlat*` shapes and is tested against a fixture).
* The migration is **applied** to production (§11a). Live OAuth still not run —
  blocked on operator actions in §11b.

## 11. Live certification progress

### 11a. Done (2026-09-10)

* **Supabase migration APPLIED** to prod `ijpfjdzmaztofawhwepf` — table
  `public.bridge_yahoo_connections` live, RLS enabled + 0 policies (identical to
  the 5 sibling `bridge_*` tables), anon/authenticated INSERT empirically
  blocked, 0 rows. Only new advisor delta = 1 INFO `rls_enabled_no_policy`
  (intended). No unrelated schema/data changed.
* **Branch built & deployed on Vercel** — preview `dpl_DUWqXnbb2pn1TLT9ufdJZQsQLmTX`
  (commit `9a03a79`, branch `yahoo-bridge-phase1-oauth`), `READY`, 7 lambdas,
  turbopack, Node 24 — production-parity runtime.
* **New routes verified on the deployed preview** (Preview env has no `YAHOO_*`,
  by the project's standing convention):
  * `GET /api/yahoo/status` → 200, `session_state: NOT_CONFIGURED`, names the 3
    missing env vars, `encryption_key_present: false`, `token_storage_backend: none`.
  * `GET /api/yahoo/auth/start` → 503 `NOT_CONFIGURED` (not a broken redirect).
  * `GET /api/yahoo/leagues` → 503 `NOT_CONFIGURED`, empty arrays (no fabrication).
  * `GET /api/auth/yahoo/status` → 308 → `/api/yahoo/status` (deprecated alias).
  * `GET /api/providers` → Sleeper `READY`, Yahoo `NOT_CONFIGURED`. Sleeper
    behaviour unchanged.
* **Production (`main` @ `896e22b`) inspected** — old scaffolding is live;
  `/api/auth/yahoo/status` reports `configured:true` so `YAHOO_CLIENT_ID` /
  `YAHOO_CLIENT_SECRET` / `YAHOO_REDIRECT_URI` are already in the Production
  env; persistence backend `supabase` `READY` so `SUPABASE_*` present;
  `REFRESH_SECRET` present (prior gate history). `/api/yahoo/*` 404s on prod
  (branch not deployed there).
* **Vercel deployment protection:** SSO `all_except_custom_domains` — preview
  URLs are login-walled, so the OAuth callback must land on the **production
  domain**, not a preview URL.

### 11b. Blocked on operator actions (cannot be done from this session)

1. **Add `YAHOO_TOKEN_ENCRYPTION_KEY` to the Vercel *Production* environment**
   (32 bytes: `openssl rand -hex 32`, or a long passphrase). New in this branch;
   almost certainly not set yet. Without it `/api/yahoo/auth/start` returns 503
   `STORAGE_UNAVAILABLE` and refuses to start a flow it cannot finish.
2. **Confirm the Production `YAHOO_REDIRECT_URI` value is exactly**
   `https://bloodline-bowl-sleeper-bridge.vercel.app/api/yahoo/oauth/callback`
   (the old scaffolding used `/api/auth/yahoo/callback`; update if so), **and
   that the identical URI is registered in the Yahoo Developer app**.
3. **Make `/api/yahoo/*` available on the production domain without merging to
   `main`:** in Vercel, **Promote** the `yahoo-bridge-phase1-oauth` deployment
   to Production (Deployments → the `9a03a79` build → ⋯ → *Promote to
   Production*, or `vercel promote <deployment-url>`). This is precedented in
   this project (`dpl_CAZUZexaeAqaqkXfZwRUKUBKcUqy` was an `action: promote` from
   a non-`main` branch). Reversible in one click via *Rollback* to the current
   `main` production deployment (`dpl_BE3RkchWyrMjjwPgeU2npvbJnnGh`).
   *Add the env var (step 1) BEFORE promoting so the build binds it.* If the
   build predates the env var, push an empty commit to the branch (or redeploy)
   to rebuild, then promote.

### 11c. Done (2026-09-10, later) — OAuth live, Fantasy API 403

* Operator set `YAHOO_TOKEN_ENCRYPTION_KEY` + confirmed `YAHOO_REDIRECT_URI` on
  Production, then **manually promoted the branch build to Production** (see the
  banner at the top of this doc).
* Operator completed the interactive Yahoo consent at
  `…/api/yahoo/auth/start`. Verified live on production:
  * `GET /api/yahoo/status` → HTTP 200, `access_state: "CONNECTED"`,
    `authorized: true`, `token_healthy: true`,
    `encryption_key_present: true`, `token_storage_backend: "supabase"`,
    access token expiring ~1 h out.
  * Access token **and** refresh token issued and **persisted encrypted** in
    `bridge_yahoo_connections` (Supabase).
* `GET /api/yahoo/leagues` → HTTP 200 with `Cache-Control: no-store`,
  `access_state: "FANTASY_API_FORBIDDEN"`, `game_key: null`, empty league
  arrays. Underlying:
  * `GET /users;use_login=1/games;game_codes=nfl` → **HTTP 403**
  * `GET /games;game_codes=nfl;seasons=2026` → **HTTP 403**
* This is **not** an OAuth failure. The likely external condition: Yahoo has not
  yet provisioned application-level Fantasy Sports API access for this Client ID
  (a review separate from the OAuth app existing). Reported as
  `FANTASY_API_FORBIDDEN`, not "OAuth failed" / "token invalid".

### 11d. Resume certification (run the moment Yahoo grants Fantasy API access)

```bash
YAHOO_CERT_BASE=https://bloodline-bowl-sleeper-bridge.vercel.app \
REFRESH_SECRET=…  npx tsx scripts/yahoo-approval-resume-cert.ts
```

`scripts/yahoo-approval-resume-cert.ts` — read-only; sanitizes all output; never
prints the secret/tokens; **stops cleanly** (exit 2) while still
`FANTASY_API_FORBIDDEN`/`RATE_LIMITED`; **never guesses** the game key;
treats an inaccessible `Maclin on Chick's XVI` as `SKIP` (authorize a second
account later) but an inaccessible `Rogers Park` as `FAIL`. It walks, in order:
`/api/yahoo/status?probe=1` → `/api/yahoo/diagnostics` (identity → dynamic 2026
game key → user league discovery → Rogers Park `287140` → Maclin `82713` →
metadata/settings/teams/standings/scoreboard/draftresults/transactions →
current user's team/roster) → the two `/api/yahoo/leagues/{slug}` detail
endpoints. Exit `0` = fully certified, `2` = still externally blocked, `1` =
internal failure.

After a green run: confirm `bridge_yahoo_connections` still holds exactly one
row with non-empty `*_encrypted` and a future `expires_at`, confirm no Yahoo
write occurred, then persist the resolved `yahoo_league_key`s (or defer to
Phase 2), and only then consider merging Phase 1 to `main`.

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
