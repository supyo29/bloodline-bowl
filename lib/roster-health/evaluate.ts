/**
 * Phase 6 — per-team, per-horizon roster-health evaluation.
 *
 * Consumes: the shared inputs (§inputs.ts), one canonical roster, one Phase 2
 * `TeamManagementState` (for the structural facts + `structural_surplus`), a
 * horizon ("weekly" | "rest_of_season"). Produces a `HorizonView`.
 * Deterministic and pure given those inputs.
 */

import { isFlexSlot, slotEligiblePositions } from "@/lib/weekly/slots";
import { leagueSlotKeys } from "@/lib/team-state/slots";
import type { CanonicalPlayer, CanonicalRoster } from "@/lib/canonical/schema";
import type { TeamManagementState } from "@/lib/team-state/schema";
import type { WeeklyProjectionBatch } from "@/lib/weekly/schema";
import type { RosterHealthInputs } from "./inputs";
import { bestLegalLineup, contingency, horizonBatch, type LineupValue } from "./contingency";
import type {
  Horizon,
  HorizonView,
  PlayerDependency,
  PositionHealth,
  QualitySurplus,
  BenchUtility,
  RosterFragility,
  ContingencyScenario,
  RosterHealthDegradation,
  RosterHealthDegradationReason,
} from "./schema";

const CORE_FRAGILITY_EXCLUDED = new Set(["K", "DEF"]);
const round2 = (v: number) => Math.round(v * 100) / 100;
const startable = (p: CanonicalPlayer): string[] => [...new Set([p.position, ...p.eligible_positions])];

