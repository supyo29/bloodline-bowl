# Yahoo Market State — provider audit, implementation and certification

Branch `provider-yahoo-market-state` (stacked on `intelligence-convergence-w2-p1-role-opportunity` @ `86e8190`; **not** `main`). Nothing merged, deployed, migrated, scheduled or enabled.
Yahoo was only ever READ (GET). No token was read, printed or stored. Production was not modified.

## 0. Verdict

Bloodline can now answer **"who is actually available to add in this Yahoo league right now?"** from Yahoo's own per-player statuses, distinguish free agents from claim-only waiver
players, keep unknown separate from available, and rank those players with the real waiver engine — verified on live Yahoo data for both leagues.

**Two limits you need to know about (details §6):**
1. The new *direct-from-Yahoo* reads (league settings, user teams, pending claims) are fixture-tested but **not live-run**: that needs the connected account's OAuth token, which exists only in production. Live certification below used the deployed bridge's public read-only endpoints as a Yahoo-sourced transport (§4). Authorization needed to close this — see §7.
2. `Dynamic VOR` can consume this now; K / D-ST weekly *values* are still the provider's standard points (warning preserved), as instructed.

## 1. Audit of the existing Yahoo adapter

| Area | Where | Finding |
|---|---|---|
| OAuth / tokens | `oauth.ts`, `token-store.ts` (Supabase, encrypted, per `connection_id`), `crypto.ts` | Durable, per-connection, refresh-then-retry-once. The only code that POSTs (token endpoint only). |
| Connection binding | `connections.ts`, registry `yahoo_connection_id` | Maclin → `maclin`, Rogers Park → `primary` (default). |
| Client | `client.ts` | **GET-only by construction** (one method). Classified errors (AUTH/FORBIDDEN/RATE_LIMITED/TIMEOUT/…). Reused, not duplicated. |
| League state / rosters / scoring | `fetch.ts`, `canonical.ts`, `scoring.ts` | Existing: identity, settings (roster slots, stat mods, `waiver_type`, `uses_faab`), standings (FAAB balance, waiver priority), per-team roster, transactions, scoreboard. |
| **Player pools** | `players.ts` | **Already existed and is correct:** `status=FA|W|T` queries, 25/page, waves of 4, end-of-pool detection, ownership sub-resource, safety limit, time budget. Used only by `/api/yahoo/.../players/available`. |
| Transactions | `fetch.ts` | Paged; no fantasy-week field. |
| Caching | none for pools | Pools were never cached or fed to the market-state layer. |
| **Root cause of `FREE_AGENT_POOL_UNAVAILABLE`** | `lib/market-state/load.ts` | The market-state substrate was **Sleeper-only**: for any non-Sleeper league it built a snapshot with every source `UNAVAILABLE` ("league is not a registered Sleeper league") → exactly the four reported codes. Yahoo was never wired in; its pool reader sat unused. |
| Identity | `canonical/players.ts` | Crosswalk covers a small slice (`supabase:nfl_players:266`). A Yahoo player with no crosswalk row became `player:yahoo:<id>` and **never joined the Sleeper-keyed projections** (live: 4 of 15 roster players projected). |

## 2. What Yahoo exposes (and what it does not)

| Need | Yahoo source | Status |
|---|---|---|
| Player universe, ownership, FA vs waiver | `/league/{key}/players;status=FA|W|T` (+`/ownership`: type, `waiver_date`, owner team) | Live-verified. Availability is **stated per player**. |
| All rosters | `/team/{key}/roster` ×teams | Live-verified; reconciled against the T pool. |
| FAAB balance / waiver priority per team | standings | Live-verified (Rogers Park: FAAB balances + priority). |
| Waiver type / rule / time / add limits | `/league/{key}/settings` | Parsed verbatim; **exact key names unconfirmed live** (kept raw, never guessed). |
| Waiver clear | a **DATE** (`YYYY-MM-DD`), not an instant | Live-verified. Never promoted to an instant. |
| Game-lock semantics | Yahoo applies its own rule (`waiver_rule`, e.g. gametime); its **`W` status already reflects it** | Per-player game state reported as a fact; no Bloodline-invented lock. |
| Pending claims | only for a team the authenticated account **owns** | Implemented read-only; **not live-run** (no owned team detected on either connection). |

## 3. What was built

