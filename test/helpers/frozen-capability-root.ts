/**
 * A capability-snapshot ROOT for the Analysis Book planner tests: the FROZEN data vintage (test/fixtures/capability-vintage-2026w1 — manifests that the football-intel / intelligence-history
 * bots rewrite every few days) overlaid with the LIVE surface registry (so registry-driven behavior is still exercised against the real file). See the fixture README for provenance.
 */
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** a fresh, mutable root (tests that edit the registry copy use this) */
export function makeCapabilityRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "abcap-"));
  cpSync(join(process.cwd(), "test", "fixtures", "capability-vintage-2026w1"), root, { recursive: true });
  cpSync(join(process.cwd(), "docs", "intelligence-surface-registry.json"), join(root, "docs", "intelligence-surface-registry.json"), { recursive: true });
  return root;
}
/** a shared read-only root */
export const FROZEN_CAPABILITY_ROOT = makeCapabilityRoot();
