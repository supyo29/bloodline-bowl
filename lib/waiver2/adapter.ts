/**
 * Phase 4 — the ADAPTER from real canonical league state to a `WaiverInput`. It reads league state ONCE, threads the same
 * immutable snapshot into the weekly context (the single-read path the trade engine uses), and consumes already-certified
 * evidence: Role (profiles), Football Intelligence (opponent readings, explanatory), Opportunity Propagation (scenario
 * evaluator) and the NFL schedule. Nothing is written; nothing is submitted.
 */
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { buildWeeklyTeamContext } from "@/lib/weekly/context";
import { loadFootballIntelligence } from "@/lib/football-intel/read";
import { loadRoleOpportunitySnapshot } from "@/lib/player-role-intelligence/read";
import { evaluateOpportunityPropagationScenario } from "@/lib/opportunity-propagation-intelligence/scenario";
import { loadFullSchedule } from "@/lib/schedule-planning/schedule";
import type { FiEvidence, FiOpponentReading, RoleEvidence, ScheduleEvidence, TeamView, WaiverInput } from "./types";
import { PARAMS } from "./config";
import { loadMarketSnapshot } from "@/lib/market-state/load";
import { waiverPoolFromMarket } from "./market-pool";

export type AdaptResult = { ok: true; input: WaiverInput } | { ok: false; status: number; code: string; detail: string };

export async function buildWaiverInputForManager(leagueSlug: string, managerSlug: string, opts: { week?: number } = {}): Promise<AdaptResult> {
  const state = await buildCanonicalLeagueState(leagueSlug, { includeMatchups: true, includeRecentTransactions: true, reportPersistence: false });
  if (!state.snapshot) return { ok: false, status: state.status, code: state.code ?? "league_state_unavailable", detail: state.detail ?? "league state unavailable" };
  const snap = state.snapshot;
  const res = await buildWeeklyTeamContext(leagueSlug, managerSlug, { week: opts.week, snapshotOverride: snap });
  if (!res.context) return { ok: false, status: res.status, code: res.code ?? "weekly_context_unavailable", detail: res.detail ?? "weekly context unavailable" };
  const weekly = res.context;

  const slugById = new Map(snap.managers.map((m) => [m.canonical_manager_id, m.manager_slug]));
  const teams: TeamView[] = snap.teams.map((t) => {
    const r = snap.rosters.find((x) => x.canonical_team_id === t.canonical_team_id); const off = new Set([...(r?.ir ?? []), ...(r?.taxi ?? [])]);
    return { team_id: t.canonical_team_id, name: t.team_name, manager_ids: t.canonical_manager_ids.map((id) => slugById.get(id) ?? id), active_player_ids: (r?.all_players ?? []).filter((id) => !off.has(id)), faab_remaining: t.faab_remaining, waiver_priority: t.waiver_priority };
  });
  const myTeamId = weekly.fantasy_team.canonical_team_id;

  const roleSnap = loadRoleOpportunitySnapshot();
  const role: RoleEvidence | null = roleSnap ? { version: roleSnap.manifest.role_opportunity_version, through_week: roleSnap.manifest.through_week, season: roleSnap.manifest.season ?? null, profile: (p) => roleSnap.getPlayerRoleProfile({ gsis_id: p.identifiers.gsis_id ?? null, sleeper_id: p.identifiers.sleeper_id ?? null }) } : null;

  const fiSnap = loadFootballIntelligence();
  const fi: FiEvidence | null = fiSnap ? {
    version: fiSnap.manifest.football_intelligence_version, through_week: fiSnap.manifest.through_week, week_state: (fiSnap.manifest as unknown as { week_completion?: { week_state?: string } }).week_completion?.week_state ?? null,
    defense: (team): FiOpponentReading[] => { const t = fiSnap.team(team); if (!t) return []; return Object.entries(t.defense).map(([metric, r]) => ({ team, metric, league_percentile: (r as unknown as { league_percentile?: number | null }).league_percentile ?? null, predictive_status: String((r as unknown as { predictive_status?: string }).predictive_status ?? "UNKNOWN"), modeled: (r as unknown as { modeled?: number | null }).modeled ?? null })); },
  } : null;

  const opp = roleSnap ? (team: string, unavailable: string[]) => evaluateOpportunityPropagationScenario({ team, season: weekly.league.season, week: weekly.league.week, unavailable_player_ids: unavailable, scenario_type: "FULL_GAME_NONPARTICIPATION" }) : null;

  let schedule: ScheduleEvidence | null = null;
  try {
    const last = PARAMS.season_last_week.value; const fs = await loadFullSchedule(weekly.league.season, weekly.league.week, last);
    const byes = new Map<string, number>(); for (const [w, set] of fs.byeByWeek) for (const t of set) if (!byes.has(t)) byes.set(t, w);
    schedule = { opponent: (t, w) => fs.opponentByWeek.get(w)?.[t] ?? null, bye_week: (t) => byes.get(t) ?? null, last_week: last };
  } catch { schedule = null; }

  // Phase 4.5: the pool and its readiness come from the ONE canonical market snapshot. Waiver 2.0 no longer interprets ownership.
  const market = await loadMarketSnapshot(leagueSlug, { week: weekly.league.week, scoring_fingerprint: snap.league.scoring_fingerprint ?? null, source_snapshot_id: (weekly.lineage?.snapshot as { league_snapshot_id?: string } | undefined)?.league_snapshot_id ?? null });
  const pool = waiverPoolFromMarket(market, weekly);

  return { ok: true, input: {
    weekly, teams, my_team_id: myTeamId, transactions: snap.recent_transactions,
    pool,
    role, fi, opp, schedule,
  } };
}
