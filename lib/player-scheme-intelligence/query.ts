/**
 * Player x Scheme Intelligence — Tier A query/assembly layer (spec §33, §34, §37, §46).
 *
 * READ-ONLY. Assembles the served Tier A CSV artifacts into the response
 * shapes the additive `app/api/player-scheme/*` surface returns. Every number
 * traces to a published cell; nothing is recomputed from play-by-play here.
 *
 * The matchup surface produces a DESCRIPTIVE tendency-overlap between a
 * player's spatial profile and an opponent's spatial vulnerability. It is NOT
 * the Tier D validated interaction model: it carries
 * `numeric_fantasy_adjustment = 0`, `deployment = "SHADOW_ONLY"`, and
 * `validation_status = "SHARED_DESCRIPTIVE"` (an overlap of two observed
 * profiles, not an out-of-sample-validated effect).
 */

import {
  defensePassMatrix,
  defenseRushProfile,
  leagueBaselines,
  loadPlayerSchemeIntelligence,
  qbCoverageProfile,
  qbCoverageFamily,
  qbConceptProfile,
  qbDirectional,
  qbFormationProfile,
  qbMatrix,
  qbPressureProfile,
  qbProgressionProfile,
  qbRusherCountProfile,
  rbBoxProfile,
  rbRushGap,
  rbRushMatrix,
  receiverCoverageProfile,
  receiverMatrix,
  receiverRouteProfile,
  resolvePlayer,
  tierBFamilyMeta,
  type ChartingSplitRow,
  type DefensePassCell,
  type ProfileWindow,
  type SpatialCellRow,
} from "./read";

const DEPTHS = ["BEHIND_LOS", "SHORT", "INTERMEDIATE", "DEEP"] as const;
const THIRDS = ["LEFT", "MIDDLE", "RIGHT"] as const;

function manifestMeta() {
  const psi = loadPlayerSchemeIntelligence();
  if (!psi) return null;
  const m = psi.manifest;
  return {
    player_scheme_version: m.player_scheme_version,
    model_tag: m.model_tag,
    tier: (m as { tier?: string }).tier ?? "A",
    as_of_season: m.current_season,
    as_of_week: m.as_of_week,
    availability_state: m.availability_state,
    live_class: m.live_class,
    current_season_status: m.current_season_status,
    data_cutoff: m.data_cutoff,
    seasons_used: m.seasons_used,
    deployment: "SHARED_DESCRIPTIVE" as const,
    fantasy_adjustment_enabled: false as const,
  };
}

function byWindow<T extends { window: string }>(rows: T[]): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) (out[r.window] ??= []).push(r);
  return out;
}

/** Order a cell list into the canonical 12-cell (or 3/4) grid, visual-ready (spec §38). */
function gridOrder(rows: SpatialCellRow[]): SpatialCellRow[] {
  return [...rows].sort(
    (a, b) => DEPTHS.indexOf(a.depth_bin) - DEPTHS.indexOf(b.depth_bin) ||
      THIRDS.indexOf(a.field_third) - THIRDS.indexOf(b.field_third),
  );
}

export interface ResolvedRef {
  gsis_id: string;
  full_name: string | null;
  position: string | null;
  nfl_team: string | null;
  matched_on: string | null;
}

export function resolveRef(raw: string): ResolvedRef | { resolution: "UNRESOLVED"; query: string } {
  const { entry, matched_on } = resolvePlayer(raw);
  if (!entry) return { resolution: "UNRESOLVED", query: raw };
  return {
    gsis_id: entry.gsis_id,
    full_name: entry.full_name,
    position: entry.position,
    nfl_team: entry.nfl_team,
    matched_on,
  };
}

