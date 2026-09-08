/**
 * Phase 6 — Roster Health orchestrator.
 *
 * `buildRosterHealthContext(leagueSlug)` — ONE canonical league-state read,
 * ONE weekly projection batch, ONE RI signal, ONE `buildLeagueManagementContext`
 * (all memoized in a single `runInLeagueStateScope`). Every team's weekly + ROS
 * roster-health is computed in memory. 0 extra provider reads per manager.
 *
 * SHARED_CONTEXT: never mutates a projection, never calls a recommendation
 * engine, never returns a lineup.
 */

import { runInLeagueStateScope } from "@/lib/canonical/request-scope";
import { buildLeagueManagementContext } from "@/lib/team-state/build";
import { buildRosterHealthInputs, type RosterHealthInputOptions } from "./inputs";
import { evaluateHorizon } from "./evaluate";
import { applyLeagueBenchmarks } from "./benchmark";
import {
  ROSTER_HEALTH_VERSION,
  type RosterHealthLeagueContext,
  type TeamRosterHealth,
  type RosterHealthLineage,
  type RosterHealthDegradation,
} from "./schema";
import { TEAM_STATE_VERSION } from "@/lib/team-state/schema";

export async function buildRosterHealthContext(
  leagueSlug: string,
  options: RosterHealthInputOptions = {},
): Promise<RosterHealthLeagueContext> {
  return runInLeagueStateScope(() => buildInner(leagueSlug, options));
}

async function buildInner(
  leagueSlug: string,
  options: RosterHealthInputOptions,
): Promise<RosterHealthLeagueContext> {
  const inputs = await buildRosterHealthInputs(leagueSlug, options);
  const lmcRes = await buildLeagueManagementContext(leagueSlug, { snapshotOverride: inputs.snapshot });
  if (!lmcRes.ok || !lmcRes.context) {
    throw new Error(`roster-health: Team-State context unavailable (${lmcRes.code ?? "unknown"})`);
  }
  const lmc = lmcRes.context;

  const lineage: RosterHealthLineage = {
    roster_health_model_version: ROSTER_HEALTH_VERSION,
    team_state_version: TEAM_STATE_VERSION,
    replacement_model: { weekly_frontier: "nth_best_available(n=1)", ros_basis: "position_rank_theoretical" },
    projection_lineage: {
      weekly: { model_version: inputs.weekly.model_version, source: inputs.weekly.source },
      ros: { source: inputs.ros_source, ri_model_version: inputs.ri_model_version },
    },
    league_snapshot_id: lmc.league.league_snapshot_id ?? null,
    scoring_fingerprint: lmc.league.scoring_fingerprint ?? null,
    horizon_note: "weekly and rest_of_season are computed separately and never blended",
    deployment: "SHARED_CONTEXT",
    generated_at: new Date().toISOString(),
  };

  const teamStateByTeamId = new Map(lmc.teams.map((t) => [t.identity.canonical_team_id, t]));
  const teams: TeamRosterHealth[] = [];

  for (const roster of [...inputs.rosters].sort((a, b) => rosterIdOf(a, teamStateByTeamId) - rosterIdOf(b, teamStateByTeamId))) {
    const ts = teamStateByTeamId.get(roster.canonical_team_id);
    if (!ts) continue;

    const weekly = evaluateHorizon(inputs, roster, ts, "weekly");
    const ros = evaluateHorizon(inputs, roster, ts, "rest_of_season");

    let irTrapped = 0;
    for (const id of roster.ir) {
      const pts = inputs.rosPointsByCid.get(id) ?? null;
      const pos = inputs.playerById.get(id)?.position ?? "RB";
      if (pts != null) irTrapped += Math.max(0, pts - (inputs.rosReplacement[pos] ?? 0));
    }

    const startersOnBye = weekly.player_dependency
      .filter((d) => {
        const p = inputs.playerById.get(d.canonical_player_id);
        return d.starting_slot_label != null && p?.nfl_team && inputs.teams_on_bye.has(p.nfl_team);
      })
      .map((d) => d.canonical_player_id);

    const nearTermBye = inputs.schedule_ready
      ? [...new Set(ts.structural_flags.filter((f) => f.code === "SHARED_BYE_WEEK").flatMap((f) => byeWeeksFromFlag(f)))]
      : [];

    const teamDeg = mergeDeg([weekly.degradation, ros.degradation], inputs.schedule_ready, ts.identity.is_vacant);

    teams.push({
      roster_health_version: ROSTER_HEALTH_VERSION,
      lineage,
      team_id: roster.canonical_team_id,
      roster_id: ts.identity.roster_id,
      manager_slug: ts.identity.manager_slug,
      manager_display_name: ts.identity.manager_display_name,
      team_name: ts.identity.team_name,
      is_vacant: ts.identity.is_vacant,
      weekly,
      rest_of_season: ros,
      ir_burden: {
        trapped_ros_vor: roster.ir.length ? Math.round(irTrapped * 100) / 100 : 0,
        ir_slots_used: roster.ir.length,
        ir_slots_available: inputs.constraints.reserve_ir_capacity,
      },
      bye_exposure: {
        current_week_starters_on_bye: startersOnBye,
        near_term_shared_bye_weeks: nearTermBye,
      },
      league_relative: { weekly: {}, rest_of_season: {} },
      explanations: buildExplanations(weekly, ros),
      degradation: teamDeg,
    });
  }

  applyLeagueBenchmarks(teams);

  return {
    roster_health_version: ROSTER_HEALTH_VERSION,
    lineage,
    league_slug: inputs.league_slug,
    season: inputs.season,
    week: inputs.week,
    teams,
    roster_index: Object.fromEntries(teams.map((t, i) => [t.roster_id, i])),
    manager_index: Object.fromEntries(teams.map((t, i) => [t.manager_slug, i])),
    warnings: [...inputs.warnings, ...lmc.warnings],
  };
}

