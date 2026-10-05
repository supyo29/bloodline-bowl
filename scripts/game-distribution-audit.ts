/**
 * Phase 3 manual audits (read-only): representative Week-3 player cases + the Thursday ATL-GB adversarial game.
 *   ENV_FILE=... SCORING_SOURCE_BASE_URL=... npx tsx scripts/game-distribution-audit.ts <season> <week> [--out file.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
function loadEnv(file: string | undefined) { if (!file) return; for (const l of readFileSync(file, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !l.trim().startsWith("#")) process.env[m[1]!] = m[2]!; } }
async function main() {
  loadEnv(process.env.ENV_FILE);
  const season = Number(process.argv[2] ?? 2026), week = Number(process.argv[3] ?? 3); const oi = process.argv.indexOf("--out"); const outFile = oi >= 0 ? process.argv[oi + 1] : null;
  const { defaultWeeklyAuditRest } = await import("../lib/persistence/supabase/weekly-audit-store");
  const { listLeagueTargets } = await import("../lib/leagues/registry");
  const { evaluateWeek } = await import("../lib/game-distribution/run-week");
  const { loadObservedRoleGames } = await import("../lib/role-calibration/data");
  const { scriptLabel } = await import("../lib/game-distribution/simulate");
  const rest = defaultWeeklyAuditRest()!; const base = process.env.SCORING_SOURCE_BASE_URL!.replace(/\/$/, "");
  const leagues = await Promise.all(listLeagueTargets().map(async (t) => { const j = (await (await fetch(`${base}/api/league/${t.key}/state`)).json()) as { state?: { league?: { raw_scoring?: Record<string, number>; scoring_fingerprint?: string } } }; const lg = j.state?.league; return lg?.raw_scoring && lg.scoring_fingerprint ? { league_slug: t.key, provider: t.provider, scoring_fingerprint: lg.scoring_fingerprint, raw_scoring: lg.raw_scoring } : { league_slug: t.key, provider: t.provider, scoring_fingerprint: null, raw_scoring: null }; }));
  const ev = await evaluateWeek({ season, week, rest, leagues });
  const names = ["Jahmyr Gibbs", "Brock Purdy", "Sam Darnold", "George Kittle", "Brock Bowers", "Kenyon Sadiq", "Harold Fannin", "Tyler Higbee", "Jonathan Taylor", "TreVeyon Henderson", "Baker Mayfield", "Drake Maye", "De'Von Achane", "Justin Jefferson", "Jordan Love"];
  const players = names.flatMap((n) => ev.rows.filter((r) => r.league_slug === "bloodline-bowl" && (r.player_name ?? "").includes(n)).map((r) => ({ name: r.player_name, pos: r.position, team: r.nfl_team, baseline: r.baseline_projection, actual: r.actual_fantasy_points, sim_mean: r.sim.sim_mean, p_zero: r.sim.p_zero, pool: r.sim.pool_key, injury: r.labels.injury_contamination, participated: r.labels.participated,
    A: [r.models.A.quantiles.p10, r.models.A.quantiles.p50, r.models.A.quantiles.p90], B: [r.models.B.quantiles.p10, r.models.B.quantiles.p50, r.models.B.quantiles.p90], C: [r.models.C.quantiles.p10, r.models.C.quantiles.p50, r.models.C.quantiles.p90],
    pit: { A: r.models.A.scores.pit, B: r.models.B.scores.pit, C: r.models.C.scores.pit }, decomposition6: r.decomposition6 })));
  // ATL-GB: team volumes vs the simulated volume distributions
  const observed = loadObservedRoleGames(); const gb = ev.envs.find((e) => [e.home_team, e.away_team].includes("GB") && [e.home_team, e.away_team].includes("ATL"))!;
  const actual = (team: string) => { const r = observed.find((o) => o.season === season && o.week === week && o.team === team); return r ? { pass_att: r.team_pass_att, rush_att: r.team_rush_att, rz_pass: r.team_rz_pass_att, rz_rush: r.team_rz_rush_att } : null; };
  const where = (v: number | null, d: { p5: number; p10: number; p25: number; p50: number; p75: number; p90: number; p95: number }) => (v == null ? null : v < d.p5 ? "<P5" : v < d.p10 ? "P5-P10" : v < d.p25 ? "P10-P25" : v < d.p50 ? "P25-P50" : v < d.p75 ? "P50-P75" : v < d.p90 ? "P75-P90" : v < d.p95 ? "P90-P95" : ">P95");
  const sim = ev.sims.get(gb.nfl_game_id)!;
  const teams = gb.teams.map((t, i) => { const a = actual(t.team); const f = t.forecast_means; const ratio = a && f.pass_att && f.rush_att ? ([(a.pass_att ?? 0) / f.pass_att, (a.rush_att ?? 0) / f.rush_att, 1, 1] as [number, number, number, number]) : null;
    return { team: t.team, forecast_means: f, volume_dist: { pass_att: t.volume.pass_att, rush_att: t.volume.rush_att, rz_pass: t.volume.rz_pass_att, rz_rush: t.volume.rz_rush_att }, actual: a, actual_position_in_distribution: a ? { pass_att: where(a.pass_att, t.volume.pass_att), rush_att: where(a.rush_att, t.volume.rush_att), rz_pass: where(a.rz_pass, t.volume.rz_pass_att), rz_rush: where(a.rz_rush, t.volume.rz_rush_att) } : null, actual_script_label: ratio ? scriptLabel(ratio, [1, 1, 1, 1]) : null, scenario_probabilities: t.scenario_probabilities, qb_changed: t.qb_changed_last_game, confidence: t.confidence, i }; });
  const dst = null; void sim; void dst;
  const out = { generated_at: new Date().toISOString(), season, week, players, atl_gb: { env_id: gb.env_id, kickoff_at: gb.kickoff_at, weather: gb.weather, fi: gb.football_intelligence.status, teams } };
  const json = JSON.stringify(out, null, 1); if (outFile) writeFileSync(outFile, json); else console.log(json);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
