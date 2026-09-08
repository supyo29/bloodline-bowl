/**
 * Stage F — the shared published-snapshot reader (`readLeagueState`).
 *
 * flag off → legacy; flag on + valid fresh pointer → published; flag on +
 * anything wrong → legacy with an observable fallback_reason. Lineage IDs are
 * never conflated. Read/publish concurrency serves whole snapshots only.
 *
 * No model / scoring / trade / waiver / Team-State code is imported.
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import { readLeagueState } from "../lib/canonical/read";
import { publishLeagueSnapshot } from "../lib/canonical/publish";
import { memoryPersistence } from "../lib/persistence/memory";
import { snapshotContentHash } from "../lib/persistence/serialize";
import { makeCanonicalSnapshot, stubProvider, TEST_LEAGUE, TEST_SEASON } from "./helpers/canonical-snapshot";
import type { CanonicalStateResult } from "../lib/canonical/state";

/** hermetic legacy/fallback branch — never touches the network */
const legacyStub = { providerOverride: stubProvider(makeCanonicalSnapshot({})) };

const FLAG = "BRIDGE_PUBLISHED_SNAPSHOT";
afterEach(() => {
  delete process.env[FLAG];
});

const ok = (snap: ReturnType<typeof makeCanonicalSnapshot>): (() => Promise<CanonicalStateResult>) =>
  async () => ({ ok: true, status: 200, snapshot: snap });

/** Publish a snapshot into `p` and return it. */
async function seedPointer(p = memoryPersistence(), snap = makeCanonicalSnapshot({})) {
  const r = await publishLeagueSnapshot(TEST_LEAGUE, {
    trigger: "TEST",
    buildOverride: ok(snap),
    persistence: p,
  });
  assert.equal(r.outcome, "published");
  return { p, snap };
}

describe("readLeagueState: flag OFF", () => {
  it("delegates to the legacy live path; provenance FLAG_OFF, no fallback_reason", async () => {
    const { p } = await seedPointer();
    const r = await readLeagueState(TEST_LEAGUE, { persistence: p, wave: 1, ...legacyStub });
    assert.equal(r.provenance.state_source, "LEGACY_LIVE_PATH");
    assert.equal(r.provenance.served_from_pointer, false);
    assert.equal(r.provenance.fallback_reason, null);
  });
});

describe("readLeagueState: flag ON, pointer serves", () => {
  it("serves the exact certified published snapshot; state_source PUBLISHED_SNAPSHOT", async () => {
    process.env[FLAG] = "1";
    const { p, snap } = await seedPointer();
    const r = await readLeagueState(TEST_LEAGUE, { persistence: p, wave: 1, ...legacyStub });

    assert.equal(r.ok, true);
    assert.equal(r.provenance.state_source, "PUBLISHED_SNAPSHOT");
    assert.equal(r.provenance.served_from_pointer, true);
    assert.equal(r.provenance.fallback_reason, null);
    assert.ok(["FRESH", "ACCEPTABLE"].includes(r.provenance.serving_freshness!));
    // byte-identical to the published snapshot
    assert.equal(snapshotContentHash(r.snapshot!), snapshotContentHash(snap));
  });

  it("wave gating: wave3 flag does not serve a wave-1 read as published unless covered", async () => {
    process.env[FLAG] = "wave1";
    const { p } = await seedPointer();
    const w1 = await readLeagueState(TEST_LEAGUE, { persistence: p, wave: 1, ...legacyStub });
    const w2 = await readLeagueState(TEST_LEAGUE, { persistence: p, wave: 2, ...legacyStub });
    assert.equal(w1.provenance.state_source, "PUBLISHED_SNAPSHOT");
    assert.equal(w2.provenance.state_source, "LEGACY_LIVE_PATH");
    assert.equal(w2.provenance.fallback_reason, null); // FLAG_OFF for this wave
  });
});

