/**
 * Competitive Trade Intelligence — dynamic market edge orchestrator
 * (Checkpoint B.5).
 *
 * Turns the Checkpoint-B league market-edge table into a TIME-AWARE one:
 *   preseason prior (ADP / league draft cost)  ── decaying prior
 *   current public ROS (Sleeper)               ── a source
 *   current-season evidence (usage / schedule) ── NULL by default in 2026
 *              ↓
 *   MarketState.current_market_proxy   vs   PrivateForwardValue.projected_ros_value
 *              ↓
 *   dynamic MarketEdge (+ preseason edge, correction, trajectory, quality_status)
 *
 * With no current-season data (live 2026 week 1) every player resolves to
 * `PRESEASON_ONLY` and the dynamic edge ≈ the Checkpoint-B edge, just enriched.
 */

import { normalizeWithinPosition, type RawPoint } from "./normalize";
import { buildTemporalContext } from "./temporal";
import { buildCurrentSeasonEvidence, type GameObservation } from "./evidence";
import { buildMarketState } from "./market-state";
import { buildPrivateForwardValue } from "./private-forward";
import { applyDynamicMarketToEdge } from "./dynamic-edge";
import { loadCompetitiveMarketCalibration, resolveCurves, type CompetitiveMarketCalibration } from "./calibration";
import type { CompetitiveTradeConfig } from "./config";
import type { LeagueMarketEdgeTable } from "./evaluate";
import type { MarketEdge, TemporalContext } from "./schema";
import type { MarketReadiness } from "./schema";

export interface DynamicMarketInput {
  table: LeagueMarketEdgeTable;
  season: number;
  as_of_week: number;
  remaining_games_expected: number | null;
  config: CompetitiveTradeConfig;
  calibration?: CompetitiveMarketCalibration;
  /** per-player observed 2026 games (empty ⇒ PRESEASON_ONLY). keyed by canonical_player_id */
  observations_by_player?: Map<string, GameObservation[]>;
  /** per-player realized fantasy standing this season */
  standing_by_player?: Map<string, { season_points_rank: number | null; recent_rank: number | null }>;
  /** per-player prior stored market-snapshot proxy z (for trajectory) */
  prior_snapshot_proxy_z?: Map<string, number | null>;
  /** how the private prior's horizon is defined — see audit */
  private_horizon?: "ROS_WEEKLY_RATE" | "FULL_SEASON" | "UNKNOWN";
  market_horizon?: "ROS_WEEKLY_RATE" | "FULL_SEASON" | "UNKNOWN";
}

export interface DynamicMarketResult {
  by_player: Map<string, MarketEdge>;
  calibration_status: CompetitiveMarketCalibration["status"];
  evidence_readiness_counts: Record<string, number>;
}

