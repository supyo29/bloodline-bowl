/**
 * Manager-context service — GENERIC. No per-manager branches.
 *
 * `buildManagerContext(leagueSlug, managerSlug)` resolves ANY manager slug
 * against the canonical league state and returns a manager-centric view with
 * enough normalized context for future lineup / trade / waiver / matchup
 * engines. It does NOT run those engines.
 *
 * Resolution order for the slug:
 *   1. exact canonical `manager_slug`
 *   2. registered manager identity (`lib/leagues/managers.ts`) -> provider_user_id
 *   3. case-insensitive `provider_username`
 *   4. otherwise -> explicit `manager_not_in_league` (never a fallback pick)
 */

import { buildCanonicalLeagueState, type BuildStateOptions } from "./state";
import { findRegisteredManager } from "@/lib/leagues/managers";
import type {
  CanonicalFantasyTeam,
  CanonicalLeagueSnapshot,
  CanonicalManager,
  CanonicalMatchup,
  CanonicalPlayer,
  CanonicalRoster,
  CanonicalStanding,
  CanonicalTransaction,
  CanonicalWarning,
} from "./schema";

export interface ManagerContextResult {
  ok: boolean;
  status: number;
  code?: string;
  detail?: string;
  context: ManagerContext | null;
}

export interface ManagerContext {
  league: {
    league_slug: string;
    name: string;
    provider: string;
    season: number;
    week: number;
    scoring_rules: CanonicalLeagueSnapshot["league"]["scoring_rules"];
    roster_settings: CanonicalLeagueSnapshot["league"]["roster_settings"];
    waiver_settings: CanonicalLeagueSnapshot["league"]["waiver_settings"];
    playoff_settings: CanonicalLeagueSnapshot["league"]["playoff_settings"];
  };
  manager: CanonicalManager;
  team: CanonicalFantasyTeam;
  roster: {
    starters: CanonicalPlayer[];
    bench: CanonicalPlayer[];
    ir: CanonicalPlayer[];
    taxi: CanonicalPlayer[];
    all: CanonicalPlayer[];
    position_counts: Record<string, number>;
    empty_starting_slots: string[];
  };
  standing: CanonicalStanding | null;
  standings_context: {
    rank: number | null;
    of: number;
    games_back_of_first: number | null;
  };
  upcoming_matchup: {
    week: number;
    opponent_team_id: string | null;
    opponent_manager_ids: string[];
    matchup: CanonicalMatchup | null;
  } | null;
  waiver_context: {
    faab_remaining: number | null;
    waiver_priority: number | null;
    budget: number | null;
  };
  recent_transactions: CanonicalTransaction[];
  bye_week_notes: string[];
  warnings: CanonicalWarning[];
}

