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

async function fetchSchedule(season: number): Promise<{ games: ScheduleGame[] | null; fetched_at: string | null }> {
  try { const g = await fetchSleeper<ScheduleGame[]>(`/schedule/nfl/regular/${season}`, { baseUrl: SLEEPER_ROOT_URL, noStore: true, timeoutMs: 2000 }); return Array.isArray(g) ? { games: g, fetched_at: new Date().toISOString() } : { games: null, fetched_at: null }; } catch { return { games: null, fetched_at: null }; }
}
export interface PersistDeps { fetchSchedule?: typeof fetchSchedule; timeoutMs?: number }
export interface PersistOutcome { status: "SKIPPED_ILLUSTRATIVE" | "NOT_CONFIGURED" | "INSERTED" | "DUPLICATE_IDENTICAL" | "REFUSED" | "ERROR" | "TIMEOUT"; capture_id: string | null; capture_class: string | null; error?: string }

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
    if (seen.has(rec.capture_id)) { health.duplicates += 1; return { status: "DUPLICATE_IDENTICAL", capture_id: rec.capture_id, capture_class: rec.capture_class }; }
    health.attempts += 1; health.last_class = rec.capture_class; health.by_class[rec.capture_class] = (health.by_class[rec.capture_class] ?? 0) + 1;
    const res = await Promise.race([Promise.resolve(st.record(rec)), new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), deps.timeoutMs ?? WAIVER2_CAPTURE_TIMEOUT_MS))]);
    if (res === "TIMEOUT") { health.failures += 1; health.last_status = "TIMEOUT"; health.last_error = "capture timed out"; return { status: "TIMEOUT", capture_id: rec.capture_id, capture_class: rec.capture_class, error: "capture timed out" }; }
    health.last_status = res.status;
    if (res.status === "INSERTED") { health.inserted += 1; seen.add(rec.capture_id); } else if (res.status === "DUPLICATE_IDENTICAL") { health.duplicates += 1; seen.add(rec.capture_id); }
    else if (res.status === "REFUSED") { health.refused += 1; health.last_error = res.reason ?? null; } else { health.failures += 1; health.last_error = res.reason ?? null; }
    return { status: res.status, capture_id: rec.capture_id, capture_class: rec.capture_class, ...(res.reason ? { error: res.reason } : {}) };
  } catch (e) { health.failures += 1; health.last_status = "ERROR"; health.last_error = e instanceof Error ? e.message : String(e); return { status: "ERROR", capture_id: null, capture_class: null, error: health.last_error }; }
}
export function __clearWaiver2SeenCache(): void { seen.clear(); }

/** Installs the durable capture as the process hook. Called once by the server route at startup. */
import { installWaiver2CaptureHook } from "@/lib/waiver2/capture-hook";
export function installWaiver2Capture(): void { installWaiver2CaptureHook((ev, input, meta) => persistWaiver2Evidence(ev, input, meta)); }
