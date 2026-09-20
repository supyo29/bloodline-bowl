/** Phase 3.5C — Player Role & Opportunity evidence. Frozen Phase 2 model; this only exposes it. */
import { loadRoleOpportunitySnapshot } from "@/lib/player-role-intelligence/read";
import { buildRoleOpportunityIntelligenceLineage } from "@/lib/player-role-intelligence/lineage";
import type { DimensionProfile, PlayerRoleProfile } from "@/lib/player-role-intelligence/schema";
import { analysisClassFor, confidenceFor, sampleSupportFor } from "../vocabulary";
import { classifyIdentity } from "../identity";
import { unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { ChangeContext, Component, ComparisonContext, EvidenceBlock, HistoryPoint, Population } from "../schema";
import { PHASE7, refreshLag, currentTemporal, historyPointsSorted, mk, notAvailable, num, readCurrentCsv, readSnapshotCsv, snapshotTemporal, weeklySnapshots, type QueryContext } from "../common";
import { listSnapshots } from "../snapshots";

const SURFACE = "role-opportunity";
const BUILT_IN = phaseRef("INTELLIGENCE_MODERNIZATION_PHASE", "2");
const DEPLOYMENT = { state: "SHARED_CONTEXT", may_influence_production: false } as const;

/** dimension path in the profile -> (unit key, per-game column in player_game_role.csv or null if none) */
interface Dim { path: string; get: (p: PlayerRoleProfile) => DimensionProfile | null | undefined; unit: string; game_col: string | null; csv_prefix: string }
const DIMS: Dim[] = [
  { path: "participation.snap_share", get: (p) => p.participation, unit: "role.snap_share", game_col: "snap_share_derived", csv_prefix: "participation_snap_share" },
  { path: "receiving.target_share", get: (p) => p.receiving?.target_share, unit: "role.target_share", game_col: "target_share", csv_prefix: "receiving_target_share" },
  { path: "receiving.position_group_target_share", get: (p) => p.receiving?.position_group_target_share, unit: "role.position_group_target_share", game_col: "position_group_target_share", csv_prefix: "receiving_position_group_target_share" },
  { path: "receiving.air_yards_share", get: (p) => p.receiving?.air_yards_share, unit: "role.air_yards_share", game_col: "air_yards_share", csv_prefix: "receiving_air_yards_share" },
  { path: "receiving.route_participation", get: (p) => p.receiving?.route_participation, unit: "role.route_participation", game_col: "route_participation", csv_prefix: "receiving_route_participation" },
  { path: "rushing.rush_share", get: (p) => p.rushing?.rush_share, unit: "role.rush_share", game_col: "rush_share", csv_prefix: "rushing_rush_share" },
  { path: "rushing.position_group_rush_share", get: (p) => p.rushing?.position_group_rush_share, unit: "role.position_group_rush_share", game_col: "position_group_rush_share", csv_prefix: "rushing_position_group_rush_share" },
  { path: "high_value.rz_target_share", get: (p) => p.high_value?.rz_target_share, unit: "role.rz_target_share", game_col: null, csv_prefix: "high_value_rz_target_share" },
  { path: "high_value.rz_carry_share", get: (p) => p.high_value?.rz_carry_share, unit: "role.rz_carry_share", game_col: null, csv_prefix: "high_value_rz_carry_share" },
  { path: "returns.kick_return_role", get: (p) => p.returns.kick_return_role, unit: "role.kick_return_role", game_col: null, csv_prefix: "returns_kick_return_role" },
  { path: "returns.punt_return_role", get: (p) => p.returns.punt_return_role, unit: "role.punt_return_role", game_col: null, csv_prefix: "returns_punt_return_role" },
];
export const ROLE_DIMENSION_PATHS = DIMS.map((d) => d.path);

export interface RoleQuery { gsis_id?: string; sleeper_id?: string; dimensions?: string[]; history?: boolean; comparisons?: boolean }

function ctxOf() {
  const snap = loadRoleOpportunitySnapshot(); if (!snap) return null;
  const lineage = buildRoleOpportunityIntelligenceLineage(snap)!;
  return { snap, lineage, m: snap.manifest };
}
type C = NonNullable<ReturnType<typeof ctxOf>>;
const fresh = (c: C) => ({ as_of: c.m.generated_at, through_week: c.m.through_week, generated_at: c.m.generated_at, week_completion: c.lineage.week_completion, refresh_lag_weeks: refreshLag(c.m.through_week) });
const temporal = (c: C, snapshotted = false) => currentTemporal({ season: c.m.season, through_week: c.m.through_week, generated_at: c.m.generated_at, source_cutoff: c.m.source_cutoffs, week_state: c.m.week_completion?.week_state ?? null }, snapshotted);
const lineageOf = (c: C) => ({ surface_version: c.m.role_opportunity_version, canonical: c.lineage, content_identity: null as string | null });

export function roleProfileEvidence(q: RoleQuery, ctx: QueryContext): EvidenceBlock[] {
  const c = ctxOf();
  if (!c) return [];
  const p = c.snap.getPlayerRoleProfile({ gsis_id: q.gsis_id ?? null, sleeper_id: q.sleeper_id ?? null });
  const idIn = q.gsis_id ?? q.sleeper_id ?? "unknown";
  if (!p) return [notAvailable({ surface: SURFACE, topic: "role.player_profile", metric: "*", subject: { kind: "PLAYER", id: idIn, identity: classifyIdentity({ source_player_id: idIn }) }, deployment: DEPLOYMENT, freshness: fresh(c), temporal: temporal(c), lineage: lineageOf(c), source: { built_in: BUILT_IN }, limitations: [] }, "UNAVAILABLE", "no current Role Intelligence profile for this player (unknown player — never backfilled from another season)")];
  const identity = classifyIdentity({ canonical_player_id: `player:gsis:${p.identity.gsis_id}`, source_player_id: p.identity.gsis_id, source_id_type: "gsis", name: p.identity.full_name, position: p.identity.position, team: p.identity.team });
  const subject = { kind: "PLAYER" as const, id: p.identity.gsis_id, identity, team: p.identity.team };
  const wanted = new Set(q.dimensions ?? []);
  const out: EvidenceBlock[] = [];
  for (const d of DIMS) {
    if (wanted.size && !wanted.has(d.path)) continue;
    const dim = d.get(p);
    if (dim === undefined || dim === null) { out.push(notAvailable(common(c, subject, d), "NOT_APPLICABLE", `${d.path} does not apply to a ${p.identity.position} (Phase 2 structural rule)`)); continue; }
    out.push(dimensionBlock(c, subject, p, d, dim, q, ctx));
  }
  // role state (categorical, with transition vs previous preserved state)
  if (!wanted.size || wanted.has("role_state.role_level")) out.push(roleLevelBlock(c, subject, p, q, ctx));
  return out;
}

function common(c: C, subject: EvidenceBlock["subject"], d: Dim) {
  return { surface: SURFACE, topic: "role.player_profile", metric: d.path, subject, deployment: DEPLOYMENT, freshness: fresh(c), temporal: temporal(c), lineage: lineageOf(c), source: { artifact: "lib/player-role-intelligence/data/player_role_profile.csv", built_in: BUILT_IN, source_data: "nflverse pbp + snap counts (route participation is a proxy)" }, limitations: [] as string[] };
}

function dimensionBlock(c: C, subject: EvidenceBlock["subject"], p: PlayerRoleProfile, d: Dim, dim: DimensionProfile, q: RoleQuery, ctx: QueryContext): EvidenceBlock {
  const unit = unitFor(d.unit);
  const base = common(c, subject, d);
  const routeLag = d.path === "receiving.route_participation" && p.source_availability.route_evidence === "ROUTE_CORROBORATION_UNAVAILABLE";
  if (dim.latest === null) {
    return notAvailable({ ...base, model_confidence: confidenceFor("ROLE", dim.confidence), sample_support: sampleSupportFor("role.evidence_state", dim.evidence_state, dim.n_games_season) },
      routeLag ? "EXPECTED_SOURCE_LAG" : "INSUFFICIENT_SAMPLE", routeLag ? "route source (nflverse participation) has not published for the current period; never fabricated" : `no current observation for ${d.path}`);
  }
  const trends: Component[] = [
    { key: "recent", label: "EWMA recent horizon", value: dim.recent, unit, analysis_class: analysisClassFor("ROLE", "EWMA_HORIZON"), source_class: "EWMA_HORIZON" },
    { key: "season", label: "season-to-date horizon", value: dim.season, unit, analysis_class: analysisClassFor("ROLE", "EWMA_HORIZON"), source_class: "EWMA_HORIZON" },
    { key: "prior", label: "prior-season role", value: dim.prior, unit, analysis_class: analysisClassFor("ROLE", "EWMA_HORIZON"), source_class: "EWMA_HORIZON", note: `prior_role_confidence=${dim.prior_role_confidence}, discontinuity=${dim.discontinuity}` },
    { key: "delta_latest_vs_recent", value: dim.delta_latest_vs_recent, unit: unitFor("role.delta") },
    { key: "opportunity_total", value: dim.opportunity_total, unit: unitFor("role.opportunity_total") },
    { key: "n_games_season", value: dim.n_games_season, unit: unitFor("role.n_games_season") },
  ];
  const block: EvidenceBlock = mk({
    ...base, availability: { state: "AVAILABLE" }, value: dim.latest, unit,
    origin: { source_class: "LATEST_OBSERVED", analysis_class: analysisClassFor("ROLE", "LATEST_OBSERVED") },
    model_confidence: confidenceFor("ROLE", dim.confidence),
    sample_support: sampleSupportFor("role.evidence_state", dim.evidence_state, dim.n_games_season),
    // Role is a descriptive context layer, never a validated predictive family and never production-influencing.
    predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" },
    components: trends,
    limitations: [...(identity(subject) ), ...(d.unit === "role.snap_share" ? [unit.note!] : []), ...(routeLag ? [] : [])].filter(Boolean),
    relationships: [{ type: "UPSTREAM_OF", target: { surface: "opportunity-propagation", version: null, note: "Opportunity Propagation redistributes these observed shares conditionally" } }, { type: "COMPARABLE_TO", target: { surface: "football-intelligence", topic: "fi.player_usage" } }],
    chart: [{ form: "line", x: "temporal.through_week", y: "value", unit: unit.display_unit, domain: unit.valid_range && unit.valid_range[0] !== null && unit.valid_range[1] !== null ? [unit.valid_range[0], unit.valid_range[1]] : null }, { form: "bar", x: "components.key", y: "components.value" }],
  }, [d.path]);
  const changes: ChangeContext[] = [
    { comparison_period: "RECENT_HORIZON_TO_LATEST", prior_value: dim.recent, current_value: dim.latest, absolute_delta: dim.delta_latest_vs_recent, relative_delta: null, significance: { status: `trend:${dim.trend_latest_vs_recent}`, source: "MODEL_SUPPLIED" } },
    { comparison_period: "SEASON_BASELINE_TO_LATEST", prior_value: dim.season, current_value: dim.latest, absolute_delta: dim.season === null ? null : dim.latest - dim.season, relative_delta: null, significance: { status: `trend:${dim.trend_latest_vs_season}`, source: "MODEL_SUPPLIED" } },
    { comparison_period: "PRIOR_SEASON_TO_RECENT", prior_value: dim.prior, current_value: dim.recent, absolute_delta: dim.prior === null || dim.recent === null ? null : dim.recent - dim.prior, relative_delta: null, significance: { status: `trend:${dim.trend_recent_vs_prior}`, source: "MODEL_SUPPLIED" } },
  ];
  block.change = changes;
  if (q.comparisons ?? ctx.comparisons) block.comparison = comparisonsFor(c, p, d, dim.latest, unit);
  if (q.history ?? ctx.history) block.history = historyFor(c, p, d, dim, ctx);
  return block;
}
const identity = (s: EvidenceBlock["subject"]): string[] => (s.identity && s.identity.resolution !== "RESOLVED" ? [`identity ${s.identity.resolution}: ${s.identity.limitations.join("; ")}`] : []);

function comparisonsFor(c: C, p: PlayerRoleProfile, d: Dim, latest: number, unit: ReturnType<typeof unitFor>): ComparisonContext[] {
  const mk1 = (id: string, definition: string, filter: (x: PlayerRoleProfile) => boolean): ComparisonContext | null => {
    const vals = c.snap.profiles.filter(filter).map((x) => d.get(x)?.latest).filter((v): v is number => typeof v === "number");
    if (vals.length < 2) return null;
    const population: Population = { id, season: c.m.season, through_week: c.m.through_week, n: vals.length, definition };
    return { population, rank: { position: 1 + vals.filter((v) => v > latest).length, of: vals.length, order: "VALUE_DESCENDING" }, percentile: { value: vals.filter((v) => v < latest).length / vals.length, scale: "FRACTION_0_1", source: "COMPUTED", orientation: "VALUE_ORIENTED" }, baseline: { kind: "POPULATION_MEDIAN", value: [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)] ?? null } };
  };
  const pos = p.identity.position, team = p.identity.team;
  return [
    mk1(`NFL_${pos}`, `all ${pos} with a current ${d.path} observation`, (x) => x.identity.position === pos),
    mk1(`${team}_${pos}`, `${team} ${pos} (team-relative)`, (x) => x.identity.position === pos && x.identity.team === team),
  ].filter((x): x is ComparisonContext => !!x);
}

