/**
 * Persistence factory + status.
 *
 * `getPersistence()` returns the production bundle: Supabase when
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set, otherwise a
 * NOT_CONFIGURED bundle whose every write reports
 * `PERSISTENCE_NOT_CONFIGURED` (it never pretends a write succeeded).
 *
 * Tests inject `memoryPersistence()` directly and never touch this file.
 *
 * The bridge's LIVE provider reads never depend on persistence — a Supabase
 * outage degrades history/ledger only. See `HISTORY_PERSISTENCE_STATUS` vs
 * `LIVE_PROVIDER_STATUS` in `lib/canonical/state.ts`.
 */

import type {
  CanonicalLeagueSnapshot,
  CanonicalTransaction,
} from "@/lib/canonical/schema";
import type {
  CaptureRunInput,
  CaptureRunStore,
  CaptureType,
  LedgerAppendResult,
  LedgerStore,
  PersistenceBundle,
  PersistenceStatus,
  PutSnapshotResult,
  SnapshotKey,
  SnapshotStore,
  StoredSnapshot,
  StoredSnapshotMeta,
  StoredTransaction,
  TransactionFilter,
} from "./types";
import { SupabaseRest, loadSupabaseConfig } from "./supabase/rest";
import {
  SupabaseCaptureRunStore,
  SupabaseLedgerStore,
  SupabaseSnapshotStore,
} from "./supabase/stores";

const NOT_CONFIGURED: PersistenceStatus = "PERSISTENCE_NOT_CONFIGURED";

class UnconfiguredSnapshotStore implements SnapshotStore {
  readonly backend = "none";
  async status() {
    return NOT_CONFIGURED;
  }
  async put(
    _s: CanonicalLeagueSnapshot,
    _o: { capture_type: CaptureType },
  ): Promise<PutSnapshotResult> {
    return { status: NOT_CONFIGURED, outcome: "error", meta: null, error: "persistence not configured" };
  }
  async getLatest(_k: SnapshotKey): Promise<StoredSnapshot | null> {
    return null;
  }
  async listVersions(_k: SnapshotKey): Promise<StoredSnapshotMeta[]> {
    return [];
  }
  async listWeeks(_l: string, _s: number): Promise<StoredSnapshotMeta[]> {
    return [];
  }
}

class UnconfiguredLedgerStore implements LedgerStore {
  readonly backend = "none";
  async status() {
    return NOT_CONFIGURED;
  }
  async append(_t: CanonicalTransaction[]): Promise<LedgerAppendResult> {
    return { status: NOT_CONFIGURED, seen: _t.length, inserted: 0, duplicates: 0, error: "persistence not configured" };
  }
  async query(_f: TransactionFilter): Promise<StoredTransaction[]> {
    return [];
  }
  async count(_l: string, _s: number): Promise<number> {
    return 0;
  }
}

class UnconfiguredRunStore implements CaptureRunStore {
  readonly backend = "none";
  async status() {
    return NOT_CONFIGURED;
  }
  async start(_i: CaptureRunInput): Promise<string | null> {
    return null;
  }
  async finish(): Promise<void> {}
}

let cached: PersistenceBundle | null = null;

export function getPersistence(env: NodeJS.ProcessEnv = process.env): PersistenceBundle {
  const useCache = env === process.env;
  if (useCache && cached) return cached;
  const cfg = loadSupabaseConfig(env);
  if (!cfg.configured || !cfg.config) {
    const bundle: PersistenceBundle = {
      snapshots: new UnconfiguredSnapshotStore(),
      ledger: new UnconfiguredLedgerStore(),
      runs: new UnconfiguredRunStore(),
      status: async () => NOT_CONFIGURED,
    };
    if (useCache) cached = bundle;
    return bundle;
  }
  const rest = new SupabaseRest(cfg.config);
  const snapshots = new SupabaseSnapshotStore(rest);
  const ledger = new SupabaseLedgerStore(rest);
  const runs = new SupabaseCaptureRunStore(rest);
  const bundle: PersistenceBundle = {
    snapshots,
    ledger,
    runs,
    status: async () => {
      const [a, b, c] = await Promise.all([snapshots.status(), ledger.status(), runs.status()]);
      return [a, b, c].every((s) => s === "READY") ? "READY" : "PERSISTENCE_ERROR";
    },
  };
  if (useCache) cached = bundle;
  return bundle;
}

/** Test/CLI seam: replace the process-wide bundle (e.g. with `memoryPersistence()`). */
export function setPersistence(bundle: PersistenceBundle | null): void {
  cached = bundle;
}

export * from "./types";
export { memoryPersistence } from "./memory";
