/**
 * Phase 3.5C — the single analytical query layer.
 *
 * `getEvidence(request)` resolves a topic to its authoritative reader, returns validated EvidenceBlocks, and attaches
 * lineage + availability. It does NOT rank decisions, write prose, or run every model: history and comparison
 * populations are explicit opt-ins, and decision topics run exactly one request-scoped build. Ordinary
 * recommendation endpoints never import this module (asserted by test/book-ready-isolation.test.ts).
 */
import { runWaiver2CaptureHook } from "@/lib/waiver2/capture-hook";
import { attachMarketRef } from "@/lib/waiver2/market-pool";
import { getMatchup2CaptureHealth } from "@/lib/matchup2/capture-health";
import { runMarketSnapshotHook } from "@/lib/market-state/snapshot-hook";
import { getWaiver2CaptureHealth } from "@/lib/waiver2/capture-health";
import { WAIVER2_LIFECYCLE_STATE } from "@/lib/waiver2/lifecycle";
import { waiver2ActionsEvidence, waiver2MarketEvidence, waiver2ReplacementEvidence } from "./families/waiver2";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_CONTRACT_VERSION, type EvidenceBlock } from "./schema";
import { completedFrontier, defaultContext, notAvailable, PHASE7, refreshLag, type QueryContext } from "./common";
import { validateEvidenceBlock } from "./validate";
import { fiPlayerUsageEvidence, fiTeamMetricEvidence } from "./families/football-intelligence";
import { roleChangeEvidence, roleProfileEvidence } from "./families/role";
import { opportunityScenarioEvidence } from "./families/opportunity";
import { schemeDefenseCoverageEvidence, schemeQbFormationEvidence, schemeQbProgressionEvidence, schemeQbSpatialEvidence } from "./families/player-scheme";
import { matchupEvidence, rosterHealthEvidence, schedulePlanningEvidence, startSitShadowEvidence, tradeCapabilityEvidence, waiverEvidence, type DecisionMeta } from "./families/decision";

export const MAX_BLOCKS = 400;

export interface EvidenceRequest {
  topic: string;
  params?: Record<string, string | number | string[] | undefined>;
  history?: boolean;
  comparisons?: boolean;
}
export interface EvidenceResponse {
  contract_version: string;
  topic: string;
  surface: string | null;
  status: "OK" | "UNKNOWN_TOPIC" | "INVALID_REQUEST";
  detail?: string;
  availability: Record<string, number>;
  blocks: EvidenceBlock[];
  truncated: boolean;
  validation: { ok: boolean; errors: Array<{ evidence_id: string; errors: string[] }> };
  performance: { elapsed_ms: number; block_count: number; approx_bytes: number; cost_class: "ARTIFACT_READ" | "REQUEST_SCOPED_BUILD"; history: boolean; comparisons: boolean };
  notes: string[];
}

interface TopicSpec {
  surface: string;
  cost: "ARTIFACT_READ" | "REQUEST_SCOPED_BUILD";
  required: string[];
  run: (p: Record<string, string>, ctx: QueryContext, req: EvidenceRequest) => Promise<EvidenceBlock[]> | EvidenceBlock[];
}
const list = (v: string | undefined): string[] | undefined => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const decisionMeta = (p: Record<string, string>): DecisionMeta => ({ league_slug: p.league!, manager_slug: p.manager!, season: Number(p.season ?? 2026), week: Number(p.week ?? 0) });

