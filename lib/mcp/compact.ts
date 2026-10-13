/**
 * Compactors: pure functions that reshape ONE bridge route body into the
 * task-specific `data` block of an MCP envelope.
 *
 * Rules every compactor follows:
 *  - select and relabel, never recompute: every number is copied from the body;
 *  - canonical player/team ids are labelled with names from the league's own
 *    canonical snapshot (lib/mcp/identity.ts), and the id is always kept;
 *  - status, readiness, confidence, limitation and lineage fields are kept —
 *    size is cut by dropping duplicated lineage copies, per-component score
 *    breakdowns and raw roster dumps, never by dropping uncertainty;
 *  - SHADOW_ONLY blocks are returned only via `shadow` outputs, labelled.
 */

import type { Deployment } from "./contract";
import { playerLabel, teamLabel, type LeagueDirectory } from "./identity";
import { arr, isObj, num, obj, objs, path, pick, str, strs, type J } from "./json";

export interface Compacted {
  data: J;
  deployment: Record<string, Deployment>;
  limitations: string[];
  warnings: unknown[];
  snapshot_id: string | null;
  scoring_fingerprint: string | null;
  generated_at: string | null;
  /** True when a readiness/degradation signal means the result is usable only with care. */
  limited: boolean;
  shadow?: J;
}

const P = playerLabel;

function blank(): Compacted {
  return { data: {}, deployment: {}, limitations: [], warnings: [], snapshot_id: null, scoring_fingerprint: null, generated_at: null, limited: false };
}

/** readiness map -> { key: { status, usable/actionable, limitations } } with reason prose reduced to codes. */
export function readinessSummary(readiness: unknown): { summary: J; limited: boolean; limitations: string[] } {
  const summary: J = {};
  const limitations: string[] = [];
  let limited = false;
  for (const [key, value] of Object.entries(obj(readiness))) {
    const r = obj(value);
    const status = str(r.status) ?? str(r.overall_status);
    const entry: J = { status };
    for (const flag of ["usable", "actionable"]) if (typeof r[flag] === "boolean") entry[flag] = r[flag];
    const lim = [...strs(r.limitations), ...strs(r.blocked_by), ...strs(r.blocking_reasons)];
    if (lim.length) entry.limitations = lim;
    const missing = num(r.missing_roster_players);
    if (missing) entry.missing_roster_players = missing;
    summary[key] = entry;
    if (status && !["READY", "HEALTHY", "FRESH", "CURRENT", "AVAILABLE"].includes(status)) {
      limited = true;
      limitations.push(`${key}: ${status}${lim.length ? ` (${lim.join(", ")})` : ""}`);
    } else if (lim.length) {
      limitations.push(`${key}: ${lim.join(", ")}`);
    }
    if (r.usable === false || r.actionable === false) limited = true;
  }
  return { summary, limited, limitations };
}

function snapshotLineage(lineage: unknown): { snapshot_id: string | null; scoring_fingerprint: string | null; generated_at: string | null } {
  const snap = obj(obj(lineage).snapshot);
  return { snapshot_id: str(snap.league_snapshot_id), scoring_fingerprint: str(snap.scoring_fingerprint), generated_at: str(snap.generated_at) };
}

function projectionLineage(lineage: unknown): J[] {
  return objs(obj(lineage).projections).map((p) => pick(p, ["role", "source", "model_version", "status"]));
}

/** Bridge warning objects, unchanged except prose capped. */
function warningsOf(v: unknown): unknown[] {
  return arr(v).map((w) => (isObj(w) ? pick(w, ["code", "severity", "message"]) : w));
}

/* ================================ league ================================ */

export function compactLeagues(body: unknown, currentWeek: { week: number | null; source: string }): Compacted {
  const out = blank();
  out.data = {
    current_nfl_week: currentWeek,
    identity_model: "League identity and manager identity are separate. Personalized tools need both a league and a manager.",
    leagues: objs(obj(body).leagues).map((l) => ({
      ...pick(l, ["league_slug", "league_name", "provider", "season", "config_status", "known_managers"]),
    })),
  };
  out.deployment = { leagues: "DESCRIPTIVE" };
  return out;
}

function standingsRows(directory: LeagueDirectory): J[] {
  const state = obj(directory.state_body.state);
  return objs(state.standings).map((s) => ({
    rank: num(s.rank),
    ...teamLabel(directory, s.canonical_team_id),
    ...pick(s, ["wins", "losses", "ties", "win_percentage", "points_for", "points_against", "games_played", "playoff_seed"]),
  }));
}

