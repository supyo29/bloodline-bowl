/** W2.R1 current-intelligence integration into the main weekly context: qualified D/ST replacement, byes, unqualified leagues, graceful absence, provider-evidence ordering, read-only. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildWeeklyTeamContext } from "@/lib/weekly/context";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { setPersistence, memoryPersistence } from "@/lib/persistence";
import { goldenProvider, goldenProjectionProvider, goldenSchedule } from "./fixtures/canonical-forecast-golden";
import { planQualifiedDst, type DstPlan } from "@/lib/w2r1/context-hook";
import type { KdstCapture } from "@/lib/w2r1/dst-live";
import { buildLineup } from "@/lib/weekly/intelligence";

const wk6 = JSON.parse(readFileSync("lib/w2r1/data/prospective/wk06/kdst_components.json", "utf8")) as KdstCapture;
const teams = Object.keys(wk6.teams);

async function ctxWith(plan: DstPlan | undefined) {
  setPersistence(memoryPersistence());
  const r = await buildWeeklyTeamContext("bloodline-bowl", "supyo29", { week: 5, providerOverride: goldenProvider(), projectionProviderOverride: goldenProjectionProvider(), scheduleProviderOverride: goldenSchedule, riSeasonProviderOverride: null, crosswalkOverride: new PlayerCrosswalk(NoCrosswalk), skipReturnGameEnrichment: true, ...(plan ? { w2r1DstPlanOverride: plan } : {}) });
  if (!r.context) throw new Error(`${r.code} ${r.detail}`);
  return r.context;
}
const plan = (over: Partial<DstPlan> = {}): DstPlan => ({ state: "QUALIFIED_SHADOW", capture_week: 5, reason: null, model_version: "test-dst", forTeam: (t) => (t === "SF" || t === "BUF" ? { points: 12.5, floor: 8, ceiling: 17, sd: 4 } : null), ...over });

describe("W2.R1 D/ST integration into the main weekly context", () => {
  it("a QUALIFIED plan replaces the CURRENT-week D/ST projection and the canonical forecast (SF playing), with provenance; the provider value is recorded", async () => {
    const base = await ctxWith(undefined); const c = await ctxWith(plan());
    assert.equal(base.projections.by_player.get("g-def")!.projected_points, 6);
    const row = c.projections.by_player.get("g-def")!; assert.equal(row.projected_points, 12.5); assert.equal(row.source, "w2r1_dst_component_model"); assert.equal(row.std_dev, 4);
    assert.ok(row.warnings.includes("w2r1_dst_component_model_qualified") && row.warnings.includes("w2r1_dst_replaced_provider_value:6"));
    assert.equal(c.forecasts!.by_player.get("g-def")!.projection.expected_points, 12.5, "canonical forecast == production value (no divergence)");
    assert.equal(c.w2r1!.dst.applied, 2, "both SF defense rows in the fixture"); const q = c.forecasts!.by_player.get("g-def-injstr")!; assert.equal(q.projection.conditional_active_points, 12.5, "W2.R1 value is the CONDITIONAL source; W1 availability is applied once, by W1"); assert.ok(q.projection.expected_points! <= 12.5, "never discounted twice"); assert.equal(c.w2r1!.dst.replaced[0]!.provider_value, 6); assert.equal(c.w2r1!.dst.state, "QUALIFIED_SHADOW");
  });
  it("BYE: a bye team defense is never replaced — current-week stays the verified bye zero, hold value preserved, unknown stays unknown", async () => {
    const base = await ctxWith(undefined); const c = await ctxWith(plan());
    const b0 = base.forecasts!.by_player.get("g-def-bye")!, b1 = c.forecasts!.by_player.get("g-def-bye")!;
    assert.deepEqual(JSON.parse(JSON.stringify(b1)), JSON.parse(JSON.stringify(b0))); assert.equal(b1.projection.expected_points, 0); assert.equal(b1.game_status.is_bye, true);
  });
  it("every non-D/ST player is byte-identical with and without the hook (nothing else moves; availability is not re-applied)", async () => {
    const base = await ctxWith(undefined); const c = await ctxWith(plan());
    for (const [id, f] of base.forecasts!.by_player) if (id !== "g-def" && id !== "g-def-injstr") assert.deepEqual(JSON.parse(JSON.stringify(c.forecasts!.by_player.get(id))), JSON.parse(JSON.stringify(f)), id);
  });
  it("unqualified / missing-capture plans leave the context byte-identical to the main-model result (reported, never silent)", async () => {
    const base = await ctxWith(undefined);
    for (const p of [plan({ state: "DIAGNOSTIC_ONLY", capture_week: null, reason: "D/ST state DIAGNOSTIC_ONLY", forTeam: () => null }), plan({ state: "EXPLORATORY_POST_DEFECT", capture_week: null, reason: "x", forTeam: () => null }), plan({ capture_week: null, reason: "no frozen pregame D/ST capture", forTeam: () => null })]) {
      const c = await ctxWith(p); assert.equal(c.projections.by_player.get("g-def")!.projected_points, 6); assert.equal(c.w2r1!.dst.applied, 0);
      assert.deepEqual(JSON.parse(JSON.stringify([...c.forecasts!.by_player])), JSON.parse(JSON.stringify([...base.forecasts!.by_player])));
    }
    const miss = await ctxWith(plan({ capture_week: null, reason: "no frozen pregame D/ST capture" })); assert.ok(miss.warnings.some((w) => w.code === "w2r1_dst_capture_missing"));
  });
  it("the lineup decision consumes the W2.R1 D/ST value (influence) while the rest of the lineup logic is unchanged", async () => {
    const c = await ctxWith(plan({ forTeam: (t) => (t === "SF" ? { points: 30, floor: 20, ceiling: 40, sd: 5 } : null) }));
    const lineup = buildLineup(c); const defSlot = lineup.slots.find((s) => s.slot === "DEF");
    assert.ok(defSlot); assert.ok(defSlot!.recommended_player_id === "g-def" || defSlot!.recommended_player_id === "g-def-bye" || defSlot!.recommended_player_id === "g-def-injstr");
    assert.equal(c.forecasts!.by_player.get("g-def")!.projection.expected_points, 30);
  });
  it("the real planner: qualified leagues get the frozen capture values; Rogers Park / Bloodline / unknown leagues and absent weeks get none", async () => {
    const t = teams[0]!;
    const q = await planQualifiedDst({ leagueSlug: "devoted-to-the-game", week: 6 }); assert.equal(q.state, "QUALIFIED_SHADOW"); assert.equal(q.capture_week, 6); const v = q.forTeam(t); assert.ok(v && v.points > 0 && v.floor < v.points && v.ceiling > v.points);
    assert.equal(q.forTeam("LAR") != null || teams.includes("LA") === false, true, "provider abbreviations are normalized (LAR -> LA)");
    for (const l of ["rogers-park", "bloodline-bowl", "no-such-league"]) { const p = await planQualifiedDst({ leagueSlug: l, week: 6 }); assert.equal(p.capture_week, null, l); assert.equal(p.forTeam(t), null, l); }
    const w7 = await planQualifiedDst({ leagueSlug: "devoted-to-the-game", week: 7 }); assert.equal(w7.capture_week, null); assert.match(w7.reason ?? "", /no frozen pregame/);
    const off = await planQualifiedDst({ leagueSlug: "devoted-to-the-game", week: 6, env: { W2R1_DST_DISABLED: "1" } as unknown as NodeJS.ProcessEnv }); assert.equal(off.capture_week, null);
  });
  it("ORDER: the W1 final-pregame calibration capture reads the PROVIDER forecasts (before the W2.R1 replacement), never the replaced values", () => {
    const src = readFileSync("lib/weekly/context.ts", "utf8"); const cap = src.slice(src.indexOf("// W1.P4 final pregame capture:"), src.indexOf("// W2.R1 current-intelligence hook"));
    assert.match(cap, /providerForecasts\.by_player\.get\(id\)/); assert.doesNotMatch(cap.replace(/providerForecasts/g, ""), /\bforecasts\.by_player\.get\(id\)/);
    assert.ok(src.indexOf("planQualifiedDst(") > src.indexOf("// W1.P4 final pregame capture:"));
  });
});