async function weekly(p: Record<string, string>) {
  const { buildWeeklyIntelligence } = await import("@/lib/weekly/intelligence");
  const r = await buildWeeklyIntelligence(p.league!, p.manager!, p.week ? { week: Number(p.week) } : {});
  return r.intelligence;
}
/** Waiver 2.0 (Phase 4): one request-scoped evaluation per topic call. Read-only; SHADOW_ONLY; nothing is submitted. */
async function waiver2Eval(p: Record<string, string>) {
  const { buildWaiverInputForManager } = await import("@/lib/waiver2/adapter"); const { evaluateWaiver2 } = await import("@/lib/waiver2/actions");
  const r = await buildWaiverInputForManager(p.league!, p.manager!, p.week ? { week: Number(p.week) } : {});
  if (!r.ok) return null;
  const ev = evaluateWaiver2(r.input); attachMarketRef(ev, r.input.pool.market);
  // Prospective shadow evidence: TELEMETRY ONLY, after the evaluation is complete. The durable hook (installed by the server route)
  // never throws, never alters `ev`, and an illustrative request is never persisted; failures are counted in the capture health.
  if (p.illustrative !== "1") await runMarketSnapshotHook(r.input.pool.market_snapshot);
  await runWaiver2CaptureHook(ev, r.input, { league_slug: p.league!, manager_slug: p.manager!, season: Number(p.season ?? 2026), illustrative: p.illustrative === "1" });
  return ev;
}
async function matchup2Source() { const { fileMatchupSource } = await import("@/lib/matchup2/source-files"); return fileMatchupSource(); }
async function matchup2Player(topic: "coverage" | "pass_area" | "pressure" | "run" | "scoring" | "summary", p: Record<string, string>): Promise<EvidenceBlock[]> {
  const { buildMatchupContext } = await import("@/lib/matchup2/context"); const { evaluatePlayer } = await import("@/lib/matchup2/engine"); const { matchup2PlayerEvidence, MATCHUP2_SURFACE } = await import("./families/matchup2"); const { normalizeTeam } = await import("@/lib/matchup2/stats");
  const src = await matchup2Source(); const pl = src.resolvePlayer(p.gsis_id!); const un = (why: string) => [notAvailable({ surface: MATCHUP2_SURFACE, topic: `matchup2.player.${topic}`, metric: "*", subject: { kind: "PLAYER", id: p.gsis_id! }, deployment: { state: "SHADOW_ONLY", may_influence_production: false }, freshness: { as_of: null, through_week: null, generated_at: null }, temporal: { season: null, week: null, through_week: null, as_of: null, generated_at: null, source_cutoff: null, point_kind: "CURRENT", as_of_kind: "CURRENT_SNAPSHOT", week_state: null, snapshot_id: null, player_team_temporal_identity: PHASE7 }, lineage: { surface_version: null }, source: { built_in: { namespace: "INTELLIGENCE_MODERNIZATION_PHASE", phase: "5" } }, limitations: [why] }, "UNAVAILABLE", why)];
  if (!pl) return un(`player '${p.gsis_id}' is not in the Player-Scheme directory`);
  const week = p.week ? Number(p.week) : Math.max(1, Number((await (await import("@/lib/sleeper/client")).getNflState().catch(() => null))?.week ?? 1));
  let opp = normalizeTeam(p.opponent); if (!opp && pl.team) { try { const { loadFullSchedule } = await import("@/lib/schedule-planning/schedule"); const fs = await loadFullSchedule(src.season(), week, 18); opp = fs.opponentByWeek.get(week)?.[pl.team] ?? null; } catch { opp = null; } }
  if (!opp) return un(`opponent for ${pl.team ?? "player"} in week ${week} could not be established (pass opponent=<TEAM>, or the team is on bye / schedule unavailable)`);
  const ctx = buildMatchupContext(src, { offense_team: pl.team ?? "UNK", defense_team: opp, week }); const ev = evaluatePlayer(src, ctx, p.gsis_id!); if ("error" in ev) return un(ev.detail);
  return matchup2PlayerEvidence(topic, ev);
}
async function matchup2Defense(topic: "coverage" | "front" | "pressure" | "explosive", p: Record<string, string>): Promise<EvidenceBlock[]> {
  const { buildMatchupContext } = await import("@/lib/matchup2/context"); const { buildDefenseProfile } = await import("@/lib/matchup2/defense"); const { matchup2DefenseEvidence } = await import("./families/matchup2");
  const src = await matchup2Source(); const ctx = buildMatchupContext(src, { offense_team: p.offense_team ?? "UNK", defense_team: p.team!, week: p.week ? Number(p.week) : null }); return matchup2DefenseEvidence(topic, ctx, buildDefenseProfile(ctx, p.window === "career" ? "career" : "recent"));
}
const w2meta = (p: Record<string, string>) => ({ league_slug: p.league!, manager_slug: p.manager!, season: Number(p.season ?? 2026), illustrative: p.illustrative === "1" });
async function managerContext(p: Record<string, string>) {
  const { resolveManagerRoute } = await import("@/lib/leagues/api");
  const r = await resolveManagerRoute(Promise.resolve({ leagueSlug: p.league!, managerSlug: p.manager! }));
  return r.ok ? r : null;
}

