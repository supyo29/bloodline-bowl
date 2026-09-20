/** Phase 3.5C — Football Intelligence evidence (team metrics + player usage). Read-only over the authoritative reader. */
import { loadFootballIntelligence } from "@/lib/football-intel/read";
import { buildFootballIntelligenceLineage } from "@/lib/football-intel/lineage";
import type { TeamMetricRating } from "@/lib/football-intel/schema";
import { analysisClassFor, compoundPredictive, confidenceFor } from "../vocabulary";
import { classifyIdentity } from "../identity";
import { fiTeamUnit, registeredFiTeamMetrics, unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { ChangeContext, Component, ComparisonContext, EvidenceBlock, HistoryPoint, Population } from "../schema";
import { currentTemporal, deviationUnit, historyPointsSorted, mk, notAvailable, num, readSnapshotCsv, snapshotTemporal, weeklySnapshots, type QueryContext } from "../common";
import { listSnapshots } from "../snapshots";

const SURFACE = "football-intelligence";
const BUILT_IN = phaseRef("FOOTBALL_INTELLIGENCE_PHASE", "3");
const DEPLOYMENT = { state: "SHARED_DESCRIPTIVE", may_influence_production: false } as const;

export interface FiTeamQuery { team: string; metrics?: string[]; side?: "offense" | "defense"; history?: boolean; comparisons?: boolean }

function fiCtx() {
  const fi = loadFootballIntelligence();
  if (!fi) return null;
  const lineage = buildFootballIntelligenceLineage(fi);
  return { fi, lineage: lineage!, m: fi.manifest };
}

export function fiTeamMetricEvidence(q: FiTeamQuery, ctx: QueryContext): EvidenceBlock[] {
  const c = fiCtx();
  const subject = { kind: "TEAM" as const, id: q.team.toUpperCase(), team: q.team.toUpperCase() };
  if (!c) return [notAvailable({ surface: SURFACE, topic: "fi.team_metric", metric: "*", subject, deployment: DEPLOYMENT, freshness: { as_of: null, through_week: null, generated_at: null }, temporal: currentTemporal({ season: null, through_week: null, generated_at: null }, false), lineage: { surface_version: null }, source: { built_in: BUILT_IN }, limitations: [] }, "UNAVAILABLE", "Football Intelligence snapshot is not published")];
  const profile = c.fi.team(subject.id);
  if (!profile) return [notAvailable({ surface: SURFACE, topic: "fi.team_metric", metric: "*", subject, deployment: DEPLOYMENT, freshness: fresh(c), temporal: curTemporal(c), lineage: lin(c), source: { built_in: BUILT_IN }, limitations: [] }, "UNAVAILABLE", `no FI profile for team ${subject.id}`)];

  const sides = q.side ? [q.side] : (["offense", "defense"] as const);
  const wanted = new Set(q.metrics ?? []);
  const out: EvidenceBlock[] = [];
  for (const side of sides) for (const [metric, r] of Object.entries(profile[side])) {
    if (wanted.size && !wanted.has(metric)) continue;
    if (!registeredFiTeamMetrics().includes(metric)) { out.push(notAvailable({ surface: SURFACE, topic: "fi.team_metric", metric, subject, deployment: DEPLOYMENT, freshness: fresh(c), temporal: curTemporal(c), lineage: lin(c), source: { built_in: BUILT_IN }, limitations: [] }, "UNAVAILABLE", `metric ${metric} has no registered unit (explicit units are required)`, "UNSUPPORTED")); continue; }
    out.push(teamMetricBlock(c, subject, side, metric, r, q, ctx));
  }
  return out;
}

const fresh = (c: NonNullable<ReturnType<typeof fiCtx>>) => ({ as_of: c.m.generated_at, through_week: c.m.through_week, generated_at: c.m.generated_at, week_completion: c.lineage.week_completion });
const curTemporal = (c: NonNullable<ReturnType<typeof fiCtx>>, snapshotted = false) => currentTemporal({ season: c.m.season, through_week: c.m.through_week, generated_at: c.m.generated_at, source_cutoff: c.m.data_cutoff, week_state: c.lineage.week_completion?.week_state ?? null }, snapshotted);
const lin = (c: NonNullable<ReturnType<typeof fiCtx>>) => ({ surface_version: c.m.football_intelligence_version, canonical: c.lineage });

function teamMetricBlock(c: NonNullable<ReturnType<typeof fiCtx>>, subject: EvidenceBlock["subject"], side: "offense" | "defense", metric: string, r: TeamMetricRating, q: FiTeamQuery, ctx: QueryContext): EvidenceBlock {
  const base = fiTeamUnit(metric);
  const unit = deviationUnit(base);
  const compound = compoundPredictive(r.predictive_status, "SHARED_DESCRIPTIVE");
  const common = { surface: SURFACE, topic: "fi.team_metric", metric: `${metric}.modeled`, subject, deployment: DEPLOYMENT, freshness: fresh(c), temporal: curTemporal(c), lineage: lin(c), source: { artifact: "lib/football-intel/data/team_profile.csv", built_in: BUILT_IN, source_data: "nflverse play-by-play (opponent-adjusted, prior-informed, recency-weighted, shrunk)" }, limitations: [] as string[] };
  if (r.modeled === null) {
    return notAvailable({ ...common, model_confidence: confidenceFor("FI", r.confidence) }, "EXPECTED_SOURCE_LAG", `${metric} has no current-season value yet (its source has not published for the current week)`);
  }
  const components: Component[] = [
    { key: "raw", label: "observed per-period value", value: r.raw, unit: base, analysis_class: "OBSERVED", source_class: "OBSERVED" },
    { key: "league_mean", value: r.league_mean, unit: base },
    { key: "prior_mean", value: r.prior_mean, unit: base, note: `${r.prior_n_seasons ?? 0} prior season(s), discount ${r.prior_discount}` },
    { key: "prior_weight", value: r.prior_weight }, { key: "recent_weight", value: r.recent_weight }, { key: "shrunk_to_league", value: r.shrunk_to_league },
    { key: "trend_current_level", value: r.trend.current_level, unit: deviationUnit(base) }, { key: "trend_recent_level", value: r.trend.recent_level, unit: deviationUnit(base) },
    { key: "trend_direction", value: r.trend.direction }, { key: "trend_magnitude", value: r.trend.magnitude }, { key: "trend_confidence", value: r.trend.confidence },
  ];
  const block: EvidenceBlock = mk({
    ...common, availability: { state: "AVAILABLE" }, value: r.modeled, unit,
    origin: { source_class: r.output_class, analysis_class: analysisClassFor("FI", r.output_class) },
    model_confidence: confidenceFor("FI", r.confidence),
    sample_support: { basis: "fi.n_obs_effective", n: r.n_obs_effective },
    predictive: { source_status: compound.source_status, class: compound.class },
    components,
    uncertainty: { kind: "STANDARD_ERROR", value: r.std_error, note: "posterior standard error of the shrunk estimate (same unit as the deviation)" },
    limitations: [...common.limitations, ...(r.raw === null ? ["no current-season observation for this metric: the modeled value is driven by the prior (it will not move week to week until the source publishes)"] : []), ...(r.confidence === "INSUFFICIENT_SAMPLE" ? ["confidence is INSUFFICIENT_SAMPLE for the current period"] : []), "value is a deviation from the league mean (modeled), not the raw rate; raw is in components"],
    relationships: [{ type: "DESCRIBES", target: { surface: "matchup-intelligence" } }, { type: "COMPARABLE_TO", target: { surface: SURFACE, topic: "fi.team_metric", note: `same metric, other ${side} units` } }],
    chart: [{ form: "line", x: "temporal.through_week", y: "value", unit: base.display_unit }, { form: "percentile", y: "comparison.percentile.value", domain: [0, 1] }],
  }, [side]);

  // ---- comparison (population explicit) — on demand
  if (q.comparisons ?? ctx.comparisons) {
    const pop = c.fi.teams().map((t) => t[side][metric]).filter((x): x is TeamMetricRating => !!x && x.modeled !== null);
    const population: Population = { id: `NFL_${side.toUpperCase()}_TEAMS`, season: c.m.season, through_week: c.m.through_week, n: pop.length, definition: `all NFL teams with a current modeled ${metric}` };
    const order = "VALUE_DESCENDING" as const;
    const rank = 1 + pop.filter((p) => (p.modeled as number) > (r.modeled as number)).length;
    const cmp: ComparisonContext = {
      population, rank: { position: rank, of: pop.length, order },
      percentile: r.league_percentile === null ? null : { value: r.league_percentile, scale: "FRACTION_0_1", source: "SOURCE_NATIVE", orientation: base.percentile_orientation! },
      baseline: { kind: "LEAGUE_MEAN", value: r.league_mean }, delta_vs_baseline: r.raw !== null && r.league_mean !== null ? r.raw - r.league_mean : null,
    };
    block.comparison = [cmp];
  }
  // ---- history from the immutable store
  if (q.history ?? ctx.history) {
    const { entries, revisions } = weeklySnapshots(SURFACE, ctx.root);
    const pts: HistoryPoint[] = [];
    for (const e of entries) {
      const row = readSnapshotCsv(ctx.root, e, "team_profile.csv").find((x) => x.team === subject.id && x.metric === metric && x.side === side);
      if (!row) continue;
      const v = num(row.modeled);
      pts.push({ temporal: snapshotTemporal(e), value: v, source_class: row.output_class, availability: v === null ? "EXPECTED_SOURCE_LAG" : "AVAILABLE", components: [{ key: "raw", value: num(row.raw), unit: base }, { key: "league_percentile", value: num(row.league_percentile), unit: unitFor("fi.percentile") }, { key: "confidence", value: row.confidence ?? null }] });
    }
    const snapVersions = new Set(listSnapshots(SURFACE, ctx.root).map((e) => e.version));
    if (!snapVersions.has(c.m.football_intelligence_version)) pts.push({ temporal: curTemporal(c, false), value: r.modeled, source_class: r.output_class, availability: "AVAILABLE" });
    block.history = { class: pts.length ? "NATIVE_HISTORY" : "CURRENT_ONLY", points: historyPointsSorted(pts), note: `points are states the system actually published (immutable snapshots, latest revision per completed week; revisions per week: ${JSON.stringify(revisions)}). Coverage starts with the 2026 season; earlier seasons are not preserved. The current point is labelled CURRENT_UNSNAPSHOTTED until its week completes.` };
    // ---- change: previous preserved state -> current
    const prev = [...pts].filter((p) => p.temporal.point_kind === "POINT_IN_TIME_STATE" && typeof p.value === "number").pop();
    if (prev && typeof prev.value === "number") {
      const change: ChangeContext = { comparison_period: "PREVIOUS_PRESERVED_WEEK_STATE", prior_value: prev.value, current_value: r.modeled, absolute_delta: r.modeled - prev.value, relative_delta: null, significance: { status: `trend:${r.trend.direction}/${r.trend.confidence}`, source: "MODEL_SUPPLIED" } };
      block.change = [change];
    }
  }
  return block;
}

/* --------------------------------------------------------------------------------------------- player usage */
export interface FiUsageQuery { gsis_id?: string; sleeper_id?: string; metrics?: string[]; history?: boolean; comparisons?: boolean }
const USAGE_UNITS: Record<string, string> = { snap_share: "fi.usage.snap_share", target_share: "fi.usage.target_share", rush_share: "fi.usage.rush_share", air_yards_share: "fi.usage.air_yards_share", route_participation: "fi.usage.route_participation", rz_target_share: "fi.usage.rz_target_share", rz_carry_share: "fi.usage.rz_carry_share", deep_att_rate: "fi.usage.deep_att_rate", designed_rush_rate: "fi.usage.designed_rush_rate" };

export function fiPlayerUsageEvidence(q: FiUsageQuery, ctx: QueryContext): EvidenceBlock[] {
  const c = fiCtx(); if (!c) return [];
  const u = c.fi.playerUsage({ gsis_id: q.gsis_id ?? null, sleeper_id: q.sleeper_id ?? null });
  const identity = classifyIdentity({ canonical_player_id: u.gsis_id ? `player:gsis:${u.gsis_id}` : null, source_player_id: u.gsis_id || u.sleeper_id, source_id_type: u.gsis_id ? "gsis" : "sleeper", name: u.full_name, position: u.position, team: u.nfl_team });
  const subject = { kind: "PLAYER" as const, id: u.gsis_id || u.sleeper_id || "unknown", identity };
  const common = { surface: SURFACE, topic: "fi.player_usage", subject, deployment: DEPLOYMENT, freshness: fresh(c), lineage: lin(c), source: { artifact: "lib/football-intel/data/player_usage_profile.csv", built_in: BUILT_IN, source_data: "nflverse pbp + snap counts" } };
  const metrics = Object.values(u.metrics);
  if (!metrics.length) return [notAvailable({ ...common, metric: "*", temporal: curTemporal(c), limitations: [] }, "UNAVAILABLE", "no FI usage profile for this player")];
  const wanted = new Set(q.metrics ?? []);
  return metrics.filter((m) => !wanted.size || wanted.has(m.metric)).map((m) => {
    const key = USAGE_UNITS[m.metric];
    if (!key) return notAvailable({ ...common, metric: m.metric, temporal: curTemporal(c), limitations: [] }, "UNAVAILABLE", `usage metric ${m.metric} has no registered unit`, "UNSUPPORTED");
    const unit = unitFor(key);
    // headline value follows the (corrected) class: an observation when one exists, otherwise the shrunk modeled value.
    const observed = m.observed !== null;
    const value = observed ? m.observed : m.modeled;
    const lims = [...(identity.resolution !== "RESOLVED" ? [`identity ${identity.resolution}: ${identity.limitations.join("; ")}`] : []), ...(observed ? [] : ["no observation this period: value is the prior/position-shrunk modeled estimate (class MODELED)"])];
    if (value === null) return notAvailable({ ...common, metric: m.metric, temporal: curTemporal(c), limitations: lims }, "INSUFFICIENT_SAMPLE", "no observed or modeled value");
    return mk({
      ...common, metric: m.metric, temporal: curTemporal(c), availability: { state: "AVAILABLE" }, value, unit: m.metric === "air_yards_share" ? unit : unit,
      origin: { source_class: m.output_class, analysis_class: analysisClassFor("FI", m.output_class) },
      model_confidence: confidenceFor("FI", m.confidence), sample_support: { basis: "fi.usage.eff_games", n: u.eff_games },
      components: [{ key: "observed", value: m.observed, unit, analysis_class: "OBSERVED" }, { key: "modeled", value: m.modeled, unit, analysis_class: "MODELED" }, { key: "position_mean", value: m.position_mean, unit }, { key: "prior_season", value: m.prior_season, unit }, { key: "prior_weight", value: m.prior_weight }, { key: "recent_weight", value: m.recent_weight }, { key: "games", value: u.games }, { key: "last_week", value: u.last_week }],
      limitations: lims, relationships: [{ type: "COMPARABLE_TO", target: { surface: "role-opportunity", note: "Role Intelligence reports the same usage families from a different (Phase 2) substrate" } }],
      chart: [{ form: "bar", x: "metric", y: "value" }],
    }, [m.metric]);
  });
}
