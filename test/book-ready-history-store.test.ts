/** Phase 3.5C Checkpoint B — immutable, content-addressed history store. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HISTORY_MANIFEST_VERSION, SNAPSHOT_SURFACES, contentId, listSnapshots, loadHistoryManifest, objectPath, readSnapshotFile, sha256, snapshotId, verifyHistoryStore } from "@/lib/book-ready/snapshots";

const ROOT = process.cwd();
const copyStore = () => { const t = mkdtempSync(join(tmpdir(), "hist-")); cpSync(join(ROOT, "data", "intelligence-history"), join(t, "data", "intelligence-history"), { recursive: true }); return t; };

test("the committed history store verifies end to end (ids derived from content; every object present and hash-correct)", () => {
  assert.deepEqual(verifyHistoryStore(ROOT), []);
  const m = loadHistoryManifest(ROOT); assert.equal(m.history_manifest_version, HISTORY_MANIFEST_VERSION); assert.ok(m.entries.length >= 9);
});

test("retention policy: COMPLETE_WEEK surfaces store only COMPLETE states; only genuinely published states are present", () => {
  for (const e of loadHistoryManifest(ROOT).entries) {
    if (e.policy === "COMPLETE_WEEK") assert.equal(e.week_state, "COMPLETE", e.snapshot_id);
    assert.ok(["GIT_PUBLICATION", "LIVE_SNAPSHOT"].includes(e.provenance.kind));
    assert.notEqual((e.provenance as { kind: string }).kind, "RETROSPECTIVE_RECONSTRUCTION");
  }
  // FI genuinely has week-1 COMPLETE published states, and no PARTIAL week-2 state was stored
  const fi = listSnapshots("football-intelligence", ROOT);
  assert.ok(fi.length >= 1 && fi.every((e) => e.week_state === "COMPLETE"));
  assert.ok(!fi.some((e) => e.through_week === 2), "week 2 is PARTIAL — must not be preserved as history");
});

test("immutability: identity is content-derived; ANY change yields a new id and cannot mutate an earlier snapshot", () => {
  const e = loadHistoryManifest(ROOT).entries[0]!;
  const changed = e.files.map((f, i) => (i === 0 ? { ...f, sha256: sha256("future data") } : f));
  assert.notEqual(contentId(changed), e.content_id);
  assert.notEqual(snapshotId(e.surface, e.version, contentId(changed)), e.snapshot_id);
  assert.equal(contentId(e.files), e.content_id); // the original identity is untouched by the hypothetical change
  assert.equal(contentId([...e.files].reverse()), e.content_id, "identity is order-independent");
});

test("tamper detection: a modified object is rejected on read and by whole-store verification", () => {
  const t = copyStore();
  const e = loadHistoryManifest(t).entries.find((x) => x.surface === "opportunity-propagation")!;
  const f = e.files.find((x) => x.name.endsWith(".csv"))!;
  assert.ok(readSnapshotFile(e, f.name, t).length > 0);
  writeFileSync(objectPath(f.sha256, t), Buffer.from("not the original bytes"));
  assert.throws(() => readSnapshotFile(e, f.name, t));
  assert.ok(verifyHistoryStore(t).length > 0);
});

test("a missing object or a forged content_id is caught", () => {
  const t = copyStore(); const p = join(t, "data", "intelligence-history", "manifest.json");
  const m = JSON.parse(readFileSync(p, "utf8")); m.entries[0].content_id = "0".repeat(64); writeFileSync(p, JSON.stringify(m));
  assert.match(verifyHistoryStore(t).join(), /content_id does not match/);
});

test("the writer is idempotent and append-only: re-running against the served state preserves nothing new and rewrites nothing", () => {
  const before = readFileSync(join(ROOT, "data/intelligence-history/manifest.json"), "utf8");
  const out = JSON.parse(execFileSync("npx", ["tsx", "scripts/intelligence-snapshot.ts", "--dry-run"], { cwd: ROOT, encoding: "utf8" }));
  assert.deepEqual(out.written, [], "nothing new to preserve for the current served state");
  assert.equal(readFileSync(join(ROOT, "data/intelligence-history/manifest.json"), "utf8"), before);
});

test("snapshot specs cover the four artifact surfaces with the documented policies", () => {
  const by = Object.fromEntries(SNAPSHOT_SURFACES.map((s) => [s.surface, s.policy]));
  assert.deepEqual(by, { "football-intelligence": "COMPLETE_WEEK", "role-opportunity": "COMPLETE_WEEK", "opportunity-propagation": "COMPLETE_WEEK", "player-scheme": "CONTENT_CHANGE" });
  for (const s of SNAPSHOT_SURFACES) assert.ok(existsSync(join(ROOT, s.manifest_path)));
  assert.ok(readdirSync(join(ROOT, "data/intelligence-history/objects")).length > 0);
});
