# Bloodline Bowl Trade Engine — Production Reference

The canonical, durable summary of the trade engine as it exists in production. For
the point-in-time integration/deployment/QA record, see
`docs/TRADE_ENGINE_PRODUCTION_READINESS.md`. For each phase's own detailed build and
audit rationale, see `docs/TRADE_ENGINE_PHASE{1..6}[_AUDIT].md`.

## Architecture

```
Phase 1 (Foundation)     What does this transaction do to each roster?
       │                 lib/trades/{schema,config,evaluate,validate,reconstruct}.ts
       ▼
Phase 2 (Contextual)     What is that change worth structurally and over the season?
       │                 lib/trades/{context,ros,depth}.ts — additive, zero-weighted by default
       ▼
Phase 3 (Calibrated)     What player-intelligence evidence exists, how trustworthy?
       │                 lib/trades/{phase3,intelligence,confidence,calibration}.ts — SHADOW ONLY
       ▼
Phase 4 (Discovery)      Which trades are worth considering?
       │                 lib/trades/discovery/* — searches, never re-values
       ▼
Phase 5 (Negotiation)    How should a viable trade be presented/countered?
       │                 lib/trades/negotiation/* — offer ladders, sweeteners, walk-away
       ▼
Phase 6 (Strategy)       Given the season, which otherwise-rational trade to prefer?
                         lib/trades/strategy/* — bounded preference layer, never re-values
```

Every layer above Phase 1 is strictly additive: it reads the prior layer's output and
produces a NEW field, never overwrites `roster_utility_delta` or `acceptance`. This is
enforced structurally (caps, promotion ceilings, dedicated fields) and verified by
regression at every phase's own audit, re-confirmed at the full-repo level in
`docs/TRADE_ENGINE_PRODUCTION_READINESS.md`.

## Versions (frozen)

```
FOUNDATION      ri-trade-foundation-2026.2
CONTEXTUAL      ri-trade-contextual-2026.2
CALIBRATED      ri-trade-calibrated-2026.2
DATA            ri-trade-data-2026.2
DISCOVERY       ri-trade-discovery-2026.2
NEGOTIATION     ri-trade-negotiation-2026.2
STRATEGY        ri-trade-strategy-2026.2
```

Every version above is returned in the `versions` block of `POST /api/trades/
{analyze,discover,negotiate}`'s responses, and `strategy_version` is returned
alongside `manager_strategic_profile` whenever `include_strategic: true` is set.

## Endpoint inventory

| Route | Method | Purpose |
|---|---|---|
| `/api/trades/analyze` | POST | Evaluate one already-specified N-party trade proposal (Phase 1/2/3-shadow). |
| `/api/trades/discover` | POST | Search for trade candidates (Phase 4); optional `include_strategic`. |
| `/api/trades/negotiate` | POST | Offer-ladder/counteroffer/walk-away intelligence for one target or proposal (Phase 5); optional `include_strategic` (Phase 6, `ACQUIRE_TARGET` only). |
| `/api/leagues/{league}/managers/{manager}/strategic-context` | GET | Standalone read of one manager's season-state strategic profile (Phase 6). |

All four are read-only and stateless — no Sleeper write path exists anywhere in
`lib/trades/`.

## Data ownership

- **Canonical league state**: one read per request via `buildTradeAnalysisContext`
  (`lib/trades/context.ts`), itself built from `buildCanonicalLeagueState`
  (`lib/canonical/state.ts`) — the same snapshot every non-trade endpoint uses.
- **Real historical trades**: `lib/trades/data/historical_trades_sleeper.json` (1 real
  trade, committed, live-wired into `calibration_status` only — never into valuation).
- **Real R-produced usage/schedule data**: `lib/trades/data/player_{usage,schedule_
  strength}_weekly.csv` + `.meta.json` (committed, NOT wired into any live path — see
  `lib/trades/r-data-providers.ts`'s doc comment and the packaging verification in
  `docs/TRADE_ENGINE_PRODUCTION_READINESS.md` Section D).
- **Standings/playoff geometry**: read directly from the canonical snapshot
  (`ctx.snapshot.standings`, `ctx.ros`) — Phase 6 never re-derives or duplicates this.

## Shadow / calibration status

Phase 3's player-intelligence layer is **SHADOW ONLY**: `resolvePhase3CalibrationMode`
(`lib/trades/activation.ts`) reads an env-only `PHASE3_CALIBRATION_MODE` variable and
refuses `PRODUCTION` unconditionally regardless of what the environment requests —
downgraded to `SHADOW` every time, pending real ablation evidence. No public API
request can override this: `sanitizePublicTradeConfig` never reads a client-supplied
`phase3` key at all, and `discover`/`negotiate` never parse a `config` field from the
request body in the first place.

## The 50-trade calibration gate

```
TRADE_CALIBRATION_MIN_REAL_TRADES = 50
```

A durable reopen gate, not automatic permission. Currently 1 real trade on file
(`remaining_trade_count: 49` in every live `calibration_status` response). Reaching 50
only makes `review_available: true` — it does **not** auto-enable any weight. No code
path anywhere reads this count to activate anything; it is purely a display/gating
value checked against a fixed constant.

## Known limitations

See `docs/TRADE_ENGINE_PRODUCTION_READINESS.md` Section N for the full, current list
(historical corpus size, shadow-only player intelligence, no real playoff-odds
simulator, conservative early-season classification, bilateral-only negotiation,
provider-outage sensitivity, the pre-existing 10 `live:` test failures, and the two
open non-blocking findings: `analyze`'s Sleeper-only `player_id` contract, and Phase
4's own vacuous three-team test fixture).

## Deployment

Git-linked Vercel project `bloodline-bowl-sleeper-bridge` (`prj_4Zhxc9SFaWcW2zB0f5Wz6AVrLuHE`),
auto-deploying `main` directly to production. Current production SHA and deployment ID
are recorded in `docs/TRADE_ENGINE_PRODUCTION_READINESS.md` Section E — that document
is updated (or a new dated one created) at each future production integration pass;
this file describes the architecture, which changes far less often than the
deployment record.

## Rollback

See `docs/TRADE_ENGINE_PRODUCTION_READINESS.md` Section O for the last known-good
deployment at the time of the most recent production pass.
