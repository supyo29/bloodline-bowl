/**
 * Phase 1C — cross-surface certification harness.
 *
 * Every live/current-state surface is reduced to a provider-neutral `LeagueFacts`
 * bundle. `certify(a, b, …)` compares the facts the two surfaces BOTH express
 * (schemas differ; facts must not) and returns a list of `Discrepancy`. A
 * non-empty list must FAIL the calling test — never merely be logged.
 *
 * The canonical snapshot (`buildCanonicalLeagueState`) is the reference. Every
 * other surface is certified against it.
 */

import type {
  CanonicalLeagueSnapshot,
  CanonicalManager,
  CanonicalPlayer,
} from "../schema";
import { reconstructRosterPositions } from "../compat/scoring-inputs";
import { scoringFingerprint } from "../scoring-fingerprint";

/* --------------------------------------------------------------- fact shapes */

export interface TeamFacts {
  roster_id: number;
  owner_user_id: string | null;
  manager_display_name: string | null;
  team_name: string | null;
  wins?: number | null;
  losses?: number | null;
  ties?: number | null;
  points_for?: number | null;
  points_against?: number | null;
  /** Sorted provider (Sleeper) ids of the filled starting slots. */
  starter_ids?: string[];
  bench_ids?: string[];
  ir_ids?: string[];
  all_player_ids?: string[];
  /** roster_id of the current-week opponent, when the surface expresses matchups. */
  opponent_roster_id?: number | null;
}

export interface PlayerFacts {
  provider_id: string;
  canonical_player_id?: string | null;
  position: string | null;
  nfl_team: string | null;
  is_team_defense?: boolean | null;
}

export interface LeagueFacts {
  source: string;
  provider_league_id?: string | null;
  season?: number | null;
  week?: number | null;
  status?: string | null;
  scoring_fingerprint?: string | null;
  raw_scoring?: Record<string, number> | null;
  roster_positions_raw?: string[] | null;
  starting_slots?: string[] | null;
  bench_slots?: number | null;
  ir_slots?: number | null;
  taxi_slots?: number | null;
  team_count?: number | null;
  /** keyed by roster_id */
  teams?: Map<number, TeamFacts>;
  /** keyed by provider id */
  players?: Map<string, PlayerFacts>;
  snapshot_id?: string | null;
  /**
   * True for a surface that only expresses a SUBSET of teams/players (a
   * per-manager view). `certify()` then compares only the overlap and never
   * flags a team missing from the partial side.
   */
  partial?: boolean;
}

export interface Discrepancy {
  a: string;
  b: string;
  field: string;
  scope: string;
  a_value: unknown;
  b_value: unknown;
}

/* ------------------------------------------------------ canonical extraction */

const sleeperId = (p: CanonicalPlayer): string | null =>
  p.identifiers.sleeper_id ??
  (p.canonical_player_id.startsWith("player:sleeper:")
    ? p.canonical_player_id.slice("player:sleeper:".length)
    : null);

export function factsFromCanonical(snap: CanonicalLeagueSnapshot): LeagueFacts {
  const playerById = new Map(snap.players.map((p) => [p.canonical_player_id, p]));
  const managerById = new Map<string, CanonicalManager>(
    snap.managers.map((m) => [m.canonical_manager_id, m]),
  );
  const idsFor = (cids: string[]): string[] =>
    cids
      .map((c) => playerById.get(c))
      .map((p) => (p ? sleeperId(p) : null))
      .filter((x): x is string => Boolean(x))
      .sort();

  const teams = new Map<number, TeamFacts>();
  for (const team of snap.teams) {
    const rosterId = Number(team.provider_team_id);
    const roster = snap.rosters.find((r) => r.canonical_team_id === team.canonical_team_id);
    const standing = snap.standings.find((s) => s.canonical_team_id === team.canonical_team_id);
    const owner = team.canonical_manager_ids[0]
      ? managerById.get(team.canonical_manager_ids[0])
      : undefined;
    const myMatchup = snap.matchups.find((m) =>
      m.sides.some((s) => s.canonical_team_id === team.canonical_team_id),
    );
    const oppSide = myMatchup?.sides.find((s) => s.canonical_team_id !== team.canonical_team_id);
    const oppTeam = oppSide
      ? snap.teams.find((t) => t.canonical_team_id === oppSide.canonical_team_id)
      : undefined;

    teams.set(rosterId, {
      roster_id: rosterId,
      owner_user_id: owner?.provider_user_id ?? team.provider_owner_id ?? null,
      manager_display_name: owner?.display_name ?? null,
      team_name: team.team_name,
      wins: standing?.wins ?? team.record.wins,
      losses: standing?.losses ?? team.record.losses,
      ties: standing?.ties ?? team.record.ties,
      points_for: standing?.points_for ?? team.record.points_for,
      points_against: standing?.points_against ?? team.record.points_against,
      starter_ids: idsFor(roster?.starters ?? []),
      bench_ids: idsFor(roster?.bench ?? []),
      ir_ids: idsFor(roster?.ir ?? []),
      all_player_ids: idsFor(roster?.all_players ?? []),
      opponent_roster_id: oppTeam ? Number(oppTeam.provider_team_id) : myMatchup ? null : undefined,
    });
  }

  const players = new Map<string, PlayerFacts>();
  for (const p of snap.players) {
    const sid = sleeperId(p);
    if (!sid) continue;
    players.set(sid, {
      provider_id: sid,
      canonical_player_id: p.canonical_player_id,
      position: p.position,
      nfl_team: p.nfl_team,
      is_team_defense: p.is_team_defense,
    });
  }

  return {
    source: "canonical",
    provider_league_id: snap.league.provenance.provider_id,
    season: snap.season,
    week: snap.week,
    status: snap.league.status,
    scoring_fingerprint: snap.league.scoring_fingerprint ?? scoringFingerprint(snap.league.raw_scoring),
    raw_scoring: snap.league.raw_scoring,
    roster_positions_raw: reconstructRosterPositions(snap.league.roster_settings),
    starting_slots: snap.league.roster_settings.starting_slots,
    bench_slots: snap.league.roster_settings.bench_slots,
    ir_slots: snap.league.roster_settings.ir_slots,
    taxi_slots: snap.league.roster_settings.taxi_slots,
    team_count: snap.league.team_count,
    teams,
    players,
    snapshot_id: snap.lineage?.league_snapshot_id ?? null,
  };
}

