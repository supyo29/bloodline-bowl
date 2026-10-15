/**
 * I/O edge of the Yahoo -> Sleeper identity bridge: builds the bridge from Sleeper's player database (the client already caches it for 24h) and memoizes
 * the built index. A failure returns null (identity simply stays provider-scoped and visibly unresolved); it never throws into a state build.
 */
import { getPlayerIndex } from "@/lib/sleeper/client";
import { YahooSleeperBridge, type BridgeCandidate } from "./yahoo-sleeper-bridge";
import type { PlayerCrosswalk } from "./players";

const TTL_MS = 6 * 60 * 60 * 1000;
let memo: { at: number; bridge: YahooSleeperBridge } | null = null;
export const __clearYahooBridgeMemo = (): void => { memo = null; };

export async function loadYahooSleeperBridge(opts: { now?: () => number; index?: () => Promise<Map<string, unknown>> } = {}): Promise<YahooSleeperBridge | null> {
  const now = (opts.now ?? Date.now)();
  if (memo && now - memo.at < TTL_MS) return memo.bridge;
  try {
    const idx = await (opts.index ? opts.index() : getPlayerIndex());
    const players: BridgeCandidate[] = [...idx.values()].map((raw) => {
      const p = raw as { player_id: string; full_name?: string | null; position?: string | null; fantasy_positions?: string[] | null; team?: string | null; status?: string | null; active?: boolean | null };
      return { player_id: String(p.player_id), full_name: p.full_name ?? null, position: p.position ?? null, fantasy_positions: p.fantasy_positions ?? [], team: p.team ?? null, status: p.status ?? null, active: p.active ?? null };
    });
    const bridge = new YahooSleeperBridge(players);
    if (bridge.size === 0) return null;
    memo = { at: now, bridge };
    return bridge;
  } catch {
    return null;
  }
}

/** Test seam (same pattern as `yahooProviderFactory`): the bridge loader every crosswalk resolution uses. */
export const yahooBridgeLoader: { load: () => Promise<YahooSleeperBridge | null> } = { load: () => loadYahooSleeperBridge() };

/**
 * The ONE place a league-state caller obtains its crosswalk. A caller-injected crosswalk is returned untouched (tests / explicit control). Otherwise the
 * default crosswalk is built and, for a YAHOO league, bridged to the Sleeper identity.
 *
 * LIVE DEFECT this fixes (found by the W2.R1 early-shadow live run, 2026-10-14): weekly/trades/roster-health built their own default crosswalk and passed it
 * to the state builder as `crosswalkOverride`, which made the builder SKIP the Yahoo bridge. Yahoo ROSTER players kept provider-scoped ids
 * (`player:yahoo:*`) that no Sleeper-keyed projection can join (Maclin 3/17 and Rogers Park 5/15 roster players projected) while the market POOL was
 * bridged, so roster and pool never shared an identity space.
 */
export async function resolveLeagueCrosswalk(provider: string, override: PlayerCrosswalk | undefined, make: () => PlayerCrosswalk): Promise<PlayerCrosswalk> {
  if (override) return override;
  const cw = make();
  if (provider === "yahoo") cw.useYahooSleeperBridge(await yahooBridgeLoader.load());
  return cw;
}
