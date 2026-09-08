/**
 * Phase 5 — Matchup Intelligence orchestrator (SHADOW_ONLY).
 *
 * `buildMatchupIntelligence(ctx)` runs alongside the untouched production
 * `buildMatchup`. It never mutates `ctx.projections`, never runs the production
 * optimizer with adjusted inputs, never returns a lineup. `buildOptimalLineup`
 * is used only to derive the opponent's ASSUMED_OPTIMAL view for a diagnostic.
 */

import { buildOptimalLineup, isEligible } from "../lineup";
import type { WeeklyTeamContext } from "../schema";
import { loadDistributionModel } from "./distributions";
import { loadCorrelationModel } from "./correlations";
import { simulateMatchup, type SimPlayer } from "./simulator";
import { buildDegradation } from "./confidence";
import { buildExplanations } from "./explain";
import { matchupDeploymentContract } from "./deployment";
import {
  MATCHUP_INTELLIGENCE_CONTRACT_VERSION,
  type MatchupIntelligence,
  type LeverageDiagnostic,
} from "./schema";

const MATCHUP_MODEL_VERSION = "ri-matchup-2026.1";
const CALIBRATED_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

function baseOf(slot: string): string {
  return ["QB", "RB", "WR", "TE", "K", "DEF"].includes(slot) ? slot : "FLEX";
}

function isQuestionable(inj: string | null | undefined): boolean {
  const s = (inj ?? "").toLowerCase();
  return s === "questionable" || s === "doubtful";
}

/** resolve a lineup's starter slots into SimPlayers (FLEX -> the player's real base position). */
function toSimPlayers(
  starterIds: string[],
  slots: string[],
  ctx: WeeklyTeamContext,
  side: "team" | "opponent",
): { players: SimPlayer[]; unknown: number; missing: number; questionable: number; incomplete: boolean } {
  const players: SimPlayer[] = [];
  let unknown = 0;
  let missing = 0;
  let questionable = 0;
  let incomplete = false;
  const allPlayers = new Map(
    [...ctx.all_rostered, ...(ctx.opponent?.all_rostered ?? [])].map((p) => [p.canonical_player_id, p]),
  );
  for (let i = 0; i < slots.length; i += 1) {
    const id = starterIds[i];
    if (!id) {
      incomplete = true;
      continue;
    }
    const wp = ctx.projections.by_player.get(id);
    const cp = allPlayers.get(id);
    const pos = cp?.position ? cp.position : baseOf(slots[i]!);
    if (!wp || (wp.projected_points == null && wp.projection_status !== "bye")) {
      unknown += 1;
      if (!wp) missing += 1;
      players.push({ canonical_player_id: id, position: pos, projection: null, questionable: false, is_qb: pos === "QB", side });
      continue;
    }
    const proj = wp.projection_status === "bye" ? 0 : (wp.projected_points ?? 0);
    const q = isQuestionable(wp.injury_status);
    if (q) questionable += 1;
    players.push({ canonical_player_id: id, position: pos, projection: proj, questionable: q, is_qb: pos === "QB", side });
  }
  return { players, unknown, missing, questionable, incomplete };
}

/** PLAUSIBLE opponent lineup: submitted starters with bye/out/empty replaced by the best legal bench. */
function plausibleOpponentLineup(
  ctx: WeeklyTeamContext,
): { ids: string[]; slots: string[]; corrected: boolean } | null {
  const opp = ctx.opponent;
  if (!opp || !opp.roster) return null;
  const slots = ctx.league.roster_constraints.starting_slots;
  const submitted = opp.roster.starters.slice(0, slots.length);
  const benchPool = opp.all_rostered.filter((p) => !submitted.includes(p.canonical_player_id));
  const used = new Set(submitted);
  let corrected = false;
  const out: string[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    const id = submitted[i];
    const wp = id ? ctx.projections.by_player.get(id) : undefined;
    const isBad = !id || wp?.projection_status === "bye" || (wp?.expected_availability ?? 1) < 0.15;
    if (!isBad) {
      out.push(id!);
      continue;
    }
    const repl = benchPool
      .filter((p) => !used.has(p.canonical_player_id) && isEligible(slots[i]!, p))
      .map((p) => ({ p, pts: ctx.projections.by_player.get(p.canonical_player_id)?.projected_points ?? -1 }))
      .sort((a, b) => b.pts - a.pts)[0];
    if (repl && repl.pts >= 0) {
      out.push(repl.p.canonical_player_id);
      used.add(repl.p.canonical_player_id);
      corrected = true;
    } else if (id) {
      out.push(id);
    }
  }
  return { ids: out, slots, corrected };
}

