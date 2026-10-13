/**
 * W2.P2 — capture-store semantics: insert-only, idempotent, never-late, version-isolated, failure-safe.
 * Exercised through the in-memory store AND the Supabase store (against the repo's FakeRest, which raises errors in the real wrapper's shape).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withIds, type RoleShadowRecord } from "../lib/role-shadow/record";
import { MemoryRoleShadowStore, lateReason, type RoleShadowStore } from "../lib/role-shadow/store";
import { SupabaseRoleShadowStore, ROLE_SHADOW_TABLE, captureRow } from "../lib/persistence/supabase/role-shadow-store";
import { PINNED } from "../lib/role-shadow/spec";
import { FakeRest } from "./fixtures/fake-rest";
import { KICK, MIN, NOW, liveRecord } from "./fixtures/role-shadow";

const strip = (r: RoleShadowRecord) => { const { capture_id: _a, content_hash: _b, ...rest } = r; void _a; void _b; return rest; };

function stores(now = () => NOW): Array<[string, () => { store: RoleShadowStore; rows: () => number; fake?: FakeRest }]> {
  return [
    ["memory", () => { const s = new MemoryRoleShadowStore(now); return { store: s, rows: () => 0 }; }],
    ["supabase(fake)", () => { const fake = new FakeRest(); return { store: new SupabaseRoleShadowStore(fake.asRest(), now), rows: () => fake.t(ROLE_SHADOW_TABLE).length, fake }; }],
  ];
}

for (const [name, make] of stores()) {
  describe(`store semantics — ${name}`, () => {
    it("inserts a valid pregame record; listing returns it; a second write of the same decision is a DUPLICATE_IDENTICAL no-op", async () => {
      const { store } = make();
      const r = liveRecord();
      assert.equal((await store.record(r)).status, "INSERTED");
      assert.equal((await store.record(r)).status, "DUPLICATE_IDENTICAL");
      assert.equal((await store.list()).length, 1);
      assert.deepEqual((await store.list())[0]!.capture_id, r.capture_id);
    });

    it("CONCURRENT writers of the same decision: exactly one INSERTED, the rest DUPLICATE_IDENTICAL, exactly one stored row", async () => {
      const { store } = make();
      const r = liveRecord();
      const res = await Promise.all(Array.from({ length: 25 }, () => store.record(r)));
      assert.equal(res.filter((x) => x.status === "INSERTED").length, 1, res.map((x) => x.status).join());
      assert.equal(res.filter((x) => x.status === "DUPLICATE_IDENTICAL").length, 24);
      assert.equal((await store.list()).length, 1);
    });

    it("an existing observation is NEVER replaced: changed evidence is a different record alongside the old one; the old row is byte-identical", async () => {
      const { store } = make();
      const a = liveRecord({ points: 14.6 });
      const b = liveRecord({ points: 15.4 });
      assert.notEqual(a.capture_id, b.capture_id);
      await store.record(a);
      await store.record(b);
      const all = await store.list();
      assert.equal(all.length, 2);
      assert.deepEqual(all.find((x) => x.capture_id === a.capture_id), a);
    });

    it("has no update/delete surface, and mutating a listed copy cannot change the stored record", async () => {
      const { store } = make();
      const r = liveRecord();
      await store.record(r);
      const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter((k) => k !== "constructor");
      assert.deepEqual(surface.sort(), ["list", "record"], "the interface is insert + read only");
      const copy = (await store.list())[0]!;
      copy.champion.expected_points = 999;
      assert.equal((await store.list())[0]!.champion.expected_points, r.champion.expected_points);
    });

    it("MODEL-VERSION ISOLATION: a record under another model/config hash can neither overwrite nor validate as the frozen one", async () => {
      const { store } = make();
      const r = liveRecord();
      await store.record(r);
      const other = withIds({ ...strip(r), models: { ...r.models, challenger: { ...r.models.challenger, config_hash: "f".repeat(32) } } });
      const res = await store.record(other);
      assert.equal(res.status, "REFUSED_INVALID");
      assert.match(res.reason ?? "", /not the pinned frozen configuration/);
      assert.equal((await store.list({ challenger_config_hash: PINNED.challenger_config_hash })).length, 1);
      assert.equal((await store.list({ challenger_config_hash: "f".repeat(32) })).length, 0);
    });

    it("REFUSES a tampered record (content hash mismatch) and a record whose timeline is not pregame", async () => {
      const { store } = make();
      const r = liveRecord();
      const t = structuredClone(r);
      t.champion.conditional_active_points = 30;
      assert.equal((await store.record(t)).status, "REFUSED_INVALID");
      const late = withIds({ ...strip(r), timing: { ...r.timing, captured_at: r.game.kickoff_at! } });
      assert.equal((await store.record(late)).status, "REFUSED_INVALID");
      assert.equal((await store.list()).length, 0);
    });

    it("filters: by season/week/league/class/config hash", async () => {
      const { store } = make();
      await store.record(liveRecord());
      await store.record(liveRecord({ id: "p2", sleeper_id: "s2", gsis_id: "00-0002" }, { gsis: "00-0002", sleeper: "s2", id: "rf:2222222222222222222222aa" }, { league_slug: "devoted" }));
      assert.equal((await store.list({ league_slug: "devoted" })).length, 1);
      assert.equal((await store.list({ season: 2026, week: 6 })).length, 2);
      assert.equal((await store.list({ week: 7 })).length, 0);
      assert.equal((await store.list({ capture_class: "LIVE_CAPTURED" })).length, 2);
    });
  });
}

describe("late evidence is refused on the STORE's clock even if the record was composed pregame", () => {
  for (const [name, make] of stores(() => KICK + MIN)) {
    it(`${name}: a valid pregame record arriving after kickoff is REFUSED_LATE and not stored`, async () => {
      const { store, rows } = make();
      const r = liveRecord(); // composed/captured two days before kickoff
      const res = await store.record(r);
      assert.equal(res.status, "REFUSED_LATE");
      assert.match(res.reason ?? "", /at\/after kickoff/);
      assert.equal(rows(), 0);
      assert.equal((await store.list()).length, 0);
    });
  }
  it("lateReason(): boundary is inclusive of the kickoff instant; reconstructed rows are not subject to the live clock", () => {
    const r = liveRecord();
    assert.equal(lateReason(r, KICK - 1), null);
    assert.ok(lateReason(r, KICK));
    assert.equal(lateReason({ ...r, capture_class: "HISTORICALLY_RECONSTRUCTED" }, KICK + 1e9), null);
  });
});

describe("Supabase store: persistence failures are classified, never thrown, never silent", () => {
  const live = () => { const fake = new FakeRest(); return { fake, store: new SupabaseRoleShadowStore(fake.asRest(), () => NOW) }; };

  it("database refuses on ITS clock (Postgres P0001 from the not-late trigger) => REFUSED_LATE, not ERROR", async () => {
    const { fake, store } = live();
    fake.failures.push({ method: "POST", table: ROLE_SHADOW_TABLE, status: 400, code: "P0001" });
    const res = await store.record(liveRecord());
    assert.equal(res.status, "REFUSED_LATE");
  });

  it("CHECK violation (23514) => REFUSED_INVALID", async () => {
    const { fake, store } = live();
    fake.failures.push({ method: "POST", table: ROLE_SHADOW_TABLE, status: 400, code: "23514" });
    assert.equal((await store.record(liveRecord())).status, "REFUSED_INVALID");
  });

  it("table missing (migration not applied) / 5xx / network error => ERROR with a reason; the call never throws", async () => {
    const a = live();
    a.fake.missingTables.add(ROLE_SHADOW_TABLE);
    const r1 = await a.store.record(liveRecord());
    assert.equal(r1.status, "ERROR");
    const b = live();
    b.fake.failures.push({ method: "POST", table: ROLE_SHADOW_TABLE, status: 503 });
    assert.equal((await b.store.record(liveRecord())).status, "ERROR");
    const throwing = new SupabaseRoleShadowStore({ insertIgnoreDuplicates: async () => { throw new Error("socket hang up"); } } as never, () => NOW);
    const r3 = await throwing.record(liveRecord());
    assert.equal(r3.status, "ERROR");
    assert.match(r3.reason ?? "", /socket hang up/);
  });

  it("RETRY after a transient failure inserts exactly once; a retry of an already-stored record is a no-op", async () => {
    const { fake, store } = live();
    const r = liveRecord();
    fake.failures.push({ method: "POST", table: ROLE_SHADOW_TABLE, status: 503 });
    assert.equal((await store.record(r)).status, "ERROR");
    assert.equal((await store.record(r)).status, "INSERTED");
    assert.equal((await store.record(r)).status, "DUPLICATE_IDENTICAL");
    assert.equal(fake.t(ROLE_SHADOW_TABLE).length, 1);
  });

  it("the stored row carries the denormalised columns the migration indexes/CHECKs and the full record; schema compatibility with the migration's column set", () => {
    const r = liveRecord();
    const row = captureRow(r);
    assert.deepEqual(Object.keys(row).sort(), [
      "capture_class", "capture_id", "captured_at", "challenger_config_hash", "challenger_model_id", "canonical_player_id", "content_hash", "control_config_hash", "eligible", "gsis_id",
      "kickoff_at", "league_slug", "position", "provider", "record", "record_schema_version", "scoring_compatibility", "scoring_fingerprint", "season", "source_observed_at", "week",
    ].sort());
    assert.equal(row.eligible, r.population.eligible);
    assert.deepEqual(row.record, r);
  });

  it("RESTART / durability: a brand-new store instance (process restart, new deployment) sees every earlier observation; re-capturing is a no-op; nothing is replaced", async () => {
    const fake = new FakeRest();
    const before = new SupabaseRoleShadowStore(fake.asRest(), () => NOW);
    const a = liveRecord({ points: 14.6 });
    const b = liveRecord({ points: 15.9 });
    await before.record(a);
    await before.record(b);
    const snapshot = JSON.stringify(fake.t(ROLE_SHADOW_TABLE));
    const after = new SupabaseRoleShadowStore(fake.asRest(), () => NOW); // "restart": nothing in memory survives except the database
    assert.deepEqual((await after.list()).map((r) => r.capture_id).sort(), [a.capture_id, b.capture_id].sort());
    assert.equal((await after.record(a)).status, "DUPLICATE_IDENTICAL");
    assert.equal((await after.record(b)).status, "DUPLICATE_IDENTICAL");
    assert.equal(JSON.stringify(fake.t(ROLE_SHADOW_TABLE)), snapshot, "a redeploy re-running the capture changes no stored row");
  });

  it("paged listing returns every row (>1000) in stable order", async () => {
    const { fake, store } = live();
    const base = liveRecord();
    const rows = Array.from({ length: 1203 }, (_, i) => ({ ...captureRow(base), capture_id: `rsc:${String(i).padStart(16, "0")}`, captured_at: new Date(NOW + i).toISOString(), record: { ...base, capture_id: `rsc:${String(i).padStart(16, "0")}` } }));
    fake.t(ROLE_SHADOW_TABLE).push(...rows);
    const out = await store.list();
    assert.equal(out.length, 1203);
    assert.equal(out[0]!.capture_id, "rsc:0000000000000000");
    assert.equal(out[1202]!.capture_id, "rsc:0000000000001202");
  });
});
