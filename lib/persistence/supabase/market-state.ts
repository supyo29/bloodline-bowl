/** Phase 4.5 — durable store + runtime for immutable market-state snapshots. TELEMETRY ONLY: nothing on a ranking path reads it. */
import { compactMarketSnapshot, validateCompactSnapshot, type CompactMarketSnapshot, type MarketSnapshotStore, type MarketWriteResult } from "@/lib/market-state/history";
import type { MarketSnapshot } from "@/lib/market-state/contract";
import { installMarketSnapshotHook } from "@/lib/market-state/snapshot-hook";
import { loadSupabaseConfig, SupabaseRest } from "./rest";

const TABLE = "bridge_market_state_snapshots";
export function snapshotRow(c: CompactMarketSnapshot): Record<string, unknown> {
  return { artifact_id: c.artifact_id, market_content_id: c.market_content_id, acquisition_context_id: c.acquisition_context_id, league_slug: c.league_slug, season: c.season, week: c.week, history_class: c.history_class, readiness_status: c.readiness.status, scoring_fingerprint: c.identities.scoring_fingerprint, market_state_version: c.market_state_version, format: c.format, snapshot: c, observed_at: c.observed_at };
}
export class SupabaseMarketSnapshotStore implements MarketSnapshotStore {
  readonly kind = "supabase"; readonly durable = true;
  constructor(private readonly rest: SupabaseRest) {}
  async record(c: CompactMarketSnapshot): Promise<MarketWriteResult> {
    const base = { store_kind: this.kind, durable: true }; const errs = validateCompactSnapshot(c);
    if (errs.length) return { ...base, status: "REFUSED", reason: errs.join("; ") };
    try { const ins = await this.rest.insertIgnoreDuplicates<{ artifact_id: string }>(TABLE, [snapshotRow(c)], ["artifact_id"]); return { ...base, status: ins.length > 0 ? "INSERTED" : "DUPLICATE_IDENTICAL" }; }
    catch (e) { return { ...base, status: "ERROR", reason: e instanceof Error ? e.message : String(e) }; }
  }
}

export interface MarketSnapshotHealth { attempts: number; inserted: number; duplicates: number; refused: number; failures: number; not_configured: number; skipped_blocked: number; throttled: number; last_status: string | null; last_error: string | null }
const health: MarketSnapshotHealth = { attempts: 0, inserted: 0, duplicates: 0, refused: 0, failures: 0, not_configured: 0, skipped_blocked: 0, throttled: 0, last_status: null, last_error: null };
export const getMarketSnapshotHealth = (): MarketSnapshotHealth => ({ ...health });
export const MARKET_SNAPSHOT_TIMEOUT_MS = 2500;
/** Per-instance bound: at most one write attempt per (league, week) per interval, and an artifact already written by this instance is never re-sent. */
export const MARKET_SNAPSHOT_MIN_INTERVAL_MS = 2 * 60 * 1000;
const seen = new Set<string>(); const lastWrite = new Map<string, number>();
let store: MarketSnapshotStore | null | undefined;
export function __setMarketSnapshotStore(s: MarketSnapshotStore | null | undefined): void { store = s; }
export function __resetMarketSnapshotRuntime(): void { seen.clear(); lastWrite.clear(); Object.assign(health, { attempts: 0, inserted: 0, duplicates: 0, refused: 0, failures: 0, not_configured: 0, skipped_blocked: 0, throttled: 0, last_status: null, last_error: null }); }
function resolveStore(): MarketSnapshotStore | null {
  if (store !== undefined) return store;
  const cfg = loadSupabaseConfig(); if (!cfg.configured || !cfg.config) return null;
  return (store = new SupabaseMarketSnapshotStore(new SupabaseRest(cfg.config)));
}

export interface MarketPersistOutcome { status: "SKIPPED_BLOCKED" | "THROTTLED" | "NOT_CONFIGURED" | "INSERTED" | "DUPLICATE_IDENTICAL" | "REFUSED" | "ERROR" | "TIMEOUT"; artifact_id: string | null; error?: string }
export async function persistMarketSnapshot(s: MarketSnapshot, deps: { minIntervalMs?: number; timeoutMs?: number; now?: () => number } = {}): Promise<MarketPersistOutcome> {
  try {
    if (!s.readiness.pool_actionable) { health.skipped_blocked += 1; return { status: "SKIPPED_BLOCKED", artifact_id: null }; }
    const st = resolveStore(); if (!st) { health.not_configured += 1; health.last_status = "NOT_CONFIGURED"; return { status: "NOT_CONFIGURED", artifact_id: null }; }
    const c = compactMarketSnapshot(s); const nowMs = (deps.now ?? Date.now)(); const tk = `${c.league_slug}|${c.season}|${c.week}`;
    if (seen.has(c.artifact_id)) { health.duplicates += 1; return { status: "DUPLICATE_IDENTICAL", artifact_id: c.artifact_id }; }
    if (nowMs - (lastWrite.get(tk) ?? -Infinity) < (deps.minIntervalMs ?? MARKET_SNAPSHOT_MIN_INTERVAL_MS)) { health.throttled += 1; return { status: "THROTTLED", artifact_id: c.artifact_id }; }
    lastWrite.set(tk, nowMs); health.attempts += 1;
    const res = await Promise.race([Promise.resolve(st.record(c)), new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), deps.timeoutMs ?? MARKET_SNAPSHOT_TIMEOUT_MS))]);
    if (res === "TIMEOUT") { health.failures += 1; health.last_status = "TIMEOUT"; health.last_error = "market snapshot write timed out"; return { status: "TIMEOUT", artifact_id: c.artifact_id, error: health.last_error }; }
    health.last_status = res.status;
    if (res.status === "INSERTED") { health.inserted += 1; seen.add(c.artifact_id); } else if (res.status === "DUPLICATE_IDENTICAL") { health.duplicates += 1; seen.add(c.artifact_id); }
    else if (res.status === "REFUSED") { health.refused += 1; health.last_error = res.reason ?? null; } else { health.failures += 1; health.last_error = res.reason ?? null; }
    return { status: res.status, artifact_id: c.artifact_id, ...(res.reason ? { error: res.reason } : {}) };
  } catch (e) { health.failures += 1; health.last_status = "ERROR"; health.last_error = e instanceof Error ? e.message : String(e); return { status: "ERROR", artifact_id: null, error: health.last_error }; }
}
export function installMarketSnapshotCapture(): void { installMarketSnapshotHook((s) => persistMarketSnapshot(s)); }
