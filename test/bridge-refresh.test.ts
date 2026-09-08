/**
 * Stage E — publication orchestrator: publish, idempotency, certification gate,
 * concurrency, failure injection, audit trail.
 *
 * No model / scoring / trade / waiver / Team-State code is imported.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publishLeagueSnapshot } from "../lib/canonical/publish";
import { memoryPersistence } from "../lib/persistence/memory";
import type { CanonicalStateResult } from "../lib/canonical/state";
import { makeCanonicalSnapshot, TEST_LEAGUE, TEST_SEASON } from "./helpers/canonical-snapshot";

const ok = (snap: ReturnType<typeof makeCanonicalSnapshot>): (() => Promise<CanonicalStateResult>) =>
  async () => ({ ok: true, status: 200, snapshot: snap });

const providerDown: () => Promise<CanonicalStateResult> = async () => ({
  ok: false,
  status: 503,
  detail: "sleeper unreachable",
  snapshot: null,
});

describe("publishLeagueSnapshot: happy path", () => {
  it("first publish advances the pointer, http 200, audit CERTIFIED/created", async () => {
    const p = memoryPersistence();
    const r = await publishLeagueSnapshot(TEST_LEAGUE, {
      trigger: "API",
      buildOverride: ok(makeCanonicalSnapshot({})),
      persistence: p,
    });
    assert.equal(r.ok, true);
    assert.equal(r.http_status, 200);
    assert.equal(r.outcome, "published");
    assert.equal(r.pointer_advanced, true);
    assert.equal(r.resulting_pointer_seq, 1);
    assert.equal(r.integrity, "CERTIFIED");
    assert.equal(r.snapshot_persisted, "created");

    const audit = await p.publication_audit.latest(TEST_LEAGUE, TEST_SEASON);
    assert.ok(audit);
    assert.equal(audit!.ok, true);
    assert.equal(audit!.pointer_advanced, true);
    assert.equal(audit!.prior_pointer_seq, null);
    assert.equal(audit!.resulting_pointer_seq, 1);
    assert.equal(audit!.trigger, "API");
    assert.equal(audit!.error, null);
  });
});

describe("publishLeagueSnapshot: idempotency", () => {
  it("republishing identical content -> unchanged, pointer does not move, http 200", async () => {
    const p = memoryPersistence();
    const snap = makeCanonicalSnapshot({});
    const first = await publishLeagueSnapshot(TEST_LEAGUE, { trigger: "API", buildOverride: ok(snap), persistence: p });
    const second = await publishLeagueSnapshot(TEST_LEAGUE, { trigger: "CRON", buildOverride: ok(snap), persistence: p });

    assert.equal(first.outcome, "published");
    assert.equal(second.outcome, "unchanged");
    assert.equal(second.pointer_advanced, false);
    assert.equal(second.http_status, 200);
    assert.equal((await p.published.get(TEST_LEAGUE, TEST_SEASON))!.published_seq, 1);
    assert.equal((await p.publication_audit.recent(TEST_LEAGUE, TEST_SEASON)).length, 2);
  });

  it("retry after a transient failure is safe (same content -> unchanged)", async () => {
    const p = memoryPersistence();
    const snap = makeCanonicalSnapshot({});
    await publishLeagueSnapshot(TEST_LEAGUE, { trigger: "API", buildOverride: providerDown, persistence: p }); // fails
    const a = await publishLeagueSnapshot(TEST_LEAGUE, { trigger: "API", buildOverride: ok(snap), persistence: p });
    const b = await publishLeagueSnapshot(TEST_LEAGUE, { trigger: "API", buildOverride: ok(snap), persistence: p });
    assert.equal(a.outcome, "published");
    assert.equal(b.outcome, "unchanged");
    assert.equal((await p.published.get(TEST_LEAGUE, TEST_SEASON))!.published_seq, 1);
  });
});

describe("publishLeagueSnapshot: certification gate", () => {
  it("a self-contradictory candidate is rejected -> http 422, pointer untouched", async () => {
    const p = memoryPersistence();
    await publishLeagueSnapshot(TEST_LEAGUE, { trigger: "API", buildOverride: ok(makeCanonicalSnapshot({})), persistence: p });
    const before = await p.published.get(TEST_LEAGUE, TEST_SEASON);

    const bad = makeCanonicalSnapshot({ standingsWinsOverride: { "1": 9 } });
    const r = await publishLeagueSnapshot(TEST_LEAGUE, { trigger: "API", buildOverride: ok(bad), persistence: p });

    assert.equal(r.ok, false);
    assert.equal(r.http_status, 422);
    assert.equal(r.outcome, "rejected");
    assert.equal(r.integrity, "REJECTED");
    assert.equal(r.snapshot_persisted, "skipped");
    assert.deepEqual(await p.published.get(TEST_LEAGUE, TEST_SEASON), before);

    const audit = await p.publication_audit.latest(TEST_LEAGUE, TEST_SEASON);
    assert.equal(audit!.integrity, "REJECTED");
    assert.equal(audit!.pointer_advanced, false);
    assert.ok(audit!.validation_detail && audit!.validation_detail.length > 0);
  });

  it("no prior pointer + failed candidate -> http 422, still no pointer", async () => {
    const p = memoryPersistence();
    const r = await publishLeagueSnapshot(TEST_LEAGUE, {
      trigger: "API",
      buildOverride: ok(makeCanonicalSnapshot({ warnings: [{ code: "player_database_unavailable", message: "down" }], live_provider_status: "PARTIAL" })),
      persistence: p,
    });
    assert.equal(r.http_status, 422);
    assert.equal(await p.published.get(TEST_LEAGUE, TEST_SEASON), null);
  });
});

describe("publishLeagueSnapshot: provider failure preserves last-known-good", () => {
  it("prior pointer intact, integrity unchanged, http 503, not 200", async () => {
    const p = memoryPersistence();
    const good = makeCanonicalSnapshot({});
    await publishLeagueSnapshot(TEST_LEAGUE, { trigger: "API", buildOverride: ok(good), persistence: p });
    const lkg = await p.published.get(TEST_LEAGUE, TEST_SEASON);

    const r = await publishLeagueSnapshot(TEST_LEAGUE, { trigger: "API", buildOverride: providerDown, persistence: p });

    assert.equal(r.ok, false);
    assert.equal(r.http_status, 503);
    assert.equal(r.outcome, "source_unavailable");
    assert.equal(r.error_category, "PROVIDER_UNAVAILABLE");
    assert.deepEqual(await p.published.get(TEST_LEAGUE, TEST_SEASON), lkg);
  });

  it("no prior + provider down -> http 503, no pointer, no fake success", async () => {
    const p = memoryPersistence();
    const r = await publishLeagueSnapshot(TEST_LEAGUE, { trigger: "API", buildOverride: providerDown, persistence: p });
    assert.equal(r.ok, false);
    assert.equal(r.http_status, 503);
    assert.equal(await p.published.get(TEST_LEAGUE, TEST_SEASON), null);
  });
});

describe("publishLeagueSnapshot: unknown league", () => {
  it("unresolvable slug -> 404, nothing written (no audit, no pointer)", async () => {
    const p = memoryPersistence();
    const r = await publishLeagueSnapshot("no-such-league-xyz", { trigger: "API", persistence: p });
    assert.equal(r.http_status, 404);
    assert.equal(r.ok, false);
    assert.equal(await p.publication_audit.latest("no-such-league-xyz", 0), null);
  });
});

describe("publishLeagueSnapshot: concurrency", () => {
  it("two concurrent publishes with different content -> one advances, one races; pointer monotonic", async () => {
    const p = memoryPersistence();
    const a = makeCanonicalSnapshot({ teams: [
      { roster_id: "1", wins: 2, losses: 1 },
      { roster_id: "2", wins: 1, losses: 2 },
    ] });
    const b = makeCanonicalSnapshot({ teams: [
      { roster_id: "1", wins: 3, losses: 1 },
      { roster_id: "2", wins: 1, losses: 3 },
    ] });

    const [r1, r2] = await Promise.all([
      publishLeagueSnapshot(TEST_LEAGUE, { trigger: "API", buildOverride: ok(a), persistence: p }),
      publishLeagueSnapshot(TEST_LEAGUE, { trigger: "API", buildOverride: ok(b), persistence: p }),
    ]);

    const outcomes = [r1.outcome, r2.outcome].sort();
    assert.deepEqual(outcomes, ["published", "raced"]);
    const finalSeq = (await p.published.get(TEST_LEAGUE, TEST_SEASON))!.published_seq;
    assert.equal(finalSeq, 1); // exactly one advance, never regressed
    // both immutable snapshots were persisted
    assert.equal((await p.publication_audit.recent(TEST_LEAGUE, TEST_SEASON)).length, 2);
  });
});
