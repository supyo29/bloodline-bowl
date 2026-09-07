/**
 * Published-snapshot infrastructure (Stage B) — deterministic, no network.
 *
 * Proves the guarantees the phase exists for:
 *   - candidate build -> certify -> publish advances the durable pointer
 *   - a candidate that FAILS the reconcile gate never becomes authoritative;
 *     the previous published snapshot stays current, response is DEGRADED
 *   - republishing identical content is idempotent (no new pointer generation)
 *   - concurrent advance from the same observed sequence: one wins, one races
 *   - a provider read failure preserves the last known good snapshot
 *   - the reuse window serves the pointer without rebuilding
 *   - no model file is touched (this suite imports zero engine code)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getPublishedLeagueSnapshot } from "../lib/canonical/published";
import { MemoryPublishedPointerStore, memoryPersistence } from "../lib/persistence/memory";
import type { CanonicalStateResult } from "../lib/canonical/state";
import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalLeagueSnapshot,
} from "../lib/canonical/schema";

const LEAGUE = "bloodline-bowl";
const SEASON = 2026;

interface TeamSpec {
  roster_id: string;
  wins: number;
  losses: number;
  points_for?: number;
}

function makeSnapshot(opts: {
  week?: number;
  teams?: TeamSpec[];
  standingsWinsOverride?: Record<string, number>;
  live_provider_status?: CanonicalLeagueSnapshot["live_provider_status"];
  warnings?: CanonicalLeagueSnapshot["warnings"];
}): CanonicalLeagueSnapshot {
  const week = opts.week ?? 3;
  const teamSpecs = opts.teams ?? [
    { roster_id: "1", wins: 2, losses: 1, points_for: 300 },
    { roster_id: "2", wins: 1, losses: 2, points_for: 250 },
  ];

  const teams = teamSpecs.map((t) => ({
    canonical_team_id: `team:${LEAGUE}:${t.roster_id}`,
    canonical_league_id: `league:${LEAGUE}`,
    provider_team_id: t.roster_id,
    team_name: `Team ${t.roster_id}`,
    canonical_manager_ids: [`manager:${LEAGUE}:u${t.roster_id}`],
    provider_owner_id: `u${t.roster_id}`,
    record: {
      wins: t.wins,
      losses: t.losses,
      ties: 0,
      points_for: t.points_for ?? 0,
      points_against: 0,
    },
    faab_remaining: 100,
    waiver_priority: Number(t.roster_id),
    provenance: { provider: "sleeper" as const, provider_id: "x", provider_synced_at: null },
  }));

  const managers = teamSpecs.map((t) => ({
    canonical_manager_id: `manager:${LEAGUE}:u${t.roster_id}`,
    canonical_league_id: `league:${LEAGUE}`,
    manager_slug: `u${t.roster_id}`,
    display_name: `Manager ${t.roster_id}`,
    provider_user_id: `u${t.roster_id}`,
    provider_username: `u${t.roster_id}`,
    is_commissioner: false,
    is_co_manager: false,
    provenance: { provider: "sleeper" as const, provider_id: "x", provider_synced_at: null },
  }));

  const standings = teamSpecs
    .map((t) => ({
      canonical_team_id: `team:${LEAGUE}:${t.roster_id}`,
      rank: null as number | null,
      wins: opts.standingsWinsOverride?.[t.roster_id] ?? t.wins,
      losses: t.losses,
      ties: 0,
      win_percentage: null,
      points_for: t.points_for ?? 0,
      points_against: 0,
      games_played: t.wins + t.losses,
      playoff_seed: null,
    }))
    .sort((a, b) => b.wins - a.wins)
    .map((s, i) => ({ ...s, rank: i + 1 }));

  return {
    schema_version: CANONICAL_SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    provider_synced_at: new Date().toISOString(),
    league: {
      canonical_league_id: `league:${LEAGUE}`,
      league_slug: LEAGUE,
      name: "Bloodline Bowl",
      season: SEASON,
      status: "in_season",
      sport: "nfl",
      team_count: teamSpecs.length,
      current_week: week,
      scoring_rules: [],
      raw_scoring: { rec: 1, pass_td: 4 },
      roster_settings: {
        starting_slots: ["QB", "RB", "WR", "TE", "FLEX", "K", "DEF"],
        bench_slots: 6,
        ir_slots: 1,
        taxi_slots: 0,
        slot_requirements: {},
      },
      playoff_settings: { playoff_team_count: null, playoff_start_week: null, championship_week: null },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: "x", provider_synced_at: null },
    },
    season: SEASON,
    week,
    managers,
    teams,
    rosters: [],
    standings,
    matchups: [],
    recent_transactions: [],
    draft_picks: [],
    waiver_state: null,
    players: [],
    unresolved_players: [],
    live_provider_status: opts.live_provider_status ?? "READY",
    history_persistence_status: "READY",
    warnings: opts.warnings ?? [],
  };
}

const build = (snap: CanonicalLeagueSnapshot): (() => Promise<CanonicalStateResult>) =>
  async () => ({ ok: true, status: 200, snapshot: snap });

describe("getPublishedLeagueSnapshot: publish + certify gate", () => {
  it("first call builds, certifies, and advances the durable pointer", async () => {
    const p = memoryPersistence();
    const r = await getPublishedLeagueSnapshot(LEAGUE, {
      persistence: p,
      forced: true,
      buildOverride: build(makeSnapshot({})),
    });

    assert.equal(r.ok, true);
    assert.equal(r.outcome, "published");
    assert.equal(r.freshness.status, "FRESH");
    assert.equal(r.freshness.certified, true);
    assert.equal(r.reconcile?.ok, true);

    const pointer = await p.published.get(LEAGUE, SEASON);
    assert.ok(pointer);
    assert.equal(pointer!.published_seq, 1);
    assert.equal(pointer!.certified, true);
    assert.equal(pointer!.league_snapshot_id, r.freshness.snapshot_id);
  });

  it("a self-contradictory candidate is REJECTED; prior snapshot stays authoritative", async () => {
    const p = memoryPersistence();
    const good = makeSnapshot({ week: 3 });
    await getPublishedLeagueSnapshot(LEAGUE, { persistence: p, forced: true, buildOverride: build(good) });
    const before = await p.published.get(LEAGUE, SEASON);

    // standings say roster 1 has 5 wins; team record says 2 -> certify() flags it.
    const bad = makeSnapshot({ week: 3, standingsWinsOverride: { "1": 5 } });
    const r = await getPublishedLeagueSnapshot(LEAGUE, {
      persistence: p,
      forced: true,
      buildOverride: build(bad),
    });

    assert.equal(r.ok, true); // authoritative state still exists
    assert.equal(r.outcome, "rejected");
    assert.equal(r.freshness.status, "DEGRADED");
    assert.equal(r.freshness.degraded_reason, "RECONCILIATION_DISCREPANCY");
    assert.ok((r.reconcile?.discrepancies.length ?? 0) > 0);

    const after = await p.published.get(LEAGUE, SEASON);
    assert.deepEqual(after, before); // pointer did NOT move
    assert.equal(r.snapshot?.week, good.week); // served the prior good snapshot
  });

  it("a non-benign provider warning keeps the candidate out", async () => {
    const p = memoryPersistence();
    const r = await getPublishedLeagueSnapshot(LEAGUE, {
      persistence: p,
      forced: true,
      buildOverride: build(
        makeSnapshot({
          live_provider_status: "PARTIAL",
          warnings: [{ code: "player_database_unavailable", message: "down" }],
        }),
      ),
    });
    assert.equal(r.outcome, "uncertified");
    assert.equal(await p.published.get(LEAGUE, SEASON), null);
  });

  it("benign unresolved-player warnings DO publish", async () => {
    const p = memoryPersistence();
    const r = await getPublishedLeagueSnapshot(LEAGUE, {
      persistence: p,
      forced: true,
      buildOverride: build(
        makeSnapshot({
          live_provider_status: "PARTIAL",
          warnings: [{ code: "unresolved_player_identities", message: "3 ids" }],
        }),
      ),
    });
    assert.equal(r.outcome, "published");
    assert.ok(await p.published.get(LEAGUE, SEASON));
  });
});

describe("getPublishedLeagueSnapshot: idempotency + reuse", () => {
  it("republishing identical content does not create a new generation", async () => {
    const p = memoryPersistence();
    const snap = makeSnapshot({});
    const first = await getPublishedLeagueSnapshot(LEAGUE, { persistence: p, forced: true, buildOverride: build(snap) });
    const second = await getPublishedLeagueSnapshot(LEAGUE, { persistence: p, forced: true, buildOverride: build(snap) });

    assert.equal(first.outcome, "published");
    assert.equal(second.outcome, "unchanged");
    const pointer = await p.published.get(LEAGUE, SEASON);
    assert.equal(pointer!.published_seq, 1); // never bumped past 1
  });

  it("within the reuse window the pointer is served without rebuilding", async () => {
    const p = memoryPersistence();
    const snap = makeSnapshot({});
    const publishedAt = Date.parse(snap.provider_synced_at!);
    await getPublishedLeagueSnapshot(LEAGUE, {
      persistence: p,
      forced: true,
      buildOverride: build(snap),
      now: publishedAt,
    });

    let rebuilt = false;
    const r = await getPublishedLeagueSnapshot(LEAGUE, {
      persistence: p,
      now: publishedAt + 30_000, // 30s later, NORMAL rebuild_after = 120s
      buildOverride: async () => {
        rebuilt = true;
        return { ok: true, status: 200, snapshot: snap };
      },
    });
    assert.equal(rebuilt, false);
    assert.equal(r.outcome, "reused");
    assert.equal(r.freshness.status, "FRESH");
  });

  it("past the reuse window a fresh candidate is built and published", async () => {
    const p = memoryPersistence();
    const snapA = makeSnapshot({ teams: [
      { roster_id: "1", wins: 2, losses: 1 },
      { roster_id: "2", wins: 1, losses: 2 },
    ] });
    const t0 = Date.parse(snapA.provider_synced_at!);
    await getPublishedLeagueSnapshot(LEAGUE, { persistence: p, forced: true, buildOverride: build(snapA), now: t0 });

    const snapB = makeSnapshot({ teams: [
      { roster_id: "1", wins: 3, losses: 1 },
      { roster_id: "2", wins: 1, losses: 3 },
    ] });
    const r = await getPublishedLeagueSnapshot(LEAGUE, {
      persistence: p,
      now: t0 + 200_000, // 200s later > 120s
      buildOverride: build(snapB),
    });
    assert.equal(r.outcome, "published");
    const pointer = await p.published.get(LEAGUE, SEASON);
    assert.equal(pointer!.published_seq, 2);
  });
});

describe("getPublishedLeagueSnapshot: failure safety", () => {
  it("a provider read failure preserves the last known good snapshot", async () => {
    const p = memoryPersistence();
    const good = makeSnapshot({});
    await getPublishedLeagueSnapshot(LEAGUE, { persistence: p, forced: true, buildOverride: build(good) });
    const before = await p.published.get(LEAGUE, SEASON);

    const r = await getPublishedLeagueSnapshot(LEAGUE, {
      persistence: p,
      forced: true,
      buildOverride: async () => ({ ok: false, status: 503, detail: "sleeper down", snapshot: null }),
    });

    assert.equal(r.ok, true);
    assert.equal(r.outcome, "source_unavailable");
    assert.equal(r.freshness.status, "SOURCE_UNAVAILABLE");
    assert.equal(r.freshness.source_status, "SOURCE_UNAVAILABLE");
    assert.equal(r.snapshot?.week, good.week);
    assert.deepEqual(await p.published.get(LEAGUE, SEASON), before);
  });

  it("no prior + provider failure -> 503, not empty state pretending to be current", async () => {
    const p = memoryPersistence();
    const r = await getPublishedLeagueSnapshot(LEAGUE, {
      persistence: p,
      forced: true,
      buildOverride: async () => ({ ok: false, status: 503, snapshot: null }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    assert.equal(r.freshness.status, "SOURCE_UNAVAILABLE");
  });
});

describe("MemoryPublishedPointerStore: atomic monotonic advance", () => {
  it("two writers from seq 0: one advances, the other races (no overwrite)", async () => {
    const store = new MemoryPublishedPointerStore();
    const mk = (hash: string) => ({
      league_slug: LEAGUE,
      season: SEASON,
      snapshot_id: `row-${hash}`,
      league_snapshot_id: `snap:${hash}`,
      content_hash: hash,
      week: 3,
      source_provider_synced_at: null,
      schema_version: CANONICAL_SCHEMA_VERSION,
    });

    const [a, b] = await Promise.all([
      store.advance(mk("AAA"), 0),
      store.advance(mk("BBB"), 0),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ["advanced", "raced"]);
    const winner = await store.get(LEAGUE, SEASON);
    assert.equal(winner!.published_seq, 1);
    assert.ok(["AAA", "BBB"].includes(winner!.content_hash));
  });

  it("advancing with a stale expected_seq is rejected as raced", async () => {
    const store = new MemoryPublishedPointerStore();
    const base = {
      league_slug: LEAGUE,
      season: SEASON,
      week: 3,
      source_provider_synced_at: null,
      schema_version: CANONICAL_SCHEMA_VERSION,
    };
    await store.advance({ ...base, snapshot_id: "r1", league_snapshot_id: "s1", content_hash: "H1" }, 0);
    const stale = await store.advance(
      { ...base, snapshot_id: "r3", league_snapshot_id: "s3", content_hash: "H3" },
      0, // stale: real seq is now 1
    );
    assert.equal(stale.outcome, "raced");
    assert.equal((await store.get(LEAGUE, SEASON))!.content_hash, "H1");
  });

  it("re-advancing to the current content hash is unchanged", async () => {
    const store = new MemoryPublishedPointerStore();
    const row = {
      league_slug: LEAGUE,
      season: SEASON,
      snapshot_id: "r1",
      league_snapshot_id: "s1",
      content_hash: "H1",
      week: 3,
      source_provider_synced_at: null,
      schema_version: CANONICAL_SCHEMA_VERSION,
    };
    await store.advance(row, 0);
    const again = await store.advance(row, 1);
    assert.equal(again.outcome, "unchanged");
    assert.equal((await store.get(LEAGUE, SEASON))!.published_seq, 1);
  });
});
