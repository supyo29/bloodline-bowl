/**
 * Phase 4 — PROSPECTIVE SHADOW CAPTURE for Waiver Intelligence 2.0 (record schema v2), with the Phase 3.5A integrity philosophy.
 *
 * Historical waiver pools were never preserved, so a backtest would have to FABRICATE alternatives. The honest path is to capture
 * pristine, content-addressed weekly evaluations going forward and attach outcomes later without ever touching the decision.
 * Capture CLASSES are never merged, and a class is a claim the store itself enforces:
 *   LIVE_CAPTURED              certified pool AND every involved NFL game verifiably pre-game (the only pristine class)
 *   LIVE_POST_LOCK             observed live, but a game had already started
 *   LIVE_UNVERIFIED            observed live, lock status could not be verified
 *   HISTORICALLY_RECONSTRUCTED rebuilt from archives (lower integrity)
 *   ILLUSTRATIVE               non-actionable demonstration on an uncertified/mock pool — NEVER persisted by the runtime
 *   NOT_ACTIONABLE             the evaluation was BLOCKED (pool not certified): a readiness fact only, NO ranked actions
 * Only LIVE_CAPTURED / RANKED_ACTIONS / certified pool can ever count toward evaluation. This module is a pure contract; the
 * durable store and the runtime hook live in lib/persistence (telemetry only — never in the ranking path).
 */
import { hashOf } from "./hash";
import { WAIVER2_ENGINE_VERSION } from "./config";
import { WAIVER2_LIFECYCLE_STATE, mayInfluenceProduction, type Waiver2LifecycleState } from "./lifecycle";
import type { WaiverEvaluation, WaiverInput } from "./types";

export type CaptureKind = "LIVE_CAPTURED" | "LIVE_POST_LOCK" | "LIVE_UNVERIFIED" | "HISTORICALLY_RECONSTRUCTED" | "ILLUSTRATIVE" | "NOT_ACTIONABLE";
export const CAPTURE_KINDS: CaptureKind[] = ["LIVE_CAPTURED", "LIVE_POST_LOCK", "LIVE_UNVERIFIED", "HISTORICALLY_RECONSTRUCTED", "ILLUSTRATIVE", "NOT_ACTIONABLE"];
export type CaptureRecordType = "RANKED_ACTIONS" | "POOL_READINESS_BLOCKED";
/** v3 (Phase 4.5): ranked records carry the canonical MARKET-STATE lineage. v2 rows (all NOT_ACTIONABLE, no market field) remain valid. */
export const CAPTURE_RECORD_SCHEMA_VERSION = 3;
export interface CaptureMarketRef {
  market_state_version: string; market_content_id: string | null; pool_id: string | null; acquisition_context_id: string | null; history_class: string; readiness_status: string;
  blocks: string[]; limitations: string[]; coverage: { pool_size: number; evaluated: number; unmatched: number } | null;
}