// ---------------------------------------------------------------------------
// Tier B — charting-dependent family blocks with per-family provenance (spec §4, §19)
// ---------------------------------------------------------------------------
function chartingFamily(family: string, rows: ChartingSplitRow[]) {
  const meta = tierBFamilyMeta(family);
  const windows: Record<string, ChartingSplitRow[]> = {};
  for (const r of rows) (windows[r.window] ??= []).push(r);
  return {
    family,
    availability: meta.availability,
    source: meta.source,
    first_supported_season: meta.first_supported_season,
    source_season_through: meta.source_season_through,
    current_season_observed: meta.current_season_observed,
    // hard, machine-readable: this is NOT a current-season observation
    is_current_season_observation: meta.current_season_observed === true,
    windows: Object.keys(windows).length ? windows : null,
  };
}

function qbChartingSection(gsis_id: string) {
  return {
    coverage: chartingFamily("qb_coverage", qbCoverageProfile(gsis_id)),
    coverage_family: chartingFamily("qb_coverage", qbCoverageFamily(gsis_id)),
    pressure: chartingFamily("qb_pressure", qbPressureProfile(gsis_id)),
    pass_rusher_count: chartingFamily("qb_rusher_count", qbRusherCountProfile(gsis_id)),
    formation: chartingFamily("qb_formation", qbFormationProfile(gsis_id)),
    concepts: chartingFamily("qb_concepts", qbConceptProfile(gsis_id)),
    progression: chartingFamily("qb_progression", qbProgressionProfile(gsis_id)),
  };
}

// ---------------------------------------------------------------------------
// QB
// ---------------------------------------------------------------------------
export function buildQbProfile(raw: string) {
  const meta = manifestMeta();
  if (!meta) return null;
  const ref = resolveRef(raw);
  if ("resolution" in ref) return { ...meta, ...ref };
  const cells = qbMatrix(ref.gsis_id);
  if (cells.length === 0) return { ...meta, ...ref, availability: "NOT_AVAILABLE" as const };
  const dir = qbDirectional(ref.gsis_id);
  const matrixByWindow = byWindow(cells);
  return {
    ...meta,
    player: ref,
    windows: Object.fromEntries(
      Object.entries(matrixByWindow).map(([w, rows]) => {
        const d = dir.find((x) => x.window === (w as ProfileWindow));
        return [w, {
          matrix: gridOrder(rows),
          directional: d ? d.values : null,
          directional_vs_league_baseline: d ? d.vs_league : null,
          attempts_total: rows[0]?.attempts_total ?? null,
          attempts_uncharted: rows[0]?.attempts_uncharted ?? null,
        }];
      }),
    ),
    spatial_availability: "LIVE_CAPABLE" as const,
    charting: qbChartingSection(ref.gsis_id),
    lineage: {
      spatial_source: "nflverse play-by-play (LIVE_CAPABLE)",
      charting_source: "nflverse participation + FTN (PRIOR_ONLY / DESCRIPTIVE_ONLY — see charting.*.availability)",
      note: "Spatial cells built only from charted plays; uncharted attempts counted in attempts_total, never binned (spec §41). Charting families carry per-family availability; none is a current-2026 observation (spec §3, §4).",
    },
  };
}

// ---------------------------------------------------------------------------
// Receiving / Rushing
// ---------------------------------------------------------------------------
export function buildReceivingProfile(raw: string) {
  const meta = manifestMeta();
  if (!meta) return null;
  const ref = resolveRef(raw);
  if ("resolution" in ref) return { ...meta, ...ref };
  const cells = receiverMatrix(ref.gsis_id);
  if (cells.length === 0) return { ...meta, ...ref, availability: "NOT_AVAILABLE" as const };
  return {
    ...meta,
    player: ref,
    windows: Object.fromEntries(
      Object.entries(byWindow(cells)).map(([w, rows]) => [w, {
        target_matrix: gridOrder(rows),
        targets_total: rows[0]?.attempts_total ?? null,
        targets_uncharted: rows[0]?.attempts_uncharted ?? null,
      }]),
    ),
    spatial_availability: "LIVE_CAPABLE" as const,
    charting: {
      routes: chartingFamily("receiver_route", receiverRouteProfile(ref.gsis_id)),
      coverage: chartingFamily("receiver_coverage", receiverCoverageProfile(ref.gsis_id)),
    },
    lineage: {
      spatial_source: "nflverse play-by-play (LIVE_CAPABLE)",
      charting_source: "nflverse participation (PRIOR_ONLY)",
      note: "Target location = the throw's location/depth, NOT receiver alignment (spec §10). `routes` is TARGETED-route only — a share of targets, not routes run; YPRR not computable (spec §10).",
    },
  };
}

