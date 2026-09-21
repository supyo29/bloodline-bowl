/**
 * Phase 5 Checkpoint B — CANONICAL MATCHUP CONTEXT. Built ONCE per game/defense and reused for every offensive player (no per-player
 * rebuilding). Deterministic identity: excludes every volatile field (request ids, timestamps).
 */
import { hashOf } from "./hash";
import { MATCHUP2_VERSION, type GameRef, type SourceVintage } from "./contract";
import { normalizeTeam } from "./stats";
import type { DefenseEvidence, MatchupSource, OffenseEvidence } from "./source";

export interface LeagueContext { teams: string[]; defenses: Map<string, DefenseEvidence> }
const leagueCache = new WeakMap<MatchupSource, LeagueContext>();
export function buildLeagueContext(src: MatchupSource): LeagueContext {
  const hit = leagueCache.get(src); if (hit) return hit;
  const defenses = new Map<string, DefenseEvidence>(); for (const t of src.defenseTeams()) { const d = src.defense(t); if (d) defenses.set(t, d); }
  const ctx = { teams: [...defenses.keys()].sort(), defenses }; leagueCache.set(src, ctx); return ctx;
}

export interface MatchupContext {
  game: GameRef; defense: DefenseEvidence | null; offense: OffenseEvidence | null; league: LeagueContext;
  vintage: SourceVintage[]; identities: ReturnType<MatchupSource["identities"]>; scoring_fingerprint: string | null;
  /** deterministic: same game + same source artifacts + same model ⇒ same id */
  context_identity: string;
}
export function buildMatchupContext(src: MatchupSource, g: { offense_team: string; defense_team: string; week: number | null; home?: boolean | null; scoring_fingerprint?: string | null }): MatchupContext {
  const league = buildLeagueContext(src); const ids = src.identities(); const vintage = src.vintages(); const dt = normalizeTeam(g.defense_team) ?? g.defense_team.toUpperCase(); const ot = normalizeTeam(g.offense_team) ?? g.offense_team.toUpperCase();
  const game: GameRef = { season: src.season(), week: g.week, offense_team: ot, defense_team: dt, home: g.home ?? null };
  return { game, defense: league.defenses.get(dt) ?? src.defense(dt), offense: src.offense(ot), league, vintage, identities: ids, scoring_fingerprint: g.scoring_fingerprint ?? null,
    context_identity: `mctx:${hashOf({ v: MATCHUP2_VERSION, game, ids, vintage: vintage.map((x) => [x.source, x.version, x.through_week, x.availability]), fp: g.scoring_fingerprint ?? null }, 16)}` };
}
