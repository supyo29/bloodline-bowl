/**
 * Phase 7 — assembles ALL membership evidence for one player (read-only) AND reports the state of every source, so an unavailable source is surfaced as
 * TEMPORAL_SOURCE_UNAVAILABLE rather than silently degrading into "no evidence". Lives in lib/temporal-identity, NOT in Book-Ready (which may not touch stores).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadRoleParticipation, providerCurrent, crosswalkSnapshot } from "./sources";
import type { TeamObservation } from "./membership";
import { defaultTeamMembershipRest, loadGameLogObservations } from "@/lib/persistence/supabase/team-membership-source";

export interface SourceStatus { source: string; state: "OK" | "NOT_CONFIGURED" | "ERROR"; detail?: string }
export interface MembershipEvidence { observations: TeamObservation[]; sources: SourceStatus[] }

export async function loadMembershipEvidence(o: { gsis_id: string; season: number; sleeper_id?: string | null; current: boolean; root?: string }): Promise<MembershipEvidence> {
  const observations: TeamObservation[] = []; const sources: SourceStatus[] = [];
  const rolePath = join(o.root ?? process.cwd(), "lib", "player-role-intelligence", "data", "player_game_role.csv");
  if (existsSync(rolePath)) { observations.push(...loadRoleParticipation(o.root)); sources.push({ source: "role_participation", state: "OK" }); } else sources.push({ source: "role_participation", state: "ERROR", detail: "player_game_role.csv not found" });
  try {
    const rest = defaultTeamMembershipRest();
    if (!rest) sources.push({ source: "game_logs", state: "NOT_CONFIGURED", detail: "Supabase is not configured in this environment" });
    else {
      observations.push(...(await loadGameLogObservations(rest, [o.gsis_id]))); sources.push({ source: "game_logs", state: "OK" });
      const row = await rest.select<{ latest_team: string | null }>("nfl_players", { select: "latest_team", filter: { gsis_id: `eq.${o.gsis_id}` }, limit: 1 });
      if (row[0]) observations.push(crosswalkSnapshot(o.gsis_id, o.season, row[0].latest_team, "nfl_players@2026-03-18")); sources.push({ source: "identity_snapshot", state: "OK" });
    }
  } catch (e) { sources.push({ source: "game_logs", state: "ERROR", detail: e instanceof Error ? e.message.slice(0, 120) : "error" }); }
  if (o.current && o.sleeper_id) {
    try { const { getPlayerIndex } = await import("@/lib/sleeper/client"); const idx = await getPlayerIndex(); observations.push(providerCurrent(o.gsis_id, o.season, idx.get(o.sleeper_id)?.team ?? null, "sleeper-players")); sources.push({ source: "provider_current", state: "OK" }); }
    catch (e) { sources.push({ source: "provider_current", state: "ERROR", detail: e instanceof Error ? e.message.slice(0, 120) : "error" }); }
  }
  return { observations, sources };
}
