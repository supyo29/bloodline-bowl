/**
 * Synthetic multi-roster trade fixtures — no network.
 *
 * Unlike `weeklyContext` (one manager + optional opponent), this builds a full
 * N-roster canonical snapshot so the replacement frontier is computed from the
 * REAL free-agent pool — every participant's rostered players are
 * `rostered_other`, never mistaken for free agents.
 */

import { batch, player, proj, roster, STD_CONSTRAINTS } from "./weekly";
import { buildLeagueAvailability } from "../../lib/weekly/availability";
import { computeWeeklyReplacement } from "../../lib/weekly/replacement";
import { CANONICAL_SCHEMA_VERSION } from "../../lib/canonical/schema";
import type {
  CanonicalLeagueSnapshot,
  CanonicalPlayer,
  CanonicalRoster,
} from "../../lib/canonical/schema";
import type { RosterConstraints, WeeklyProjection } from "../../lib/weekly/schema";
import type { TradeEvaluationInput } from "../../lib/trades/evaluate";
import type { NormalizedProposal, TradeParticipantInput } from "../../lib/trades/schema";
import { resolveTradeConfig, type PartialTradeConfig } from "../../lib/trades/config";
import { validateTrade, type TradeResolution } from "../../lib/trades/validate";

export interface TeamSpec {
  slug: string;
  starters: string[];
  bench?: string[];
  ir?: string[];
}

export interface TradeFixtureSpec {
  teams: TeamSpec[];
  players: CanonicalPlayer[];
  projections: WeeklyProjection[];
  freeAgents?: CanonicalPlayer[];
  faProjections?: WeeklyProjection[];
  constraints?: RosterConstraints;
  teamCount?: number;
  transfers: NormalizedProposal["transfers"];
  config?: PartialTradeConfig;
}

export interface TradeFixture {
  input: TradeEvaluationInput;
  rosters: Map<string, CanonicalRoster>;
  ownership: Map<string, string>;
  playerPositions: Map<string, string[]>;
  /** build a TradeResolution for validateTrade with the given participant/transfer aliases */
  resolution: (
    participants: Array<{ input: string; slug: string | null }>,
    transfers: Array<{ from: string; to: string; pid: string; cid: string | null }>,
  ) => TradeResolution;
}

const managerId = (slug: string) => `manager:test-league:${slug}`;
const teamId = (slug: string) => `team:test-league:${slug}`;

/**
 * A standard, legal 9-slot team (QB/RB/RB/WR/WR/TE/FLEX/K/DEF) with per-team
 * unique starter ids so the same player is NEVER on two rosters. Locked starters
 * are strong enough to hold their base slots; the FLEX occupant and any bench
 * are caller-supplied.
 */
export interface StdTeamPiece {
  id: string;
  pos: import("../../lib/canonical/schema").CanonicalPosition;
  pts: number;
  eligible?: import("../../lib/canonical/schema").CanonicalPosition[];
}
export interface StdTeamSpec {
  slug: string;
  /** the FLEX starter (position must be RB/WR/TE unless the league says otherwise) */
  flex: StdTeamPiece;
  bench?: StdTeamPiece[];
  ir?: StdTeamPiece[];
  /** override locked-starter projections; defaults are comfortably slot-locking */
  lockPts?: Partial<Record<"QB" | "RB1" | "RB2" | "WR1" | "WR2" | "TE" | "K" | "DEF", number>>;
}
const DEFAULT_LOCK_PTS = { QB: 25, RB1: 20, RB2: 19, WR1: 19, WR2: 18, TE: 13, K: 9, DEF: 8 } as const;

