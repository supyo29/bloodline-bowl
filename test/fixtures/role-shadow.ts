/**
 * Shared fixtures for the W2.P2 Role Shadow tests. Champions come from the REAL production builder (`buildCanonicalWeeklyPlayerForecast`) so the
 * availability identity and injury semantics under test are genuine; only the clocks/kickoff are patched on (the builder takes them from the batch).
 */
import { buildCanonicalWeeklyPlayerForecast, type CanonicalWeeklyPlayerForecast } from "../../lib/weekly/forecast";
import type { CanonicalPlayer } from "../../lib/canonical/schema";
import type { WeeklyProjection, WeeklyProjectionBatch } from "../../lib/weekly/schema";
import type { LeagueWeekInput, RoleForecastLike } from "../../lib/role-shadow/capture";
import { buildLeagueWeekRecords } from "../../lib/role-shadow/capture";
import type { RoleShadowRecord } from "../../lib/role-shadow/record";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const KICK = Date.parse("2026-10-18T17:00:00Z"); // Sunday 1:00 pm ET
export const NOW = KICK - 2 * DAY; // captured Friday
export const iso = (ms: number): string => new Date(ms).toISOString();

/** Bloodline Bowl style: every MODELED rule equals the frozen HALF fit, plus rules the fit never saw (QB sack / pick-six penalties). */
export const BB_SCORING: Record<string, number> = {
  pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6, rec: 0.5, rec_yd: 0.1, rec_td: 6, fum_lost: -2, pass_2pt: 2, rush_2pt: 2, rec_2pt: 2,
  pass_sack: -1, pass_int_td: -1, fum_rec: 1, fgm: 3, def_td: 6, pts_allow_0: 10,
};
/** Devoted / Sporty's style: full PPR and interceptions at -1 — NOT on the frozen fit. */
export const PPR_SCORING: Record<string, number> = { ...BB_SCORING, rec: 1, pass_int: -1 };

const projection = (over: Partial<WeeklyProjection> = {}): WeeklyProjection => ({
  canonical_player_id: "p1", week: 6, season: 2026, position: "WR", nfl_team: "KC", opponent: "LV", is_home: null,
  projected_points: 14.6, floor_points: 9, ceiling_points: 22, std_dev: 5, projection_status: "projected",
  expected_availability: 1, is_bye: false, injury_status: null, rest_of_season_points: null, ros: null,
  source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire", uncertainty_source: "position_volatility_heuristic", warnings: [], ...over,
});
const canonicalPlayer = (over: Partial<CanonicalPlayer> = {}): CanonicalPlayer => ({
  canonical_player_id: "p1", full_name: "P One", first_name: null, last_name: null, position: "WR", eligible_positions: ["WR"],
  nfl_team: "KC", is_team_defense: false, status: null, injury_status: null, identifiers: { sleeper_id: "s1", gsis_id: "00-0001" },
  resolution: { method: "stable_id", confidence: "high", note: null }, ...over,
});
const batch = (): WeeklyProjectionBatch => ({
  league_slug: "bloodline-bowl", season: 2026, week: 6, status: "READY", by_player: new Map(), resolved_players: new Map(),
  source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire", missing: [], teams_with_games: ["KC", "LV"], warnings: [], ...({} as object),
}) as WeeklyProjectionBatch;

