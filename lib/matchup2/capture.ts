/**
 * Phase 5 Checkpoint G — PROSPECTIVE SHADOW CAPTURE for Matchup Intelligence 2.0.
 *
 * Historical per-week matchup state was never preserved, and player×scheme families cannot be rebuilt as-of for a live decision with the
 * production baseline of the time. The honest path is to capture pristine, content-addressed PRE-GAME evaluations going forward and attach
 * outcomes later, without ever touching the decision. Classes are derived from evidence, never chosen:
 *   LIVE_CAPTURED   server-derived baseline present AND the player's own game verifiably pre-game in a schedule read at decision time
 *   LIVE_POST_LOCK  observed live, but the game had already started
 *   LIVE_UNVERIFIED observed live, lock could not be verified
 *   HISTORICALLY_RECONSTRUCTED / ILLUSTRATIVE  never count (ILLUSTRATIVE is never persisted)
 * Only the server (a scheduled job with the production baseline) can create a record: a public evidence request has no baseline and can never
 * manufacture evaluation-eligible evidence, and request volume cannot inflate counts (identity dedupe + one decision per player-week-scoring).
 */
import { hashOf } from "./hash";
import { MATCHUP2_LIFECYCLE, MATCHUP2_VERSION, type MatchupEvaluation } from "./contract";

export type Matchup2CaptureClass = "LIVE_CAPTURED" | "LIVE_POST_LOCK" | "LIVE_UNVERIFIED" | "HISTORICALLY_RECONSTRUCTED" | "ILLUSTRATIVE";
export const MATCHUP2_CAPTURE_CLASSES: Matchup2CaptureClass[] = ["LIVE_CAPTURED", "LIVE_POST_LOCK", "LIVE_UNVERIFIED", "HISTORICALLY_RECONSTRUCTED", "ILLUSTRATIVE"];
export const MATCHUP2_CAPTURE_SCHEMA_VERSION = 1;
export type CaptureInvocation = "CRON" | "REQUEST";

export interface GameLock { verdict: "PRE_KICKOFF_VERIFIED" | "POST_LOCK" | "UNVERIFIED"; reason: string; team: string; game: { home: string | null; away: string | null; status: string | null; date: string | null } | null }
export interface ScheduleGame { week: number; home?: string | null; away?: string | null; date?: string | null; status?: string | null }
export const LOCK_SCHEDULE_MAX_AGE_MS = 5 * 60 * 1000;
const etDate = (iso: string): string | null => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); };
/** Pure. Pristine only if THIS player's own game this week is verifiably `pre_game` in a schedule read taken at decision time. No kickoff time is invented. */
export function classifyGameLock(i: { decision_timestamp: string; week: number; team: string; games: ScheduleGame[] | null; schedule_fetched_at: string | null }): GameLock {
  const team = i.team.toUpperCase(); const un = (reason: string, game: GameLock["game"] = null): GameLock => ({ verdict: "UNVERIFIED", reason, team, game }); const day = etDate(i.decision_timestamp);
  if (!day) return un("DECISION_TIMESTAMP_INVALID"); if (!i.games?.length || !i.schedule_fetched_at) return un("SCHEDULE_UNAVAILABLE");
  if (!(Math.abs(new Date(i.decision_timestamp).getTime() - new Date(i.schedule_fetched_at).getTime()) <= LOCK_SCHEDULE_MAX_AGE_MS)) return un("SCHEDULE_READ_NOT_AT_DECISION_TIME");
  const g = i.games.find((x) => x.week === i.week && (x.home?.toUpperCase() === team || x.away?.toUpperCase() === team)); if (!g) return un("NO_GAME_FOUND_FOR_TEAM");
  const game = { home: g.home ?? null, away: g.away ?? null, status: g.status ?? null, date: g.date ?? null }; const st = (g.status ?? "").trim().toLowerCase();
  if (st !== "pre_game") return { verdict: "POST_LOCK", reason: `GAME_NOT_PRE_GAME:${st || "unknown"}`, team, game }; if (g.date && g.date < day) return { verdict: "POST_LOCK", reason: `GAME_DATE_PAST:${g.date}`, team, game };
  return { verdict: "PRE_KICKOFF_VERIFIED", reason: "OWN_GAME_PRE_GAME", team, game };
}

