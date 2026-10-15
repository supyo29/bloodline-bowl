/**
 * W1.P2 decision-level regressions: the lineup optimizer consumes the canonical injury-aware expected value; matchup null
 * semantics (F2); drop safety; roster-health single-truth seam (F5).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildLineup } from "../lib/weekly/intelligence";
import { buildMatchup, drawSpec } from "../lib/weekly/matchup";
import { buildWaiverRecommendations } from "../lib/weekly/waivers";
import { buildOptimalLineup } from "../lib/weekly/lineup";
import { buildCanonicalForecastBatch } from "../lib/weekly/forecast";
import { decisionProjectionRows } from "../lib/weekly/forecast/view";
import { buildRosterHealthInputs } from "../lib/roster-health/inputs";
import type { InjuryEvidence } from "../lib/weekly/forecast";
import type { RosterConstraints, WeeklyTeamContext } from "../lib/weekly/schema";
import { STD_CONSTRAINTS, player, proj, roster, weeklyContext } from "./fixtures/weekly";
import { buildGoldenContext, buildGoldenSnapshot, goldenProjectionProvider, goldenSchedule } from "./fixtures/canonical-forecast-golden";

const ONE_WR: RosterConstraints = {
  starting_slots: ["WR"], slot_requirements: { WR: 1 }, bench_slots: 3, ir_slots: 0, taxi_slots: 0, roster_size_limit: null,
  active_roster_capacity: 4, reserve_ir_capacity: 0, taxi_capacity: 0, flex_positions: [], flex_slots: 0,
};

/** Two-WR decision: `a` (possibly injured) vs `b` (healthy), one WR slot. Returns the starter under legacy and canonical values. */
function decide(
  a: { pts: number; status?: string | null; avail?: number },
  b: { pts: number },
  evidence?: Partial<InjuryEvidence>,
): { legacy: string | null; canonical: string | null; ctx: WeeklyTeamContext } {
  const A = player("A", "WR", { injury: a.status ?? null });
  const B = player("B", "WR");
  const base = weeklyContext({
    constraints: ONE_WR,
    myRoster: roster("team:test-league:1", ["A"], ["B"], { startingSlots: ["WR"] }),
    players: [A, B],
    projections: [
      proj("A", "WR", a.pts, { injury_status: a.status ?? null, expected_availability: a.avail ?? 1 }),
      proj("B", "WR", b.pts),
    ],
  });
  const forecasts = buildCanonicalForecastBatch({
    batch: base.projections,
    requested_player_ids: base.roster.all_players,
    injury_evidence: evidence ? new Map([["A", evidence]]) : undefined,
  });
  const starter = (c: WeeklyTeamContext) => buildLineup(c).slots[0]?.recommended_player_id ?? null;
  const ctx = { ...base, forecasts };
  return { legacy: starter({ ...base, forecasts: undefined }), canonical: starter(ctx), ctx };
}

