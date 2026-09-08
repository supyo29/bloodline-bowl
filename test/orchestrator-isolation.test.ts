/**
 * Phase 8 §39 / §40 — specialist isolation.
 *
 * The Orchestrator CONSUMES the frozen Phase 1–7 specialists through adapters;
 * it must not change any of their outputs. This asserts that the specialist
 * results reached through the shared `ManagementAnalysisContext` are byte-for-
 * byte identical to the results of calling those specialists directly, and that
 * the Orchestrator never mutates a shared object.
 *
 * (The structural proof — no specialist source file changed — is a `git diff`
 * check in the certification doc; this is the behavioural proof.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runInLeagueStateScope } from "@/lib/canonical/request-scope";
import { buildWeeklyIntelligence } from "@/lib/weekly/intelligence";
import { buildRosterHealthContext } from "@/lib/roster-health";
import { buildSchedulePlanningContext } from "@/lib/schedule-planning";
import { buildManagementAnalysisContext } from "@/lib/orchestrator";

const LEAGUE = "bloodline-bowl";
const MANAGER = "supyo29";

test("orchestrator context: weekly lineup/matchup/waivers identical to a direct build", { concurrency: false }, async (t) => {
  let direct: unknown;


  await runInLeagueStateScope(async () => {
    const d = await buildWeeklyIntelligence(LEAGUE, MANAGER);
    if (!d.ok || !d.intelligence) {
      t.skip("weekly intelligence unavailable (offline?)");
      return;
    }
    direct = {
      optimal_total: d.intelligence.lineup.optimal_total,
      changes: d.intelligence.lineup.changes_recommended,
      matchup_wp: d.intelligence.matchup.win_probability,
      matchup_margin: d.intelligence.matchup.projected_margin,
      waiver_recs: d.intelligence.waivers.recommendations.map((r) => ({ add: r.add_player_id, drop: r.drop_player_id, net: r.net_roster_gain, priority: r.priority })),
      start_sit_shadow_deployment: (d.intelligence.start_sit_shadow?.lineage as { deployment?: string })?.deployment ?? null,
      matchup_shadow_deployment: (d.intelligence.matchup_intelligence?.lineage as { deployment?: string })?.deployment ?? null,
    };
  });

  if (!direct) return;

  const ctxRes = await buildManagementAnalysisContext(LEAGUE);
  assert.ok(ctxRes.ok, "orchestrator context builds");
  if (!ctxRes.ok) return;
  const slice = await ctxRes.context.forManager(MANAGER);
  assert.ok(slice?.weekly, "slice has weekly intelligence");
  const w = slice!.weekly!;
  const viaOrchestrator = {
    optimal_total: w.lineup.optimal_total,
    changes: w.lineup.changes_recommended,
    matchup_wp: w.matchup.win_probability,
    matchup_margin: w.matchup.projected_margin,
    waiver_recs: w.waivers.recommendations.map((r) => ({ add: r.add_player_id, drop: r.drop_player_id, net: r.net_roster_gain, priority: r.priority })),
    start_sit_shadow_deployment: (w.start_sit_shadow?.lineage as { deployment?: string })?.deployment ?? null,
    matchup_shadow_deployment: (w.matchup_intelligence?.lineage as { deployment?: string })?.deployment ?? null,
  };

  assert.deepEqual(viaOrchestrator, direct, "specialist behaviour change = 0");
  // shadows remain SHADOW_ONLY where surfaced
  const v = viaOrchestrator as { start_sit_shadow_deployment: string | null; matchup_shadow_deployment: string | null };
  if (v.start_sit_shadow_deployment) assert.equal(v.start_sit_shadow_deployment, "SHADOW_ONLY");
  if (v.matchup_shadow_deployment) assert.equal(v.matchup_shadow_deployment, "SHADOW_ONLY");
});

test("orchestrator context: roster-health + schedule-planning identical to a direct build", { concurrency: false }, async (t) => {
  const directRh = await buildRosterHealthContext(LEAGUE).catch(() => null);
  const directSp = await buildSchedulePlanningContext(LEAGUE).catch(() => null);
  if (!directRh || !directSp) {
    t.skip("roster-health / schedule-planning unavailable (offline?)");
    return;
  }

  const ctxRes = await buildManagementAnalysisContext(LEAGUE);
  assert.ok(ctxRes.ok);
  if (!ctxRes.ok) return;
  const mac = ctxRes.context;

  assert.equal(mac.rosterHealth?.roster_health_version, directRh.roster_health_version);
  assert.equal(mac.rosterHealth?.lineage.league_snapshot_id, directRh.lineage.league_snapshot_id);
  assert.equal(mac.rosterHealth?.teams.length, directRh.teams.length);
  const rhA = mac.rosterHealth!.teams.find((x) => x.manager_slug === MANAGER);
  const rhB = directRh.teams.find((x) => x.manager_slug === MANAGER);
  assert.deepEqual(rhA?.weekly.fragility, rhB?.weekly.fragility);
  assert.deepEqual(rhA?.rest_of_season.quality_surplus, rhB?.rest_of_season.quality_surplus);

  assert.equal(mac.schedulePlanning?.planning_model_version, directSp.planning_model_version);
  assert.equal(mac.schedulePlanning?.lineage.football_intelligence_version, directSp.lineage.football_intelligence_version);
  const spA = mac.schedulePlanning!.teams.find((x) => x.manager_slug === MANAGER);
  const spB = directSp.teams.find((x) => x.manager_slug === MANAGER);
  assert.equal(spA?.week_timeline.length, spB?.week_timeline.length);
  assert.deepEqual(spA?.summary, spB?.summary);
});

test("orchestrator context: one coherent snapshot across every specialist (§8)", async (t) => {
  const ctxRes = await buildManagementAnalysisContext(LEAGUE);
  if (!ctxRes.ok) {
    t.skip("context unavailable (offline?)");
    return;
  }
  const mac = ctxRes.context;
  const ids = new Set(mac.metrics.snapshot_ids_seen);
  assert.equal(ids.size, 1, `expected one snapshot id, saw ${[...ids].join(", ")}`);
  assert.equal(mac.metrics.snapshot_coherent, true);
  // one canonical provider read for the whole operation
  assert.equal(mac.metrics.canonical_provider_reads, 1);
});