/* --------------------------------------------------------------- comparison */

function eqScalar(x: unknown, y: unknown): boolean {
  if (typeof x === "number" && typeof y === "number") {
    return Math.abs(x - y) < 1e-6;
  }
  return JSON.stringify(x) === JSON.stringify(y);
}

export interface CertifyOptions {
  /** `field` or `scope:field` entries whose disagreement is a documented, allowed difference. */
  allow?: string[];
  /** Only compare these top-level fact fields (default: all present in both). */
  only?: string[];
}

const LEAGUE_SCALAR_FIELDS: (keyof LeagueFacts)[] = [
  "provider_league_id",
  "season",
  "week",
  "status",
  "scoring_fingerprint",
  "roster_positions_raw",
  "starting_slots",
  "bench_slots",
  "ir_slots",
  "taxi_slots",
  "team_count",
];

const TEAM_FIELDS: (keyof TeamFacts)[] = [
  "owner_user_id",
  "manager_display_name",
  "team_name",
  "wins",
  "losses",
  "ties",
  "points_for",
  "points_against",
  "starter_ids",
  "bench_ids",
  "ir_ids",
  "all_player_ids",
  "opponent_roster_id",
];

const PLAYER_FIELDS: (keyof PlayerFacts)[] = ["position", "nfl_team", "is_team_defense"];

export function certify(a: LeagueFacts, b: LeagueFacts, opts: CertifyOptions = {}): Discrepancy[] {
  const out: Discrepancy[] = [];
  const allow = new Set(opts.allow ?? []);
  const allowed = (scope: string, field: string) =>
    allow.has(field) || allow.has(`${scope}:${field}`);
  const push = (field: string, scope: string, av: unknown, bv: unknown) => {
    if (!allowed(scope, field)) {
      out.push({ a: a.source, b: b.source, field, scope, a_value: av, b_value: bv });
    }
  };

  for (const f of LEAGUE_SCALAR_FIELDS) {
    if (opts.only && !opts.only.includes(f)) continue;
    if (a[f] == null || b[f] == null) continue;
    if (!eqScalar(a[f], b[f])) push(f, "league", a[f], b[f]);
  }

  if (a.raw_scoring && b.raw_scoring && (!opts.only || opts.only.includes("raw_scoring"))) {
    // Scoring EQUIVALENCE (not byte identity): compare via the fingerprint.
    if (scoringFingerprint(a.raw_scoring) !== scoringFingerprint(b.raw_scoring)) {
      push("raw_scoring", "league", a.raw_scoring, b.raw_scoring);
    }
  }

  if (a.teams && b.teams && (!opts.only || opts.only.includes("teams"))) {
    const checkPresence = !a.partial && !b.partial;
    for (const [rid, ta] of a.teams) {
      const tb = b.teams.get(rid);
      if (!tb) {
        if (checkPresence) push("roster_id", `team:${rid}`, "present", "absent");
        continue;
      }
      for (const f of TEAM_FIELDS) {
        if (ta[f] === undefined || tb[f] === undefined) continue;
        if (!eqScalar(ta[f], tb[f])) push(f, `team:${rid}`, ta[f], tb[f]);
      }
    }
    if (checkPresence) {
      for (const rid of b.teams.keys()) {
        if (!a.teams.has(rid)) push("roster_id", `team:${rid}`, "absent", "present");
      }
    }
  }

  if (a.players && b.players && (!opts.only || opts.only.includes("players"))) {
    for (const [pid, pa] of a.players) {
      const pb = b.players.get(pid);
      if (!pb) continue; // b may only know a subset of players
      for (const f of PLAYER_FIELDS) {
        if (pa[f] == null || pb[f] == null) continue;
        if (!eqScalar(pa[f], pb[f])) push(f, `player:${pid}`, pa[f], pb[f]);
      }
      if (pa.canonical_player_id && pb.canonical_player_id && pa.canonical_player_id !== pb.canonical_player_id) {
        push("canonical_player_id", `player:${pid}`, pa.canonical_player_id, pb.canonical_player_id);
      }
    }
  }

  return out;
}

export function formatDiscrepancies(ds: Discrepancy[]): string {
  return ds
    .map((d) => `  [${d.scope}] ${d.field}: ${d.a}=${JSON.stringify(d.a_value)} vs ${d.b}=${JSON.stringify(d.b_value)}`)
    .join("\n");
}
