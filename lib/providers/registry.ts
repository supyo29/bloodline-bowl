/**
 * Provider factory + status aggregation.
 *
 * `getProvider("sleeper")` is the only way analytical code obtains a provider.
 * Instances are cheap and stateless (Sleeper) or hold just a token store
 * (Yahoo), so they are created per call rather than cached.
 */

import type { ProviderName } from "@/lib/canonical/schema";
import { SleeperProvider } from "./sleeper/provider";
import { YahooProvider } from "./yahoo/provider";
import type { FantasyProvider, ProviderHealth } from "./types";

export function getProvider(name: ProviderName): FantasyProvider {
  switch (name) {
    case "sleeper":
      return new SleeperProvider();
    case "yahoo":
      return new YahooProvider();
    case "espn":
      throw new Error("ESPN provider is not implemented. Add lib/providers/espn/ and register it here.");
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown provider: ${String(exhaustive)}`);
    }
  }
}

export const SUPPORTED_PROVIDERS: ProviderName[] = ["sleeper", "yahoo"];

export interface ProviderStatusReport {
  provider: ProviderName;
  status: ProviderHealth["status"];
  authentication: "NONE" | "OAUTH";
  detail: string;
  capabilities: ReturnType<FantasyProvider["capabilities"]>;
  checked_at: string;
}

/** Live status of every supported provider — backs `GET /api/providers`. */
export async function reportProviderStatus(): Promise<ProviderStatusReport[]> {
  return Promise.all(
    SUPPORTED_PROVIDERS.map(async (name) => {
      const provider = getProvider(name);
      const health = await provider.healthCheck();
      return {
        provider: name,
        status: health.status,
        authentication: provider.authentication,
        detail: health.detail,
        capabilities: provider.capabilities(),
        checked_at: health.checked_at,
      };
    }),
  );
}