describe("W1.P2 start/sit decisions use canonical injury-aware expected value", () => {
  it("Case A: questionable A (source 15) vs healthy B (14): legacy starts A, injury-aware starts B", () => {
    const r = decide({ pts: 15, status: "Questionable", avail: 0.78 }, { pts: 14 });
    assert.equal(r.legacy, "A", "the W1.P1 behavior this phase exists to fix");
    assert.equal(r.canonical, "B");
  });

  it("Case B: questionable STAR (22) vs healthy B (14): still starts A — not every questionable player is benched", () => {
    const r = decide({ pts: 22, status: "Questionable", avail: 0.78 }, { pts: 14 });
    assert.equal(r.legacy, "A");
    assert.equal(r.canonical, "A");
    assert.ok(buildCanonicalForecastBatch({ batch: r.ctx.projections }).by_player.get("A")!.projection.expected_points! > 14);
  });

  it("Case C: star ruled OUT after an earlier projection cannot remain the preferred starter", () => {
    const r = decide({ pts: 22, status: "Out", avail: 0.03 }, { pts: 5 });
    assert.equal(r.legacy, "A", "legacy still prefers the stale 22");
    assert.equal(r.canonical, "B");
    // an official inactive overrides even a stale Questionable designation
    const off = decide({ pts: 22, status: "Questionable", avail: 0.78 }, { pts: 5 }, { official_inactive: true });
    assert.equal(off.canonical, "B");
  });

  it("Case D: questionable player later cleared as officially active carries NO stale penalty", () => {
    const stillQ = decide({ pts: 15, status: "Questionable", avail: 0.78 }, { pts: 14 });
    assert.equal(stillQ.canonical, "B");
    const cleared = decide({ pts: 15, status: "Questionable", avail: 0.78 }, { pts: 14 }, { official_active: true });
    assert.equal(cleared.canonical, "A");
  });

  it("doubtful star vs healthy replacement: replacement starts", () => {
    const r = decide({ pts: 20, status: "Doubtful", avail: 0.3 }, { pts: 6 });
    assert.equal(r.legacy, "A");
    assert.equal(r.canonical, "B");
  });

  it("limited-workload return: explicit workload evidence can flip a close call; without it, no invented discount", () => {
    const noEvidence = decide({ pts: 15, status: null }, { pts: 12 });
    assert.equal(noEvidence.canonical, "A");
    const limited = decide({ pts: 15, status: null }, { pts: 12 }, { returning_from_injury: true, expected_workload: { fraction: 0.7, reason: "snap count restriction" } });
    assert.equal(limited.canonical, "B");
  });

  it("unknown injury semantics / unrecognised status: no invented discount, the source value decides", () => {
    const r = decide({ pts: 15, status: "COV" }, { pts: 14 });
    assert.equal(r.canonical, "A");
  });

  it("healthy vs healthy is unchanged (identical numbers, identical decision)", () => {
    const r = decide({ pts: 13 }, { pts: 14 });
    assert.equal(r.legacy, r.canonical);
    assert.equal(r.canonical, "B");
  });

  it("reported lineup numbers are the injury-aware expected values; the legacy ctx.projections row is untouched", () => {
    const r = decide({ pts: 22, status: "Questionable", avail: 0.78 }, { pts: 14 });
    const lu = buildLineup(r.ctx);
    const slot = lu.slots[0]!;
    const fa = r.ctx.forecasts!.by_player.get("A")!;
    assert.equal(slot.recommended_projected, fa.projection.expected_points);
    assert.ok(slot.recommended_projected! < 22);
    assert.equal(r.ctx.projections.by_player.get("A")!.projected_points, 22, "source row not mutated");
  });

  it("the optimizer without forecasts is exactly the legacy optimizer (non-migrated callers unchanged)", () => {
    const r = decide({ pts: 15, status: "Questionable", avail: 0.78 }, { pts: 14 });
    const players = new Map(r.ctx.all_rostered.map((p) => [p.canonical_player_id, p]));
    const a = buildOptimalLineup({ week: 1, roster: r.ctx.roster, constraints: ONE_WR, players, projections: r.ctx.projections });
    const b = buildOptimalLineup({ week: 1, roster: r.ctx.roster, constraints: ONE_WR, players, projections: r.ctx.projections, forecasts: null });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(a.slots[0]!.recommended_player_id, "A");
  });

  it("a rostered Out player the feed omitted is a KNOWN zero in the decision view (no provisional hole)", () => {
    const A = player("A", "WR", { injury: "Out" });
    const B = player("B", "WR");
    const base = weeklyContext({
      constraints: ONE_WR,
      myRoster: roster("team:test-league:1", ["A"], ["B"], { startingSlots: ["WR"] }),
      players: [A, B],
      projections: [proj("B", "WR", 9)],
    });
    const forecasts = buildCanonicalForecastBatch({ batch: base.projections, requested_player_ids: base.roster.all_players, players: new Map(base.all_rostered.map((p) => [p.canonical_player_id, p])) });
    assert.equal(forecasts.by_player.get("A")!.value_state, "KNOWN_UNAVAILABLE");
    const view = decisionProjectionRows(base.projections, forecasts).rows;
    assert.equal(view.get("A")!.projected_points, 0);
    assert.equal(buildLineup({ ...base, forecasts }).slots[0]!.recommended_player_id, "B");
  });
});