export interface ChampionOpts {
  id?: string; position?: string; team?: string; points?: number | null; injury_status?: string | null; practice?: "FULL" | "LIMITED" | "DNP";
  sleeper_id?: string | null; gsis_id?: string | null; kickoff_ms?: number | null; observed_ms?: number; composed_ms?: number; is_bye?: boolean;
}
/** A REAL canonical forecast (injury model, ledger, validation) with the freshness instants and kickoff set explicitly. */
export function champion(o: ChampionOpts = {}): CanonicalWeeklyPlayerForecast {
  const id = o.id ?? "p1";
  const pos = o.position ?? "WR";
  const team = o.team ?? "KC";
  const ids: Record<string, string> = {};
  if (o.sleeper_id !== null) ids.sleeper_id = o.sleeper_id ?? "s1";
  if (o.gsis_id !== null) ids.gsis_id = o.gsis_id ?? "00-0001";
  const f = buildCanonicalWeeklyPlayerForecast({
    canonical_player_id: id, season: 2026, week: 6,
    projection: projection({ canonical_player_id: id, position: pos as WeeklyProjection["position"], nfl_team: team, projected_points: o.points === undefined ? 14.6 : o.points, injury_status: o.injury_status ?? null, is_bye: o.is_bye ?? false, projection_status: o.is_bye ? "bye" : "projected" }),
    batch: batch(), player: canonicalPlayer({ canonical_player_id: id, position: pos as CanonicalPlayer["position"], nfl_team: team, identifiers: ids }),
    injury: o.practice ? { practice: o.practice } : undefined,
  });
  const kick = o.kickoff_ms === undefined ? KICK : o.kickoff_ms;
  return {
    ...f,
    game_status: { ...f.game_status, kickoff_at: kick == null ? null : iso(kick), game_id: "g-KC-LV" },
    freshness: { ...f.freshness, source_observed_at: iso(o.observed_ms ?? NOW - 30 * MIN), forecast_composed_at: iso(o.composed_ms ?? NOW - 5 * MIN), source_observation_id: "obs-1" },
  };
}

export interface RoleOpts {
  gsis?: string | null; sleeper?: string | null; team?: string; position?: string; confidence?: RoleForecastLike["confidence"]; kind?: RoleForecastLike["capture_kind"];
  kickoff_ms?: number | null; as_of_ms?: number; cutoff_ms?: number | null; designation?: string; id?: string; overrides?: Partial<RoleForecastLike>;
}
export function roleForecast(o: RoleOpts = {}): RoleForecastLike {
  const pos = o.position ?? "WR";
  const opportunity = pos === "RB"
    ? { carries: 12.5, rz_carries: 2.1, targets: 3.0, rz_targets: 0.4, dropbacks: null, designed_rushes: null, scrambles: null }
    : pos === "QB"
      ? { carries: null, rz_carries: null, targets: null, rz_targets: null, dropbacks: 34, designed_rushes: 1.4, scrambles: 2.1 }
      : { carries: null, rz_carries: null, targets: pos === "TE" ? 4.8 : 7.2, rz_targets: pos === "TE" ? 0.7 : 0.9, dropbacks: null, designed_rushes: null, scrambles: null };
  return {
    forecast_id: o.id ?? "rf:0123456789abcdef01234567", forecast_version: "role-forecast-2026.1",
    gsis_id: o.gsis === undefined ? "00-0001" : o.gsis, sleeper_id: o.sleeper === undefined ? "s1" : o.sleeper, nfl_team: o.team ?? "KC", position: pos,
    nfl_game_id: "g-KC-LV", kickoff_at: o.kickoff_ms === null ? null : iso(o.kickoff_ms ?? KICK), capture_kind: o.kind ?? "LIVE_CAPTURED",
    as_of_at: iso(o.as_of_ms ?? NOW), data_cutoff_at: o.cutoff_ms === null ? null : iso(o.cutoff_ms ?? KICK - 6 * DAY), confidence: o.confidence ?? "MEDIUM",
    availability: { designation: o.designation ?? "NONE" }, opportunity, metrics: { snap_share: { value: 0.82 }, air_yards_share: { value: 0.27 } },
    ...(o.overrides ?? {}),
  };
}

export function leagueWeek(forecasts: CanonicalWeeklyPlayerForecast[], over: Partial<LeagueWeekInput> = {}): LeagueWeekInput {
  return {
    league_slug: "bloodline-bowl", provider: "sleeper", season: 2026, week: 6, raw_scoring: BB_SCORING, scoring_fingerprint: "scoring:v1:aaaaaaaaaaaaaaaaaaaaaaaa",
    league_snapshot_id: "snap-1", forecast_identity_id: "fcid:1", forecasts, ...over,
  };
}

/** One valid LIVE_CAPTURED record built through the real capture path. */
export function liveRecord(champ: ChampionOpts = {}, role: RoleOpts = {}, league: Partial<LeagueWeekInput> = {}, nowMs: number = NOW): RoleShadowRecord {
  const r = buildLeagueWeekRecords(leagueWeek([champion(champ)], league), [roleForecast(role)], nowMs, "TEST");
  if (r.records.length !== 1) throw new Error(`fixture failed to build a record: ${JSON.stringify(r.counters)}`);
  return r.records[0]!;
}
