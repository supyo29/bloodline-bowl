/**
 * Synthetic prospective evidence for G3 tests. Records are built through the REAL capture path (real production forecast builder, real
 * validation); only the Role features, baselines and outcomes are generated. `effect` is the TRUE share of the challenger's delta that shows up
 * in realized points: 1 = the Role signal is real, 0 = the Role signal is noise.
 */
import { buildLeagueWeekRecords, type RoleForecastLike } from "../../lib/role-shadow/capture";
import type { OutcomeRow } from "../../lib/role-shadow/g3";
import type { RoleShadowRecord } from "../../lib/role-shadow/record";
import { SHADOW_POSITIONS, challengerPositionSpec, type ShadowPosition } from "../../lib/role-shadow/spec";
import { lcg } from "../../lib/role-shadow/stats";
import { DAY, KICK, champion, leagueWeek, roleForecast } from "./role-shadow";

export interface SynthOptions {
  weeks: number[]; perPosition: number; effect: number; noise: number; seed?: number; teams?: number; league?: string; lowConfidenceShare?: number; featureScale?: number;
}
export interface Synth { records: RoleShadowRecord[]; outcomes: OutcomeRow[] }

const TEAMS = ["KC", "BUF", "SF", "MIA", "DAL", "PHI", "DET", "BAL", "CIN", "LAR", "GB", "HOU"];

export function synth(o: SynthOptions): Synth {
  const rnd = lcg(o.seed ?? 7);
  const gauss = (): number => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const records: RoleShadowRecord[] = [];
  const outcomes: OutcomeRow[] = [];
  const nTeams = Math.min(o.teams ?? 12, TEAMS.length);
  for (const week of o.weeks) {
    const kick = KICK + (week - 6) * 7 * DAY;
    const now = kick - 2 * DAY;
    for (const pos of SHADOW_POSITIONS) {
      const spec = challengerPositionSpec(pos as ShadowPosition)!;
      const forecasts = [];
      const roles: RoleForecastLike[] = [];
      for (let i = 0; i < o.perPosition; i++) {
        const id = `p-${week}-${pos}-${i}`;
        const team = TEAMS[i % nTeams]!;
        const points = Math.round((3.5 + rnd() * 17) * 100) / 100;
        forecasts.push(champion({ id, position: pos, team, points, sleeper_id: `s-${id}`, gsis_id: `00-${id}`, kickoff_ms: kick, observed_ms: now - 30 * 60_000, composed_ms: now - 5 * 60_000 }));
        const f: Record<string, number> = {};
        for (const sf of spec.role_features) f[sf.feature] = Math.max(0, sf.mean + sf.sd * (o.featureScale ?? 0.8) * gauss());
        const share = (v: number) => Math.min(0.99, Math.max(0.05, v));
        roles.push(roleForecast({
          gsis: `00-${id}`, sleeper: `s-${id}`, team, position: pos, kickoff_ms: kick, as_of_ms: now, cutoff_ms: kick - 6 * DAY, id: `rf:${id}`.padEnd(27, "0").slice(0, 27),
          confidence: rnd() < (o.lowConfidenceShare ?? 0.2) ? "LOW" : "MEDIUM",
          overrides: {
            opportunity: { carries: f.exp_carries ?? null, rz_carries: f.exp_rz_carries ?? null, targets: f.exp_targets ?? null, rz_targets: f.exp_rz_targets ?? null, dropbacks: f.exp_dropbacks ?? null, designed_rushes: f.exp_designed_rushes ?? null, scrambles: f.exp_scrambles ?? null },
            metrics: { snap_share: { value: share(f.snap_share ?? 0.6) }, air_yards_share: { value: share(f.air_yards_share ?? 0.2) } },
          },
        }));
      }
      const built = buildLeagueWeekRecords(leagueWeek(forecasts, { week, league_slug: o.league ?? "bloodline-bowl" }), roles, now, "TEST");
      for (const r of built.records) {
        records.push(r);
        const mean = (r.champion.expected_points ?? 0) + o.effect * r.arms.challenger.delta;
        const actual = Math.max(0, Math.round((mean + o.noise * gauss()) * 100) / 100);
        outcomes.push({ league_slug: r.league_slug, season: r.season, week: r.week, canonical_player_id: r.player.canonical_player_id, actual_fantasy_points: actual, participation_state: "PLAYED_NORMAL", evidence_status: "CERTIFIED", scoring_exactness: "LEAGUE_EXACT", case_ref: `cc:${r.player.canonical_player_id}|d${r.week}` });
      }
    }
  }
  return { records, outcomes };
}
