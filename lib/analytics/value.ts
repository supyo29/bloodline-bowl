/**
 * Builds `/api/value` facts: player identity plus every attributed value the
 * configured provider returns. Never averages across sources into an unlabeled
 * consensus number — see `lib/values/provider.ts` for why none is configured
 * today.
 */

import { getValueProvider } from "@/lib/values/provider";
import { slimPlayer, type PlayerIndex } from "@/lib/sleeper/client";
import type { PlayerValue } from "@/lib/values/types";
import type { NormalizedPlayer } from "@/lib/sleeper/types";

export interface PlayerValueFacts {
  player_id: string;
  player: NormalizedPlayer;
  values: PlayerValue[];
}

export async function buildValueFacts(
  playerIds: string[],
  playerIndex: PlayerIndex,
): Promise<{
  players: PlayerValueFacts[];
  provider_available: boolean;
  warnings: string[];
}> {
  const provider = getValueProvider();
  const warnings: string[] = [];

  if (!provider.isAvailable()) {
    warnings.push(
      provider.unavailableReason() ?? "No player-value provider is configured.",
    );
  }

  const valuesByPlayer = await provider.getValues(playerIds);

  const players = playerIds.map((playerId): PlayerValueFacts => ({
    player_id: playerId,
    player: playerIndex.get(playerId) ?? slimPlayer(playerId, undefined),
    values: valuesByPlayer.get(playerId) ?? [],
  }));

  return { players, provider_available: provider.isAvailable(), warnings };
}
