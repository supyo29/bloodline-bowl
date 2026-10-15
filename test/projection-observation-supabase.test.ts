/** W1.P4 durable stores on the deterministic FakeRest: parity with the in-memory reference, pagination past 1000 rows, idempotency, final-pregame SQL-side rules. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SupabaseFinalPregameStore, SupabaseSourceObservationStore } from "@/lib/persistence/supabase/projection-observations";
import { MemorySourceObservationStore, SourceObservationRecorder, type SourceObservationInput, type SourcePlayerObservation } from "@/lib/weekly/freshness/observation";
import { MemoryFinalPregameStore, type FinalPregameRecord } from "@/lib/weekly/freshness/final-pregame";
import { FakeRest } from "./fixtures/fake-rest";

const T0 = Date.parse("2026-10-11T09:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const pl = (id: string, over: Partial<SourcePlayerObservation> = {}): SourcePlayerObservation => ({ provider: "sleeper", provider_player_id: id, position: "WR", nfl_team: "KC", opponent: "LV", injury_status: null, gp: 1, stats: { rec: 5, rec_yd: 60 }, ...over });
const obs = (min: number, players: SourcePlayerObservation[]): SourceObservationInput => ({ provider: "sleeper", season: 2026, week: 5, observed_at: at(min), by_segment: { WR: at(min) }, fetch_path: "LIVE_FETCH", players });
const many = (n: number) => Array.from({ length: n }, (_, i) => pl(`p${String(i).padStart(5, "0")}`));

async function script(rec: SourceObservationRecorder, n: number) {
  const base = many(n);
  await rec.record(obs(0, base));
  await rec.record(obs(10, base)); // unchanged -> touch
  const b = base.map((p, i) => (i === 3 ? pl(p.provider_player_id, { stats: { rec: 8, rec_yd: 99 } }) : i === 9 ? pl(p.provider_player_id, { injury_status: "Questionable" }) : p));
  await rec.record(obs(20, b));
  await rec.record(obs(30, b.slice(1))); // tombstone for p00000
}

describe("W1.P4 Supabase observation store", () => {
  it("is behaviourally identical to the in-memory reference (headers, replay state, events)", async () => {
    const mem = new MemorySourceObservationStore();
    const rest = new FakeRest();
    const sb = new SupabaseSourceObservationStore(rest.asRest());
    await script(new SourceObservationRecorder(mem), 40);
    await script(new SourceObservationRecorder(sb), 40);
    const hm = await mem.headers("sleeper", 2026, 5);
    const hs = await sb.headers("sleeper", 2026, 5);
    assert.deepEqual(hs.map((h) => [h.observation_id, h.kind, h.row_count, h.changed_count, h.removed_count]), hm.map((h) => [h.observation_id, h.kind, h.row_count, h.changed_count, h.removed_count]));
    for (const m of [5, 15, 25, 35]) {
      const a = await mem.stateAsOf("sleeper", 2026, 5, at(m));
      const b = await sb.stateAsOf("sleeper", 2026, 5, at(m));
      assert.deepEqual([...b.players.entries()].map(([k, v]) => [k, v.player_hash, v.removed]).sort(), [...a.players.entries()].map(([k, v]) => [k, v.player_hash, v.removed]).sort(), `as of +${m}m`);
    }
    assert.deepEqual((await sb.events("sleeper", 2026, 5)).map((e) => e.event_id).sort(), (await mem.events("sleeper", 2026, 5)).map((e) => e.event_id).sort());
  });

  it("history rows are change-only: unchanged observations add no player rows", async () => {
    const rest = new FakeRest();
    const rec = new SourceObservationRecorder(new SupabaseSourceObservationStore(rest.asRest()));
    await script(rec, 40);
    const rows = rest.t("bridge_projection_source_observation_rows");
    // FULL (40) + DELTA(2 changed) + DELTA(1 tombstone) = 43 — NOT 4 x 40
    assert.equal(rows.length, 43);
    assert.equal(rest.t("bridge_projection_source_observations").length, 3, "the unchanged re-observation wrote no header either");
  });

  it("an observation larger than the 1000-row PostgREST page replays completely", async () => {
    const rest = new FakeRest();
    const sb = new SupabaseSourceObservationStore(rest.asRest());
    const rec = new SourceObservationRecorder(sb);
    await rec.record(obs(0, many(2305)));
    const changed = many(2305).map((p, i) => (i === 2000 ? pl(p.provider_player_id, { injury_status: "Out" }) : p));
    await rec.record(obs(15, changed));
    const st = await sb.latestState("sleeper", 2026, 5);
    assert.equal(st.players.size, 2305);
    assert.equal(st.players.get("p02000")!.row!.injury_status, "Out");
    assert.ok(rest.selects.some((s) => (s.offset ?? 0) >= 2000), "paged beyond 2000");
    assert.ok(rest.selects.every((s) => (s.limit ?? 0) <= 1000));
  });

  it("append is idempotent (a retried write inserts nothing twice)", async () => {
    const rest = new FakeRest();
    const sb = new SupabaseSourceObservationStore(rest.asRest());
    const mem = new MemorySourceObservationStore();
    const r = await new SourceObservationRecorder(mem).record(obs(0, many(5)));
    assert.equal(r.status, "RECORDED");
    if (r.status !== "RECORDED") return;
    const rows = [...(await mem.stateAsOf("sleeper", 2026, 5, at(1))).players.values()];
    await sb.append({ header: r.header, rows, events: [] });
    await sb.append({ header: r.header, rows, events: [] });
    assert.equal(rest.t("bridge_projection_source_observations").length, 1);
    assert.equal(rest.t("bridge_projection_source_observation_rows").length, 5);
  });

  it("the confirmation touch advances the pointer monotonically and never backwards", async () => {
    const rest = new FakeRest();
    const sb = new SupabaseSourceObservationStore(rest.asRest());
    const rec = new SourceObservationRecorder(sb);
    await rec.record(obs(0, many(3)));
    await sb.touch("sleeper", 2026, 5, at(30), "h");
    await sb.touch("sleeper", 2026, 5, at(10), "h-old");
    assert.equal((await sb.latestState("sleeper", 2026, 5)).last_observed_at, at(30));
  });
});

const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const fat = (off: number) => new Date(KICK + off).toISOString();
const frec = (offMin: number, pts: number, over: Partial<FinalPregameRecord> = {}): FinalPregameRecord => ({
  record_version: 2, forecast_id: `fpf:test-${pts}-${offMin}`, composed_at: fat(offMin * 60_000), content_signature: `sig:${pts}`, forecast_snapshot: null,
  league_slug: "bloodline-bowl", provider: "sleeper", season: 2026, week: 5, canonical_player_id: "player:x", identifiers: {}, game_id: "g1",
  kickoff_at: fat(0), source_observed_at: fat(offMin * 60_000), confirmed_through: fat(offMin * 60_000), source_observation_id: null,
  seconds_before_kickoff: -offMin * 60, source_provider: "sleeper", source_version: "v", forecast_model_version: "m1", injury_model_version: "i1",
  scoring_fingerprint: "fp", snapshot_artifact_id: null, expected_points: pts, source_points: pts, conditional_active_points: pts,
  current_week_state: "PROJECTED", injury: { source_status: null, normalized_state: "HEALTHY", probability_active: 1, mode: "NONE" },
  shadow: { role_adjustment: null, matchup_adjustment: null, environment_adjustment: null }, freshness_state: "FRESH", recorded_at: fat(offMin * 60_000), ...over,
});

describe("W1.P4 Supabase final-pregame store", () => {
  it("resolves T-24h, T-3h, T-45m, T-10m, T+5m to the T-10m forecast, identically to the memory reference", async () => {
    const rest = new FakeRest();
    const sb = new SupabaseFinalPregameStore(rest.asRest());
    const mem = new MemoryFinalPregameStore();
    const seq: Array<[number, number]> = [[-1440, 10], [-180, 11], [-45, 12], [-10, 13], [5, 99]];
    const a: string[] = [];
    const b: string[] = [];
    for (const [m, p] of seq) {
      a.push(await sb.upsertCandidate(frec(m, p)));
      b.push(await mem.upsertCandidate(frec(m, p)));
    }
    assert.deepEqual(a, b);
    assert.deepEqual(a, ["RECORDED", "RECORDED", "RECORDED", "RECORDED", "REJECTED_POST_KICKOFF"]);
    const f = await sb.get("bloodline-bowl", 2026, 5, "player:x");
    assert.equal(f?.expected_points, 13);
    assert.equal(f?.source_observed_at, fat(-10 * 60_000));
    assert.equal(rest.t("bridge_final_pregame_forecasts").length, 1, "one frozen row per league/player/week");
  });

  it("batched upsert: identical later observation CONFIRMS in one batched update; league rows stay separate", async () => {
    const rest = new FakeRest();
    const sb = new SupabaseFinalPregameStore(rest.asRest());
    const ids = Array.from({ length: 30 }, (_, i) => `player:${i}`);
    await sb.upsertMany(ids.map((id) => frec(-45, 5, { canonical_player_id: id })));
    await sb.upsertCandidate(frec(-45, 7, { canonical_player_id: "player:0", league_slug: "rogers-park", scoring_fingerprint: "fp2" }));
    const before = rest.requests;
    const r = await sb.upsertMany(ids.map((id) => frec(-10, 5, { canonical_player_id: id })));
    assert.equal(r.CONFIRMED, 30);
    assert.ok(rest.requests - before <= 4, `confirmation is batched (used ${rest.requests - before} requests)`);
    const f = await sb.get("bloodline-bowl", 2026, 5, "player:0");
    assert.equal(f?.source_observed_at, fat(-45 * 60_000));
    assert.equal(f?.confirmed_through, fat(-10 * 60_000));
    assert.equal((await sb.get("rogers-park", 2026, 5, "player:0"))?.expected_points, 7);
  });
});