/* ------------------------------------------------------------------------------------------------ lock evidence */
export interface WaiverLockEvidence { verdict: "PRE_KICKOFF_VERIFIED" | "POST_LOCK" | "UNVERIFIED"; reason: string; involved_teams: string[]; schedule_fetched_at: string | null; decision_date_et: string | null }
export interface ScheduleGame { week: number; home?: string | null; away?: string | null; date?: string | null; status?: string | null }
export const LOCK_SCHEDULE_MAX_AGE_MS = 5 * 60 * 1000;
const etDate = (iso: string): string | null => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); };
/** Pure. Pristine only if every involved team's game this week is verifiably `pre_game` in a schedule read taken at decision time. */
export function classifyWaiverLock(i: { decision_timestamp: string; week: number; involved_teams: string[]; games: ScheduleGame[] | null; schedule_fetched_at: string | null }): WaiverLockEvidence {
  const teams = [...new Set(i.involved_teams.filter(Boolean).map((t) => t.toUpperCase()))].sort(); const decisionEt = etDate(i.decision_timestamp);
  const base = { involved_teams: teams, schedule_fetched_at: i.schedule_fetched_at, decision_date_et: decisionEt };
  const un = (reason: string): WaiverLockEvidence => ({ verdict: "UNVERIFIED", reason, ...base });
  if (!decisionEt) return un("DECISION_TIMESTAMP_INVALID"); if (!i.games || !i.games.length || !i.schedule_fetched_at) return un("SCHEDULE_UNAVAILABLE");
  if (!(Math.abs(new Date(i.decision_timestamp).getTime() - new Date(i.schedule_fetched_at).getTime()) <= LOCK_SCHEDULE_MAX_AGE_MS)) return un("SCHEDULE_READ_NOT_AT_DECISION_TIME");
  if (!teams.length) return un("NO_INVOLVED_TEAMS");
  let seen = 0; let post: string | null = null;
  for (const t of teams) { const g = i.games.find((x) => x.week === i.week && (x.home?.toUpperCase() === t || x.away?.toUpperCase() === t)); if (!g) continue; seen += 1; const st = (g.status ?? "").trim().toLowerCase(); if (st !== "pre_game") post ??= `GAME_NOT_PRE_GAME:${t}:${st || "unknown"}`; else if (g.date && g.date < decisionEt) post ??= `GAME_DATE_PAST:${t}:${g.date}`; }
  if (!seen) return un("NO_INVOLVED_GAMES_FOUND"); if (post) return { verdict: "POST_LOCK", reason: post, ...base };
  return { verdict: "PRE_KICKOFF_VERIFIED", reason: "ALL_INVOLVED_GAMES_PRE_GAME", ...base };
}

export interface ClassFacts { illustrative: boolean; is_reconstruction: boolean; lock: WaiverLockEvidence | null }
/** The class is derived, never chosen: an uncertified pool can only be NOT_ACTIONABLE (or ILLUSTRATIVE if the caller says so). */
export function captureKindFor(ev: Pick<WaiverEvaluation, "availability">, f: ClassFacts): CaptureKind {
  if (f.illustrative) return "ILLUSTRATIVE"; if (f.is_reconstruction) return "HISTORICALLY_RECONSTRUCTED";
  if (ev.availability.certification !== "CERTIFIED" || ev.availability.status !== "AVAILABLE") return "NOT_ACTIONABLE";
  if (!f.lock || f.lock.verdict === "UNVERIFIED") return "LIVE_UNVERIFIED"; return f.lock.verdict === "POST_LOCK" ? "LIVE_POST_LOCK" : "LIVE_CAPTURED";
}

/* ------------------------------------------------------------------------------------------------ record */
export interface CaptureAction {
  rank: number; id: string; tier: string; candidate_id: string | null; candidate_position: string | null; drop_id: string | null; archetype: string | null;
  net_action_value: number; net_low: number; net_high: number; gross_add_value: number; drop_cost: number; acquisition_cost: number; risk_penalty: number;
  horizons: Record<string, number>; value_by_kind: Record<string, number>;
  uncertainty: { total: number; components: Array<{ source: string; level: number; weight: number }> };
  faab: { status: string; calibration: string; rungs: [number | null, number | null, number | null, number | null] }; priority: string;
  components: Array<[string, number | null]>; alternatives: Array<{ candidate_id: string; net_action_value: number }>;
  opp: { status: string; condition: string | null; counted_points: number; conditional_payoff_points: number }; content_id: string;
}
export interface WaiverShadowCaptureRecord {
  schema_version: number; capture_id: string; capture_class: CaptureKind; record_type: CaptureRecordType; captured_at: string; season: number; week: number;
  league_slug: string; manager_slug: string; scoring_fingerprint: string | null; model_version: string; lifecycle_state: Waiver2LifecycleState; params_hash: string;
  deployment: { state: string; may_influence_production: boolean };
  snapshot: { id: string | null; content_hash: string | null };
  /** Phase 4.5: which certified market snapshot the candidate set came from (absent on v2 rows). A BLOCKED record carries only the readiness codes. */
  market?: CaptureMarketRef | null;
  provenance?: { invocation: CaptureInvocation };
  pool: { certification: string; readiness: { actionable: boolean; reason_code: string | null; reasons: string[]; missing_inputs: string[] }; pool_hash: string; candidate_count: number; candidate_ids: string[] };
  roster: { team_id: string; active_player_ids: string[]; faab_remaining: number | null; waiver_priority: number | null; roster_hash: string };
  lock: WaiverLockEvidence | null;
  evidence: { role: { version: string | null; through_week: number | null }; fi: { version: string | null; through_week: number | null; week_state: string | null }; opp: { version: string | null; conditions: string[] }; schedule: { available: boolean; identity_hash: string | null }; projection_model: string | null };
  actions: CaptureAction[]; recommended_id: string | null; pass_recommended: boolean | null; evaluation_hash: string | null; content_hash: string;
}

