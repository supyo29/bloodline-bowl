/**
 * Runtime hook for Waiver 2.0 prospective capture (Phase 4). TELEMETRY ONLY.
 *
 *  - It runs AFTER an evaluation is complete and never feeds back into it: a store failure, timeout or misconfiguration is
 *    recorded in `getWaiver2CaptureHealth()` and logged-by-counter, and the caller's response is unchanged.
 *  - ILLUSTRATIVE requests are never persisted (there is no illustrative row; they cannot become evidence).
 *  - When the pool is not certified only a NOT_ACTIONABLE / POOL_READINESS_BLOCKED readiness record is written — no ranked
 *    actions, no candidate list — and such rows never count toward evaluation.
 *  - When the pool IS certified the class comes from a live lock verification (every involved NFL game verifiably pre-game);
 *    anything unverifiable is LIVE_UNVERIFIED, never pristine. No code change is needed when the pool becomes certified.
 */
import { SLEEPER_ROOT_URL, fetchSleeper } from "@/lib/sleeper/client";
import { classifyWaiverLock, buildCaptureRecord, captureKindFor, type ScheduleGame, type WaiverCaptureStore, type WaiverLockEvidence } from "@/lib/waiver2/capture";
import type { WaiverEvaluation, WaiverInput } from "@/lib/waiver2/types";
import { loadSupabaseConfig, SupabaseRest } from "./rest";
import { SupabaseWaiverCaptureStore } from "./waiver2-capture";

export const WAIVER2_CAPTURE_TIMEOUT_MS = 2500;
import { captureHealth as health } from "@/lib/waiver2/capture-health";
export { getWaiver2CaptureHealth, __resetWaiver2CaptureHealth } from "@/lib/waiver2/capture-health";

let store: WaiverCaptureStore | null | undefined;
export function __setWaiver2CaptureStore(s: WaiverCaptureStore | null | undefined): void { store = s; }
function resolveStore(): WaiverCaptureStore | null {
  if (store !== undefined) return store;
  const cfg = loadSupabaseConfig(); if (!cfg.configured || !cfg.config) return null;
  return (store = new SupabaseWaiverCaptureStore(new SupabaseRest(cfg.config)));
}
const seen = new Set<string>();
/** Per-instance write throttle: at most one attempt per (league, manager, week, class) per interval — bounds write amplification from repeated requests. */
export const WAIVER2_CAPTURE_MIN_INTERVAL_MS = 10 * 60 * 1000; const lastWrite = new Map<string, number>();

async function fetchSchedule(season: number): Promise<{ games: ScheduleGame[] | null; fetched_at: string | null }> {
  try { const g = await fetchSleeper<ScheduleGame[]>(`/schedule/nfl/regular/${season}`, { baseUrl: SLEEPER_ROOT_URL, noStore: true, timeoutMs: 2000 }); return Array.isArray(g) ? { games: g, fetched_at: new Date().toISOString() } : { games: null, fetched_at: null }; } catch { return { games: null, fetched_at: null }; }
}
export interface PersistDeps { fetchSchedule?: typeof fetchSchedule; timeoutMs?: number; minIntervalMs?: number }
export interface PersistOutcome { status: "SKIPPED_ILLUSTRATIVE" | "THROTTLED" | "NOT_CONFIGURED" | "INSERTED" | "DUPLICATE_IDENTICAL" | "REFUSED" | "ERROR" | "TIMEOUT"; capture_id: string | null; capture_class: string | null; error?: string }

