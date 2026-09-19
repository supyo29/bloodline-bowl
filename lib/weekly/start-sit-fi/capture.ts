/**
 * Shadow-decision evidence capture (Phase 4 remediation Part C; hardened in Phase 3.5A).
 *
 * The shadow model can only be re-certified later if we keep what it genuinely
 * believed BEFORE kickoff. Everything here exists to make that evidence trustworthy:
 *
 *   * `capture_kind` is a four-way classification, never a free label:
 *       LIVE_CAPTURED               -- recorded from the live system, and EVERY involved
 *                                      NFL game was verifiably `pre_game` when it was
 *                                      recorded (lock evidence stored on the record).
 *       LIVE_POST_LOCK              -- observed live, but a game had already started/finished.
 *                                      Not valid evaluation evidence. Kept, separately countable.
 *       LIVE_UNVERIFIED             -- observed live, lock status could not be verified.
 *                                      Fail closed: never counted as pristine.
 *       HISTORICALLY_RECONSTRUCTED  -- rebuilt from archives. Lower integrity, never merged.
 *   * A record is IMMUTABLE. It carries a deterministic `capture_id`; writing the same
 *     decision twice is a no-op (idempotent). Outcomes are attached later in a SEPARATE
 *     enrichment record keyed by `capture_id` and never rewrite the decision.
 *   * Persistence is telemetry. A store failure never throws into, delays past a bound,
 *     or alters the recommendation -- but it is recorded in `getCaptureHealth()` and logged.
 *   * The default store is durable (Supabase) when configured; otherwise it is
 *     `UnconfiguredCaptureStore`, which reports NOT_CONFIGURED -- it can never be mistaken
 *     for a successful capture.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { StartSitShadowComparison } from "./schema";
import type { RawNflScheduleGame } from "@/lib/canonical/nfl-reality-frontier";

export type CaptureKind =
  | "LIVE_CAPTURED"
  | "LIVE_POST_LOCK"
  | "LIVE_UNVERIFIED"
  | "HISTORICALLY_RECONSTRUCTED";

export const CAPTURE_KINDS: readonly CaptureKind[] = [
  "LIVE_CAPTURED",
  "LIVE_POST_LOCK",
  "LIVE_UNVERIFIED",
  "HISTORICALLY_RECONSTRUCTED",
];

/** Only this class is valid pre-kickoff live evidence. */
export const isValidLiveEvidence = (k: CaptureKind): boolean => k === "LIVE_CAPTURED";

export const CAPTURE_RECORD_SCHEMA_VERSION = 2;

export interface LockEvidence {
  rule: "ALL_INVOLVED_GAMES_PRE_GAME";
  verdict: "PRE_KICKOFF_VERIFIED" | "POST_LOCK" | "UNVERIFIED";
  reason: string;
  schedule_fetched_at: string | null;
  decision_date_et: string | null;
  involved_teams: string[];
  games: Array<{ team: string; date: string | null; status: string | null }>;
  /** kickoff TIME is not in the schedule feed; same-day games rely on `status` alone. */
  same_day_games: number;
}

export interface ShadowDecisionRecord {
  capture_kind: CaptureKind;
  decision_timestamp: string;
  season: number;
  week: number;
  league_slug: string;
  manager_slug: string;
  /** canonical scoring identity for the league (spec §26). */
  scoring_fingerprint: string | null;
  start_sit_model_version: string;
  football_intelligence_version: string | null;
  football_intel_data_cutoff: Record<string, number> | null;
  baseline_projection_version: string;
  deployment: string;
  /** per close-call: identities, baseline proj, FI inputs, adjusted proj, both picks, reversal. */
  decisions: Array<{
    slot: string | null;
    baseline_start: string;
    fi_start: string;
    baseline_edge: number | null;
    fi_edge: number | null;
    reversal: boolean;
    inside_tie_break_gate: boolean;
    reason_codes: string[];
  }>;
  adjustments: Array<{
    canonical_player_id: string;
    position: string;
    nfl_team: string | null;
    opponent: string | null;
    baseline_projection: number | null;
    expected_adjustment: number;
    adjusted_projection: number | null;
    decision_confidence: string;
    fi_prior_season_only: boolean;
    contributions: Array<{ family: string; routing: string; fi_value: number | null; fi_confidence: string | null; points_contribution: number }>;
  }>;
  /**
   * LEGACY. Always `null` on a captured record -- decisions are immutable. Outcomes live
   * in a separate enrichment record (`ShadowOutcomeRecord`) keyed by `capture_id`.
   */
  actual_fantasy_points: Record<string, number> | null;

