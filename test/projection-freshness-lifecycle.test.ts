/**
 * W1.P4 end-to-end freshness lifecycle through the REAL provider wrapper + REAL Supabase snapshot store on a deterministic fake REST.
 * Includes the audit regression: a newly written snapshot must not make old SOURCE data fresh again (the ~120-minute effective window).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NoCrosswalk, PlayerCrosswalk } from "@/lib/canonical/players";
import { runInLeagueStateScope } from "@/lib/canonical/request-scope";
import { SupabaseProjectionSnapshotStore } from "@/lib/persistence/supabase/projection-snapshot";
import { CanonicalProjectionSnapshotProvider } from "@/lib/weekly/projections/canonical-provider";
import { InvalidationLedger, makeEvent } from "@/lib/weekly/freshness/events";
import type { KickoffSource } from "@/lib/weekly/freshness/kickoff";
import type { ProjectionProvider, ProjectionRequest } from "@/lib/weekly/projections/types";
import type { WeeklyProjectionBatch } from "@/lib/weekly/schema";
import { player, proj } from "./fixtures/weekly";
import { FakeRest } from "./fixtures/fake-rest";

const MIN = 60_000;
const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function request(over: Partial<ProjectionRequest["league"]> = {}, policy: ProjectionRequest["projection_snapshot_policy"] = "prefer"): ProjectionRequest {
  return {
    league: { league_slug: "test-league", season: 2026, raw_scoring: { rec: 1, rec_yd: 0.1, rec_td: 6 }, scoring_rules: [], ...over },
    week: 5,
    crosswalk: new PlayerCrosswalk(NoCrosswalk),
    canonical_player_ids: ["p1"],
    want_rest_of_season: true,
    projection_snapshot_policy: policy,
  };
}

/** Live provider that simulates the sleeper 30-minute client cache: it serves a payload whose SOURCE observation is `sourceAge` old. */
class CachedSourceProvider implements ProjectionProvider {
  readonly name = "fake_live";
  readonly model_version = "v1";
  calls = 0;
  lastMaxSourceAge: number | undefined;
  fail = false;
  constructor(private readonly clock: { now: number }, public sourceObservedAt: number, public points = 10) {}
  async getWeeklyProjections(req: ProjectionRequest): Promise<WeeklyProjectionBatch> {
    this.calls += 1;
    this.lastMaxSourceAge = req.max_source_age_ms;
    if (this.fail) {
      return { league_slug: req.league.league_slug, season: 2026, week: 5, status: "PROJECTIONS_UNAVAILABLE", by_player: new Map(), resolved_players: new Map(), source: "fake_live", model_version: "v1", missing: [], teams_with_games: [], warnings: [{ code: "x", message: "sleeper 503", severity: "error" }] };
    }
    // honour the requested max source age like the real provider: a too-old cached payload forces a live fetch
    if (req.max_source_age_ms != null && this.clock.now - this.sourceObservedAt > req.max_source_age_ms) this.sourceObservedAt = this.clock.now;
    return {
      league_slug: req.league.league_slug,
      season: 2026,
      week: 5,
      status: "READY",
      by_player: new Map([["p1", proj("p1", "WR", this.points, { rest_of_season_points: 120 })]]),
      resolved_players: new Map([["p1", player("p1", "WR")]]),
      source: "fake_live",
      model_version: "v1",
      missing: [],
      teams_with_games: ["KC"],
      warnings: [],
      source_observation: { provider: "sleeper", observed_at: iso(this.sourceObservedAt), observation_id: null, content_hash: null, fetch_path: "PROCESS_CACHE" },
    };
  }
}

const kickoffAt = (k: number): KickoffSource => ({ name: "fixture", getWeekGames: async () => [{ game_id: "g1", home_team: "KC", away_team: "BUF", kickoff_at: iso(k), status: "pre_game" }] });

function rig(sourceAgeMin: number, nowMs: number, kickoff = KICK) {
  const clock = { now: nowMs };
  const rest = new FakeRest();
  const store = new SupabaseProjectionSnapshotStore(rest.asRest());
  const live = new CachedSourceProvider(clock, nowMs - sourceAgeMin * MIN);
  const ledger = new InvalidationLedger();
  const provider = new CanonicalProjectionSnapshotProvider(live, store, { now: () => clock.now, kickoffSource: kickoffAt(kickoff), ledger });
  return { clock, rest, store, live, ledger, provider };
}

