/** Phase 3.5C — shared helpers for evidence builders. No modelling here; only assembly. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_CONTRACT_VERSION, type AnalysisClass, type AvailabilityState, type EvidenceBlock, type HistoryPoint, type TemporalIdentity, type UnitSpec } from "./schema";
import { listSnapshots, readSnapshotFile, type SnapshotEntry } from "./snapshots";

export const PHASE7 = "NOT_MODELED_UNTIL_INTELLIGENCE_MODERNIZATION_PHASE_7" as const;

export interface QueryContext {
  root: string;
  /** injectable clock for deterministic tests */
  now: () => string;
  /** whether to include full history series / comparison populations (explicit, on demand) */
  history: boolean;
  comparisons: boolean;
}
export const defaultContext = (over: Partial<QueryContext> = {}): QueryContext => ({ root: process.cwd(), now: () => new Date().toISOString(), history: false, comparisons: false, ...over });

export function mk(b: Omit<EvidenceBlock, "evidence_id" | "contract_version">, key: unknown[] = []): EvidenceBlock {
  const id = createHash("sha256").update(JSON.stringify([b.surface, b.topic, b.metric, b.subject.id, b.temporal.snapshot_id ?? null, b.temporal.through_week, b.temporal.week, b.temporal.as_of, b.subject.kind, ...key])).digest("hex").slice(0, 20);
  const lag = b.freshness.refresh_lag_weeks;
  // A lagging substrate is never presented as current: the vintage mismatch is stated on the block itself.
  const limitations = lag && lag > 0 ? [...b.limitations, `NOT_YET_REFRESHED: served through_week ${String(b.freshness.through_week)} is ${lag} complete week(s) behind the Football Intelligence completed-week frontier; this evidence has a different vintage than newer sources and must not be combined with them as if synchronized`] : b.limitations;
  return { evidence_id: `eb:${id}`, contract_version: EVIDENCE_CONTRACT_VERSION, ...b, limitations };
}

/** A block for something that cannot be provided. Value absent; the availability STATE says why (never collapsed). */
export function notAvailable(base: Omit<EvidenceBlock, "evidence_id" | "contract_version" | "availability" | "value" | "unit" | "history" | "comparison" | "change" | "components" | "origin"> & { origin?: EvidenceBlock["origin"] },
  state: Exclude<AvailabilityState, "AVAILABLE">, reason: string, cls: AnalysisClass = "UNAVAILABLE"): EvidenceBlock {
  const { origin, ...rest } = base;
  return mk({ ...rest, availability: { state, reason }, origin: origin ?? { source_class: state, analysis_class: cls }, limitations: [...rest.limitations, reason] });
}

export const num = (v: unknown): number | null => { if (v === null || v === undefined || v === "" || v === "NA") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Minimal RFC-4180-ish CSV parser (quoted fields, doubled quotes). */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []; let cur: string[] = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { cur.push(f); f = ""; }
    else if (c === "\n") { cur.push(f); rows.push(cur); cur = []; f = ""; } else if (c !== "\r") f += c;
  }
  if (f || cur.length) { cur.push(f); rows.push(cur); }
  const head = rows[0] ?? [];
  return rows.slice(1).filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const csvCache = new Map<string, Array<Record<string, string>>>();
export function readCurrentCsv(root: string, rel: string): Array<Record<string, string>> {
  const key = `cur:${root}:${rel}`; const hit = csvCache.get(key); if (hit) return hit;
  const p = join(root, rel); const rows = existsSync(p) ? parseCsv(readFileSync(p, "utf8")) : [];
  csvCache.set(key, rows); return rows;
}
export function readSnapshotCsv(root: string, e: SnapshotEntry, name: string): Array<Record<string, string>> {
  const key = `snap:${root}:${e.snapshot_id}:${name}`; const hit = csvCache.get(key); if (hit) return hit;
  const rows = parseCsv(readSnapshotFile(e, name, root).toString("utf8")); csvCache.set(key, rows); return rows;
}
export const __clearCsvCache = (): void => csvCache.clear();

/** Latest revision per through_week (revisions of the same complete week are all preserved in the store). */
export function weeklySnapshots(surface: string, root: string): { entries: SnapshotEntry[]; revisions: Record<number, number> } {
  const all = listSnapshots(surface, root); const byWeek = new Map<string, SnapshotEntry>(); const revisions: Record<number, number> = {};
  for (const e of all) { byWeek.set(`${e.season}|${e.through_week}`, e); revisions[e.through_week] = (revisions[e.through_week] ?? 0) + 1; } // sorted ascending -> last wins
  return { entries: [...byWeek.values()], revisions };
}

export function snapshotTemporal(e: SnapshotEntry): TemporalIdentity {
  return { season: e.season, week: null, through_week: e.through_week, as_of: e.generated_at, generated_at: e.generated_at, source_cutoff: e.source_cutoff, point_kind: "POINT_IN_TIME_STATE", as_of_kind: "PUBLISHED_STATE", week_state: e.week_state, snapshot_id: e.snapshot_id, player_team_temporal_identity: PHASE7 };
}
export function currentTemporal(m: { season: number | null; through_week: number | null; generated_at: string | null; source_cutoff?: Record<string, number> | null; week_state?: "PARTIAL" | "COMPLETE" | null }, snapshotted: boolean): TemporalIdentity {
  return { season: m.season, week: null, through_week: m.through_week, as_of: m.generated_at, generated_at: m.generated_at, source_cutoff: m.source_cutoff ?? null, point_kind: snapshotted ? "CURRENT" : "CURRENT_UNSNAPSHOTTED", as_of_kind: "CURRENT_SNAPSHOT", week_state: m.week_state ?? null, snapshot_id: null, player_team_temporal_identity: PHASE7 };
}
export const deviationUnit = (u: UnitSpec): UnitSpec => ({ ...u, valid_range: null, may_exceed_one: true, is_deviation: true, note: "deviation from the league mean, in the metric's own unit" });
export const historyPointsSorted = (pts: HistoryPoint[]): HistoryPoint[] => [...pts].sort((a, b) => (a.temporal.season ?? 0) - (b.temporal.season ?? 0) || (a.temporal.through_week ?? 0) - (b.temporal.through_week ?? 0) || String(a.temporal.as_of).localeCompare(String(b.temporal.as_of)));

/**
 * Completed-week frontier as published by Football Intelligence's own week_completion (the same manifest the Phase 1
 * freshness evaluator reads). PARTIAL week W means weeks <= W-1 are complete. Used to flag artifacts that are not
 * refreshed on FI's daily cadence (Role, Opportunity Propagation) — it never fetches the network.
 */
export function completedFrontier(root = process.cwd()): number | null {
  const p = join(root, "lib", "football-intel", "data", "football_intelligence_manifest.json");
  if (!existsSync(p)) return null;
  const m = JSON.parse(readFileSync(p, "utf8")) as { through_week?: number; week_completion?: { week_state?: string; latest_week?: number } };
  const wc = m.week_completion; if (!wc?.latest_week) return null;
  return wc.week_state === "COMPLETE" ? wc.latest_week : wc.latest_week - 1;
}
export function refreshLag(throughWeek: number | null, root = process.cwd()): number | null {
  const f = completedFrontier(root); if (f === null || throughWeek === null) return null;
  return Math.max(0, f - throughWeek);
}