export function stdTeam(spec: StdTeamSpec): {
  team: TeamSpec;
  players: CanonicalPlayer[];
  projections: WeeklyProjection[];
} {
  const lp = { ...DEFAULT_LOCK_PTS, ...(spec.lockPts ?? {}) };
  const locks: Array<[string, "QB" | "RB" | "WR" | "TE" | "K" | "DEF", number]> = [
    [`${spec.slug}_QB`, "QB", lp.QB],
    [`${spec.slug}_RB1`, "RB", lp.RB1],
    [`${spec.slug}_RB2`, "RB", lp.RB2],
    [`${spec.slug}_WR1`, "WR", lp.WR1],
    [`${spec.slug}_WR2`, "WR", lp.WR2],
    [`${spec.slug}_TE`, "TE", lp.TE],
    [`${spec.slug}_K`, "K", lp.K],
    [`${spec.slug}_DEF`, "DEF", lp.DEF],
  ];
  const pieces = [spec.flex, ...(spec.bench ?? []), ...(spec.ir ?? [])];
  const players = [
    ...locks.map(([id, pos]) => player(id, pos)),
    ...pieces.map((p) => player(p.id, p.pos, { eligible: p.eligible })),
  ];
  const projections = [
    ...locks.map(([id, pos, pts]) => proj(id, pos, pts)),
    ...pieces.map((p) => proj(p.id, p.pos, p.pts)),
  ];
  const starters = [
    `${spec.slug}_QB`, `${spec.slug}_RB1`, `${spec.slug}_RB2`,
    `${spec.slug}_WR1`, `${spec.slug}_WR2`, `${spec.slug}_TE`,
    spec.flex.id, `${spec.slug}_K`, `${spec.slug}_DEF`,
  ];
  return {
    team: { slug: spec.slug, starters, bench: (spec.bench ?? []).map((p) => p.id), ir: (spec.ir ?? []).map((p) => p.id) },
    players,
    projections,
  };
}