export function buildMatchupIntelligence(ctx: WeeklyTeamContext): MatchupIntelligence {
  const distModel = loadDistributionModel();
  const corrModel = loadCorrelationModel();
  const contract = matchupDeploymentContract();
  const now = new Date().toISOString();
  const snapLineage = (ctx.lineage as { snapshot?: { league_snapshot_id?: string; scoring_fingerprint?: string } }).snapshot;
  const warnings: string[] = [];

  const lineageBase = {
    matchup_model_version: MATCHUP_MODEL_VERSION,
    distribution_model_version: distModel?.distribution_model_version ?? null,
    correlation_model_version: corrModel?.correlation_model_version ?? null,
    projection_lineage: { model_version: ctx.projections.model_version, source: ctx.projections.source },
    football_intelligence_version: "not_used" as string,
    league_snapshot_id: snapLineage?.league_snapshot_id ?? null,
    scoring_fingerprint: snapLineage?.scoring_fingerprint ?? null,
    deployment: contract.deployment,
    contract_version: MATCHUP_INTELLIGENCE_CONTRACT_VERSION,
    generated_at: now,
  };

  const teamLineup = buildOptimalLineup({
    week: ctx.league.week,
    roster: ctx.roster,
    constraints: ctx.league.roster_constraints,
    players: new Map(ctx.all_rostered.map((p) => [p.canonical_player_id, p])),
    projections: ctx.projections,
  });
  const slots = ctx.league.roster_constraints.starting_slots;
  const teamStarterIds = teamLineup.slots.map((s) => s.recommended_player_id ?? "");
  const team = toSimPlayers(teamStarterIds, slots, ctx, "team");

  if (!ctx.opponent || !ctx.opponent.roster) {
    return emptyResult(ctx, lineageBase, "no_opponent");
  }

  const plausible = plausibleOpponentLineup(ctx);
  const opponent_view: MatchupIntelligence["lineage"]["opponent_view"] =
    plausible?.corrected ? "PLAUSIBLE" : "SUBMITTED";
  const oppIds = plausible ? plausible.ids : ctx.opponent.roster.starters.slice(0, slots.length);
  const opp = toSimPlayers(oppIds, slots, ctx, "opponent");

  const seedIdentity = [
    lineageBase.league_snapshot_id ?? ctx.league.slug,
    ctx.fantasy_team.canonical_team_id,
    ctx.opponent.fantasy_team.canonical_team_id,
    ctx.league.week,
    MATCHUP_MODEL_VERSION,
    distModel?.distribution_model_version ?? "none",
    10000,
  ].join("|");

  if (team.incomplete || opp.incomplete || team.unknown > 0 || opp.unknown > 0) {
    // an unknown/incomplete starter must not be simulated as a numeric 0
    return degradedResult(ctx, lineageBase, opponent_view, seedIdentity, {
      team_unknown: team.unknown, opp_unknown: opp.unknown,
      team_missing: team.missing, opp_missing: opp.missing,
      team_incomplete: team.incomplete, opp_incomplete: opp.incomplete,
      questionable: team.questionable + opp.questionable,
    });
  }

  const sim = simulateMatchup({ team: team.players, opponent: opp.players, seedIdentity, simCount: 10000 });

  const uncal = [...new Set([...team.players, ...opp.players].map((p) => p.position))].filter(
    (p) => !distModel || !distModel.positions[p] || !CALIBRATED_POSITIONS.has(p),
  );
  const provDegraded = ctx.league.season < 2023;

  const degradation = buildDegradation({
    team_unknown_starters: 0, opp_unknown_starters: 0,
    team_missing_projection: 0, opp_missing_projection: 0,
    team_incomplete: false, opp_incomplete: false,
    questionable_starters: team.questionable + opp.questionable,
    uncalibrated_positions: uncal,
    correlation_available: corrModel != null,
    game_context_available: true,
    fi_prior_only: true,
    non_pregame: false,
    opponent_view,
    distribution_model_present: distModel != null,
    sim_se: sim.win_probability_se,
    baseline_provenance_degraded: provDegraded,
  });

  const explanations = buildExplanations(sim, {
    team_expected: sim.team_score.expected,
    opp_expected: sim.opponent_score.expected,
    team_sd: sim.team_score.sd,
    opp_sd: sim.opponent_score.sd,
    questionable_starters: team.questionable + opp.questionable,
    uncalibrated_positions: uncal,
    opponent_view,
  });

  const leverage_diagnostics = buildLeverageDiagnostics(ctx, teamLineup, team.players, opp.players, seedIdentity, sim.win_probability, degradation.overall);

  return {
    week: ctx.league.week,
    team_id: ctx.fantasy_team.canonical_team_id,
    opponent_team_id: ctx.opponent.fantasy_team.canonical_team_id,
    has_opponent: true,
    team_score: sim.team_score,
    opponent_score: sim.opponent_score,
    margin: sim.margin,
    win_probability: round4(sim.win_probability),
    win_probability_pct: Math.round(sim.win_probability * 100),
    win_probability_interval: {
      low: Math.round((sim.win_probability - sim.win_probability_se) * 100),
      high: Math.round((sim.win_probability + sim.win_probability_se) * 100),
    },
    tie_probability: round4(sim.tie_probability),
    expected_margin: sim.expected_margin,
    upset_probability: round4(sim.upset_probability),
    blowout_probability: round4(sim.blowout_probability),
    confidence: degradation,
    dependence_diagnostics: {
      win_probability_with_dependence: null, // computed lazily by a diagnostic caller
      delta_vs_independent: null,
      correlation_model: corrModel?.correlation_model_version ?? null,
      note: "2-factor dependence adds no incremental win-probability calibration value (Phase 5 backtest) — DIAGNOSTIC only, never in the headline WP.",
    },
    explanations,
    leverage_diagnostics,
    lineage: {
      ...lineageBase,
      sim_seed: sim.sim_seed,
      sim_seed_identity: seedIdentity,
      sim_count: sim.sim_count,
      sim_win_probability_se: round4(sim.win_probability_se),
      opponent_view,
    },
    warnings,
  };
}

