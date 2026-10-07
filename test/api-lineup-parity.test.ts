/**
 * W1.R1 / P1-2: every headline lineup surface consumes the canonical injury-aware decision value.
 * Audit finding: `/api/lineup` built its own optimizer input without `forecasts`, so it served source-basis values while
 * `/api/intelligence` served injury-aware `expected_points`. The rule: same league + manager + week + evidence -> same lineup.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildOptimalLineup } from "../lib/weekly/lineup";
import { buildLineup, buildWeeklyIntelligence, lineupEndpointView, runWithWeeklyContext } from "../lib/weekly/intelligence";
import { buildCanonicalForecastBatch } from "../lib/weekly/forecast";
import { setPersistence, memoryPersistence } from "../lib/persistence";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import type { RosterConstraints, WeeklyTeamContext } from "../lib/weekly/schema";
import { goldenProjectionProvider, goldenProvider, goldenSchedule } from "./fixtures/canonical-forecast-golden";
import { player, proj, roster, weeklyContext } from "./fixtures/weekly";

const ROOT = join(__dirname, "..");
const ONE_WR: RosterConstraints = {
  starting_slots: ["WR"], slot_requirements: { WR: 1 }, bench_slots: 3, ir_slots: 0, taxi_slots: 0, roster_size_limit: null,
  active_roster_capacity: 4, reserve_ir_capacity: 0, taxi_capacity: 0, flex_positions: [], flex_slots: 0,
};

function ctxFor(a: { pts: number; status: string | null; avail?: number }, b: { pts: number }): WeeklyTeamContext {
  const base = weeklyContext({
    constraints: ONE_WR,
    myRoster: roster("team:test-league:1", ["A"], ["B"], { startingSlots: ["WR"] }),
    players: [player("A", "WR", { injury: a.status }), player("B", "WR")],
    projections: [proj("A", "WR", a.pts, { injury_status: a.status, expected_availability: a.avail ?? 1 }), proj("B", "WR", b.pts)],
  });
  return { ...base, forecasts: buildCanonicalForecastBatch({ batch: base.projections, requested_player_ids: base.roster.all_players }) };
}
const legacyStarter = (ctx: WeeklyTeamContext) =>
  buildOptimalLineup({
    week: ctx.league.week, roster: ctx.roster, constraints: ctx.league.roster_constraints,
    players: new Map(ctx.all_rostered.map((p) => [p.canonical_player_id, p])), projections: ctx.projections,
  }).slots[0]?.recommended_player_id;
const endpointStarter = (ctx: WeeklyTeamContext) => lineupEndpointView(ctx).lineup.slots[0]?.recommended_player_id;
const intelligenceStarter = (ctx: WeeklyTeamContext) => buildLineup(ctx).slots[0]?.recommended_player_id;

describe("W1.R1 P1-2: /api/lineup and /api/intelligence share one lineup decision", () => {
  it("Questionable player with the higher SOURCE projection: both pick the healthy alternative (source basis would pick the questionable one)", () => {
    const ctx = ctxFor({ pts: 15, status: "Questionable", avail: 0.78 }, { pts: 14 });
    assert.equal(legacyStarter(ctx), "A", "the source-basis answer the bypassed route used to serve");
    assert.equal(endpointStarter(ctx), "B");
    assert.equal(intelligenceStarter(ctx), "B");
  });

  it("Questionable STAR: both still start him", () => {
    const ctx = ctxFor({ pts: 22, status: "Questionable", avail: 0.78 }, { pts: 14 });
    assert.equal(endpointStarter(ctx), "A");
    assert.equal(intelligenceStarter(ctx), "A");
  });

  it("OUT player with a stale high source projection: both bench him", () => {
    const ctx = ctxFor({ pts: 22, status: "Out", avail: 0.03 }, { pts: 5 });
    assert.equal(legacyStarter(ctx), "A", "stale source still prefers him");
    assert.equal(endpointStarter(ctx), "B");
    assert.equal(intelligenceStarter(ctx), "B");
  });

  it("healthy roster: identical to legacy behavior on both surfaces", () => {
    const ctx = ctxFor({ pts: 15, status: null }, { pts: 12 });
    assert.equal(legacyStarter(ctx), "A");
    assert.equal(endpointStarter(ctx), "A");
    assert.equal(intelligenceStarter(ctx), "A");
  });

  it("close calls explain the SAME decision as the lineup (no source-basis explanation beside an injury-aware lineup)", () => {
    const ctx = ctxFor({ pts: 15, status: "Questionable", avail: 0.78 }, { pts: 14 });
    const view = lineupEndpointView(ctx);
    assert.equal(view.lineup.slots[0]?.recommended_player_id, "B");
    assert.ok(view.start_sit.length >= 1, "the scenario must actually produce a close call (otherwise this assertion is vacuous)");
    for (const call of view.start_sit) {
      assert.equal(call.start_player_id, "B", `close call must agree with the lineup: ${call.start_player_id} over ${call.over_player_id}`);
      assert.equal(call.over_player_id, "A");
    }
  });

  it("the full real context path (golden league through buildWeeklyTeamContext): route view == intelligence lineup, and it differs from the source basis", async () => {
    setPersistence(memoryPersistence());
    const opts = () => ({
      week: 5, providerOverride: goldenProvider(), projectionProviderOverride: goldenProjectionProvider(), scheduleProviderOverride: goldenSchedule,
      riSeasonProviderOverride: null, crosswalkOverride: new PlayerCrosswalk(NoCrosswalk), skipReturnGameEnrichment: true,
    }) as never;
    const route = await runWithWeeklyContext("bloodline-bowl", "supyo29", opts(), lineupEndpointView);
    const intel = await buildWeeklyIntelligence("bloodline-bowl", "supyo29", opts());
    const slots = (l?: { slots: Array<{ slot: string; recommended_player_id: string | null }> }) => (l?.slots ?? []).map((s) => `${s.slot}:${s.recommended_player_id}`);
    const r = slots(route.data?.lineup);
    const i = slots(intel.intelligence?.lineup);
    assert.ok(r.length > 0);
    assert.deepEqual(r, i);
    // one analysis, one evidence set: both endpoints rest on the SAME forecast-set identity
    assert.ok(route.data?.forecast_set_identity, "the golden context carries a forecast-set identity");
    assert.equal(route.data?.forecast_set_identity, intel.intelligence?.lineage.engine_versions.projection_forecast_identity ?? null);
    assert.ok(!r.some((x) => /g-wr-out|g-rb-ir/.test(x)), "an Out / IR player is not started by either surface");
    let legacy: string[] = [];
    await runWithWeeklyContext("bloodline-bowl", "supyo29", opts(), (ctx) => {
      legacy = buildOptimalLineup({
        week: ctx.league.week, roster: ctx.roster, constraints: ctx.league.roster_constraints,
        players: new Map(ctx.all_rostered.map((p) => [p.canonical_player_id, p])), projections: ctx.projections,
      }).slots.map((s) => `${s.slot}:${s.recommended_player_id}`);
    });
    assert.notDeepEqual(r, legacy, "the scenario must be one where the source basis would have answered differently");
  });

  it("the REAL route handler (GET) agrees with /api/intelligence (child process: module mock supplies the golden providers)", () => {
    const res = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "scripts/w1r1-repros/p1-2-lineup-route-parity.ts"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
    const line = res.stdout.split("\n").find((l) => l.startsWith('{"p1":"P1-2"'));
    assert.ok(line, `repro script produced no result:\n${res.stderr.slice(-600)}`);
    const out = JSON.parse(line!) as { route_status: number; endpoints_agree: boolean; route_starts_OUT_or_IR_player: boolean };
    assert.equal(out.route_status, 200);
    assert.equal(out.endpoints_agree, true);
    assert.equal(out.route_starts_OUT_or_IR_player, false);
  });

  it("wiring: the route passes the shared view function and builds no optimizer input of its own", () => {
    const src = readFileSync(join(ROOT, "app/api/lineup/[league]/[manager]/week/[week]/route.ts"), "utf8");
    assert.match(src, /runWithWeeklyContext\([^)]*lineupEndpointView\)/);
    assert.doesNotMatch(src, /buildOptimalLineup|ctx\.projections/);
  });
});
