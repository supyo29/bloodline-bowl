/**
 * Phase 5 — durable store + runtime for Matchup Intelligence 2.0 prospective shadow captures. TELEMETRY ONLY: never on a ranking path, never
 * fails a caller. The ONLY writer is the scheduled job below (server-derived production baseline); no public route can create a record.
 */
import { buildCaptureRecord, captureKindFor, classifyGameLock, validateCaptureRecord, type Baseline, type Matchup2CaptureRecord, type Matchup2CaptureStore, type Matchup2Outcome, type ScheduleGame, type WriteResult } from "@/lib/matchup2/capture";
import { SLEEPER_ROOT_URL, fetchSleeper } from "@/lib/sleeper/client";
import { loadSupabaseConfig, SupabaseRest } from "./rest";

const CAPTURES = "bridge_matchup2_shadow_captures"; const OUTCOMES = "bridge_matchup2_shadow_outcomes";
export function captureRow(r: Matchup2CaptureRecord): Record<string, unknown> {
  return { capture_id: r.capture_id, capture_class: r.capture_class, season: r.season, week: r.week, player_gsis_id: r.player.gsis_id, position: r.player.position, offense_team: r.player.team, defense_team: r.opponent, model_version: r.model_version, lifecycle_state: r.lifecycle_state, context_identity: r.context_identity, scoring_fingerprint: r.scoring_fingerprint, has_baseline: r.baseline != null, lock_verdict: r.lock?.verdict ?? null, content_hash: r.content_hash, record_schema_version: r.schema_version, record: r, captured_at: r.captured_at };
}
export class SupabaseMatchup2CaptureStore implements Matchup2CaptureStore {
  readonly kind = "supabase"; readonly durable = true; constructor(private readonly rest: SupabaseRest) {}
  async record(r: Matchup2CaptureRecord): Promise<WriteResult> { const base = { store_kind: this.kind, durable: true }; const errs = validateCaptureRecord(r); if (errs.length) return { ...base, status: "REFUSED", reason: errs.join("; ") };
    try { const ins = await this.rest.insertIgnoreDuplicates<{ capture_id: string }>(CAPTURES, [captureRow(r)], ["capture_id"]); return { ...base, status: ins.length > 0 ? "INSERTED" : "DUPLICATE_IDENTICAL" }; } catch (e) { return { ...base, status: "ERROR", reason: e instanceof Error ? e.message : String(e) }; } }
  async attachOutcome(o: Matchup2Outcome): Promise<WriteResult> { const base = { store_kind: this.kind, durable: true };
    try { const ins = await this.rest.insertIgnoreDuplicates<{ capture_id: string }>(OUTCOMES, [{ capture_id: o.capture_id, source: o.source, outcome: o }], ["capture_id", "source"]); return { ...base, status: ins.length > 0 ? "INSERTED" : "DUPLICATE_IDENTICAL" }; } catch (e) { return { ...base, status: "ERROR", reason: e instanceof Error ? e.message : String(e) }; } }
}
export interface Matchup2CaptureHealth { attempts: number; inserted: number; duplicates: number; refused: number; failures: number; not_configured: number; by_class: Record<string, number>; last_status: string | null; last_error: string | null }
const health: Matchup2CaptureHealth = { attempts: 0, inserted: 0, duplicates: 0, refused: 0, failures: 0, not_configured: 0, by_class: {}, last_status: null, last_error: null };
export const getMatchup2CaptureHealth = (): Matchup2CaptureHealth => ({ ...health, by_class: { ...health.by_class } });
export function __resetMatchup2CaptureHealth(): void { Object.assign(health, { attempts: 0, inserted: 0, duplicates: 0, refused: 0, failures: 0, not_configured: 0, by_class: {}, last_status: null, last_error: null }); seen.clear(); }
let store: Matchup2CaptureStore | null | undefined; const seen = new Set<string>();
export function __setMatchup2CaptureStore(s: Matchup2CaptureStore | null | undefined): void { store = s; }
function resolveStore(): Matchup2CaptureStore | null { if (store !== undefined) return store; const cfg = loadSupabaseConfig(); if (!cfg.configured || !cfg.config) return null; return (store = new SupabaseMatchup2CaptureStore(new SupabaseRest(cfg.config))); }
export const MATCHUP2_CAPTURE_TIMEOUT_MS = 2500;
export async function persistMatchup2Capture(r: Matchup2CaptureRecord): Promise<WriteResult["status"] | "NOT_CONFIGURED" | "TIMEOUT"> {
  try { const st = resolveStore(); if (!st) { health.not_configured += 1; health.last_status = "NOT_CONFIGURED"; return "NOT_CONFIGURED"; }
    if (seen.has(r.capture_id)) { health.duplicates += 1; return "DUPLICATE_IDENTICAL"; } health.attempts += 1; health.by_class[r.capture_class] = (health.by_class[r.capture_class] ?? 0) + 1;
    const res = await Promise.race([Promise.resolve(st.record(r)), new Promise<"TIMEOUT">((x) => setTimeout(() => x("TIMEOUT"), MATCHUP2_CAPTURE_TIMEOUT_MS))]);
    if (res === "TIMEOUT") { health.failures += 1; health.last_status = "TIMEOUT"; return "TIMEOUT"; } health.last_status = res.status;
    if (res.status === "INSERTED") { health.inserted += 1; seen.add(r.capture_id); } else if (res.status === "DUPLICATE_IDENTICAL") { health.duplicates += 1; seen.add(r.capture_id); } else if (res.status === "REFUSED") { health.refused += 1; health.last_error = res.reason ?? null; } else { health.failures += 1; health.last_error = res.reason ?? null; }
    return res.status; } catch (e) { health.failures += 1; health.last_status = "ERROR"; health.last_error = e instanceof Error ? e.message : String(e); return "ERROR"; }
}