function matchupPairs(directory: LeagueDirectory, matchups: unknown): J[] {
  return objs(matchups).map((m) => ({
    ...pick(m, ["week", "status"]),
    sides: objs(m.sides).map((side) => ({
      ...teamLabel(directory, side.canonical_team_id),
      actual_points: num(side.actual_points),
      projected_points: num(side.projected_points),
    })),
  }));
}

export function compactLeague(directory: LeagueDirectory): Compacted {
  const out = blank();
  const body = directory.state_body;
  const state = obj(body.state);
  const league = obj(state.league);
  const freshness = obj(body.freshness);
  out.data = {
    league: {
      ...pick(league, ["league_slug", "name", "season", "status", "team_count", "current_week", "roster_settings", "playoff_settings", "waiver_settings", "scoring_fingerprint"]),
      provider: str(obj(league.provenance).provider),
    },
    standings: standingsRows(directory),
    current_week_matchups: matchupPairs(directory, state.matchups),
    snapshot: {
      integrity: str(obj(body.capabilities).snapshot_integrity),
      freshness: str(obj(freshness.freshness).status),
      state_source: str(freshness.state_source),
      capabilities: Object.fromEntries(Object.entries(obj(obj(body.capabilities).capabilities)).map(([k, v]) => [k, str(obj(v).status)])),
    },
    notes: [
      "Scores in current_week_matchups are live provider points (0 before kickoff), not projections.",
      "Standings are the provider's own; there is no playoff-probability model in this bridge.",
    ],
  };
  out.deployment = { league: "DESCRIPTIVE", standings: "DESCRIPTIVE", current_week_matchups: "DESCRIPTIVE", snapshot: "DESCRIPTIVE" };
  out.warnings = warningsOf(state.warnings);
  out.snapshot_id = str(obj(state.lineage).league_snapshot_id);
  out.scoring_fingerprint = str(league.scoring_fingerprint);
  out.generated_at = str(state.captured_at);
  const caps = obj(obj(body.capabilities).capabilities);
  for (const [k, v] of Object.entries(caps)) {
    const s = str(obj(v).status);
    if (s && s !== "HEALTHY") out.limitations.push(`${k}: ${s}${k === "free_agent_pool" ? " in the generic snapshot — use bloodline_waiver_analysis for the dedicated waiver market" : ""}`);
  }
  return out;
}

export function compactManagers(directory: LeagueDirectory): Compacted {
  const out = blank();
  const standing = new Map(objs(obj(directory.state_body.state).standings).map((s) => [str(s.canonical_team_id), s]));
  out.data = {
    league_slug: directory.league_slug,
    managers: directory.managers.map((m) => {
      const s = obj(standing.get(m.canonical_team_id));
      return {
        manager_slug: m.manager_slug,
        display_name: m.display_name,
        username: m.provider_username,
        team_name: m.team_name,
        is_commissioner: m.is_commissioner,
        is_co_manager: m.is_co_manager,
        rank: num(s.rank),
        record: s.wins !== undefined ? `${s.wins}-${s.losses}${num(s.ties) ? `-${s.ties}` : ""}` : null,
      };
    }),
    note: "Pass manager_slug (or the exact display name / team name) to manager tools. Knowing a slug grants read access only to data the bridge already publishes.",
  };
  out.deployment = { managers: "DESCRIPTIVE" };
  out.snapshot_id = str(obj(obj(directory.state_body.state).lineage).league_snapshot_id);
  return out;
}

/* ================================= team ================================= */

function rosterPlayer(p: unknown, slot?: string): J {
  const o = obj(p);
  return {
    ...(slot ? { slot } : {}),
    id: str(o.canonical_player_id),
    name: str(o.full_name),
    position: str(o.position),
    nfl_team: str(o.nfl_team),
    status: str(o.status),
    injury_status: str(o.injury_status),
  };
}