export const TOPICS: Record<string, TopicSpec> = {
  "fi.team_metric": { surface: "football-intelligence", cost: "ARTIFACT_READ", required: ["team"], run: (p, ctx, r) => fiTeamMetricEvidence({ team: p.team!, ...(p.side ? { side: p.side as "offense" | "defense" } : {}), ...(list(p.metrics) ? { metrics: list(p.metrics)! } : {}), history: r.history ?? false, comparisons: r.comparisons ?? false }, ctx) },
  "fi.player_usage": { surface: "football-intelligence", cost: "ARTIFACT_READ", required: [], run: (p, ctx, r) => fiPlayerUsageEvidence({ ...(p.gsis_id ? { gsis_id: p.gsis_id } : {}), ...(p.sleeper_id ? { sleeper_id: p.sleeper_id } : {}), ...(list(p.metrics) ? { metrics: list(p.metrics)! } : {}), history: r.history ?? false, comparisons: r.comparisons ?? false }, ctx) },
  "role.player_profile": { surface: "role-opportunity", cost: "ARTIFACT_READ", required: [], run: (p, ctx, r) => roleProfileEvidence({ ...(p.gsis_id ? { gsis_id: p.gsis_id } : {}), ...(p.sleeper_id ? { sleeper_id: p.sleeper_id } : {}), ...(list(p.dimensions) ? { dimensions: list(p.dimensions)! } : {}), history: r.history ?? false, comparisons: r.comparisons ?? false }, ctx) },
  "role.role_change": { surface: "role-opportunity", cost: "ARTIFACT_READ", required: [], run: (p) => roleChangeEvidence({ ...(p.gsis_id ? { gsis_id: p.gsis_id } : {}), ...(p.sleeper_id ? { sleeper_id: p.sleeper_id } : {}) }) },
  "opp.scenario": { surface: "opportunity-propagation", cost: "ARTIFACT_READ", required: ["team", "season", "week", "unavailable"], run: (p, ctx) => opportunityScenarioEvidence({ team: p.team!, season: Number(p.season), week: Number(p.week), unavailable_player_ids: list(p.unavailable)! }, ctx) },
  "scheme.qb_progression": { surface: "player-scheme", cost: "ARTIFACT_READ", required: ["gsis_id"], run: (p, ctx, r) => schemeQbProgressionEvidence({ gsis_id: p.gsis_id!, ...(p.window ? { window: p.window } : {}), comparisons: r.comparisons ?? false }, ctx) },
  "scheme.qb_spatial": { surface: "player-scheme", cost: "ARTIFACT_READ", required: ["gsis_id"], run: (p, ctx) => schemeQbSpatialEvidence({ gsis_id: p.gsis_id!, ...(p.window ? { window: p.window } : {}) }, ctx) },
  "scheme.qb_formation": { surface: "player-scheme", cost: "ARTIFACT_READ", required: ["gsis_id"], run: (p, ctx) => schemeQbFormationEvidence({ gsis_id: p.gsis_id!, ...(p.window ? { window: p.window } : {}) }, ctx) },
  "scheme.defense_coverage": { surface: "player-scheme", cost: "ARTIFACT_READ", required: ["team"], run: (p, ctx, r) => schemeDefenseCoverageEvidence({ team: p.team!, ...(p.window ? { window: p.window } : {}), comparisons: r.comparisons ?? false }, ctx) },
  "startsit.shadow": { surface: "start-sit-fi", cost: "REQUEST_SCOPED_BUILD", required: ["league", "manager"], run: async (p) => { const i = await weekly(p); return i?.start_sit_shadow ? startSitShadowEvidence(i.start_sit_shadow, { ...decisionMeta(p), week: i.week, season: Number(p.season ?? 2026) }) : []; } },
  "matchup.shadow": { surface: "matchup-intelligence", cost: "REQUEST_SCOPED_BUILD", required: ["league", "manager"], run: async (p) => { const i = await weekly(p); return matchupEvidence(i?.matchup_intelligence, { ...decisionMeta(p), week: i?.week ?? 0 }); } },
  "waiver.status": { surface: "waiver-foundations", cost: "REQUEST_SCOPED_BUILD", required: ["league", "manager"], run: async (p) => { const i = await weekly(p); return i ? waiverEvidence(i.waivers, { ...decisionMeta(p), week: i.week }) : []; } },
  "market.state": { surface: "league-market-state", cost: "REQUEST_SCOPED_BUILD", required: ["league"], run: async (p) => {
    const { loadMarketSnapshot } = await import("@/lib/market-state/load"); const { marketStateEvidence } = await import("./families/market-state"); const { getNflState } = await import("@/lib/sleeper/client");
    const week = p.week ? Number(p.week) : Math.max(1, Number((await getNflState().catch(() => null))?.week ?? 1));
    const nflWeek = Math.max(1, Number((await getNflState().catch(() => null))?.week ?? 1)); const snap = await loadMarketSnapshot(p.league!, { week });
    const mc = p.manager ? await managerContext(p) : null; const overlay = mc ? { team_id: `team:${mc.league.league_slug}:${mc.manager.roster_id}`, manager_slug: mc.manager.manager_slug } : null;
    // history is preserved only for the CURRENT week: a caller-chosen week must never label a stored snapshot
    if (p.illustrative !== "1" && week === nflWeek) await runMarketSnapshotHook(snap); return marketStateEvidence(snap, overlay ?? undefined);
  } },
  // ---- Matchup Intelligence 2.0 (Phase 5): player-level topics resolve the opponent from the schedule unless `opponent` is given; defense topics take `team`.
  ...Object.fromEntries((["coverage", "pass_area", "pressure", "run", "scoring", "summary"] as const).map((t) => [`matchup2.player.${t}`, { surface: "matchup-intelligence-2", cost: "REQUEST_SCOPED_BUILD" as const, required: ["gsis_id"], run: async (p: Record<string, string>) => matchup2Player(t, p) }])),
  ...Object.fromEntries((["coverage", "front", "pressure", "explosive"] as const).map((t) => [`matchup2.defense.${t}`, { surface: "matchup-intelligence-2", cost: "ARTIFACT_READ" as const, required: ["team"], run: async (p: Record<string, string>) => matchup2Defense(t, p) }])),
  "waiver2.actions": { surface: "waiver-intelligence-2", cost: "REQUEST_SCOPED_BUILD", required: ["league", "manager"], run: async (p) => { const ev = await waiver2Eval(p); return ev ? waiver2ActionsEvidence(ev, w2meta(p)) : []; } },
  "waiver2.market": { surface: "waiver-intelligence-2", cost: "REQUEST_SCOPED_BUILD", required: ["league", "manager"], run: async (p) => { const ev = await waiver2Eval(p); return ev ? waiver2MarketEvidence(ev, w2meta(p)) : []; } },
  "waiver2.replacement": { surface: "waiver-intelligence-2", cost: "REQUEST_SCOPED_BUILD", required: ["league", "manager"], run: async (p) => { const ev = await waiver2Eval(p); return ev ? waiver2ReplacementEvidence(ev, w2meta(p)) : []; } },
  "roster_health.team": { surface: "roster-health", cost: "REQUEST_SCOPED_BUILD", required: ["league", "manager"], run: async (p) => {
    const r = await managerContext(p); if (!r) return [];
    const { buildRosterHealthContext } = await import("@/lib/roster-health");
    const c = await buildRosterHealthContext(r.league.league_slug); const t = c.roster_index[r.manager.roster_id] != null ? c.teams[c.roster_index[r.manager.roster_id]!] : c.teams.find((x) => x.manager_slug === r.manager.manager_slug);
    return rosterHealthEvidence({ roster_health_version: c.roster_health_version, lineage: c.lineage, team: t }, { ...decisionMeta(p), season: c.season, week: c.week }, { populationN: c.teams.length });
  } },
  "schedule_planning.team": { surface: "schedule-planning", cost: "REQUEST_SCOPED_BUILD", required: ["league", "manager"], run: async (p) => {
    const r = await managerContext(p); if (!r) return [];
    const { buildSchedulePlanningContext } = await import("@/lib/schedule-planning");
    const c = await buildSchedulePlanningContext(r.league.league_slug); const t = c.roster_index[r.manager.roster_id] != null ? c.teams[c.roster_index[r.manager.roster_id]!] : c.teams.find((x) => x.manager_slug === r.manager.manager_slug);
    return schedulePlanningEvidence({ planning_model_version: c.planning_model_version, lineage: c.lineage, team: t }, { ...decisionMeta(p), season: c.season, week: c.week });
  } },
  // ---- Phase 6: the league's scoring contract — which of its rules actually reach valuation (and which do not).
  "scoring.league_contract": { surface: "league-scoring-contract", cost: "REQUEST_SCOPED_BUILD", required: ["league"], run: async (p) => {
    const { buildCanonicalLeagueState } = await import("@/lib/canonical/state"); const { scoringContractEvidence, SCORING_SURFACE } = await import("./families/scoring");
    const st = await buildCanonicalLeagueState(p.league!, { reportPersistence: false }); const lg = st.snapshot?.league;
    if (!lg) return [notAvailable({ surface: SCORING_SURFACE, topic: "scoring.league_contract", metric: "*", subject: { kind: "LEAGUE", id: p.league!, league_slug: p.league! }, deployment: { state: "SHARED_DESCRIPTIVE", may_influence_production: false }, temporal: { season: Number(p.season ?? 2026), week: null, through_week: null, as_of: null, generated_at: null, source_cutoff: null, point_kind: "CURRENT", as_of_kind: "CURRENT_SNAPSHOT", week_state: null, snapshot_id: null, player_team_temporal_identity: PHASE7 }, freshness: { as_of: null, through_week: null, generated_at: null }, lineage: { surface_version: "scoring-contract-2026.1", content_identity: "unavailable", canonical: {}, depends_on: [] }, source: { built_in: { namespace: "INTELLIGENCE_MODERNIZATION_PHASE", phase: "6" }, source_data: "league scoring settings" }, limitations: [] }, "UNAVAILABLE", `league '${p.league}' scoring settings could not be established (${st.code ?? "league_state_unavailable"})`)];
    return scoringContractEvidence({ league_slug: p.league!, season: lg.season, raw_scoring: lg.raw_scoring });
  } },
  "trade.evaluation": { surface: "trade-foundations", cost: "ARTIFACT_READ", required: ["league", "manager"], run: (p) => tradeCapabilityEvidence(decisionMeta(p)) },
};