  // ---- schema v2 (additive; absent on legacy records) ----------------------
  record_schema_version?: number;
  /** deterministic identity: same material decision context => same id. */
  capture_id?: string;
  /** hash of the decision content (decisions + adjustments); excludes timestamps. */
  content_hash?: string;
  /** fingerprint of the served start_sit_model.json the decision was made with. */
  model_fingerprint?: string | null;
  /** when FI generated the snapshot the decision consulted. */
  fi_generated_at?: string | null;
  lock_evidence?: LockEvidence;
}

/** Enrichment record: attaches actuals to a captured decision WITHOUT mutating it. */
export interface ShadowOutcomeRecord {
  capture_id: string;
  source: string;
  recorded_at: string;
  scoring_fingerprint: string | null;
  actual_fantasy_points: Record<string, number>;
}

export type CaptureWriteStatus =
  | "CREATED"
  | "DUPLICATE"
  | "NOT_CONFIGURED"
  | "NOT_CAPTURED_NULL_STORE"
  | "TIMEOUT"
  | "ERROR";

export interface CaptureWriteResult {
  status: CaptureWriteStatus;
  capture_id: string | null;
  durable: boolean;
  store_kind: string;
  error?: string;
}

export interface CaptureSummary {
  available: boolean;
  store_kind: string;
  durable: boolean;
  generated_at: string;
  error?: string;
  totals_by_kind: Record<string, number>;
  live_captured_by_week: Record<string, number>;
  by_week_kind: Array<{ season: number; week: number; kind: string; n: number }>;
  by_model_version: Record<string, number>;
  by_fi_version: Record<string, number>;
  by_scoring_fingerprint: Record<string, number>;
  by_position: Record<string, { decisions: number; reversals: number }>;
  outcomes_attached: number;
}

export interface ShadowCaptureStore {
  readonly kind: string;
  /** true only when a successful record() survives a process restart / redeploy. */
  readonly durable: boolean;
  /** Legacy stores return void; new stores return a write result. */
  record(rec: ShadowDecisionRecord): void | CaptureWriteResult | Promise<CaptureWriteResult | void>;
  recordOutcome?(o: ShadowOutcomeRecord): Promise<CaptureWriteResult>;
  summary?(): Promise<CaptureSummary>;
}

export class NullCaptureStore implements ShadowCaptureStore {
  readonly kind = "null";
  readonly durable = false;
  record(): void {
    /* no-op */
  }
}

/** Nothing is configured to persist evidence. Explicit failure, never a silent success. */
export class UnconfiguredCaptureStore implements ShadowCaptureStore {
  readonly kind = "unconfigured";
  readonly durable = false;
  record(rec?: ShadowDecisionRecord): CaptureWriteResult {
    return { status: "NOT_CONFIGURED", capture_id: rec?.capture_id ?? null, durable: false, store_kind: this.kind, error: "no durable capture store configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" };
  }
  async summary(): Promise<CaptureSummary> {
    return emptySummary(this.kind, false, false, "no durable capture store configured");
  }
}