**Provider-neutral contract** (`lib/market-state/contract.ts`, additive; Sleeper output byte-identical): `MarketProvider = sleeper | yahoo`; per-player `availability_evidence { basis: PROVIDER_STATUS, provider_status }`, `claimable`, `waiver_clears_on`, `pending_claim`; snapshot `pending_claim_visibility`, `game_lock_semantics`, `pool_evidence` (per-pool pagination), `freshness` (observed_at / age / state), `ownership_reconciliation`; **readiness axes** `availability / valuation / transaction / recommendation`.

**Pure builder** `yahoo-build.ts`: a player is `AVAILABLE_FREE_AGENT` / `ON_WAIVERS` **only** when Yahoo's own FA / W status returned him, he is on no roster and in no second pool; otherwise `UNKNOWN_AVAILABILITY` (`OWNERSHIP_CONFLICT`). Enforced structurally in `integrity.ts` — "unrostered" cannot become "available". K and D/ST first-class; D/ST = `defense:nfl:<team>` through the repo's alias-safe resolver (JAX/JAC, WAS/WSH, LA→LAR; "New York"/"Los Angeles" ambiguous → UNKNOWN).

**Loader** `yahoo-load.ts`: reuses `YahooProvider` (new `openReadHandle`), the GET-only client, and the existing pool reader (raw per-pool rows, so cross-pool conflicts stay visible). Connection comes **only** from the registry binding and is re-validated. Freshness: 90 s memo → cheap transaction-feed fingerprint revalidation → full re-read; nothing older than the 10-min substrate ceiling is served as live. `loadMarketSnapshot` dispatches Yahoo leagues to it; every existing consumer (weekly engine, Waiver 2.0, Book-Ready, orchestrator) gets Yahoo automatically.

**Identity bridge** (`canonical/yahoo-sleeper-bridge.ts`, opt-in on `PlayerCrosswalk`): Yahoo has no cross-provider id, so a Yahoo player maps to the Sleeper identity **only** on a unique active name+position+team match (never name alone; ambiguity ⇒ unmapped). Fallback for the ~310 active Sleeper players whose `team` is null (offseason signees): unique name+position with no other same-name same-position player carrying a team, flagged `team_unverified`, confidence `low`.

**Weekly integration**: certification by **canonical identity** (not Sleeper id); FA vs claim-only distinct (`acquisition.method`); unrostered-but-unverified players demoted; **replacement level now comes from the verified pool**; Waiver 2.0's pool reduction made provider-neutral; the real waiver engine ranks Yahoo players and labels each add `FREE_AGENT_ADD` / `WAIVER_CLAIM` with the clear date.

**Readiness redesign**: pool certainty ≠ transaction certainty. Pending-claims-unavailable, missing waiver settings, unknown game locks, a down transaction feed are *limitations*, not blocks. Blocks remain for: pools unreadable, no ownership evidence, stale data, integrity violations. Fail-closed is unchanged.

**Exposure**: waiver response gains `market_pool` (+ `readiness_axes`) — counts of verified FA / waivers / unknown, projection coverage, a named sample of verified players with no projection, per-position, rules, FAAB/priority per manager, pending-claim visibility, pagination evidence, freshness, scoring fingerprint and the K/D-ST approximation flag. New read-only route **`GET /api/league/{league}/market?view=summary|pool&position=&status=`** (discovery-registered, `expensive` rate class). Book-Ready `market.state` extended (claimable count, axes).

**Defects found and fixed along the way** (not asked for; each tested):
- `probeUserTeams` read Yahoo's nested team shape with a one-level merge → a real owner would be reported as "owns no team" (probable false negative for pending-claim visibility). Fixed; also cross-checked with the standings' `is_current_login`.
- Yahoo canonical league **invented a FAAB budget of 100** (hard-coded). Now `null` (unknown); real per-team remaining balances are unchanged.
- Pool read budget computed from an injectable clock but enforced against the real one (found by the first test run).

## 4. Live certification (read-only; Yahoo-sourced via the deployed bridge's public GET endpoints; new loader/builder/engine run locally)

Evidence: `docs/evidence/yahoo-market-live-replay-{rogers-park,maclin}.json`. Script: `scripts/yahoo-market-live-replay.ts`.

