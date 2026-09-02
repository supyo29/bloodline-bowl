/**
 * Transaction-sync idempotency & concurrency — deterministic (no network).
 *
 * Regression coverage for the production defect: two `/api/cron/capture` jobs
 * ~1.3s apart both tried to persist the same Sleeper transactions; the second
 * ledger insert collided with the composite UNIQUE constraint and was recorded
 * as ERROR (data stayed correct — 0 duplicate rows — but the sync status lied).
 *
 * Root cause: `SupabaseRest.insertIgnoreDuplicates` sent no `on_conflict`
 * target, so PostgREST inferred the PRIMARY KEY (`id`) and a violation of the
 * *composite* UNIQUE was NOT ignored -> SQLSTATE 23505 -> surfaced as an error.
 *
 * Fix: explicit `ON CONFLICT (league_slug, season, provider,
 * provider_transaction_id) DO NOTHING`. These tests run the REAL store code
 * against a faithful in-memory PostgREST that honours the conflict target and
 * `return=representation` (skipped rows are not returned).
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { syncLeagueTransactions } from "../lib/persistence/capture";
import { memoryPersistence } from "../lib/persistence/memory";
import { SupabaseLedgerStore, SupabaseSnapshotStore } from "../lib/persistence/supabase/stores";
import { SupabaseRestError, PG_UNIQUE_VIOLATION } from "../lib/persistence/supabase/rest";
import type { SupabaseRest } from "../lib/persistence/supabase/rest";
import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalLeagueSnapshot,
  type CanonicalTransaction,
} from "../lib/canonical/schema";

/* --------------------------------------------------------------------------
 * FakePostgrest — models the semantics the fix relies on:
 *   - INSERT ... ON CONFLICT (<conflictColumns>) DO NOTHING
 *   - return=representation -> only actually-inserted rows come back
 *   - a non-conflict failure (e.g. a poisoned row) throws a real error
 *   - a WRONG conflict target does NOT catch the composite unique (the old bug)
 * ------------------------------------------------------------------------ */

interface FakeOpts {
  /** Force a non-unique DB error when a row has this key === true. */
  poisonKey?: string;
  /** Add latency so concurrent appends genuinely interleave. */
  latencyMs?: number;
}

class FakePostgrest {
  tables = new Map<string, Array<Record<string, unknown>>>();
  /** Real unique indexes on the bridge tables. */
  private uniques: Record<string, string[][]> = {
    bridge_transaction_ledger: [
      ["id"],
      ["league_slug", "season", "provider", "provider_transaction_id"],
    ],
    bridge_league_snapshots: [
      ["id"],
      ["league_slug", "season", "week", "capture_type", "content_hash"],
    ],
  };

  constructor(private opts: FakeOpts = {}) {}

  private rows(table: string): Array<Record<string, unknown>> {
    let r = this.tables.get(table);
    if (!r) {
      r = [];
      this.tables.set(table, r);
    }
    return r;
  }

  private key(row: Record<string, unknown>, cols: string[]): string {
    return cols.map((c) => JSON.stringify(row[c] ?? null)).join("|");
  }

  private violatesUnique(table: string, row: Record<string, unknown>, exceptCols: string[]): string[] | null {
    for (const cols of this.uniques[table] ?? []) {
      if (cols.join(",") === exceptCols.join(",")) continue;
      const k = this.key(row, cols);
      if (this.rows(table).some((existing) => this.key(existing, cols) === k)) return cols;
    }
    return null;
  }

