/**
 * Stage C — Layer A: deterministic same-source equivalence.
 *
 * The OLD path (a canonical snapshot consumed directly) and the NEW path
 * (`getPublishedLeagueSnapshot` dry-run) fed from the SAME frozen source must be
 * semantically identical. Any difference on a stable source is UNEXPLAINED and
 * fails the gate.
 *
 * (Legacy-analytics-vs-canonical equivalence from a frozen Sleeper fixture is
 * already covered by `certification.test.ts` / `certification-live.test.ts`;
 * this file guards the publish wrapper specifically.)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getPublishedLeagueSnapshot } from "../lib/canonical/published";
import { compareCanonicalPaths } from "../lib/canonical/shadow";
import { snapshotContentHash } from "../lib/persistence/serialize";
import { memoryPersistence } from "../lib/persistence/memory";
import { makeCanonicalSnapshot, testPlayer } from "./helpers/canonical-snapshot";

describe("shadow Layer A: publish wrapper is semantically transparent", () => {
  it("old canonical == new published (dry-run), stable source -> EQUIVALENT, 0 diffs", async () => {
    const frozen = makeCanonicalSnapshot({
      players: [testPlayer("4046", { position: "QB" }), testPlayer("6794", { position: "WR" })],
      rosterPlayerIdsByTeam: { "1": ["player:sleeper:4046"], "2": ["player:sleeper:6794"] },
    });
    const hash = snapshotContentHash(frozen);

    const newPath = await getPublishedLeagueSnapshot("bloodline-bowl", {
      persistence: memoryPersistence(),
      forced: true,
      dryRun: true,
      buildOverride: async () => ({ ok: true, status: 200, snapshot: frozen }),
    });

    assert.equal(newPath.outcome, "dry_run");
    assert.equal(newPath.dry_run, true);
    assert.ok(newPath.snapshot);

    const cmp = compareCanonicalPaths(frozen, newPath.snapshot!, {
      mode: "DETERMINISTIC_SAME_SOURCE",
      sourceStartHash: hash,
      sourceEndHash: hash,
      reconcileOk: newPath.reconcile!.ok,
    });

    assert.equal(cmp.verdict, "EQUIVALENT");
    assert.equal(cmp.diffs.length, 0);
    assert.equal(cmp.totals.UNEXPLAINED, 0);
    assert.equal(cmp.reconcile_ok, true);
  });

  it("dry-run writes NOTHING: no snapshot row, no pointer", async () => {
    const p = memoryPersistence();
    const frozen = makeCanonicalSnapshot({});
    await getPublishedLeagueSnapshot("bloodline-bowl", {
      persistence: p,
      forced: true,
      dryRun: true,
      buildOverride: async () => ({ ok: true, status: 200, snapshot: frozen }),
    });
    assert.equal(await p.published.get("bloodline-bowl", 2026), null);
    assert.equal(await p.snapshots.getLatest({ league_slug: "bloodline-bowl", season: 2026, week: 3 }), null);
  });

  it("a stronger identity in the new path is CORRECTED_IDENTITY, not UNEXPLAINED", () => {
    const oldSnap = makeCanonicalSnapshot({
      players: [testPlayer("99999", { unresolved: true })],
      rosterPlayerIdsByTeam: { "1": ["player:sleeper:99999"] },
    });
    const newSnap = makeCanonicalSnapshot({
      players: [testPlayer("99999", { unresolved: false, team: "BUF" })], // same id, now resolved
      rosterPlayerIdsByTeam: { "1": ["player:sleeper:99999"] },
    });
    const h = snapshotContentHash(oldSnap);
    const cmp = compareCanonicalPaths(oldSnap, newSnap, {
      mode: "LIVE_SHADOW",
      sourceStartHash: h,
      sourceEndHash: h,
      reconcileOk: true,
    });
    assert.equal(cmp.totals.UNEXPLAINED, 0);
    assert.ok(cmp.totals.CORRECTED_IDENTITY >= 1);
    assert.equal(cmp.verdict, "EQUIVALENT_WITH_DOCUMENTED_DIFFS");
  });

  it("real divergence on a stable source is UNEXPLAINED (gate fails)", () => {
    const oldSnap = makeCanonicalSnapshot({ teams: [
      { roster_id: "1", wins: 5, losses: 0 },
      { roster_id: "2", wins: 0, losses: 5 },
    ] });
    const newSnap = makeCanonicalSnapshot({ teams: [
      { roster_id: "1", wins: 2, losses: 3 }, // materially different record
      { roster_id: "2", wins: 3, losses: 2 },
    ] });
    const h = "same-source-hash";
    const cmp = compareCanonicalPaths(oldSnap, newSnap, {
      mode: "DETERMINISTIC_SAME_SOURCE",
      sourceStartHash: h,
      sourceEndHash: h,
      reconcileOk: true,
    });
    assert.equal(cmp.verdict, "UNEXPLAINED_DIFFERENCE");
    assert.ok(cmp.totals.UNEXPLAINED > 0);
  });

  it("divergence when the source moved is SOURCE_MOVED_DURING_RUN, not a regression", () => {
    const oldSnap = makeCanonicalSnapshot({ teams: [
      { roster_id: "1", wins: 5, losses: 0 },
      { roster_id: "2", wins: 0, losses: 5 },
    ] });
    const newSnap = makeCanonicalSnapshot({ teams: [
      { roster_id: "1", wins: 6, losses: 0 },
      { roster_id: "2", wins: 0, losses: 6 },
    ] });
    const cmp = compareCanonicalPaths(oldSnap, newSnap, {
      mode: "LIVE_SHADOW",
      sourceStartHash: "hash-at-start",
      sourceEndHash: "hash-at-end-DIFFERENT",
      reconcileOk: true,
    });
    assert.equal(cmp.verdict, "INCONCLUSIVE_SOURCE_MOVED");
    assert.equal(cmp.totals.UNEXPLAINED, 0);
    assert.ok(cmp.totals.SOURCE_MOVED_DURING_RUN > 0);
  });
});
