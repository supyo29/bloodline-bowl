/**
 * W1.R2 / P1-A — final-pregame clock semantics.
 *
 *   request starts -> provider fetch begins -> fetch completes (source_observed_at) -> forecast composed (composed_at) -> capture considered
 *
 * so `source_observed_at <= composed_at` holds by construction, and pregame truth is EVIDENCE availability: an observation made at/after kickoff
 * is never pregame evidence, whenever the request started. Deterministic cases drive a controllable clock that ADVANCES during the fetch (the
 * R1 mistake was only invisible because tests injected a single frozen instant); one case runs the production-shaped wall-clock path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWeeklyTeamContext } from "../lib/weekly/context";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import { setPersistence, memoryPersistence } from "../lib/persistence";
import { CanonicalProjectionSnapshotProvider } from "../lib/weekly/projections/canonical-provider";
import { decideCandidate, MemoryFinalPregameStore, type FinalPregameRecord, type FinalPregameStore } from "../lib/weekly/freshness/final-pregame";
import type { ProjectionProvider } from "../lib/weekly/projections/types";
import type { WeeklyTeamContext } from "../lib/weekly/schema";
import { goldenProjectionProvider, goldenProvider, goldenSchedule } from "./fixtures/canonical-forecast-golden";
import { runOnce } from "../scripts/w1r2-repros/p1-a-live-fetch-final-pregame";

const MIN = 60_000;
const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** a clock that moves forward while the provider "fetches" — the network round trip takes `latencyMs` of real (fake) time */
function rig(o: { startMs: number; latencyMs: number; cacheObservedMs?: number; store?: FinalPregameStore }) {
  const clock = { now: o.startMs };
  let fetchStarted: number | null = null;
  const inner = goldenProjectionProvider();
  const live: ProjectionProvider = {
    name: inner.name, model_version: inner.model_version,
    async getWeeklyProjections(req) {
      fetchStarted = clock.now;
      const b = await inner.getWeeklyProjections(req);
      clock.now += o.latencyMs; // the response ARRIVES latencyMs later
      const observed = o.cacheObservedMs ?? clock.now; // stamped on arrival (live) or the original fetch time (process cache)
      return { ...b, status: "READY", source_observation: { provider: "sleeper", observed_at: iso(observed), observation_id: "srcobs:aaaaaaaaaaaaaaaaaaaa", content_hash: "h", fetch_path: o.cacheObservedMs ? "PROCESS_CACHE" : "LIVE_FETCH" } as never };
    },
  };
  const kickoffSource = { name: "fixture", async getWeekGames() { return ["KC", "MIA", "SF", "BUF", "OPP", "LV", "NYJ", "DAL"].map((t, i) => ({ game_id: `g${i}`, home_team: t, away_team: `X${i}`, kickoff_at: iso(KICK), status: "pre_game" })); } };
  const noStore = { kind: "none", durable: false, async readLatest() { return null; }, async record() { return { status: "NOT_CONFIGURED", artifact_id: null, observed_at: null, durable: false }; } } as never;
  const store = (o.store ?? new MemoryFinalPregameStore()) as MemoryFinalPregameStore;
  const run = async (): Promise<WeeklyTeamContext> => {
    setPersistence(memoryPersistence());
    const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", {
      week: 5, providerOverride: goldenProvider(), scheduleProviderOverride: goldenSchedule, riSeasonProviderOverride: null, crosswalkOverride: new PlayerCrosswalk(NoCrosswalk), skipReturnGameEnrichment: true,
      projectionProviderOverride: new CanonicalProjectionSnapshotProvider(live, noStore, { kickoffSource, now: () => clock.now }),
      projectionSnapshotPolicy: "refresh", finalPregameStoreOverride: store,
    } as never);
    if (!r.context) throw new Error(`context failed: ${r.code}`);
    return r.context;
  };
  return { clock, store, run, fetchStarted: () => fetchStarted };
}
const someForecast = (ctx: WeeklyTeamContext) => [...ctx.forecasts!.by_player.values()].find((f) => f.game_status.kickoff_at != null)!;