/** identity of the NFL schedule the evaluation saw: byes + next opponents for every team in the pool/roster, hashed */
export function scheduleIdentity(input: WaiverInput): { available: boolean; identity_hash: string | null } {
  const s = input.schedule; if (!s) return { available: false, identity_hash: null };
  const teams = [...new Set([...input.pool.candidates.map((c) => c.player.nfl_team), ...input.weekly.all_rostered.map((p) => p.nfl_team)].filter((t): t is string => !!t))].sort();
  const wk = input.weekly.league.week; return { available: true, identity_hash: hashOf(teams.map((t) => [t, s.bye_week(t), [0, 1, 2, 3].map((i) => s.opponent(t, wk + i))])) };
}

export type CaptureInvocation = "CRON" | "REQUEST";
export interface BuildOpts { kind: CaptureKind; league_slug: string; manager_slug: string; season: number; lock: WaiverLockEvidence | null; invocation?: CaptureInvocation }
function common(ev: WaiverEvaluation, input: WaiverInput, o: BuildOpts) {
  const my = input.teams.find((t) => t.team_id === input.my_team_id)!; const roster = { active_player_ids: [...my.active_player_ids].sort(), faab_remaining: my.faab_remaining, waiver_priority: my.waiver_priority };
  const ids = input.pool.candidates.map((c) => c.canonical_player_id).sort(); const rd = input.pool.readiness ?? input.weekly.free_agent_pool_readiness;
  const snap = input.weekly.lineage?.snapshot as { league_snapshot_id?: string; content_hash?: string } | undefined;
  return {
    // Provenance only: how the evaluation was triggered. NEVER identity and NEVER an eligibility criterion (class + evidence decide).
    provenance: { invocation: o.invocation ?? "REQUEST" },
    schema_version: CAPTURE_RECORD_SCHEMA_VERSION, capture_class: o.kind, season: o.season, week: ev.week, league_slug: o.league_slug, manager_slug: o.manager_slug, scoring_fingerprint: ev.scoring_fingerprint, model_version: WAIVER2_ENGINE_VERSION,
    lifecycle_state: WAIVER2_LIFECYCLE_STATE, params_hash: ev.lineage.params_hash, deployment: { state: WAIVER2_LIFECYCLE_STATE, may_influence_production: mayInfluenceProduction() },
    snapshot: { id: snap?.league_snapshot_id ?? ev.lineage.snapshot, content_hash: snap?.content_hash ?? null },
    market: ((m) => (m ? (o.kind === "NOT_ACTIONABLE" ? { ...m, market_content_id: null, pool_id: null, acquisition_context_id: null, coverage: null } : { ...m, blocks: [...m.blocks], limitations: [...m.limitations] }) : null))(input.pool.market ?? null),
    pool: { certification: ev.availability.certification, readiness: { actionable: rd.actionable, reason_code: rd.reason_code, reasons: rd.reasons, missing_inputs: rd.missing_inputs }, pool_hash: hashOf({ c: ev.availability.certification, ids }), candidate_count: ids.length, candidate_ids: o.kind === "NOT_ACTIONABLE" ? [] : ids },
    roster: { team_id: my.team_id, ...roster, roster_hash: hashOf(roster) }, lock: o.lock,
    evidence: { role: { version: input.role?.version ?? null, through_week: input.role?.through_week ?? null }, fi: { version: input.fi?.version ?? null, through_week: input.fi?.through_week ?? null, week_state: input.fi?.week_state ?? null }, opp: { version: ev.lineage.opp, conditions: [...new Set(ev.actions.map((a) => a.candidate_asset?.opp.condition).filter((x): x is string => !!x && a_isEstablished(x)))].sort() }, schedule: scheduleIdentity(input), projection_model: ev.lineage.projection_model },
  };
}
const a_isEstablished = (c: string) => !/no teammate designation establishes/.test(c);

