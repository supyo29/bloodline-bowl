/**
 * Phase 2 — Team-State builder.
 *
 * `buildLeagueManagementContext(leagueSlug)` performs I/O ONCE
 * (`buildCanonicalLeagueState` + the authoritative NFL schedule) inside a
 * `runInLeagueStateScope`, then derives EVERY manager's `TeamManagementState`
 * from that one immutable snapshot — N managers, one provider read.
 *
 * `buildTeamManagementState(snapshot, teamId, schedule)` is pure and synchronous
 * (the deterministic core the tests hit directly).
 */

import { readLeagueState } from "@/lib/canonical/read";
import { runInLeagueStateScope } from "@/lib/canonical/request-scope";
import { snapshotLineage } from "@/lib/canonical/snapshot-lineage";
import { buildRecommendationLineage } from "@/lib/canonical/lineage";
import { getScheduleProvider, type ScheduleProvider } from "@/lib/weekly/schedule/registry";
import type {
  CanonicalLeagueSnapshot,
  CanonicalPlayer,
  CanonicalRoster,
} from "@/lib/canonical/schema";
import {
  TEAM_STATE_VERSION,
  type LeagueManagementContext,
  type TeamManagementState,
  type TeamStatePlayer,
  type TeamStateScheduleFacts,
} from "./schema";
import { computePositionInventory } from "./inventory";
import { computeDepthPressure } from "./depth";
import { computeStructuralFlags } from "./flags";
import { isFlexSlot, leagueSlotKeys, maxSlotMatching, slotEligiblePositions, startablePositions } from "./slots";

const MAX_WEEK = 18;
const UPCOMING_BYE_LOOKAHEAD = 3;

/* --------------------------------------------------------------- schedule */

export interface ScheduleBundle {
  status: "READY" | "UNVERIFIED";
  source: string | null;
  /** week -> Set of NFL team abbrs on a schedule-verified bye that week. */
  byeTeamsByWeek: Map<number, Set<string>>;
  /** current-week: NFL team abbr -> opponent abbr. */
  opponentByTeam: Record<string, string>;
  currentWeek: number;
}

export async function loadScheduleBundle(
  season: number,
  week: number,
  provider: ScheduleProvider = getScheduleProvider(),
): Promise<ScheduleBundle> {
  const byeTeamsByWeek = new Map<number, Set<string>>();
  let opponentByTeam: Record<string, string> = {};
  let anyReady = false;
  let source: string | null = null;

  const weeks = [];
  for (let w = week; w <= Math.min(week + UPCOMING_BYE_LOOKAHEAD, MAX_WEEK); w += 1) weeks.push(w);

  for (const w of weeks) {
    let sched;
    try {
      sched = await provider.getWeekSchedule(season, w);
    } catch {
      continue;
    }
    if (sched.status === "READY") {
      anyReady = true;
      source = sched.source;
      byeTeamsByWeek.set(w, new Set(sched.teams_on_bye));
      if (w === week) opponentByTeam = { ...sched.opponent_by_team };
    }
  }

  return {
    status: anyReady ? "READY" : "UNVERIFIED",
    source,
    byeTeamsByWeek,
    opponentByTeam,
    currentWeek: week,
  };
}

/* --------------------------------------------------------- player summary */

function toTeamStatePlayer(
  p: CanonicalPlayer,
  slot: TeamStatePlayer["roster_slot"],
  label: string | null,
  schedule: ScheduleBundle,
): TeamStatePlayer {
  const team = (p.nfl_team ?? "").toUpperCase();
  const byeThisWeek =
    schedule.status === "READY" &&
    team.length > 0 &&
    (schedule.byeTeamsByWeek.get(schedule.currentWeek)?.has(team) ?? false);
  const opp = team ? schedule.opponentByTeam[team] ?? null : null;
  return {
    canonical_player_id: p.canonical_player_id,
    ids: {
      ...(p.identifiers.sleeper_id ? { sleeper_id: p.identifiers.sleeper_id } : {}),
      ...(p.identifiers.yahoo_id ? { yahoo_id: p.identifiers.yahoo_id } : {}),
      ...(p.identifiers.gsis_id ? { gsis_id: p.identifiers.gsis_id } : {}),
      ...(p.identifiers.pfr_id ? { pfr_id: p.identifiers.pfr_id } : {}),
      ...(p.identifiers.espn_id ? { espn_id: p.identifiers.espn_id } : {}),
    },
    full_name: p.full_name,
    position: p.position,
    eligible_positions: p.eligible_positions,
    nfl_team: p.nfl_team,
    is_team_defense: p.is_team_defense,
    status: p.status,
    injury_status: p.injury_status,
    identity_unresolved: p.resolution.method === "unresolved",
    roster_slot: slot,
    starting_slot_label: slot === "starter" ? label : null,
    nfl_opponent: byeThisWeek ? null : opp,
    on_bye_this_week: byeThisWeek,
  };
}

