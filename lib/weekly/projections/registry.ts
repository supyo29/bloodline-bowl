/**
 * Weekly projection provider selection.
 *
 * Today: Sleeper's weekly feed for every league (it is NFL-player projection
 * data, resolved through the canonical crosswalk — not a Sleeper *fantasy*
 * object). When a league's own Roster Intel weekly projections exist for the
 * season, a `SupabaseWeeklyProjectionProvider` slots in here without any
 * analytics change.
 */

import type { ProviderName } from "@/lib/canonical/schema";
import { SleeperWeeklyProjectionProvider } from "./sleeper-weekly";
import type { ProjectionProvider } from "./types";

export function getWeeklyProjectionProvider(_provider: ProviderName): ProjectionProvider {
  return new SleeperWeeklyProjectionProvider();
}
