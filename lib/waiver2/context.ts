/**
 * Phase 4 (Checkpoint B) — the canonical WAIVER EVALUATION CONTEXT.
 *
 * Built ONCE per request from already-retrieved inputs; every downstream computation reads from it. It owns the caches
 * (Role profile per player, OPP scenario per team+absence set), the league-scoring opportunity->points conversion (the
 * canonical scoring engine, not a private interpretation), the baseline optimal lineup, and the replacement pools.
 * Counters prove nothing is retrieved twice. The only clock is `weekly.generated_at` (no wall-clock reads anywhere in the engine).
 */
import { scoreWeeklyLine } from "@/lib/weekly/scoring";
import { buildOptimalLineup, isEligible, type LineupResult } from "@/lib/weekly/lineup";
import { scoringFingerprint } from "@/lib/canonical/scoring-fingerprint";
import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { WeeklyProjection } from "@/lib/weekly/schema";
import type { PlayerRoleProfile } from "@/lib/player-role-intelligence/schema";
import type { OpportunityPropagationScenarioResult } from "@/lib/opportunity-propagation-intelligence/schema";
import { PARAMS } from "./config";
import type { ReplacementView, RetrievalCounters, TeamView, WaiverInput } from "./types";

const BASE = ["QB", "RB", "WR", "TE", "K", "DEF"];
export const round2 = (v: number) => Math.round(v * 100) / 100;
export const round3 = (v: number) => Math.round(v * 1000) / 1000;

export interface WaiverContext {
  input: WaiverInput; now: string; week: number; lastWeek: number; weeksRemaining: number;
  myTeam: TeamView; players: Map<string, CanonicalPlayer>; counters: RetrievalCounters;
  proj: (id: string) => WeeklyProjection | null;
  role: (p: CanonicalPlayer) => PlayerRoleProfile | null;
  opp: (team: string, unavailableGsis: string[]) => OpportunityPropagationScenarioResult | null;
  /** league-scoring points for one typical target / carry (canonical scoring engine) */
  ppo: { target: number; carry: number; unscored_keys: string[] };
  scoring_fingerprint: string | null;
  baseline: LineupResult; startersByPlayer: Map<string, { slot: string; points: number | null }>;
  activeIds: string[]; myPlayerIds: Set<string>;
  marginalStarter: (p: CanonicalPlayer) => number | null;
  replacement: Record<string, ReplacementView>;
  byeWeek: (p: CanonicalPlayer) => number | null;
}

