# Bloodline Bowl — Sleeper Data Bridge

A small, read-only service that turns the **Bloodline Bowl** fantasy football league into a
single, self-describing JSON document an AI can fetch and reason about directly.

Point any model at one URL:

```text
https://bloodline-bowl-sleeper-bridge.vercel.app/api/league
```

…and it can answer "who owns each team", "what does every roster look like", "who holds which
draft picks", and "what are the scoring rules" without a single screenshot or manual export.

During the draft, point it at `/api/draft` instead for a live war-room view: who has been taken,
what they cost, who is left, and exactly how much each rival can still bid.

To evaluate the league's scoring rules — is a rushing QB favored over a pocket passer, does the
reception value overvalue possession receivers, how would a small scoring tweak ripple across
positions — point it at `/api/scoring`.

**This bridge serves more than one league.** Every endpoint accepts an optional `?league=`
selector; omit it and you get the default league (Bloodline Bowl). See
[Multi-league support](#multi-league-support) below.

| Key                        | League              | Sleeper league ID     | Sleeper account |
| -------------------------- | ------------------- | --------------------- | --------------- |
| `bloodline-bowl` (default) | Bloodline Bowl      | `1395549281678532608` | supyo29         |
| `devoted-to-the-game`      | Devoted to the Game | `1389735763649761280` | darthmarker     |

---

## What it does

Sleeper's public API is normalized for storage, not for analysis. Rosters are arrays of opaque
player IDs, managers are separate from teams, lineup slots are positional, and traded picks only
appear when they've changed hands. This bridge does the joins:

| Sleeper gives you                                | The bridge gives you                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `"players": ["4046", "6794"]`                    | Full player objects with name, position, NFL team, age, injury status     |
| `owner_id` on a roster, users in a separate call | A `manager` object attached to each team                                  |
| `"starters": ["4046", "0", …]` positional array  | Each starter paired with the lineup slot it fills, empty slots flagged    |
| Only _traded_ picks                              | Every roster's complete pick inventory, filed under its current owner     |
| A 14 MB player database                          | Only the players this league actually references                          |
| Terse settings like `waiver_type: 2`             | A `key_settings` gloss (`"waiver_type": "faab"`) alongside the raw values |

Original Sleeper IDs are preserved everywhere, so nothing is lost for debugging or future joins.

---

## Multi-league support

This bridge fetches everything live from Sleeper per request — there is no database and no
background sync job. "Adding a league" is therefore not an ingestion pipeline; it's registering a
memorable name for a Sleeper league id.

### How league selection works

Every endpoint accepts an optional `?league=` query parameter, resolved by
`resolveLeagueId()` (`lib/sleeper/service.ts`) in this order:

1. **An explicit `?league=` selector**, if given. It can be either:
   - a **registry key** (e.g. `devoted-to-the-game`) — the friendly, documented handle, or
   - a **raw numeric Sleeper league id** (e.g. `1389735763649761280`) — always works, whether or
     not that league is in the registry. The registry is a naming convenience, not an allowlist.
2. The `SLEEPER_LEAGUE_ID` environment variable, for local overrides/testing.
3. The default registry target (`bloodline-bowl`).

An unrecognized _non-numeric_ selector is rejected with `400` by `parseLeagueSelector`
(`lib/analytics/query.ts`) before any Sleeper call is made — the same allowlisted-query-parameter
contract every other input in this bridge follows (`?season=`, `?week=`, `?position=`, …).

```bash
curl "https://bloodline-bowl-sleeper-bridge.vercel.app/api/league?league=devoted-to-the-game"
curl "https://bloodline-bowl-sleeper-bridge.vercel.app/api/scoring?league=1389735763649761280"
```

### The league registry

`lib/leagues/registry.ts` holds the known leagues as a small typed list:

```ts
const LEAGUE_TARGETS: LeagueTarget[] = [
  {
    key: "bloodline-bowl",
    provider: "sleeper",
    league_id: "1395549281678532608",
    display_name: "Bloodline Bowl",
    sleeper_username: "supyo29",
    sleeper_user_id: "1308955807408230400",
    enabled: true,
  },
  {
    key: "devoted-to-the-game",
    provider: "sleeper",
    league_id: "1389735763649761280",
    display_name: "Devoted to the Game",
    sleeper_username: "darthmarker",
    sleeper_user_id: "1265419589680910336",
    enabled: true,
  },
];
```

This is the "simplest repository-appropriate configuration mechanism" for this codebase: the
bridge has no database, no CSV-parsing dependency, and no existing config-file convention, so a
typed in-source array — consistent with how the original single-league id was already declared
(`BLOODLINE_BOWL_LEAGUE_ID`) — stayed the most native fit. Nothing here is a proxy for Sleeper
credentials; Sleeper's read endpoints need none.

**`display_name` is a fallback label only.** Every response's actual league name always comes from
Sleeper's own live `league.name` for that league id — confirmed live for Devoted to the Game, whose
Sleeper-returned name already matches the registry's fallback exactly. The registry's name is never
used to override what Sleeper returns; it exists so the status page and error messages have
something to show before any Sleeper call has been made.

### Validation and safety

`getLeagueRegistry()` (backed by the pure, independently-testable `validateAndDedupeTargets()`)
loads the static list every call and:

- **Drops a malformed entry** (missing `key`, non-numeric or empty `league_id`) with a warning,
  rather than crashing route resolution — the same fail-safe contract every other config-shaped
  input in this bridge follows.
- **Deduplicates by `provider:league_id`.** If the same Sleeper league were ever listed under two
  different keys, only the first is kept — this is what stops a league from being served twice if
  it's reachable more than one way.
- **Honors `enabled: false`.** A disabled entry is parsed and kept visible (e.g. for
  `/api/health`'s `available_leagues` listing context) but never resolves via `findLeagueTarget`,
  so `?league=<disabled-key>` behaves exactly like an unregistered key.

All three guarantees — plus the safe fallback for an unrecognized `?league=` selector — are covered
by deterministic unit tests
(`test/leagues-registry.test.ts`) against synthetic fixtures — not just the real two-league list —
so the safety properties hold regardless of what's currently registered.

### Isolation

Each league is completely independent. Every route resolves one `league_id` per request and fetches
that league's own scoring settings, rosters, matchups, and transactions from Sleeper fresh — nothing
is merged, averaged, or compared across leagues by this bridge. (Confirmed live: Bloodline Bowl is
half-PPR; Devoted to the Game is full-PPR, 12 teams, and a snake draft — querying one never leaks the
other's settings, and each league's own live team count and draft type are always read from Sleeper
rather than assumed.) The only thing genuinely shared across leagues is
the module-scoped `/players/nfl` metadata cache — player identity (name, position, team), not
scoring or roster context — which carries no per-league state and is exactly the kind of shared
reference data that's safe to cache once.

Cross-league analysis (e.g. "compare scoring philosophies across my leagues") is something an AI
consumer can do by calling this bridge twice, once per `?league=`, and reasoning over both
responses itself — this bridge does not do that comparison internally, by design.

### Adding another league

Append one object to `LEAGUE_TARGETS` in `lib/leagues/registry.ts` — nothing else needs to change.
No route, no service function, and no other file references league ids directly; they all go
through `resolveLeagueId()`/`findLeagueTarget()`. Duplicate keys or league ids are caught by the
existing validation (see above), so a copy-paste mistake fails safely instead of silently shadowing
an existing league.

---

## Canonical routing: league identity ≠ manager identity

Two identity dimensions that are resolved separately and must never be conflated:

1. **Which league** is being requested?
2. **Which manager inside it** is asking for personalized data?

A **league** route exposes shared, league-wide data (settings, scoring, draft board, picks, available
players, standings). A **manager** route additionally exposes that one manager's Sleeper identity,
roster, roster id, draft slot, picks, positional needs, and personalized recommendations.

### Path routes (preferred — AI-friendly, no query-string construction)

```text
GET /api/leagues                                          # discovery: every league + its URLs
GET /api/leagues/:leagueSlug                              # league overview + manager routing table
GET /api/leagues/:leagueSlug/draft                        # league draft state
GET /api/leagues/:leagueSlug/snapshot
GET /api/leagues/:leagueSlug/scoring
GET /api/leagues/:leagueSlug/managers                     # every manager in the league (live)
GET /api/leagues/:leagueSlug/managers/:managerSlug        # ONE manager's identity + roster
GET /api/leagues/:leagueSlug/managers/:managerSlug/draft  # personalized draft state + best-available candidate list
GET /api/leagues/:leagueSlug/managers/:managerSlug/recommendations  # snake decision engine (ri-snake-decision-2026.1)
GET /api/leagues/:leagueSlug/managers/:managerSlug/snapshot
```

**`/draft` vs `/recommendations` (Phase 4 §3).** `.../draft` returns the raw
draft state plus a needs-filtered best-available **candidate** list (Sleeper
`search_rank`). `.../recommendations` is the actual **decision engine**: snake
turn geometry, gap-relative tier cliffs, a provisional survival interface,
positional-run detection, reach cost, roster-construction risk, an uncertainty
treatment, evidence-backed reason strings — and, on the snake turn (BijiMac,
slot 12), **two-pick turn-pair optimisation** rather than two independent picks.
`SNAKE_ONLY`: an auction draft returns `UNSUPPORTED_MODE`. See
`lib/draft/README.md`.

Flat aliases (same handler, same resolver): `/api/draft/:leagueSlug`, `/api/snapshot/:leagueSlug`,
`/api/scoring/:leagueSlug`.

### Canonical routes for the three known managers

| Manager | Sleeper username | League | Manager route |
| --- | --- | --- | --- |
| `supyo29` | `Supyo29` | `bloodline-bowl` | `/api/leagues/bloodline-bowl/managers/supyo29` |
| `bijimac` | `BijiMac` | `bloodline-bowl` | `/api/leagues/bloodline-bowl/managers/bijimac` |
| `darthmarker` | `DarthMarker` | `devoted-to-the-game` | `/api/leagues/devoted-to-the-game/managers/darthmarker` |

Append `/draft` or `/snapshot` for the personalized draft / snapshot views. Slugs and Sleeper
usernames are case-insensitive on input; responses and links always use the lowercase slug.

### For an AI client

To get **personalized** draft guidance, use a **manager** route — e.g. for Supyo29's Bloodline Bowl
draft: `https://<domain>/api/leagues/bloodline-bowl/managers/supyo29/draft`. The response's
`context` object and `manager.recommendation_context` state exactly which league, manager, roster id,
and draft slot were resolved, and the roster the recommendation engine reasoned over — so the client
can verify it, not just trust the label.

### Legacy compatibility

`?league=` still works and resolves through the **same** registry (`findLeagueTarget`) and
numeric-id rule as the path form. Only the fallback differs: the query form still defaults to
Bloodline Bowl when `?league=` is omitted; the path form **requires** a slug and returns `404` for an
unknown one.

### Identity resolution rules (`lib/leagues/resolve.ts`)

- Manager identity is **never** inferred from commissioner status, league ownership, "the first
  roster/manager Sleeper returned", array order, a previous request, an env var, a hard-coded user,
  roster number alone, or draft slot alone.
- A manager slug resolves via the canonical registry (`lib/leagues/managers.ts`, three known
  managers with verified Sleeper `user_id`s) **or**, for anyone else, a live Sleeper user lookup —
  so the architecture stays generic (`league → manager → resource`) as more managers join.
- League membership is **validated live** every request: the manager's `user_id` must own (or
  co-own) a roster in the requested league. `roster_id` and `draft_slot` come from that league's
  data only. A manager who is not in the league is an explicit `404 manager_not_in_league` — **never**
  a fallback to another manager. `bloodline-bowl + darthmarker`, `devoted-to-the-game + bijimac`, and
  `devoted-to-the-game + supyo29` all 404.
- Same numeric `roster_id` in two leagues (BijiMac is roster 2 in Bloodline Bowl, DarthMarker is
  roster 2 in Devoted to the Game) and the same draft slot in two leagues never collide, because
  every lookup is scoped to one resolved `league_id`.

### Caching

All Sleeper fetches go through Next's data cache keyed by the upstream URL (`/league/<id>/...`), so
they are inherently per-league-id. CDN caching is keyed by the request URL, so
`/api/leagues/bloodline-bowl/managers/supyo29/draft` and `.../bijimac/draft` are distinct cache
entries. There is **no** module-level manager/roster/league state and no in-memory manager cache;
the only shared module-scoped cache is the league-agnostic `/players/nfl` player index.

---

## Draft Bridge (`/bridge`)

An interactive, **league-isolated** draft-night board. Unlike the JSON endpoints, the Bridge holds
per-league draft state (locally, in the browser) and produces a self-identifying ChatGPT snapshot.

### One league at a time, never mixed

There is no single "Bridge state". Each league is a completely separate draft environment with its
own identity, rules, model profile, rankings, draft geometry, ledger, roster, and snapshot. The
league selector at the top switches between them; the active league is shown in the top bar and a
large safety banner at all times (name, slot, model/profile, scoring hash, Sleeper ids) — never by
colour alone.

| Bridge league key      | Registry key          | Sleeper league        | Manager             | Draft            |
| ---------------------- | --------------------- | --------------------- | ------------------- | ---------------- |
| `bloodline_bowl`       | `bloodline-bowl`      | `1395549281678532608` | supyo29 (slot 7\*)  | snake, 15 rounds |
| `devoted_to_the_game`  | `devoted-to-the-game` | `1389735763649761280` | DarthMarker (slot 4) | snake, 16 rounds |

\* Sleeper's live `draft_order` puts supyo29 at slot 7. The multi-league addendum referenced
"Slot 12" for Bloodline; that is not what Sleeper reports, so the slot is user-confirmable in the UI
(`Confirm your draft slot`). DarthMarker's slot 4 **is** confirmed from Sleeper's live draft order.

`lib/bridge/profiles.ts` is the source of truth for each league's frozen identity/rules/model.
`lib/bridge/board.ts` fetches that league's own live Sleeper data and warns on any drift from the
frozen profile (it always uses the live values). State lives in `localStorage` under
`bbb.bridge.state.v1.<league_key>` — one key per league.

### Model identity & ranking source

The Bridge ranks each league's board from one source, chosen per league and always labelled in the
UI and the snapshot (`ranking_quality.status`):

- **`devoted_to_the_game` — a vendored ranking pack (`ranking_quality: MODEL`).**
  `lib/bridge/ranking-packs/darthmarker_2026_ranking_pack.json` is the Roster Intel **v7** DarthMarker
  draft board (240 players, every row carrying a direct Sleeper id), imported verbatim by
  `scripts/build-darthmarker-ranking-pack.mjs` — no value recomputed. It activates **only** when it
  validates against the live league: `scoring_status: MATCH` (the pack's `scoring_settings` are
  byte-identical to live Sleeper league `1389735763649761280`, producing the same identity hash),
  `roster_status: MATCH` (QB1/RB2/WR2/TE1/FLEX3/K1/DEF1/BN5, 12-team, 16-round snake), and the right
  `league_key`. The v7 workbook's "NOT READY" verdict is scoped to interactive-Excel / simulation
  gates; the board **table** passed its contract regression, pick-path check, and exact-from-Sleeper
  offense scoring. Best Available is ordered by the model's `overall_rank`; `sleeper_search_rank` is
  kept as a secondary market reference.
- **If that pack fails to load or validate (`ranking_quality: FALLBACK`)** the board falls back to
  Sleeper `search_rank`, shows a red **"DARTHMARKER MODEL NOT LOADED — USING SLEEPER FALLBACK
  RANKINGS"** banner, and the snapshot carries `ranking_quality.status = "FALLBACK"` with a warning.
  Never silent.
- **`bloodline_bowl` — Sleeper `search_rank` (`ranking_quality: MARKET`).** It carries the
  owner-declared `candidate_id` `bloodline_production_20260827113702` (+ declared
  `projection_sha`/`scoring_sha`/`config_sha`, `survival_engine: canonical_stateful_survival_v1`) from
  the multi-league addendum, marked `candidate_verified: false` — recorded exactly as declared,
  nothing fabricated. No ranking pack; the Bridge does not port Bloodline's frozen candidate engine.
- **Any league** can override with its own uploaded rankings/tiers file (`ranking_quality: CUSTOM`) via
  "Load my rankings" — stored per league, never shared.
- The **authoritative** scoring identity for every cross-check is the live `scoring_sha256` the board
  computes each session from that league's own Sleeper `scoring_settings` + roster positions.

To refresh the DarthMarker pack from a newer Roster Intel build:
`node scripts/build-darthmarker-ranking-pack.mjs` (point `ROSTER_INTEL_DIR` at the project; defaults
to `/Users/johnmcpherson/rosterintel`).

### `GET /api/bridge/board?league=<key>`

Server side of the Bridge: resolves one profile, fetches that league's live league/draft/rosters/
players, and returns identity, live-resolved rules, the scoring hash, the draft feed (already
reconciled to that league's `draft_id`), and the ranked available pool (capped at 700).

| Query parameter | Default          | Notes                                              |
| --------------- | ---------------- | -------------------------------------------------- |
| `league`        | `bloodline_bowl` | Bridge key, registry key, or alias (`darthmarker`). |
| `ranking`       | `sleeper`        | `sleeper` or `custom` (labels the response).        |
| `slot`          | live draft order | 1–99 user-confirmed slot override.                  |

### ChatGPT snapshot — self-identifying, fail-closed

"Export for ChatGPT" fetches a fresh board, runs a cross-check, and (only if it passes) builds a
JSON snapshot + a plain-text companion. Downloads use league-keyed filenames
(`darthmarker_chatgpt_snapshot.json` / `_summary.txt`; `bloodline_bowl_…`). The JSON leads with
`league_identity`, `model`, `ranking_quality` (MODEL/MARKET/FALLBACK/CUSTOM + warning),
`ranking_pack` (source artifact + sha + verification: scoring/roster status), `league_rules`,
`draft_state` (`state_quality`, geometry, `my_team` with model ranks, `roster_status` with open
starters, `my_roster_needs`, `recent_board_context` with position-run counts),
`best_available_overall` (top 30, each with `model_overall_rank` / `model_tier` / `model_value` /
`market_adp` / `sleeper_search_rank` / `roster_fit` / `flags`), `best_available_by_position`
(QB 8 / RB 12 / WR 12 / TE 8 / K 5 / DEF 5), `best_for_my_team`, and an `analysis_instructions` block
that tells ChatGPT to analyse **only this league**, use the model rankings as primary evidence and
Sleeper rank as secondary market context, and never substitute another league's scoring or rankings —
enough that a brand-new ChatGPT conversation with no history can answer "which league is this?" with
certainty.

The export is **blocked** (nothing is written) when the active league, the freshly-fetched board,
and the stored draft state do not all agree on the league (`ACTIVE_LEAGUE_MISMATCH` /
`LEAGUE_STATE_KEY_MISMATCH`), when the league's live scoring has drifted from what the state was
built against (`LEAGUE_SCORING_PROFILE_MISMATCH`), when the draft feed belongs to another league
(`DRAFT_SOURCE_LEAGUE_MISMATCH`), or when a supplied model identity does not belong to the league
(`LEAGUE_MODEL_IDENTITY_MISMATCH`).

### Tonight workflow (manual, no automated sync required)

1. Open `/bridge`, pick the league — the banner confirms it.
2. Confirm your draft slot.
3. Everyone starts available. Click **DRAFTED** as players go, **MINE** for your picks.
4. My Team, roster needs, Best Available, Best For My Team, and next-pick geometry update live.
5. **Export for ChatGPT** → Download JSON (and `.txt`) → upload to ChatGPT.

Switching leagues persists the current one and loads the other's own state; neither is ever cleared
by the switch.

### Multi-league validation report

Run `npm test`. The Bridge suites are `test/bridge.test.ts` (deterministic) and
`test/bridge-live.test.ts` (real Sleeper API):

```
MULTI-LEAGUE SUPPORT:               PASS  (lib/bridge/*, app/bridge, /api/bridge/board)
DARTHMARKER RANKING PACK:           ACTIVE (Roster Intel v7 board, 240 players, direct Sleeper ids)
DARTHMARKER PACK SCORING CHECK:     MATCH  (pack scoring_settings == live Sleeper, same identity hash)
DARTHMARKER PACK ROSTER CHECK:      MATCH  (QB1/RB2/WR2/TE1/FLEX3/K1/DEF1/BN5, 12-team 16-round snake)
DARTHMARKER FALLBACK (pack fails):  FAIL-CLOSED to Sleeper + loud FALLBACK banner/warning
BLOODLINE PROFILE RESOLUTION:       PASS  (declared candidate, verified:false; ranks by Sleeper market)
BLOODLINE STATE ISOLATION:          PASS  (bbb.bridge.state.v1.bloodline_bowl)
DARTHMARKER STATE ISOLATION:        PASS  (bbb.bridge.state.v1.devoted_to_the_game)
CROSS-LEAGUE CONTAMINATION TEST:    PASS  (test/bridge.test.ts §20 + verified live in /bridge)
WRONG-MODEL EXPORT REJECTION:       PASS  (LEAGUE_MODEL_IDENTITY_MISMATCH, fail closed)
WRONG-DRAFT-ID REJECTION:           PASS  (DRAFT_SOURCE_LEAGUE_MISMATCH, fail closed)
BLOODLINE CHATGPT SNAPSHOT:         PASS  (candidate_id present; no DarthMarker/devoted/rosterintel text)
DARTHMARKER CHATGPT SNAPSHOT:       PASS  (self-identifying, model-ranked, no "bloodline" text)
DARTHMARKER MANUAL MOCK MODE:       PASS  (test/bridge-live.test.ts deterministic mock draft)
BLOODLINE FORMAT DRIFT (auction→snake): FIXED (test/draft-live.test.ts now reads live draft type)
DARTHMARKER READY FOR TONIGHT:      YES   (model pack active; manual mode; pick-sync is P1, not required)
```

---

## API

Two layers of endpoints:

- **Snapshot endpoints** (`/api/league`, `/api/draft`, `/api/scoring`) — the original bridge, each a
  self-contained normalized view.
- **Factual analytics layer** (`/api/history`, `/api/transactions`, `/api/matchups`,
  `/api/standings`, `/api/managers`, `/api/value`, `/api/weekly-stats`, `/api/roster-analysis`,
  `/api/snapshot`) — facts and transparent derived metrics only. See
  [Factual analytics layer](#factual-analytics-layer) below for the design philosophy and every
  endpoint's data sources, formulas, and known limitations.
- **Historical weekly data** (`/api/player-weekly`, `/api/lineups`) — per-player weekly fantasy
  scoring and per-roster weekly starter/bench ownership for any season a league's Sleeper
  lineage covers. See [Historical weekly player scoring & lineups](#historical-weekly-player-scoring--lineups).

### `GET /api/league`

The main endpoint. One consolidated, normalized snapshot.

**Response:** `200` with the full document. Headers include
`Cache-Control: public, s-maxage=300, stale-while-revalidate=900` and
`X-Bloodline-Complete: true | partial`.

Top-level keys:

- `generated_at`, `source`, `league_id`
- `nfl_state` — current NFL week/season from Sleeper
- `league` — name, status, roster positions, `starting_lineup`, `scoring_settings`, `settings`, `key_settings`
- `teams[]` — manager, record, players, starters, bench, taxi, reserve, keepers, draft picks, summary
- `drafts[]` — each draft with settings, resolved draft order, and normalized picks
- `traded_picks[]` — every pick trade with original/previous/current owners resolved to names
- `league_state` — plain-English flags (`is_pre_draft`, `vacant_teams`, `notes[]`) so a model doesn't misread an empty league
- `metadata` — counts, unresolved IDs, warnings, build time

**Error responses:** `404` league not found, `429` rate limited, `502` upstream failure,
`504` timeout, `500` internal. All return `{ ok: false, error, detail, status }`.

### `GET /api/draft`

Live draft-night view, built for repeated polling by an AI during the auction.

```text
https://bloodline-bowl-sleeper-bridge.vercel.app/api/draft
```

Answers, at any moment: who has been drafted and by whom, what each player cost,
who remains available, how much budget each manager has left, **the largest bid each
manager can still make**, and what positions each roster still needs.

| Query parameter   | Default | Notes                                                                                           |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `available_limit` | `300`   | 1–1000. Caps the available-player pool.                                                         |
| `position`        | none    | One of `QB`, `RB`, `WR`, `TE`, `K`, `DEF`. Validated against the league's own roster positions. |

```bash
curl "https://bloodline-bowl-sleeper-bridge.vercel.app/api/draft?position=RB&available_limit=20"
```

Response headers carry `X-Draft-Status` and a status-dependent `Cache-Control`.

### `GET /api/draft/debug`

Sanitized dump of the raw Sleeper draft fields — draft settings, the metadata keys
Sleeper actually returns on picks, and whether an `amount` field is present. Exists to
verify auction-price behavior on draft night. Takes no parameters and is safe to delete;
nothing else imports it.

### `GET /api/scoring`

Normalized Bloodline Bowl scoring rules plus derived metrics, cross-category
comparisons, player-archetype examples, sensitivity analysis, and evidence-based
diagnostics — built for an AI to assess scoring balance without hand-parsing
Sleeper's raw keys.

```text
https://bloodline-bowl-sleeper-bridge.vercel.app/api/scoring
```

Answers questions like "are rushing touchdowns worth more than passing touchdowns",
"how much does a 0.5-point reception bump favor pass-catching backs over pocket
passers", and "is field-goal distance rewarded at all" directly from the league's
live `scoring_settings` — nothing is hardcoded to a generic PPR/half-PPR/standard
format.

Every raw Sleeper scoring key is preserved verbatim in `scoring.raw` and also
appears in `scoring.normalized` with a readable label and category. A key with no
built-in label still appears (never dropped) with a generated label and a warning
in `metadata.warnings`.

`archetype_examples` and `sensitivity` are both computed by the same scoring engine
that powers `/api/scoring/calculate` — nothing in either section is hardcoded.

### `POST /api/scoring/calculate`

Apply the league's live scoring settings to an arbitrary stat line — useful for
simulations. Read-only and stateless; no authentication.

```bash
curl -X POST "https://bloodline-bowl-sleeper-bridge.vercel.app/api/scoring/calculate" \
  -H "Content-Type: application/json" \
  -d '{"stats": {"pass_yd": 300, "pass_td": 2, "pass_int": 1, "rush_yd": 20}}'
```

```json
{
  "fantasy_points": 20,
  "breakdown": [
    {
      "stat": "pass_yd",
      "label": "Passing yard",
      "category": "passing",
      "value": 300,
      "multiplier": 0.04,
      "points": 12
    }
  ],
  "warnings": []
}
```

Only stat keys the league's own scoring settings actually define are accepted — an
unrecognized key is dropped with a warning rather than silently scored as zero
without explanation, and a request containing _only_ unrecognized keys is rejected
with `400`. The body is capped at 16KB and 60 stat keys, and each value is bounded
to keep this from being usable as an arbitrary compute sink.

### `GET /api/health`

Liveness probe. Makes no upstream calls by default; pass `?draft=1` to also report the
active draft's id and status (two small cached Sleeper calls).

```json
{
  "ok": true,
  "service": "bloodline-bowl-sleeper-bridge",
  "league_id": "1395549281678532608",
  "timestamp": "2026-08-18T23:05:01.580Z",
  "player_cache": { "cached": true, "player_count": 12221, "age_seconds": 412 }
}
```

### `GET /api/raw?resource=<name>`

Debugging aid returning untouched Sleeper payloads. **Not an open proxy** — `resource` is matched
against a fixed allowlist and never concatenated from user input.

Allowed: `league`, `users`, `rosters`, `drafts`, `traded_picks`, `state`, `draft_picks`.
`draft_picks` additionally requires a numeric `&draft_id=`.

```bash
curl "https://bloodline-bowl-sleeper-bridge.vercel.app/api/raw?resource=rosters"
```

The full player database is deliberately **not** exposed here.

---

## Example `/api/league` response

Abbreviated real output, captured while the league was still pre-draft. Long arrays are elided;
counts such as `claimed_teams` change as managers join.

```json
{
  "generated_at": "2026-08-18T23:05:35.723Z",
  "source": "Sleeper",
  "league_id": "1395549281678532608",
  "nfl_state": {
    "week": 2,
    "leg": 0,
    "season": "2026",
    "season_type": "pre",
    "league_season": "2026",
    "previous_season": "2025",
    "season_start_date": "2026-08-06",
    "display_week": 2,
    "league_create_season": "2026",
    "season_has_scores": true
  },
  "league": {
    "name": "Bloodline Bowl",
    "season": "2026",
    "status": "pre_draft",
    "status_description": "League has been created but the draft has not started yet.",
    "total_rosters": 10,
    "roster_positions": [
      "QB",
      "QB",
      "RB",
      "RB",
      "WR",
      "WR",
      "TE",
      "FLEX",
      "FLEX",
      "K",
      "DEF",
      "BN",
      "BN",
      "BN",
      "BN",
      "BN"
    ],
    "starting_lineup": {
      "slots": [
        "QB",
        "QB",
        "RB",
        "RB",
        "WR",
        "WR",
        "TE",
        "FLEX",
        "FLEX",
        "K",
        "DEF"
      ],
      "total_starters": 11,
      "bench_slots": 5,
      "taxi_slots": 0,
      "reserve_slots": 1,
      "position_requirements": {
        "QB": 2,
        "RB": 2,
        "WR": 2,
        "TE": 1,
        "FLEX": 2,
        "K": 1,
        "DEF": 1
      }
    },
    "key_settings": {
      "scoring_format": "half_ppr",
      "points_per_reception": 0.5,
      "passing_td_points": 4,
      "is_superflex_or_2qb": true,
      "starting_qb_slots": 2,
      "teams": 10,
      "playoff_teams": 6,
      "playoff_week_start": 15,
      "trade_deadline_week": 11,
      "waiver_type": "faab",
      "waiver_budget": 100,
      "max_keepers": 1,
      "taxi_slots": 0,
      "reserve_slots": 1,
      "pick_trading_enabled": true,
      "trades_enabled": true
    },
    "scoring_settings": {
      "rec": 0.5,
      "pass_td": 4,
      "\u2026": "(full Sleeper scoring map)"
    },
    "settings": {
      "\u2026": "(full Sleeper settings map)"
    }
  },
  "teams": [
    {
      "roster_id": 1,
      "manager": {
        "user_id": "1308955807408230400",
        "display_name": "supyo29",
        "team_name": null,
        "avatar": null,
        "is_owner": true,
        "is_bot": false,
        "is_vacant": false,
        "co_owner_user_ids": []
      },
      "record": {
        "wins": 0,
        "losses": 0,
        "ties": 0,
        "points_for": 0,
        "points_against": 0,
        "waiver_position": 10,
        "waiver_budget_used": 0,
        "total_moves": 0,
        "division": 1
      },
      "players": [],
      "starters": [
        {
          "slot": 1,
          "roster_position": "QB",
          "player": null,
          "is_empty": true
        },
        {
          "slot": 2,
          "roster_position": "QB",
          "player": null,
          "is_empty": true
        },
        "\u2026"
      ],
      "bench": [],
      "taxi": [],
      "reserve": [],
      "keepers": [],
      "draft_picks": [
        {
          "season": "2026",
          "round": 1,
          "original_roster_id": 1,
          "current_owner_roster_id": 1,
          "previous_owner_roster_id": null,
          "is_traded": false,
          "is_acquired": false,
          "rounds_source": "draft"
        },
        {
          "season": "2026",
          "round": 2,
          "original_roster_id": 1,
          "current_owner_roster_id": 1,
          "previous_owner_roster_id": null,
          "is_traded": false,
          "is_acquired": false,
          "rounds_source": "draft"
        },
        "\u2026"
      ],
      "summary": {
        "position_counts": {},
        "player_count": 0,
        "starter_count": 0,
        "empty_starter_slots": 11,
        "bench_count": 0,
        "taxi_count": 0,
        "reserve_count": 0,
        "own_picks_held": 16,
        "picks_acquired": 0,
        "picks_traded_away": 0,
        "total_picks_held": 16
      }
    },
    "\u2026 9 more teams"
  ],
  "drafts": [
    {
      "draft_id": "1395549282349617152",
      "season": "2026",
      "status": "pre_draft",
      "type": "auction",
      "rounds": 16,
      "pick_count": 0,
      "draft_order": [],
      "picks": []
    }
  ],
  "traded_picks": [],
  "league_state": {
    "is_pre_draft": true,
    "rosters_filled": false,
    "claimed_teams": 2,
    "vacant_teams": 8,
    "total_rostered_players": 0,
    "total_draft_picks_made": 0,
    "notes": [
      "League is in pre-draft state: rosters are empty until the draft happens, so roster-strength comparisons are not yet meaningful.",
      "8 of 10 teams have no manager assigned yet.",
      "No players are rostered on any team yet.",
      "No draft picks have been made yet.",
      "No draft picks have been traded; every team still holds its own picks."
    ]
  },
  "metadata": {
    "player_count": 0,
    "team_count": 10,
    "draft_count": 1,
    "traded_pick_count": 0,
    "unresolved_player_ids": [],
    "player_database_size": 12221,
    "warnings": [],
    "build_ms": 3
  }
}
```

---

## Architecture

```text
app/
  api/
    league/route.ts     HTTP handling, status codes, cache headers
    draft/route.ts      live draft view (query validation + cache policy)
    draft/debug/route.ts  sanitized raw draft fields
    scoring/route.ts     normalized scoring rules, derived metrics, diagnostics
    scoring/calculate/route.ts  POST: apply live scoring to a caller-supplied stat line
    player-weekly/route.ts     historical weekly player fantasy scoring, any season
    lineups/route.ts           historical weekly roster ownership + starters, any season
    history/route.ts           season lineage + factual results (all routes accept ?league=)
    transactions/route.ts      normalized trades/waivers/free agents/drops
    matchups/route.ts          weekly matchup results + score rank
    standings/route.ts         records + weekly-score statistics
    managers/route.ts          career aggregation by stable user_id
    value/route.ts             player values (provider currently unavailable)
    weekly-stats/route.ts      raw NFL stats scored via Bloodline Bowl rules
    roster-analysis/route.ts   structural roster facts, no grading
    snapshot/route.ts          compact AI-friendly current-state view
    health/route.ts     liveness probe
    raw/route.ts        allowlisted raw passthrough
  page.tsx              minimal status page
  layout.tsx

lib/
  http.ts               CORS + cache header helpers
  leagues/
    registry.ts          multi-league registry: known leagues, validation, dedup
  sleeper/
    types.ts            raw Sleeper types + normalized output types
    client.ts           HTTP client: timeouts, retries, player-DB cache
    normalize.ts        pure normalization for /api/league (no HTTP)
    service.ts          /api/league orchestration + graceful degradation
    budget.ts           pure auction budget math
    draft.ts            pure draft logic: needs, availability, team assembly
    draft-service.ts    /api/draft orchestration + tiered fetch freshness
  scoring/
    types.ts             scoring-analysis response types
    catalog.ts           Sleeper scoring-key -> label/category lookup
    calculate.ts         the scoring engine: calculateFantasyPoints()
    normalize.ts         derived metrics, comparisons, classification
    archetypes.ts        fixed diagnostic player stat lines
    sensitivity.ts        modest scoring-change impact analysis
    diagnostics.ts        evidence-based scoring-balance flags
    scoring-service.ts    /api/scoring orchestration
  analytics/
    types.ts             shared metadata + DerivedValue types
    lineage.ts            safe previous_league_id traversal (cycle/depth guarded)
    season-data.ts        shared per-season loader: league/users/rosters/matchups/brackets
    matchups.ts            pairs weekly rows into games, computes weekly_score_rank
    standings.ts            win%, weekly stats, playoff finish from bracket data only
    transactions.ts         trade/waiver/free-agent/drop normalization
    roster.ts                composition, age, FLEX-aware slot coverage, auction spend
    weekly-stats.ts          applies the scoring engine to raw stats, computes ranks
    history.ts                season-by-season factual results
    managers.ts                career aggregation by stable Sleeper user_id
    value.ts                   player-value facts with source attribution
    snapshot.ts                composes /api/snapshot from already-built pieces
    query.ts                   shared, allowlisted query-parameter validation
    season-resolution.ts        shared previous_league_id walk: season -> actual league_id
    historical-scoring.ts       weekly player scoring: Sleeper matchup points + raw-stat fallback
    historical-lineups.ts       weekly roster ownership + starter-slot mapping
    reconciliation.ts           sums starter scoring, checks it against matchup totals
  stats/
    types.ts              PlayerStatsProvider interface
    provider.ts            Sleeper-stats-endpoint-backed implementation
  values/
    types.ts               PlayerValueProvider interface
    provider.ts              "unavailable" implementation (no source configured)

test/
  fixtures.ts             synthetic league using real Sleeper player IDs
  normalize.test.ts       normalization unit tests
  live.test.ts            end-to-end against the real Sleeper API
  draft.test.ts           budget, needs, availability, query validation
  draft-simulation.test.ts  full team assembly against a simulated mid-auction
  draft-live.test.ts      /api/draft end-to-end against the real league
  scoring.test.ts          scoring engine: yardage/TD math, archetypes, sensitivity, diagnostics
  scoring-live.test.ts     /api/scoring end-to-end against the real league's live settings
  analytics.test.ts        standings math, transactions, roster analysis, weekly-stat ranking
  analytics-live.test.ts   analytics layer end-to-end + a scan for forbidden subjective fields
  historical-data.test.ts       weekly scoring/lineup unit tests (synthetic fixtures)
  historical-data-live.test.ts  full 2025 Devoted to the Game validation + the required trade check
```

The layering is deliberate: `normalize.ts` is pure and has no knowledge of HTTP, so it is directly
testable; `service.ts` decides what is fatal and what degrades; the route handlers only translate
results into status codes and headers.

### Draft pick ownership

This is the subtlest part. Per Sleeper's docs, `/league/{id}/traded_picks` returns:

- `roster_id` — roster of the **original** owner
- `previous_owner_id` — roster of the previous owner
- `owner_id` — roster of the **current** owner

Critically, it only returns picks that have **changed hands**. Picks still held by their original
owner are never listed. So to answer "what draft capital does each team control", the bridge
_synthesizes_ the full inventory — every roster starts owning its own pick in every round — and
then applies the trades on top. Each pick carries `rounds_source` (`draft`, `league_settings`, or
`traded_picks`) so you can see where the round count came from.

Seasons whose draft has already **completed** are excluded from draft capital: those picks are
spent, and counting them as assets would misrepresent a team's position.

### Failure policy

League, users, and rosters are required — if they fail, the request fails with an appropriate
status. Everything else (NFL state, drafts, picks, traded picks, the player database) degrades to a
`metadata.warnings[]` entry and the response is still returned, with `X-Bloodline-Complete: partial`
and a shortened cache TTL. If the player database is unavailable, players come back as unresolved
stubs (`resolved: false`) with their IDs intact rather than disappearing.

---

## Draft night

### Does Sleeper expose auction prices?

**Yes — but undocumented.** Sleeper puts the winning bid in each pick's
`metadata.amount`, as a string (`"amount": "42"`). This field appears in **no**
official Sleeper documentation, so it is parsed defensively: a missing or
unparseable value yields `price: null` rather than a fabricated number, and the
response reports how many picks lacked one.

Because the Bloodline Bowl draft has not run yet, this could not be confirmed
against live picks. `/api/draft/debug` reports `metadata_keys_seen` and
`has_amount_field` so the first real pick will settle it immediately. If the field
turns out to be absent, `budget.prices_available` flips to `false` and a warning is
emitted — the endpoint degrades honestly instead of reporting wrong budgets.

### Budget and maximum bid

**Draft type is read live from Sleeper, not assumed.** Bloodline Bowl was configured
as a $200 auction when this endpoint was first built; Sleeper currently reports the
2026 Bloodline Bowl draft as a **snake**. `/api/draft` follows whatever Sleeper
reports today: for a non-auction draft `budget.supported` is `false`, `budget.reason`
names the actual type, and each team's `budget` block is `null`. The budget math below
applies only when `budget.supported` is `true`.

```text
spent      = sum of acquisition prices (an unknown price counts as 0)
remaining  = starting_budget - spent
reserve    = (slots_remaining - 1) * minimum_bid
max_bid    = remaining - reserve
```

The reserve is what a manager must hold back to fill every _other_ remaining slot at
the minimum bid. A manager with $83 and 6 slots left can bid at most **$78**; with one
slot left they can spend everything.

Sleeper exposes **no minimum-bid setting**, so $1 is assumed and labelled as such via
`budget.minimum_bid_source: "assumed_default"`. The live-draft tests
(`test/draft-live.test.ts`) assert the auction path only when Sleeper reports an
auction, and the non-auction path otherwise.

### Positional needs and FLEX

`needs.required` lists only **strict** starting slots that are genuinely unfilled. A
team with two RBs and an empty FLEX is _not_ reported as needing a third RB — flex
capacity is reported separately as `flexible_slots_remaining`.

Acquired players are matched to slots with a most-constrained-first greedy assignment,
so a multi-position player is not wasted on a slot a single-position player could fill.
Strict slots are filled before flex slots.

### Available players

Ordered by Sleeper's own `search_rank` (its relevance ordering) — no proprietary
rankings are invented. Drafted and rostered players are excluded.

One wrinkle: Sleeper leaves `search_rank` **null on all 32 team defenses**, so a purely
rank-ordered list would never surface a DEF even though this league starts one.
Unfiltered responses therefore guarantee a minimum number of candidates per required
starting position before filling the rest by rank. Defenses are returned in
deterministic alphabetical order, since Sleeper provides no ranking to sort them by.

## Scoring analysis

### Bloodline Bowl's actual classification

Read live from Sleeper, not assumed:

```text
base: half_ppr (0.5 points per reception)
```

Features actually present in the live settings (only what the settings evidence, nothing assumed):

- 4-point passing touchdown
- 6-point rushing touchdown (a 2-point premium over passing)
- 6-point receiving touchdown (a 2-point premium over passing)
- 2QB (two dedicated starting quarterback slots — not Superflex)
- Points-allowed penalty for team defense, continuous rather than tiered (all point-allowed
  tier bonuses are set to zero; defense loses 0.25 points per point allowed instead)
- Flat field-goal scoring — a field goal is worth 3 points regardless of distance (all
  distance-tier bonuses are zero)
- Quarterback-sacked penalty (-1 point)
- 2-point conversions scored

No TE-premium bonus is configured, so that diagnostic correctly never fires.

### Notable tendencies the diagnostics surface

- **Rushing and receiving touchdowns are worth 2 more points than passing touchdowns**
  (6 vs. 4) — `rushing_td_premium` and `receiving_td_premium`, both `notable`.
- **Rushing yardage is worth 2.5x passing yardage per yard** (0.1 vs. 0.04) —
  `rushing_yardage_premium`, `notable`. Combined with the TD premium above, dual-threat
  quarterbacks and touchdown-scoring backs are structurally favored over pocket passers on a
  per-play basis.
- **Team defense scoring is a continuous points-allowed penalty**, not the tiered bonus most
  leagues use — `defense_points_allowed_penalty`, `notable`.
- Reception value (0.5), the sack penalty (-1), and flat kicker scoring are all present but
  only `informational` — none represents an unusual departure from common league norms.

These are diagnostics, not verdicts — the endpoint surfaces evidence (`severity` +
a plain-English `message` naming the exact settings compared) for an AI or a commissioner to
weigh, not a judgment that the scoring system is unbalanced.

### Player archetypes: the same engine, no hardcoded totals

`archetype_examples` and `sensitivity` both call the same `calculateFantasyPoints()` used by
`POST /api/scoring/calculate` — there is no separate hardcoded table to drift out of sync. A test
(`scoring.test.ts`) asserts every archetype total matches a fresh call to the engine.

Under the live settings, the receiving RB archetype (50 rush yd, 8 rec, 70 rec yd) scores lower
than the workhorse RB (100 rush yd, 1 rush TD, 3 rec, 20 rec yd) — 16 vs. 19.5 — because half-PPR
reception value does not fully offset the rushing-touchdown premium here. `sensitivity` shows
exactly how much that would shift under a modest scoring change (e.g. `reception_plus_0_5` adds
+4 to the receiving RB).

## Factual analytics layer

> **Facts and transparent derived metrics belong in the bridge. Interpretation belongs to the AI
> consumer.**

This layer exists to separate four distinct concerns:

```text
SOURCE DATA  ->  NORMALIZED FACTS  ->  TRANSPARENT DERIVED METRICS  ->  AI INTERPRETATION
```

The bridge stops at the third layer. Every field here is either a fact read straight from Sleeper
(or a named external source) or a derived metric with a visible formula and inputs. **None of these
endpoints produce grades, rankings-by-quality, or labels** — no `manager_skill`, `roster_grade`,
`trade_grade`, `power_rank`, `contender`/`rebuild`, `draft_winner`, or `championship_probability`
field exists anywhere in this layer, and a live test (`analytics-live.test.ts`) scans every
response for exactly those patterns. If a metric can't be expressed as a deterministic calculation
with visible inputs, it is left out — that judgment belongs to whatever AI is reading the response.

### Missing data

A value the bridge cannot determine is `null`, never a fabricated `0`. For example, a manager who
has made no waiver claims reports `faab_spent: null` (there is nothing to sum), not `0`. Every
analytics response carries `metadata.warnings[]` explaining _why_ something is null when that isn't
self-evident (e.g. "No matchup data is available for week 2 of 2026 yet").

### Common response metadata

Every analytics endpoint's response includes:

```json
{
  "metadata": {
    "schema_version": 1,
    "generated_at": "ISO_TIMESTAMP",
    "league_id": "1395549281678532608",
    "season": "2026",
    "sources": [{ "name": "Sleeper", "type": "league_data" }],
    "data_freshness": { "standings": "1m" },
    "warnings": []
  }
}
```

### `GET /api/history`

Walks Sleeper's season lineage via `previous_league_id` and reports each season's settings, roster
positions, standings, and — **only when an actual bracket final has been decided** — champion and
runner-up. A championship is never inferred from regular-season record.

**Safety:** traversal stops on a missing/deleted league, a repeated league id (circular-chain
guard), or after `MAX_LINEAGE_DEPTH` (15) seasons — whichever comes first — and reports why via
`metadata.warnings`, never by throwing.

**Bloodline Bowl today:** a single season (`previous_league_id` is `null`), so `/api/history`
returns one entry with `champion: null` and `runner_up: null` (the bracket exists but no game has
been played).

### `GET /api/transactions`

Normalized trades, waivers, free-agent moves, and drops. `?season`, `?week`, `?type`, `?manager`
(a Sleeper `user_id`), `?roster_id` are all validated. A trade's `sides[]` shows each roster's
received players/picks/FAAB — there is no fairness or value-differential field.

Historical seasons are resolved to their actual `league_id` via the same lineage walk as
`/api/history` (Sleeper issues a new `league_id` per season) — requesting a season outside the
discovered lineage returns `404`, not a silent reuse of the current league's data.

### `GET /api/matchups`

Pairs Sleeper's per-roster weekly rows (which share a `matchup_id`) into games and reports
`result` (`win`/`loss`/`tie`), `margin`, and `weekly_score_rank` (e.g. `"2 of 10"`, ties sharing a
rank). No "fortunate"/"unfortunate" labeling of close results.

### `GET /api/standings`

Factual records plus formula-backed weekly statistics:

| Field                                                | Formula                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `win_percentage`                                     | `(wins + ties * 0.5) / games_played`                               |
| `average_points_for`                                 | `points_for / games_played`                                        |
| `median_weekly_score`                                | median of that roster's weekly scores                              |
| `standard_deviation_weekly_score`                    | **population** standard deviation of weekly scores                 |
| `weekly_high_score_count` / `weekly_low_score_count` | weeks this roster posted the league's single highest/lowest score  |
| `regular_season_finish`                              | rank by `wins`, then `points_for` (Sleeper's own default tiebreak) |

`championship`/`runner_up` again only ever come from a decided bracket final. Explicitly **not**
computed here: luck, expected wins, power rank, strength grade.

### `GET /api/managers`

Aggregates career facts by Sleeper's `user_id` — the one identifier Sleeper keeps stable for the
same person across every season in the discovered lineage (a roster's `owner_id` can be reused by a
different person season to season on some platforms, but not on Sleeper). `all_time` is implicit: a
manager's `career` always spans every season discovered by the lineage walk.

This is the most expensive analytics call — it sweeps all 18 possible weeks of transactions per
season to total trades/waivers/free-agent adds/drops/FAAB, so it leans on the longer cache tier.

### `GET /api/value`

**No player-value provider is currently configured.** Rather than fabricate a number or silently
wire in a paid API, the endpoint reports this honestly:

```json
{
  "provider": {
    "name": "none",
    "available": false,
    "unavailable_reason": "..."
  }
}
```

The architecture (`lib/values/{types,provider}.ts`, a `PlayerValueProvider` interface) is real and
ready — a future ADP/auction-value/dynasty-ranking/projection source only has to implement
`getValues(playerIds)` and return values with mandatory source attribution
(`source`, `source_type`, `updated_at`, `format`). Multiple sources are never averaged into an
unlabeled consensus number; if a consensus is ever added, its formula and included sources will be
exposed explicitly, not hidden behind a single value.

### `GET /api/weekly-stats`

**NFL stats provider: Sleeper's own stats endpoint** (`GET /v1/stats/nfl/regular/{season}/{week}`).
It's undocumented but public and same-domain (`api.sleeper.app`) — not a third-party scrape, not a
paid service. Its stat keys line up with `scoring_settings` keys, which is what lets Bloodline
Bowl's own scoring engine (`calculateFantasyPoints`, the same function `/api/scoring` and
`/api/draft` use) be applied to the **raw counting stats** directly. Sleeper's own precomputed
`pts_std`/`pts_ppr`/`pts_half_ppr` fields are read and discarded — they are never this bridge's
source of truth.

One correctness fix found during validation: Sleeper's stats endpoint includes ~32 synthetic
`TEAM_XXX` rows carrying team-level offensive aggregates (not real players, not present in
`/players/nfl`). Left unfiltered, these scored huge bogus point totals and dominated the rankings;
they are now excluded in the provider before anything downstream sees them
(`lib/stats/provider.ts`).

`overall_weekly_rank`/`position_weekly_rank` are computed **only among players who have a returned
stat line that week** — the response's `methodology.description` says so explicitly, since a rank
is meaningless without the pool it was computed against.

The provider abstraction (`PlayerStatsProvider`) means a different source can be swapped in later
without changing anything downstream.

### `GET /api/roster-analysis`

Deterministic structural facts only — composition, age, slot coverage, auction spend, draft-pick
ownership. **FLEX/SUPER_FLEX handling reuses the exact same logic `/api/draft` already uses**
(`computeRosterNeeds` in `lib/sleeper/draft.ts`), so a roster is never described as "needing a WR"
merely because a FLEX slot is open — that distinction (`strict_slots_filled` vs.
`flexible_slots_remaining`) is enforced in one place across the whole bridge. Auction spend
(`total_spend`, `average_acquisition_cost`, `remaining_budget`) is `null` — not `0` — for any
roster with no known acquisition prices.

### `GET /api/snapshot`

The compact, AI-friendly current-state view — composed from already-built pieces of `/api/league`,
`/api/draft`, `/api/scoring`, and this analytics layer, **not a concatenation of their full
payloads** (`/api/league`'s per-player detail and `/api/draft`'s available-player pool are both
deliberately left out). Optimized for "analyze my league", "what happened recently", "what do the
standings look like" style questions. Typically ~10 KB.

### Manager identity, summarized

Sleeper's `user_id` is the one stable identity across a league's entire lineage — it survives
league renames, roster reassignment, and season-to-season `league_id` churn. Every analytics
endpoint that aggregates "by manager" (`/api/managers`, trade `sides[]`) keys off `user_id`, never
off a roster's `owner_id` in isolation (which is only stable _within_ one season) or off
`display_name` (which a manager can change at any time).

### Known limitations

- **Single season of real data.** Bloodline Bowl has no `previous_league_id`, so `/api/history` and
  `/api/managers` currently report on one season; the lineage-walking and cross-season aggregation
  code is exercised by unit tests against synthetic multi-season fixtures, not yet against a real
  multi-season Bloodline Bowl history.
- **No player-value provider configured** (see `/api/value` above) — this is a documented,
  intentional gap, not an oversight.
- **`/api/managers`'s transaction sweep costs up to 18 Sleeper calls per season** it aggregates.
  Fine for one season; would need the longer historical cache tier to matter once seasons pile up
  (it already gets it).
- **Weekly stats depend on Sleeper's undocumented stats endpoint.** It has been reliable and public
  throughout this project, but it is not part of Sleeper's official API surface, so a future
  provider swap (behind the existing `PlayerStatsProvider` interface) may become necessary.

## Historical weekly player scoring & lineups

Two general-purpose endpoints expose per-week, per-player fantasy scoring and roster
ownership/starter data — for any season a league's Sleeper lineage covers, not just the
current one. They exist so external analysis (e.g. an R-based manager-efficiency study) can
reconstruct exactly what happened in a given week without re-deriving Sleeper's own scoring.

### `GET /api/player-weekly`

One row per player-week.

```text
?league=devoted-to-the-game&season=2025            (full season, all weeks)
?league=devoted-to-the-game&season=2025&week=4     (single week)
```

**Scoring method — two sources, in priority order** (see `lib/analytics/historical-scoring.ts`):

1. **Rostered players:** Sleeper's own matchup-scored `players_points` from
   `/league/{id}/matchups/{week}`. This is Sleeper's own scoring engine having already applied
   that league's exact `scoring_settings` for that season — the single most authoritative
   source available, so nothing is recomputed. `scoring_source: "sleeper_matchup_points"`.
2. **Unrostered (free-agent) players:** scored locally from raw counting stats
   (Sleeper's `/stats/nfl/regular/{season}/{week}`) using the resolved season's own
   `scoring_settings`, through the same `calculateFantasyPoints` engine `/api/scoring` and
   `/api/weekly-stats` use. `scoring_source: "bridge_calculated_from_raw_stats"`. This path
   exists because "waiver value" analysis is meaningless without knowing what unrostered
   players scored too. Bounded to positions this league can actually draft/start (reusing
   `draftablePositions`/`eligiblePositions` from `lib/sleeper/draft.ts`) — Sleeper's raw stats
   endpoint returns a line for every NFL player who recorded anything that week, including
   offensive linemen, punters, and IDP positions, none of which belong in a standard-lineup
   fantasy analysis. Rostered players (source 1) are never filtered this way — real ownership
   is reported regardless of position.

A rostered player with no points entry for a week (bye/inactive) reports `fantasy_points: 0`
and `game_played: false` — never a fabricated positive value, and never treated as missing
data (the roster snapshot itself is evidence of ownership).

Every row carries `scoring_settings_hash` (a deterministic fingerprint of the exact
`scoring_settings` object used) so a consumer can verify two rows were scored under identical
rules without re-fetching the league.

### `GET /api/lineups`

One row per roster-player-week.

```text
?league=devoted-to-the-game&season=2025            (full season, all weeks)
?league=devoted-to-the-game&season=2025&week=4     (single week)
```

**Source:** the same `/league/{id}/matchups/{week}` call, using its `players` (full roster
that week) and `starters` (ordered starter ids) arrays — a genuine weekly snapshot, never
inferred from end-of-season rosters, so mid-season trades and waiver moves are reflected
correctly at the week they actually happened.

**Slot mapping:** Sleeper positionally aligns `starters` with the league's `roster_positions`
(bench/taxi/IR excluded) — the same convention `lib/sleeper/normalize.ts` already relies on
for the live league, and verified here against real 2025 data before reuse. A flex pick is
labeled with its true Sleeper `roster_position` (e.g. `"FLEX"`), never a fabricated
`"FLEX1"`/`"RB3"` distinction Sleeper itself doesn't make. Any starter slot that can't be
matched deterministically returns `roster_slot: "STARTER_UNKNOWN"` rather than guessing.

**Known limitation:** Sleeper does not expose a per-historical-week IR flag — `reserve` only
exists on the _current_ `/rosters` snapshot, not a historical week's matchup data. `ir` is
therefore honestly `null` rather than inferred; only `starter` / `bench` / `not_owned` are
distinguished.

### Historical season resolution

Both endpoints (and `/api/matchups`, `/api/transactions`, `/api/weekly-stats`, all sharing
`lib/analytics/season-resolution.ts`) resolve `?season=` by walking the league's
`previous_league_id` lineage to find the season whose league object actually reports that
season — never by reusing the current league's id. Requesting a season the league's lineage
doesn't cover returns `404 season_not_found` naming the seasons that do exist; a resolved
league whose own `.season` field doesn't match the request returns `502 season_mismatch`
rather than serving data under a silent assumption.

**Verified:** `?league=devoted-to-the-game&season=2025` resolves to Sleeper league id
`1264616401079914496` — the exact historical league id, distinct from the current (2026)
league `1389735763649761280`, linked via that league's own `previous_league_id`.

_This fixed a real pre-existing bug:_ `/api/weekly-stats` previously always used the
**current** season's league object for scoring settings regardless of the requested `season`,
which would have silently applied 2026 scoring rules to 2025 stats. It's now routed through
the same shared resolver as everything else.

### Reconciliation

`/api/player-weekly` includes a `reconciliation` block: for every returned week, it sums each
roster's starters' `fantasy_points` and compares against that roster's `points` total from the
matchup data. **Verified against the full 2025 Devoted to the Game season: 216/216
roster-weeks (12 rosters × 18 weeks) reconciled with zero discrepancy.**

```json
"reconciliation": {
  "weeks_checked": [1, 2, "...", 18],
  "rosters_checked": 216,
  "rosters_within_tolerance": 216,
  "max_absolute_difference": 0,
  "status": "reconciled"
}
```

### Sample requests (Devoted to the Game 2025)

```bash
curl "https://bloodline-bowl-sleeper-bridge.vercel.app/api/player-weekly?league=devoted-to-the-game&season=2025&week=1"
curl "https://bloodline-bowl-sleeper-bridge.vercel.app/api/lineups?league=devoted-to-the-game&season=2025"
```

### Response metadata

Both endpoints return, alongside their rows: `league_selector`, `league_id` (the _resolved_
historical id), `season`, `weeks_returned`, `missing_weeks`, `row_count`,
`unresolved_players`, and a `metadata` block with `generated_at`, `sources`, `warnings`, and
`cache_seconds`. `/api/player-weekly` additionally reports `scoring_method` and
`scoring_settings_provenance`; `/api/lineups` reports `starter_source` and `roster_source`.

## Historical weekly player availability

`GET /api/player-availability` and `GET /api/manager-availability` expose evidence for
answering, per player-week: *was this player actually available to their fantasy manager, and
if not, why?* Built for the Injury Response Efficiency / counterfactual-LVA analysis, but
generic for any registered league/season.

**The single most important thing to know before using either endpoint:**

> A zero fantasy score is not evidence of injury. A missed game without authoritative status
> evidence is not automatically an injury. Sleeper's current injury status is never applied
> retroactively to a historical week.

### Source audit — what Sleeper actually supports

Sleeper's public API has **no historical archive** for injury designations, official game-day
inactive lists, or practice reports. `/players/nfl` carries `injury_status`, `injury_notes`,
and `practice_participation` — but only as a live snapshot, overwritten in place as the season
progresses. There is no way to ask Sleeper "what was this designation in week 4," only "what is
it right now." Because of that, **this bridge never reads those fields at all**, for any
season — not even the current one — so there is no code path that could leak current status
into a historical week.

What Sleeper does provide, and what powers every field below:

| Source | Gives us |
|---|---|
| `/stats/nfl/regular/{season}/{week}` (`gp`, `gms_active`) | Real per-player-week participation evidence |
| Same endpoint's team-code rows (e.g. `"KC"`, `"HOU"`) | Whether each NFL team played that week — the basis for bye-week detection, cross-checked against the player index's own `DEF` entries rather than a hardcoded team list |
| `/league/{id}/matchups/{week}` (via the same builder behind `/api/lineups`) | Real per-week roster/starter/bench membership |
| `/league/{id}/rosters` `reserve` array | Real, but only a **season-end snapshot** for a finished season — not a per-week timeline |
| `RawTransaction.created` / `status_updated` | Real per-transaction timestamps, for joining externally — see "Knowledge-time safeguard" below |

No third-party/non-Sleeper source is used anywhere in this endpoint.

### Availability classes

Only classes this bridge can back with real Sleeper evidence are emitted —
`confirmed_injury`, per-grade injury designations, `inactive_injury`/`inactive_non_injury`,
`suspension`, `reserve_pup`, and `reserve_nfi` are **never produced**, by construction, because
no authoritative historical source exists for any of them:

| `availability_class` | Confidence | Meaning |
|---|---|---|
| `participated` | high | `gp>=1` in Sleeper's weekly stats — regardless of fantasy points scored |
| `bye` | high/moderate | No NFL team-defense stat row recorded a game for this player's team that week |
| `ir` | low | Season-end reserve snapshot + no participation from this week through end of season (exact placement week is not knowable — see below) |
| `did_not_play_unknown` | moderate | A stat line exists with `gp=0` (team had a game); the reason is not available from Sleeper |
| `unknown` | low | No stat line, no bye signal, no reserve status found |

`reserve_status`/`reserve_or_ir` is a **roster-status** signal, never a medical claim — a
player on a manager's Reserve/IR slot is evidence of roster status, not proof of the specific
injury. `ir` is only asserted for the trailing block of weeks after a player's last real
participation, labeled `evidence_granularity: "season_end_snapshot"`, and never claims an exact
placement week.

### Coverage / field support

Every response's `coverage.field_support` reports exactly which evidence dimensions are
supported — never silently blank fields that look supported:

```json
{
  "game_participation": "available",
  "bye_week": "available",
  "manager_roster_context": "available",
  "reserve_or_ir": "partial",
  "historical_injury_designation": "unsupported",
  "historical_game_status": "unsupported",
  "historical_practice_status": "unsupported",
  "official_inactive": "unsupported",
  "suspension_non_injury": "unsupported",
  "known_before_transaction": "unsupported"
}
```

### Knowledge-time safeguard

`known_before_transaction` is **always `null`** — establishing it would require a
status-publication timestamp this bridge does not have (no historical designation archive
exists to timestamp in the first place). This is deliberate: it prevents hindsight leakage in
any downstream injury-response scoring rather than fabricating a chronology Sleeper can't
support. Records instead expose stable join keys (`season`, `week`, `player_id`, `manager_id`,
`roster_id`) so a consumer can join to `/api/transactions`' own `created`/`status_updated`
timestamps itself.

### `GET /api/player-availability`

```text
?league=devoted-to-the-game&season=2025
?league=devoted-to-the-game&season=2025&week=7
?league=devoted-to-the-game&season=2025&player_id=8146
?league=devoted-to-the-game&season=2025&manager_id=1265419589680910336
```

Records are bounded to players who were on some roster in this league at some point during the
season — the same rostered-player bound already used for `/api/player-weekly`'s free-agent
pool, to keep the response from exploding to every NFL player. Response shape: `league`,
`season`, `weeks`, `source_summary`, `coverage` (with `field_support`), `records[]`.

### `GET /api/manager-availability`

```text
?league=devoted-to-the-game&season=2025
```

Per-manager **factual counts only** — `rostered_player_weeks`, `starter_player_weeks`,
`starter_unavailable_weeks`, `ir_player_weeks`, `bye_starter_weeks`, `inactive_starter_weeks`
(always 0 — see coverage), `confirmed_injury_starter_weeks` (always 0), and
`unknown_absence_starter_weeks`. No injury-response scoring, no efficiency judgment — that
belongs to the downstream R manager-efficiency engine.

### Validated against real 2025 Devoted to the Game data

Full-season build (17 weeks, 12 rosters): 4,998 player-weeks, 3,917 `participated`, 276 `bye`,
83 `ir`, 722 `unknown`, 0 `did_not_play_unknown` (Sleeper's stats endpoint omits inactive
players entirely rather than publishing a `gp=0` row — a real, documented gap, not a bug).
Spot-checked: Sam LaPorta (Rawb21's roster) correctly resolves to `ir`/`low confidence` in the
trailing weeks of the season; a real bye week is detected with `high` confidence; a real
return-from-absence week exists; DarthMarker made real transaction activity within a week of
Garrett Wilson's first non-participation week. See
`test/historical-availability.test.ts` and `test/historical-availability-live.test.ts`.

## Projection layers (2026 Roster Intel projection engine)

`lib/projections/*` builds a **scoring-neutral NFL projection first**, then translates it, in
strictly separated layers:

| Layer | Question | Keyed by | Code | Endpoint |
| --- | --- | --- | --- | --- |
| **1 — football** | "What will this NFL player actually do?" | season + player + `projection_version` | `model.ts`, `uncertainty.ts`, `reconcile.ts`, `build.ts` | `GET /api/projections[/:playerId]` |
| **2 — league scoring** | "What is that worth in *this* league?" | + `league_id` + `scoring_hash` | `league.ts`, `replacement.ts` | `GET /api/leagues/:slug/projections[/:playerId]` |
| **3 — manager value** | "What is that worth to *this* manager's roster right now?" | + `sleeper_user_id` + draft state | `manager-value.ts` | `GET /api/leagues/:slug/managers/:mgr/projections` |

A player's projected receptions **do not change** because two managers look at them. Two managers in
the same league get **identical** `league_points`; only `contextual_value` differs. `roster_id` is
never a cache key — BijiMac and DarthMarker are both `roster_id 2` in different leagues.

**Sleeper projections are a BENCHMARK, never a model input.** `lib/projections/sleeper.ts` ingests
Sleeper's RotoWire-sourced projections (`api.sleeper.app/projections/nfl/{season}`) purely to
compare against — `RI_STANDALONE` is built only from historical box-score actuals
(`/v1/stats/nfl/regular/{season}`), depth-chart role, position baselines and age curves. Every
player carries `vs_sleeper` with the point delta **and** the underlying stat deltas (targets,
carries, yards, TDs) and a deterministic `primary_driver`. "Closer to Sleeper" is not treated as
"better".

**Philosophy: opportunity before efficiency.** team environment → position-group volume pools →
player opportunity share → efficiency (shrunk toward baseline) → touchdowns (from red-zone
opportunity + team TD environment + regressed conversion, *not* last year's total) → games
(availability model) → season stat line. Fantasy points are an output, not the model target.

**Per-game vs season.** The Layer-1 stat line is full (17-game) pace. Availability is applied only
to season points: `season = points_per_game × expected_games`. Per-game talent is never lowered
because a player might miss games (and the `vs_sleeper` comparison is done on a full-pace basis so
it is apples-to-apples).

Build the artifacts (`outputs/projections-2026/`, incl. `FINAL_PROJECTION_AUDIT.md`,
`projection_comparison.csv`, `projection_backtest.csv`, `team_reconciliation.csv`):

```bash
npx tsx scripts/build-projections.ts
```

**Calibration (R).** `model_version: ri-structural-2026.3`. Phase 2 (`ri-structural-2026.2`)
calibrated the veteran core with a reproducible R harness — rolling season-aware validation, the
expected-games haircut selected by a **development-only rule** (2023-2024) then run once against
the untouched 2025 holdout, 1000-resample bootstrap, paired candidate-vs-baseline testing,
shrinkage-K sweep, opportunity-component and team-reconciliation analysis. Phase 3
(`ri-structural-2026.3`) added a held-out-validated **draft-capital rookie opportunity prior**
(`log(1+pick)` + round, quasi-Poisson, WR/RB/TE) — college production was tested and proven to add
**no** incremental signal beyond draft capital, so it is not used. Every Phase 2 lever is frozen
byte-identical.

```bash
npx tsx scripts/export-backtest-dataset.ts    # raw historical dataset from Sleeper actuals
Rscript analysis/phase2_calibration.R         # -> outputs/projections-2026/phase2_*.csv + analysis/plots/
npx tsx scripts/audit-production-v1-v2.ts      # production-path v1 -> v2 impact + sign-reversal audit
Rscript analysis/phase3_rookie_role_model.R   # rookie cohort, models M0-M6, 2025 holdout, 2026 crosswalk
npx tsx scripts/audit-phase3-rookie.ts        # production-path v2 -> v3 impact + redistribution audit
```

The R port of the projection core (`analysis/lib_ri_projection.R`) is parity-checked against the
production TypeScript in `test/projection-r-parity.test.ts`; the calibration's production invariants
(expected-games monotonicity, age direction, opportunity-shade bounds, team conservation, layer
invariance, Sleeper independence) are proven in `test/projection-calibration-invariants.test.ts`.

Tests: `test/projections.test.ts` (deterministic, fixture-based), `test/projections-live.test.ts`
(live Sleeper, layer invariance, manager isolation, full-roster), `test/projection-r-parity.test.ts`
(R↔TS core), `test/projection-calibration-invariants.test.ts`, `test/projection-rookie-model.test.ts`
(Phase 3 rookie prior — R↔TS parity, football invariants, share-cap conservation). See
`lib/projections/README.md` for the calibration state and known limitations.

## Caching

| Data                                            | Strategy                                             | Why                                                               |
| ----------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| League, users, rosters, drafts, picks           | Next data cache, 5 min                               | Changes slowly; keeps Sleeper calls low                           |
| `/api/league` response                          | CDN `s-maxage=300, stale-while-revalidate=900`       | Vercel serves instantly, refreshes in background                  |
| `/players/nfl` (~14 MB)                         | In-memory, 24 h TTL, module scope                    | Sleeper's docs: _"use this call sparingly… once per day at most"_ |
| Draft object + picks (during a draft)           | Uncached (`no-store`)                                | Live bidding must be current                                      |
| `/api/draft` response                           | 5s while drafting, 30s pre-draft, 300s once complete | Fresh enough to poll, cheap enough to spam                        |
| Historical seasons (all analytics endpoints)    | Next data cache, 24 h                                | A finished season's results never change                          |
| Current-season league/users/rosters (analytics) | Next data cache, 1-5 min                             | Same freshness tier as `/api/league`'s core resources             |
| Current-week matchups / transactions            | Next data cache, 60s                                 | Changes during the week, but not second to second                 |
| Weekly stats: a completed week                  | Next data cache, 1 h                                 | The box score is final                                            |
| Weekly stats: the current week                  | Next data cache, 5 min                               | Stats can still update as late games finish                       |
| `/api/value`                                    | CDN 1 h                                              | No live source configured; nothing to invalidate quickly          |
| `/api/snapshot`                                 | CDN `s-maxage=30, stale-while-revalidate=60`         | Composed from live pieces; kept close to real-time                |
| `/api/health`                                   | `no-store`                                           | Must reflect live state                                           |

The player database is too large for Next's data cache (2 MB per entry), so it is fetched with
`no-store`, trimmed to ~13 fields per player on the way in, and held in module scope — which
survives across invocations on a warm serverless instance. Concurrent cold starts are de-duplicated
into a single upstream fetch, and a stale index is preferred over a hard failure.

Net effect: `/api/league` returns **~44 KB**, about **321× smaller** than the raw player dump.

---

## Local development

```bash
npm install
npm run dev
```

Then:

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/league | python3 -m json.tool | head -60
```

### Checks

```bash
npm run typecheck
npm run lint
npm test
```

`npm run lint` drives ESLint directly — Next 16 removed the `next lint` command.

`npm test` runs 297 tests: normalization and draft-logic units against a synthetic league built
from **real** Sleeper player IDs, a simulated mid-auction exercising the full team-assembly
pipeline, the scoring engine's yardage/TD/archetype/sensitivity math, the factual analytics layer's
standings/transaction/roster/weekly-stat calculations, the league registry's validation/dedup/
disabled-target/malformed-id guarantees against synthetic fixtures, and live end-to-end tests
against both the Bloodline Bowl and Devoted to the Game leagues — including a scan of every
analytics response for forbidden subjective fields, full-season (18-week) reconciliation of
Devoted to the Game's 2025 player scoring against Sleeper's own matchup totals, and the known
2025 Judkins/Jennings trade's before/after roster ownership — plus error paths (404, timeout, degraded
player database). The live tests require network access.

### Configuration

No credentials are needed — Sleeper's read endpoints are public and unauthenticated.

| Variable            | Default               | Purpose                                                  |
| ------------------- | --------------------- | -------------------------------------------------------- |
| `SLEEPER_LEAGUE_ID` | `1395549281678532608` | Point the bridge at a different league. Must be numeric. |

---

## Deploying to Vercel

Already deployed:

|                |                                                               |
| -------------- | ------------------------------------------------------------- |
| Production     | <https://bloodline-bowl-sleeper-bridge.vercel.app>            |
| Main endpoint  | <https://bloodline-bowl-sleeper-bridge.vercel.app/api/league> |
| Vercel project | `supyo29s-projects/bloodline-bowl-sleeper-bridge`             |

To ship subsequent changes:

```bash
vercel --prod
```

The project is linked via `.vercel/project.json` (gitignored). Vercel Authentication is enabled for
preview and deployment-specific URLs; the production alias above is public, which is what lets an
external AI fetch it.

`/api/league` runs on the Node.js runtime with `maxDuration = 60` to absorb the occasional cold
start where the player database has to be re-downloaded. Warm requests return in milliseconds.

CORS is open for read-only `GET`/`OPTIONS` (`Access-Control-Allow-Origin: *`), so ChatGPT, Claude,
or a browser can fetch the endpoint directly.

---

## Security notes

- Read-only. No writes, no credentials, no database.
- `/api/raw` is allowlisted, not a proxy: `resource` must match a known key and `draft_id` must be
  numeric, so no caller-supplied string ever reaches a Sleeper URL.
- `SLEEPER_LEAGUE_ID` is validated as numeric before use.
- No secrets are required or stored.

### Dependency advisories

`npm audit` reports **0 vulnerabilities**. The project runs Next 16, which clears the earlier
`postcss` and `sharp` advisories carried by the Next 15 line.