/* ------------------------------------------------------------------------------------------------ scheduled prospective capture */
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { buildWeeklyTeamContext } from "@/lib/weekly/context";
import { fileMatchupSource } from "@/lib/matchup2/source-files";
import { buildMatchupContext } from "@/lib/matchup2/context";
import { evaluatePlayer } from "@/lib/matchup2/engine";
import { normalizeTeam } from "@/lib/matchup2/stats";
import { listLeagueTargets, leagueConfigStatus } from "@/lib/leagues/registry";

export interface Matchup2ScheduledDeps { fetchSchedule?: (season: number) => Promise<{ games: ScheduleGame[] | null; fetched_at: string | null }>; now?: () => Date }
async function defaultSchedule(season: number): Promise<{ games: ScheduleGame[] | null; fetched_at: string | null }> {
  try { const g = await fetchSleeper<ScheduleGame[]>(`/schedule/nfl/regular/${season}`, { baseUrl: SLEEPER_ROOT_URL, noStore: true, timeoutMs: 2500 }); return Array.isArray(g) ? { games: g, fetched_at: new Date().toISOString() } : { games: null, fetched_at: null }; } catch { return { games: null, fetched_at: null }; }
}
export interface Matchup2ScheduledSummary { failures: number; leagues: Array<Record<string, unknown>>; by_class: Record<string, number>; by_status: Record<string, number> }
/** For every ready Sleeper league: one weekly build (server-derived production projections in the league's scoring), then one shadow evaluation per rostered QB/RB/WR/TE. Deduplicated per (player, week, scoring fingerprint) within the run and by identity in the store. */
export async function runScheduledMatchup2Capture(deps: Matchup2ScheduledDeps = {}): Promise<Matchup2ScheduledSummary> {
  const src = fileMatchupSource(); const out: Matchup2ScheduledSummary = { failures: 0, leagues: [], by_class: {}, by_status: {} }; const doneKeys = new Set<string>(); let sched: Awaited<ReturnType<typeof defaultSchedule>> | null = null;
  for (const t of listLeagueTargets().filter((x) => x.provider === "sleeper" && leagueConfigStatus(x) === "READY")) {
    try {
      const st = await buildCanonicalLeagueState(t.key, { reportPersistence: false }); const mgr = st.snapshot?.managers[0]; if (!st.snapshot || !mgr) { out.failures += 1; out.leagues.push({ league_slug: t.key, ok: false, code: st.code ?? "league_state_unavailable" }); continue; }
      const res = await buildWeeklyTeamContext(t.key, mgr.manager_slug, { snapshotOverride: st.snapshot }); if (!res.context) { out.failures += 1; out.leagues.push({ league_slug: t.key, ok: false, code: res.code ?? "weekly_context_unavailable" }); continue; }
      const w = res.context; const season = w.league.season; const week = w.league.week; const fp = st.snapshot.league.scoring_fingerprint ?? null; const decisionAt = (deps.now ?? (() => new Date()))().toISOString();
      sched = await (deps.fetchSchedule ?? defaultSchedule)(season); let n = 0, skipped = 0;
      const byId = new Map(st.snapshot.players.map((x) => [x.canonical_player_id, x] as const)); const rostered = [...new Set(st.snapshot.rosters.flatMap((r) => r.all_players))];
      for (const id of rostered) {
        const p = w.projections.resolved_players.get(id) ?? byId.get(id); const pos = (p?.position ?? "").toUpperCase(); const gsis = p?.identifiers.sleeper_id ?? null; const proj = w.projections.by_player.get(id); if (!p || !gsis || !["QB", "RB", "WR", "TE"].includes(pos) || !proj || proj.is_bye || !proj.opponent) { skipped += 1; continue; }
        const key = `${gsis}|${season}|${week}|${fp}`; if (doneKeys.has(key)) continue; doneKeys.add(key);
        const team = normalizeTeam(proj.nfl_team ?? p.nfl_team); const opp = normalizeTeam(proj.opponent); if (!team || !opp) { skipped += 1; continue; }
        const ctx = buildMatchupContext(src, { offense_team: team, defense_team: opp, week, home: proj.is_home, scoring_fingerprint: fp }); const ev = evaluatePlayer(src, ctx, gsis); if ("error" in ev) { skipped += 1; continue; }
        const baseline: Baseline = { source: proj.source, model_version: proj.model_version, projected_points: proj.projected_points, scoring_fingerprint: fp, injury_status: proj.injury_status, expected_availability: proj.expected_availability };
        const lock = classifyGameLock({ decision_timestamp: decisionAt, week, team, games: sched.games, schedule_fetched_at: sched.fetched_at });
        const kind = captureKindFor({ illustrative: false, is_reconstruction: false, lock, has_baseline: proj.projected_points != null });
        const rec = buildCaptureRecord(ev, { kind, baseline, lock, captured_at: decisionAt, invocation: "CRON" }); const status = await persistMatchup2Capture(rec);
        out.by_status[status] = (out.by_status[status] ?? 0) + 1; out.by_class[rec.capture_class] = (out.by_class[rec.capture_class] ?? 0) + 1; n += 1; if (status === "ERROR" || status === "TIMEOUT" || status === "REFUSED") out.failures += 1;
      }
      out.leagues.push({ league_slug: t.key, ok: true, week, scoring_fingerprint: fp, evaluated: n, skipped });
    } catch (e) { out.failures += 1; out.leagues.push({ league_slug: t.key, ok: false, code: e instanceof Error ? e.message.slice(0, 120) : "error" }); }
  }
  console.log(`[cron:matchup2-capture] leagues=${out.leagues.length} failures=${out.failures} classes=${JSON.stringify(out.by_class)} statuses=${JSON.stringify(out.by_status)}`);
  return out;
}