export function buildDynamicMarketEdges(input: DynamicMarketInput): DynamicMarketResult {
  const { table, config, season, as_of_week } = input;
  const calibration = input.calibration ?? loadCompetitiveMarketCalibration();

  // ---- preseason prior z: from ADP / league-draft implied ranks in the B lineage ----
  const priorRankPoints: RawPoint[] = [];
  for (const [id, snap] of table.market_snapshots) {
    const draftMkt = snap.lineage.sources.find((s) => s.source_type === "draft_market" && s.implied_position_rank != null);
    const leagueDraft = snap.lineage.sources.find((s) => s.source_type === "league_draft_value" && s.implied_position_rank != null);
    const rank = draftMkt?.implied_position_rank ?? leagueDraft?.implied_position_rank ?? null;
    // rank → value: negate so a lower (better) rank is a higher value
    priorRankPoints.push({ canonical_player_id: id, position: snap.position, raw: rank == null ? null : -rank });
  }
  const priorNorm = normalizeWithinPosition(priorRankPoints).by_player;

  const out = new Map<string, MarketEdge>();
  const readinessCounts: Record<string, number> = {};

  for (const [id, baseEdge] of table.edges.by_player) {
    if (baseEdge.direction === "INSUFFICIENT_DATA" && baseEdge.private_value.normalized_value == null) {
      out.set(id, baseEdge); // nothing to make time-aware
      bump(readinessCounts, "UNAVAILABLE");
      continue;
    }

    const position = baseEdge.position;
    const observations = input.observations_by_player?.get(id) ?? [];
    const meaningfulGames = observations.filter((o) => o.meaningful).length;

    // ---- temporal context (ROLE family drives the headline maturity weight) ----
    const temporal: TemporalContext = buildTemporalContext({
      as_of_week,
      season,
      meaningful_games_observed: observations.length > 0 ? meaningfulGames : as_of_week <= 1 ? 0 : null,
      games_source: observations.length > 0 ? "ROLE_OBSERVED_GAMES" : as_of_week <= 1 ? "GAMES_PLAYED" : "WEEK_NUMBER_FALLBACK",
      position,
      metric_family: "ROLE",
      calibration,
      remaining_games: input.remaining_games_expected,
    });
    bump(readinessCounts, temporal.evidence_readiness);

    // ---- current-season evidence ----
    const curves = resolveCurves(calibration, position, "ROLE");
    const recency = {
      ROLE: resolveCurves(calibration, position, "ROLE").recency,
      EFFICIENCY: resolveCurves(calibration, position, "EFFICIENCY").recency,
      RESULT: resolveCurves(calibration, position, "RESULT").recency,
      CONTEXT: resolveCurves(calibration, position, "CONTEXT").recency,
    };
    void curves;
    const evidence = buildCurrentSeasonEvidence({ observations, position, as_of_week, recency });

    // ---- private forward value (prior = Checkpoint B private_value) ----
    const privateForward = buildPrivateForwardValue({
      canonical_player_id: id,
      prior: baseEdge.private_value,
      evidence,
      temporal,
      calibration,
      remaining_games_expected: input.remaining_games_expected,
    });

    // ---- market state ----
    const priorZ = priorNorm.get(id)?.normalized_value ?? baseEdge.market_value?.normalized_value ?? null;
    const priorRank = priorNorm.get(id)?.position_rank ?? null;
    const publicReadiness: MarketReadiness = baseEdge.lineage.worst_readiness;
    const standing = input.standing_by_player?.get(id) ?? { season_points_rank: null, recent_rank: null };
    const marketState = buildMarketState({
      canonical_player_id: id,
      season,
      as_of_week,
      preseason_prior_z: priorZ,
      preseason_prior_rank: priorRank,
      preseason_sources: ["adp_consensus", "league_draft_value"],
      current_public_z: baseEdge.market_value?.normalized_value ?? null,
      current_public_rank: baseEdge.market_value?.position_rank ?? null,
      current_public_readiness: publicReadiness,
      current_public_source: "sleeper_ros_benchmark",
      season_points_rank: standing.season_points_rank,
      recent_rank: standing.recent_rank,
      evidence,
      temporal,
      calibration,
      lineage: baseEdge.lineage,
      prior_snapshot_proxy_z: input.prior_snapshot_proxy_z?.get(id) ?? null,
    });

    // ---- apply ----
    const dyn = applyDynamicMarketToEdge({
      base_edge: baseEdge,
      private_forward: privateForward,
      market_state: marketState,
      temporal,
      config,
      calibration,
      private_horizon: input.private_horizon ?? "ROS_WEEKLY_RATE",
      market_horizon: input.market_horizon ?? "ROS_WEEKLY_RATE",
      private_as_of_week: as_of_week,
      market_as_of_week: as_of_week,
      evidence_flags: {
        weak_schedule_inflation: evidence.weak_schedule_inflation,
        touchdown_mirage_risk: evidence.touchdown_mirage_risk,
      },
    });
    out.set(id, dyn);
  }

  return { by_player: out, calibration_status: calibration.status, evidence_readiness_counts: readinessCounts };
}

function bump(m: Record<string, number>, k: string): void {
  m[k] = (m[k] ?? 0) + 1;
}
