/**
 * Phase 4.5 — deterministic player-universe eligibility rules (versioned by MARKET_ELIGIBILITY_RULES_VERSION).
 *
 * The provider universe is large and noisy (12k+ entries). Each entry is classified into exactly one outcome with an explicit
 * reason. A poor or injured player is NEVER excluded for that reason: injury/IR/PUP designations are caveats, not verdicts.
 * Unknown provider vocabulary maps to UNKNOWN, never to eligible.
 */
import type { IneligibleReason, PlayerCaveat, UnknownReason } from "./contract";

export interface UniversePlayer {
  player_id: string;
  full_name: string | null;
  position: string | null;
  fantasy_positions: string[];
  team: string | null;
  status: string | null;
  injury_status: string | null;
  active: boolean | null;
}

const BASE = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
const FLEX_POSITIONS: Record<string, string[]> = {
  FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
};
/** Provider sub-positions folded into league slot positions (only matters when the league has such a slot). */
const POSITION_FOLD: Record<string, string> = { DE: "DL", DT: "DL", NT: "DL", OLB: "LB", ILB: "LB", MLB: "LB", CB: "DB", S: "DB", SS: "DB", FS: "DB", DST: "DEF", "D/ST": "DEF" };
export const foldPosition = (p: string | null | undefined): string | null => { if (!p) return null; const u = p.toUpperCase(); if (u === "XX") return null; return POSITION_FOLD[u] ?? u; };

/** Positions a league can START, expanded from its `roster_positions` (BN/IR/TAXI never add a position). */
export function startablePositionsFor(rosterPositions: string[]): string[] {
  const out = new Set<string>();
  for (const s of rosterPositions) { const u = s.toUpperCase(); if (BASE.has(u) || ["DL", "LB", "DB"].includes(u)) out.add(u); else if (FLEX_POSITIONS[u]) for (const p of FLEX_POSITIONS[u]) out.add(p); }
  return [...out].sort();
}

export type UniverseVerdict =
  | { kind: "INELIGIBLE"; reason: IneligibleReason }
  | { kind: "UNKNOWN"; reason: UnknownReason }
  | { kind: "ELIGIBLE"; entity: "PLAYER" | "TEAM_DEFENSE"; position: string; team: string; caveats: PlayerCaveat[] };

const CAVEAT_BY_STATUS: Record<string, PlayerCaveat> = { "injured reserve": "NFL_INJURED_RESERVE_DESIGNATION", inactive: "NFL_INACTIVE_DESIGNATION", suspended: "SUSPENDED", pup: "PUP_OR_NFI", "physically unable to perform": "PUP_OR_NFI", "non football injury": "PUP_OR_NFI" };
const CAVEAT_BY_INJURY: Record<string, PlayerCaveat> = { ir: "NFL_INJURED_RESERVE_DESIGNATION", pup: "PUP_OR_NFI", sus: "SUSPENDED" };

export function classifyUniversePlayer(p: UniversePlayer, startable: ReadonlySet<string>): UniverseVerdict {
  const pos = foldPosition(p.position) ?? foldPosition(p.fantasy_positions.find((x) => foldPosition(x) && startable.has(foldPosition(x)!)) ?? null);
  const isDef = pos === "DEF" || (p.position?.toUpperCase() === "DEF");
  if (!pos) return { kind: "INELIGIBLE", reason: "NO_FANTASY_POSITION" };
  if (!startable.has(pos)) return { kind: "INELIGIBLE", reason: "POSITION_NOT_IN_LEAGUE" };
  // A team defense is a TEAM entity keyed by its team abbreviation; it never passes through individual-player status logic.
  if (isDef) { const t = (p.team ?? p.player_id ?? "").toUpperCase(); return t ? { kind: "ELIGIBLE", entity: "TEAM_DEFENSE", position: "DEF", team: t, caveats: [] } : { kind: "INELIGIBLE", reason: "NO_NFL_TEAM" }; }
  if (!p.team) return { kind: "INELIGIBLE", reason: "NO_NFL_TEAM" };
  // The provider database carries placeholder rows for merged/stale identities (live example: "Duplicate Player", team CHI, active=false). Never a real acquisition target.
  if (/^\s*duplicate\b/i.test(p.full_name ?? "")) return { kind: "INELIGIBLE", reason: "DUPLICATE_OR_STALE_IDENTITY" };
  const status = (p.status ?? "").trim().toLowerCase();
  if (status === "retired") return { kind: "INELIGIBLE", reason: "RETIRED_OR_INACTIVE_IDENTITY" };
  if (status === "practice squad") return { kind: "UNKNOWN", reason: "PRACTICE_SQUAD_ELIGIBILITY_UNVERIFIED" };
  // The provider's own `active: false` flag contradicts any listed team/status (a "Inactive" status is legitimate ONLY with active=true — it is Sleeper's label for an inactive/injured roster player).
  // Live audit: 4 such rows per league (stale identities). Not proven acquirable, so UNKNOWN — never silently eligible.
  if (p.active === false) return { kind: "UNKNOWN", reason: "PLAYER_MARKED_NOT_ACTIVE" };
  if (status === "" || (status !== "active" && !(status in CAVEAT_BY_STATUS))) return { kind: "UNKNOWN", reason: "PLAYER_STATUS_UNRECOGNIZED" };
  const caveats = new Set<PlayerCaveat>();
  const sc = CAVEAT_BY_STATUS[status]; if (sc) caveats.add(sc);
  const inj = (p.injury_status ?? "").trim().toLowerCase(); if (inj) { caveats.add("INJURY_DESIGNATION_PRESENT"); const ic = CAVEAT_BY_INJURY[inj]; if (ic) caveats.add(ic); }
  return { kind: "ELIGIBLE", entity: "PLAYER", position: pos, team: p.team.toUpperCase(), caveats: [...caveats].sort() };
}