export function evaluateHorizon(
  inputs: RosterHealthInputs,
  roster: CanonicalRoster,
  teamState: TeamManagementState,
  horizon: Horizon,
): HorizonView {
  const { constraints, playerById, week } = inputs;
  const reasons: RosterHealthDegradationReason[] = [];

  const projections: WeeklyProjectionBatch =
    horizon === "weekly" ? inputs.weekly : horizonBatch(inputs.weekly, inputs.rosPointsByCid);
  const replacement = (key: string): number | null =>
    horizon === "weekly"
      ? inputs.weeklyReplacement.by_position[key]?.replacement_points ?? null
      : inputs.rosReplacement[key] ?? null;
  if (horizon === "rest_of_season") reasons.push("FA_POOL_ROS_APPROXIMATE");

  const proj = (id: string): number | null => projections.by_player.get(id)?.projected_points ?? null;

  const activeIds = roster.all_players.filter((id) => !roster.ir.includes(id) && !roster.taxi.includes(id));
  const activePlayers = activeIds.map((id) => playerById.get(id)).filter((p): p is CanonicalPlayer => Boolean(p));
  const benchIds = roster.bench.filter((id) => playerById.has(id));

  if (activePlayers.length < roster.all_players.length) reasons.push("UNKNOWN_PLAYER");
  const missingProj = activeIds.filter((id) => proj(id) == null && projections.by_player.get(id)?.projection_status !== "bye");
  if (missingProj.length > 0) reasons.push(horizon === "weekly" ? "MISSING_WEEKLY_PROJECTION" : "MISSING_ROS_PROJECTION");

  const baseline: LineupValue = bestLegalLineup(roster, constraints, playerById, projections, week);
  if (baseline.status === "PROVISIONAL") reasons.push("CONTINGENCY_PROVISIONAL");
  if (!baseline.value) reasons.push("INCOMPLETE_LINEUP");

  // ---- starter quality: Σ VOR of the current best legal starters ----
  const slotKeys = leagueSlotKeys(constraints.starting_slots);
  let starterQualityTotal = 0;
  let starterQualityKnown = false;
  const starterVorByPos: Record<string, number[]> = {};
  for (const sid of baseline.starterIds) {
    const p = playerById.get(sid);
    const pts = proj(sid);
    if (!p || pts == null) continue;
    const slot = baseline.slotByPlayer.get(sid) ?? p.position;
    const key = isFlexSlot(slot) ? slot : p.position;
    const rep = replacement(key) ?? replacement(p.position) ?? 0;
    const vor = round2(pts - rep);
    starterQualityTotal += vor;
    starterQualityKnown = true;
    (starterVorByPos[p.position] ??= []).push(vor);
  }

  // ---- player dependency (starters + bench that changes contingency coverage) ----
  const dependencyTargets = [
    ...baseline.starterIds,
    ...benchIds.filter((id) => {
      // include a bench player if his removal changes best-legal-lineup value
      const c = contingency(roster, constraints, playerById, projections, week, baseline, id);
      return (c.value_loss ?? 0) > 0.01;
    }),
  ];
  const player_dependency: PlayerDependency[] = [];
  const contingency_scenarios: ContingencyScenario[] = [];
  for (const id of [...new Set(dependencyTargets)]) {
    const p = playerById.get(id);
    if (!p) continue;
    const c = contingency(roster, constraints, playerById, projections, week, baseline, id);
    const pts = proj(id);
    const key = isFlexSlot(baseline.slotByPlayer.get(id) ?? "") ? baseline.slotByPlayer.get(id)! : p.position;
    const rep = replacement(key) ?? replacement(p.position);
    const bestBackupProj =
      c.promoted_projection ??
      benchIds
        .filter((b) => b !== id && eligibleShares(playerById.get(b), key))
        .map((b) => proj(b) ?? -Infinity)
        .sort((a, b) => b - a)[0] ??
      null;
    const remaining = benchIds.filter((b) => b !== id && eligibleShares(playerById.get(b), key) && (proj(b) ?? -1) >= (rep ?? 0)).length;
    contingency_scenarios.push({
      removed_player_id: id,
      removed_player_name: p.full_name ?? null,
      removed_position: p.position,
      horizon,
      baseline_lineup_value: c.baseline_value,
      post_removal_lineup_value: c.post_value,
      value_loss: c.value_loss,
      promoted_player_id: c.promoted_player_id,
      promoted_projection: c.promoted_projection,
      slot_affected: c.slot_affected,
      remaining_usable_backups: remaining,
      provisional: c.provisional,
    });
    // K/DST are excluded from the core single-point-of-failure signal (spec §14, §18)
    const coreExcluded = CORE_FRAGILITY_EXCLUDED.has(p.position);
    player_dependency.push({
      canonical_player_id: id,
      full_name: p.full_name ?? null,
      position: p.position,
      starting_slot_label: baseline.slotByPlayer.get(id) ?? null,
      horizon,
      raw_point_loss: c.value_loss,
      pct_lineup_loss:
        c.value_loss != null && baseline.value ? round2((c.value_loss / baseline.value) * 100) : null,
      replacement_gap:
        pts != null && bestBackupProj != null && Number.isFinite(bestBackupProj)
          ? round2(pts - bestBackupProj)
          : null,
      league_percentile: null, // filled by benchmark.ts
      position_percentile: null,
      single_point_of_failure:
        !coreExcluded && baseline.starterIds.includes(id) && remaining === 0 && (c.value_loss ?? 0) > 0,
      evidence: {
        baseline_value: c.baseline_value,
        post_removal_value: c.post_value,
        promoted_player_id: c.promoted_player_id,
        promoted_projection: c.promoted_projection,
        remaining_usable_backups: remaining,
      },
    });
  }
  player_dependency.sort((a, b) => (b.raw_point_loss ?? 0) - (a.raw_point_loss ?? 0));

  // ---- position health (depth quality — count vs quality, spec §10) ----
  const depth_quality: PositionHealth[] = slotKeys.map((key) => {
    const req = constraints.starting_slots.filter((s) => s === key).length;
    const rep = replacement(key) ?? replacement("QB") ?? 0;
    const pool = activePlayers
      .filter((p) => eligibleShares(p, key))
      .map((p) => ({ id: p.canonical_player_id, pts: proj(p.canonical_player_id) }))
      .filter((x): x is { id: string; pts: number } => x.pts != null)
      .sort((a, b) => b.pts - a.pts);
    const starterPool = pool.slice(0, Math.max(req, 1));
    const marginalStarter = req > 0 ? pool[req - 1]?.pts ?? pool.at(-1)?.pts ?? null : pool[0]?.pts ?? null;
    const bestBackup = pool[req]?.pts ?? null;
    const secondBackup = pool[req + 1]?.pts ?? null;
    const usable = pool.slice(req).filter((x) => x.pts >= rep).length;
    const nominal = Math.max(0, pool.length - Math.max(req, 1));
    const starterQ = starterPool.reduce((s, x) => s + Math.max(0, x.pts - rep), 0);
    const cliff = marginalStarter != null && bestBackup != null ? round2(Math.max(0, marginalStarter - bestBackup)) : null;
    const excluded = CORE_FRAGILITY_EXCLUDED.has(key);
    let grade: PositionHealth["depth_quality_grade"];
    if (usable >= 2) grade = "STRONG";
    else if (usable >= 1) grade = "ADEQUATE";
    else if (nominal >= 1) grade = "THIN";
    else grade = "BARE";
    return {
      slot_key: key,
      horizon,
      starter_quality_vor: round2(starterQ),
      best_backup_vor: bestBackup != null ? round2(bestBackup - rep) : null,
      second_backup_vor: secondBackup != null ? round2(secondBackup - rep) : null,
      replacement_cliff: cliff,
      usable_backup_count: usable,
      nominal_backup_count: nominal,
      depth_quality_grade: grade,
      excluded_from_core_fragility: excluded,
      reason_code: excluded
        ? "K_DST_EXCLUDED_FROM_CORE"
        : `usable=${usable} nominal=${nominal} cliff=${cliff ?? "na"}`,
    };
  });

  // ---- quality surplus (distinct from Phase 2 structural_surplus, spec §11) ----
  const tsSurplusKeys = new Set(
    teamState.depth_pressure.by_key.filter((e) => e.structural_surplus).map((e) => e.slot_key),
  );
  const quality_surplus: QualitySurplus[] = slotKeys.map((key) => {
    const rep = replacement(key) ?? 0;
    const posSpread = positionVorSpread(activePlayers, projections, key, replacement);
    const threshold = Math.max(1.5, posSpread * 0.35); // position-relative (spec §17)
    const pool = benchIds
      .map((id) => ({ id, p: playerById.get(id), pts: proj(id) }))
      .filter((x): x is { id: string; p: CanonicalPlayer; pts: number } => Boolean(x.p) && x.pts != null && eligibleShares(x.p, key));
    const surplusPlayers = pool.filter((x) => x.pts - rep >= threshold);
    // fieldable ceiling: bench players beyond what the optimizer would ever start
    const isQuality = surplusPlayers.length > 1;
    return {
      slot_key: key,
      horizon,
      team_state_structural_surplus: tsSurplusKeys.has(key),
      quality_surplus: isQuality,
      surplus_players: surplusPlayers.map((x) => ({
        canonical_player_id: x.id,
        full_name: x.p.full_name ?? null,
        vor: round2(x.pts - rep),
      })),
      reason_code: `bench_above_threshold(${threshold.toFixed(1)})=${surplusPlayers.length}`,
    };
  });

  // ---- bench utility (deterministic contingency usefulness, spec §12) ----
  const bench_utility: BenchUtility[] = benchIds.map((id) => {
    const p = playerById.get(id)!;
    const covers = slotKeys.filter((k) => eligibleShares(p, k));
    // starter replacement value: max value_loss AVOIDED because this bench player exists
    let bestPrevent = 0;
    for (const sid of baseline.starterIds) {
      const sPlayer = playerById.get(sid);
      if (!sPlayer) continue;
      const sSlotKey = isFlexSlot(baseline.slotByPlayer.get(sid) ?? "") ? baseline.slotByPlayer.get(sid)! : sPlayer.position;
      if (!eligibleShares(p, sSlotKey)) continue;
      const withOut = contingency(roster, constraints, playerById, projections, week, baseline, sid).value_loss ?? 0;
      const withoutBench = contingency(rosterWithoutBench(roster, id), constraints, playerById, projections, week, baseline, sid).value_loss ?? 0;
      bestPrevent = Math.max(bestPrevent, withoutBench - withOut);
    }
    const multiSlot = covers.filter((k) => {
      // this bench player is the BEST usable backup for slot k
      const rep = replacement(k) ?? 0;
      const others = benchIds
        .filter((b) => b !== id && eligibleShares(playerById.get(b), k))
        .map((b) => proj(b) ?? -1)
        .filter((x) => x >= rep);
      const mine = proj(id) ?? -1;
      return mine >= rep && others.every((o) => o <= mine);
    }).length;
    const byeCover = horizon === "weekly"
      ? covers.filter((k) =>
          baseline.starterIds.some((sid) => {
            const sp = playerById.get(sid);
            return sp && (isFlexSlot(baseline.slotByPlayer.get(sid) ?? "") ? baseline.slotByPlayer.get(sid)! : sp.position) === k && sp.nfl_team && inputs.teams_on_bye.has(sp.nfl_team);
          }),
        )
      : [];
    let grade: BenchUtility["bench_utility_grade"];
    if (bestPrevent >= 4 || multiSlot >= 2) grade = "HIGH";
    else if (bestPrevent >= 1.5 || multiSlot >= 1) grade = "MODERATE";
    else if (bestPrevent > 0) grade = "LOW";
    else grade = "DEAD_WEIGHT";
    return {
      canonical_player_id: id,
      full_name: p.full_name ?? null,
      position: p.position,
      horizon,
      starter_replacement_value: round2(bestPrevent),
      multi_slot_coverage: multiSlot,
      bye_coverage_slots: byeCover,
      bench_utility_grade: grade,
    };
  });

  // ---- roster fragility (component vector, spec §9) ----
  // K/DST are excluded from CORE fragility (spec §14, §18) — their dependency is
  // still in `player_dependency` for transparency, just not in the roster score.
  const starterDeps = player_dependency
    .filter((d) => baseline.starterIds.includes(d.canonical_player_id) && !CORE_FRAGILITY_EXCLUDED.has(d.position))
    .map((d) => d.raw_point_loss ?? 0)
    .sort((a, b) => b - a);
  const spofs = player_dependency.filter((d) => d.single_point_of_failure).map((d) => d.canonical_player_id);
  const worst = starterDeps[0] ?? null;
  const mean = starterDeps.length ? round2(starterDeps.reduce((s, x) => s + x, 0) / starterDeps.length) : null;
  const top3 = starterDeps.slice(0, 3);
  const top3w = top3.length
    ? round2(top3.reduce((s, x, i) => s + x * [0.5, 0.3, 0.2][i]!, 0) / top3.slice(0, 3).reduce((s, _, i) => s + [0.5, 0.3, 0.2][i]!, 0))
    : null;
  const p90 = starterDeps.length ? round2(starterDeps[Math.floor(0.9 * (starterDeps.length - 1))]!) : null;
  const concentrated = worst != null && mean != null && worst >= 6 && worst >= mean * 2.2;
  const distributed = mean != null && mean >= 3.5;
  const profile: RosterFragility["profile"] =
    concentrated && distributed ? "FRAGILE_BOTH" : concentrated ? "CONCENTRATED_FRAGILITY" : distributed ? "DISTRIBUTED_FRAGILITY" : "RESILIENT";

  const fragility: RosterFragility = {
    horizon,
    worst_starter_dependency: worst,
    expected_one_loss_damage: mean,
    top3_weighted_dependency: top3w,
    tail_dependency_p90: p90,
    single_points_of_failure: spofs,
    profile,
    min_slot_value_retained_after_any_one_loss:
      baseline.value != null && worst != null ? round2(baseline.value - worst) : null,
  };

  const degradation: RosterHealthDegradation = buildDeg(reasons, {
    baseline_value: baseline.value,
    missing_projection_count: missingProj.length,
    provisional: baseline.provisional,
    horizon,
  });

  return {
    horizon,
    starter_quality_vor_total: starterQualityKnown ? round2(starterQualityTotal) : null,
    baseline_lineup_value: baseline.value,
    depth_quality,
    fragility,
    player_dependency,
    quality_surplus,
    bench_utility,
    contingency_scenarios: contingency_scenarios.sort((a, b) => (b.value_loss ?? 0) - (a.value_loss ?? 0)),
    degradation,
  };
}

