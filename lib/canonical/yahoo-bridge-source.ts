/**
 * I/O edge of the Yahoo -> Sleeper identity bridge: builds the bridge from Sleeper's player database (the client already caches it for 24h) and memoizes
 * the built index. A failure returns null (identity simply stays provider-scoped and visibly unresolved); it never throws into a state build.
 */
import { getPlayerIndex } from "@/lib/sleeper/client";
import { YahooSleeperBridge, type BridgeCandidate } from "./yahoo-sleeper-bridge";

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