| Capability | Maclin (`maclin`) | Rogers Park (`primary`) |
|---|---|---|
| OAuth | league READY / CONNECTED (deployed) | CONNECTED, token healthy (deployed) |
| Player universe | 1,010 FA + 18 W + 168 rostered | 0 FA + 985 W + 155 rostered |
| Full pagination | FA 44 pages, W 4, T 8 — all `end_of_pool` | FA 4 (empty), W 40, T 8 — all `end_of_pool` |
| League rosters | 10 teams / 168 players | 10 teams / 155 players |
| Ownership | roster union = Yahoo rostered pool (168 = 168, 0 conflicts) | 155 = 155, 0 conflicts |
| Verified free agents | 1,010 | 0 (real: every unrostered player is on waivers Tuesday night) |
| Verified waivers | 18 (clear 2026-10-15/16) | 985 (clear 2026-10-14) |
| K | 42 FA + 3 W | none — the league has no K slot; Yahoo lists none |
| D/ST | 16 FA + 4 W (all `defense:nfl:*`) | 22 W (all `defense:nfl:*`) |
| Scoring | exact fingerprint `scoring:v1:4739a8…`; K/D-ST weekly **approximated (warning preserved)** | `scoring:v1:91d06d…`; same K/D-ST note |
| FAAB / priority | priority league (raw settings not read in replay) | FAAB: per-team balances + priority; budget **unknown (no longer invented)** |
| Pending claims | UNAVAILABLE (reason stated) | UNAVAILABLE (reason stated) |
| Game locks | Yahoo's W status reflects its rule; raw rule not live-read | same |
| Cross-check vs Yahoo | 61 players re-looked-up independently: **0 mismatches** | 43: **0 mismatches** |
| Identity | 1,013 / 1,028 acquirable resolved; 168/168 rostered | 970 / 985; 155/155 rostered (was 665 before the null-team fallback) |
| Waiver recommendations | `justin`: roster 14/17 projected, 491 considered, 1 recommendation (LOW) | `john`: roster **14/15 projected (was 4/15)**, 462 considered, 8 recommendations (all `WAIVER_CLAIM`, each with the drop it requires) |
| Dynamic VOR ready | yes (see §5 Q10) | yes |

## 5. The ten questions

1. **Can Bloodline retrieve the actual Yahoo free-agent list?** Yes — live on both leagues (Maclin 1,010; Rogers Park 0 because everyone is on waivers right now). Via the new direct path: implemented and tested, not live-run (§6).
2. **Free agents vs waiver players?** Yes, from Yahoo's own `FA`/`W` status, kept distinct end to end (Maclin 1,010 vs 18).
3. **Unknown vs available?** Yes. Contradictory ownership, ambiguous identity, partial pools → `UNKNOWN_AVAILABILITY`; integrity forbids availability without Yahoo's status. Live: 0 unknown (clean reads).
4. **All rosters?** Yes — every team; the union equals Yahoo's own rostered pool on both leagues.
5. **K and D/ST?** Yes, where the league has them (Maclin both; Rogers Park D/ST only — no K slot).
6. **Isolation?** Enforced in code (registry binding + handle check), unit-tested, and **mutation-tested** (swap + removed check both killed). Live token isolation was not independently observed.
7. **Can the waiver engine rank Yahoo players now?** Yes — real engine, real data, certified pool, replacement from the verified pool.
8. **Genuine provider limitations?** Pending claims only for an owned team; waiver clear is a date; the exact game-time add rule is Yahoo's own (we preserve it, we don't re-derive it). **Not** provider limits: K/D-ST weekly scoring (ours, W2.R1) and the FAAB budget (unread, not unavailable).
9. **P0 / P1?** None found in the new code. P2/P3 in §6.
10. **Safe to feed W2.R1 Dynamic VOR?** Yes for availability and the replacement pool (same provider-neutral engine as Sleeper; `acquirablePlayers`, `by_position`, `claimable`). Treat K/D-ST values as approximated and valuation as PARTIAL until W2.R1.

## 6. Findings and honest limits