describe("W1.P4 audit regression: effective source staleness (~120 min) is gone", () => {
  it("a snapshot written NOW from a 10-minute-old cached source is still 10 minutes old at the source", async () => {
    const t0 = KICK - 5 * 60 * MIN; // GAME_DAY_NEAR: 5h out
    const { provider, live } = rig(10, t0);
    const b = await provider.getWeeklyProjections(request());
    assert.equal(live.calls, 1);
    assert.equal(b.canonical_snapshot?.observed_at != null, true);
    assert.equal(b.canonical_snapshot?.source_observed_at, iso(t0 - 10 * MIN), "source time is the FETCH instant, not the snapshot write time");
    assert.equal(b.canonical_snapshot?.age_ms, 10 * MIN, "age is SOURCE age: a snapshot written now does not read as age 0");
  });

  it("OLD behaviour (snapshot age 80 < 90 min) is rejected: the same data 90 minutes old at the source is not served from the snapshot", async () => {
    const t0 = KICK - 5 * 60 * MIN;
    const r = rig(10, t0);
    await r.provider.getWeeklyProjections(request()); // writes a snapshot whose source is 10 min old
    // 80 minutes later: snapshot pointer is 80 min old (inside the legacy 90 min window) but the source is 90 min old
    r.clock.now = t0 + 80 * MIN;
    r.live.sourceObservedAt = t0 - 10 * MIN; // upstream cache has NOT been refreshed (still the old payload)
    const callsBefore = r.live.calls;
    const b = await r.provider.getWeeklyProjections(request());
    assert.equal(r.live.calls, callsBefore + 1, "stale source forces a live read instead of serving the snapshot");
    assert.ok(r.live.lastMaxSourceAge != null && r.live.lastMaxSourceAge <= 15 * MIN, `live was told the max source age (got ${r.live.lastMaxSourceAge})`);
    assert.equal(b.canonical_snapshot?.source_observed_at, iso(t0 + 80 * MIN), "the refreshed observation is genuinely new");
  });

  it("the store itself never lets pointer-write time rejuvenate old source data", async () => {
    const t0 = KICK - 5 * 60 * MIN;
    const { store, live, clock } = rig(0, t0);
    const old = await live.getWeeklyProjections(request());
    clock.now = t0 + 100 * MIN; // written 100 minutes after the source was observed
    await store.record(request(), old, iso(clock.now));
    const miss = await store.readLatest(request(), { maxAgeMs: 30 * MIN, now: () => clock.now });
    assert.equal(miss, null, "pointer observed_at is fresh but the SOURCE is 100 min old: not servable");
    const stale = await store.readLatest(request(), { allowStale: true, now: () => clock.now });
    assert.equal(stale?.source_observed_at, iso(t0));
    assert.equal(stale?.age_ms, 100 * MIN);
    assert.equal(stale?.observed_at, iso(t0 + 100 * MIN), "snapshot time and source time stay distinct fields");
  });

  it("a re-wrapped OLDER payload can never move the pointer's source instant backwards", async () => {
    const t0 = KICK - 5 * 60 * MIN;
    const { store, live } = rig(0, t0);
    const fresh = await live.getWeeklyProjections(request());
    await store.record(request(), fresh, iso(t0));
    const older = { ...fresh, source_observation: { ...fresh.source_observation!, observed_at: iso(t0 - 60 * MIN) } };
    live.points = 99;
    await store.record(request(), older, iso(t0 + 5 * MIN));
    const hit = await store.readLatest(request(), { allowStale: true, now: () => t0 + 6 * MIN });
    assert.equal(hit?.source_observed_at, iso(t0));
  });
});

describe("W1.P4 dynamic window by kickoff (replaces the universal 90 minutes)", () => {
  it("early week: a 4-hour-old source is served from the snapshot (no live call)", async () => {
    const t0 = KICK - 100 * 60 * MIN;
    const r = rig(0, t0);
    await r.provider.getWeeklyProjections(request());
    r.clock.now = t0 + 4 * 60 * MIN;
    const b = await r.provider.getWeeklyProjections(request());
    assert.equal(r.live.calls, 1);
    assert.equal(b.canonical_snapshot?.read_path, "SUPABASE_HIT");
  });

  it("20 minutes before kickoff: a 20-minute-old source is NOT served (15 min tier), a live read is made", async () => {
    const t0 = KICK - 60 * MIN;
    const r = rig(0, t0);
    await r.provider.getWeeklyProjections(request());
    r.clock.now = KICK - 20 * MIN;
    r.live.sourceObservedAt = t0; // upstream cache still old
    await r.provider.getWeeklyProjections(request());
    assert.equal(r.live.calls, 2);
  });

  it("unknown kickoff is conservative (30 min), never treated as far away", async () => {
    const t0 = KICK - 100 * 60 * MIN;
    const clock = { now: t0 };
    const rest = new FakeRest();
    const live = new CachedSourceProvider(clock, t0);
    const provider = new CanonicalProjectionSnapshotProvider(live, new SupabaseProjectionSnapshotStore(rest.asRest()), { now: () => clock.now, kickoffSource: { name: "down", getWeekGames: async () => null } });
    await provider.getWeeklyProjections(request());
    clock.now = t0 + 45 * MIN;
    live.sourceObservedAt = t0;
    await provider.getWeeklyProjections(request());
    assert.equal(live.calls, 2);
  });
});

