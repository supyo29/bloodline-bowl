/**
 * Bridge canonical identity for season-projection outputs.
 *
 * The season model keys everything on the Sleeper `player_id` (its own internal
 * "canonical" notion). Phase 1B.1 additively exposes the BRIDGE canonical
 * identity (`lib/canonical/*`) on projection responses so a downstream consumer
 * can line a projected value up with the canonical league snapshot — and see
 * EXPLICITLY when that line-up is only provider-scoped (not cross-provider
 * verified) rather than silently trusting a Sleeper id.
 *
 * The projection MODELS are untouched and NOT merged — this is a response-layer
 * annotation only.
 */

import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { defaultCrosswalkSource } from "@/lib/persistence/supabase/crosswalk-source";

export interface CanonicalIdentity {
  /** Bridge canonical id. `player:gsis:*` = cross-provider verified; `player:sleeper:*` = provider-scoped only; null = unresolvable. */
  canonical_player_id: string | null;
  method: "stable_id" | "name_position_team" | "name_position" | "unresolved";
  confidence: "exact" | "high" | "low" | "none";
  /** True only when the id is a real cross-provider identity (gsis-backed). */
  cross_provider_verified: boolean;
}

export async function loadProjectionCrosswalk(): Promise<PlayerCrosswalk> {
  const source = defaultCrosswalkSource();
  const crosswalk = source ? new PlayerCrosswalk(source) : new PlayerCrosswalk(NoCrosswalk);
  await crosswalk.ensureLoaded();
  return crosswalk;
}

export function resolveCanonicalIdentity(
  crosswalk: PlayerCrosswalk,
  player: { player_id: string; full_name: string; position: string | null; team: string | null },
): CanonicalIdentity {
  const { player: resolved } = crosswalk.resolve({
    provider: "sleeper",
    provider_player_id: player.player_id,
    full_name: player.full_name,
    position: player.position,
    nfl_team: player.team,
  });
  const unresolved = resolved.resolution.method === "unresolved";
  const id = unresolved ? null : resolved.canonical_player_id;
  return {
    canonical_player_id: id,
    method: resolved.resolution.method,
    confidence: resolved.resolution.confidence,
    cross_provider_verified: id != null && id.startsWith("player:gsis:"),
  };
}

/** Resolve a batch, keyed by the source `player_id`. */
export function resolveCanonicalIdentities(
  crosswalk: PlayerCrosswalk,
  players: ReadonlyArray<{ player_id: string; full_name: string; position: string | null; team: string | null }>,
): Map<string, CanonicalIdentity> {
  const out = new Map<string, CanonicalIdentity>();
  for (const p of players) out.set(p.player_id, resolveCanonicalIdentity(crosswalk, p));
  return out;
}