/* ------------------------------------------------------------------ helpers */

function eligibleShares(p: CanonicalPlayer | undefined, key: string): boolean {
  if (!p) return false;
  const allowed = new Set(slotEligiblePositions(key));
  return startable(p).some((pos) => allowed.has(pos));
}

function positionVorSpread(
  players: CanonicalPlayer[],
  projections: WeeklyProjectionBatch,
  key: string,
  replacement: (k: string) => number | null,
): number {
  const rep = replacement(key) ?? 0;
  const vors = players
    .filter((p) => eligibleShares(p, key))
    .map((p) => (projections.by_player.get(p.canonical_player_id)?.projected_points ?? null))
    .filter((x): x is number => x != null)
    .map((x) => x - rep)
    .sort((a, b) => b - a);
  if (vors.length < 4) return 3;
  const q1 = vors[Math.floor(0.25 * (vors.length - 1))]!;
  const q3 = vors[Math.floor(0.75 * (vors.length - 1))]!;
  return Math.max(1, q1 - q3);
}

function rosterWithoutBench(roster: CanonicalRoster, id: string): CanonicalRoster {
  return {
    ...roster,
    bench: roster.bench.filter((x) => x !== id),
    all_players: roster.all_players.filter((x) => x !== id),
  };
}

function buildDeg(
  reasons: RosterHealthDegradationReason[],
  detail: Record<string, string | number | boolean | null>,
): RosterHealthDegradation {
  const uniqR = [...new Set(reasons)];
  let overall: RosterHealthDegradation["overall"] = "OK";
  if (uniqR.includes("INCOMPLETE_LINEUP")) overall = "INSUFFICIENT";
  else if (uniqR.some((r) => r === "MISSING_WEEKLY_PROJECTION" || r === "MISSING_ROS_PROJECTION" || r === "CONTINGENCY_PROVISIONAL")) overall = "DEGRADED";
  else if (uniqR.length > 0) overall = "PARTIAL";
  return { reasons: uniqR, overall, detail };
}