/* -------------------------------------------------- one team's state (pure) */

export function buildTeamManagementState(
  snapshot: CanonicalLeagueSnapshot,
  canonicalTeamId: string,
  schedule: ScheduleBundle,
): TeamManagementState {
  const team = snapshot.teams.find((t) => t.canonical_team_id === canonicalTeamId);
  if (!team) throw new Error(`team ${canonicalTeamId} not in snapshot`);
  const roster: CanonicalRoster =
    snapshot.rosters.find((r) => r.canonical_team_id === canonicalTeamId) ?? {
      canonical_roster_id: canonicalTeamId.replace(/^team:/, "roster:"),
      canonical_team_id: canonicalTeamId,
      slots: [],
      starters: [],
      bench: [],
      ir: [],
      taxi: [],
      all_players: [],
      provenance: team.provenance,
    };
  const managerById = new Map(snapshot.managers.map((m) => [m.canonical_manager_id, m]));
  const owner = team.canonical_manager_ids[0] ? managerById.get(team.canonical_manager_ids[0]) : undefined;
  const playerById = new Map(snapshot.players.map((p) => [p.canonical_player_id, p]));
  const lin = snapshotLineage(snapshot);
  const rs = snapshot.league.roster_settings;

  // ---- roster -> TeamStatePlayer[] with slot + label ----
  const labelByPlayer = new Map<string, string>();
  for (const s of roster.slots) {
    if (s.canonical_player_id && s.slot !== "BN" && s.slot !== "IR" && s.slot !== "TAXI") {
      labelByPlayer.set(s.canonical_player_id, s.slot);
    }
  }
  const slotOf = (id: string): TeamStatePlayer["roster_slot"] =>
    roster.starters.includes(id) ? "starter"
      : roster.ir.includes(id) ? "ir"
        : roster.taxi.includes(id) ? "taxi"
          : "bench";

  const players: TeamStatePlayer[] = roster.all_players
    .map((id) => playerById.get(id))
    .filter((p): p is CanonicalPlayer => Boolean(p))
    .map((p) => toTeamStatePlayer(p, slotOf(p.canonical_player_id), labelByPlayer.get(p.canonical_player_id) ?? null, schedule));

  // ---- roster structural facts ----
  const emptyStarterSlots = roster.slots
    .filter((s) => s.is_empty && s.slot !== "BN" && s.slot !== "IR" && s.slot !== "TAXI")
    .map((s) => s.slot);
  const activeCapacity = rs.starting_slots.length + rs.bench_slots;
  const activeCount = players.filter((p) => p.roster_slot === "starter" || p.roster_slot === "bench").length;
  const rosterSizeLimit = rs.starting_slots.length + rs.bench_slots + rs.ir_slots + rs.taxi_slots || null;

  const activeCandidates = players
    .filter((p) => p.roster_slot === "starter" || p.roster_slot === "bench")
    .map((p) => ({ id: p.canonical_player_id, positions: startablePositions(p) }));
  const legalMatch = maxSlotMatching(rs.starting_slots, activeCandidates);

  // ---- schedule facts ----
  const startersOnBye = players
    .filter((p) => p.roster_slot === "starter" && p.on_bye_this_week)
    .map((p) => p.canonical_player_id);
  const opponentByPlayer: Record<string, string | null> = {};
  for (const p of players) opponentByPlayer[p.canonical_player_id] = p.nfl_opponent;
  const scheduleFacts: TeamStateScheduleFacts = {
    status: schedule.status,
    schedule_source: schedule.source,
    teams_on_bye_this_week:
      schedule.status === "READY" ? [...(schedule.byeTeamsByWeek.get(schedule.currentWeek) ?? [])].sort() : [],
    opponent_by_player: opponentByPlayer,
    starters_on_bye: startersOnBye,
  };

  // ---- remaining bye weeks per player (for SHARED_BYE_WEEK) ----
  const byeWeeksByPlayer = new Map<string, number[]>();
  if (schedule.status === "READY") {
    for (const p of players) {
      const t = (p.nfl_team ?? "").toUpperCase();
      if (!t) continue;
      const ws: number[] = [];
      for (const [w, teams] of schedule.byeTeamsByWeek) if (teams.has(t)) ws.push(w);
      if (ws.length) byeWeeksByPlayer.set(p.canonical_player_id, ws.sort((a, b) => a - b));
    }
  }

  // ---- inventory / depth / flags ----
  const position_inventory = computePositionInventory(rs.starting_slots, players, roster);
  const depth_pressure = computeDepthPressure(rs.starting_slots, players, roster);
  const structural_flags = computeStructuralFlags({
    startingSlots: rs.starting_slots,
    players,
    roster,
    activeCapacity: rosterSizeLimit != null ? activeCapacity : null,
    scheduleReady: schedule.status === "READY",
    startersOnBye,
    byeWeeksByPlayer,
  });

  // ---- matchup ----
  const myMatchup = snapshot.matchups.find((m) =>
    m.sides.some((s) => s.canonical_team_id === canonicalTeamId),
  );
  const oppSide = myMatchup?.sides.find((s) => s.canonical_team_id !== canonicalTeamId) ?? null;
  const oppTeam = oppSide ? snapshot.teams.find((t) => t.canonical_team_id === oppSide.canonical_team_id) : null;
  const matchup = myMatchup
    ? {
        matchup_id: myMatchup.canonical_matchup_id,
        week: myMatchup.week,
        status: myMatchup.status,
        opponent_team_id: oppTeam?.canonical_team_id ?? null,
        opponent_roster_id: oppTeam ? Number(oppTeam.provider_team_id) : null,
        opponent_manager_ids: oppSide?.canonical_manager_ids ?? [],
        is_bye: oppSide == null,
      }
    : null;

  const standing = snapshot.standings.find((s) => s.canonical_team_id === canonicalTeamId) ?? null;

  const flexSlots = [...new Set(rs.starting_slots.filter(isFlexSlot))].map((label) => ({
    label,
    eligible_positions: slotEligiblePositions(label),
    count: rs.starting_slots.filter((s) => s === label).length,
  }));

  return {
    version: TEAM_STATE_VERSION,
    lineage: buildRecommendationLineage(lin, { team_state: TEAM_STATE_VERSION }, []),
    identity: {
      league_slug: snapshot.league.league_slug,
      league_snapshot_id: lin.league_snapshot_id,
      provider: snapshot.league.provenance.provider,
      season: snapshot.season,
      week: snapshot.week,
      canonical_manager_id: owner?.canonical_manager_id ?? (team.canonical_manager_ids[0] ?? ""),
      canonical_team_id: canonicalTeamId,
      roster_id: Number(team.provider_team_id),
      manager_slug: owner?.manager_slug ?? "",
      manager_display_name: owner?.display_name ?? null,
      team_name: team.team_name,
      provider_owner_id: team.provider_owner_id ?? null,
      is_co_managed: team.canonical_manager_ids.length > 1,
      is_vacant: team.canonical_manager_ids.length === 0 && team.provider_owner_id == null,
    },
    league: {
      scoring_fingerprint: lin.scoring_fingerprint,
      roster_fingerprint: lin.roster_fingerprint,
      team_count: snapshot.league.team_count,
      status: snapshot.league.status,
      starting_slots: rs.starting_slots,
      slot_requirements: rs.slot_requirements,
      bench_slots: rs.bench_slots,
      ir_slots: rs.ir_slots,
      taxi_slots: rs.taxi_slots,
      roster_size_limit: rosterSizeLimit,
      flex_slots: flexSlots,
      playoff: {
        playoff_team_count: snapshot.league.playoff_settings.playoff_team_count,
        playoff_start_week: snapshot.league.playoff_settings.playoff_start_week,
        championship_week: snapshot.league.playoff_settings.championship_week,
      },
    },
    roster: {
      players,
      starters: roster.starters,
      bench: roster.bench,
      ir: roster.ir,
      taxi: roster.taxi,
      all_players: roster.all_players,
      unfilled_starter_slots: [...new Set(emptyStarterSlots)],
      open_active_slots: rosterSizeLimit != null ? activeCapacity - activeCount : null,
      can_field_legal_lineup: legalMatch.unfilled.length === 0,
    },
    standing: standing
      ? {
          rank: standing.rank,
          wins: standing.wins,
          losses: standing.losses,
          ties: standing.ties,
          points_for: standing.points_for,
          points_against: standing.points_against,
          games_played: standing.games_played,
          playoff_seed: standing.playoff_seed,
        }
      : null,
    position_inventory,
    structural_flags,
    depth_pressure,
    matchup,
    schedule_facts: scheduleFacts,
    football_context: null,
  };
}

