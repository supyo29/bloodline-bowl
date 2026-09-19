/**
 * Runtime wiring for shadow-decision capture (Phase 3.5A). Kept out of `capture.ts` so the pure
 * capture contract has no persistence imports.
 *
 *   * `installDefaultCaptureStore()` registers the durable Supabase store as the process default
 *     WHEN Supabase is configured. Otherwise the default stays `UnconfiguredCaptureStore`, which
 *     reports NOT_CONFIGURED -- never a silent success.
 *   * `resolveLockEvidence()` reads the live NFL schedule (no-store) so a decision can only be
 *     called LIVE_CAPTURED if every involved game is verifiably `pre_game` right now.
 */
import { createHash } from "node:crypto";
import { SLEEPER_ROOT_URL, fetchSleeper } from "@/lib/sleeper/client";
import { loadSupabaseConfig, SupabaseRest } from "@/lib/persistence/supabase/rest";
import { SupabaseShadowCaptureStore } from "@/lib/persistence/supabase/shadow-capture";
import type { RawNflScheduleGame } from "@/lib/canonical/nfl-reality-frontier";
import {
  classifyLock,
  involvedTeams,
  setDefaultShadowCaptureStoreResolver,
  UnconfiguredCaptureStore,
  type ShadowCaptureStore,
} from "./capture";
import type { StartSitShadowComparison } from "./schema";
import { loadStartSitModel } from "./translate";

let fpCache: { model: object; fp: string } | null = null;
/** Fingerprint of the served start_sit_model.json (so a decision names the exact artifact). */
export function startSitModelFingerprint(): string | null {
  const m = loadStartSitModel();
  if (!m) return null;
  if (fpCache?.model === m) return fpCache.fp;
  const fp = createHash("sha256").update(JSON.stringify(m)).digest("hex").slice(0, 16);
  fpCache = { model: m, fp };
  return fp;
}

let supabaseStore: ShadowCaptureStore | null = null;
const unconfigured = new UnconfiguredCaptureStore();

export function installDefaultCaptureStore(): void {
  setDefaultShadowCaptureStoreResolver(() => {
    const cfg = loadSupabaseConfig();
    if (!cfg.configured || !cfg.config) return unconfigured;
    return (supabaseStore ??= new SupabaseShadowCaptureStore(new SupabaseRest(cfg.config)));
  });
}

async function fetchScheduleNoStore(season: number): Promise<{ games: RawNflScheduleGame[] | null; fetched_at: string | null }> {
  try {
    const games = await fetchSleeper<RawNflScheduleGame[]>(`/schedule/nfl/regular/${season}`, {
      baseUrl: SLEEPER_ROOT_URL,
      noStore: true,
      timeoutMs: 2000,
    });
    return Array.isArray(games) ? { games, fetched_at: new Date().toISOString() } : { games: null, fetched_at: null };
  } catch {
    return { games: null, fetched_at: null };
  }
}

export async function resolveLockEvidence(cmp: StartSitShadowComparison, season: number, week: number) {
  const { games, fetched_at } = await fetchScheduleNoStore(season);
  return classifyLock({
    decision_timestamp: cmp.lineage.decision_generated_at,
    week,
    involved_teams: involvedTeams(cmp),
    games,
    schedule_fetched_at: fetched_at,
  });
}