  async insertIgnoreDuplicates<T>(
    table: string,
    rows: Record<string, unknown>[],
    conflictColumns: string[],
  ): Promise<T[]> {
    if (conflictColumns.length === 0) throw new Error("no conflict target");
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));

    // The INSERT is atomic: build the result, throw before committing anything.
    const toInsert: Record<string, unknown>[] = [];
    const seenInBatch = new Set<string>();
    for (const row of rows) {
      const full = { id: `fake_${Math.random().toString(36).slice(2)}`, ...row };

      // A genuine (non-conflict) failure aborts the whole statement.
      if (this.opts.poisonKey && row[this.opts.poisonKey] === "__POISON__") {
        throw new SupabaseRestError(`Supabase POST ${table} -> 400 [22P02]`, 400, table, "22P02");
      }

      const ck = this.key(full, conflictColumns);
      // Already stored (another run / concurrent job) OR earlier in this batch -> DO NOTHING.
      const conflictsStored = this.rows(table).some((e) => this.key(e, conflictColumns) === ck);
      if (conflictsStored || seenInBatch.has(ck)) {
        seenInBatch.add(ck);
        continue;
      }

      // A violation of a DIFFERENT unique index is still an error (the old bug:
      // if conflictColumns were ["id"], the composite unique would land here).
      if (this.violatesUnique(table, full, conflictColumns)) {
        throw new SupabaseRestError(
          `Supabase POST ${table} -> 409 [${PG_UNIQUE_VIOLATION}]`,
          409,
          table,
          PG_UNIQUE_VIOLATION,
        );
      }

      seenInBatch.add(ck);
      toInsert.push(full);
    }
    this.rows(table).push(...toInsert);
    return toInsert as T[];
  }

  async select<T>(
    table: string,
    opts: { filter?: Record<string, string>; limit?: number } = {},
  ): Promise<T[]> {
    let rows = [...this.rows(table)];
    for (const [k, v] of Object.entries(opts.filter ?? {})) {
      const m = /^eq\.(.*)$/.exec(v);
      if (m) rows = rows.filter((r) => String(r[k]) === m[1]);
    }
    if (opts.limit) rows = rows.slice(0, opts.limit);
    return rows as T[];
  }

  async insert<T>(table: string, row: Record<string, unknown>): Promise<T[]> {
    const full = { id: `fake_${Math.random().toString(36).slice(2)}`, ...row };
    this.rows(table).push(full);
    return [full] as T[];
  }
  async update(): Promise<void> {}
}

function asRest(fake: FakePostgrest): SupabaseRest {
  return fake as unknown as SupabaseRest;
}

/* --------------------------------------------------------------------------- */

function txn(overrides: Partial<CanonicalTransaction> & { provider_id: string }): CanonicalTransaction {
  const { provider_id, ...rest } = overrides;
  return {
    canonical_transaction_id: `txn:sleeper:bloodline-bowl:2026:${provider_id}`,
    canonical_league_id: "league:bloodline-bowl",
    league_slug: "bloodline-bowl",
    season: 2026,
    type: "trade",
    status: "complete",
    provider_timestamp: "2026-09-02T18:44:00Z",
    fantasy_week: 1,
    canonical_team_ids: ["team:bloodline-bowl:1"],
    players_added: [],
    players_dropped: [],
    trade_legs: [],
    faab_spent: null,
    provenance: { provider: "sleeper", provider_id, provider_synced_at: null },
    source_metadata: {},
    ...rest,
  };
}

const THREE = [txn({ provider_id: "T1" }), txn({ provider_id: "T2" }), txn({ provider_id: "T3" })];

/* ----------------------------------------------- Test 1 — repeated sync */

describe("Test 1 — repeated transaction sync is a successful no-op", () => {
  it("second identical append inserts 0, reports READY, one row per transaction", async () => {
    const store = new SupabaseLedgerStore(asRest(new FakePostgrest()));

    const first = await store.append(THREE);
    assert.deepEqual(
      { status: first.status, seen: first.seen, inserted: first.inserted, duplicates: first.duplicates },
      { status: "READY", seen: 3, inserted: 3, duplicates: 0 },
    );

    const second = await store.append(THREE);
    assert.deepEqual(
      { status: second.status, seen: second.seen, inserted: second.inserted, duplicates: second.duplicates },
      { status: "READY", seen: 3, inserted: 0, duplicates: 3 },
    );
    assert.equal(second.error, undefined);
    assert.equal(await store.count("bloodline-bowl", 2026), 3);
  });
});

/* ----------------------------------------------- Test 2 — duplicate batch */

describe("Test 2 — the same provider transaction supplied twice in one batch", () => {
  it("stores exactly one row and succeeds", async () => {
    const store = new SupabaseLedgerStore(asRest(new FakePostgrest()));
    const dupBatch = [txn({ provider_id: "D1" }), txn({ provider_id: "D1" }), txn({ provider_id: "D2" })];
    const res = await store.append(dupBatch);
    assert.equal(res.status, "READY");
    assert.equal(res.inserted, 2); // D1 once + D2
    assert.equal(res.duplicates, 1);
    assert.equal(res.error, undefined);
    assert.equal(await store.count("bloodline-bowl", 2026), 2);
  });
});

/* ----------------------------------------------- Test 3 — simulated concurrency */

