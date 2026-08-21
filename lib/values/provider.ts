/**
 * Provider selection for `/api/value`.
 *
 * No player-value source is currently configured for Bloodline Bowl. Rather
 * than fabricate consensus numbers or silently wire in a paid API, this
 * exports an explicit "unavailable" provider — the architecture is real and
 * ready to swap in a future {@link PlayerValueProvider}, but today's answer
 * is an honest, documented absence.
 */

import type { PlayerValue, PlayerValueProvider } from "./types";

class UnavailablePlayerValueProvider implements PlayerValueProvider {
  readonly name = "none";

  isAvailable(): boolean {
    return false;
  }

  unavailableReason(): string {
    return "No player-value provider is currently configured for Bloodline Bowl. This endpoint's architecture supports adding one (ADP, auction values, dynasty rankings, projections) behind the PlayerValueProvider interface without changing the response shape.";
  }

  async getValues(): Promise<Map<string, PlayerValue[]>> {
    return new Map();
  }
}

let activeProvider: PlayerValueProvider = new UnavailablePlayerValueProvider();

export function getValueProvider(): PlayerValueProvider {
  return activeProvider;
}

/** Exposed for tests to swap in a fake provider without touching module state elsewhere. */
export function setValueProviderForTesting(
  provider: PlayerValueProvider,
): void {
  activeProvider = provider;
}