/* ---------------------------------------------- league-level (does the I/O) */

export interface BuildLeagueManagementOptions {
  providerOverride?: import("@/lib/providers/types").FantasyProvider;
  scheduleOverride?: ScheduleProvider;
  /** pre-built snapshot (skips the canonical read). */
  snapshotOverride?: CanonicalLeagueSnapshot;
}

export interface LeagueManagementResult {
  ok: boolean;
  status: number;
  code?: string;
  detail?: string;
  context: LeagueManagementContext | null;
  /** Stage F — where the underlying snapshot came from. */
  state_source?: "PUBLISHED_SNAPSHOT" | "LEGACY_LIVE_PATH";
  fallback_reason?: string | null;
}

export async function buildLeagueManagementContext(
  leagueSlug: string,
  options: BuildLeagueManagementOptions = {},
): Promise<LeagueManagementResult> {
  return runInLeagueStateScope(async () => {
    let snapshot = options.snapshotOverride ?? null;
    let stateSource: LeagueManagementResult["state_source"] = options.snapshotOverride
      ? "LEGACY_LIVE_PATH"
      : undefined;
    let fallbackReason: string | null = null;
    if (!snapshot) {
      const state = await readLeagueState(leagueSlug, {
        wave: 2,
        providerOverride: options.providerOverride,
      });
      stateSource = state.provenance.state_source;
      fallbackReason = state.provenance.fallback_reason;
      if (!state.snapshot) {
        return { ok: false, status: state.status, code: state.code, detail: state.detail, context: null };
      }
      if (state.snapshot.live_provider_status === "PROVIDER_ERROR" || state.snapshot.league.team_count === 0) {
        return {
          ok: false,
          status: 502,
          code: state.code ?? "provider_unavailable",
          detail: state.detail ?? "Canonical league state unavailable.",
          context: null,
        };
      }
      snapshot = state.snapshot;
    }

    const warnings: string[] = [];
    const schedule = await loadScheduleBundle(
      snapshot.season,
      snapshot.week && snapshot.week > 0 ? snapshot.week : 1,
      options.scheduleOverride ?? getScheduleProvider(),
    );
    if (schedule.status !== "READY") {
      warnings.push("No authoritative NFL schedule this run — bye / opponent facts are UNVERIFIED.");
    }

    const teams = [...snapshot.teams]
      .sort((a, b) => Number(a.provider_team_id) - Number(b.provider_team_id))
      .map((t) => buildTeamManagementState(snapshot!, t.canonical_team_id, schedule));

    const manager_index: Record<string, number> = {};
    const roster_index: Record<number, number> = {};
    teams.forEach((ts, i) => {
      if (ts.identity.canonical_manager_id) manager_index[ts.identity.canonical_manager_id] = i;
      roster_index[ts.identity.roster_id] = i;
    });

    const owned_by_team: Record<string, string> = {};
    for (const r of snapshot.rosters) for (const id of r.all_players) owned_by_team[id] = r.canonical_team_id;

    const matchup_pairs: [number, number | null][] = [];
    const seen = new Set<number>();
    for (const ts of teams) {
      if (seen.has(ts.identity.roster_id)) continue;
      const opp = ts.matchup?.opponent_roster_id ?? null;
      matchup_pairs.push([ts.identity.roster_id, opp]);
      seen.add(ts.identity.roster_id);
      if (opp != null) seen.add(opp);
    }

    const keys = leagueSlotKeys(snapshot.league.roster_settings.starting_slots);
    const league_position_summary = keys.map((slot_key) => {
      let total_active = 0;
      let teams_broken = 0;
      let teams_bare = 0;
      let teams_thin = 0;
      let teams_surplus = 0;
      for (const ts of teams) {
        const entry = ts.depth_pressure.by_key.find((e) => e.slot_key === slot_key);
        if (!entry) continue;
        total_active += entry.active_eligible;
        if (entry.level === "broken") teams_broken += 1;
        else if (entry.level === "bare") teams_bare += 1;
        else if (entry.level === "thin") teams_thin += 1;
        if (entry.structural_surplus) teams_surplus += 1;
      }
      return { slot_key, total_active, teams_broken, teams_bare, teams_thin, teams_surplus };
    });

    const lin = snapshotLineage(snapshot);
    const context: LeagueManagementContext = {
      version: TEAM_STATE_VERSION,
      lineage: buildRecommendationLineage(lin, { team_state: TEAM_STATE_VERSION }, []),
      league: {
        ...teams[0]!.league,
        league_slug: snapshot.league.league_slug,
        league_snapshot_id: lin.league_snapshot_id,
        season: snapshot.season,
        week: snapshot.week,
      },
      teams,
      manager_index,
      roster_index,
      ownership: {
        owned_by_team,
        league_roster_ids: teams.map((t) => t.identity.roster_id),
        free_agent_pool: "NOT_MATERIALIZED",
      },
      matchup_pairs,
      league_position_summary,
      warnings,
    };
    return { ok: true, status: 200, context, state_source: stateSource, fallback_reason: fallbackReason };
  });
}
