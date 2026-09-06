/**
 * Phase 1C — per-surface `LeagueFacts` extractors.
 *
 * Each turns one surface's payload into the provider-neutral fact bundle the
 * harness compares. Extractors pull only what the surface actually expresses;
 * absent facts are left `undefined` so `certify()` skips them.
 */

import type { LeagueFacts, TeamFacts, PlayerFacts } from "./harness";
import { scoringFingerprint } from "../scoring-fingerprint";
import type { ScoringResponse } from "@/lib/scoring/types";
import type { LeagueResponse, NormalizedTeam, NormalizedPlayer } from "@/lib/sleeper/types";
import type { LeagueSnapshot } from "@/lib/analytics/snapshot";
import type { RosterStandingFacts } from "@/lib/analytics/standings";
import type { WeeklyTeamContext } from "@/lib/weekly/schema";

const sorted = (xs: (string | null | undefined)[]) =>
  xs.filter((x): x is string => Boolean(x)).sort();

/* ------------------------------------------------------ /api/scoring family */

export function factsFromScoringBundle(r: ScoringResponse): LeagueFacts {
  return {
    source: "scoring-bundle",
    provider_league_id: r.league_id,
    season: Number(r.league.season),
    raw_scoring: r.scoring.raw,
    scoring_fingerprint: scoringFingerprint(r.scoring.raw),
    roster_positions_raw: r.league.roster_positions,
  };
}

/* -------------------------------------------------- /api/league (provider-native) */

function playerFacts(p: NormalizedPlayer | null): PlayerFacts | null {
  if (!p) return null;
  return {
    provider_id: p.player_id,
    position: p.position,
    nfl_team: p.team,
    is_team_defense: (p.position ?? "").toUpperCase() === "DEF",
  };
}

export function factsFromLegacyLeagueResponse(r: LeagueResponse): LeagueFacts {
  const teams = new Map<number, TeamFacts>();
  const players = new Map<string, PlayerFacts>();
  const register = (p: NormalizedPlayer | null) => {
    const pf = playerFacts(p);
    if (pf) players.set(pf.provider_id, pf);
  };

  for (const t of r.teams as NormalizedTeam[]) {
    for (const s of t.starters) register(s.player);
    for (const p of t.bench) register(p);
    for (const p of t.reserve) register(p);
    for (const p of t.players) register(p);

    teams.set(t.roster_id, {
      roster_id: t.roster_id,
      owner_user_id: t.manager.user_id,
      manager_display_name: t.manager.display_name,
      team_name: t.manager.team_name,
      wins: t.record.wins,
      losses: t.record.losses,
      ties: t.record.ties,
      points_for: t.record.points_for,
      points_against: t.record.points_against,
      starter_ids: sorted(t.starters.filter((s) => !s.is_empty).map((s) => s.player?.player_id)),
      bench_ids: sorted(t.bench.map((p) => p.player_id)),
      ir_ids: sorted(t.reserve.map((p) => p.player_id)),
      all_player_ids: sorted(t.players.map((p) => p.player_id)),
    });
  }

  const sl = r.league.starting_lineup;
  return {
    source: "api/league",
    provider_league_id: r.league.league_id,
    season: Number(r.league.season),
    status: r.league.status,
    raw_scoring: r.league.scoring_settings,
    scoring_fingerprint: scoringFingerprint(r.league.scoring_settings),
    roster_positions_raw: r.league.roster_positions,
    starting_slots: sl.slots.filter((s) => !["BN", "IR", "TAXI"].includes(s)),
    bench_slots: sl.bench_slots,
    ir_slots: sl.reserve_slots,
    taxi_slots: sl.taxi_slots,
    team_count: r.league.total_rosters,
    teams,
    players,
  };
}

/* --------------------------------- /api/snapshot (buildSnapshot, partial migration) */

function fromStandingsRows(rows: RosterStandingFacts[]): Map<number, TeamFacts> {
  const teams = new Map<number, TeamFacts>();
  for (const s of rows) {
    teams.set(s.roster_id, {
      roster_id: s.roster_id,
      owner_user_id: s.manager.user_id,
      manager_display_name: s.manager.display_name,
      team_name: s.manager.team_name,
      wins: s.wins,
      losses: s.losses,
      ties: s.ties,
      points_for: s.points_for,
      points_against: s.points_against,
    });
  }
  return teams;
}

export function factsFromLeagueSnapshot(s: LeagueSnapshot): LeagueFacts {
  return {
    source: "api/snapshot",
    provider_league_id: s.league.league_id,
    season: Number(s.league.season),
    status: s.league.status,
    team_count: s.league.team_count,
    teams: fromStandingsRows(s.standings),
  };
}

