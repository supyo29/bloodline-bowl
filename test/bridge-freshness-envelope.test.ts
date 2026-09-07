/**
 * Stage D — freshness/capability envelope.
 *
 * Boundary exactness, clock safety, missing-pointer honesty, certified-but-stale,
 * fresh-but-degraded-capability, source-outage LKG, legacy lineage honesty,
 * additive compatibility.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveFreshness, FRESHNESS_THRESHOLDS } from "../lib/canonical/freshness";
import { buildFreshnessEnvelope } from "../lib/canonical/freshness-envelope";
import { makeCanonicalSnapshot, testPlayer } from "./helpers/canonical-snapshot";
import type { PublishedPointer } from "../lib/persistence/types";

const T0 = Date.parse("2026-09-07T12:00:00.000Z");
const ago = (s: number) => new Date(T0 - s * 1000).toISOString();

function pointer(overrides: Partial<PublishedPointer> = {}): PublishedPointer {
  return {
    league_slug: "bloodline-bowl",
    season: 2026,
    snapshot_id: "row-1",
    league_snapshot_id: "snap:bloodline-bowl:2026:w3:abcdef0123456789",
    content_hash: "abcdef0123456789",
    week: 3,
    published_seq: 1,
    certified: true,
    source_provider_synced_at: ago(10),
    published_at: ago(10),
    updated_at: ago(10),
    schema_version: 3,
    ...overrides,
  };
}

describe("deriveFreshness: exact mode boundaries", () => {
  for (const [mode, th] of Object.entries(FRESHNESS_THRESHOLDS)) {
    it(`${mode}: ${th.fresh_seconds}/${th.fresh_seconds + 1}/${th.acceptable_seconds}/${th.acceptable_seconds + 1}`, () => {
      const f = (age: number) =>
        deriveFreshness({
          mode: mode as keyof typeof FRESHNESS_THRESHOLDS,
          source_synced_at: ago(age),
          now: T0,
        }).status;
      assert.equal(f(th.fresh_seconds), "FRESH");
      assert.equal(f(th.fresh_seconds + 1), "ACCEPTABLE");
      assert.equal(f(th.acceptable_seconds), "ACCEPTABLE");
      assert.equal(f(th.acceptable_seconds + 1), "STALE");
    });
  }
});

describe("deriveFreshness: clock safety", () => {
  it("a future source timestamp clamps age to 0, never negative", () => {
    const f = deriveFreshness({
      mode: "NORMAL",
      source_synced_at: new Date(T0 + 5000).toISOString(), // 5s in the future
      now: T0,
    });
    assert.equal(f.age_seconds, 0);
    assert.equal(f.status, "FRESH");
  });
});

describe("buildFreshnessEnvelope: missing pointer", () => {
  it("no pointer -> published freshness UNKNOWN (not STALE, not FRESH); pointer inspection present:false", () => {
    const env = buildFreshnessEnvelope({
      servedSnapshot: makeCanonicalSnapshot({ provider_synced_at: ago(3) }),
      stateSource: "LEGACY_LIVE_PATH",
      pointer: null,
      now: T0,
    });
    assert.equal(env.freshness.status, "UNKNOWN");
    assert.equal(env.freshness.degraded_reason, "NO_PUBLISHED_SNAPSHOT");
    assert.equal(env.published_snapshot.present, false);
    assert.equal(env.published_snapshot.snapshot_id, null);
    // the served payload still gets an honest lineage
    assert.equal(env.response_state_lineage?.snapshot_id != null, true);
  });
});

describe("buildFreshnessEnvelope: legacy lineage honesty", () => {
  it("state_source is LEGACY_LIVE_PATH and the served payload is NOT claimed to be the published snapshot", () => {
    const served = makeCanonicalSnapshot({ provider_synced_at: ago(2) });
    const env = buildFreshnessEnvelope({
      servedSnapshot: served,
      stateSource: "LEGACY_LIVE_PATH",
      pointer: pointer({ league_snapshot_id: "snap:DIFFERENT:2026:w3:0000000000000000" }),
      now: T0,
    });
    assert.equal(env.state_source, "LEGACY_LIVE_PATH");
    assert.notEqual(env.response_state_lineage!.snapshot_id, env.published_snapshot.snapshot_id);
  });

  it("conservative age = measured age + cache max staleness; served_freshness classified from it", () => {
    const env = buildFreshnessEnvelope({
      servedSnapshot: makeCanonicalSnapshot({ provider_synced_at: ago(1) }),
      stateSource: "LEGACY_LIVE_PATH",
      pointer: null,
      sourceMaxStalenessSeconds: 300,
      now: T0,
    });
    const l = env.response_state_lineage!;
    assert.equal(l.age_seconds, 1);
    assert.equal(l.conservative_age_seconds, 301);
    // 301s under NORMAL (fresh<=120, acceptable<=600) -> ACCEPTABLE, not FRESH
    assert.equal(l.served_freshness, "ACCEPTABLE");
  });
});

describe("buildFreshnessEnvelope: integrity vs freshness stay separate", () => {
  it("certified snapshot + stale published pointer -> integrity CERTIFIED, freshness STALE, source AVAILABLE", () => {
    const env = buildFreshnessEnvelope({
      servedSnapshot: makeCanonicalSnapshot({}),
      stateSource: "PUBLISHED_SNAPSHOT",
      pointer: pointer({ source_provider_synced_at: ago(5000), published_at: ago(5000) }),
      now: T0,
    });
    assert.equal(env.integrity.snapshot_integrity, "CERTIFIED");
    assert.equal(env.freshness.status, "STALE");
    assert.equal(env.freshness.source_status, "AVAILABLE");
  });

  it("fresh published pointer + degraded capability -> freshness FRESH, free_agent_pool UNAVAILABLE", () => {
    const env = buildFreshnessEnvelope({
      servedSnapshot: makeCanonicalSnapshot({}), // waiver_state null -> pool unavailable
      stateSource: "PUBLISHED_SNAPSHOT",
      pointer: pointer({ source_provider_synced_at: ago(5), published_at: ago(5) }),
      now: T0,
    });
    assert.equal(env.freshness.status, "FRESH");
    assert.equal(env.capabilities.free_agent_pool.status, "UNAVAILABLE");
    assert.equal(env.integrity.snapshot_integrity, "CERTIFIED");
  });
});

describe("buildFreshnessEnvelope: source outage with last-known-good", () => {
  it("source unavailable + pointer present -> freshness SOURCE_UNAVAILABLE, pointer still inspectable, no 'corrupt' signal", () => {
    const env = buildFreshnessEnvelope({
      servedSnapshot: makeCanonicalSnapshot({}),
      stateSource: "PUBLISHED_SNAPSHOT",
      pointer: pointer({ source_provider_synced_at: ago(400) }),
      sourceUnavailable: true,
      now: T0,
    });
    assert.equal(env.freshness.status, "SOURCE_UNAVAILABLE");
    assert.equal(env.freshness.source_status, "SOURCE_UNAVAILABLE");
    assert.equal(env.published_snapshot.present, true);
    assert.equal(env.published_snapshot.certified, true);
    assert.equal(env.integrity.snapshot_integrity, "CERTIFIED"); // LKG is not corrupt
  });
});

describe("buildFreshnessEnvelope: material unresolved identity surfaces", () => {
  it("an unresolved id on a roster -> integrity REJECTED, material_unresolved populated", () => {
    const env = buildFreshnessEnvelope({
      servedSnapshot: makeCanonicalSnapshot({
        players: [testPlayer("99999", { unresolved: true })],
        rosterPlayerIdsByTeam: { "1": ["player:sleeper:99999"] },
      }),
      stateSource: "LEGACY_LIVE_PATH",
      pointer: null,
      now: T0,
    });
    assert.equal(env.integrity.snapshot_integrity, "REJECTED");
    assert.equal(env.material_unresolved.length, 1);
  });
});

describe("additive compatibility", () => {
  it("envelope is a self-contained object with no dependency on removing existing fields", () => {
    const env = buildFreshnessEnvelope({
      servedSnapshot: makeCanonicalSnapshot({}),
      stateSource: "LEGACY_LIVE_PATH",
      pointer: null,
      now: T0,
    });
    // shape assertions a consumer can rely on
    for (const k of ["state_source", "response_state_lineage", "published_snapshot", "freshness", "integrity", "capabilities"]) {
      assert.ok(k in env, `missing ${k}`);
    }
  });
});
