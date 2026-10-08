/**
 * W1.R2 — closes the meaningful mutation survivors the second independent audit found (J2, G1/G2/E5, D3, D5, B2 [in w1r2-asset-value], L3),
 * plus the signature-stability and calibration/pointer-selection consistency gaps. Each test is aimed at the exact edit that survived.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SupabaseFinalPregameStore } from "../lib/persistence/supabase/projection-observations";
import { buildCanonicalForecastBatch, type ForecastShadowSignals } from "../lib/weekly/forecast";
import { buildFinalPregameRecord, forecastContentSignature, MemoryFinalPregameStore, selectFinalRevision, type FinalPregameRecord } from "../lib/weekly/freshness/final-pregame";
import { finalRevisionPerPlayer } from "../lib/calibration/final-pregame-evidence";
import { lineupEndpointView } from "../lib/weekly/intelligence";
import { decisionProjectionRows } from "../lib/weekly/forecast/view";
import { clearProjectionFeedCache } from "../lib/sleeper/client";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import { SleeperWeeklyProjectionProvider, __resetOfferedObservationsForTests } from "../lib/weekly/projections/sleeper-weekly";
import type { CanonicalPlayer } from "../lib/canonical/schema";
import type { RosterConstraints, WeeklyProjection, WeeklyProjectionBatch, WeeklyTeamContext } from "../lib/weekly/schema";
import { FakeRest } from "./fixtures/fake-rest";
import { player, proj, roster, weeklyContext } from "./fixtures/weekly";

const MIN = 60_000;
const KICK = Date.parse("2026-10-11T17:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function forecast(o: { pts?: number; injury?: string | null; observedMin?: number; composedMin?: number; shadow?: ForecastShadowSignals; opponent?: string } = {}) {
  const row: WeeklyProjection = proj("wr1", "WR", o.pts ?? 14, { injury_status: o.injury ?? null, expected_availability: o.injury ? 0.78 : 1, opponent: o.opponent ?? "LV" });
  const live: CanonicalPlayer = { ...player("wr1", "WR", { team: "KC", injury: o.injury ?? null }), identifiers: { sleeper_id: "wr1" } };
  const observedAt = KICK + (o.observedMin ?? -30) * MIN;
  const batch: WeeklyProjectionBatch = {
    league_slug: "L1", season: 2026, week: 5, status: "READY", by_player: new Map([["wr1", row]]), resolved_players: new Map([["wr1", live]]),
    source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire", missing: [], teams_with_games: ["KC"], warnings: [],
    source_observation: { provider: "sleeper", observed_at: iso(observedAt), observation_id: "srcobs:abc", content_hash: "h", fetch_path: "LIVE_FETCH" },
  };
  return buildCanonicalForecastBatch({
    batch, requested_player_ids: ["wr1"], players: new Map([["wr1", live]]), shadow: o.shadow ? new Map([["wr1", o.shadow]]) : undefined,
    freshness: { now_ms: KICK + (o.composedMin ?? -20) * MIN, league_slug: "L1", provider: "sleeper", kickoffFor: () => ({ kickoff_at: iso(KICK), game_id: "g1" }) },
  }).by_player.get("wr1")!;
}
const record = (o: Parameters<typeof forecast>[0] = {}): FinalPregameRecord => {
  const f = forecast(o);
  return buildFinalPregameRecord({ forecast: f, league_slug: "L1", provider: "sleeper", scoring_fingerprint: "fp", source_observation_id: "srcobs:abc", recorded_at: f.freshness.forecast_composed_at! })!;
};

/* --------------------------------------------------------------------------------------------------------- J2 */