/** Identity covers the whole decision but NOT wall-clock read times (schedule fetch time / decision date): the same decision must not re-capture every minute. The lock VERDICT and involved teams are identity. */
// A BLOCKED readiness record is a fact about (league, manager, week, pool state, scoring, roster, evidence versions): the canonical snapshot id changes on every read, so it is NOT identity there (otherwise every request would write a new row).
const identityBody = (body: Omit<WaiverShadowCaptureRecord, "capture_id" | "content_hash" | "captured_at">) => ({ ...body, provenance: undefined,
  // The canonical snapshot id AND content hash change on every read (they fold in provider-sync timestamps), so neither is decision identity — for ranked records
  // exactly as for blocked ones (Phase 4.5 fix: without this every request would write a new ranked row). The decision is identified by its market content id, roster hash,
  // evidence versions and the action content ids; `evaluation_hash` folds in lineage.snapshot, so ranked identity uses the action ids instead.
  snapshot: { id: null, content_hash: null }, evaluation_hash: body.record_type === "RANKED_ACTIONS" ? null : body.evaluation_hash, lock: body.lock ? { verdict: body.lock.verdict, reason: body.lock.reason, involved_teams: body.lock.involved_teams } : null });
function finish(body: Omit<WaiverShadowCaptureRecord, "capture_id" | "content_hash" | "captured_at">, capturedAt: string): WaiverShadowCaptureRecord {
  const idb = identityBody(body); const content_hash = hashOf(idb, 16); return { ...body, captured_at: capturedAt, capture_id: `w2cap:${hashOf({ b: idb, c: content_hash }, 16)}`, content_hash };
}

/** Ranked-actions record. Refuses to build a LIVE_* class for an uncertified pool. */
export function buildCaptureRecord(ev: WaiverEvaluation, input: WaiverInput, o: BuildOpts): WaiverShadowCaptureRecord {
  if ((o.kind === "LIVE_CAPTURED" || o.kind === "LIVE_POST_LOCK" || o.kind === "LIVE_UNVERIFIED") && (ev.availability.certification !== "CERTIFIED" || ev.availability.status !== "AVAILABLE")) throw new Error(`refusing to build a ${o.kind} record for an uncertified pool`);
  if (o.kind === "NOT_ACTIONABLE") return buildBlockedRecord(ev, input, o);
  const c = common(ev, input, o);
  const actions: CaptureAction[] = ev.actions.map((a, i) => ({
    rank: i + 1, id: a.id, tier: a.tier, candidate_id: a.candidate?.player_id ?? null, candidate_position: a.candidate?.position ?? null, drop_id: a.drop?.player_id ?? null, archetype: a.candidate_asset?.archetype ?? null, net_action_value: a.net_action_value, net_low: a.net_low, net_high: a.net_high, gross_add_value: a.gross_add_value, drop_cost: a.drop_cost, acquisition_cost: a.acquisition_cost, risk_penalty: a.risk_penalty,
    horizons: { ...a.horizons }, value_by_kind: { ...a.value_by_kind }, uncertainty: { total: a.uncertainty.total, components: a.uncertainty.components.map((u) => ({ source: u.source, level: u.level, weight: u.weight })) },
    faab: { status: a.market.faab.status, calibration: a.market.faab.calibration, rungs: [a.market.faab.min_useful, a.market.faab.expected_competitive, a.market.faab.aggressive, a.market.faab.walk_away] }, priority: a.market.priority.status,
    components: a.components.map((x) => [x.key, x.value] as [string, number | null]), alternatives: a.alternatives.map((x) => ({ candidate_id: x.candidate_id, net_action_value: x.net_action_value })),
    opp: { status: a.candidate_asset?.opp.status ?? "UNAVAILABLE", condition: a.candidate_asset?.opp.condition ?? null, counted_points: a.candidate_asset?.opp.counted_points ?? 0, conditional_payoff_points: a.candidate_asset?.opp.conditional_payoff_points ?? 0 }, content_id: a.content_id,
  }));
  return finish({ ...c, record_type: "RANKED_ACTIONS", actions, recommended_id: ev.recommended?.id ?? null, pass_recommended: ev.recommended == null, evaluation_hash: ev.evaluation_hash }, ev.generated_at);
}
/** Readiness-only record for a BLOCKED evaluation: NO ranked actions, NO candidate list, never counts toward evaluation. */
export function buildBlockedRecord(ev: WaiverEvaluation, input: WaiverInput, o: BuildOpts): WaiverShadowCaptureRecord {
  const c = common(ev, input, { ...o, kind: "NOT_ACTIONABLE" });
  return finish({ ...c, capture_class: "NOT_ACTIONABLE", record_type: "POOL_READINESS_BLOCKED", actions: [], recommended_id: null, pass_recommended: null, evaluation_hash: null, evidence: { ...c.evidence, opp: { version: null, conditions: [] } } }, ev.generated_at);
}