/** Local JSONL. NOT durable on Vercel; retained for CLI/research use. */
export class FileCaptureStore implements ShadowCaptureStore {
  readonly kind = "file";
  readonly durable = false;
  private readonly dir: string;
  constructor(baseDir?: string) {
    this.dir = baseDir ?? join(process.cwd(), "outputs", "startsit-2026", "shadow_capture");
  }
  record(rec: ShadowDecisionRecord): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${rec.season}_w${String(rec.week).padStart(2, "0")}.jsonl`);
    appendFileSync(file, JSON.stringify(rec) + "\n");
  }
}

/** In-process store (tests / deterministic harnesses). Idempotent on `capture_id`. */
export class MemoryShadowCaptureStore implements ShadowCaptureStore {
  readonly kind = "memory";
  readonly durable = false;
  readonly records = new Map<string, ShadowDecisionRecord>();
  readonly outcomes = new Map<string, ShadowOutcomeRecord>();
  record(rec: ShadowDecisionRecord): CaptureWriteResult {
    const id = rec.capture_id ?? null;
    if (!id) return { status: "ERROR", capture_id: null, durable: false, store_kind: this.kind, error: "record has no capture_id" };
    if (this.records.has(id)) return { status: "DUPLICATE", capture_id: id, durable: false, store_kind: this.kind };
    this.records.set(id, deepFreeze(structuredClone(rec)));
    return { status: "CREATED", capture_id: id, durable: false, store_kind: this.kind };
  }
  async recordOutcome(o: ShadowOutcomeRecord): Promise<CaptureWriteResult> {
    if (!this.records.has(o.capture_id)) return { status: "ERROR", capture_id: o.capture_id, durable: false, store_kind: this.kind, error: "unknown capture_id" };
    const key = `${o.capture_id}|${o.source}`;
    if (this.outcomes.has(key)) return { status: "DUPLICATE", capture_id: o.capture_id, durable: false, store_kind: this.kind };
    this.outcomes.set(key, deepFreeze(structuredClone(o)));
    return { status: "CREATED", capture_id: o.capture_id, durable: false, store_kind: this.kind };
  }
  async summary(): Promise<CaptureSummary> {
    return summarize([...this.records.values()], this.outcomes.size, this.kind, false);
  }
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

// ---------------------------------------------------------------------------
// Store registry
// ---------------------------------------------------------------------------

let explicitStore: ShadowCaptureStore | null = null;
let defaultResolver: (() => ShadowCaptureStore) | null = null;

/** Wire the process default (used by the Supabase store module to self-register lazily). */
export function setDefaultShadowCaptureStoreResolver(fn: (() => ShadowCaptureStore) | null): void {
  defaultResolver = fn;
}

export function setShadowCaptureStore(s: ShadowCaptureStore | null): void {
  explicitStore = s;
}

/**
 * The store used by ordinary runtime. An explicitly set store wins. Otherwise the default
 * resolver (durable Supabase when configured). Never silently `NullCaptureStore`.
 * Under `node --test` the default is disabled unless a test injects a store, so a test
 * run can never write to a real database.
 */
export function getShadowCaptureStore(): ShadowCaptureStore {
  if (explicitStore) return explicitStore;
  if (process.env.START_SIT_SHADOW_CAPTURE === "off" || process.env.NODE_TEST_CONTEXT) return new NullCaptureStore();
  if (defaultResolver) return defaultResolver();
  return new UnconfiguredCaptureStore();
}

// ---------------------------------------------------------------------------
// Identity + lock classification (pure)
// ---------------------------------------------------------------------------

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function decisionContentHash(rec: Pick<ShadowDecisionRecord, "decisions" | "adjustments">): string {
  return sha(canonical({ decisions: rec.decisions, adjustments: rec.adjustments })).slice(0, 32);
}

/**
 * Deterministic identity of one material decision. Includes the capture class, so a
 * post-lock observation or a reconstruction of the same numbers is a DIFFERENT record and
 * can never collide with (or be silently deduplicated into) genuine pre-kickoff evidence.
 * Excludes wall-clock timestamps, so repeated identical requests share an id.
 */
export function shadowCaptureId(r: Omit<ShadowDecisionRecord, "capture_id">): string {
  const material = {
    kind: r.capture_kind, season: r.season, week: r.week, league: r.league_slug, manager: r.manager_slug,
    scoring: r.scoring_fingerprint, model: r.start_sit_model_version, model_fp: r.model_fingerprint ?? null,
    fi: r.football_intelligence_version, fi_cutoff: r.football_intel_data_cutoff,
    baseline: r.baseline_projection_version, content: r.content_hash,
  };
  return `ssc:${sha(canonical(material)).slice(0, 32)}`;
}

const etDate = (iso: string): string | null => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};

/** Max age of the schedule read relative to the decision, so a stale cache can't vouch for it. */
export const LOCK_SCHEDULE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Pure. LIVE_CAPTURED only when every involved team's game this week is verifiably
 * `pre_game`, in a schedule read taken at (about) decision time, with no involved game's
 * date already past. Everything else is POST_LOCK or UNVERIFIED -- never pristine.
 */
export function classifyLock(input: {
  decision_timestamp: string;
  week: number;
  involved_teams: string[];
  games: RawNflScheduleGame[] | null;
  schedule_fetched_at: string | null;
}): { kind: CaptureKind; evidence: LockEvidence } {
  const teams = [...new Set(input.involved_teams.filter(Boolean).map((t) => t.toUpperCase()))].sort();
  const decisionEt = etDate(input.decision_timestamp);
  const base: LockEvidence = {
    rule: "ALL_INVOLVED_GAMES_PRE_GAME", verdict: "UNVERIFIED", reason: "",
    schedule_fetched_at: input.schedule_fetched_at, decision_date_et: decisionEt,
    involved_teams: teams, games: [], same_day_games: 0,
  };
  const unverified = (reason: string) => ({ kind: "LIVE_UNVERIFIED" as CaptureKind, evidence: { ...base, reason } });

  if (!decisionEt) return unverified("DECISION_TIMESTAMP_INVALID");
  if (!input.games || input.games.length === 0 || !input.schedule_fetched_at) return unverified("SCHEDULE_UNAVAILABLE");
  const age = Math.abs(new Date(input.decision_timestamp).getTime() - new Date(input.schedule_fetched_at).getTime());
  if (!(age <= LOCK_SCHEDULE_MAX_AGE_MS)) return unverified("SCHEDULE_READ_NOT_AT_DECISION_TIME");
  if (teams.length === 0) return unverified("NO_INVOLVED_TEAMS");

  const games: LockEvidence["games"] = [];
  let postLock: string | null = null;
  for (const t of teams) {
    const g = input.games.find((x) => x.week === input.week && (x.home?.toUpperCase() === t || x.away?.toUpperCase() === t));
    if (!g) continue; // bye / no game: nothing to lock
    const status = (g.status ?? "").trim().toLowerCase() || null;
    games.push({ team: t, date: g.date ?? null, status });
    if (status !== "pre_game") postLock ??= `GAME_NOT_PRE_GAME:${t}:${status ?? "unknown"}`;
    else if (g.date && g.date < decisionEt) postLock ??= `GAME_DATE_PAST_DESPITE_STATUS:${t}:${g.date}`;
  }
  const evidence: LockEvidence = { ...base, games, same_day_games: games.filter((g) => g.date === decisionEt).length };
  if (games.length === 0) return { kind: "LIVE_UNVERIFIED", evidence: { ...evidence, reason: "NO_INVOLVED_GAMES_FOUND" } };
  if (postLock) return { kind: "LIVE_POST_LOCK", evidence: { ...evidence, verdict: "POST_LOCK", reason: postLock } };
  return { kind: "LIVE_CAPTURED", evidence: { ...evidence, verdict: "PRE_KICKOFF_VERIFIED", reason: "ALL_INVOLVED_GAMES_PRE_GAME" } };
}

export function involvedTeams(cmp: StartSitShadowComparison): string[] {
  const s = new Set<string>();
  for (const a of cmp.adjustments) {
    if (a.nfl_team) s.add(a.nfl_team);
    if (a.opponent) s.add(a.opponent);
  }
  return [...s];
}

// ---------------------------------------------------------------------------
// Record construction
// ---------------------------------------------------------------------------

export interface CaptureMeta {
  season: number;
  week: number;
  league_slug: string;
  manager_slug: string;
  scoring_fingerprint: string | null;
  /**
   * Requested class. `HISTORICALLY_RECONSTRUCTED` is honoured. A live class is NEVER taken on
   * trust: without `lock_evidence` proving pre-kickoff it is downgraded to LIVE_UNVERIFIED,
   * and with evidence the classifier's verdict overrides the request.
   */
  kind?: CaptureKind;
  lock_evidence?: { kind: CaptureKind; evidence: LockEvidence };
  model_fingerprint?: string | null;
}

/** Pure: builds the immutable, identified record. Does not touch any store. */
export function buildShadowDecisionRecord(cmp: StartSitShadowComparison, meta: CaptureMeta): ShadowDecisionRecord {
  let kind: CaptureKind;
  let lock: LockEvidence | undefined;
  if (meta.kind === "HISTORICALLY_RECONSTRUCTED") {
    kind = "HISTORICALLY_RECONSTRUCTED";
  } else if (meta.lock_evidence) {
    kind = meta.lock_evidence.kind;
    lock = meta.lock_evidence.evidence;
  } else {
    kind = "LIVE_UNVERIFIED"; // a bare live request without lock evidence can never be pristine
  }

  const decisions = cmp.start_sit_deltas.map((d) => ({
    slot: d.slot,
    baseline_start: d.baseline_start,
    fi_start: d.fi_start,
    baseline_edge: d.baseline_edge,
    fi_edge: d.fi_edge,
    reversal: d.changed,
    inside_tie_break_gate: d.inside_tie_break_gate,
    reason_codes: d.reason_codes as string[],
  }));
  const adjustments = cmp.adjustments.map((a) => ({
    canonical_player_id: a.canonical_player_id,
    position: a.position,
    nfl_team: a.nfl_team,
    opponent: a.opponent,
    baseline_projection: a.baseline_projection,
    expected_adjustment: a.expected_adjustment,
    adjusted_projection: a.adjusted_projection,
    decision_confidence: a.decision_confidence as string,
    fi_prior_season_only: a.fi_prior_season_only,
    contributions: a.contributions.map((c) => ({
      family: c.family,
      routing: c.routing,
      fi_value: c.fi_value,
      fi_confidence: c.fi_confidence,
      points_contribution: c.points_contribution,
    })),
  }));

  const partial: Omit<ShadowDecisionRecord, "capture_id"> = {
    capture_kind: kind,
    decision_timestamp: cmp.lineage.decision_generated_at,
    season: meta.season,
    week: meta.week,
    league_slug: meta.league_slug,
    manager_slug: meta.manager_slug,
    scoring_fingerprint: meta.scoring_fingerprint,
    start_sit_model_version: cmp.lineage.start_sit_model_version,
    football_intelligence_version: cmp.lineage.football_intelligence_version,
    football_intel_data_cutoff: cmp.lineage.football_intel_data_cutoff,
    baseline_projection_version: cmp.lineage.baseline_projection_version,
    deployment: cmp.lineage.deployment,
    decisions,
    adjustments,
    actual_fantasy_points: null,
    record_schema_version: CAPTURE_RECORD_SCHEMA_VERSION,
    content_hash: decisionContentHash({ decisions, adjustments }),
    model_fingerprint: meta.model_fingerprint ?? null,
    fi_generated_at: cmp.shadow_football_intelligence?.lineage?.generated_at ?? null,
    ...(lock ? { lock_evidence: lock } : {}),
  };
  return deepFreeze({ ...partial, capture_id: shadowCaptureId(partial) });
}

/**
 * LEGACY synchronous entry point (kept for API compatibility). Builds the record and hands it
 * to the current store's `record()`. Ordinary runtime uses `persistShadowDecision` instead,
 * which is async, bounded, idempotent and observable.
 */
export function captureShadowDecision(cmp: StartSitShadowComparison, meta: CaptureMeta): ShadowDecisionRecord {
  const rec = buildShadowDecisionRecord(cmp, meta);
  const r = getShadowCaptureStore().record(rec);
  if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).catch(() => undefined);
  return rec;
}

// ---------------------------------------------------------------------------
// Observable, bounded, never-throwing persistence (runtime path)
// ---------------------------------------------------------------------------

export interface CaptureHealth {
  attempts: number;
  created: number;
  duplicates: number;
  failures: number;
  not_captured: number;
  last_attempt_at: string | null;
  last_status: CaptureWriteStatus | null;
  last_error: string | null;
  last_store_kind: string | null;
  last_store_durable: boolean | null;
  by_kind: Record<string, number>;
}

const health: CaptureHealth = {
  attempts: 0, created: 0, duplicates: 0, failures: 0, not_captured: 0,
  last_attempt_at: null, last_status: null, last_error: null, last_store_kind: null, last_store_durable: null, by_kind: {},
};
export const getCaptureHealth = (): CaptureHealth => ({ ...health, by_kind: { ...health.by_kind } });
export function __resetCaptureHealth(): void {
  Object.assign(health, { attempts: 0, created: 0, duplicates: 0, failures: 0, not_captured: 0, last_attempt_at: null, last_status: null, last_error: null, last_store_kind: null, last_store_durable: null, by_kind: {} });
  recentIds.clear();
}

/** ids already written by THIS process; a cheap short-circuit only -- the store PK is the real guard. */
const recentIds = new Set<string>();
const RECENT_MAX = 500;
export const CAPTURE_TIMEOUT_MS = 2500;

export interface PersistOutcome {
  record: ShadowDecisionRecord | null;
  result: CaptureWriteResult;
}

export async function persistShadowRecord(rec: ShadowDecisionRecord, timeoutMs = CAPTURE_TIMEOUT_MS): Promise<CaptureWriteResult> {
  const store = getShadowCaptureStore();
  const done = (result: CaptureWriteResult): CaptureWriteResult => {
    health.attempts += 1;
    health.last_attempt_at = new Date().toISOString();
    health.last_status = result.status;
    health.last_store_kind = result.store_kind;
    health.last_store_durable = result.durable;
    health.by_kind[rec.capture_kind] = (health.by_kind[rec.capture_kind] ?? 0) + 1;
    if (result.status === "CREATED") health.created += 1;
    else if (result.status === "DUPLICATE") health.duplicates += 1;
    else if (result.status === "NOT_CAPTURED_NULL_STORE" || result.status === "NOT_CONFIGURED") health.not_captured += 1;
    else health.failures += 1;
    if (result.status !== "CREATED" && result.status !== "DUPLICATE") {
      health.last_error = result.error ?? result.status;
      // eslint-disable-next-line no-console
      console.warn(`[start-sit-capture] not persisted: ${result.status} store=${result.store_kind} durable=${result.durable}${result.error ? ` (${result.error})` : ""}`);
    }
    return result;
  };
  if (store.kind === "null") {
    return done({ status: "NOT_CAPTURED_NULL_STORE", capture_id: rec.capture_id ?? null, durable: false, store_kind: "null" });
  }
  if (rec.capture_id && recentIds.has(rec.capture_id) && store.durable) {
    return done({ status: "DUPLICATE", capture_id: rec.capture_id, durable: true, store_kind: store.kind });
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CaptureWriteResult>((res) => {
      timer = setTimeout(() => res({ status: "TIMEOUT", capture_id: rec.capture_id ?? null, durable: store.durable, store_kind: store.kind, error: `store exceeded ${timeoutMs}ms` }), timeoutMs);
    });
    const write = Promise.resolve(store.record(rec)).then((r) =>
      r ?? { status: "CREATED" as const, capture_id: rec.capture_id ?? null, durable: store.durable, store_kind: store.kind },
    );
    const result = await Promise.race([write, timeout]);
    if (timer) clearTimeout(timer);
    if ((result.status === "CREATED" || result.status === "DUPLICATE") && store.durable && rec.capture_id) {
      if (recentIds.size >= RECENT_MAX) recentIds.clear();
      recentIds.add(rec.capture_id);
    }
    return done(result);
  } catch (e) {
    return done({ status: "ERROR", capture_id: rec.capture_id ?? null, durable: store.durable, store_kind: store.kind, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Build + persist. Never throws. */
export async function persistShadowDecision(cmp: StartSitShadowComparison, meta: CaptureMeta, timeoutMs = CAPTURE_TIMEOUT_MS): Promise<PersistOutcome> {
  let rec: ShadowDecisionRecord | null = null;
  try {
    rec = buildShadowDecisionRecord(cmp, meta);
    return { record: rec, result: await persistShadowRecord(rec, timeoutMs) };
  } catch (e) {
    health.attempts += 1;
    health.failures += 1;
    health.last_status = "ERROR";
    health.last_error = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.warn(`[start-sit-capture] record build failed: ${health.last_error}`);
    return { record: rec, result: { status: "ERROR", capture_id: null, durable: false, store_kind: getShadowCaptureStore().kind, error: health.last_error } };
  }
}

// ---------------------------------------------------------------------------
// Outcome enrichment (never mutates the decision)
// ---------------------------------------------------------------------------

/** Pure: a NEW view joining a decision with its outcome. The inputs are untouched. */
export function withOutcome(rec: ShadowDecisionRecord, o: ShadowOutcomeRecord) {
  if (o.capture_id !== rec.capture_id) throw new Error("outcome does not belong to this capture");
  return { decision: rec, outcome: o };
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export function emptySummary(store_kind: string, durable: boolean, available: boolean, error?: string): CaptureSummary {
  return {
    available, store_kind, durable, generated_at: new Date().toISOString(), ...(error ? { error } : {}),
    totals_by_kind: {}, live_captured_by_week: {}, by_week_kind: [], by_model_version: {}, by_fi_version: {},
    by_scoring_fingerprint: {}, by_position: {}, outcomes_attached: 0,
  };
}

export function summarize(recs: ShadowDecisionRecord[], outcomes: number, store_kind: string, durable: boolean): CaptureSummary {
  const s = emptySummary(store_kind, durable, true);
  const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
  const wk = new Map<string, number>();
  for (const r of recs) {
    bump(s.totals_by_kind, r.capture_kind);
    bump(s.by_model_version, `${r.capture_kind}|${r.start_sit_model_version}`);
    bump(s.by_fi_version, `${r.capture_kind}|${r.football_intelligence_version ?? "none"}`);
    bump(s.by_scoring_fingerprint, `${r.capture_kind}|${r.scoring_fingerprint ?? "none"}`);
    if (r.capture_kind === "LIVE_CAPTURED") bump(s.live_captured_by_week, String(r.week));
    const k = `${r.season}|${r.week}|${r.capture_kind}`;
    wk.set(k, (wk.get(k) ?? 0) + 1);
    // decisions/reversals are only reported for VALID live evidence, never blended across classes
    if (r.capture_kind === "LIVE_CAPTURED") {
      const posOf = new Map(r.adjustments.map((a) => [a.canonical_player_id, a.position]));
      for (const d of r.decisions) {
        const pos = posOf.get(d.baseline_start) ?? "UNKNOWN";
        const e = (s.by_position[pos] ??= { decisions: 0, reversals: 0 });
        e.decisions += 1;
        if (d.reversal) e.reversals += 1;
      }
    }
  }
  s.by_week_kind = [...wk.entries()].map(([k, n]) => { const [season, week, kind] = k.split("|"); return { season: Number(season), week: Number(week), kind: kind!, n }; })
    .sort((a, b) => a.season - b.season || a.week - b.week || a.kind.localeCompare(b.kind));
  s.outcomes_attached = outcomes;
  return s;
}
