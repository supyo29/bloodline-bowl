/**
 * Player x Scheme Intelligence — file-backed read adapter (Phase 9).
 *
 * Pure synchronous file reads over `lib/player-scheme-intelligence/data/*`
 * (committed, Vercel-safe — same boundary as `lib/football-intel/read.ts`).
 * No R, no network, no recomputation.
 *
 * Honest degradation (aligns with FI spec §25):
 *   - no manifest / no data file          -> loadPlayerSchemeIntelligence() returns null
 *   - player join key not found           -> { resolution: "UNRESOLVED" }
 *   - profile / interaction pair absent   -> { availability: "NOT_AVAILABLE" }
 *   - a cell below publication threshold  -> present, evidence_class "INSUFFICIENT"
 *
 * Phase 9 Part II populates the data directory + fills in the readers. Until
 * then this module compiles, is imported nowhere in the production path, and
 * returns null so no consumer can accidentally depend on it (spec §1, §44).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlayerSchemeManifest } from "./schema";

const DATA_DIR = join(process.cwd(), "lib", "player-scheme-intelligence", "data");
const MANIFEST = join(DATA_DIR, "player_scheme_manifest.json");

export interface PlayerSchemeIntelligence {
  manifest: PlayerSchemeManifest;
}

let cache: PlayerSchemeIntelligence | null | undefined;

export function __resetPlayerSchemeCache(): void {
  cache = undefined;
}

export function loadPlayerSchemeIntelligence(): PlayerSchemeIntelligence | null {
  if (cache !== undefined) return cache;
  if (!existsSync(MANIFEST)) {
    cache = null;
    return cache;
  }
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as PlayerSchemeManifest;
    cache = { manifest };
  } catch {
    cache = null;
  }
  return cache;
}
