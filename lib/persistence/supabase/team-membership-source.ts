/** Phase 7 — reads game-level team observations from Supabase `player_lab_game_logs` (READ-ONLY, chunked because PostgREST caps a response at 1,000 rows). */
import { fromGameLogRows, type GameLogRow } from "@/lib/temporal-identity/sources";
import type { TeamObservation } from "@/lib/temporal-identity/membership";
import { SupabaseRest, loadSupabaseConfig } from "./rest";

const CHUNK = 4; /* 4 players x <= ~130 career rows each stays well under the 1,000-row response cap */
export async function loadGameLogObservations(rest: SupabaseRest, gsisIds: readonly string[]): Promise<TeamObservation[]> {
  const out: GameLogRow[] = [];
  for (let i = 0; i < gsisIds.length; i += CHUNK) {
    const ids = gsisIds.slice(i, i + CHUNK).filter((x) => /^[0-9A-Za-z-]+$/.test(x)); if (!ids.length) continue;
    out.push(...(await rest.select<GameLogRow>("player_lab_game_logs", { select: "gsis_id,season,week,team,opponent_team", filter: { gsis_id: `in.(${ids.join(",")})` }, order: "season.asc,week.asc", limit: 1000 })));
  }
  return fromGameLogRows(out);
}
export function defaultTeamMembershipRest(env: NodeJS.ProcessEnv = process.env): SupabaseRest | null { const c = loadSupabaseConfig(env); return c.configured && c.config ? new SupabaseRest(c.config) : null; }
