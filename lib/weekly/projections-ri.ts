/**
 * Roster Intel season-model SIGNAL for weekly decisions.
 *
 * The repo's `lib/projections/*` engine (`ri-structural-2026.3`) is a genuine,
 * independent season projection: scoring-neutral football model -> league
 * scoring translation -> replacement/VOR/tier/confidence, with Sleeper as a
 * `BENCHMARK_ONLY` comparison. It is NOT a "draft-value model" and it is NOT
 * discarded here.
 *
 * What RI does NOT have is a defensible opponent-specific WEEKLY projection, and
 * its absolute season level carries a known calibration caveat. So the weekly
 * engine consumes RI as:
 *   - an ORDINAL rest-of-season signal (position rank, VOR, tier)
 *   - a DISAGREEMENT / CONFIDENCE signal vs the external season projection
 * and never numerically ensembles RI points with Sleeper points.
 *
 * This provider is best-effort: if it fails or is skipped, weekly analytics run
 * unchanged (the ROS fields are simply `null`).
 */

import { PROJECTION_MODEL_VERSION } from "@/lib/projections/schema";
import { buildLeagueResponse, loadLeagueConfig } from "@/lib/projections/service";

export interface RiSeasonEntry {
  sleeper_player_id: string;
  /** RI's own full-season projection in this league's scoring (absolute — caveated). */
  ri_season_points: number | null;
  ri_vor: number | null;
  ri_vor_rank: number | null;
  ri_position_rank: number | null;
  ri_tier: number | null;
  ri_confidence: "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW" | null;
  /** Sleeper's full-season projection in the same scoring (RI's own benchmark). */
  external_season_points: number | null;
  /** RI vs external as a fraction of external. Null unless both exist. */
  disagreement_pct: number | null;
  primary_driver: string | null;
}

export interface RiSeasonSignalResult {
  status: "READY" | "UNAVAILABLE";
  model_version: string | null;
  by_sleeper_id: Map<string, RiSeasonEntry>;
  warning: string | null;
}

export interface RiSeasonSignalProvider {
  readonly name: string;
  getSeasonSignal(input: { league_slug: string; league_id: string }): Promise<RiSeasonSignalResult>;
}

export class RosterIntelSeasonSignalProvider implements RiSeasonSignalProvider {
  readonly name = "roster_intel_season";

  async getSeasonSignal(input: { league_slug: string; league_id: string }): Promise<RiSeasonSignalResult> {
    const empty: RiSeasonSignalResult = {
      status: "UNAVAILABLE",
      model_version: null,
      by_sleeper_id: new Map(),
      warning: null,
    };
    try {
      const cfg = await loadLeagueConfig(input.league_slug, input.league_id);
      const res = await buildLeagueResponse(cfg, { limit: 2000 });
      const map = new Map<string, RiSeasonEntry>();
      for (const p of res.players) {
        map.set(p.player_id, {
          sleeper_player_id: p.player_id,
          ri_season_points: num(p.league_points),
          ri_vor: num(p.value_over_replacement),
          ri_vor_rank: num(p.vor_rank),
          ri_position_rank: num(p.position_rank),
          ri_tier: num(p.tier),
          ri_confidence: p.confidence ?? null,
          external_season_points: num(p.sleeper_league_points),
          disagreement_pct:
            p.vs_sleeper?.delta_pct != null ? Math.round((p.vs_sleeper.delta_pct / 100) * 1000) / 1000 : null,
          primary_driver: p.vs_sleeper?.primary_driver ?? null,
        });
      }
      return { status: "READY", model_version: PROJECTION_MODEL_VERSION, by_sleeper_id: map, warning: null };
    } catch (error) {
      return {
        ...empty,
        warning: `Roster Intel season signal unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