function historyFor(c: C, p: PlayerRoleProfile, d: Dim, dim: DimensionProfile, ctx: QueryContext): EvidenceBlock["history"] {
  const pts: HistoryPoint[] = [];
  // 1) preserved published STATES (latest revision per completed week)
  const { entries } = weeklySnapshots(SURFACE, ctx.root);
  for (const e of entries) {
    const row = readSnapshotCsv(ctx.root, e, "player_role_profile.csv").find((x) => x.gsis_id === p.identity.gsis_id);
    if (!row) continue;
    pts.push({ temporal: snapshotTemporal(e), value: num(row[`${d.csv_prefix}_latest`]), source_class: "LATEST_OBSERVED", components: [{ key: "recent", value: num(row[`${d.csv_prefix}_recent`]) }, { key: "season", value: num(row[`${d.csv_prefix}_season`]) }, { key: "confidence", value: row[`${d.csv_prefix}_confidence`] ?? null }] });
  }
  const preserved = new Set(listSnapshots(SURFACE, ctx.root).map((e) => e.version));
  if (!preserved.has(c.m.role_opportunity_version)) pts.push({ temporal: temporal(c, false), value: dim.latest, source_class: "LATEST_OBSERVED" });
  // 2) native per-game OBSERVATIONS (immutable facts keyed by their own game/week) from the latest preserved substrate
  let nativeCount = 0;
  if (d.game_col) {
    const latestSnap = entries[entries.length - 1];
    const rows = latestSnap ? readSnapshotCsv(ctx.root, latestSnap, "player_game_role.csv") : readCurrentCsv(ctx.root, "lib/player-role-intelligence/data/player_game_role.csv");
    for (const r of rows.filter((x) => x.gsis_id === p.identity.gsis_id)) {
      const week = num(r.week); const season = num(r.season); const v = num(r[d.game_col]); if (week === null || season === null) continue;
      nativeCount++;
      pts.push({ temporal: { season, week, through_week: week, as_of: null, generated_at: latestSnap?.generated_at ?? c.m.generated_at, point_kind: "NATIVE_OBSERVATION", as_of_kind: "OBSERVED_FACT", week_state: "COMPLETE", snapshot_id: null, player_team_temporal_identity: PHASE7 }, value: v, source_class: "OBSERVED_GAME", availability: v === null ? "UNAVAILABLE" : "AVAILABLE" });
    }
  }
  return { class: "NATIVE_HISTORY", points: historyPointsSorted(pts), note: `POINT_IN_TIME_STATE points are published Role states (immutable snapshots); ${nativeCount} NATIVE_OBSERVATION per-game point(s) come from the preserved substrate${d.game_col ? "" : " (no per-game column exists for this dimension: state history only)"}. Coverage starts with the 2026 season in the served artifact.` };
}