export interface Baseline { source: string; model_version: string; projected_points: number | null; scoring_fingerprint: string | null; injury_status: string | null; expected_availability: number | null }
export interface CaptureComponent { id: string; family: string; direction: string; value: number | null; z: number | null; evidence: string; window: string | null; predictive_class: string }
export interface Matchup2CaptureRecord {
  schema_version: number; capture_id: string; content_hash: string; capture_class: Matchup2CaptureClass; captured_at: string; season: number; week: number;
  player: { gsis_id: string; name: string | null; position: string; team: string | null }; opponent: string; model_version: string; lifecycle_state: string; may_influence_production: false;
  context_identity: string; evidence_identities: { fi: string | null; role: string | null; player_scheme: string | null; opp: string | null };
  scoring_fingerprint: string | null; baseline: Baseline | null; components: CaptureComponent[]; structural_verdict: string; overall_evidence: string; generic_percentile: number | null; uncertainty_kinds: string[];
  lock: GameLock | null; provenance?: { invocation: CaptureInvocation };
}
export function captureKindFor(f: { illustrative: boolean; is_reconstruction: boolean; lock: GameLock | null; has_baseline: boolean }): Matchup2CaptureClass {
  if (f.illustrative) return "ILLUSTRATIVE"; if (f.is_reconstruction) return "HISTORICALLY_RECONSTRUCTED";
  if (!f.lock || f.lock.verdict === "UNVERIFIED" || !f.has_baseline) return "LIVE_UNVERIFIED"; return f.lock.verdict === "POST_LOCK" ? "LIVE_POST_LOCK" : "LIVE_CAPTURED";
}
const r4 = (x: number | null): number | null => (x == null ? null : Math.round(x * 1e4) / 1e4);
/** Identity = the decision context. EXCLUDES read times, provenance, request ids and the lock's schedule-read time; INCLUDES the lock verdict, baseline, scoring fingerprint, versions, components. */
type Body = Omit<Matchup2CaptureRecord, "capture_id" | "content_hash" | "captured_at">;
const identityBody = (b: Body) => ({ ...b, provenance: undefined, lock: b.lock ? { verdict: b.lock.verdict, reason: b.lock.reason, team: b.lock.team } : null, baseline: b.baseline ? { ...b.baseline, projected_points: b.baseline.projected_points == null ? null : Math.round(b.baseline.projected_points * 100) / 100 } : null });
function finish(b: Body, at: string): Matchup2CaptureRecord { const idb = identityBody(b); const content_hash = hashOf(idb, 16); return { ...b, captured_at: at, capture_id: `m2cap:${hashOf({ b: idb, c: content_hash }, 16)}`, content_hash }; }
export function buildCaptureRecord(e: MatchupEvaluation, o: { kind: Matchup2CaptureClass; baseline: Baseline | null; lock: GameLock | null; captured_at: string; invocation?: CaptureInvocation }): Matchup2CaptureRecord {
  if (e.offense_subject.kind !== "PLAYER" || !e.offense_subject.position) throw new Error("only player evaluations are captured");
  if (o.kind === "ILLUSTRATIVE") throw new Error("ILLUSTRATIVE evaluations are never captured");
  const body: Body = { schema_version: MATCHUP2_CAPTURE_SCHEMA_VERSION, capture_class: o.kind, season: e.game.season, week: e.game.week ?? 0, player: { gsis_id: e.offense_subject.id, name: e.offense_subject.name, position: e.offense_subject.position, team: e.offense_subject.team }, opponent: e.game.defense_team,
    model_version: MATCHUP2_VERSION, lifecycle_state: MATCHUP2_LIFECYCLE, may_influence_production: false, context_identity: e.lineage.context_identity, evidence_identities: { fi: e.lineage.fi_version, role: e.lineage.role_version, player_scheme: e.lineage.player_scheme_identity, opp: e.lineage.opp_version },
    scoring_fingerprint: e.lineage.scoring_fingerprint ?? o.baseline?.scoring_fingerprint ?? null, baseline: o.baseline, components: e.components.filter((c) => c.origin !== "MODELED_GAME_EXPECTATION").map((c) => ({ id: c.id, family: c.family, direction: c.direction, value: r4(c.value), z: c.z == null ? null : Math.round(c.z * 1e3) / 1e3, evidence: c.evidence, window: c.window, predictive_class: c.predictive_class })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    structural_verdict: e.structural_verdict, overall_evidence: e.overall_evidence, generic_percentile: e.generic_defense_context.overall_percentile, uncertainty_kinds: e.uncertainty.map((u) => u.kind).sort(), lock: o.lock, provenance: { invocation: o.invocation ?? "REQUEST" } };
  return finish(body, o.captured_at);
}
export function validateCaptureRecord(r: Matchup2CaptureRecord): string[] {
  const e: string[] = []; const { capture_id, content_hash, captured_at, ...body } = r; void captured_at;
  if (!capture_id?.startsWith("m2cap:") || !content_hash) e.push("missing identity"); else { const idb = identityBody(body); if (hashOf(idb, 16) !== content_hash) e.push("content_hash does not match the record (tampered or malformed)"); if (capture_id !== `m2cap:${hashOf({ b: idb, c: content_hash }, 16)}`) e.push("capture_id does not match the record"); }
  if (!MATCHUP2_CAPTURE_CLASSES.includes(r.capture_class)) e.push(`unknown capture class ${r.capture_class}`); if (r.capture_class === "ILLUSTRATIVE") e.push("ILLUSTRATIVE records are never persisted");
  if (r.may_influence_production !== false || r.lifecycle_state !== "SHADOW_ONLY") e.push("a Matchup 2.0 record must be SHADOW_ONLY and non-influencing");
  if (r.capture_class === "LIVE_CAPTURED" && (r.lock?.verdict !== "PRE_KICKOFF_VERIFIED" || !r.baseline)) e.push("LIVE_CAPTURED requires a verified pre-kickoff lock and a baseline projection");
  if (r.capture_class === "LIVE_POST_LOCK" && r.lock?.verdict !== "POST_LOCK") e.push("LIVE_POST_LOCK requires a POST_LOCK verdict");
  return e;
}
export const MATCHUP2_EVIDENCE_THRESHOLDS = { minimum: { distinct_live_weeks: 8, eligible_decisions: 300, distinct_players: 100, positions_covered: 4 }, preferred: { distinct_live_weeks: 14, eligible_decisions: 1500, distinct_players: 250, positions_covered: 4 } } as const;
export function evaluationEligibility(r: Matchup2CaptureRecord, hasOutcome: boolean): { eligible: boolean; reasons: string[] } {
  const why: string[] = []; if (r.capture_class !== "LIVE_CAPTURED") why.push(`class ${r.capture_class} never counts`);
  if (!r.baseline || r.baseline.projected_points == null || !r.baseline.model_version) why.push("no baseline projection at decision time"); if (!/^scoring:v1:/.test(r.scoring_fingerprint ?? "")) why.push("invalid scoring fingerprint");
  if (!r.evidence_identities.fi || !r.evidence_identities.role || !r.evidence_identities.player_scheme) why.push("required evidence identity incomplete (FI / Role / Player-Scheme)");
  if (!r.components.some((c) => c.direction === "ADVANTAGE" || c.direction === "DISADVANTAGE" || c.direction === "NEUTRAL")) why.push("no determinable matchup component"); if (r.lock?.verdict !== "PRE_KICKOFF_VERIFIED") why.push("decision not verified pre-kickoff");
  if (validateCaptureRecord(r).length) why.push("record fails validation"); if (!hasOutcome) why.push("no outcome attached yet"); return { eligible: why.length === 0, reasons: why };
}
export interface Matchup2Outcome { capture_id: string; source: string; recorded_at: string; realized_fantasy_points: number | null; played: boolean }
export interface Matchup2Gate { status: "NOT_ELIGIBLE" | "MINIMUM_MET_FOR_REVIEW" | "PREFERRED_MET_FOR_REVIEW"; auto_promotion: false; eligible_decisions: number; distinct_weeks: number; distinct_players: number; positions_covered: number; excluded: Record<string, number>; thresholds: typeof MATCHUP2_EVIDENCE_THRESHOLDS; unmet: string[]; note: string }
/** ONE decision per (player, season, week, scoring fingerprint): the earliest eligible record. Repeated captures of one window are correlated snapshots, never independent decisions. */
export function matchup2EvidenceGate(records: Matchup2CaptureRecord[], outcomes: Array<Pick<Matchup2Outcome, "capture_id">>): Matchup2Gate {
  const outs = new Set(outcomes.map((o) => o.capture_id)); const excluded: Record<string, number> = {}; const bump = (k: string) => { excluded[k] = (excluded[k] ?? 0) + 1; }; const seen = new Set<string>(); const weeks = new Set<string>(), players = new Set<string>(), pos = new Set<string>(); let n = 0;
  for (const r of [...records].sort((a, b) => (a.captured_at < b.captured_at ? -1 : a.captured_at > b.captured_at ? 1 : a.capture_id < b.capture_id ? -1 : 1))) {
    const el = evaluationEligibility(r, outs.has(r.capture_id)); if (!el.eligible) { bump(r.capture_class !== "LIVE_CAPTURED" ? r.capture_class : el.reasons[0]!.startsWith("no outcome") ? "NO_OUTCOME_YET" : "FAILS_ELIGIBILITY"); continue; }
    const k = `${r.player.gsis_id}|${r.season}|${r.week}|${r.scoring_fingerprint}`; if (seen.has(k)) { bump("CORRELATED_SAME_DECISION_WINDOW"); continue; } seen.add(k); n += 1; weeks.add(`${r.season}-${r.week}`); players.add(r.player.gsis_id); pos.add(r.player.position);
  }
  const T = MATCHUP2_EVIDENCE_THRESHOLDS; const need = (t: typeof T.minimum | typeof T.preferred) => [["distinct live weeks", weeks.size, t.distinct_live_weeks], ["eligible decisions with outcomes", n, t.eligible_decisions], ["distinct players", players.size, t.distinct_players], ["positions covered", pos.size, t.positions_covered]].filter(([, h, w]) => (h as number) < (w as number)).map(([l, h, w]) => `${l}: ${h}/${w}`);
  const minUnmet = need(T.minimum); const prefUnmet = need(T.preferred);
  return { status: minUnmet.length ? "NOT_ELIGIBLE" : prefUnmet.length ? "MINIMUM_MET_FOR_REVIEW" : "PREFERRED_MET_FOR_REVIEW", auto_promotion: false, eligible_decisions: n, distinct_weeks: weeks.size, distinct_players: players.size, positions_covered: pos.size, excluded, thresholds: T, unmet: minUnmet.length ? minUnmet : prefUnmet, note: "Meeting a threshold makes the sample eligible for HUMAN REVIEW only; it never changes the lifecycle state, and no Matchup 2.0 output influences production." };
}
export type WriteStatus = "INSERTED" | "DUPLICATE_IDENTICAL" | "REFUSED" | "ERROR";
export interface WriteResult { status: WriteStatus; reason?: string; store_kind: string; durable: boolean }
export interface Matchup2CaptureStore { readonly kind: string; readonly durable: boolean; record(r: Matchup2CaptureRecord): Promise<WriteResult> | WriteResult; attachOutcome(o: Matchup2Outcome): Promise<WriteResult> | WriteResult }
export class MemoryMatchup2CaptureStore implements Matchup2CaptureStore {
  readonly kind = "memory"; readonly durable = false; private rows = new Map<string, Matchup2CaptureRecord>(); private outs = new Map<string, Matchup2Outcome>();
  record(r: Matchup2CaptureRecord): WriteResult { const base = { store_kind: this.kind, durable: false }; const errs = validateCaptureRecord(r); if (errs.length) return { ...base, status: "REFUSED", reason: errs.join("; ") }; if (this.rows.has(r.capture_id)) return { ...base, status: "DUPLICATE_IDENTICAL" }; this.rows.set(r.capture_id, JSON.parse(JSON.stringify(r))); return { ...base, status: "INSERTED" }; }
  attachOutcome(o: Matchup2Outcome): WriteResult { const base = { store_kind: this.kind, durable: false }; if (!this.rows.has(o.capture_id)) return { ...base, status: "REFUSED", reason: "orphan outcome" }; const k = `${o.capture_id}|${o.source}`; if (this.outs.has(k)) return { ...base, status: "DUPLICATE_IDENTICAL" }; this.outs.set(k, o); return { ...base, status: "INSERTED" }; }
  list(): Matchup2CaptureRecord[] { return [...this.rows.values()]; } outcomes(): Matchup2Outcome[] { return [...this.outs.values()]; }
}