/* ------------------------------------------------------------------------------------------------ validation (shared by every store) */
export function validateCaptureRecord(r: WaiverShadowCaptureRecord): string[] {
  const e: string[] = []; const { content_hash, capture_id, captured_at, ...body } = r; void captured_at;
  if (!capture_id?.startsWith("w2cap:") || !content_hash) e.push("missing identity");
  else { const idb = identityBody(body); if (hashOf(idb, 16) !== content_hash) e.push("content_hash does not match the record (tampered or malformed)"); if (capture_id !== `w2cap:${hashOf({ b: idb, c: content_hash }, 16)}`) e.push("capture_id does not match the record"); }
  if (!CAPTURE_KINDS.includes(r.capture_class)) e.push(`unknown capture class ${r.capture_class}`);
  if (r.record_type !== "RANKED_ACTIONS" && r.record_type !== "POOL_READINESS_BLOCKED") e.push(`unknown record type ${r.record_type}`);
  if (r.record_type === "POOL_READINESS_BLOCKED" && (r.capture_class !== "NOT_ACTIONABLE" || r.actions.length > 0 || r.pool.candidate_ids.length > 0)) e.push("a blocked record must be NOT_ACTIONABLE with no actions and no candidate list");
  if (r.capture_class === "NOT_ACTIONABLE" && r.record_type !== "POOL_READINESS_BLOCKED") e.push("NOT_ACTIONABLE records are readiness facts only");
  if (["LIVE_CAPTURED", "LIVE_POST_LOCK", "LIVE_UNVERIFIED"].includes(r.capture_class) && (r.pool.certification !== "CERTIFIED" || !r.pool.readiness.actionable)) e.push(`${r.capture_class} requires a certified, actionable pool`);
  if (r.schema_version >= 3 && ["LIVE_CAPTURED", "LIVE_POST_LOCK", "LIVE_UNVERIFIED"].includes(r.capture_class) && (!r.market?.market_content_id || r.market.readiness_status === "NOT_READY")) e.push(`${r.capture_class} (v3) requires the market-state lineage of a non-blocked market`);
  if (r.record_type === "POOL_READINESS_BLOCKED" && r.market && (r.market.market_content_id || r.market.pool_id || r.market.coverage)) e.push("a blocked record carries readiness codes only (no per-read market ids)");
  if (r.capture_class === "LIVE_CAPTURED" && r.lock?.verdict !== "PRE_KICKOFF_VERIFIED") e.push("LIVE_CAPTURED requires a verified pre-kickoff lock");
  if (r.deployment.may_influence_production !== mayInfluenceProduction(r.lifecycle_state)) e.push("deployment flag disagrees with the lifecycle state");
  return e;
}

/* ------------------------------------------------------------------------------------------------ outcomes */
export interface WaiverOutcome {
  capture_id: string; source: string; recorded_at: string; outcome_schema_version?: number;
  claim_result: "WON" | "LOST" | "NOT_SUBMITTED" | "UNKNOWN"; winning_bid: number | null; winning_manager?: string | null; candidate_unclaimed?: boolean | null;
  realized: { candidate_points_started: number | null; drop_points_lost: number | null; role_share_change: number | null; roster_survival_weeks: number | null; best_alternative_points_started: number | null };
}
export type WriteStatus = "INSERTED" | "DUPLICATE_IDENTICAL" | "REFUSED" | "ERROR";
export interface WriteResult { status: WriteStatus; reason?: string; store_kind?: string; durable?: boolean }
export interface WaiverCaptureStore {
  readonly kind: string; readonly durable: boolean;
  record(r: WaiverShadowCaptureRecord): WriteResult | Promise<WriteResult>;
  attachOutcome(o: WaiverOutcome): WriteResult | Promise<WriteResult>;
}

