/**
 * Phase 3.5D — entity resolution for a question. Uses a PlayerDirectory (cheap, cached artifact read of the served Role
 * profiles) — never evidence retrieval. Ambiguity is reported, not guessed; nothing is invented.
 */
import type { PlayerRef } from "./schema";

export interface DirectoryPlayer { gsis_id: string; name: string; position: string | null; team: string | null; opponent: string | null }
export interface PlayerDirectory { players: DirectoryPlayer[]; team_qb: Record<string, string>; current_week: number | null; season: number }

const TEAMS: Record<string, string[]> = {
  ARI: ["arizona", "cardinals"], ATL: ["atlanta", "falcons"], BAL: ["baltimore", "ravens"], BUF: ["buffalo", "bills"], CAR: ["carolina", "panthers"], CHI: ["chicago", "bears"],
  CIN: ["cincinnati", "bengals"], CLE: ["cleveland", "browns"], DAL: ["dallas", "cowboys"], DEN: ["denver", "broncos"], DET: ["detroit", "lions"], GB: ["green bay", "packers"],
  HOU: ["houston", "texans"], IND: ["indianapolis", "colts"], JAX: ["jacksonville", "jaguars"], KC: ["kansas city", "chiefs"], LAC: ["chargers"], LAR: ["rams"], LV: ["las vegas", "raiders"],
  MIA: ["miami", "dolphins"], MIN: ["minnesota", "vikings"], NE: ["new england", "patriots"], NO: ["new orleans", "saints"], NYG: ["giants"], NYJ: ["jets"], PHI: ["philadelphia", "eagles"],
  PIT: ["pittsburgh", "steelers"], SEA: ["seattle", "seahawks"], SF: ["san francisco", "49ers", "niners"], TB: ["tampa bay", "buccaneers", "bucs"], TEN: ["tennessee", "titans"], WAS: ["washington", "commanders"],
};
// words that are ordinary English or verbs in a fantasy question but ALSO given names; a one-word match on these is never trusted (use a full name)
const STOP = new Set(["will", "start", "sit", "trade", "should", "this", "week", "the", "and", "for", "with", "who", "how", "why", "what", "when", "waiver", "waivers", "team", "roster", "game", "defense", "analyze", "compare", "best", "over", "into", "from", "that", "have", "does", "did", "play", "plays", "mark", "chase", "tank", "cook", "love", "gold", "young", "black", "white", "king"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();

export interface Entities { players: PlayerRef[]; teams: string[]; manager_hint: string | null; unresolved: string[]; ambiguous: string[] }

export function extractEntities(question: string, dir: PlayerDirectory): Entities {
  const q = norm(question);
  const mgr = /\b([a-z][a-z0-9_]+)'s (team|roster|season|lineup)\b/.exec(q); const managerHint = mgr ? mgr[1]! : null;
  const teams: string[] = [];
  for (const [abbr, names] of Object.entries(TEAMS)) if (names.some((n) => new RegExp(`\\b${n}\\b`).test(q)) || new RegExp(`\\b${abbr}\\b`).test(question)) teams.push(abbr);
  const found = new Map<string, DirectoryPlayer>(); const ambiguous: string[] = []; const unresolved: string[] = [];
  // full names first (unambiguous)
  for (const p of dir.players) if (q.includes(norm(p.name)) && norm(p.name).includes(" ")) found.set(p.gsis_id, p);
  const covered = new Set([...found.values()].flatMap((p) => norm(p.name).split(" ")));
  const tokens = q.split(" ").filter((t) => t.length >= 4 && !STOP.has(t) && !covered.has(t) && t !== managerHint);
  for (const t of new Set(tokens)) {
    const hits = dir.players.filter((p) => { const parts = norm(p.name).split(" "); return parts[0] === t || parts[parts.length - 1] === t; });
    if (hits.length === 1) found.set(hits[0]!.gsis_id, hits[0]!);
    else if (hits.length > 1 && !TEAMS_FLAT().has(t)) ambiguous.push(`${t} (${hits.length} players)`);
  }
  // an entity mentioned as a team nickname is not a player search failure
  for (const m of question.matchAll(/\b([A-Z]{2,4})\b/g)) if (!teams.includes(m[1]!) && !TEAM_KEYS().has(m[1]!) && !["NFL", "PPR", "FAAB", "RB", "WR", "TE", "QB", "DEF", "IR"].includes(m[1]!)) unresolved.push(m[1]!);
  if (managerHint) unresolved.push(`manager:${managerHint}`);
  const players: PlayerRef[] = [...found.values()].map((p) => ({ gsis_id: p.gsis_id, name: p.name, position: p.position, team: p.team, opponent: p.opponent }));
  return { players, teams, manager_hint: managerHint, unresolved: [...new Set(unresolved)], ambiguous };
}
function TEAMS_FLAT() { return new Set(Object.values(TEAMS).flat()); }
function TEAM_KEYS() { return new Set(Object.keys(TEAMS)); }