function buildLeverageDiagnostics(
  ctx: WeeklyTeamContext,
  teamLineup: ReturnType<typeof buildOptimalLineup>,
  teamStarters: SimPlayer[],
  oppStarters: SimPlayer[],
  seedIdentity: string,
  baselineWp: number,
  conf: LeverageDiagnostic["model_confidence"],
): LeverageDiagnostic[] {
  const out: LeverageDiagnostic[] = [];
  const byId = new Map(ctx.all_rostered.map((p) => [p.canonical_player_id, p]));
  const benchIds = ctx.roster.bench;
  // screen: only bench players within ~4 projected pts of a same-eligible starter
  for (let si = 0; si < teamLineup.slots.length; si += 1) {
    const slot = teamLineup.slots[si]!.slot;
    const startId = teamLineup.slots[si]!.recommended_player_id;
    if (!startId) continue;
    const startProj = ctx.projections.by_player.get(startId)?.projected_points ?? null;
    if (startProj == null) continue;
    for (const bId of benchIds) {
      const bp = byId.get(bId);
      const bwp = ctx.projections.by_player.get(bId);
      if (!bp || bwp?.projected_points == null || !isEligible(slot, bp)) continue;
      const diff = bwp.projected_points - startProj;
      if (diff > 0.5 || diff < -4) continue; // only close-or-worse candidates matter for leverage
      const swapped = teamStarters.map((p) =>
        p.canonical_player_id === startId
          ? { ...p, canonical_player_id: bId, projection: bwp.projected_points!, position: bp.position ? bp.position : baseOf(slot), is_qb: bp.position === "QB", questionable: isQuestionable(bwp.injury_status) }
          : p,
      );
      const altSim = simulateMatchup({ team: swapped, opponent: oppStarters, seedIdentity: `${seedIdentity}|swap:${startId}->${bId}`, simCount: 4000 });
      out.push({
        slot,
        current_player_id: startId,
        alternative_player_id: bId,
        expected_point_diff: round2(diff),
        variance_diff: null,
        correlation_diff: null,
        baseline_win_probability: round4(baselineWp),
        alternative_win_probability: round4(altSim.win_probability),
        delta_win_probability: round4(altSim.win_probability - baselineWp),
        model_confidence: conf,
        resolution: "OK",
      });
    }
  }
  return out.sort((a, b) => Math.abs(b.delta_win_probability) - Math.abs(a.delta_win_probability)).slice(0, 8);
}