export async function persistWaiver2Evidence(ev: WaiverEvaluation, input: WaiverInput, meta: { league_slug: string; manager_slug: string; season: number; illustrative: boolean }, deps: PersistDeps = {}): Promise<PersistOutcome> {
  try {
    if (meta.illustrative) { health.skipped_illustrative += 1; return { status: "SKIPPED_ILLUSTRATIVE", capture_id: null, capture_class: null }; }
    const st = resolveStore(); if (!st) { health.not_configured += 1; health.last_status = "NOT_CONFIGURED"; return { status: "NOT_CONFIGURED", capture_id: null, capture_class: null }; }
    let lock: WaiverLockEvidence | null = null;
    if (ev.availability.status === "AVAILABLE" && ev.availability.certification === "CERTIFIED") {
      const teams = [...input.weekly.all_rostered.map((p) => p.nfl_team), ...ev.actions.map((a) => input.weekly.availability.players.find((x) => x.canonical_player_id === a.candidate?.player_id)?.player.nfl_team)].filter((t): t is string => !!t);
      const sch = await (deps.fetchSchedule ?? fetchSchedule)(meta.season); lock = classifyWaiverLock({ decision_timestamp: new Date().toISOString(), week: ev.week, involved_teams: teams, games: sch.games, schedule_fetched_at: sch.fetched_at });
    }
    const kind = captureKindFor(ev, { illustrative: false, is_reconstruction: false, lock });
    const rec = buildCaptureRecord(ev, input, { kind, league_slug: meta.league_slug, manager_slug: meta.manager_slug, season: meta.season, lock });
    const tk = `${rec.league_slug}|${rec.manager_slug}|${rec.season}|${rec.week}|${rec.capture_class}`; const nowMs = Date.now();
    if (!seen.has(rec.capture_id) && nowMs - (lastWrite.get(tk) ?? 0) < (deps.minIntervalMs ?? WAIVER2_CAPTURE_MIN_INTERVAL_MS)) { health.throttled += 1; return { status: "THROTTLED", capture_id: rec.capture_id, capture_class: rec.capture_class }; }
    if (seen.has(rec.capture_id)) { health.duplicates += 1; return { status: "DUPLICATE_IDENTICAL", capture_id: rec.capture_id, capture_class: rec.capture_class }; }
    lastWrite.set(tk, nowMs); health.attempts += 1; health.last_class = rec.capture_class; health.by_class[rec.capture_class] = (health.by_class[rec.capture_class] ?? 0) + 1;
    const res = await Promise.race([Promise.resolve(st.record(rec)), new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), deps.timeoutMs ?? WAIVER2_CAPTURE_TIMEOUT_MS))]);
    if (res === "TIMEOUT") { health.failures += 1; health.last_status = "TIMEOUT"; health.last_error = "capture timed out"; return { status: "TIMEOUT", capture_id: rec.capture_id, capture_class: rec.capture_class, error: "capture timed out" }; }
    health.last_status = res.status;
    if (res.status === "INSERTED") { health.inserted += 1; seen.add(rec.capture_id); } else if (res.status === "DUPLICATE_IDENTICAL") { health.duplicates += 1; seen.add(rec.capture_id); }
    else if (res.status === "REFUSED") { health.refused += 1; health.last_error = res.reason ?? null; } else { health.failures += 1; health.last_error = res.reason ?? null; }
    return { status: res.status, capture_id: rec.capture_id, capture_class: rec.capture_class, ...(res.reason ? { error: res.reason } : {}) };
  } catch (e) { health.failures += 1; health.last_status = "ERROR"; health.last_error = e instanceof Error ? e.message : String(e); return { status: "ERROR", capture_id: null, capture_class: null, error: health.last_error }; }
}
export function __clearWaiver2SeenCache(): void { seen.clear(); lastWrite.clear(); }

/** Installs the durable capture as the process hook. Called once by the server route at startup. */
import { installWaiver2CaptureHook } from "@/lib/waiver2/capture-hook";
export function installWaiver2Capture(): void { installWaiver2CaptureHook((ev, input, meta) => persistWaiver2Evidence(ev, input, meta)); }


/* ---------------------------------------------------------------------------------------------- scheduled prospective capture (Phase 4.5) */
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { buildWaiverInputForManager } from "@/lib/waiver2/adapter";
import { evaluateWaiver2 } from "@/lib/waiver2/actions";
import { persistMarketSnapshot } from "./market-state";
import { listLeagueTargets, leagueConfigStatus } from "@/lib/leagues/registry";

export interface ScheduledCaptureSummary { failures: number; leagues: Array<Record<string, unknown>> }
/** Evaluates Waiver 2.0 for every manager of every READY Sleeper league and records the market snapshot + shadow capture. Shadow only; never submits; per-manager failures are isolated. */
export async function runScheduledWaiver2Capture(): Promise<ScheduledCaptureSummary> {
  let failures = 0; const leagues: Array<Record<string, unknown>> = [];
  for (const t of listLeagueTargets().filter((x) => x.provider === "sleeper" && leagueConfigStatus(x) === "READY")) {
    const state = await buildCanonicalLeagueState(t.key, { reportPersistence: false });
    if (!state.snapshot) { failures += 1; leagues.push({ league_slug: t.key, ok: false, code: state.code ?? "league_state_unavailable" }); continue; }
    const season = Number(state.snapshot.league.season) || 2026; const byClass: Record<string, number> = {}; const byStatus: Record<string, number> = {}; let managerFailures = 0; let market: unknown = null;
    for (const m of state.snapshot.managers) {
      try {
        const r = await buildWaiverInputForManager(t.key, m.manager_slug);
        if (!r.ok) { managerFailures += 1; continue; }
        const ev = evaluateWaiver2(r.input);
        if (!market && r.input.pool.market_snapshot) market = (await persistMarketSnapshot(r.input.pool.market_snapshot, { minIntervalMs: 0 })).status;
        const out = await persistWaiver2Evidence(ev, r.input, { league_slug: t.key, manager_slug: m.manager_slug, season, illustrative: false }, { minIntervalMs: 0 });
        byStatus[out.status] = (byStatus[out.status] ?? 0) + 1; if (out.capture_class) byClass[out.capture_class] = (byClass[out.capture_class] ?? 0) + 1;
        if (out.status === "ERROR" || out.status === "TIMEOUT" || out.status === "REFUSED") managerFailures += 1;
      } catch { managerFailures += 1; }
    }
    if (managerFailures) failures += 1;
    console.log(`[cron:waiver2-capture] ${t.key}: managers=${state.snapshot.managers.length} failures=${managerFailures} classes=${JSON.stringify(byClass)} statuses=${JSON.stringify(byStatus)} market=${market}`);
    leagues.push({ league_slug: t.key, ok: managerFailures === 0, managers: state.snapshot.managers.length, failures: managerFailures, by_class: byClass, by_status: byStatus, market_snapshot: market });
  }
  return { failures, leagues };
}