export function buildWaiverContext(input: WaiverInput): WaiverContext {
  const w = input.weekly;
  const counters: RetrievalCounters = { role_lookups: 0, role_cache_hits: 0, opp_calls: 0, opp_cache_hits: 0, fi_calls: 0, lineup_builds: 0, assets_built: 0, candidates: 0, droppables: 0 };
  const myTeam = input.teams.find((t) => t.team_id === input.my_team_id);
  if (!myTeam) throw new Error(`manager team ${input.my_team_id} is not in the league team list`);
  const players = new Map<string, CanonicalPlayer>();
  for (const a of w.availability.players) players.set(a.canonical_player_id, a.player);
  for (const p of w.all_rostered) players.set(p.canonical_player_id, p);
  for (const a of input.pool.candidates) players.set(a.canonical_player_id, a.player);

  const proj = (id: string) => w.projections.by_player.get(id) ?? null;
  const roleCache = new Map<string, PlayerRoleProfile | null>();
  const role = (p: CanonicalPlayer): PlayerRoleProfile | null => {
    if (!input.role) return null;
    if (roleCache.has(p.canonical_player_id)) { counters.role_cache_hits += 1; return roleCache.get(p.canonical_player_id)!; }
    counters.role_lookups += 1; const r = input.role.profile(p); roleCache.set(p.canonical_player_id, r); return r;
  };
  const oppCache = new Map<string, OpportunityPropagationScenarioResult | null>();
  const opp = (team: string, un: string[]) => {
    if (!input.opp) return null; const k = `${team}|${[...un].sort().join("+")}`;
    if (oppCache.has(k)) { counters.opp_cache_hits += 1; return oppCache.get(k)!; }
    counters.opp_calls += 1; const r = input.opp(team, un); oppCache.set(k, r); return r;
  };

  // league-scoring value of one typical opportunity, through the CANONICAL scoring engine
  const y = PARAMS.yield_per_opportunity.value;
  const t = scoreWeeklyLine(y.target!, w.league.raw_scoring); const c = scoreWeeklyLine(y.carry!, w.league.raw_scoring);
  const ppo = { target: t.points, carry: c.points, unscored_keys: [...new Set([...t.unscored_keys, ...c.unscored_keys])] };

  const myPlayers = new Map<string, CanonicalPlayer>(w.all_rostered.map((p) => [p.canonical_player_id, p]));
  counters.lineup_builds += 1;
  const baseline = buildOptimalLineup({ week: w.league.week, roster: w.roster, constraints: w.league.roster_constraints, players: myPlayers, projections: w.projections });
  const startersByPlayer = new Map<string, { slot: string; points: number | null }>();
  for (const s of baseline.slots) if (s.recommended_player_id) startersByPlayer.set(s.recommended_player_id, { slot: s.slot, points: s.recommended_projected });
  const irSet = new Set(w.roster.ir), taxiSet = new Set(w.roster.taxi);
  const activeIds = w.roster.all_players.filter((id) => !irSet.has(id) && !taxiSet.has(id));

  const marginalStarter = (p: CanonicalPlayer): number | null => {
    let m: number | null = null;
    for (const s of baseline.slots) {
      if (!s.recommended_player_id || !isEligible(s.slot, p)) continue;
      const pts = s.recommended_projected; if (pts == null) continue;
      m = m == null ? pts : Math.min(m, pts);
    }
    return m;
  };

  // replacement pools: FA nth-best (consumed from the weekly replacement framework), rostered replacement, starter baseline, scarcity
  const replacement: Record<string, ReplacementView> = {};
  for (const pos of BASE) {
    const lvl = w.replacement.by_position[pos];
    const mine = activeIds.map((id) => ({ id, p: myPlayers.get(id)!, pts: proj(id)?.projected_points ?? null })).filter((x) => x.p && x.p.position === pos && x.pts != null).sort((a, b) => (b.pts as number) - (a.pts as number));
    const starterPts = mine.filter((x) => startersByPlayer.has(x.id)).map((x) => x.pts as number);
    const benchPts = mine.filter((x) => !startersByPlayer.has(x.id)).map((x) => x.pts as number);
    const starter_baseline = starterPts.length ? Math.min(...starterPts) : null;
    const faPts = input.pool.candidates.map((a) => proj(a.canonical_player_id)).filter((x) => x && x.position === pos && x.projected_points != null).map((x) => x!.projected_points as number).sort((a, b) => b - a);
    const useful = starter_baseline == null ? faPts.length : faPts.filter((v) => v >= starter_baseline).length;
    replacement[pos] = {
      position: pos, free_agent_replacement: lvl?.replacement_points ?? null, free_agent_depth: faPts.length,
      rostered_replacement: benchPts.length ? benchPts[0]! : null, starter_baseline, bench_replacement: benchPts.length ? benchPts[0]! : null,
      scarcity: round3(1 / (1 + useful)), basis: lvl ? `FA ${lvl.basis} (rank ${lvl.derived_from_rank ?? "?"}, n=${lvl.sample_size}); ${useful} free agent(s) at or above my ${pos} starter baseline` : "no free-agent replacement level",
    };
  }
  const byeWeek = (p: CanonicalPlayer): number | null => (p.nfl_team && input.schedule ? input.schedule.bye_week(p.nfl_team) : (w.byes.by_player[p.canonical_player_id] ?? null));
  return {
    input, now: w.generated_at, week: w.league.week, lastWeek: PARAMS.season_last_week.value, weeksRemaining: Math.max(1, PARAMS.season_last_week.value - w.league.week),
    myTeam, players, counters, proj, role, opp, ppo, scoring_fingerprint: w.lineage?.snapshot?.scoring_fingerprint ?? scoringFingerprint(w.league.raw_scoring),
    baseline, startersByPlayer, activeIds, myPlayerIds: new Set(w.roster.all_players), marginalStarter, replacement, byeWeek,
  };
}
