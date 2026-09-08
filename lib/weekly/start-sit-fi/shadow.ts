/**
 * Phase 4 — SHADOW comparison path (spec §13, §29).
 *
 * For one weekly team context, produce:
 *   - the BASELINE optimal lineup (exactly today's production output)
 *   - the FI-CANDIDATE optimal lineup (same optimizer, FI-adjusted projections)
 *   - the diff + per-close-call start/sit deltas + evidence
 *
 * Production behavior is UNCHANGED: this returns a comparison object; nothing
 * here mutates `ctx.projections`, the production `lineup`, or `start_sit`.
 * `buildOptimalLineup` / `maxSlotMatching` are reused verbatim — FI only
 * rewrites the numeric projections fed to a SEPARATE optimizer invocation.
 */

import { buildOptimalLineup } from "../lineup";
import type { WeeklyTeamContext, WeeklyProjection, WeeklyProjectionBatch } from "../schema";
import { loadFootballIntelligence } from "@/lib/football-intel";
import { loadStartSitModel, translateFiAdjustment } from "./translate";
import type {
  StartSitShadowComparison,
  StartSitFiAdjustment,
  StartSitFiReasonCode,
} from "./schema";
import { START_SIT_FI_CONTRACT_VERSION } from "./schema";

export function buildStartSitShadow(ctx: WeeklyTeamContext): StartSitShadowComparison | null {
  const model = loadStartSitModel();
  const fi = loadFootballIntelligence();
  const now = new Date().toISOString();

  const lineage = {
    start_sit_model_version: model?.start_sit_model_version ?? "unavailable",
    football_intelligence_version: fi?.manifest.football_intelligence_version ?? null,
    football_intel_data_cutoff: fi?.manifest.data_cutoff ?? null,
    baseline_projection_version: ctx.projections.model_version,
    decision_generated_at: now,
    deployment: (model?.deployment ?? "SHADOW_ONLY") as "SHADOW_ONLY" | "PRODUCTION",
    contract_version: START_SIT_FI_CONTRACT_VERSION,
  };

  if (!model) {
    return {
      lineage,
      adjustments: [],
      baseline_lineup_total: null,
      fi_lineup_total: null,
      lineup_differs: false,
      lineup_deltas: [],
      start_sit_deltas: [],
      notes: ["No start_sit_model.json — shadow comparison is a no-op; production unchanged."],
    };
  }

  const season = ctx.league.season;
  const players = new Map(ctx.all_rostered.map((p) => [p.canonical_player_id, p]));

  // per-player FI adjustment
  const adjustments: StartSitFiAdjustment[] = [];
  const adjById = new Map<string, StartSitFiAdjustment>();
  for (const p of ctx.all_rostered) {
    const proj = ctx.projections.by_player.get(p.canonical_player_id) ?? null;
    const a = translateFiAdjustment({
      canonical_player_id: p.canonical_player_id,
      position: p.position,
      nfl_team: proj?.nfl_team ?? p.nfl_team ?? null,
      opponent: proj?.opponent ?? null,
      baseline_projection: proj?.projected_points ?? null,
      request_season: season,
      fi,
      model,
    });
    adjustments.push(a);
    adjById.set(p.canonical_player_id, a);
  }

  // FI-adjusted projection batch (clone; never touch the original)
  const fiBatch: WeeklyProjectionBatch = {
    ...ctx.projections,
    by_player: new Map(),
  };
  for (const [id, proj] of ctx.projections.by_player) {
    const a = adjById.get(id);
    if (!a || a.expected_adjustment === 0 || proj.projected_points == null) {
      fiBatch.by_player.set(id, proj);
      continue;
    }
    const adjusted: WeeklyProjection = {
      ...proj,
      projected_points:
        Math.round((proj.projected_points + a.expected_adjustment) * 100) / 100,
      warnings: [...proj.warnings, "start_sit_fi_shadow_adjustment_applied"],
    };
    fiBatch.by_player.set(id, adjusted);
  }

  const baseLineup = buildOptimalLineup({
    week: ctx.league.week,
    roster: ctx.roster,
    constraints: ctx.league.roster_constraints,
    players,
    projections: ctx.projections,
  });
  const fiLineup = buildOptimalLineup({
    week: ctx.league.week,
    roster: ctx.roster,
    constraints: ctx.league.roster_constraints,
    players,
    projections: fiBatch,
  });

  const baseStarters = new Set(baseLineup.slots.map((s) => s.recommended_player_id).filter(Boolean) as string[]);
  const fiStarters = new Set(fiLineup.slots.map((s) => s.recommended_player_id).filter(Boolean) as string[]);
  const lineup_deltas: StartSitShadowComparison["lineup_deltas"] = [];
  for (const s of fiLineup.slots) {
    const id = s.recommended_player_id;
    if (id && !baseStarters.has(id)) {
      const out =
        baseLineup.slots.find((b) => b.slot === s.slot)?.recommended_player_id ?? null;
      lineup_deltas.push({ in: id, out: out && !fiStarters.has(out) ? out : null, slot: s.slot });
    }
  }

  // pairwise close-call deltas from the baseline lineup's own change set
  const start_sit_deltas: StartSitShadowComparison["start_sit_deltas"] = [];
  const tau = model.tau_tie_break ?? 0;
  for (const c of baseLineup.changes_recommended) {
    if (!c.out) continue;
    const inProj = ctx.projections.by_player.get(c.in)?.projected_points ?? null;
    const outProj = ctx.projections.by_player.get(c.out)?.projected_points ?? null;
    if (inProj == null || outProj == null) continue;
    const baseEdge = inProj - outProj;
    const inAdj = adjById.get(c.in)?.expected_adjustment ?? 0;
    const outAdj = adjById.get(c.out)?.expected_adjustment ?? 0;
    const fiEdge = baseEdge + (inAdj - outAdj);
    const insideGate = Math.abs(baseEdge) < tau;
    const baseStart = baseEdge >= 0 ? c.in : c.out;
    const fiStart = insideGate ? (fiEdge >= 0 ? c.in : c.out) : baseStart;
    const rc: StartSitFiReasonCode[] = [
      "BASELINE_PROJECTION_EDGE",
      ...(insideGate ? [] : (["FI_BELOW_TIE_BREAK_GATE"] as StartSitFiReasonCode[])),
      ...(adjById.get(c.in)?.reason_codes ?? []),
    ];
    start_sit_deltas.push({
      slot: c.slot,
      baseline_start: baseStart,
      fi_start: fiStart,
      baseline_edge: round2(baseEdge),
      fi_edge: round2(fiEdge),
      changed: fiStart !== baseStart,
      inside_tie_break_gate: insideGate,
      reason_codes: [...new Set(rc)],
    });
  }

  return {
    lineage,
    adjustments,
    baseline_lineup_total: baseLineup.optimal_total,
    fi_lineup_total: fiLineup.optimal_total,
    lineup_differs: lineup_deltas.length > 0,
    lineup_deltas,
    start_sit_deltas,
    notes: [
      `deployment=${lineage.deployment}: this comparison does NOT change production lineup or start/sit output.`,
      ...(fi && fi.manifest.season < season
        ? [`Football Intelligence is a ${fi.manifest.season} prior for the ${season} season.`]
        : []),
    ],
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