function emptyResult(
  ctx: WeeklyTeamContext,
  lineageBase: Omit<MatchupIntelligence["lineage"], "sim_seed" | "sim_seed_identity" | "sim_count" | "sim_win_probability_se" | "opponent_view">,
  code: string,
): MatchupIntelligence {
  return {
    week: ctx.league.week,
    team_id: ctx.fantasy_team.canonical_team_id,
    opponent_team_id: ctx.opponent?.fantasy_team.canonical_team_id ?? null,
    has_opponent: false,
    team_score: null, opponent_score: null, margin: null,
    win_probability: null, win_probability_pct: null, win_probability_interval: null,
    tie_probability: null, expected_margin: null, upset_probability: null, blowout_probability: null,
    confidence: { reasons: ["INCOMPLETE_LINEUP"], overall: "INSUFFICIENT", detail: {} },
    dependence_diagnostics: null,
    explanations: [], leverage_diagnostics: [],
    lineage: { ...lineageBase, sim_seed: 0, sim_seed_identity: "", sim_count: 0, sim_win_probability_se: 0, opponent_view: "SUBMITTED" },
    warnings: [code],
  };
}

function degradedResult(
  ctx: WeeklyTeamContext,
  lineageBase: Omit<MatchupIntelligence["lineage"], "sim_seed" | "sim_seed_identity" | "sim_count" | "sim_win_probability_se" | "opponent_view">,
  opponent_view: MatchupIntelligence["lineage"]["opponent_view"],
  seedIdentity: string,
  d: { team_unknown: number; opp_unknown: number; team_missing: number; opp_missing: number; team_incomplete: boolean; opp_incomplete: boolean; questionable: number },
): MatchupIntelligence {
  const degradation = buildDegradation({
    team_unknown_starters: d.team_unknown, opp_unknown_starters: d.opp_unknown,
    team_missing_projection: d.team_missing, opp_missing_projection: d.opp_missing,
    team_incomplete: d.team_incomplete, opp_incomplete: d.opp_incomplete,
    questionable_starters: d.questionable, uncalibrated_positions: [],
    correlation_available: true, game_context_available: true, fi_prior_only: true,
    non_pregame: false, opponent_view, distribution_model_present: loadDistributionModel() != null,
    sim_se: 0, baseline_provenance_degraded: ctx.league.season < 2023,
  });
  return {
    week: ctx.league.week,
    team_id: ctx.fantasy_team.canonical_team_id,
    opponent_team_id: ctx.opponent?.fantasy_team.canonical_team_id ?? null,
    has_opponent: true,
    team_score: null, opponent_score: null, margin: null,
    win_probability: null, win_probability_pct: null, win_probability_interval: null,
    tie_probability: null, expected_margin: null, upset_probability: null, blowout_probability: null,
    confidence: degradation,
    dependence_diagnostics: null,
    explanations: [{
      code: "NOT_SIMULATED",
      message: "Matchup not simulated — an UNKNOWN or missing projected starter must not be modeled as a numeric 0.",
      evidence: { team_unknown: d.team_unknown, opp_unknown: d.opp_unknown },
    }],
    leverage_diagnostics: [],
    lineage: { ...lineageBase, sim_seed: 0, sim_seed_identity: seedIdentity, sim_count: 0, sim_win_probability_se: 0, opponent_view },
    warnings: ["matchup_intelligence_not_simulated_unknown_starter"],
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