export function getCapabilities(root = process.cwd()): unknown {
  const reg = JSON.parse(readFileSync(join(root, "docs", "intelligence-surface-registry.json"), "utf8")) as { registry_version: string; surfaces: Array<{ id: string; book_ready?: unknown }> };
  const manifestThrough = (rel: string, key = "through_week"): number | null => { try { return (JSON.parse(readFileSync(join(root, rel), "utf8")) as Record<string, number>)[key] ?? null; } catch { return null; } };
  const frontier = completedFrontier(root);
  const stat = (id: string, tw: number | null) => ({ surface: id, through_week: tw, completed_week_frontier: frontier, refresh_lag_weeks: refreshLag(tw, root), state: refreshLag(tw, root) === null ? "UNKNOWN" : refreshLag(tw, root) === 0 ? "CURRENT" : "NOT_YET_REFRESHED" });
  return { registry_version: reg.registry_version, contract_version: EVIDENCE_CONTRACT_VERSION, matchup2: { model_version: "matchup-2-2026.1", lifecycle_state: "SHADOW_ONLY", may_influence_production: false, numeric_adjustment: null, capture_health: getMatchup2CaptureHealth() }, waiver2: { lifecycle_state: WAIVER2_LIFECYCLE_STATE, may_influence_production: false, capture_health: getWaiver2CaptureHealth() },
    refresh_status: [stat("football-intelligence", manifestThrough("lib/football-intel/data/football_intelligence_manifest.json")), stat("role-opportunity", manifestThrough("lib/player-role-intelligence/data/role_opportunity_manifest.json")), stat("opportunity-propagation", manifestThrough("lib/opportunity-propagation-intelligence/data/opportunity_propagation_manifest.json"))], topics: Object.fromEntries(Object.entries(TOPICS).map(([k, v]) => [k, { surface: v.surface, required_params: v.required, cost_class: v.cost }])), surfaces: reg.surfaces.map((s) => ({ id: s.id, book_ready: s.book_ready ?? null })) };
}