describe("readLeagueState: flag ON, fallback reasons", () => {
  it("NO_POINTER — flag on but nothing published", async () => {
    process.env[FLAG] = "1";
    const p = memoryPersistence();
    const r = await readLeagueState(TEST_LEAGUE, { persistence: p, wave: 1, ...legacyStub });
    assert.equal(r.provenance.state_source, "LEGACY_LIVE_PATH");
    assert.equal(r.provenance.fallback_reason, "NO_POINTER");
    assert.equal(r.provenance.pointer_present, false);
  });

  it("TARGET_MISSING — pointer names a snapshot the store cannot return", async () => {
    process.env[FLAG] = "1";
    const { p } = await seedPointer();
    // corrupt the pointer to name a non-existent snapshot row
    const ptr = await p.published.get(TEST_LEAGUE, TEST_SEASON);
    await p.published.advance(
      { ...ptr!, snapshot_id: "does-not-exist", content_hash: "x", schema_version: 3 },
      ptr!.published_seq,
    );
    const r = await readLeagueState(TEST_LEAGUE, { persistence: p, wave: 1, ...legacyStub });
    assert.equal(r.provenance.state_source, "LEGACY_LIVE_PATH");
    assert.equal(r.provenance.fallback_reason, "TARGET_MISSING");
    assert.equal(r.provenance.pointer_present, true);
  });

  it("ID_MISMATCH — pointer content_hash disagrees with the stored snapshot", async () => {
    process.env[FLAG] = "1";
    const { p } = await seedPointer();
    const ptr = await p.published.get(TEST_LEAGUE, TEST_SEASON);
    await p.published.advance({ ...ptr!, content_hash: "tampered-hash" }, ptr!.published_seq);
    const r = await readLeagueState(TEST_LEAGUE, { persistence: p, wave: 1, ...legacyStub });
    assert.equal(r.provenance.fallback_reason, "ID_MISMATCH");
  });

  it("TOO_STALE — published snapshot is older than the serving policy", async () => {
    process.env[FLAG] = "1";
    const old = makeCanonicalSnapshot({
      provider_synced_at: new Date(Date.now() - 3600_000).toISOString(), // 1h old
    });
    const { p } = await seedPointer(memoryPersistence(), old);
    const r = await readLeagueState(TEST_LEAGUE, { persistence: p, wave: 1, ...legacyStub });
    assert.equal(r.provenance.state_source, "LEGACY_LIVE_PATH");
    assert.equal(r.provenance.fallback_reason, "TOO_STALE");
    assert.equal(r.provenance.serving_freshness, "STALE");
    assert.equal(r.provenance.pointer_present, true); // pointer stays visible
  });

  it("PERSISTENCE_UNAVAILABLE — pointer store down", async () => {
    process.env[FLAG] = "1";
    const p = memoryPersistence();
    p.published.status = async () => "PERSISTENCE_ERROR";
    const r = await readLeagueState(TEST_LEAGUE, { persistence: p, wave: 1, ...legacyStub });
    assert.equal(r.provenance.fallback_reason, "PERSISTENCE_UNAVAILABLE");
  });

  it("UNSUPPORTED_SCHEMA — stored snapshot is a future schema version", async () => {
    process.env[FLAG] = "1";
    const { p } = await seedPointer();
    const ptr = await p.published.get(TEST_LEAGUE, TEST_SEASON);
    const stored = await p.snapshots.getById(ptr!.snapshot_id);
    (stored!.payload as { schema_version: number }).schema_version = 99;
    const r = await readLeagueState(TEST_LEAGUE, { persistence: p, wave: 1, ...legacyStub });
    assert.equal(r.provenance.fallback_reason, "UNSUPPORTED_SCHEMA");
  });

  it("MALFORMED — stored snapshot has no teams", async () => {
    process.env[FLAG] = "1";
    const { p } = await seedPointer();
    const ptr = await p.published.get(TEST_LEAGUE, TEST_SEASON);
    const stored = await p.snapshots.getById(ptr!.snapshot_id);
    (stored!.payload as { teams: unknown[] }).teams = [];
    const r = await readLeagueState(TEST_LEAGUE, { persistence: p, wave: 1, ...legacyStub });
    assert.equal(r.provenance.fallback_reason, "MALFORMED");
  });
});

describe("readLeagueState: lineage IDs are never conflated", () => {
  it("on fallback, pointer_snapshot_id stays the pointer target, not the live id", async () => {
    process.env[FLAG] = "1";
    const { p } = await seedPointer();
    const ptr = await p.published.get(TEST_LEAGUE, TEST_SEASON);
    await p.published.advance({ ...ptr!, content_hash: "tampered" }, ptr!.published_seq);

    const r = await readLeagueState(TEST_LEAGUE, { persistence: p, wave: 1, ...legacyStub });
    assert.equal(r.provenance.fallback_reason, "ID_MISMATCH");
    assert.equal(r.provenance.pointer_snapshot_id, ptr!.league_snapshot_id); // pointer target preserved
    assert.equal(r.provenance.served_from_pointer, false);
  });
});

describe("readLeagueState: read / publish concurrency", () => {
  it("a read concurrent with an advance sees a whole old OR whole new snapshot, never a mix", async () => {
    process.env[FLAG] = "1";
    const a = makeCanonicalSnapshot({ teams: [
      { roster_id: "1", wins: 1, losses: 0 },
      { roster_id: "2", wins: 0, losses: 1 },
    ] });
    const b = makeCanonicalSnapshot({ teams: [
      { roster_id: "1", wins: 2, losses: 0 },
      { roster_id: "2", wins: 0, losses: 2 },
    ] });
    const { p } = await seedPointer(memoryPersistence(), a);
    const hashA = snapshotContentHash(a);
    const hashB = snapshotContentHash(b);

    const [read, pub] = await Promise.all([
      readLeagueState(TEST_LEAGUE, { persistence: p, wave: 1, ...legacyStub }),
      publishLeagueSnapshot(TEST_LEAGUE, { trigger: "TEST", buildOverride: ok(b), persistence: p }),
    ]);

    assert.equal(pub.outcome, "published");
    if (read.provenance.state_source === "PUBLISHED_SNAPSHOT") {
      const h = snapshotContentHash(read.snapshot!);
      assert.ok(h === hashA || h === hashB, "read must be a whole snapshot, never a blend");
      // the read's snapshot content hash matches whichever pointer it resolved
      assert.ok([hashA, hashB].includes(h));
    }
    // final pointer is B, seq 2
    const finalPtr = await p.published.get(TEST_LEAGUE, TEST_SEASON);
    assert.equal(finalPtr!.published_seq, 2);
    assert.equal(finalPtr!.content_hash, hashB);
  });
});
