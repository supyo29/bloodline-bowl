import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NoCrosswalk, PlayerCrosswalk } from "@/lib/canonical/players";
import { scoringFingerprint } from "@/lib/canonical/scoring-fingerprint";
import {
  buildProjectionSnapshotArtifact,
  hydrateProjectionSnapshotBatch,
  projectionSnapshotRequestFingerprint,
  projectionSnapshotScope,
  type ProjectionSnapshotHit,
  type ProjectionSnapshotStore,
  type ProjectionSnapshotWriteResult,
} from "@/lib/weekly/projections/canonical-snapshot";
import { CanonicalProjectionSnapshotProvider } from "@/lib/weekly/projections/canonical-provider";
import { SupabaseProjectionSnapshotStore } from "@/lib/persistence/supabase/projection-snapshot";
import type { SupabaseRest } from "@/lib/persistence/supabase/rest";
import type { ProjectionProvider, ProjectionRequest } from "@/lib/weekly/projections/types";
import type { WeeklyProjectionBatch } from "@/lib/weekly/schema";
import { player, proj } from "./fixtures/weekly";

function request(policy: ProjectionRequest["projection_snapshot_policy"] = "prefer"): ProjectionRequest {
  return {
    league: {
      league_slug: "test-league",
      season: 2026,
      raw_scoring: { rec: 1, rec_yd: 0.1, rec_td: 6 },
      scoring_rules: [],
    },
    week: 3,
    crosswalk: new PlayerCrosswalk(NoCrosswalk),
    canonical_player_ids: ["p1"],
    want_rest_of_season: true,
    projection_snapshot_policy: policy,
  };
}

function batch(points = 10): WeeklyProjectionBatch {
  const p = player("p1", "WR", { name: "Snapshot WR" });
  const wp = proj("p1", "WR", points, { rest_of_season_points: 120 });
  return {
    league_slug: "test-league",
    season: 2026,
    week: 3,
    status: "READY",
    by_player: new Map([["p1", wp]]),
    resolved_players: new Map([["p1", p]]),
    source: "fake_live",
    model_version: "fake-v1",
    missing: [],
    teams_with_games: ["AAA"],
    warnings: [],
  };
}

class FakeLiveProvider implements ProjectionProvider {
  readonly name = "fake_live";
  readonly model_version = "fake-v1";
  calls = 0;
  constructor(private points = 10) {}
  async getWeeklyProjections(): Promise<WeeklyProjectionBatch> {
    this.calls += 1;
    return batch(this.points + this.calls - 1);
  }
}

class MemorySnapshotStore implements ProjectionSnapshotStore {
  readonly kind = "memory";
  readonly durable = true;
  hit: ProjectionSnapshotHit | null = null;
  reads = 0;
  writes = 0;

  async readLatest(req: ProjectionRequest): Promise<ProjectionSnapshotHit | null> {
    this.reads += 1;
    if (!this.hit) return null;
    return {
      ...this.hit,
      batch: hydrateProjectionSnapshotBatch(
        this.hit.artifact,
        req.canonical_player_ids,
        {
          observed_at: this.hit.observed_at,
          age_ms: this.hit.age_ms,
          durable: true,
        },
      ),
    };
  }

  async record(
    req: ProjectionRequest,
    b: WeeklyProjectionBatch,
    observedAt = "2026-09-26T23:00:00.000Z",
  ): Promise<ProjectionSnapshotWriteResult> {
    this.writes += 1;
    const artifact = buildProjectionSnapshotArtifact(req, b);
    this.hit = {
      artifact,
      observed_at: observedAt,
      age_ms: 0,
      batch: hydrateProjectionSnapshotBatch(artifact, req.canonical_player_ids, {
        observed_at: observedAt,
        age_ms: 0,
        durable: true,
      }),
    };
    return {
      status: this.writes === 1 ? "INSERTED" : "DUPLICATE_IDENTICAL",
      artifact_id: artifact.artifact_id,
      observed_at: observedAt,
      durable: true,
    };
  }
}

