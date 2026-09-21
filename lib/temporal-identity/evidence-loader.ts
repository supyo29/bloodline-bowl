/**
 * Phase 7 — assembles ALL membership evidence for one player (best-effort, read-only): Role participation file, Supabase game logs + identity-table snapshot, and the provider's
 * statement about NOW. Lives in lib/temporal-identity, NOT in Book-Ready (which may not touch stores). A source that is unavailable simply contributes nothing — absence yields NO_EVIDENCE, never a guessed team.
 */
import { loadRoleParticipation, providerCurrent, crosswalkSnapshot } from "./sources";
import type { TeamObservation } from "./membership";
import { defaultTeamMembershipRest, loadGameLogObservations } from "@/lib/persistence/supabase/team-membership-source";

export async function loadMembershipEvidence(o: { gsis_id: string; season: number; sleeper_id?: string | null; current: boolean }): Promise<TeamObservation[]> {
  const obs: TeamObservation[] = [...loadRoleParticipation()];
  try {
    const rest = defaultTeamMembershipRest();
    if (rest) {
      obs.push(...(await loadGameLogObservations(rest, [o.gsis_id])));
      const row = await rest.select<{ latest_team: string | null }>("nfl_players", { select: "latest_team", filter: { gsis_id: `eq.${o.gsis_id}` }, limit: 1 });
      if (row[0]) obs.push(crosswalkSnapshot(o.gsis_id, o.season, row[0].latest_team, "nfl_players@2026-03-18"));
    }
  } catch { /* best-effort */ }
  if (o.current && o.sleeper_id) {
    try { const { getPlayerIndex } = await import("@/lib/sleeper/client"); const idx = await getPlayerIndex(); obs.push(providerCurrent(o.gsis_id, o.season, idx.get(o.sleeper_id)?.team ?? null, "sleeper-players")); } catch { /* best-effort */ }
  }
  return obs;
}