export function compactTeam(body: unknown, directory: LeagueDirectory | null): Compacted {
  const out = blank();
  const b = obj(body);
  const mc = obj(b.manager_context);
  const league = obj(mc.league);
  const roster = obj(mc.roster);
  const slots = strs(obj(league.roster_settings).starting_slots);
  const upcoming = obj(mc.upcoming_matchup);
  const freshness = obj(b.freshness);
  out.data = {
    league: pick(league, ["league_slug", "name", "provider", "season", "week", "playoff_settings", "waiver_settings"]),
    manager: pick(mc.manager, ["manager_slug", "display_name", "provider_username", "is_commissioner", "is_co_manager"]),
    team: { ...pick(mc.team, ["canonical_team_id", "team_name", "record", "faab_remaining", "waiver_priority"]) },
    standing: { ...pick(mc.standing, ["rank", "wins", "losses", "ties", "win_percentage", "points_for", "points_against", "games_played", "playoff_seed"]), ...pick(mc.standings_context, ["of", "games_back_of_first"]) },
    roster: {
      starters: arr(roster.starters).map((p, i) => rosterPlayer(p, slots[i])),
      bench: arr(roster.bench).map((p) => rosterPlayer(p)),
      ir: arr(roster.ir).map((p) => rosterPlayer(p)),
      taxi: arr(roster.taxi).map((p) => rosterPlayer(p)),
      position_counts: roster.position_counts ?? null,
      empty_starting_slots: roster.empty_starting_slots ?? [],
    },
    upcoming_matchup: upcoming.week !== undefined
      ? { week: num(upcoming.week), opponent: teamLabel(directory, upcoming.opponent_team_id), status: str(obj(upcoming.matchup).status) }
      : null,
    waiver_context: mc.waiver_context ?? null,
    recent_transactions: arr(mc.recent_transactions).slice(0, 10),
    data_capabilities: Object.fromEntries(Object.entries(obj(freshness.capabilities)).map(([k, v]) => [k, str(obj(v).status)])),
    freshness: { status: str(obj(freshness.freshness).status), state_source: str(freshness.state_source), snapshot_integrity: str(obj(freshness.integrity).snapshot_integrity) },
  };
  out.deployment = { league: "DESCRIPTIVE", manager: "DESCRIPTIVE", team: "DESCRIPTIVE", standing: "DESCRIPTIVE", roster: "DESCRIPTIVE", upcoming_matchup: "DESCRIPTIVE" };
  out.warnings = warningsOf(mc.warnings);
  out.snapshot_id = str(obj(freshness.response_state_lineage).snapshot_id);
  for (const [k, v] of Object.entries(obj(freshness.capabilities))) {
    const s = str(obj(v).status);
    if (s && s !== "HEALTHY") out.limitations.push(`${k}: ${s}`);
  }
  return out;
}

/* ================================ scoring ================================ */

export function compactScoring(body: unknown): Compacted {
  const out = blank();
  const b = obj(body);
  out.data = {
    league: pick(b.league, ["name", "season", "roster_positions"]),
    classification: b.classification ?? null,
    rules: objs(obj(b.scoring).normalized).map((r) => pick(r, ["key", "label", "category", "points"])),
    derived: b.derived ?? null,
    comparisons: b.comparisons ?? null,
    archetype_examples: Object.fromEntries(Object.entries(obj(b.archetype_examples)).map(([k, v]) => [k, pick(v, ["description", "fantasy_points", "points"])])),
    diagnostics: objs(b.diagnostics).map((d) => pick(d, ["id", "severity", "message"])),
    source: str(b.source),
  };
  out.deployment = { rules: "DESCRIPTIVE", derived: "DESCRIPTIVE", archetype_examples: "DESCRIPTIVE" };
  out.warnings = arr(obj(b.metadata).warnings);
  out.generated_at = str(b.generated_at);
  return out;
}

/** Provider-agnostic fallback (e.g. Yahoo leagues) from the canonical snapshot's own scoring rules. */
export function compactScoringFromState(directory: LeagueDirectory): Compacted {
  const out = blank();
  const league = obj(obj(directory.state_body.state).league);
  out.data = {
    league: pick(league, ["name", "season", "roster_settings"]),
    rules: objs(league.scoring_rules).map((r) => pick(r, ["key", "category", "points"])),
    note: "Canonical snapshot scoring rules (the bridge's Sleeper scoring explainer is not available for this provider).",
  };
  out.deployment = { rules: "DESCRIPTIVE" };
  out.scoring_fingerprint = str(league.scoring_fingerprint);
  return out;
}

/* ============================ weekly surfaces ============================ */

function lineupSlots(directory: LeagueDirectory | null, slots: unknown): J[] {
  return objs(slots).map((s) => ({
    slot: str(s.slot),
    recommended: { ...P(directory, s.recommended_player_id), projected: num(s.recommended_projected), floor: num(s.recommended_floor), ceiling: num(s.recommended_ceiling), projection_state: str(s.recommended_projection_state) },
    current: { ...P(directory, s.current_player_id), projected: num(s.current_projected), projection_state: str(s.current_projection_state) },
    is_change: s.is_change === true,
    confidence: str(s.confidence),
    reason: str(s.reason),
  }));
}