function roleLevelBlock(c: C, subject: EvidenceBlock["subject"], p: PlayerRoleProfile, q: RoleQuery, ctx: QueryContext): EvidenceBlock {
  const rs = p.role_state; const base = { surface: SURFACE, topic: "role.player_profile", metric: "role_state.role_level", subject, deployment: DEPLOYMENT, freshness: fresh(c), temporal: temporal(c), lineage: lineageOf(c), source: { artifact: "lib/player-role-intelligence/data/player_role_profile.csv", built_in: BUILT_IN }, limitations: identity(subject) };
  if (rs.role_level === null) return notAvailable({ ...base, sample_support: sampleSupportFor("role.evidence_state", rs.evidence_state) }, "INSUFFICIENT_SAMPLE", "no role level assigned");
  const block = mk({ ...base, availability: { state: "AVAILABLE" }, value: rs.role_level, unit: unitFor("category"), category: { raw: rs.role_level, normalized: null, mapping_status: "NO_VERIFIED_MAPPING" },
    origin: { source_class: "LATEST_OBSERVED", analysis_class: "DESCRIPTIVE" }, sample_support: sampleSupportFor("role.evidence_state", rs.evidence_state),
    predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" }, components: [{ key: "role_trend", value: rs.role_trend }], limitations: [...base.limitations, "role_level is an ordered label (MINIMAL<ROTATIONAL<REGULAR<FEATURED<PRIMARY); it is not a numeric score"] });
  if (q.history ?? ctx.history) {
    const { entries } = weeklySnapshots(SURFACE, ctx.root); const pts: HistoryPoint[] = [];
    for (const e of entries) { const row = readSnapshotCsv(ctx.root, e, "player_role_profile.csv").find((x) => x.gsis_id === p.identity.gsis_id); if (row) pts.push({ temporal: snapshotTemporal(e), value: row.role_level || null, source_class: "LATEST_OBSERVED" }); }
    const preserved = new Set(listSnapshots(SURFACE, ctx.root).map((e) => e.version));
    if (!preserved.has(c.m.role_opportunity_version)) pts.push({ temporal: temporal(c, false), value: rs.role_level });
    block.history = { class: "NATIVE_HISTORY", points: historyPointsSorted(pts), note: "categorical states; changes are transitions, not numeric deltas" };
    const prev = pts.filter((x) => x.temporal.point_kind === "POINT_IN_TIME_STATE" && x.value).pop();
    if (prev && prev.value !== rs.role_level) block.change = [{ comparison_period: "PREVIOUS_PRESERVED_WEEK_STATE", prior_value: prev.value, current_value: rs.role_level, absolute_delta: null, relative_delta: null, transition: { from: String(prev.value), to: rs.role_level }, significance: null }];
  }
  return block;
}

/** Role change events (already produced by the model). */
export function roleChangeEvidence(q: RoleQuery): EvidenceBlock[] {
  const c = ctxOf(); if (!c) return [];
  const p = c.snap.getPlayerRoleProfile({ gsis_id: q.gsis_id ?? null, sleeper_id: q.sleeper_id ?? null });
  const ev = c.snap.getPlayerRoleChanges({ gsis_id: q.gsis_id ?? null, sleeper_id: q.sleeper_id ?? null });
  const subject = { kind: "PLAYER" as const, id: p?.identity.gsis_id ?? q.gsis_id ?? "unknown", identity: classifyIdentity({ source_player_id: p?.identity.gsis_id ?? q.gsis_id, name: p?.identity.full_name, position: p?.identity.position, team: p?.identity.team }) };
  return ev.map((e) => {
    const dimKey = DIMS.find((d) => d.path.endsWith(`.${e.dimension}`) || d.path === e.dimension);
    const unit = dimKey ? unitFor(dimKey.unit) : unitFor("role.delta");
    return mk({ surface: SURFACE, topic: "role.role_change", metric: `${e.domain}.${e.dimension}`, subject, availability: { state: "AVAILABLE" }, value: e.delta, unit: unitFor("role.delta"),
      origin: { source_class: "LATEST_OBSERVED", analysis_class: "DESCRIPTIVE" }, model_confidence: confidenceFor("ROLE", e.confidence), sample_support: sampleSupportFor("role.evidence_state", e.evidence_state, e.n_games_season),
      predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" }, deployment: DEPLOYMENT, freshness: fresh(c), temporal: temporal(c), lineage: lineageOf(c), source: { artifact: "lib/player-role-intelligence/data/player_role_change.csv", built_in: BUILT_IN },
      components: [{ key: "latest", value: e.latest, unit }, { key: "baseline_recent", value: e.baseline_recent, unit }, { key: "baseline_season", value: e.baseline_season, unit }, { key: "baseline_prior", value: e.baseline_prior, unit }, { key: "trend", value: e.trend }, { key: "opportunity_total", value: e.opportunity_total, unit: unitFor("role.opportunity_total") }],
      change: [{ comparison_period: "LATEST_VS_BASELINES", prior_value: e.baseline_recent, current_value: e.latest, absolute_delta: e.delta, relative_delta: null, significance: { status: `trend:${e.trend}`, source: "MODEL_SUPPLIED" } }],
      limitations: identity(subject) }, [e.domain, e.dimension]);
  });
}