export function buildRushingProfile(raw: string) {
  const meta = manifestMeta();
  if (!meta) return null;
  const ref = resolveRef(raw);
  if ("resolution" in ref) return { ...meta, ...ref };
  const dir = rbRushMatrix(ref.gsis_id);
  if (dir.length === 0) return { ...meta, ...ref, availability: "NOT_AVAILABLE" as const };
  const gap = rbRushGap(ref.gsis_id);
  return {
    ...meta,
    player: ref,
    windows: Object.fromEntries(
      Object.entries(byWindow(dir)).map(([w, rows]) => [w, {
        direction: rows,
        gap: gap.filter((g) => g.window === w),
        carries_total: rows[0]?.attempts_total ?? null,
        carries_uncharted: rows[0]?.attempts_uncharted ?? null,
      }]),
    ),
    spatial_availability: "LIVE_CAPABLE" as const,
    charting: { box: chartingFamily("rb_box", rbBoxProfile(ref.gsis_id)) },
    lineage: {
      spatial_source: "nflverse play-by-play (LIVE_CAPABLE)",
      charting_source: "nflverse participation defenders_in_box (PRIOR_ONLY)",
      note: "Direction + gap ONLY (end/tackle/guard). Never relabeled zone/gap/power/counter (spec §13). Offense-perspective, no mirroring (spec §42). Box count is NOT a defensive front scheme (spec §14).",
    },
  };
}

// ---------------------------------------------------------------------------
// Defense
// ---------------------------------------------------------------------------
export function buildDefenseProfile(team: string) {
  const meta = manifestMeta();
  if (!meta) return null;
  const pass = defensePassMatrix(team);
  if (pass.length === 0) return { ...meta, team: team.toUpperCase(), availability: "NOT_AVAILABLE" as const };
  const rush = defenseRushProfile(team);
  return {
    ...meta,
    team: team.toUpperCase(),
    windows: Object.fromEntries(
      Object.entries(byWindow(pass)).map(([w, rows]) => [w, {
        pass_vulnerability_matrix: [...rows].sort(
          (a, b) => DEPTHS.indexOf(a.depth_bin) - DEPTHS.indexOf(b.depth_bin) ||
            THIRDS.indexOf(a.field_third) - THIRDS.indexOf(b.field_third),
        ),
        rush_direction: rush.filter((r) => r.window === w),
      }]),
    ),
    lineage: { source: "nflverse play-by-play", note: "Allowed-target grid on the SAME depth x third definitions as the QB/receiver matrices (spec §18)." },
  };
}