/** Insert-only, idempotent, tamper-evident in-memory store — the contract a durable implementation must honor. */
export class MemoryWaiverCaptureStore implements WaiverCaptureStore {
  readonly kind = "memory"; readonly durable = false;
  private caps = new Map<string, WaiverShadowCaptureRecord>(); private outs = new Map<string, WaiverOutcome>();
  record(r: WaiverShadowCaptureRecord): WriteResult {
    const errs = validateCaptureRecord(r); if (errs.length) return { status: "REFUSED", reason: errs.join("; ") };
    const prior = this.caps.get(r.capture_id);
    // same capture_id => same identity content (the id is derived from it); a re-read at a different wall-clock time is the SAME capture
    if (prior) return prior.content_hash === r.content_hash ? { status: "DUPLICATE_IDENTICAL" } : { status: "REFUSED", reason: `capture ${r.capture_id} already exists with different content (rows are immutable)` };
    this.caps.set(r.capture_id, structuredClone(r)); return { status: "INSERTED" };
  }
  attachOutcome(o: WaiverOutcome): WriteResult {
    if (!this.caps.has(o.capture_id)) return { status: "REFUSED", reason: "outcome for an unknown capture" };
    const k = `${o.capture_id}|${o.source}`; const prior = this.outs.get(k);
    if (prior) return JSON.stringify(prior) === JSON.stringify(o) ? { status: "DUPLICATE_IDENTICAL" } : { status: "REFUSED", reason: "outcomes are insert-only" };
    this.outs.set(k, structuredClone(o)); return { status: "INSERTED" };
  }
  list() { return [...this.caps.values()].map((x) => structuredClone(x)); } outcomes() { return [...this.outs.values()].map((x) => structuredClone(x)); }
}

/* ------------------------------------------------------------------------------------------------ eligibility gate */
/** Thresholds are fixed BEFORE outcomes accumulate; meeting them only makes the evidence REVIEWABLE — it never promotes anything. */
export const WAIVER2_EVIDENCE_THRESHOLDS = {
  minimum: { distinct_live_weeks: 8, eligible_decisions: 60, distinct_managers: 3 },
  preferred: { distinct_live_weeks: 14, eligible_decisions: 200, distinct_managers: 6, distinct_leagues: 2 },
} as const;

/** Why a record does (not) count. Pure. */
export function evaluationEligibility(r: WaiverShadowCaptureRecord, hasOutcome: boolean): { eligible: boolean; reasons: string[] } {
  const why: string[] = [];
  if (r.capture_class !== "LIVE_CAPTURED") why.push(`class ${r.capture_class} never counts`);
  if (r.record_type !== "RANKED_ACTIONS") why.push("not a ranked-actions record");
  if (r.pool.certification !== "CERTIFIED" || !r.pool.readiness.actionable) why.push("pool not certified");
  if (!r.market?.market_content_id || r.market.history_class !== "TRUE_AS_OF" || r.market.readiness_status === "NOT_READY") why.push("market-state lineage missing or not a TRUE_AS_OF certified market");
  if (!/^scoring:v1:/.test(r.scoring_fingerprint ?? "")) why.push("invalid scoring fingerprint");
  if (!r.snapshot.id || !r.snapshot.content_hash) why.push("canonical snapshot identity incomplete");
  if (!r.evidence.role.version || !r.evidence.fi.version || !r.evidence.schedule.available) why.push("required evidence identity incomplete (role / FI / schedule)");
  if (!r.actions.length) why.push("no ranked actions");
  if (r.lock?.verdict !== "PRE_KICKOFF_VERIFIED") why.push("decision not verified pre-kickoff");
  if (hashOf({ active_player_ids: r.roster.active_player_ids, faab_remaining: r.roster.faab_remaining, waiver_priority: r.roster.waiver_priority }) !== r.roster.roster_hash) why.push("roster state identity does not verify");
  if (validateCaptureRecord(r).length) why.push("record fails validation");
  if (!hasOutcome) why.push("no outcome attached yet");
  return { eligible: why.length === 0, reasons: why };
}