function rosterIdOf(roster: { canonical_team_id: string }, m: Map<string, { identity: { roster_id: number } }>): number {
  return m.get(roster.canonical_team_id)?.identity.roster_id ?? 999;
}

function byeWeeksFromFlag(f: { facts?: Record<string, unknown> }): number[] {
  const w = f.facts?.["bye_week"] ?? f.facts?.["week"];
  return typeof w === "number" ? [w] : [];
}

function buildExplanations(
  weekly: ReturnType<typeof evaluateHorizon>,
  ros: ReturnType<typeof evaluateHorizon>,
): TeamRosterHealth["explanations"] {
  const out: TeamRosterHealth["explanations"] = [];
  const topDep = weekly.player_dependency[0];
  if (topDep && (topDep.raw_point_loss ?? 0) > 4) {
    out.push({
      code: "TOP_DEPENDENCY",
      message: `${topDep.full_name ?? topDep.canonical_player_id} (${topDep.position}) unavailable → best-legal-lineup value falls ${topDep.raw_point_loss} pts (${topDep.pct_lineup_loss}%)${topDep.single_point_of_failure ? " — no usable backup remains" : ""}.`,
      evidence: { ...topDep.evidence, raw_point_loss: topDep.raw_point_loss },
    });
  }
  const frag = weekly.fragility;
  if (frag.profile !== "RESILIENT") {
    out.push({
      code: `FRAGILITY_${frag.profile}`,
      message:
        frag.profile === "CONCENTRATED_FRAGILITY"
          ? `One catastrophic single point of failure (worst dependency ${frag.worst_starter_dependency}) with otherwise moderate exposure (mean ${frag.expected_one_loss_damage}).`
          : frag.profile === "DISTRIBUTED_FRAGILITY"
            ? `Broadly thin — mean one-loss damage ${frag.expected_one_loss_damage} across starters, no single catastrophic point.`
            : `Concentrated AND distributed fragility (worst ${frag.worst_starter_dependency}, mean ${frag.expected_one_loss_damage}).`,
      evidence: {
        worst: frag.worst_starter_dependency,
        mean: frag.expected_one_loss_damage,
        spof_count: frag.single_points_of_failure.length,
      },
    });
  }
  const rosSurplus = ros.quality_surplus.filter((q) => q.quality_surplus);
  if (rosSurplus.length) {
    out.push({
      code: "QUALITY_SURPLUS",
      message: `Quality surplus (ROS) at ${rosSurplus.map((q) => q.slot_key).join(", ")} — bench players materially above replacement beyond what is fieldable.`,
      evidence: { slots: rosSurplus.map((q) => q.slot_key).join(","), n: rosSurplus.reduce((s, q) => s + q.surplus_players.length, 0) },
    });
  }
  return out;
}

function mergeDeg(
  views: RosterHealthDegradation[],
  scheduleReady: boolean,
  vacant: boolean,
): RosterHealthDegradation {
  const reasons = [...new Set(views.flatMap((v) => v.reasons))];
  if (!scheduleReady) reasons.push("SCHEDULE_LIMITED");
  if (vacant) reasons.push("VACANT_TEAM");
  const order = { OK: 0, PARTIAL: 1, DEGRADED: 2, INSUFFICIENT: 3 } as const;
  const overall = views.reduce<RosterHealthDegradation["overall"]>(
    (acc, v) => (order[v.overall] > order[acc] ? v.overall : acc),
    "OK",
  );
  return { reasons: [...new Set(reasons)] as RosterHealthDegradation["reasons"], overall, detail: {} };
}