export async function buildManagerContext(
  leagueSlug: string,
  managerSlug: string,
  options: BuildStateOptions = {},
): Promise<ManagerContextResult> {
  const trimmed = managerSlug?.trim();
  if (!trimmed) {
    return { ok: false, status: 400, code: "manager_slug_required", detail: "A manager slug is required.", context: null };
  }

  const state = await buildCanonicalLeagueState(leagueSlug, options);
  if (!state.ok || !state.snapshot) {
    return {
      ok: false,
      status: state.status,
      code: state.code ?? "league_state_unavailable",
      detail: state.detail,
      context: null,
    };
  }
  const snap = state.snapshot;

  const manager = resolveManager(snap.managers, trimmed);
  if (!manager) {
    return {
      ok: false,
      status: 404,
      code: "manager_not_in_league",
      detail:
        `Manager "${trimmed}" is not a member of league "${leagueSlug}". ` +
        `This combination is rejected rather than falling back to another manager. ` +
        `Known managers: ${snap.managers.map((m) => m.manager_slug).join(", ")}.`,
      context: null,
    };
  }

  const team = snap.teams.find((t) => t.canonical_manager_ids.includes(manager.canonical_manager_id));
  if (!team) {
    return {
      ok: false,
      status: 404,
      code: "manager_has_no_team",
      detail: `Manager "${manager.manager_slug}" resolved but owns no team in "${leagueSlug}".`,
      context: null,
    };
  }

  const roster = snap.rosters.find((r) => r.canonical_team_id === team.canonical_team_id) ?? null;
  const playerById = new Map(snap.players.map((p) => [p.canonical_player_id, p]));
  const lookup = (ids: string[]): CanonicalPlayer[] =>
    ids.map((id) => playerById.get(id)).filter((p): p is CanonicalPlayer => Boolean(p));

  const starters = lookup(roster?.starters ?? []);
  const bench = lookup(roster?.bench ?? []);
  const ir = lookup(roster?.ir ?? []);
  const taxi = lookup(roster?.taxi ?? []);
  const all = lookup(roster?.all_players ?? []);

  const positionCounts: Record<string, number> = {};
  for (const p of all) positionCounts[p.position] = (positionCounts[p.position] ?? 0) + 1;

  const emptySlots = (roster?.slots ?? [])
    .filter((s) => s.is_empty)
    .map((s) => s.slot);

  const standing = snap.standings.find((s) => s.canonical_team_id === team.canonical_team_id) ?? null;
  const first = snap.standings.find((s) => s.rank === 1) ?? null;
  const gamesBack =
    standing && first
      ? Math.round(((first.wins - standing.wins) + (standing.losses - first.losses)) / 2 * 10) / 10
      : null;

  const upcoming = buildUpcomingMatchup(snap, team.canonical_team_id);

  const recent = snap.recent_transactions.filter((t) =>
    t.canonical_team_ids.includes(team.canonical_team_id),
  );

  const byeNotes = buildByeNotes(all);

  const context: ManagerContext = {
    league: {
      league_slug: snap.league.league_slug,
      name: snap.league.name,
      provider: snap.league.provenance.provider,
      season: snap.season,
      week: snap.week,
      scoring_rules: snap.league.scoring_rules,
      roster_settings: snap.league.roster_settings,
      waiver_settings: snap.league.waiver_settings,
      playoff_settings: snap.league.playoff_settings,
    },
    manager,
    team,
    roster: {
      starters,
      bench,
      ir,
      taxi,
      all,
      position_counts: positionCounts,
      empty_starting_slots: emptySlots,
    },
    standing,
    standings_context: {
      rank: standing?.rank ?? null,
      of: snap.standings.length,
      games_back_of_first: gamesBack,
    },
    upcoming_matchup: upcoming,
    waiver_context: {
      faab_remaining: team.faab_remaining,
      waiver_priority: team.waiver_priority,
      budget: snap.league.waiver_settings.faab_budget,
    },
    recent_transactions: recent,
    bye_week_notes: byeNotes,
    warnings: snap.warnings,
  };

  return { ok: true, status: 200, context };
}

function resolveManager(managers: CanonicalManager[], slug: string): CanonicalManager | null {
  const needle = slug.toLowerCase();
  const bySlug = managers.find((m) => m.manager_slug.toLowerCase() === needle);
  if (bySlug) return bySlug;

  const registered = findRegisteredManager(slug);
  if (registered) {
    const byUserId = managers.find((m) => m.provider_user_id === registered.sleeper_user_id);
    if (byUserId) return byUserId;
    const byRegisteredSlug = managers.find(
      (m) => m.manager_slug.toLowerCase() === registered.manager_slug.toLowerCase(),
    );
    if (byRegisteredSlug) return byRegisteredSlug;
  }

  const byUsername = managers.find(
    (m) => (m.provider_username ?? "").toLowerCase() === needle,
  );
  return byUsername ?? null;
}

function buildUpcomingMatchup(
  snap: CanonicalLeagueSnapshot,
  teamId: string,
): ManagerContext["upcoming_matchup"] {
  const mine = snap.matchups.find((m) => m.sides.some((s) => s.canonical_team_id === teamId));
  if (!mine) return snap.week > 0 ? { week: snap.week, opponent_team_id: null, opponent_manager_ids: [], matchup: null } : null;
  const opp = mine.sides.find((s) => s.canonical_team_id !== teamId) ?? null;
  return {
    week: mine.week,
    opponent_team_id: opp?.canonical_team_id ?? null,
    opponent_manager_ids: opp?.canonical_manager_ids ?? [],
    matchup: mine,
  };
}

/** NFL 2026 bye weeks are not modeled in the foundation phase — flag, don't guess. */
function buildByeNotes(_players: CanonicalPlayer[]): string[] {
  return [
    "Bye-week detection requires an NFL schedule source, which is deferred to the schedule-analysis phase.",
  ];
}
