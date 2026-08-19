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

**League ID:** `1395549281678532608`

---

## What it does

Sleeper's public API is normalized for storage, not for analysis. Rosters are arrays of opaque
player IDs, managers are separate from teams, lineup slots are positional, and traded picks only
appear when they've changed hands. This bridge does the joins:

| Sleeper gives you | The bridge gives you |
| --- | --- |
| `"players": ["4046", "6794"]` | Full player objects with name, position, NFL team, age, injury status |
| `owner_id` on a roster, users in a separate call | A `manager` object attached to each team |
| `"starters": ["4046", "0", …]` positional array | Each starter paired with the lineup slot it fills, empty slots flagged |
| Only *traded* picks | Every roster's complete pick inventory, filed under its current owner |
| A 14 MB player database | Only the players this league actually references |
| Terse settings like `waiver_type: 2` | A `key_settings` gloss (`"waiver_type": "faab"`) alongside the raw values |

Original Sleeper IDs are preserved everywhere, so nothing is lost for debugging or future joins.

---

## API

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

| Query parameter | Default | Notes |
| --- | --- | --- |
| `available_limit` | `300` | 1–1000. Caps the available-player pool. |
| `position` | none | One of `QB`, `RB`, `WR`, `TE`, `K`, `DEF`. Validated against the league's own roster positions. |

```bash
curl "https://bloodline-bowl-sleeper-bridge.vercel.app/api/draft?position=RB&available_limit=20"
```

Response headers carry `X-Draft-Status` and a status-dependent `Cache-Control`.

### `GET /api/draft/debug`

Sanitized dump of the raw Sleeper draft fields — draft settings, the metadata keys
Sleeper actually returns on picks, and whether an `amount` field is present. Exists to
verify auction-price behavior on draft night. Takes no parameters and is safe to delete;
nothing else imports it.

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
    health/route.ts     liveness probe
    raw/route.ts        allowlisted raw passthrough
  page.tsx              minimal status page
  layout.tsx

lib/
  http.ts               CORS + cache header helpers
  sleeper/
    types.ts            raw Sleeper types + normalized output types
    client.ts           HTTP client: timeouts, retries, player-DB cache
    normalize.ts        pure normalization for /api/league (no HTTP)
    service.ts          /api/league orchestration + graceful degradation
    budget.ts           pure auction budget math
    draft.ts            pure draft logic: needs, availability, team assembly
    draft-service.ts    /api/draft orchestration + tiered fetch freshness

test/
  fixtures.ts             synthetic league using real Sleeper player IDs
  normalize.test.ts       normalization unit tests
  live.test.ts            end-to-end against the real Sleeper API
  draft.test.ts           budget, needs, availability, query validation
  draft-simulation.test.ts  full team assembly against a simulated mid-auction
  draft-live.test.ts      /api/draft end-to-end against the real league
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
*synthesizes* the full inventory — every roster starts owning its own pick in every round — and
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

Bloodline Bowl is a **$200 auction** filling **16 roster slots** per team.

```text
spent      = sum of acquisition prices (an unknown price counts as 0)
remaining  = starting_budget - spent
reserve    = (slots_remaining - 1) * minimum_bid
max_bid    = remaining - reserve
```

The reserve is what a manager must hold back to fill every *other* remaining slot at
the minimum bid. A manager with $83 and 6 slots left can bid at most **$78**; with one
slot left they can spend everything.

Sleeper exposes **no minimum-bid setting**, so $1 is assumed and labelled as such via
`budget.minimum_bid_source: "assumed_default"`.

### Positional needs and FLEX

`needs.required` lists only **strict** starting slots that are genuinely unfilled. A
team with two RBs and an empty FLEX is *not* reported as needing a third RB — flex
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

## Caching

| Data | Strategy | Why |
| --- | --- | --- |
| League, users, rosters, drafts, picks | Next data cache, 5 min | Changes slowly; keeps Sleeper calls low |
| `/api/league` response | CDN `s-maxage=300, stale-while-revalidate=900` | Vercel serves instantly, refreshes in background |
| `/players/nfl` (~14 MB) | In-memory, 24 h TTL, module scope | Sleeper's docs: *"use this call sparingly… once per day at most"* |
| Draft object + picks (during a draft) | Uncached (`no-store`) | Live bidding must be current |
| `/api/draft` response | 5s while drafting, 30s pre-draft, 300s once complete | Fresh enough to poll, cheap enough to spam |
| `/api/health` | `no-store` | Must reflect live state |

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

`npm test` runs 124 tests: normalization and draft-logic units against a synthetic league built
from **real** Sleeper player IDs, a simulated mid-auction exercising the full team-assembly
pipeline, and live end-to-end tests against the actual Bloodline Bowl league plus error paths
(404, timeout, degraded player database). The live tests require network access.

### Configuration

No credentials are needed — Sleeper's read endpoints are public and unauthenticated.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SLEEPER_LEAGUE_ID` | `1395549281678532608` | Point the bridge at a different league. Must be numeric. |

---

## Deploying to Vercel

Already deployed:

| | |
| --- | --- |
| Production | <https://bloodline-bowl-sleeper-bridge.vercel.app> |
| Main endpoint | <https://bloodline-bowl-sleeper-bridge.vercel.app/api/league> |
| Vercel project | `supyo29s-projects/bloodline-bowl-sleeper-bridge` |

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
