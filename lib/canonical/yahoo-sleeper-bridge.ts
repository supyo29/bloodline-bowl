/**
 * Yahoo -> Sleeper identity bridge (opt-in supplement to `PlayerCrosswalk`).
 *
 * WHY: the identity crosswalk table covers only a small slice of players, and the projection feed is keyed on Sleeper identity. A Yahoo player with no crosswalk row
 * used to fall back to `player:yahoo:<key>`, which never joins a projection (live: 4 of 15 Rogers Park roster players projected). Yahoo supplies no cross-provider id,
 * so the only evidence available is (name, position, NFL team).
 *
 * RULE (never guess): a Yahoo player is bridged to a Sleeper player ONLY when exactly ONE active Sleeper player matches the normalized name AND position AND team.
 * Zero matches -> null (stays provider-scoped, visibly unresolved). More than one -> AMBIGUOUS (null). A name alone is never enough; a team defense never goes through here.
 */
import { playerNameKey } from "./ids";
import { normalizeTeamCode, isCanonicalTeam } from "./team-codes";

export interface BridgeCandidate {
  player_id: string;
  full_name: string | null;
  position: string | null;
  fantasy_positions: string[];
  team: string | null;
  status: string | null;
  active: boolean | null;
}
/** `team_unverified` = matched on name+position because Sleeper's record carries NO team (unknown, not contradictory) and no other same-name same-position player exists. */
export type BridgeResult = { status: "MATCHED"; sleeper_id: string; team_unverified?: boolean } | { status: "AMBIGUOUS"; candidates: string[] } | { status: "NONE" };

const FANTASY = new Set(["QB", "RB", "WR", "TE", "K"]);

export class YahooSleeperBridge {
  private readonly byKey = new Map<string, Set<string>>();
  /** every active candidate by name+position, split by whether Sleeper states a team (the null-team fallback needs the full picture to stay safe) */
  private readonly byNamePos = new Map<string, { withTeam: Set<string>; noTeam: Set<string> }>();
  readonly size: number;
  constructor(players: Iterable<BridgeCandidate>) {
    let n = 0;
    for (const p of players) {
      if (!p.full_name || p.active === false) continue;
      if (/^\s*duplicate\b/i.test(p.full_name)) continue;
      const st = (p.status ?? "").trim().toLowerCase();
      if (st === "retired") continue;
      const team = normalizeTeamCode(p.team);
      const hasTeam = !!team && isCanonicalTeam(team);
      if (team && !hasTeam) continue; // an unrecognized team code is a contradiction we cannot reason about; a MISSING team is not
      const positions = new Set([p.position, ...p.fantasy_positions].filter((x): x is string => !!x).map((x) => x.toUpperCase()).filter((x) => FANTASY.has(x)));
      for (const pos of positions) {
        const np = this.byNamePos.get(playerNameKey(p.full_name, pos, null)) ?? { withTeam: new Set<string>(), noTeam: new Set<string>() };
        (hasTeam ? np.withTeam : np.noTeam).add(p.player_id); this.byNamePos.set(playerNameKey(p.full_name, pos, null), np);
        if (hasTeam) { const key = playerNameKey(p.full_name, pos, team); const set = this.byKey.get(key) ?? new Set<string>(); set.add(p.player_id); this.byKey.set(key, set); }
      }
      n += 1;
    }
    this.size = n;
  }
  lookup(o: { name: string | null; position: string | null; team: string | null }): BridgeResult {
    if (!o.name || !o.position) return { status: "NONE" };
    const team = normalizeTeamCode(o.team);
    if (!team || !isCanonicalTeam(team)) return { status: "NONE" };
    const pos = o.position.trim().toUpperCase();
    if (!FANTASY.has(pos)) return { status: "NONE" };
    const hit = this.byKey.get(playerNameKey(o.name, pos, team));
    if (hit && hit.size > 1) return { status: "AMBIGUOUS", candidates: [...hit].sort() };
    if (hit && hit.size === 1) return { status: "MATCHED", sleeper_id: [...hit][0]! };
    // No team-confirmed match. Sleeper's database leaves `team` null for many active offseason signees (unknown, not contradictory). Accept the name+position
    // match ONLY when exactly one active player has that name+position, he has no team on record, and NO other same-name same-position player carries a team.
    const np = this.byNamePos.get(playerNameKey(o.name, pos, null));
    if (!np || np.noTeam.size === 0) return { status: "NONE" };
    if (np.withTeam.size > 0) return { status: "NONE" };
    if (np.noTeam.size > 1) return { status: "AMBIGUOUS", candidates: [...np.noTeam].sort() };
    return { status: "MATCHED", sleeper_id: [...np.noTeam][0]!, team_unverified: true };
  }
}