/* ------------------------------ /api/leagues/:slug/managers/:slug/snapshot */

export interface ManagerSnapshotPayload {
  league: { league_id: string; season: string; status: string; team_count: number; roster_positions: string[] };
  standings: RosterStandingFacts[];
}

export function factsFromManagerSnapshot(p: ManagerSnapshotPayload): LeagueFacts {
  return {
    source: "api/managers/:m/snapshot",
    provider_league_id: p.league.league_id,
    season: Number(p.league.season),
    status: p.league.status,
    team_count: p.league.team_count,
    roster_positions_raw: p.league.roster_positions,
    teams: fromStandingsRows(p.standings),
  };
}

/* -------------------------------------------- /api/leagues/:slug/managers */

export interface LeaguesManagersPayload {
  managers: Array<{
    roster_id: number;
    vacant: boolean;
    manager_slug: string | null;
    sleeper_user_id?: string;
    display_name?: string | null;
    team_name?: string | null;
  }>;
}

export function factsFromLeaguesManagers(p: LeaguesManagersPayload): LeagueFacts {
  const teams = new Map<number, TeamFacts>();
  for (const m of p.managers) {
    teams.set(m.roster_id, {
      roster_id: m.roster_id,
      owner_user_id: m.vacant ? null : (m.sleeper_user_id ?? null),
      manager_display_name: m.vacant ? null : (m.display_name ?? null),
      team_name: m.vacant ? null : (m.team_name ?? null),
    });
  }
  return { source: "api/leagues/:slug/managers", teams };
}

/* --------------------------- /api/leagues/:slug/managers/:slug (identity) */

export interface ManagerIdentityPayload {
  manager: { roster_id: number; sleeper_user_id: string; display_name: string | null; team_name: string | null };
  roster: {
    starters: { player_id: string }[];
    bench: { player_id: string }[];
    reserve: { player_id: string }[];
    players: { player_id: string }[];
  };
}

export function factsFromManagerIdentity(p: ManagerIdentityPayload): LeagueFacts {
  const teams = new Map<number, TeamFacts>([
    [
      p.manager.roster_id,
      {
        roster_id: p.manager.roster_id,
        owner_user_id: p.manager.sleeper_user_id,
        manager_display_name: p.manager.display_name,
        team_name: p.manager.team_name,
        starter_ids: sorted(p.roster.starters.map((x) => x.player_id)),
        bench_ids: sorted(p.roster.bench.map((x) => x.player_id)),
        ir_ids: sorted(p.roster.reserve.map((x) => x.player_id)),
        all_player_ids: sorted(p.roster.players.map((x) => x.player_id)),
      },
    ],
  ]);
  return { source: "api/leagues/:slug/managers/:slug", partial: true, teams };
}

/* ----------------------------------------------- weekly context (one manager) */

export function factsFromWeeklyContext(ctx: WeeklyTeamContext): LeagueFacts {
  const teams = new Map<number, TeamFacts>();
  const rosterId = Number(ctx.fantasy_team.provider_team_id);
  const sid = (ps: { identifiers: { sleeper_id?: string }; canonical_player_id: string }[]) =>
    sorted(
      ps.map(
        (p) =>
          p.identifiers.sleeper_id ??
          (p.canonical_player_id.startsWith("player:sleeper:")
            ? p.canonical_player_id.slice("player:sleeper:".length)
            : null),
      ),
    );
  teams.set(rosterId, {
    roster_id: rosterId,
    owner_user_id: ctx.manager.provider_user_id,
    manager_display_name: ctx.manager.display_name,
    team_name: ctx.fantasy_team.team_name,
    wins: ctx.standing?.wins ?? ctx.fantasy_team.record.wins,
    losses: ctx.standing?.losses ?? ctx.fantasy_team.record.losses,
    ties: ctx.standing?.ties ?? ctx.fantasy_team.record.ties,
    starter_ids: sid(ctx.starters),
    bench_ids: sid(ctx.bench),
    ir_ids: sid(ctx.reserve_ir),
    all_player_ids: sid(ctx.all_rostered),
    opponent_roster_id: ctx.opponent ? Number(ctx.opponent.fantasy_team.provider_team_id) : null,
  });
  return {
    source: `weekly-context:${ctx.manager.manager_slug}`,
    partial: true,
    season: ctx.league.season,
    week: ctx.league.week,
    scoring_fingerprint: ctx.lineage.snapshot.scoring_fingerprint,
    raw_scoring: ctx.league.raw_scoring,
    starting_slots: ctx.league.roster_constraints.starting_slots,
    snapshot_id: ctx.lineage.snapshot.league_snapshot_id,
    teams,
  };
}