describe("J2: close calls are computed from the canonical decision rows, not the source rows", () => {
  const ONE_WR: RosterConstraints = { starting_slots: ["WR"], slot_requirements: { WR: 1 }, bench_slots: 3, ir_slots: 0, taxi_slots: 0, roster_size_limit: null, active_roster_capacity: 4, reserve_ir_capacity: 0, taxi_capacity: 0, flex_positions: [], flex_slots: 0 };
  it("the projection edge equals the CANONICAL expected-points difference (source rows would give the opposite sign)", () => {
    const base = weeklyContext({
      constraints: ONE_WR, myRoster: roster("team:test-league:1", ["A"], ["B"], { startingSlots: ["WR"] }),
      players: [player("A", "WR", { injury: "Questionable" }), player("B", "WR")],
      projections: [proj("A", "WR", 15, { injury_status: "Questionable", expected_availability: 0.78 }), proj("B", "WR", 14)],
    });
    const ctx: WeeklyTeamContext = { ...base, forecasts: buildCanonicalForecastBatch({ batch: base.projections, requested_player_ids: base.roster.all_players }) };
    const rows = decisionProjectionRows(ctx.projections, ctx.forecasts).rows;
    const call = lineupEndpointView(ctx).start_sit[0];
    assert.ok(call, "the scenario produces a close call");
    const start = rows.get(call.start_player_id)!.projected_points!;
    const over = rows.get(call.over_player_id)!.projected_points!;
    assert.equal(call.start_player_id, "B");
    assert.ok(call.projection_edge != null && call.projection_edge > 0, `edge ${call.projection_edge} must favour the started player on the canonical basis`);
    assert.ok(Math.abs(call.projection_edge - Math.round((start - over) * 100) / 100) <= 0.05, "edge = canonical(start) - canonical(over), to the edge's 0.1 rounding");
  });
});

/* --------------------------------------------------------------------------------------------- G1 / G2 / E5 */

/** B reads the pointer while it still says `seed`; A then advances it to `winner`; B writes `late` from its stale read */
async function staleRace(seed: FinalPregameRecord, winner: FinalPregameRecord, late: FinalPregameRecord) {
  const fake = new FakeRest();
  const A = new SupabaseFinalPregameStore(fake.asRest());
  await A.upsertCandidate(seed);
  const stale = structuredClone(fake.t("bridge_final_pregame_forecasts"));
  const realSelect = fake.select.bind(fake);
  let served = false;
  fake.select = (async (table: string, opts: never) => {
    if (table === "bridge_final_pregame_forecasts" && !served) {
      served = true;
      await A.upsertCandidate(winner);
      return stale as never;
    }
    return realSelect(table, opts);
  }) as never;
  const decided = await new SupabaseFinalPregameStore(fake.asRest()).upsertCandidate(late);
  return { decided, pointer: (await A.get("L1", 2026, 5, "wr1"))?.forecast_id };
}

