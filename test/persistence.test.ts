/**
 * Persistence contracts — deterministic, in-memory (no database).
 *
 * Proves the guarantees the Supabase implementation also enforces (via UNIQUE
 * constraints + an immutability trigger):
 *   - snapshots are immutable + versioned; a later capture never destroys an earlier one
 *   - week / season / league isolation for snapshots
 *   - the ledger is append-only + idempotent; overlapping sync windows do not duplicate
 *   - league isolation for transaction queries
 *   - PERSISTENCE_NOT_CONFIGURED is explicit, never a silent success
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MemoryLedgerStore,
  MemorySnapshotStore,
  memoryPersistence,
} from "../lib/persistence/memory";
import { getPersistence, setPersistence } from "../lib/persistence";
import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalLeagueSnapshot,
  type CanonicalTransaction,
} from "../lib/canonical/schema";

function snapshot(overrides: Partial<CanonicalLeagueSnapshot> & { league_slug: string; season: number; week: number }): CanonicalLeagueSnapshot {
  const { league_slug, season, week, ...rest } = overrides;
  return {
    schema_version: CANONICAL_SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    provider_synced_at: null,
    league: {
      canonical_league_id: `league:${league_slug}`,
      league_slug,
      name: league_slug,
      season,
      status: "in_season",
      sport: "nfl",
      team_count: 2,
      current_week: week,
      scoring_rules: [],
      raw_scoring: {},
      roster_settings: { starting_slots: [], bench_slots: 0, ir_slots: 0, taxi_slots: 0, slot_requirements: {} },
      playoff_settings: { playoff_team_count: null, playoff_start_week: null, championship_week: null },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: "x", provider_synced_at: null },
    },
    season,
    week,
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
    ...rest,
  };
}

function txn(overrides: Partial<CanonicalTransaction> & { league_slug: string; season: number; provider_id: string }): CanonicalTransaction {
  const { league_slug, season, provider_id, ...rest } = overrides;
  return {
    canonical_transaction_id: `txn:sleeper:${league_slug}:${season}:${provider_id}`,
    canonical_league_id: `league:${league_slug}`,
    league_slug,
    season,
    type: "waiver_add",
    status: "complete",
    provider_timestamp: "2026-09-10T12:00:00Z",
    fantasy_week: 2,
    canonical_team_ids: [`team:${league_slug}:1`],
    players_added: [],
    players_dropped: [],
    trade_legs: [],
    faab_spent: 5,
    provenance: { provider: "sleeper", provider_id, provider_synced_at: null },
    source_metadata: {},
    ...rest,
  };
}

/* --------------------------------------------------------------- snapshots */

describe("SnapshotStore: immutable + versioned", () => {
  it("re-putting identical content is a no-op (duplicate), not a new version", async () => {
    const store = new MemorySnapshotStore();
    const s = snapshot({ league_slug: "bloodline-bowl", season: 2026, week: 1, teams: [] });
    const first = await store.put(s, { capture_type: "FINAL" });
    assert.equal(first.outcome, "created");
    // Different captured_at, same underlying content -> still a duplicate.
    const again = await store.put({ ...s, captured_at: new Date(Date.now() + 5000).toISOString() }, { capture_type: "FINAL" });
    assert.equal(again.outcome, "duplicate");
    assert.equal((await store.listVersions({ league_slug: "bloodline-bowl", season: 2026, week: 1 })).length, 1);
  });

  it("changed content lands as a new version; the earlier version is retained", async () => {
    const store = new MemorySnapshotStore();
    const base = snapshot({ league_slug: "bloodline-bowl", season: 2026, week: 1 });
    await store.put(base, { capture_type: "MID_WEEK" });
    const changed = snapshot({ league_slug: "bloodline-bowl", season: 2026, week: 1, standings: [
      { canonical_team_id: "team:bloodline-bowl:1", rank: 1, wins: 1, losses: 0, ties: 0, win_percentage: 1, points_for: 120, points_against: 90, games_played: 1, playoff_seed: null },
    ] });
    await store.put(changed, { capture_type: "MID_WEEK" });
    const versions = await store.listVersions({ league_slug: "bloodline-bowl", season: 2026, week: 1 });
    assert.equal(versions.length, 2);
    const latest = await store.getLatest({ league_slug: "bloodline-bowl", season: 2026, week: 1 });
    assert.equal(latest!.payload.standings.length, 1);
  });

  it("Week 1 cannot be overwritten by Week 2", async () => {
    const store = new MemorySnapshotStore();
    await store.put(snapshot({ league_slug: "bloodline-bowl", season: 2026, week: 1 }), { capture_type: "FINAL" });
    await store.put(snapshot({ league_slug: "bloodline-bowl", season: 2026, week: 2 }), { capture_type: "FINAL" });
    assert.ok(await store.getLatest({ league_slug: "bloodline-bowl", season: 2026, week: 1 }));
    assert.ok(await store.getLatest({ league_slug: "bloodline-bowl", season: 2026, week: 2 }));
    assert.equal((await store.listWeeks("bloodline-bowl", 2026)).length, 2);
  });

  it("one league cannot overwrite another league's snapshot", async () => {
    const store = new MemorySnapshotStore();
    await store.put(snapshot({ league_slug: "bloodline-bowl", season: 2026, week: 1 }), { capture_type: "FINAL" });
    await store.put(snapshot({ league_slug: "devoted-to-the-game", season: 2026, week: 1 }), { capture_type: "FINAL" });
    assert.equal((await store.listWeeks("bloodline-bowl", 2026)).length, 1);
    assert.equal((await store.listWeeks("devoted-to-the-game", 2026)).length, 1);
    const bb = await store.getLatest({ league_slug: "bloodline-bowl", season: 2026, week: 1 });
    assert.equal(bb!.payload.league.league_slug, "bloodline-bowl");
  });

  it("season boundaries are isolated", async () => {
    const store = new MemorySnapshotStore();
    await store.put(snapshot({ league_slug: "bloodline-bowl", season: 2025, week: 1 }), { capture_type: "FINAL" });
    await store.put(snapshot({ league_slug: "bloodline-bowl", season: 2026, week: 1 }), { capture_type: "FINAL" });
    assert.equal((await store.listWeeks("bloodline-bowl", 2025)).length, 1);
    assert.equal((await store.listWeeks("bloodline-bowl", 2026)).length, 1);
  });

  it("multiple capture types for one week coexist", async () => {
    const store = new MemorySnapshotStore();
    await store.put(snapshot({ league_slug: "bloodline-bowl", season: 2026, week: 3 }), { capture_type: "PRE_WEEK" });
    await store.put(snapshot({ league_slug: "bloodline-bowl", season: 2026, week: 3, warnings: [{ code: "x", message: "y" }] }), { capture_type: "FINAL" });
    assert.equal((await store.listWeeks("bloodline-bowl", 2026)).length, 2);
    assert.equal(
      (await store.getLatest({ league_slug: "bloodline-bowl", season: 2026, week: 3, capture_type: "PRE_WEEK" }))!.capture_type,
      "PRE_WEEK",
    );
  });
});