describe("W1.P2 matchup: injury-aware values flow through, attributably; null never becomes 0 (F2)", () => {
  function matchupPair(withForecasts: boolean) {
    const mine = player("A", "WR", { injury: "Questionable" });
    const opp = player("O", "WR");
    const base = weeklyContext({
      constraints: ONE_WR,
      myRoster: roster("team:test-league:1", ["A"], [], { startingSlots: ["WR"] }),
      oppRoster: roster("team:test-league:2", ["O"], [], { startingSlots: ["WR"] }),
      players: [mine, opp],
      projections: [proj("A", "WR", 20, { injury_status: "Questionable", expected_availability: 0.78 }), proj("O", "WR", 18)],
    });
    const forecasts = buildCanonicalForecastBatch({ batch: base.projections, requested_player_ids: ["A", "O"] });
    const withF = { ...base, opponent: base.opponent && { ...base.opponent, roster: base.opponent.roster }, forecasts };
    return { legacy: buildMatchup({ ...base, forecasts: undefined }), canonical: buildMatchup(withForecasts ? withF : base), forecasts };
  }

  it("margin and win probability reflect the injury-aware value (legacy favors A, canonical does not)", () => {
    const { legacy, canonical, forecasts } = matchupPair(true);
    assert.ok(legacy.projected_margin! > 0, "legacy: 20 vs 18");
    assert.ok(canonical.projected_margin! < legacy.projected_margin!);
    assert.equal(canonical.team_optimal_total, forecasts.by_player.get("A")!.projection.expected_points, "attributable to the canonical expected_points");
    if (legacy.win_probability != null && canonical.win_probability != null) assert.ok(canonical.win_probability < legacy.win_probability);
    assert.equal(canonical.opponent_optimal_total, 18, "healthy opponent unchanged");
  });

  it("drawSpec excludes an UNKNOWN (null) starter instead of simulating it as 0, and keeps a verified bye as a legitimate 0", () => {
    const lineup = {
      slots: [
        { slot: "WR", recommended_player_id: "known" },
        { slot: "WR", recommended_player_id: "unknown" },
        { slot: "WR", recommended_player_id: "bye" },
        { slot: "WR", recommended_player_id: "absent" },
        { slot: "WR", recommended_player_id: null },
      ],
    } as unknown as Parameters<typeof drawSpec>[0];
    const rows = new Map([
      ["known", proj("known", "WR", 10)],
      ["unknown", proj("unknown", "WR", null)],
      ["bye", proj("bye", "WR", 0, { projection_status: "bye", is_bye: true })],
    ]);
    const d = drawSpec(lineup, rows);
    assert.deepEqual(d.unknown, ["unknown", "absent"]);
    assert.equal(d.draws.length, 2);
    assert.equal(d.draws[1]!.mean, 0, "verified bye is a real zero");
    assert.ok(!d.draws.some((x) => x.mean === 0 && x.sd === 2), "no unknown was fabricated as a (0, heuristic-sd) draw");
  });
});

