/**
 * Weekly projection provider selection.
 *
 * Today: Sleeper's weekly feed for every league (it is NFL-player projection
 * data, resolved through the canonical crosswalk — not a Sleeper *fantasy*
 * object). Yahoo leagues therefore also read this feed: one upstream NFL source
 * observation is shared by every league and scored per league downstream.
 * When a league's own Roster Intel weekly projections exist for the season, a
 * `SupabaseWeeklyProjectionProvider` slots in here without any analytics change.
 *
 * W1.P4 wiring (process singletons so ALL leagues share one observation history and one invalidation ledger):
 *   - the Sleeper provider offers each upstream fetch (league-independent facts) to the observation recorder, once per fetch
 *   - the canonical wrapper gets the live kickoff source and the shared ledger the recorder fills
 */

import type { ProviderName } from "@/lib/canonical/schema";
import { getSourceObservationStore } from "@/lib/persistence/supabase/projection-observations";
import { InvalidationLedger } from "../freshness/events";
import { LiveKickoffSource, type KickoffSource } from "../freshness/kickoff";
import { MemorySourceObservationStore, SourceObservationRecorder } from "../freshness/observation";
import { SleeperWeeklyProjectionProvider } from "./sleeper-weekly";
import { CanonicalProjectionSnapshotProvider } from "./canonical-provider";
import type { ProjectionProvider } from "./types";

const ledger = new InvalidationLedger();
let recorder: SourceObservationRecorder | null = null;
let kickoff: KickoffSource | null = null;

/** The process-wide recorder: durable (Supabase) when configured, otherwise in-memory so invalidation events still flow within the process. */
export function getSourceObservationRecorder(): SourceObservationRecorder {
  if (!recorder) recorder = new SourceObservationRecorder(getSourceObservationStore() ?? new MemorySourceObservationStore(), ledger);
  return recorder;
}

export function getKickoffSource(): KickoffSource {
  if (!kickoff) kickoff = new LiveKickoffSource();
  return kickoff;
}

/** test hook */
export function __resetFreshnessRuntimeForTests(): void {
  recorder = null;
  kickoff = null;
  ledger.clear();
}

export function getWeeklyProjectionProvider(_provider: ProviderName): ProjectionProvider {
  const rec = getSourceObservationRecorder();
  return new CanonicalProjectionSnapshotProvider(new SleeperWeeklyProjectionProvider((o) => rec.record(o)), undefined, {
    kickoffSource: getKickoffSource(),
    ledger,
  });
}