describe("Test 3 — two overlapping syncs of the same transactions", () => {
  it("exactly one row per transaction; BOTH callers resolve READY; no fatal uniqueness error", async () => {
    const fake = new FakePostgrest({ latencyMs: 5 });
    const store = new SupabaseLedgerStore(asRest(fake));

    // Job A syncs [T1,T2,T3]; Job B (fired ~concurrently) syncs [T1,T2,T3,T4].
    const jobB = [...THREE, txn({ provider_id: "T4" })];
    const [a, b] = await Promise.all([store.append(THREE), store.append(jobB)]);

    assert.equal(a.status, "READY");
    assert.equal(b.status, "READY");
    assert.equal(a.error, undefined);
    assert.equal(b.error, undefined);

    // Across both runs, T1..T4 each stored exactly once.
    assert.equal(a.inserted + b.inserted, 4, "total inserts across both overlapping runs");
    assert.equal(await store.count("bloodline-bowl", 2026), 4);

    // Re-running either now is a pure no-op.
    const rerun = await store.append(jobB);
    assert.deepEqual({ inserted: rerun.inserted, duplicates: rerun.duplicates, status: rerun.status }, {
      inserted: 0,
      duplicates: 4,
      status: "READY",
    });
  });
});

/* ----------------------------------------------- Test 4 — real DB error surfaces */

describe("Test 4 — a non-uniqueness database failure still surfaces", () => {
  it("append does NOT convert a genuine error into a successful no-op", async () => {
    const fake = new FakePostgrest({ poisonKey: "provider_transaction_id" });
    const store = new SupabaseLedgerStore(asRest(fake));
    const poisoned = [txn({ provider_id: "OK1" }), txn({ provider_id: "__POISON__" })];

    const res = await store.append(poisoned);
    assert.equal(res.status, "PERSISTENCE_ERROR");
    assert.ok(res.error);
    assert.match(res.error, /22P02/); // SQLSTATE surfaced, not swallowed
    assert.equal(res.inserted, 0);
    // Atomic: nothing was written.
    assert.equal(await store.count("bloodline-bowl", 2026), 0);
  });

  it("status() reports PERSISTENCE_ERROR when the DB is unreachable", async () => {
    const broken = {
      select: async () => {
        throw new SupabaseRestError("Supabase GET x -> 503", 503, "x");
      },
    } as unknown as SupabaseRest;
    const store = new SupabaseLedgerStore(broken);
    assert.equal(await store.status(), "PERSISTENCE_ERROR");
  });
});

/* ----------------------------------------------- Test 5 — identity still distinguishes */

describe("Test 5 — the uniqueness key still distinguishes genuinely different transactions", () => {
  it("different provider_transaction_id / league / season / provider are all kept", async () => {
    const store = new SupabaseLedgerStore(asRest(new FakePostgrest()));
    await store.append([
      txn({ provider_id: "SAME" }),
      txn({ provider_id: "SAME", league_slug: "devoted-to-the-game", canonical_league_id: "league:devoted-to-the-game" }),
      txn({ provider_id: "SAME", season: 2025 }),
      txn({ provider_id: "SAME", provenance: { provider: "yahoo", provider_id: "SAME", provider_synced_at: null } }),
      txn({ provider_id: "DIFFERENT" }),
    ]);
    // 5 rows: (bloodline,2026,sleeper,SAME) vs (devoted,…) vs (…,2025,…) vs (…,yahoo,…) vs (…,DIFFERENT)
    assert.equal(await store.count("bloodline-bowl", 2026), 3); // SAME/sleeper, SAME/yahoo, DIFFERENT/sleeper
    assert.equal(await store.count("devoted-to-the-game", 2026), 1);
    assert.equal(await store.count("bloodline-bowl", 2025), 1);

    // And re-appending that exact set is a full no-op — identity is stable.
    const rerun = await store.append([txn({ provider_id: "SAME" }), txn({ provider_id: "DIFFERENT" })]);
    assert.equal(rerun.inserted, 0);
    assert.equal(rerun.duplicates, 2);
  });
});

/* ------------------------------- root-cause guard: wrong conflict target = the bug */

describe("root cause: an inferred-PK conflict target does NOT protect the composite unique", () => {
  it("insertIgnoreDuplicates with the WRONG target raises 23505 on a repeat (documents the fixed bug)", async () => {
    const fake = new FakePostgrest();
    const row = {
      league_slug: "bloodline-bowl",
      season: 2026,
      provider: "sleeper",
      provider_transaction_id: "Z",
      canonical_transaction_id: "c_Z",
      transaction_type: "trade",
      payload: {},
    };
    await fake.insertIgnoreDuplicates("bridge_transaction_ledger", [row], [
      "league_slug",
      "season",
      "provider",
      "provider_transaction_id",
    ]);
    // Same row again, but with the OLD (wrong) conflict target -> composite
    // unique is unhandled -> 23505.
    await assert.rejects(
      () => fake.insertIgnoreDuplicates("bridge_transaction_ledger", [row], ["id"]),
      (e: unknown) => e instanceof SupabaseRestError && e.code === PG_UNIQUE_VIOLATION,
    );
  });
});