describe("G1/G2/E5: mixed-axis pointer races (one timestamp newer, the other older)", () => {
  it("G2 (DB guard on the OBSERVATION axis): a later-composed writer built on an OLDER observation cannot move the pointer back", async () => {
    const seed = record({ observedMin: -200, composedMin: -190 });
    const winner = record({ pts: 14, injury: "Questionable", observedMin: -30, composedMin: -25 });
    const late = record({ pts: 9, injury: "Doubtful", observedMin: -60, composedMin: -5 }); // newer composition, OLDER evidence
    const r = await staleRace(seed, winner, late);
    assert.equal(r.decided, "RECORDED", "the stale read let the in-memory rule accept it");
    assert.equal(r.pointer, winner.forecast_id, "the DB-side observation guard kept the newer evidence");
  });

  it("G1 (DB guard on the COMPOSITION axis): same observation, an OLDER composition with different content cannot overwrite a newer one", async () => {
    const seed = record({ observedMin: -200, composedMin: -190 });
    const winner = record({ pts: 14, injury: "Doubtful", observedMin: -30, composedMin: -10 });
    const late = record({ pts: 14, injury: "Questionable", observedMin: -30, composedMin: -25 }); // same evidence, OLDER composition
    const r = await staleRace(seed, winner, late);
    assert.equal(r.pointer, winner.forecast_id, "the DB-side composition guard kept the newer composition");
  });

  it("E5 (the in-memory rule itself): newer composition on an older observation is rejected outright", async () => {
    const store = new MemoryFinalPregameStore();
    const newer = record({ pts: 14, observedMin: -30, composedMin: -25 });
    assert.equal(await store.upsertCandidate(newer), "RECORDED");
    assert.equal(await store.upsertCandidate(record({ pts: 9, injury: "Doubtful", observedMin: -60, composedMin: -5 })), "REJECTED_OLDER_OBSERVATION");
    assert.equal((await store.get("L1", 2026, 5, "wr1"))?.forecast_id, newer.forecast_id);
  });

  it("the ledger grades the revision the store's POINTER names — even after a stale-read race where a newer confirmation superseded the late writer (verifier S1)", async () => {
    const fake = new FakeRest();
    const A = new SupabaseFinalPregameStore(fake.asRest());
    const x = record({ pts: 14, observedMin: -60, composedMin: -55 });
    await A.upsertCandidate(x);
    const stale = structuredClone(fake.t("bridge_final_pregame_forecasts"));
    // X is CONFIRMED by a newer observation (-10): no new revision, the pointer's confirmed_through advances
    assert.equal(await A.upsertCandidate(record({ pts: 14, observedMin: -10, composedMin: -8 })), "CONFIRMED");
    // a late writer holding the STALE read proposes Y (obs -30, composed -5)
    const y = record({ pts: 9, injury: "Doubtful", observedMin: -30, composedMin: -5 });
    const realSelect = fake.select.bind(fake);
    let served = false;
    fake.select = (async (table: string, opts: never) => {
      if (table === "bridge_final_pregame_forecasts" && !served) { served = true; return stale as never; }
      return realSelect(table, opts);
    }) as never;
    assert.equal(await new SupabaseFinalPregameStore(fake.asRest()).upsertCandidate(y), "RECORDED", "decided against the stale pointer");
    fake.select = realSelect as never;
    const revisions = fake.t("bridge_final_pregame_revisions").map((r) => r.record as FinalPregameRecord);
    assert.equal(revisions.length, 2, "Y's revision exists (immutable evidence) ...");
    const pointer = (await A.get("L1", 2026, 5, "wr1"))!.forecast_id;
    assert.equal(pointer, x.forecast_id, "... but the DB guard kept the pointer on the confirmed belief");
    const graded = finalRevisionPerPlayer(revisions, new Map([["wr1", pointer]]));
    assert.equal(graded[0]!.forecast_id, x.forecast_id, "the ledger grades what the store froze, not the superseded late writer");
  });

  it("a pointer naming an INVALID revision (e.g. an older writer's observation exactly at kickoff) is not graded; the rule decides", () => {
    const ok = record({ pts: 14, observedMin: -20, composedMin: -10 });
    const bad = { ...record({ pts: 9, observedMin: -15, composedMin: -5 }), source_observed_at: iso(KICK), forecast_id: "fpf:badbadbadbadbadbadbadbad" };
    assert.equal(finalRevisionPerPlayer([ok, bad], new Map([["wr1", bad.forecast_id]]))[0]!.forecast_id, ok.forecast_id);
  });

  it("no pointer for a player: the deterministic selectFinalRevision decides", () => {
    const a = record({ pts: 14, observedMin: -20, composedMin: -5 });
    const b = record({ pts: 0, injury: "Out", observedMin: -15, composedMin: -10 });
    assert.equal(finalRevisionPerPlayer([a, b])[0]!.forecast_id, selectFinalRevision([a, b])!.forecast_id);
  });

  it("calibration grades the SAME revision the store considers final (one selection rule), even when revisions arrive out of order", () => {
    const olderEvidenceLaterComposition = record({ pts: 14, observedMin: -120, composedMin: -5 });
    const newerEvidence = record({ pts: 0, injury: "Out", observedMin: -30, composedMin: -25 });
    const picked = finalRevisionPerPlayer([newerEvidence, olderEvidenceLaterComposition]);
    assert.equal(picked.length, 1);
    assert.equal(picked[0]!.forecast_id, selectFinalRevision([olderEvidenceLaterComposition, newerEvidence])!.forecast_id);
    assert.equal(picked[0]!.forecast_id, newerEvidence.forecast_id);
  });
});

/* ------------------------------------------------------------------------------------------------- D3 / D5 + stability */