export async function getEvidence(req: EvidenceRequest, over: Partial<QueryContext> = {}): Promise<EvidenceResponse> {
  const t0 = Date.now();
  const empty = (status: EvidenceResponse["status"], detail: string): EvidenceResponse => ({ contract_version: EVIDENCE_CONTRACT_VERSION, topic: req.topic, surface: null, status, detail, availability: {}, blocks: [], truncated: false, validation: { ok: true, errors: [] }, performance: { elapsed_ms: Date.now() - t0, block_count: 0, approx_bytes: 0, cost_class: "ARTIFACT_READ", history: !!req.history, comparisons: !!req.comparisons }, notes: [] });
  const spec = TOPICS[req.topic];
  if (!spec) return empty("UNKNOWN_TOPIC", `unknown topic '${req.topic}'. Known: ${Object.keys(TOPICS).join(", ")}`);
  const p = Object.fromEntries(Object.entries(req.params ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)])) as Record<string, string>;
  const missing = spec.required.filter((k) => !p[k]);
  if (missing.length) return { ...empty("INVALID_REQUEST", `missing required parameter(s): ${missing.join(", ")}`), surface: spec.surface };
  if (req.topic.startsWith("fi.player_usage") || req.topic.startsWith("role.")) if (!p.gsis_id && !p.sleeper_id) return { ...empty("INVALID_REQUEST", "gsis_id or sleeper_id is required"), surface: spec.surface };
  const ctx = defaultContext({ ...over, history: !!req.history, comparisons: !!req.comparisons });
  let blocks = await spec.run(p, ctx, req);
  const truncated = blocks.length > MAX_BLOCKS; if (truncated) blocks = blocks.slice(0, MAX_BLOCKS);
  const errors = blocks.map((b) => ({ evidence_id: b.evidence_id, errors: validateEvidenceBlock(b) })).filter((e) => e.errors.length);
  const availability: Record<string, number> = {}; for (const b of blocks) availability[b.availability.state] = (availability[b.availability.state] ?? 0) + 1;
  const approx = JSON.stringify(blocks).length;
  return { contract_version: EVIDENCE_CONTRACT_VERSION, topic: req.topic, surface: spec.surface, status: "OK", availability, blocks, truncated, validation: { ok: errors.length === 0, errors },
    performance: { elapsed_ms: Date.now() - t0, block_count: blocks.length, approx_bytes: approx, cost_class: spec.cost, history: !!req.history, comparisons: !!req.comparisons },
    notes: [...(truncated ? [`response truncated to ${MAX_BLOCKS} blocks`] : []), ...(spec.cost === "REQUEST_SCOPED_BUILD" ? ["this topic runs one request-scoped build of the underlying surface"] : [])] };
}
