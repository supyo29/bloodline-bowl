/** W1.P4 source-observation history: change-only capture, FULL anchors + DELTAs, provider namespaces, cross-league sharing. Fixed instants only. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FULL_ANCHOR_INTERVAL_MS,
  MemorySourceObservationStore,
  SourceObservationRecorder,
  STAT_EPSILON,
  type SourceObservationInput,
  type SourcePlayerObservation,
} from "../lib/weekly/freshness/observation";

const T0 = Date.parse("2026-10-11T09:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const pl = (id: string, over: Partial<SourcePlayerObservation> = {}, provider = "sleeper"): SourcePlayerObservation => ({
  provider,
  provider_player_id: id,
  position: "WR",
  nfl_team: "KC",
  opponent: "BUF",
  injury_status: null,
  gp: 1,
  stats: { rec: 6, rec_yd: 80, rec_td: 0.5 },
  ...over,
});
const obs = (min: number, players: SourcePlayerObservation[], provider = "sleeper", week = 5): SourceObservationInput => ({
  provider,
  season: 2026,
  week,
  observed_at: at(min),
  by_segment: { WR: at(min) },
  fetch_path: "LIVE_FETCH",
  players,
});
const mk = () => {
  const store = new MemorySourceObservationStore();
  return { store, rec: new SourceObservationRecorder(store) };
};
const roster = () => Array.from({ length: 50 }, (_, i) => pl(`p${i}`));

describe("W1.P4 observation history", () => {
  it("first observation is a FULL anchor with every row", async () => {
    const { store, rec } = mk();
    const r = await rec.record(obs(0, roster()));
    assert.equal(r.status, "RECORDED");
    if (r.status !== "RECORDED") return;
    assert.equal(r.header.kind, "FULL");
    assert.equal(r.header.base_observation_id, null);
    assert.equal(store.totalRows(), 50);
    assert.equal(r.events.length, 0, "new players appearing is not an invalidation");
  });

  it("the same upstream fetch seen again (another league / request) writes nothing", async () => {
    const { store, rec } = mk();
    await rec.record(obs(0, roster()));
    const again = await rec.record(obs(0, roster()));
    assert.equal(again.status, "SKIPPED_SAME_FETCH");
    assert.equal(store.appends, 1);
  });

  it("an unchanged payload at a later fetch is a confirmation touch, not history rows", async () => {
    const { store, rec } = mk();
    await rec.record(obs(0, roster()));
    const r = await rec.record(obs(30, roster()));
    assert.equal(r.status, "UNCHANGED_CONFIRMED");
    assert.equal(store.totalRows(), 50);
    assert.equal(store.touches, 1);
    const st = await store.latestState("sleeper", 2026, 5);
    assert.equal(st.last_observed_at, at(30), "confirmation pointer advanced");
    assert.equal((await store.headers("sleeper", 2026, 5)).length, 1);
  });

  it("a projection change writes a DELTA containing ONLY the changed player", async () => {
    const { store, rec } = mk();
    await rec.record(obs(0, roster()));
    const next = roster();
    next[7] = pl("p7", { stats: { rec: 6, rec_yd: 95, rec_td: 0.5 } });
    const r = await rec.record(obs(30, next));
    assert.equal(r.status, "RECORDED");
    if (r.status !== "RECORDED") return;
    assert.equal(r.header.kind, "DELTA");
    assert.equal(r.header.base_observation_id, (await store.headers("sleeper", 2026, 5))[0]!.observation_id);
    assert.equal(r.header.row_count, 1);
    assert.equal(store.totalRows(), 51);
    assert.ok(r.events.some((e) => e.type === "PROJECTION_SOURCE_UPDATE"));
  });

  it("sub-epsilon drift is not material, but accumulates against the LAST RECORDED value", async () => {
    const { store, rec } = mk();
    await rec.record(obs(0, roster()));
    const drift = (d: number) => roster().map((p, i) => (i === 3 ? pl("p3", { stats: { rec: 6, rec_yd: 80 + d, rec_td: 0.5 } }) : p));
    assert.equal((await rec.record(obs(10, drift(STAT_EPSILON * 0.6)))).status, "UNCHANGED_CONFIRMED");
    // 0.6 + 0.6 eps against the ORIGINAL recorded 80 => 1.2 eps >= eps: now material
    assert.equal((await rec.record(obs(20, drift(STAT_EPSILON * 1.2)))).status, "RECORDED");
    assert.equal(store.appends, 2);
  });

  it("injury / status change is material and emits a targeted PLAYER event", async () => {
    const { rec } = mk();
    await rec.record(obs(0, roster()));
    const next = roster();
    next[2] = pl("p2", { injury_status: "Questionable" });
    const r = await rec.record(obs(15, next));
    assert.equal(r.status, "RECORDED");
    if (r.status !== "RECORDED") return;
    const e = r.events.find((x) => x.type === "INJURY_STATUS_CHANGE")!;
    assert.deepEqual(e.scope, { kind: "PLAYER", provider: "sleeper", provider_player_id: "p2" });
    assert.deepEqual(e.detail, { from: null, to: "Questionable" });
    assert.equal(e.known_at, at(15), "known_at is the observation instant, never a claimed upstream time");
  });

  it("a player leaving the feed is a tombstone, not silent absence", async () => {
    const { store, rec } = mk();
    await rec.record(obs(0, roster()));
    const r = await rec.record(obs(20, roster().slice(1)));
    assert.equal(r.status, "RECORDED");
    if (r.status !== "RECORDED") return;
    assert.equal(r.header.removed_count, 1);
    const st = await store.latestState("sleeper", 2026, 5);
    assert.equal(st.players.get("p0")!.removed, true);
    const asOf = await store.stateAsOf("sleeper", 2026, 5, at(10));
    assert.equal(asOf.players.get("p0")!.removed, false, "history before the removal still shows him");
  });

  it("a FULL anchor is re-written once the interval elapses even if nothing changed", async () => {
    const { rec } = mk();
    await rec.record(obs(0, roster()));
    const later = new Date(T0 + FULL_ANCHOR_INTERVAL_MS).toISOString();
    const r = await rec.record({ ...obs(0, roster()), observed_at: later });
    assert.equal(r.status, "RECORDED");
    if (r.status === "RECORDED") assert.equal(r.header.kind, "FULL");
  });

  it("replay: stateAsOf equals the recorded state at every observation", async () => {
    const { store, rec } = mk();
    await rec.record(obs(0, roster()));
    const a = roster();
    a[1] = pl("p1", { stats: { rec: 9, rec_yd: 110, rec_td: 1 } });
    await rec.record(obs(30, a));
    const b = a.map((p, i) => (i === 4 ? pl("p4", { injury_status: "Out" }) : p));
    await rec.record(obs(60, b));
    const s0 = await store.stateAsOf("sleeper", 2026, 5, at(10));
    const s1 = await store.stateAsOf("sleeper", 2026, 5, at(40));
    const s2 = await store.stateAsOf("sleeper", 2026, 5, at(90));
    assert.equal(s0.players.get("p1")!.row!.stats.rec_yd, 80);
    assert.equal(s1.players.get("p1")!.row!.stats.rec_yd, 110);
    assert.equal(s1.players.get("p4")!.row!.injury_status, null);
    assert.equal(s2.players.get("p4")!.row!.injury_status, "Out");
  });

  it("provider namespaces are independent: the same id under two providers never collides", async () => {
    const { store, rec } = mk();
    await rec.record(obs(0, [pl("100", { stats: { rec: 5 } }, "sleeper")], "sleeper"));
    await rec.record(obs(0, [pl("100", { stats: { rec: 1 } }, "yahoo")], "yahoo"));
    assert.equal((await store.stateAsOf("sleeper", 2026, 5, at(5))).players.get("100")!.row!.stats.rec, 5);
    assert.equal((await store.stateAsOf("yahoo", 2026, 5, at(5))).players.get("100")!.row!.stats.rec, 1);
    // a change in one provider's feed creates no event in the other's
    const r = await rec.record(obs(20, [pl("100", { injury_status: "Out", stats: { rec: 5 } }, "sleeper")], "sleeper"));
    assert.equal(r.status, "RECORDED");
    assert.equal((await store.events("yahoo", 2026, 5)).length, 0);
  });

  it("weeks are independent histories", async () => {
    const { store, rec } = mk();
    await rec.record(obs(0, roster(), "sleeper", 5));
    const r = await rec.record(obs(1, roster(), "sleeper", 6));
    assert.equal(r.status, "RECORDED");
    if (r.status === "RECORDED") assert.equal(r.header.kind, "FULL");
    assert.equal((await store.headers("sleeper", 2026, 5)).length, 1);
  });

  it("league-independence: stored rows carry raw stat facts and no league scoring", async () => {
    const { store, rec } = mk();
    await rec.record(obs(0, roster()));
    const st = await store.latestState("sleeper", 2026, 5);
    for (const row of st.players.values()) {
      const keys = Object.keys(row.row as object);
      assert.deepEqual(keys.sort(), ["gp", "injury_status", "nfl_team", "opponent", "position", "stats"]);
      assert.equal("projected_points" in (row.row as object), false);
      assert.equal("scoring_fingerprint" in (row.row as object), false);
    }
  });

  it("five leagues observing the same feed produce ONE observation (shared, not duplicated)", async () => {
    const { store, rec } = mk();
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await rec.record(obs(0, roster())));
    assert.equal(results.filter((r) => r.status === "RECORDED").length, 1);
    assert.equal(results.filter((r) => r.status === "SKIPPED_SAME_FETCH").length, 4);
    assert.equal(store.appends, 1);
  });

  it("a failing store never throws into the projection path and allows a retry", async () => {
    const store = new MemorySourceObservationStore();
    let fail = true;
    const orig = store.latestState.bind(store);
    store.latestState = async (...a) => {
      if (fail) throw new Error("db down");
      return orig(...a);
    };
    const rec = new SourceObservationRecorder(store);
    assert.equal((await rec.record(obs(0, roster()))).status, "ERROR");
    fail = false;
    assert.equal((await rec.record(obs(0, roster()))).status, "RECORDED");
  });
});