describe("W1.P4 events and refresh failure", () => {
  it("a newer PLAYER event supersedes a fresh snapshot and forces a refresh", async () => {
    const t0 = KICK - 100 * 60 * MIN;
    const r = rig(0, t0);
    await r.provider.getWeeklyProjections(request());
    r.clock.now = t0 + 10 * MIN;
    r.ledger.add([makeEvent({ type: "INJURY_STATUS_CHANGE", scope: { kind: "PLAYER", provider: "sleeper", provider_player_id: "1" }, effective_at: null, known_at: iso(t0 + 5 * MIN), source: "sleeper", authority: "PROVIDER_STATUS", detail: {} })]);
    await r.provider.getWeeklyProjections(request());
    assert.equal(r.live.calls, 2);
  });

  it("refresh failure keeps the last known projection, marked STALE with the failure — never zero/healthy/unavailable", async () => {
    const t0 = KICK - 5 * 60 * MIN;
    const r = rig(0, t0);
    await r.provider.getWeeklyProjections(request());
    r.clock.now = t0 + 3 * 60 * MIN; // snapshot is beyond the 30-minute tier
    r.live.fail = true;
    const b = await r.provider.getWeeklyProjections(request());
    assert.equal(b.status, "READY");
    assert.equal(b.by_player.get("p1")?.projected_points, 10, "last-known value retained, not zeroed");
    assert.equal(b.canonical_snapshot?.read_path, "SUPABASE_STALE_FALLBACK");
    assert.equal(b.freshness_context?.refresh?.succeeded, false);
    assert.ok(b.warnings.some((w) => w.code === "projection_refresh_failed_using_last_known"));
    assert.equal(b.canonical_snapshot?.source_observed_at, iso(t0), "the old observation time is preserved");
  });

  it("with no last-known snapshot a failed refresh is an honest UNAVAILABLE batch (null, not 0)", async () => {
    const r = rig(0, KICK - 5 * 60 * MIN);
    r.live.fail = true;
    const b = await r.provider.getWeeklyProjections(request());
    assert.equal(b.status, "PROJECTIONS_UNAVAILABLE");
    assert.equal(b.by_player.size, 0);
    assert.equal(b.freshness_context?.refresh?.succeeded, false);
  });

  it("a last-known snapshot older than the 48h fallback limit is not served as current-week state", async () => {
    const t0 = KICK - 100 * 60 * MIN;
    const r = rig(0, t0);
    await r.provider.getWeeklyProjections(request());
    r.clock.now = t0 + 49 * 60 * MIN;
    r.live.fail = true;
    const b = await r.provider.getWeeklyProjections(request());
    assert.equal(b.status, "PROJECTIONS_UNAVAILABLE");
  });
});

describe("W1.P4 request-scoped consistency", () => {
  it("within one request scope a league/week batch resolves ONCE; each caller gets an isolated clone", async () => {
    const t0 = KICK - 100 * 60 * MIN;
    const r = rig(0, t0);
    await runInLeagueStateScope(async () => {
      const a = await r.provider.getWeeklyProjections(request());
      a.by_player.get("p1")!.projected_points = 999; // a consumer mutates in place
      const b = await r.provider.getWeeklyProjections(request());
      assert.equal(r.live.calls, 1);
      assert.equal(b.by_player.get("p1")?.projected_points, 10, "mutation did not leak across sections");
      assert.equal(b.canonical_snapshot?.read_path, "REQUEST_MEMO");
      assert.equal(a.canonical_snapshot?.source_observed_at, b.canonical_snapshot?.source_observed_at, "one evidence set");
    });
  });

  it("different scoring in the same scope is a DIFFERENT batch (no cross-scoring memo reuse)", async () => {
    const t0 = KICK - 100 * 60 * MIN;
    const r = rig(0, t0);
    await runInLeagueStateScope(async () => {
      await r.provider.getWeeklyProjections(request());
      await r.provider.getWeeklyProjections(request({ raw_scoring: { rec: 0, rec_yd: 0.1, rec_td: 6 } }));
      assert.equal(r.live.calls, 2);
    });
  });
});