/* -------------------------------- snapshot store: same conflict-target fix, versioning intact */

function snap(hash: string): CanonicalLeagueSnapshot {
  return {
    schema_version: CANONICAL_SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    provider_synced_at: null,
    league: {
      canonical_league_id: "league:bloodline-bowl",
      league_slug: "bloodline-bowl",
      name: "Bloodline Bowl",
      season: 2026,
      status: "in_season",
      sport: "nfl",
      team_count: 12,
      current_week: 1,
      scoring_rules: [],
      raw_scoring: { marker: hash === "A" ? 1 : 2 },
      roster_settings: { starting_slots: [], bench_slots: 0, ir_slots: 0, taxi_slots: 0, slot_requirements: {} },
      playoff_settings: { playoff_team_count: null, playoff_start_week: null, championship_week: null },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: "1395549281678532608", provider_synced_at: null },
    },
    season: 2026,
    week: 1,
    managers: [],
    teams: [],
    rosters: [],
    standings: [],
    matchups: [],
    recent_transactions: [],
    draft_picks: [],
    waiver_state: null,
    players: [],
    unresolved_players: [],
    live_provider_status: "READY",
    history_persistence_status: "READY",
    warnings: [],
  };
}

/* -------------------- end-to-end: the real capture.ts path is idempotent ----- */

describe("live: syncLeagueTransactions is idempotent across repeated runs", () => {
  let online = false;
  before(async () => {
    try {
      online = (await fetch("https://api.sleeper.app/v1/state/nfl", { signal: AbortSignal.timeout(5000) })).ok;
    } catch {
      online = false;
    }
  });

  it("second sync of the same league writes 0 new rows and reports success", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const persistence = memoryPersistence();

    const first = await syncLeagueTransactions("bloodline-bowl", { trigger: "TEST", persistence });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.persistence_status, "READY");
    const total = first.seen;
    assert.equal(first.inserted, total);
    assert.equal(first.duplicates, 0);

    const second = await syncLeagueTransactions("bloodline-bowl", { trigger: "TEST", persistence });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.error, undefined);
    assert.equal(second.seen, total);
    assert.equal(second.inserted, 0, "nothing new on the second run");
    assert.equal(second.duplicates, total);
    assert.equal(await persistence.ledger.count("bloodline-bowl", 2026), total);
  });

  it("two overlapping syncs never fatally collide", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const persistence = memoryPersistence();
    const [a, b] = await Promise.all([
      syncLeagueTransactions("devoted-to-the-game", { trigger: "TEST", persistence }),
      syncLeagueTransactions("devoted-to-the-game", { trigger: "TEST", persistence }),
    ]);
    assert.equal(a.ok, true, a.error);
    assert.equal(b.ok, true, b.error);
    assert.equal(a.inserted + b.inserted, a.seen, "each transaction stored exactly once across both runs");
    assert.equal(await persistence.ledger.count("devoted-to-the-game", 2026), a.seen);
  });
});

describe("snapshot put: concurrent identical capture is a no-op; different content still versions", () => {
  it("two identical concurrent captures -> one row (duplicate), no error", async () => {
    const store = new SupabaseSnapshotStore(asRest(new FakePostgrest({ latencyMs: 5 })));
    const s = snap("A");
    const [a, b] = await Promise.all([
      store.put(s, { capture_type: "AD_HOC" }),
      store.put({ ...s, captured_at: new Date(Date.now() + 1300).toISOString() }, { capture_type: "AD_HOC" }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ["created", "duplicate"]);
    assert.equal(a.status, "READY");
    assert.equal(b.status, "READY");
  });

  it("genuinely different content lands as a second version (versioning unchanged)", async () => {
    const store = new SupabaseSnapshotStore(asRest(new FakePostgrest()));
    const first = await store.put(snap("A"), { capture_type: "AD_HOC" });
    const second = await store.put(snap("B"), { capture_type: "AD_HOC" });
    assert.equal(first.outcome, "created");
    assert.equal(second.outcome, "created");
    assert.equal((await store.listVersions({ league_slug: "bloodline-bowl", season: 2026, week: 1 })).length, 2);
  });
});