function startSitDecisions(directory: LeagueDirectory | null, decisions: unknown): J[] {
  return objs(decisions).map((d) => ({
    slot: str(d.slot),
    start: P(directory, d.start_player_id),
    over: P(directory, d.over_player_id),
    ...pick(d, ["recommendation", "projection_edge", "floor_edge", "ceiling_edge", "availability_edge", "replacement_impact", "confidence", "reasons"]),
  }));
}

function lineupSummary(directory: LeagueDirectory | null, lineup: unknown): J {
  const l = obj(lineup);
  return {
    ...pick(l, ["week", "optimality_status", "provisional_reason", "optimal_total", "current_total", "projected_points_gained", "points_left_on_bench", "lineup_efficiency", "projection_coverage", "empty_slots", "illegal_situations"]),
    changes_recommended: objs(l.changes_recommended).map((c) => ({ slot: str(c.slot), out: P(directory, c.out), in: P(directory, c.in), gain: num(c.gain), part_of_reshuffle: c.part_of_reshuffle === true })),
    unresolved_decisions: arr(l.unresolved_decisions),
    injury_risks: objs(l.injury_risks).map((r) => ({ ...P(directory, r.canonical_player_id), ...pick(r, ["slot", "injury_status", "expected_availability"]) })),
    bye_problems: objs(l.bye_problems).map((r) => ({ ...P(directory, r.canonical_player_id), slot: str(r.slot) })),
    unprojected_starters: arr(l.unprojected_starters).map((id) => P(directory, id)),
  };
}

function productionMatchup(directory: LeagueDirectory | null, matchup: unknown): J {
  const m = obj(matchup);
  return {
    week: num(m.week),
    team: teamLabel(directory, m.team_id),
    opponent: teamLabel(directory, m.opponent_team_id),
    ...pick(m, ["has_opponent", "team_optimal_total", "opponent_optimal_total", "projected_margin", "projected_margin_status", "margin_confidence", "win_probability", "win_probability_method", "win_probability_confidence", "positional_advantages", "positional_disadvantages", "bench_depth", "replacement_vulnerability"]),
    high_leverage_players: objs(m.high_leverage_players).map((p) => ({ ...P(directory, p.canonical_player_id), ...pick(p, ["position", "projected", "note"]) })),
    swing_players: objs(m.swing_players).map((p) => ({ ...P(directory, p.canonical_player_id), ...pick(p, ["side", "position", "projected", "expected_availability", "injury_status", "swing_note"]) })),
  };
}

function opponentLineup(directory: LeagueDirectory | null, lineup: unknown): J[] {
  return objs(obj(lineup).slots).map((s) => ({ slot: str(s.slot), ...P(directory, s.recommended_player_id ?? s.current_player_id), projected: num(s.recommended_projected ?? s.current_projected) }));
}

/** The SHADOW_ONLY simulated matchup (ri-matchup-2026.1), labelled; never merged into the production block. */
export function shadowMatchup(intelligence: unknown): J | null {
  const mi = obj(obj(intelligence).matchup_intelligence);
  if (!Object.keys(mi).length) return null;
  return {
    deployment: str(obj(mi.lineage).deployment) ?? "SHADOW_ONLY",
    banner: "SHADOW_ONLY research simulation — NOT the production matchup projection. Do not present these numbers as the bridge's prediction.",
    model: pick(mi.lineage, ["matchup_model_version", "distribution_model_version", "correlation_model_version", "contract_version"]),
    ...pick(mi, ["win_probability", "win_probability_interval", "expected_margin", "team_score", "opponent_score", "margin", "upset_probability", "blowout_probability", "confidence", "explanations"]),
  };
}

export function shadowStartSit(intelligence: unknown): J | null {
  const s = obj(obj(intelligence).start_sit_shadow);
  if (!Object.keys(s).length) return null;
  return {
    deployment: str(obj(s.lineage).deployment) ?? "SHADOW_ONLY",
    banner: "SHADOW_ONLY Football-Intelligence start/sit comparison — research output, never applied to the production lineup.",
    model: pick(s.lineage, ["start_sit_model_version", "football_intelligence_version", "contract_version"]),
    ...pick(s, ["baseline_lineup_total", "fi_lineup_total", "lineup_differs", "lineup_deltas", "start_sit_deltas", "notes"]),
  };
}