// ---------------------------------------------------------------------------
// Matchup tendency-overlap (DESCRIPTIVE — spec §33, §34; NOT Tier D)
// ---------------------------------------------------------------------------
export function buildMatchupAlignment(rawPlayer: string, opponent: string, window: ProfileWindow = "recent") {
  const meta = manifestMeta();
  if (!meta) return null;
  const ref = resolveRef(rawPlayer);
  if ("resolution" in ref) return { ...meta, ...ref };

  const isQb = (ref.position ?? "").toUpperCase() === "QB";
  const playerCells = (isQb ? qbMatrix(ref.gsis_id) : receiverMatrix(ref.gsis_id)).filter((c) => c.window === window);
  const defCellsAll = defensePassMatrix(opponent);
  const defWindow = defCellsAll.some((c) => c.window === window) ? window : "career";
  const defCells = defCellsAll.filter((c) => c.window === defWindow);
  if (playerCells.length === 0 || defCells.length === 0) {
    return { ...meta, player: ref, opponent: opponent.toUpperCase(), availability: "NOT_AVAILABLE" as const };
  }

  const baselines = leagueBaselines().filter((b) => b.window === window || b.window === "career");
  const defKey = (c: DefensePassCell) => `${c.depth_bin}|${c.field_third}`;
  const defMap = new Map(defCells.map((c) => [defKey(c), c]));
  const baseMap = new Map(
    baselines.map((b) => [`${b.depth_bin}|${b.field_third}`, Number(b.epa_per_attempt ?? 0)]),
  );

  // league-average allowed EPA/target as the defensive reference
  const leagueDefEpa =
    defCellsAll.filter((c) => c.window === defWindow && c.epa_per_target_allowed != null)
      .reduce((s, c, _i, arr) => s + (c.epa_per_target_allowed ?? 0) / arr.length, 0);

  let overlap = 0;
  let weight = 0;
  const cellRows = DEPTHS.flatMap((d) =>
    THIRDS.map((t) => {
      const pc = playerCells.find((c) => c.depth_bin === d && c.field_third === t);
      const dc = defMap.get(`${d}|${t}`);
      const share = pc?.attempt_share ?? 0;
      const defEpaAllowed = dc?.epa_per_target_allowed ?? null;
      const defDelta = defEpaAllowed == null ? null : defEpaAllowed - leagueDefEpa;
      const lowSample = (pc?.evidence_class ?? "INSUFFICIENT") === "INSUFFICIENT" ||
        (dc?.evidence_class ?? "INSUFFICIENT") === "INSUFFICIENT";
      if (defDelta != null && !lowSample) { overlap += share * defDelta; weight += share; }
      return {
        depth_bin: d, field_third: t,
        player_attempt_share: pc?.attempt_share ?? null,
        player_epa: pc?.epa_per_attempt ?? null,
        player_evidence: pc?.evidence_class ?? "INSUFFICIENT",
        defense_epa_per_target_allowed: defEpaAllowed,
        defense_vs_league_delta: defDelta,
        defense_evidence: dc?.evidence_class ?? "INSUFFICIENT",
        league_baseline_epa: baseMap.get(`${d}|${t}`) ?? null,
      };
    }),
  );

  const alignmentScore = weight > 0 ? overlap / weight : null;
  const strongCells = cellRows.filter(
    (r) => (r.player_attempt_share ?? 0) >= 0.06 && (r.defense_vs_league_delta ?? 0) > 0.02 &&
      r.player_evidence !== "INSUFFICIENT" && r.defense_evidence !== "INSUFFICIENT",
  );

  return {
    ...meta,
    player: ref,
    opponent: opponent.toUpperCase(),
    window,
    defense_window_used: defWindow,
    cells: cellRows,
    alignment: {
      // where the player throws/targets, weighted by how far the defense is
      // from league-average allowed EPA there. Positive = player's volume
      // areas are areas this defense has been softer than average.
      tendency_overlap_score: alignmentScore,
      overlap_areas: strongCells.map((c) => `${c.depth_bin}_${c.field_third}`),
      interpretation:
        alignmentScore == null
          ? "INSUFFICIENT_SAMPLE for an overlap read"
          : alignmentScore > 0.03
            ? "Player's high-volume areas overlap areas this defense has allowed above-average efficiency."
            : alignmentScore < -0.03
              ? "Player's high-volume areas are areas this defense has defended better than average."
              : "No material overlap between the player's volume areas and this defense's soft/strong areas.",
      // HARD guardrails (spec §24, §33, §35): this is a descriptive overlap of
      // two observed profiles, NOT an out-of-sample-validated interaction.
      numeric_fantasy_adjustment: 0 as const,
      deployment: "SHADOW_ONLY" as const,
      validation_status: "SHARED_DESCRIPTIVE" as const,
      caveat:
        "Tendency overlap only. NOT the Tier D validated player x scheme interaction model. Does not account for role, opponent strength, or the production projection baseline. No production influence.",
    },
    lineage: {
      player_source: isQb ? "qb_spatial_matrix.csv" : "receiver_spatial_matrix.csv",
      defense_source: "defense_pass_vulnerability.csv",
      as_of: `${meta.as_of_season} w${meta.as_of_week}`,
      current_season_status: meta.current_season_status,
    },
  };
}
