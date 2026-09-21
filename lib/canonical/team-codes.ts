/**
 * Canonical NFL team codes — the ONE normalizer for team-code vocabularies.
 *
 * Phase 7 audit found four vocabularies in live data: Sleeper/Role/FI (`LAR`, `LV`, `SF`, `JAX`), nflverse-style directory (`LVR`, `SFO`, `KCC`, `JAC`, `NEP`, `NOS`,
 * `GBP`, `TBB`), Supabase game logs and `nfl_players.latest_team` (`LA` for the Rams), and provider free-agent markers (`FA`, `FA*`, blank). A join keyed on one vocabulary
 * silently misses rows in another (e.g. `LA` != `LAR`), so every team comparison in the temporal layer goes through this function. Same alias table Matchup 2.0 previously kept privately,
 * now shared; behavior-preserving there.
 */
const ALIAS: Record<string, string> = { GBP: "GB", JAC: "JAX", KCC: "KC", LVR: "LV", OAK: "LV", NEP: "NE", NOS: "NO", SFO: "SF", TBB: "TB", LA: "LAR", STL: "LAR", SD: "LAC", SDG: "LAC", WSH: "WAS" };
export const CANONICAL_TEAMS = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS"] as const;
const SET = new Set<string>(CANONICAL_TEAMS);

/** Normalized 2-3 letter team code, or null for blank / free-agent markers. An unknown non-blank code is returned upper-cased (never guessed into a team). */
export function normalizeTeamCode(t: string | null | undefined): string | null {
  if (t == null) return null; const u = t.trim().toUpperCase(); if (u === "" || u.startsWith("FA")) return null; return ALIAS[u] ?? u;
}
export const isCanonicalTeam = (t: string | null | undefined): boolean => { const n = normalizeTeamCode(t); return n != null && SET.has(n); };
/** True when the raw value is a free-agent / no-team marker (distinct from "unknown"). */
export const isNoTeamMarker = (t: string | null | undefined): boolean => t != null && /^\s*FA\*?\s*$/i.test(t);