export function compactWeekly(body: unknown, orchestrate: unknown | null, directory: LeagueDirectory | null, includeShadow: boolean): Compacted {
  const out = blank();
  const b = obj(body);
  const i = obj(b.intelligence);
  const ready = readinessSummary(b.readiness ?? i.readiness);
  const lin = snapshotLineage(i.lineage);
  out.data = {
    week: num(i.week),
    statuses: pick(b, ["status", "projection_status", "market_status", "ros_status", "waiver_recommendation_status"]),
    readiness: ready.summary,
    summary: i.summary ?? null,
    top_actions: objs(i.top_actions).map((a) => pick(a, ["type", "priority", "message", "projected_gain", "net_roster_gain"])),
    lineup: lineupSummary(directory, i.lineup),
    start_sit: startSitDecisions(directory, i.start_sit),
    matchup: productionMatchup(directory, i.matchup),
    matchup_leverage: arr(i.matchup_leverage),
    positional_needs: arr(i.positional_needs),
    waivers_top: objs(obj(i.waivers).recommendations).slice(0, 5).map((r) => waiverRec(r, false)),
    projection_lineage: projectionLineage(i.lineage),
  };
  out.deployment = { summary: "PRODUCTION", top_actions: "PRODUCTION", lineup: "PRODUCTION", start_sit: "PRODUCTION", matchup: "PRODUCTION", matchup_leverage: "PRODUCTION", positional_needs: "PRODUCTION", waivers_top: "PRODUCTION" };
  if (orchestrate) {
    const o = obj(orchestrate);
    out.data.action_plan = {
      ...pick(o, ["deployment", "verdict", "confidence", "hold_rationale", "degradation"]),
      primary_action: o.primary_action ? actionOf(o.primary_action) : null,
      secondary_actions: objs(o.secondary_actions).map(actionOf),
      future_watch_items: objs(o.future_watch_items).map((w) => pick(w, ["code", "title", "urgency", "horizon", "has_available_remedy", "disposition"])),
      current_conditions: objs(o.current_conditions).map((c) => pick(c, ["code", "title", "materiality", "urgency", "horizon", "disposition"])),
    };
    out.deployment.action_plan = "ADVISORY_ONLY";
  }
  if (includeShadow) {
    const shadow: J = {};
    const sm = shadowMatchup(i);
    const ss = shadowStartSit(i);
    if (sm) shadow.matchup_simulation = sm;
    if (ss) shadow.start_sit_football_intelligence = ss;
    out.shadow = shadow;
  }
  out.limitations.push(...ready.limitations);
  out.limited = ready.limited || str(b.status) !== "READY";
  out.warnings = warningsOf(i.warnings);
  out.snapshot_id = lin.snapshot_id;
  out.scoring_fingerprint = lin.scoring_fingerprint;
  out.generated_at = str(i.generated_at);
  return out;
}

function actionOf(a: unknown): J {
  const o = obj(a);
  return {
    ...pick(o, ["action_class", "target_condition", "target_problem", "priority", "reason_codes", "negative_evidence", "expires_when"]),
    remedy: o.remedy ?? null,
    expected_weekly_effect: path(o, "dimensions.expected_weekly_effect") ?? null,
    explanation: objs(o.explanation_chain).map((e) => pick(e, ["specialist", "fact"])),
  };
}

export function compactLineup(body: unknown, directory: LeagueDirectory | null): Compacted {
  const out = blank();
  const b = obj(body);
  const ctx = obj(b.context);
  const d = obj(b.data);
  const ready = readinessSummary(ctx.readiness);
  const lin = snapshotLineage(ctx.lineage);
  out.data = {
    week: num(ctx.week),
    status: str(b.status),
    data_quality: pick(ctx.data_quality, ["projections", "roster_players_projected", "roster_players_total", "identity_unresolved", "opponent_available"]),
    lineup: lineupSummary(directory, d.lineup),
    slots: lineupSlots(directory, obj(d.lineup).slots),
    start_sit: startSitDecisions(directory, d.start_sit),
    starting_slots: obj(d.roster_constraints).starting_slots ?? null,
    projection_lineage: projectionLineage(ctx.lineage),
  };
  out.deployment = { lineup: "PRODUCTION", slots: "PRODUCTION", start_sit: "PRODUCTION" };
  out.limitations.push(...ready.limitations);
  out.limited = ready.limited || str(b.status) !== "READY";
  out.warnings = [...warningsOf(ctx.warnings), ...warningsOf(obj(d.lineup).warnings)];
  out.snapshot_id = lin.snapshot_id;
  out.scoring_fingerprint = lin.scoring_fingerprint;
  out.generated_at = lin.generated_at;
  return out;
}

