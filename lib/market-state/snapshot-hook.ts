/** One-way TELEMETRY hook for persisting market snapshots (mirrors the Waiver 2.0 capture hook). Never throws, never alters the snapshot; installed by the server route. */
import type { MarketSnapshot } from "./contract";
export type MarketSnapshotHook = (s: MarketSnapshot) => Promise<unknown>;
let hook: MarketSnapshotHook | null = null;
export function installMarketSnapshotHook(h: MarketSnapshotHook | null): void { hook = h; }
export async function runMarketSnapshotHook(s: MarketSnapshot | null | undefined): Promise<void> {
  if (!hook || !s) return;
  try { await hook(s); } catch { /* telemetry only */ }
}
