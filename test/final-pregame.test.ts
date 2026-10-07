/** W1.P4 final-pregame freezing for calibration. Fixed instants only. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MemoryFinalPregameStore,
  selectFinalPregameObservation,
  type FinalPregameRecord,
} from "../lib/weekly/freshness/final-pregame";

const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const MIN = 60_000;
const H = 60 * MIN;
const at = (off: number) => new Date(KICK + off).toISOString();

const rec = (offMs: number, pts: number, over: Partial<FinalPregameRecord> = {}): FinalPregameRecord => ({
  record_version: 2,
  forecast_id: `fpf:test-${pts}-${offMs}`,
  composed_at: at(offMs),
  content_signature: `sig:${pts}`,
  forecast_snapshot: null,
  league_slug: "bloodline-bowl",
  provider: "sleeper",
  season: 2026,
  week: 5,
  canonical_player_id: "player:x",
  identifiers: { sleeper: "1" },
  game_id: "g1",
  kickoff_at: at(0),
  source_observed_at: at(offMs),
  confirmed_through: at(offMs),
  source_observation_id: `obs@${offMs}`,
  seconds_before_kickoff: Math.round(-offMs / 1000),
  source_provider: "sleeper",
  source_version: "v",
  forecast_model_version: "m1",
  injury_model_version: "i1",
  scoring_fingerprint: "fp-a",
  snapshot_artifact_id: null,
  expected_points: pts,
  source_points: pts,
  conditional_active_points: pts,
  current_week_state: "PROJECTED",
  injury: { source_status: null, normalized_state: "HEALTHY", probability_active: 1, mode: "NONE" },
  shadow: { role_adjustment: null, matchup_adjustment: null, environment_adjustment: null },
  freshness_state: "FRESH",
  recorded_at: at(offMs),
  ...over,
});

describe("W1.P4 final pregame observation", () => {
  const offsets = [-24 * H, -3 * H, -45 * MIN, -10 * MIN, 5 * MIN];

  it("T-24h, T-3h, T-45m, T-10m, T+5m resolves to T-10m", () => {
    const obs = offsets.map((o) => ({ observed_at: at(o), label: o }));
    const sel = selectFinalPregameObservation(obs, at(0));
    assert.equal(sel?.observed_at, at(-10 * MIN));
  });

  it("selection is independent of input order and of ISO spelling (offsets)", () => {
    const obs = [{ observed_at: "2026-10-11T12:50:00-04:00" }, { observed_at: at(-45 * MIN) }, { observed_at: at(5 * MIN) }];
    const sel = selectFinalPregameObservation([...obs].reverse(), at(0));
    assert.equal(Date.parse(sel!.observed_at), KICK - 10 * MIN);
  });

  it("an observation exactly at kickoff is still valid; one millisecond after is not", () => {
    assert.equal(selectFinalPregameObservation([{ observed_at: at(0) }], at(0))?.observed_at, at(0));
    assert.equal(selectFinalPregameObservation([{ observed_at: at(1) }], at(0)), null);
    assert.equal(selectFinalPregameObservation([{ observed_at: at(-1) }], "not a date"), null);
  });

  it("the store freezes the T-10m forecast; T+5m and older candidates can never replace it", async () => {
    const s = new MemoryFinalPregameStore();
    const writes: string[] = [];
    for (const [o, p] of [[-24 * H, 10], [-3 * H, 11], [-45 * MIN, 12], [-10 * MIN, 13], [5 * MIN, 99]] as const) writes.push(await s.upsertCandidate(rec(o, p)));
    assert.deepEqual(writes, ["RECORDED", "RECORDED", "RECORDED", "RECORDED", "REJECTED_POST_KICKOFF"]);
    const final = await s.get("bloodline-bowl", 2026, 5, "player:x");
    assert.equal(final?.expected_points, 13);
    assert.equal(final?.source_observed_at, at(-10 * MIN));
    assert.equal(final?.seconds_before_kickoff, 600);
    // a late-arriving OLDER candidate is rejected
    assert.equal(await s.upsertCandidate(rec(-45 * MIN, 12)), "REJECTED_OLDER_OBSERVATION");
    assert.equal((await s.get("bloodline-bowl", 2026, 5, "player:x"))?.expected_points, 13);
  });

  it("identical content seen later only CONFIRMS (extends confirmed_through, keeps first-observed)", async () => {
    const s = new MemoryFinalPregameStore();
    await s.upsertCandidate(rec(-45 * MIN, 12));
    assert.equal(await s.upsertCandidate(rec(-10 * MIN, 12)), "CONFIRMED");
    const f = await s.get("bloodline-bowl", 2026, 5, "player:x");
    assert.equal(f?.source_observed_at, at(-45 * MIN));
    assert.equal(f?.confirmed_through, at(-10 * MIN));
    assert.equal(f?.seconds_before_kickoff, 600);
    assert.equal(await s.upsertCandidate(rec(-10 * MIN, 12)), "UNCHANGED");
  });

  it("a record with no kickoff is rejected", async () => {
    const s = new MemoryFinalPregameStore();
    assert.equal(await s.upsertCandidate(rec(-10 * MIN, 1, { kickoff_at: "" })), "REJECTED_NO_KICKOFF");
  });

  it("records are league-scoped: two leagues, same player, different scoring never overwrite each other", async () => {
    const s = new MemoryFinalPregameStore();
    await s.upsertCandidate(rec(-10 * MIN, 14, { league_slug: "bloodline-bowl", scoring_fingerprint: "fp-ppr" }));
    await s.upsertCandidate(rec(-10 * MIN, 11, { league_slug: "rogers-park", scoring_fingerprint: "fp-std" }));
    assert.equal((await s.get("bloodline-bowl", 2026, 5, "player:x"))?.expected_points, 14);
    assert.equal((await s.get("rogers-park", 2026, 5, "player:x"))?.expected_points, 11);
    assert.equal(s.size(), 2);
  });

  it("upsertMany reports per-outcome counts", async () => {
    const s = new MemoryFinalPregameStore();
    const r = await s.upsertMany([rec(-10 * MIN, 1), rec(5 * MIN, 2, { canonical_player_id: "player:y" })]);
    assert.equal(r.RECORDED, 1);
    assert.equal(r.REJECTED_POST_KICKOFF, 1);
  });
});
