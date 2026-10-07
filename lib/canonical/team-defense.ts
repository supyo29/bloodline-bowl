/**
 * W1.R1 / P1-3 — provider-neutral TEAM DEFENSE identity.
 *
 * A team defense (D/ST) is not an individual player: it has no gsis/sleeper/yahoo person id and no crosswalk row. Before this module a
 * Yahoo defense resolved to `player:yahoo:<numeric id>` while the projection feed's defense row (Sleeper player_id "BAL") resolved to
 * `player:sleeper:bal`, so a Yahoo-rostered defense never joined its projection (`SOURCE_MISSING_PLAYER`) in both Yahoo leagues.
 *
 * One canonical entity per NFL franchise: `defense:nfl:<team>` (lowercase, repo id convention). It is derived ONLY from team evidence —
 * never from a person id, a provider numeric id, or a lucky crosswalk row — in this order:
 *   1. the observed NFL team code (Yahoo `editorial_team_abbr`, Sleeper `team`), normalised by the repo's ONE team-code normalizer
 *   2. a provider id that IS a team code (Sleeper defense `player_id` = "BAL")
 *   3. the team name / city / nickname ("Baltimore", "Ravens", "Baltimore Ravens D/ST")
 * Evidence that disagrees, or a label that names more than one franchise ("New York", "Los Angeles"), is AMBIGUOUS and never mapped.
 */

import { CANONICAL_TEAMS, isCanonicalTeam, normalizeTeamCode } from "./team-codes";

export const TEAM_DEFENSE_ID_PREFIX = "defense:nfl:" as const;

export function teamDefenseId(team: string): string {
  const t = normalizeTeamCode(team);
  if (!t || !isCanonicalTeam(t)) throw new Error(`teamDefenseId: not an NFL team code: ${team}`);
  return `${TEAM_DEFENSE_ID_PREFIX}${t.toLowerCase()}`;
}

/** Canonical NFL team code for a `defense:nfl:<team>` id, else null. */
export function teamFromDefenseId(canonicalId: string | null | undefined): string | null {
  if (!canonicalId || !canonicalId.startsWith(TEAM_DEFENSE_ID_PREFIX)) return null;
  const t = canonicalId.slice(TEAM_DEFENSE_ID_PREFIX.length).toUpperCase();
  return isCanonicalTeam(t) ? t : null;
}
export const isTeamDefenseId = (id: string | null | undefined): boolean => teamFromDefenseId(id) != null;

/**
 * The bare SLEEPER player id for a canonical id, for joins into Sleeper-keyed stat tables (actuals, transactions). A person is
 * `player:sleeper:<id>`; a team defense is its team code (Sleeper keys defenses by team abbreviation). Any other scheme -> null (never guessed).
 */
export function sleeperIdFromCanonicalId(canonicalId: string | null | undefined): string | null {
  if (!canonicalId) return null;
  const m = /^player:sleeper:(.+)$/.exec(canonicalId);
  if (m) return m[1]!;
  return teamFromDefenseId(canonicalId);
}

const TEAMS: ReadonlyArray<readonly [string, string, string]> = [
  ["ARI", "arizona", "cardinals"], ["ATL", "atlanta", "falcons"], ["BAL", "baltimore", "ravens"], ["BUF", "buffalo", "bills"],
  ["CAR", "carolina", "panthers"], ["CHI", "chicago", "bears"], ["CIN", "cincinnati", "bengals"], ["CLE", "cleveland", "browns"],
  ["DAL", "dallas", "cowboys"], ["DEN", "denver", "broncos"], ["DET", "detroit", "lions"], ["GB", "green bay", "packers"],
  ["HOU", "houston", "texans"], ["IND", "indianapolis", "colts"], ["JAX", "jacksonville", "jaguars"], ["KC", "kansas city", "chiefs"],
  ["LAC", "los angeles chargers", "chargers"], ["LAR", "los angeles rams", "rams"], ["LV", "las vegas", "raiders"], ["MIA", "miami", "dolphins"],
  ["MIN", "minnesota", "vikings"], ["NE", "new england", "patriots"], ["NO", "new orleans", "saints"], ["NYG", "new york giants", "giants"],
  ["NYJ", "new york jets", "jets"], ["PHI", "philadelphia", "eagles"], ["PIT", "pittsburgh", "steelers"], ["SEA", "seattle", "seahawks"],
  ["SF", "san francisco", "49ers"], ["TB", "tampa bay", "buccaneers"], ["TEN", "tennessee", "titans"], ["WAS", "washington", "commanders"],
];
if (TEAMS.length !== CANONICAL_TEAMS.length) throw new Error("team-defense name table must cover every canonical team");