export function compactMatchup(body: unknown, directory: LeagueDirectory | null, shadowSource: unknown | null): Compacted {
  const out = blank();
  const b = obj(body);
  const ctx = obj(b.context);
  const d = obj(b.data);
  const ready = readinessSummary(ctx.readiness);
  const lin = snapshotLineage(ctx.lineage);
  const m = obj(d.matchup);
  out.data = {
    week: num(ctx.week),
    status: str(b.status),
    matchup: productionMatchup(directory, m),
    leverage: arr(d.leverage),
    team_lineup: opponentLineup(directory, m.team_lineup),
    opponent_lineup: opponentLineup(directory, m.opponent_lineup),
    projection_lineage: projectionLineage(ctx.lineage),
  };
  out.deployment = { matchup: "PRODUCTION", leverage: "PRODUCTION", team_lineup: "PRODUCTION", opponent_lineup: "PRODUCTION" };
  if (shadowSource) {
    const sm = shadowMatchup(obj(shadowSource).intelligence);
    out.shadow = sm ? { matchup_simulation: sm } : { note: "No shadow matchup simulation in this response." };
  }
  out.limitations.push(...ready.limitations);
  out.limited = ready.limited || str(b.status) !== "READY" || str(m.win_probability_confidence) === "LOW";
  if (str(m.win_probability_confidence) === "LOW") out.limitations.push("win_probability: LOW confidence (heuristic independent-normal simulation) — directional only");
  out.warnings = [...warningsOf(ctx.warnings), ...warningsOf(m.warnings)];
  out.snapshot_id = lin.snapshot_id;
  out.scoring_fingerprint = lin.scoring_fingerprint;
  out.generated_at = lin.generated_at;
  return out;
}

function waiverRec(r: J, withComponents: boolean): J {
  return {
    add: { id: str(r.add_player_id), name: str(r.add_name), position: str(r.position), nfl_team: str(r.nfl_team) },
    drop: r.drop_player_id ? { id: str(r.drop_player_id), name: str(r.drop_name) } : null,
    ...pick(r, ["priority", "confidence", "weekly_projection", "rest_of_season_points", "weekly_vor", "flex_vor", "immediate_role", "rest_of_season_role", "drop_cost", "net_roster_gain", "starter_impact", "starter_impact_status", "bye_coverage_impact", "injury_hedge_impact", "reasons"]),
    ...(withComponents ? { score_components: objs(obj(r.score).components).map((c) => pick(c, ["key", "label", "raw", "weight", "contribution"])) } : {}),
  };
}

export function compactWaivers(body: unknown, includeComponents: boolean): Compacted {
  const out = blank();
  const b = obj(body);
  const ctx = obj(b.context);
  const d = obj(b.data);
  const ready = readinessSummary(b.readiness ?? d.readiness);
  const lin = snapshotLineage(ctx.lineage);
  const available = str(d.availability_status);
  out.data = {
    week: num(d.week),
    statuses: pick(b, ["status", "market_status", "projection_status", "ros_status", "recommendation_status"]),
    readiness: ready.summary,
    availability_status: available,
    unavailable_reason_code: d.unavailable_reason_code ?? null,
    unavailable_detail: d.unavailable_detail ?? null,
    waiver_model: str(d.waiver_model),
    faab: d.faab ?? null,
    waiver_priority: d.waiver_priority ?? null,
    roster_has_open_spot: d.roster_has_open_spot ?? null,
    players_considered: num(d.considered),
    recommendations: objs(d.recommendations).map((r) => waiverRec(r, includeComponents)),
    do_not_add: objs(d.do_not_add).map((x) => pick(x, ["add_player_id", "add_name", "reason", "starter_impact_status"])),
    engine: pick(d.intelligence, ["engine", "engine_version", "football_intelligence_used_for_numeric_ranking"]),
  };
  out.deployment = { recommendations: "PRODUCTION", do_not_add: "PRODUCTION" };
  if (available !== "AVAILABLE") {
    out.limitations.push(`free-agent pool ${available ?? "UNKNOWN"}: no verified list of available players — do not present recommendations as available pickups`);
    out.limited = true;
  }
  out.limitations.push(...ready.limitations);
  out.limited = out.limited || ready.limited || str(b.status) !== "READY";
  out.warnings = [...warningsOf(ctx.warnings), ...warningsOf(d.warnings)];
  out.snapshot_id = lin.snapshot_id;
  out.scoring_fingerprint = lin.scoring_fingerprint;
  out.generated_at = lin.generated_at;
  return out;
}

/* ============================ roster analysis ============================ */

function depthRows(horizon: unknown): J[] {
  return objs(obj(horizon).depth_quality).map((d) => pick(d, ["slot_key", "depth_quality_grade", "starter_quality_vor", "best_backup_vor", "replacement_cliff", "usable_backup_count", "nominal_backup_count"]));
}

