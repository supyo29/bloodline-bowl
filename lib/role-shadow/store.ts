/**
 * W2.P2 — capture-store contract + the in-memory implementation (tests, dry runs).
 *
 * Semantics (identical in the Supabase store + migration):
 *   INSERT-ONLY  a stored record is never updated or deleted; there is no `update`/`delete` on the interface.
 *   IDEMPOTENT   the id is content-addressed, so re-recording the same decision is DUPLICATE_IDENTICAL (a no-op), safe under retries/concurrency.
 *   NEVER LATE   a LIVE_CAPTURED record is refused when the store's clock is at/after its kickoff — evidence that ARRIVES late is rejected even if
 *                it was composed earlier (REFUSED_LATE). The Postgres trigger enforces the same on the database clock.
 *   VERSION-SAFE the model version/config hash is part of the identity: a new model version can never overwrite an older version's observations.
 */

import { validateRecord, type RoleShadowRecord } from "./record";

export type WriteStatus = "INSERTED" | "DUPLICATE_IDENTICAL" | "REFUSED_INVALID" | "REFUSED_LATE" | "ERROR";
export interface WriteResult { status: WriteStatus; reason?: string; store_kind: string; durable: boolean }

export interface CaptureFilter {
  season?: number; week?: number; league_slug?: string; capture_class?: string; challenger_config_hash?: string;
}

export interface RoleShadowStore {
  readonly kind: string;
  readonly durable: boolean;
  record(r: RoleShadowRecord): Promise<WriteResult>;
  list(filter?: CaptureFilter): Promise<RoleShadowRecord[]>;
}

/** Why a LIVE_CAPTURED record is too late to store, given the store's clock. Null = not late. */
export function lateReason(r: RoleShadowRecord, nowMs: number): string | null {
  if (r.capture_class !== "LIVE_CAPTURED") return null;
  const ko = Date.parse(r.game.kickoff_at ?? "");
  if (!Number.isFinite(ko)) return "no resolvable kickoff";
  return nowMs >= ko ? `store clock ${new Date(nowMs).toISOString()} is at/after kickoff ${r.game.kickoff_at}` : null;
}

export class MemoryRoleShadowStore implements RoleShadowStore {
  readonly kind = "memory";
  readonly durable = false;
  private rows = new Map<string, RoleShadowRecord>();
  constructor(private readonly now: () => number = Date.now) {}

  async record(r: RoleShadowRecord): Promise<WriteResult> {
    const base = { store_kind: this.kind, durable: false };
    const errs = validateRecord(r);
    if (errs.length) return { ...base, status: "REFUSED_INVALID", reason: errs.join("; ") };
    const late = lateReason(r, this.now());
    if (late) return { ...base, status: "REFUSED_LATE", reason: late };
    if (this.rows.has(r.capture_id)) return { ...base, status: "DUPLICATE_IDENTICAL" };
    this.rows.set(r.capture_id, JSON.parse(JSON.stringify(r)) as RoleShadowRecord);
    return { ...base, status: "INSERTED" };
  }

  async list(f: CaptureFilter = {}): Promise<RoleShadowRecord[]> {
    return [...this.rows.values()]
      .filter((r) => (f.season == null || r.season === f.season) && (f.week == null || r.week === f.week) && (f.league_slug == null || r.league_slug === f.league_slug)
        && (f.capture_class == null || r.capture_class === f.capture_class) && (f.challenger_config_hash == null || r.models.challenger.config_hash === f.challenger_config_hash))
      .map((r) => JSON.parse(JSON.stringify(r)) as RoleShadowRecord);
  }
}