describe("Phase 5 canonical projection snapshot provider", () => {
  it("a cache miss falls back live, persists, and the next read avoids the live source", async () => {
    const live = new FakeLiveProvider();
    const store = new MemorySnapshotStore();
    const provider = new CanonicalProjectionSnapshotProvider(live, store);

    const first = await provider.getWeeklyProjections(request());
    assert.equal(live.calls, 1);
    assert.equal(store.writes, 1);
    assert.equal(first.canonical_snapshot?.read_path, "LIVE_FALLBACK");
    assert.equal(first.canonical_snapshot?.durable, true);
    assert.equal(first.by_player.get("p1")?.projected_points, 10);

    const second = await provider.getWeeklyProjections(request());
    assert.equal(live.calls, 1, "fresh durable snapshot should eliminate the second live read");
    assert.equal(store.writes, 1);
    assert.equal(second.canonical_snapshot?.read_path, "SUPABASE_HIT");
    assert.equal(second.by_player.get("p1")?.projected_points, 10);
  });

  it("refresh forces live and advances persistence even when a snapshot exists", async () => {
    const live = new FakeLiveProvider();
    const store = new MemorySnapshotStore();
    const provider = new CanonicalProjectionSnapshotProvider(live, store);

    await provider.getWeeklyProjections(request());
    const refreshed = await provider.getWeeklyProjections(request("refresh"));

    assert.equal(live.calls, 2);
    assert.equal(store.writes, 2);
    assert.equal(refreshed.canonical_snapshot?.read_path, "LIVE_REFRESH");
    assert.equal(refreshed.by_player.get("p1")?.projected_points, 11);
  });

  it("bypass neither reads nor writes the snapshot store", async () => {
    const live = new FakeLiveProvider();
    const store = new MemorySnapshotStore();
    const provider = new CanonicalProjectionSnapshotProvider(live, store);

    const result = await provider.getWeeklyProjections(request("bypass"));
    assert.equal(live.calls, 1);
    assert.equal(store.reads, 0);
    assert.equal(store.writes, 0);
    assert.equal(result.canonical_snapshot?.read_path, "LIVE_BYPASS");
    assert.equal(result.canonical_snapshot?.durable, false);
  });

  it("artifact identity is deterministic and scoring-scoped", () => {
    const a = buildProjectionSnapshotArtifact(request(), batch());
    const b = buildProjectionSnapshotArtifact(request(), batch());
    assert.equal(a.artifact_id, b.artifact_id);
    assert.equal(a.content_hash, b.content_hash);
    assert.equal(a.scoring_fingerprint, scoringFingerprint(request().league.raw_scoring));
    assert.equal(a.request_fingerprint, projectionSnapshotRequestFingerprint(request()));

    const changed = request();
    changed.league = { ...changed.league, raw_scoring: { ...changed.league.raw_scoring, rec: 0.5 } };
    const c = buildProjectionSnapshotArtifact(changed, batch());
    assert.notEqual(a.artifact_id, c.artifact_id);
    assert.notEqual(a.scoring_fingerprint, c.scoring_fingerprint);
  });
});


