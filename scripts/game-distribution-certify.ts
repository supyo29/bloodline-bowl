/**
 * Projection Calibration Phase 3 — evaluate (read-only) or materialize (--write) the distribution layer for completed weeks against the production ledger.
 *   ENV_FILE=... SCORING_SOURCE_BASE_URL=... npx tsx scripts/game-distribution-certify.ts <season> <weeks,csv> [--write] [--sims N] [--out file.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
function loadEnv(file: string | undefined) { if (!file) return; for (const l of readFileSync(file, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !l.trim().startsWith("#")) process.env[m[1]!] = m[2]!; } }
async function main() {
  loadEnv(process.env.ENV_FILE);
  const args = process.argv.slice(2); const season = Number(args[0] ?? 2026); const weeks = (args[1] ?? "3").split(",").map(Number);
  const write = args.includes("--write"); const si = args.indexOf("--sims"); const sims = si >= 0 ? Number(args[si + 1]) : 1000; const oi = args.indexOf("--out"); const outFile = oi >= 0 ? args[oi + 1] : null;
  const { defaultWeeklyAuditRest } = await import("../lib/persistence/supabase/weekly-audit-store");
  const { listLeagueTargets } = await import("../lib/leagues/registry");
  const { evaluateWeek } = await import("../lib/game-distribution/run-week");
  const { distributionReport } = await import("../lib/game-distribution/report");
  const rest = defaultWeeklyAuditRest(); if (!rest) throw new Error("Supabase env missing");
  const base = process.env.SCORING_SOURCE_BASE_URL?.replace(/\/$/, ""); if (!base) throw new Error("SCORING_SOURCE_BASE_URL required");
  const leagues = await Promise.all(listLeagueTargets().map(async (t) => {
    const j = (await (await fetch(`${base}/api/league/${t.key}/state`)).json()) as { state?: { league?: { raw_scoring?: Record<string, number>; scoring_fingerprint?: string } } }; const lg = j.state?.league;
    return lg?.raw_scoring && lg.scoring_fingerprint ? { league_slug: t.key, provider: t.provider, scoring_fingerprint: lg.scoring_fingerprint, raw_scoring: lg.raw_scoring } : { league_slug: t.key, provider: t.provider, scoring_fingerprint: null, raw_scoring: null, note: "no scoring" };
  }));
  const out: Record<string, unknown> = { generated_at: new Date().toISOString(), season, weeks, sims, write, weeks_out: {} };
  for (const week of weeks) {
    const t0 = Date.now();
    const ev = await evaluateWeek({ season, week, rest, leagues, sims });
    const persisted = write ? await (await import("../lib/game-distribution/materialize")).persistWeek({ rest, ev, leagues, season, week, sims }) : null;
    (out.weeks_out as Record<string, unknown>)[String(week)] = { seconds: (Date.now() - t0) / 1000, forecasts: { persisted: ev.forecasts.persisted, reconstructed: ev.forecasts.reconstructed }, env_games: ev.envs.length, rows: ev.rows.length, report: distributionReport(ev.rows), persisted };
    if (!write) (out.weeks_out as Record<string, { rows_detail?: unknown }>)[String(week)]!.rows_detail = ev.rows.filter((r) => r.league_slug === "bloodline-bowl").map((r) => ({ n: r.player_name, p: r.position, t: r.nfl_team, b: r.baseline_projection, a: r.actual_fantasy_points, de: r.eval_populations.distribution_eval, inj: r.labels.injury_contamination, part: r.labels.participated, simMean: r.sim.sim_mean, pool: r.sim.pool_key, q: { A: [r.models.A.quantiles.p10, r.models.A.quantiles.p50, r.models.A.quantiles.p90], B: [r.models.B.quantiles.p10, r.models.B.quantiles.p50, r.models.B.quantiles.p90], C: [r.models.C.quantiles.p10, r.models.C.quantiles.p50, r.models.C.quantiles.p90] }, pit: { A: r.models.A.scores.pit, B: r.models.B.scores.pit, C: r.models.C.scores.pit }, d6: r.decomposition6 }));
  }
  const json = JSON.stringify(out, null, 1); if (outFile) writeFileSync(outFile, json); else console.log(json);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
