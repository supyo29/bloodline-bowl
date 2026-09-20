/**
 * Phase 3.5C — identity quality. Placeholder / blank identities are NOT dropped and NOT repaired: legitimate
 * evidence attached to them stays queryable, with the limitation stated. No identity is ever invented.
 */
import type { SubjectIdentity } from "./schema";

const REAL_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "P", "DEF", "OL", "DL", "LB", "DB", "LS"]);
/** nflverse's "no position" code (retired / inactive / unknown). Source-native; kept as-is. */
const PLACEHOLDER_POSITIONS = new Set(["XX"]);

export function classifyIdentity(input: {
  canonical_player_id?: string | null; source_player_id?: string | null; source_id_type?: string;
  name?: string | null; position?: string | null; team?: string | null;
}): SubjectIdentity {
  const name = input.name?.trim() || null; const position = input.position?.trim() || null; const team = input.team?.trim() || null;
  const limitations: string[] = [];
  const hasId = !!(input.canonical_player_id || input.source_player_id);
  let resolution: SubjectIdentity["resolution"];
  if (!hasId && !name) resolution = "UNRESOLVED";
  else if (!name && !position && !team) { resolution = "PLACEHOLDER"; limitations.push("identity has only an id: no name, position or team in the source directory"); }
  else if (position && PLACEHOLDER_POSITIONS.has(position)) { resolution = "PLACEHOLDER"; limitations.push(`position '${position}' is a source-native no-position placeholder (not a real position)`); }
  else if (!name || !position || !team) {
    resolution = "PARTIAL";
    if (!name) limitations.push("name missing"); if (!position) limitations.push("position missing"); if (!team) limitations.push("team missing");
  } else if (!REAL_POSITIONS.has(position)) { resolution = "PARTIAL"; limitations.push(`position '${position}' not in the known position set`); }
  else resolution = "RESOLVED";
  return {
    resolution, canonical_player_id: input.canonical_player_id ?? null, source_player_id: input.source_player_id ?? null,
    ...(input.source_id_type ? { source_id_type: input.source_id_type } : {}), name, position, team, limitations,
  };
}