describe("Phase 5 Supabase projection snapshot pagination", () => {
  it("hydrates an artifact larger than the PostgREST 1,000-row page cap", async () => {
    const req = request();
    const rows = Array.from({ length: 2305 }, (_, i) => {
      const id = `bulk-${String(i).padStart(4, "0")}`;
      return [id, proj(id, "WR", 8 + (i % 5), { rest_of_season_points: 100 + (i % 20) })] as const;
    });
    const bulkBatch: WeeklyProjectionBatch = {
      ...batch(),
      by_player: new Map(rows),
      resolved_players: new Map(),
      missing: [],
    };
    const artifact = buildProjectionSnapshotArtifact(req, bulkBatch);
    const observedAt = new Date().toISOString();
    const offsets: number[] = [];
    let pointerReads = 0;

    const fakeRest = {
      select: async (table: string, opts: { limit?: number; offset?: number }) => {
        if (table === "bridge_projection_latest") {
          pointerReads += 1;
          return [{
            league_slug: artifact.league_slug,
            season: artifact.season,
            week: artifact.week,
            scoring_fingerprint: artifact.scoring_fingerprint,
            request_fingerprint: artifact.request_fingerprint,
            artifact_id: artifact.artifact_id,
            observed_at: observedAt,
          }];
        }
        if (table === "bridge_projection_snapshots") {
          return [{
            artifact_id: artifact.artifact_id,
            content_hash: artifact.content_hash,
            league_slug: artifact.league_slug,
            season: artifact.season,
            week: artifact.week,
            scoring_fingerprint: artifact.scoring_fingerprint,
            request_fingerprint: artifact.request_fingerprint,
            status: artifact.status,
            source: artifact.source,
            model_version: artifact.model_version,
            teams_with_games: artifact.teams_with_games,
            warnings: artifact.warnings,
            row_count: artifact.row_count,
            format: artifact.format,
          }];
        }
        if (table === "bridge_projection_snapshot_players") {
          const offset = opts.offset ?? 0;
          const limit = opts.limit ?? 1000;
          offsets.push(offset);
          return artifact.players.slice(offset, offset + limit).map((p) => ({
            artifact_id: artifact.artifact_id,
            canonical_player_id: p.canonical_player_id,
            projection: p.projection,
            resolved_player: p.resolved_player,
          }));
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as SupabaseRest;

    const store = new SupabaseProjectionSnapshotStore(fakeRest);
    const now = () => Date.parse(observedAt) + 1000;
    const [hit, concurrentHit] = await Promise.all([
      store.readLatest(req, { now }),
      store.readLatest(req, { now }),
    ]);

    assert.ok(hit);
    assert.ok(concurrentHit);
    assert.equal(hit!.artifact.row_count, 2305);
    assert.equal(hit!.batch.by_player.size, 2305);
    assert.equal(concurrentHit!.batch.by_player.size, 2305);
    assert.deepEqual(offsets, [0, 1000, 2000], "concurrent readers share one paged Supabase load");
    assert.equal(pointerReads, 1, "concurrent readers share one pointer read");
    assert.equal(hit!.batch.canonical_snapshot?.read_path, "SUPABASE_HIT");

    const warmHit = await store.readLatest(req, { now: () => Date.parse(observedAt) + 2000 });
    assert.ok(warmHit);
    assert.deepEqual(offsets, [0, 1000, 2000], "warm process-local read performs no extra page reads");
    assert.equal(pointerReads, 1, "warm process-local read performs no extra pointer read");
  });
});


describe("Phase 7 projection snapshot hardening", () => {
  it("request fingerprint separates ROS, return-game, and crosswalk variants", () => {
    const base = request();
    const noRos = request();
    noRos.want_rest_of_season = false;

    const returnA = request();
    returnA.return_game_recent_attempts = new Map([["s1", [1, 0, 0]]]);
    const returnB = request();
    returnB.return_game_recent_attempts = new Map([["s1", [2, 0, 0]]]);

    assert.notEqual(
      projectionSnapshotRequestFingerprint(base),
      projectionSnapshotRequestFingerprint(noRos),
      "ROS mode changes normalized projection output and must not share a pointer",
    );
    assert.notEqual(
      projectionSnapshotRequestFingerprint(returnA),
      projectionSnapshotRequestFingerprint(returnB),
      "return-game evidence changes normalized projection output and must not share a pointer",
    );
    assert.notEqual(
      projectionSnapshotScope(base).request_fingerprint,
      projectionSnapshotScope(noRos).request_fingerprint,
    );
  });

  it("hydration clones mutable player records so one caller cannot poison the cached artifact", () => {
    const req = request();
    const artifact = buildProjectionSnapshotArtifact(req, batch());
    const originalRos = structuredClone(artifact.players[0]!.projection.ros);
    const first = hydrateProjectionSnapshotBatch(artifact, ["p1"], {
      observed_at: "2026-09-28T10:00:00.000Z",
      age_ms: 0,
      durable: true,
    });
    const firstProjection = first.by_player.get("p1")!;
    firstProjection.rest_of_season_points = 999;
    firstProjection.ros = {
      points: 999,
      source: "sleeper_season_rotowire_prorated",
      external_season_points: 999,
      ri_season_points: null,
      ri_position_rank: null,
      ri_vor: null,
      ri_tier: null,
      ri_confidence: null,
      disagreement_pct: null,
      disagreement_direction: "ONE_SOURCE",
      confidence: "LOW",
      warnings: ["caller mutation"],
    };

    const second = hydrateProjectionSnapshotBatch(artifact, ["p1"], {
      observed_at: "2026-09-28T10:00:00.000Z",
      age_ms: 1,
      durable: true,
    });
    assert.equal(second.by_player.get("p1")?.rest_of_season_points, 120);
    assert.deepEqual(second.by_player.get("p1")?.ros, originalRos);
    assert.equal(artifact.players[0]?.projection.rest_of_season_points, 120);
    assert.deepEqual(artifact.players[0]?.projection.ros, originalRos);
  });

  it("a slower old read cannot overwrite a newer process-local cache entry", async () => {
    const req = request();
    const oldBatch = batch(10);
    const newBatch = batch(20);
    const oldArtifact = buildProjectionSnapshotArtifact(req, oldBatch);
    const newArtifact = buildProjectionSnapshotArtifact(req, newBatch);
    const oldObserved = "2026-09-28T10:00:00.000Z";
    const newObserved = "2026-09-28T10:01:00.000Z";

    let releaseOldPage!: () => void;
    const oldPageBlocked = new Promise<void>((resolve) => { releaseOldPage = resolve; });
    let oldPageStarted!: () => void;
    const oldPageStartedPromise = new Promise<void>((resolve) => { oldPageStarted = resolve; });

    const fakeRest = {
      select: async (table: string) => {
        if (table === "bridge_projection_latest") {
          return [{
            league_slug: oldArtifact.league_slug,
            season: oldArtifact.season,
            week: oldArtifact.week,
            scoring_fingerprint: oldArtifact.scoring_fingerprint,
            request_fingerprint: oldArtifact.request_fingerprint,
            artifact_id: oldArtifact.artifact_id,
            observed_at: oldObserved,
          }];
        }
        if (table === "bridge_projection_snapshots") {
          return [{
            artifact_id: oldArtifact.artifact_id,
            content_hash: oldArtifact.content_hash,
            league_slug: oldArtifact.league_slug,
            season: oldArtifact.season,
            week: oldArtifact.week,
            scoring_fingerprint: oldArtifact.scoring_fingerprint,
            request_fingerprint: oldArtifact.request_fingerprint,
            status: oldArtifact.status,
            source: oldArtifact.source,
            model_version: oldArtifact.model_version,
            teams_with_games: oldArtifact.teams_with_games,
            warnings: oldArtifact.warnings,
            row_count: oldArtifact.row_count,
            format: oldArtifact.format,
          }];
        }
        if (table === "bridge_projection_snapshot_players") {
          oldPageStarted();
          await oldPageBlocked;
          return oldArtifact.players.map((p) => ({
            artifact_id: oldArtifact.artifact_id,
            canonical_player_id: p.canonical_player_id,
            projection: p.projection,
            resolved_player: p.resolved_player,
          }));
        }
        throw new Error(`unexpected table ${table}`);
      },
      insertIgnoreDuplicates: async (table: string) => {
        if (table === "bridge_projection_snapshots") return [{ artifact_id: newArtifact.artifact_id }];
        return [];
      },
      updateReturning: async () => [{
        league_slug: newArtifact.league_slug,
        season: newArtifact.season,
        week: newArtifact.week,
        scoring_fingerprint: newArtifact.scoring_fingerprint,
        request_fingerprint: newArtifact.request_fingerprint,
        artifact_id: newArtifact.artifact_id,
        observed_at: newObserved,
      }],
    } as unknown as SupabaseRest;

    const store = new SupabaseProjectionSnapshotStore(fakeRest);
    const oldRead = store.readLatest(req, { now: () => Date.parse(oldObserved) + 1000 });
    await oldPageStartedPromise;

    const write = await store.record(req, newBatch, newObserved);
    assert.notEqual(write.status, "ERROR");
    releaseOldPage();

    const resolvedOldRead = await oldRead;
    assert.ok(resolvedOldRead);
    assert.equal(
      resolvedOldRead!.batch.by_player.get("p1")?.projected_points,
      20,
      "newer winning write remains authoritative even when an older read finishes later",
    );

    const warm = await store.readLatest(req, { now: () => Date.parse(newObserved) + 1000 });
    assert.equal(warm?.batch.by_player.get("p1")?.projected_points, 20);
  });
});