- **Not live-verified (needs the account's token):** `fetchYahooLeagueSettings` acquisition fields (waiver_rule/waiver_time/max_adds — names unconfirmed, preserved raw), `probeUserTeams` nested-shape fix, pending-claims read (owned-team path), the real token-refresh behavior under the new load. All fixture-tested; mutation-tested.
- **P2 behavior change on deploy:** the identity bridge changes Yahoo players' canonical ids from `player:yahoo:<id>` to the Sleeper/GSIS form (this is the point — projections join), so Yahoo snapshot lineage hashes change once. Anything keyed on `player:yahoo:` ids would break (none found in the repo).
- **P2 latency/quota:** an uncached Yahoo market read is ~50 paginated Yahoo requests (~6 s measured via the bridge). Mitigated by a 90 s memo + 1-request revalidation, but `/api/waivers`, `/api/intelligence`, `/api/evidence?topic=market.state` for Yahoo leagues now fan out to Yahoo. The new route is `expensive`; the existing ones are `standard`.
- **P2:** Yahoo market snapshots become eligible for the existing market-history telemetry hook (compact snapshot, no schema change) when deployed.
- **P2 (pre-existing, found):** Sleeper replacement level is still computed from "unrostered projected players", not the certified pool (changing it would alter Sleeper outputs; out of scope). `test/waiver2-integration.test.ts` file-hash pins were already stale on the W2.P1 tip (4 of 7); re-baselined here with the reason in the test.
- **P3:** `waiver_model` is `unknown` for Yahoo priority leagues whose `waiver_type` vocabulary is unmapped (raw value preserved in `market_pool.rules`). 3 routes predating this work are unadvertised in discovery (`test/discovery-route-coverage`).
- Observed: some D/ST rows have no weekly projection (likely teams on bye) — not investigated.

## 7. Verification

- New tests: **118** across 6 files (pure builder 34, loader 31, weekly 18, bridge 17, parsers 10, architecture/read-only 8). Full repo: **3,811 tests, 82 failing vs baseline 83 — zero new failures**; one pre-existing failure fixed (the stale pins).
- Read-only guarantee: transport exposes only `get`; static scans prove no module on the path names a write verb, helper, endpoint or payload and that only OAuth POSTs (token endpoint only); runtime recorder proves GET-only on a full load.
- Mutation suite `scripts/yahoo-market-mutation-suite.py`: **37 / 37 killed**, files restored byte-for-byte (every mutation the brief lists plus regressions found while building). Two survivors on the first run exposed real test gaps (the loader's own default reads were not exercised; fixture ids hid an id-matching bug) and were closed.

**To close the live gap (your call):** either (a) authorize pulling the Yahoo OAuth app config + token-store access into a local, untracked environment for one read-only run — note a token **refresh writes the rotated token back to production's `bridge_yahoo_connections`**, so this should be done once, deliberately, with the deployed app idle; or (b) authorize a Vercel **preview** deployment of this branch, which would run the new code on Vercel with the app's own env. Neither has been done.


## Strict read-only (no-refresh) live certification mode

`YahooProvider({ readOnly: true, tokenStore })` / `YahooFantasyClient({ readOnly: true })` use only a *current access token*:
the refresh endpoint is never reached, no POST is possible, `store.set/clear` are never called (`NoRefreshTokenStore` throws and counts attempts, holds no refresh token),
an expired token or a Yahoo 401 fails with `AUTH_REFRESH_REQUIRED_READ_ONLY` (degraded `AUTH_REQUIRED`). Production (non read-only) refresh behavior is unchanged (existing tests).
Tests: `test/yahoo-readonly-auth.test.ts`; mutants Y32-Y36 (Y36 = provider pre-check duplicating the client guard, documented equivalent).

Live gate: `YAHOO_ACCESS_TOKEN_MACLIN=... YAHOO_ACCESS_TOKEN_PRIMARY=... node --import tsx scripts/yahoo-live-readonly-cert.ts`
(tokens only from the environment; never printed or persisted; whole-run enforcement of GET-only / no token-endpoint / no store writes).
Without a token it exits 3 with `LIVE_CERT_BLOCKED_NO_SAFE_ACCESS_TOKEN`.

**Status 2026-10-14: LIVE_CERT_BLOCKED_NO_SAFE_ACCESS_TOKEN** - no safe access token available in this environment; no Yahoo request was made by the new loader.

## Permanent token lifecycle (no manual maintenance)

`getValidAccessToken` (lib/providers/yahoo/oauth.ts): refresh within 120 s of expiry or on a 401 (one retry); in-process single-flight per (client, connection, guid);
cross-instance rotation is a compare-and-swap on `refresh_seq` (ONE `UPDATE ... WHERE connection_id AND refresh_seq`, both ciphertexts + provenance in the same statement);
a CAS loser or an `invalid_grant` loser re-reads the store and ADOPTS the sibling's rotation; a rotation Yahoo issued but the store could not persist is retried and held in memory
(re-persisted before any further refresh); a genuine `invalid_grant` on the still-stored refresh token => `reauthorization_required`; every failed refresh serves NO token.
`GET /api/yahoo/health` (credential-free; per connection) and `GET /api/cron/yahoo-health` (daily 10:00 UTC keep-alive; refreshes only inside a 30-min window, then one read-only probe).
Tests: test/yahoo-token-lifecycle.test.ts (16), test/yahoo-health-job.test.ts (2); mutants Y37-Y47 all killed. No migration is required (`refresh_seq`, `last_refreshed_at`, `last_used_at` already exist).
Known limitation: "last refresh failure" is per server instance (not persisted; no column exists and no migration was authorized).