export interface WaiverEvidenceGate {
  status: "NOT_ELIGIBLE" | "MINIMUM_MET_FOR_REVIEW" | "PREFERRED_MET_FOR_REVIEW"; auto_promotion: false; lifecycle_state: Waiver2LifecycleState;
  eligible_records: number; distinct_weeks: number; distinct_managers: number; distinct_leagues: number; by_position: Record<string, number>;
  excluded: Record<string, number>; thresholds: typeof WAIVER2_EVIDENCE_THRESHOLDS; unmet: string[]; note: string;
}
export function waiver2EvidenceGate(records: WaiverShadowCaptureRecord[], outcomes: Array<Pick<WaiverOutcome, "capture_id">>): WaiverEvidenceGate {
  const outs = new Set(outcomes.map((o) => o.capture_id)); const excluded: Record<string, number> = {}; const weeks = new Set<string>(), mgrs = new Set<string>(), lgs = new Set<string>(); const pos: Record<string, number> = {}; let n = 0;
  const bump = (k: string) => { excluded[k] = (excluded[k] ?? 0) + 1; };
  // ONE decision per (league, manager, season, week): repeated eligible captures of the same decision window (daily cron + requests) are correlated
  // snapshots of one decision, not independent decisions. The earliest eligible record is the decision; later ones are excluded, never counted.
  const windowSeen = new Set<string>();
  for (const r of [...records].sort((a, b) => (a.captured_at < b.captured_at ? -1 : a.captured_at > b.captured_at ? 1 : a.capture_id < b.capture_id ? -1 : 1))) {
    const el = evaluationEligibility(r, outs.has(r.capture_id)); if (!el.eligible) { bump(r.capture_class !== "LIVE_CAPTURED" ? r.capture_class : el.reasons[0]!.startsWith("no outcome") ? "NO_OUTCOME_YET" : "FAILS_ELIGIBILITY"); continue; }
    const wk = `${r.league_slug}|${r.manager_slug}|${r.season}|${r.week}`; if (windowSeen.has(wk)) { bump("CORRELATED_SAME_DECISION_WINDOW"); continue; } windowSeen.add(wk);
    n += 1; weeks.add(`${r.season}-${r.week}`); mgrs.add(`${r.league_slug}/${r.manager_slug}`); lgs.add(r.league_slug);
    const top = r.actions[0]; if (top?.candidate_position) pos[top.candidate_position] = (pos[top.candidate_position] ?? 0) + 1;
  }
  const T = WAIVER2_EVIDENCE_THRESHOLDS; const unmet: string[] = [];
  const chk = (label: string, have: number, need: number) => { if (have < need) unmet.push(`${label}: ${have}/${need}`); };
  chk("distinct live weeks", weeks.size, T.minimum.distinct_live_weeks); chk("eligible decisions with outcomes", n, T.minimum.eligible_decisions); chk("distinct managers", mgrs.size, T.minimum.distinct_managers);
  const minimum = unmet.length === 0; const pref: string[] = []; const chkP = (l: string, h: number, need: number) => { if (h < need) pref.push(`${l}: ${h}/${need}`); };
  chkP("distinct live weeks", weeks.size, T.preferred.distinct_live_weeks); chkP("eligible decisions", n, T.preferred.eligible_decisions); chkP("distinct managers", mgrs.size, T.preferred.distinct_managers); chkP("distinct leagues", lgs.size, T.preferred.distinct_leagues);
  return { status: !minimum ? "NOT_ELIGIBLE" : pref.length === 0 ? "PREFERRED_MET_FOR_REVIEW" : "MINIMUM_MET_FOR_REVIEW", auto_promotion: false, lifecycle_state: WAIVER2_LIFECYCLE_STATE, eligible_records: n, distinct_weeks: weeks.size, distinct_managers: mgrs.size, distinct_leagues: lgs.size, by_position: pos, excluded, thresholds: T, unmet: minimum ? pref : unmet, note: "Meeting a threshold makes the evidence REVIEWABLE only. It never changes the lifecycle state; promotion requires a recorded human approval (requestTransition)." };
}
