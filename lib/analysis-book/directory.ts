/** Phase 3.5D — the default PlayerDirectory: a cheap read of the served Role profiles (identity only; no evidence retrieval). */
import { loadRoleOpportunitySnapshot } from "@/lib/player-role-intelligence/read";
import type { PlayerDirectory } from "./entities";

export function loadPlayerDirectory(season = 2026): PlayerDirectory {
  const snap = loadRoleOpportunitySnapshot();
  if (!snap) return { players: [], team_qb: {}, current_week: null, season };
  const players = snap.profiles.map((p) => ({ gsis_id: p.identity.gsis_id, name: p.identity.full_name, position: p.identity.position ?? null, team: p.identity.team ?? null, opponent: p.identity.opponent ?? null }));
  const best: Record<string, { id: string; snaps: number }> = {};
  for (const p of snap.profiles) if (p.identity.position === "QB" && p.identity.team) { const s = p.participation?.latest ?? 0; if (!best[p.identity.team] || s > best[p.identity.team]!.snaps) best[p.identity.team] = { id: p.identity.gsis_id, snaps: s }; }
  return { players, team_qb: Object.fromEntries(Object.entries(best).map(([t, v]) => [t, v.id])), current_week: snap.manifest.through_week + 1, season: snap.manifest.season ?? season };
}