describe("W1.P2 drop safety: weekly injury value is NOT permanent player worth", () => {
  it("waiver/drop output is identical with and without canonical forecasts (it reads the SOURCE basis)", () => {
    const star = player("star", "WR", { injury: "Out", name: "Injured Star" });
    const filler = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"].map((id) => player(id, "WR", { name: id }));
    const me = [player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"), star, player("te1", "TE"), player("k1", "K"), player("def1", "DEF"), ...filler];
    const myRoster = roster("team:test-league:1", ["qb1", "rb1", "rb2", "wr1", "star", "te1", "f1", "k1", "def1"], ["f2", "f3", "f4", "f5", "f6", "f7"]); // 15 rostered: at the size limit, so a real drop is required
    const fa = player("faWR", "WR", { name: "Free Agent WR" });
    const base = weeklyContext({
      myRoster,
      players: me,
      freeAgents: [fa],
      projections: [
        proj("qb1", "QB", 20), proj("rb1", "RB", 16), proj("rb2", "RB", 12), proj("wr1", "WR", 15),
        proj("star", "WR", 24, { injury_status: "Out", expected_availability: 0.03, rest_of_season_points: 40 }),
        proj("te1", "TE", 10), proj("k1", "K", 8), proj("def1", "DEF", 7),
        ...filler.map((p) => proj(p.canonical_player_id, "WR", 6, { rest_of_season_points: 70 })),
      ],
      faProjections: [proj("faWR", "WR", 11, { rest_of_season_points: 120 })],
    });
    const forecasts = buildCanonicalForecastBatch({ batch: base.projections, requested_player_ids: base.roster.all_players });
    assert.equal(forecasts.by_player.get("star")!.projection.expected_points, 0, "this week the injured star is worth 0");
    const withF = buildWaiverRecommendations({ ...base, forecasts });
    const without = buildWaiverRecommendations({ ...base, forecasts: undefined });
    assert.equal(JSON.stringify(withF), JSON.stringify(without), "waiver engine must not consume the weekly injury-adjusted value");
    // non-vacuous: the engine produced a real add/drop pair, and the injured star (worth 0 THIS WEEK, 24 on source) is never the drop
    const recs = (withF as unknown as { recommendations: Array<{ add_player_id: string; drop_player_id: string | null }> }).recommendations;
    assert.ok(recs.length >= 1, "waiver engine must have produced output for this test to mean anything");
    assert.ok(recs.every((r) => r.drop_player_id != null), "roster is full, so every recommendation exercises a real drop choice");
    assert.ok(recs.every((r) => r.drop_player_id !== "star"), "injured star must not become the best drop");
  });
});

describe("W1.P2 roster-health F5: one weekly forecast truth per context", () => {
  it("projectionsOverride makes NO provider read and reuses the context batch + forecasts", async () => {
    const ctx = await buildGoldenContext();
    const snapshot = await buildGoldenSnapshot();
    let providerCalls = 0;
    const throwing = {
      name: "should-not-be-called",
      model_version: "x",
      getWeeklyProjections: async () => {
        providerCalls += 1;
        throw new Error("second provider read");
      },
    };
    const inputs = await buildRosterHealthInputs("bloodline-bowl", {
      snapshotOverride: snapshot,
      projectionProviderOverride: throwing,
      projectionsOverride: { batch: ctx.projections, forecasts: ctx.forecasts },
      scheduleProviderOverride: goldenSchedule,
      skipRi: true,
    });
    assert.equal(providerCalls, 0);
    assert.equal(inputs.projection_source, "SHARED_CONTEXT");
    assert.equal(inputs.weekly, ctx.projections, "the very same batch object");
    assert.equal(inputs.forecasts, ctx.forecasts, "the very same forecast batch");
    assert.ok(inputs.warnings.some((w) => /shared from an assembled context/.test(w)));
  });

  it("without an override roster-health still reads the provider once, and attaches canonical forecasts from that same batch", async () => {
    const snapshot = await buildGoldenSnapshot();
    let calls = 0;
    const inner = goldenProjectionProvider();
    const counting = { ...inner, getWeeklyProjections: async (req: Parameters<typeof inner.getWeeklyProjections>[0]) => { calls += 1; return inner.getWeeklyProjections(req); } };
    const inputs = await buildRosterHealthInputs("bloodline-bowl", { snapshotOverride: snapshot, projectionProviderOverride: counting, scheduleProviderOverride: goldenSchedule, skipRi: true });
    assert.equal(calls, 1);
    assert.equal(inputs.projection_source, "PROVIDER_READ");
    assert.ok(inputs.forecasts && inputs.forecasts.by_player.size > 0);
    // roster-health values stay on the SOURCE basis (documented): its weekly batch is not injury-adjusted
    assert.equal(inputs.weekly.by_player.get("g-rb-q")!.projected_points, 14.6);
    assert.equal(inputs.forecasts!.by_player.get("g-rb-q")!.projection.source_points, 14.6);
    assert.ok(inputs.forecasts!.by_player.get("g-rb-q")!.projection.expected_points! < 14.6);
  });
});

describe("W1.P2 context integration", () => {
  it("context lineup uses the injury-aware value: golden questionable RB is valued below its source in the lineup", async () => {
    const ctx = await buildGoldenContext();
    const lu = buildLineup(ctx);
    const slots = lu.slots.filter((s) => s.recommended_player_id === "g-rb-q");
    for (const s of slots) assert.equal(s.recommended_projected, ctx.forecasts!.by_player.get("g-rb-q")!.projection.expected_points);
    assert.equal(ctx.projections.by_player.get("g-rb-q")!.projected_points, 14.6);
  });

  it("STD constraints still produce a legal lineup with forecasts present (smoke)", async () => {
    const ctx = await buildGoldenContext();
    const lu = buildLineup(ctx);
    assert.equal(lu.slots.length, STD_CONSTRAINTS.starting_slots.length);
  });
});