export function tradeFixture(spec: TradeFixtureSpec): TradeFixture {
  const constraints = spec.constraints ?? STD_CONSTRAINTS;
  const teamCount = spec.teamCount ?? 12;
  const week = 1;

  const rosters = new Map<string, CanonicalRoster>();
  for (const t of spec.teams) {
    rosters.set(
      managerId(t.slug),
      roster(teamId(t.slug), t.starters, t.bench ?? [], { ir: t.ir, startingSlots: constraints.starting_slots }),
    );
  }

  const seenP = new Set<string>();
  const allPlayers = [...spec.players, ...(spec.freeAgents ?? [])].filter((p) => {
    if (seenP.has(p.canonical_player_id)) return false;
    seenP.add(p.canonical_player_id);
    return true;
  });
  const allProjs = [...spec.projections, ...(spec.faProjections ?? [])];
  const projections = batch(allProjs, allPlayers);
  const players_by_id = new Map(allPlayers.map((p) => [p.canonical_player_id, p]));
  const playerPositions = new Map(allPlayers.map((p) => [p.canonical_player_id, [p.position, ...p.eligible_positions]]));

  const teams = spec.teams.map((t) => ({
    canonical_team_id: teamId(t.slug),
    canonical_league_id: "league:test-league",
    provider_team_id: t.slug,
    team_name: t.slug,
    canonical_manager_ids: [managerId(t.slug)],
    record: { wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0 },
    faab_remaining: 100,
    waiver_priority: 5,
    provenance: { provider: "sleeper" as const, provider_id: t.slug, provider_synced_at: null },
  }));
  const managers = spec.teams.map((t) => ({
    canonical_manager_id: managerId(t.slug),
    manager_slug: t.slug,
    provider_username: t.slug,
    display_name: t.slug,
    provider_user_id: t.slug,
    is_commissioner: false,
    is_co_manager: false,
    provenance: { provider: "sleeper" as const, provider_id: t.slug, provider_synced_at: null },
  }));

  const snapshot: CanonicalLeagueSnapshot = {
    schema_version: CANONICAL_SCHEMA_VERSION,
    captured_at: "2026-09-03T00:00:00.000Z",
    provider_synced_at: null,
    league: {
      canonical_league_id: "league:test-league",
      league_slug: "test-league",
      name: "test-league",
      season: 2026,
      status: "in_season",
      sport: "nfl",
      team_count: teamCount,
      current_week: week,
      scoring_rules: [],
      raw_scoring: { rec: 1, pass_td: 4, rush_td: 6, rec_td: 6, pass_yd: 0.04, rush_yd: 0.1, rec_yd: 0.1 },
      roster_settings: {
        starting_slots: constraints.starting_slots,
        bench_slots: constraints.bench_slots,
        ir_slots: constraints.ir_slots,
        taxi_slots: constraints.taxi_slots,
        slot_requirements: constraints.slot_requirements,
      },
      playoff_settings: { playoff_team_count: 6, playoff_start_week: 15, championship_week: 17 },
      waiver_settings: { type: "faab", faab_budget: 100, waiver_day: null },
      provenance: { provider: "sleeper", provider_id: "test-league", provider_synced_at: null },
    },
    season: 2026,
    week,
    managers,
    teams,
    rosters: [...rosters.values()],
    standings: [],
    matchups: [],
    recent_transactions: [],
    draft_picks: [],
    waiver_state: null,
    players: allPlayers,
    unresolved_players: [],
    live_provider_status: "READY",
    history_persistence_status: "READY",
    warnings: [],
  };

  const startablePositions = new Set(
    constraints.starting_slots.flatMap((s) =>
      ["QB", "RB", "WR", "TE", "K", "DEF"].includes(s) ? [s] : constraints.flex_positions,
    ),
  );
  const availability = buildLeagueAvailability({
    snapshot,
    manager_team_id: teams[0]!.canonical_team_id,
    week,
    candidates: allPlayers,
    startable_positions: startablePositions,
  });
  const replacement = computeWeeklyReplacement({
    league_slug: "test-league",
    week,
    team_count: teamCount,
    constraints,
    projections,
    availability,
  });

  const normalized: NormalizedProposal = {
    league_slug: "test-league",
    participant_manager_ids: spec.teams.map((t) => managerId(t.slug)),
    transfers: spec.transfers,
  };

  const participants: TradeParticipantInput[] = spec.teams.map((t) => ({
    manager: managers.find((m) => m.canonical_manager_id === managerId(t.slug))! as never,
    team: teams.find((tm) => tm.canonical_team_id === teamId(t.slug))! as never,
    roster: rosters.get(managerId(t.slug))!,
  }));

  const ownership = new Map<string, string>();
  for (const r of rosters.values()) for (const id of r.all_players) ownership.set(id, r.canonical_team_id);

  const input: TradeEvaluationInput = {
    normalized,
    week,
    constraints,
    team_count: teamCount,
    projections,
    replacement,
    players_by_id,
    participants,
    config: resolveTradeConfig(spec.config),
    projections_status: "READY",
  };

  return {
    input,
    rosters,
    ownership,
    playerPositions,
    resolution: (parts, transfers) => ({
      league_slug: "test-league",
      participants: parts.map((p) => ({
        input_id: p.input,
        canonical_manager_id: p.slug ? managerId(p.slug) : null,
        manager_slug: p.slug,
        canonical_team_id: p.slug ? teamId(p.slug) : null,
      })),
      transfers: transfers.map((t) => ({
        from_input: t.from,
        to_input: t.to,
        from_manager_id: parts.find((p) => p.input === t.from)?.slug ? managerId(parts.find((p) => p.input === t.from)!.slug!) : null,
        to_manager_id: parts.find((p) => p.input === t.to)?.slug ? managerId(parts.find((p) => p.input === t.to)!.slug!) : null,
        input_player_id: t.pid,
        canonical_player_id: t.cid,
      })),
      ownership,
      roster_by_manager: rosters,
      constraints,
      player_positions: playerPositions,
    }),
  };
}

export { validateTrade, player, proj };
export type { TradeResolution };
export const MID = managerId;
export const TID = teamId;

/** Convenience: a canonical transfer between two team slugs. */
export function xfer(from: string, to: string, playerId: string): NormalizedProposal["transfers"][number] {
  return { from_manager_id: managerId(from), to_manager_id: managerId(to), canonical_player_id: playerId, input_player_id: playerId };
}