describe("D3/D5: the final-pregame signature protects model version and shadow components; time noise does not mint revisions", () => {
  it("D3: a different forecast model version is a different belief (distinct signature and revision id)", () => {
    const f = forecast();
    const g = { ...structuredClone(f), model_version: `${f.model_version}+next` } as unknown as typeof f;
    assert.notEqual(forecastContentSignature(f), forecastContentSignature(g));
  });

  it("D5: a different shadow signal value OR shadow model version is a different belief", () => {
    const sig = (adj: number, v: string): ForecastShadowSignals => ({ role: { mode: "SHADOW", signal: { adjustment_points: adj, model_version: v } as never, reason: "role" } });
    const a = forecastContentSignature(forecast({ shadow: sig(1.1, "role-v1") }));
    assert.notEqual(a, forecastContentSignature(forecast({ shadow: sig(1.4, "role-v1") })), "shadow value");
    assert.notEqual(a, forecastContentSignature(forecast({ shadow: sig(1.1, "role-v2") })), "shadow version");
    const env = (v: string): ForecastShadowSignals => ({ environment: { mode: "SHADOW", signal: { adjustment_points: 0.5, model_version: v } as never } });
    assert.notEqual(forecastContentSignature(forecast({ shadow: env("ge-1") })), forecastContentSignature(forecast({ shadow: env("ge-2") })), "environment shadow version");
  });

  it("the game the belief is about is part of it: same numbers against a different opponent are a different belief", () => {
    assert.notEqual(forecastContentSignature(forecast({ opponent: "LV" })), forecastContentSignature(forecast({ opponent: "DEN" })));
  });

  it("the same belief composed at a different moment — including after the source turned STALE — has the SAME signature (no false revision)", () => {
    const fresh = forecast({ observedMin: -30, composedMin: -25 });
    const stale = forecast({ observedMin: -30, composedMin: -1 }); // same observation, composed later: the age now exceeds the near-kickoff tier
    assert.equal(stale.freshness.state, "STALE", "precondition: the later composition sees a STALE source");
    assert.notEqual(stale.certification.state, fresh.certification.state, "precondition: certification was downgraded by freshness");
    assert.equal(forecastContentSignature(stale), forecastContentSignature(fresh));
  });
});

/* ------------------------------------------------------------------------------------------------------------- L3 */

describe("L3: a K/DST with no source stats is UNKNOWN, never a known zero (a genuine pts_std 0 IS a known zero)", () => {
  it("through the real Sleeper weekly provider", async () => {
    const original = globalThis.fetch;
    clearProjectionFeedCache();
    __resetOfferedObservationsForTests();
    const kRow = (id: string, stats: Record<string, unknown>) => ({ player_id: id, team: "KC", opponent: "LV", season: "2026", season_type: "regular", week: 5, category: "proj", company: "rotowire", stats, player: { first_name: "K", last_name: id, position: "K", team: "KC", injury_status: null, fantasy_positions: ["K"], metadata: null } });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const pos = new URL(String(input)).searchParams.getAll("position[]");
      const rows = pos.includes("K") ? [kRow("k-empty", { gp: 1 }), kRow("k-nullstd", { gp: 1, pts_std: null }), kRow("k-zero", { gp: 1, pts_std: 0 })] : [];
      return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const b = await new SleeperWeeklyProjectionProvider().getWeeklyProjections({ league: { league_slug: "L1", season: 2026, raw_scoring: {}, scoring_rules: [] }, week: 5, crosswalk: new PlayerCrosswalk(NoCrosswalk), canonical_player_ids: [], want_rest_of_season: false });
      const byId = new Map([...b.by_player.values()].map((r) => [String(r.canonical_player_id).split(":").pop()!, r]));
      assert.equal(byId.get("k-empty")?.projected_points ?? null, null, "no stats -> unknown");
      assert.equal(byId.get("k-nullstd")?.projected_points ?? null, null, "null pts_std -> unknown");
      assert.equal(byId.get("k-zero")?.projected_points, 0, "a genuine source 0 is a known 0");
    } finally {
      globalThis.fetch = original;
      clearProjectionFeedCache();
    }
  });
});