export function compactRosterAnalysis(rh: unknown, sp: unknown | null, strategic: unknown | null, directory: LeagueDirectory | null): Compacted {
  const out = blank();
  const team = obj(obj(rh).team);
  const horizonSummary = (h: unknown) => {
    const o = obj(h);
    const scalars: J = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === "number" || typeof v === "string" || v === null) scalars[k] = v;
    return { ...scalars, depth_by_position: depthRows(o) };
  };
  out.data = {
    team: pick(team, ["team_name", "manager_slug", "manager_display_name", "roster_id"]),
    weekly: horizonSummary(team.weekly),
    rest_of_season: horizonSummary(team.rest_of_season),
    league_relative_percentiles: team.league_relative ?? null,
    ir_burden: team.ir_burden ?? null,
    bye_exposure: {
      current_week_starters_on_bye: arr(obj(team.bye_exposure).current_week_starters_on_bye).map((id) => P(directory, id)),
      near_term_shared_bye_weeks: arr(obj(team.bye_exposure).near_term_shared_bye_weeks),
    },
    explanations: arr(team.explanations),
    degradation: team.degradation ?? null,
  };
  out.deployment = { weekly: "SHARED_CONTEXT", rest_of_season: "SHARED_CONTEXT", league_relative_percentiles: "SHARED_CONTEXT", bye_exposure: "SHARED_CONTEXT" };
  const deg = obj(team.degradation);
  if (strs(deg.reasons).length) {
    out.limitations.push(`roster health degradation (${str(deg.overall) ?? "?"}): ${strs(deg.reasons).join(", ")}`);
    out.limited = true;
  }
  const lineage = obj(obj(rh).lineage);
  out.snapshot_id = str(lineage.league_snapshot_id);
  out.scoring_fingerprint = str(lineage.scoring_fingerprint);
  out.generated_at = str(lineage.generated_at);
  if (sp) {
    const t = obj(obj(sp).team);
    out.data.schedule = {
      summary: t.summary ?? null,
      weeks: objs(t.week_timeline).map((w) => ({
        ...pick(w, ["week", "is_current", "is_playoff_week", "legal_lineup_covered", "uncovered_slot_labels", "projected_lineup_value", "estimated_bye_loss", "projection_basis", "value_confidence"]),
        starters_on_bye: arr(w.starters_on_bye).map((id) => P(directory, id)),
      })),
      degradation: t.degradation ?? null,
    };
    out.deployment.schedule = "SHARED_CONTEXT";
    const sdeg = obj(t.degradation);
    if (strs(sdeg.reasons).length) out.limitations.push(`schedule planning: ${strs(sdeg.reasons).join(", ")}`);
  }
  if (strategic) {
    const s = obj(strategic);
    const m = obj(s.manager);
    out.data.season_position = {
      ...pick(s, ["status", "season_stage", "strategy_version"]),
      season: m.season ?? null,
      standings: m.standings ?? null,
      playoff: m.playoff ?? null,
      archetype: m.archetype ?? null,
      archetype_reasons: m.archetype_reasons ?? null,
      urgency: m.urgency ?? null,
      note: "playoff_odds is null by design: the bridge has no playoff-probability model. playoff.status / playoff_odds_band are standings-position bands, not probabilities.",
    };
    out.deployment.season_position = "SHARED_CONTEXT";
  }
  return out;
}

/* ================================ history ================================ */