/* ----------------------------------------------------------------- ledger */

describe("LedgerStore: append-only + idempotent", () => {
  it("appending the same provider transaction twice inserts once", async () => {
    const store = new MemoryLedgerStore();
    const t = txn({ league_slug: "bloodline-bowl", season: 2026, provider_id: "sleeper_txn_1" });
    const a = await store.append([t]);
    assert.equal(a.inserted, 1);
    const b = await store.append([t]);
    assert.equal(b.inserted, 0);
    assert.equal(b.duplicates, 1);
    assert.equal(await store.count("bloodline-bowl", 2026), 1);
  });

  it("overlapping sync windows do not duplicate (the core idempotency requirement)", async () => {
    const store = new MemoryLedgerStore();
    const window1 = [
      txn({ league_slug: "bloodline-bowl", season: 2026, provider_id: "a" }),
      txn({ league_slug: "bloodline-bowl", season: 2026, provider_id: "b" }),
      txn({ league_slug: "bloodline-bowl", season: 2026, provider_id: "c" }),
    ];
    const window2 = [
      txn({ league_slug: "bloodline-bowl", season: 2026, provider_id: "b" }),
      txn({ league_slug: "bloodline-bowl", season: 2026, provider_id: "c" }),
      txn({ league_slug: "bloodline-bowl", season: 2026, provider_id: "d" }),
    ];
    await store.append(window1);
    const second = await store.append(window2);
    assert.equal(second.inserted, 1); // only "d" is new
    assert.equal(second.duplicates, 2);
    assert.equal(await store.count("bloodline-bowl", 2026), 4);
  });

  it("Devoted transactions never appear in a Bloodline query", async () => {
    const store = new MemoryLedgerStore();
    await store.append([
      txn({ league_slug: "bloodline-bowl", season: 2026, provider_id: "bb1" }),
      txn({ league_slug: "devoted-to-the-game", season: 2026, provider_id: "dv1" }),
      txn({ league_slug: "devoted-to-the-game", season: 2026, provider_id: "dv2" }),
    ]);
    const bb = await store.query({ league_slug: "bloodline-bowl", season: 2026 });
    assert.equal(bb.length, 1);
    assert.equal(bb[0]!.provider_transaction_id, "bb1");
    const dv = await store.query({ league_slug: "devoted-to-the-game", season: 2026 });
    assert.equal(dv.length, 2);
  });

  it("filters by week and type", async () => {
    const store = new MemoryLedgerStore();
    await store.append([
      txn({ league_slug: "bloodline-bowl", season: 2026, provider_id: "w1", fantasy_week: 1, type: "trade" }),
      txn({ league_slug: "bloodline-bowl", season: 2026, provider_id: "w2", fantasy_week: 2, type: "waiver_add" }),
    ]);
    assert.equal((await store.query({ league_slug: "bloodline-bowl", season: 2026, week: 2 })).length, 1);
    assert.equal((await store.query({ league_slug: "bloodline-bowl", season: 2026, type: "trade" })).length, 1);
  });
});

/* --------------------------------------------------------- not configured */

describe("unconfigured persistence is explicit", () => {
  it("getPersistence() with no SUPABASE_* env reports PERSISTENCE_NOT_CONFIGURED and refuses to fake a write", async () => {
    setPersistence(null);
    const p = getPersistence({} as NodeJS.ProcessEnv);
    assert.equal(await p.status(), "PERSISTENCE_NOT_CONFIGURED");
    const put = await p.snapshots.put(
      snapshot({ league_slug: "bloodline-bowl", season: 2026, week: 1 }),
      { capture_type: "AD_HOC" },
    );
    assert.equal(put.outcome, "error");
    assert.equal(put.status, "PERSISTENCE_NOT_CONFIGURED");
    const append = await p.ledger.append([txn({ league_slug: "bloodline-bowl", season: 2026, provider_id: "z" })]);
    assert.equal(append.inserted, 0);
    assert.equal(append.status, "PERSISTENCE_NOT_CONFIGURED");
    setPersistence(null);
  });

  it("memoryPersistence() is a full working bundle for tests", async () => {
    const p = memoryPersistence();
    assert.equal(await p.status(), "READY");
    const runId = await p.runs.start({ league_slug: "bloodline-bowl", run_type: "SNAPSHOT", trigger: "TEST" });
    assert.ok(runId);
    await p.runs.finish(runId, { status: "OK" });
  });
});