describe("W1.R2 P1-A: composition is stamped AFTER the evidence it used", () => {
  it("live fetch completing before kickoff: observed <= composed, revisions RECORDED (was: 0 recorded, all REJECTED_INCONSISTENT_TIMES)", async () => {
    const r = rig({ startMs: KICK - 30 * MIN, latencyMs: 400 });
    const ctx = await r.run();
    const f = someForecast(ctx);
    assert.ok(Date.parse(f.freshness.source_observed_at!) > r.fetchStarted()!, "the observation is stamped on ARRIVAL, after the fetch began");
    assert.ok(Date.parse(f.freshness.source_observed_at!) <= Date.parse(f.freshness.forecast_composed_at!), "observed <= composed");
    assert.equal(ctx.final_pregame_capture?.status, "CAPTURED");
    assert.ok((ctx.final_pregame_capture?.counts?.RECORDED ?? 0) > 0);
    assert.equal(ctx.final_pregame_capture?.counts?.REJECTED_INCONSISTENT_TIMES, undefined);
    assert.equal(r.store.revisionCount(), ctx.final_pregame_capture!.counts!.RECORDED);
  });

  it("slow provider (4-minute fetch), still before kickoff: clock ordering holds, revisions recorded", async () => {
    const r = rig({ startMs: KICK - 30 * MIN, latencyMs: 4 * MIN });
    const ctx = await r.run();
    const f = someForecast(ctx);
    assert.equal(Date.parse(f.freshness.forecast_composed_at!) - r.fetchStarted()!, 4 * MIN, "composition is after the 4-minute fetch, not at its start");
    assert.ok(r.store.revisionCount() > 0);
  });

  it("process-cache hit before kickoff: the older observation is valid pregame evidence", async () => {
    const r = rig({ startMs: KICK - 30 * MIN, latencyMs: 0, cacheObservedMs: KICK - 50 * MIN });
    const ctx = await r.run();
    assert.equal(someForecast(ctx).freshness.source_observed_at, iso(KICK - 50 * MIN));
    assert.ok(r.store.revisionCount() > 0);
  });

  it("fetch BEGINS before kickoff and COMPLETES after it: not pregame evidence (request start never overrides evidence time)", async () => {
    const r = rig({ startMs: KICK - 10_000, latencyMs: 20_000 });
    const ctx = await r.run();
    assert.ok(r.fetchStarted()! < KICK);
    assert.ok(Date.parse(someForecast(ctx).freshness.source_observed_at!) >= KICK);
    assert.equal(r.store.revisionCount(), 0);
    assert.equal(ctx.final_pregame_capture?.status, "NOTHING_TO_CAPTURE");
  });

  it("request begins after kickoff: rejected", async () => {
    const r = rig({ startMs: KICK + 5 * MIN, latencyMs: 300, cacheObservedMs: KICK - 20 * MIN });
    await r.run();
    assert.equal(r.store.revisionCount(), 0);
  });

  it("a post-kickoff request cannot mutate a frozen pre-kickoff revision", async () => {
    const store = new MemoryFinalPregameStore();
    const pre = rig({ startMs: KICK - 20 * MIN, latencyMs: 300, store });
    await pre.run();
    const before = store.revisionCount();
    const frozen = await store.get("bloodline-bowl", 2026, 5, someForecast(await pre.run()).canonical_player_id);
    assert.ok(before > 0 && frozen);
    const post = rig({ startMs: KICK + 3 * MIN, latencyMs: 300, store });
    await post.run();
    assert.equal(store.revisionCount(), before);
    assert.equal((await store.get("bloodline-bowl", 2026, 5, frozen.canonical_player_id))?.forecast_id, frozen.forecast_id);
  });

  it("the store rule: an observation exactly AT kickoff is not pregame; observation after composition is still inconsistent", () => {
    const rec = (o: number, c: number) => ({ kickoff_at: iso(KICK), source_observed_at: iso(o), composed_at: iso(c), confirmed_through: iso(o) }) as FinalPregameRecord;
    assert.equal(decideCandidate(null, rec(KICK - MIN, KICK - 30_000)), "RECORDED");
    assert.equal(decideCandidate(null, rec(KICK, KICK - 1)), "REJECTED_POST_KICKOFF");
    assert.equal(decideCandidate(null, rec(KICK - MIN, KICK - 2 * MIN)), "REJECTED_INCONSISTENT_TIMES");
  });

  it("production-shaped path (wall clock, live provider stamping arrival time): a fresh network fetch is RECORDED", async () => {
    const out = await runOnce("network", "refresh");
    assert.equal(out.observed_le_composed, true);
    assert.ok((out.write_counts.RECORDED ?? 0) > 0);
    assert.equal(out.write_counts.REJECTED_INCONSISTENT_TIMES, undefined);
  });
});

describe("W1.R2: a final-pregame capture failure is visible, and never fails the analysis", () => {
  it("store throws: the context is still built, capture status FAILED with the error, and a warning is emitted", async () => {
    const broken = { kind: "broken", async upsertMany() { throw new Error("Supabase POST bridge_final_pregame_revisions -> 503"); } } as unknown as FinalPregameStore;
    const r = rig({ startMs: KICK - 30 * MIN, latencyMs: 300, store: broken });
    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (m: string) => logged.push(String(m));
    try {
      const ctx = await r.run();
      assert.ok(ctx.forecasts!.by_player.size > 0, "the analysis is intact");
      assert.equal(ctx.final_pregame_capture?.status, "FAILED");
      assert.match(ctx.final_pregame_capture!.error!, /503/);
      assert.ok(ctx.warnings.some((w) => w.code === "final_pregame_capture_failed"));
      assert.ok(logged.some((l) => /final_pregame_capture_failed/.test(l)));
      assert.ok(!logged.some((l) => /Bearer|apikey|service_role/i.test(l)), "no credentials in the log line");
    } finally {
      console.warn = warn;
    }
  });

  it("a store that persists nothing (Supabase not configured) is reported as STORE_NOT_CONFIGURED, never CAPTURED (re-audit A-2)", async () => {
    const noop = { kind: "none", async upsertMany() { return {}; } } as unknown as FinalPregameStore;
    const ctx = await rig({ startMs: KICK - 30 * MIN, latencyMs: 300, store: noop }).run();
    assert.equal(ctx.final_pregame_capture?.status, "STORE_NOT_CONFIGURED");
  });

  it("rejections are reported with counts (never silently swallowed)", async () => {
    const store = new MemoryFinalPregameStore();
    const r = rig({ startMs: KICK - 10 * MIN, latencyMs: 300, store });
    await r.run();
    // a second request that read an OLDER cached observation: every candidate is rejected as older evidence — and the context says so
    const older = rig({ startMs: KICK - 5 * MIN, latencyMs: 0, cacheObservedMs: KICK - 40 * MIN, store });
    const ctx = await older.run();
    assert.ok((ctx.final_pregame_capture?.counts?.REJECTED_OLDER_OBSERVATION ?? 0) > 0);
    assert.ok(ctx.warnings.some((w) => w.code === "final_pregame_capture_rejected"));
  });
});