export function compactHistoryWeek(body: unknown, leagueSlug: string, managerSlug: string | null, buildDir: (slug: string, stateBody: unknown) => LeagueDirectory): Compacted {
  const out = blank();
  const b = obj(body);
  const snap = obj(b.snapshot);
  const directory = buildDir(leagueSlug, { state: snap });
  const matchups = objs(snap.matchups);
  const statuses = [...new Set(matchups.map((m) => str(m.status)).filter((s): s is string => !!s))];
  out.data = {
    week: num(b.week),
    season: num(b.season),
    status: str(b.status),
    capture: b.preferred_capture ?? null,
    matchup_statuses: statuses,
    scoreboard: matchupPairs(directory, matchups),
    standings_after_capture: standingsRows(directory),
  };
  out.deployment = { scoreboard: "DESCRIPTIVE", standings_after_capture: "DESCRIPTIVE" };
  if (statuses.some((s) => s !== "complete")) {
    out.limitations.push(`matchup status at capture: ${statuses.join(", ")} — this capture may predate final scoring (e.g. before Monday night); points can differ from final results`);
    out.limited = true;
  }
  if (managerSlug) {
    const manager = directory.managers.find((m) => m.manager_slug === managerSlug);
    const side = manager ? matchups.flatMap((m) => objs(m.sides).map((s) => ({ m, s }))).find(({ s }) => strs(s.canonical_manager_ids).includes(manager.canonical_manager_id)) : undefined;
    if (!manager || !side) {
      out.data.manager_matchup = { manager_slug: managerSlug, found: false, note: "Manager not found in this week's captured matchups." };
    } else {
      const opp = objs(side.m.sides).find((s) => s !== side.s);
      const sideDetail = (s: J) => {
        const pts = obj(s.player_points);
        const row = (id: unknown) => ({ ...P(directory, id), points: num(pts[str(id) ?? ""]) });
        return { ...teamLabel(directory, s.canonical_team_id), actual_points: num(s.actual_points), starters: arr(s.starters).map(row), bench: arr(s.bench).map(row) };
      };
      const mine = sideDetail(side.s);
      const theirs = opp ? sideDetail(opp) : null;
      const a = num(mine.actual_points);
      const t = theirs ? num(theirs.actual_points) : null;
      out.data.manager_matchup = {
        manager_slug: managerSlug,
        found: true,
        matchup_status: str(side.m.status),
        result_at_capture: a != null && t != null ? (a > t ? "WIN" : a < t ? "LOSS" : "TIE") : null,
        team: mine,
        opponent: theirs,
      };
    }
    out.deployment.manager_matchup = "DESCRIPTIVE";
  }
  const lineage = obj(snap.lineage);
  out.snapshot_id = str(lineage.league_snapshot_id);
  out.scoring_fingerprint = str(obj(snap.league).scoring_fingerprint);
  out.generated_at = str(snap.captured_at);
  out.warnings = warningsOf(snap.warnings);
  return out;
}

/* ================================= trades ================================= */

export function compactTrade(body: unknown): Compacted {
  const out = blank();
  const b = obj(body);
  const { snapshot, ...rest } = b;
  out.data = rest;
  out.deployment = { analysis: "PRODUCTION" };
  const snap = obj(snapshot);
  out.snapshot_id = str(snap.league_snapshot_id);
  out.scoring_fingerprint = str(snap.scoring_fingerprint);
  out.generated_at = str(b.generated_at);
  out.limitations.push(...strs(b.limitations));
  out.warnings = warningsOf(b.diagnostics);
  const status = str(b.status);
  out.limited = status !== "READY" || ["VERY_LOW", "LOW"].includes(str(b.confidence) ?? "");
  return out;
}

/* ================================ evidence ================================ */

/** One evidence block reduced to value + unit + the axes that qualify it (class, confidence, sample, freshness, deployment). */
export function compactEvidenceBlock(block: unknown): J {
  const b = obj(block);
  const fresh = obj(b.freshness);
  return {
    metric: str(b.metric),
    subject: { kind: str(obj(b.subject).kind), id: str(obj(b.subject).id), team: str(obj(b.subject).team) },
    value: b.value ?? null,
    unit: str(obj(b.unit).display_unit) ?? str(obj(b.unit).kind),
    availability: str(obj(b.availability).state),
    analysis_class: str(obj(b.origin).analysis_class),
    confidence: str(obj(b.model_confidence).level),
    sample_n: num(obj(b.sample_support).n),
    deployment: str(obj(b.deployment).state),
    may_influence_production: obj(b.deployment).may_influence_production === true,
    through_week: num(fresh.through_week),
    refresh_lag_weeks: num(fresh.refresh_lag_weeks),
    limitations: arr(b.limitations),
  };
}

export function compactEvidence(body: unknown): Compacted {
  const out = blank();
  const b = obj(body);
  const blocks = objs(b.blocks);
  out.data = {
    topic: str(b.topic),
    surface: str(b.surface),
    status: str(b.status),
    availability: b.availability ?? null,
    blocks: blocks.map(compactEvidenceBlock),
    truncated: b.truncated === true,
    notes: arr(b.notes),
  };
  const states = [...new Set(blocks.map((x) => str(obj(x.deployment).state)).filter((s): s is string => !!s))];
  out.deployment = { blocks: states.includes("SHADOW_ONLY") ? "SHADOW_ONLY" : states.includes("SHARED_CONTEXT") ? "SHARED_CONTEXT" : "DESCRIPTIVE" };
  const lags = blocks.map((x) => num(obj(x.freshness).refresh_lag_weeks)).filter((n): n is number => n != null && n > 0);
  if (lags.length) {
    out.limitations.push(`surface data lags the completed NFL week by ${Math.max(...lags)} week(s) (refresh pending)`);
    out.limited = true;
  }
  if (b.truncated === true) out.limitations.push("bridge truncated this evidence response");
  out.generated_at = str(obj(blocks[0]?.freshness).generated_at);
  return out;
}