const NAME_TO_TEAM = new Map<string, string>();
for (const [code, city, nick] of TEAMS) {
  NAME_TO_TEAM.set(nick, code);
  NAME_TO_TEAM.set(city, code);
  NAME_TO_TEAM.set(`${city} ${nick}`, code);
}
// historical / alternate names that unambiguously name ONE franchise
NAME_TO_TEAM.set("oakland raiders", "LV");
NAME_TO_TEAM.set("washington football team", "WAS");
NAME_TO_TEAM.set("washington redskins", "WAS");
NAME_TO_TEAM.set("new york giants", "NYG");
NAME_TO_TEAM.set("new york jets", "NYJ");
NAME_TO_TEAM.set("la rams", "LAR");
NAME_TO_TEAM.set("la chargers", "LAC");
/** a label that names MORE THAN ONE franchise: never mapped */
const AMBIGUOUS_LABELS = new Set(["new york", "ny", "los angeles", "la", "l.a.", "n.y.", "new york defense"]);

const DEFENSE_SUFFIX = /\s*\b(d\/st|d-st|dst|defense|defence|def)\b\.?\s*$/i;

export type DefenseTeamResolution =
  | { status: "RESOLVED"; team: string; via: "team_code" | "provider_id" | "name" }
  | { status: "AMBIGUOUS"; reason: string }
  | { status: "UNRESOLVED" };

export interface DefenseEvidence {
  nfl_team?: string | null;
  provider_player_id?: string | null;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

function teamFromName(raw: string | null | undefined): { team: string | null; ambiguous: boolean } {
  if (!raw) return { team: null, ambiguous: false };
  const label = raw.trim().replace(DEFENSE_SUFFIX, "").replace(/\s+/g, " ").toLowerCase();
  if (!label) return { team: null, ambiguous: false };
  if (AMBIGUOUS_LABELS.has(label)) return { team: null, ambiguous: true };
  const hit = NAME_TO_TEAM.get(label);
  return { team: hit ?? null, ambiguous: false };
}

export function resolveDefenseTeam(e: DefenseEvidence): DefenseTeamResolution {
  const byCode = normalizeTeamCode(e.nfl_team);
  const codeTeam = byCode && isCanonicalTeam(byCode) ? byCode : null;
  const idTeamRaw = normalizeTeamCode(e.provider_player_id);
  const idTeam = idTeamRaw && isCanonicalTeam(idTeamRaw) && /^[A-Za-z]{2,4}$/.test((e.provider_player_id ?? "").trim()) ? idTeamRaw : null;
  const names = [e.full_name, [e.first_name, e.last_name].filter(Boolean).join(" ") || null];
  let nameTeam: string | null = null;
  let nameAmbiguous = false;
  for (const n of names) {
    const r = teamFromName(n);
    if (r.ambiguous) nameAmbiguous = true;
    if (r.team) {
      if (nameTeam && nameTeam !== r.team) return { status: "AMBIGUOUS", reason: "defense name parts name different franchises" };
      nameTeam = r.team;
    }
  }
  const evidence = [codeTeam && { team: codeTeam, via: "team_code" as const }, idTeam && { team: idTeam, via: "provider_id" as const }, nameTeam && { team: nameTeam, via: "name" as const }].filter(Boolean) as Array<{ team: string; via: "team_code" | "provider_id" | "name" }>;
  const distinct = new Set(evidence.map((x) => x.team));
  if (distinct.size > 1) return { status: "AMBIGUOUS", reason: `defense evidence disagrees: ${evidence.map((x) => `${x.via}=${x.team}`).join(", ")}` };
  if (evidence.length > 0) return { status: "RESOLVED", team: evidence[0]!.team, via: evidence[0]!.via };
  if (nameAmbiguous) return { status: "AMBIGUOUS", reason: "defense label names more than one franchise" };
  return { status: "UNRESOLVED" };
}
