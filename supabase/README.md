# Supabase — bridge persistence

The bridge persists **only** durable history (weekly snapshots + the transaction
ledger + capture-run metadata) to Supabase, behind the `SnapshotStore` /
`LedgerStore` interfaces in `lib/persistence/`. Current league state is still
read live from the provider per request. See
[`../docs/POST_DRAFT_FOUNDATION.md`](../docs/POST_DRAFT_FOUNDATION.md).

## Project

| | |
| --- | --- |
| project ref | `ijpfjdzmaztofawhwepf` ("Roster Intel", shared infra) |
| tables | `bridge_league_snapshots`, `bridge_transaction_ledger`, `bridge_capture_runs` (all `bridge_`-prefixed, RLS on, **no policies** — service-role only) |

## Migrations

`migrations/20260902172602_bridge_post_draft_foundation.sql` is the source of
truth for the three tables — columns, types, primary/unique keys, the content
`UNIQUE` that gives snapshots immutable versioning, the transaction idempotency
`UNIQUE`, indexes, the `bridge_snapshots_immutable()` trigger that blocks
`UPDATE`/`DELETE` on snapshots, and RLS enablement. The live schema was verified
to match this file column-for-column and key-for-key.

Apply / reproduce (CLI ≥ 1.180):

```bash
supabase link --project-ref ijpfjdzmaztofawhwepf
supabase migration up          # or: supabase db push
```

The ledger is append-only at the application layer (`LedgerStore.append` only
inserts, keyed on the idempotency `UNIQUE`); there is no DB-level DELETE block on
the ledger because nothing in the app path ever issues one.

## Environment (server only — never committed, never sent to a client)

```
SUPABASE_URL=https://ijpfjdzmaztofawhwepf.supabase.co   # or SUPABASE_PROJECT_REF=ijpfjdzmaztofawhwepf
SUPABASE_SERVICE_ROLE_KEY=<service_role JWT>
```

With neither set, every write path returns `PERSISTENCE_NOT_CONFIGURED` and reads
return `NOT_CAPTURED`; live provider reads are unaffected.
