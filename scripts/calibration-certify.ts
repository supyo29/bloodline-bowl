/**
 * Projection Calibration Phase 1 — materialize + certify.
 *
 *   ENV_FILE=/path/.env.prod npx tsx scripts/calibration-certify.ts <season> <weeks,csv> [--write] [--out file.json]
 *
 * Without --write it builds and reports only. With --write it materializes (insert-only), immediately re-runs to prove
 * idempotency (must write 0 new cases), reads the ledger back and reports coverage per week/league plus a
 * reconciliation of ledger actuals against provider team totals where the provider exposes them. Secrets are loaded
 * from ENV_FILE into process.env and never printed.
 */
import { readFileSync, writeFileSync } from "node:fs";

function loadEnv(file: string | undefined) {
  if (!file) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (m && !line.trim().startsWith("#")) process.env[m[1]!] = m[2]!;
  }
}

async function main() {
  loadEnv(process.env.ENV_FILE);
  const args = process.argv.slice(2);
  const season = Number(args[0] ?? 2026);
  const weeks = (args[1] ?? "3").split(",").map(Number);
  const write = args.includes("--write");
  const outIdx = args.indexOf("--out");
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;

  const { loadLeagueScoringInputs } = await import("../lib/calibration/leagues");
  const { materializeCalibrationWeek } = await import("../lib/calibration/materialize");
  const { defaultWeeklyAuditRest } = await import("../lib/persistence/supabase/weekly-audit-store");
  const { readCurrentCases } = await import("../lib/calibration/store");
  const { buildCalibrationReport, statusCounts } = await import("../lib/calibration/report");
  const { getMatchups, getNflState } = await import("../lib/sleeper/client");
  const { listLeagueTargets } = await import("../lib/leagues/registry");
  const { RECONCILIATION_TOLERANCE } = await import("../lib/analytics/reconciliation");

  const rest = defaultWeeklyAuditRest();
  if (!rest) throw new Error("Supabase env missing");
  // Scoring inputs: the deployed public canonical state route (SCORING_SOURCE_BASE_URL) when set — it exposes each league's
  // canonical raw_scoring + fingerprint for EVERY provider (incl. Yahoo) with no provider credentials — else local canonical state.
  const base = process.env.SCORING_SOURCE_BASE_URL?.replace(/\/$/, "");
  const leagues = base
    ? await Promise.all(listLeagueTargets().map(async (t) => {
        try {
          const j = (await (await fetch(`${base}/api/league/${t.key}/state`)).json()) as { state?: { league?: { raw_scoring?: Record<string, number>; scoring_fingerprint?: string } } };
          const lg = j.state?.league;
          return lg?.raw_scoring && lg.scoring_fingerprint ? { league_slug: t.key, provider: t.provider, scoring_fingerprint: lg.scoring_fingerprint, raw_scoring: lg.raw_scoring, note: `scoring from ${base}` } : { league_slug: t.key, provider: t.provider, scoring_fingerprint: null, raw_scoring: null, note: `deployed state exposed no scoring for ${t.key}` };
        } catch (e) { return { league_slug: t.key, provider: t.provider, scoring_fingerprint: null, raw_scoring: null, note: `scoring fetch failed: ${e instanceof Error ? e.message : String(e)}` }; }
      }))
    : await loadLeagueScoringInputs();
  const report: Record<string, unknown> = { generated_at: new Date().toISOString(), season, weeks, write, nfl_state: await getNflState().catch(() => null), leagues: leagues.map((l) => ({ league_slug: l.league_slug, provider: l.provider, scoring_fingerprint: l.scoring_fingerprint, scoring_available: !!l.raw_scoring, unmapped_yahoo_stats: l.raw_scoring ? Object.keys(l.raw_scoring).filter((k) => k.startsWith("yahoo_stat_")).length : null, note: l.note ?? null })), weeks_out: {} };

  for (const week of weeks) {
    const first = await materializeCalibrationWeek({ season, week, leagues, rest, write });
    const second = write ? await materializeCalibrationWeek({ season, week, leagues, rest, write: true }) : null;
    const rows = await readCurrentCases(rest, { season, week });
    const perLeague: Record<string, unknown> = {};
    for (const l of leagues) {
      const lr = rows.filter((r) => r.league_slug === l.league_slug);
      perLeague[l.league_slug] = { provider: l.provider, scoring_fingerprint: l.scoring_fingerprint, total_cases: lr.length, status_counts: statusCounts(lr), participation: Object.fromEntries([...new Set(lr.map((r) => r.participation_state))].map((s) => [s, lr.filter((r) => r.participation_state === s).length])), with_actual: lr.filter((r) => r.actual_fantasy_points != null).length, with_certified_projection: lr.filter((r) => r.projection_artifact_id != null).length, artifact_kinds: Object.fromEntries([...new Set(lr.map((r) => r.projection_artifact_kind ?? "NONE"))].map((k) => [k, lr.filter((r) => (r.projection_artifact_kind ?? "NONE") === k).length])), metrics: buildCalibrationReport(lr, []).groups[0]?.metrics ?? null };
    }

    // Reconciliation against provider team totals (Sleeper only: Yahoo historical matchups are not retrievable/persisted for this week).
    const reconciliation: Record<string, unknown> = {};
    for (const l of leagues) {
      const t = listLeagueTargets().find((x) => x.key === l.league_slug)!;
      if (t.provider !== "sleeper") { reconciliation[l.league_slug] = { status: "UNAVAILABLE", reason: `${t.provider}: no retrievable provider team totals for week ${week} (canonical state exposes the current week only; no persisted Yahoo snapshot for this week)` }; continue; }
      const lr = rows.filter((r) => r.league_slug === l.league_slug);
      const bySid = new Map(lr.map((r) => [r.provider_player_ids.sleeper_id?.toUpperCase() ?? "", r]));
      const matchups = await getMatchups(t.league_id, week).catch(() => []);
      const out = matchups.filter((m) => typeof m.points === "number").map((m) => {
        const starters = (m.starters ?? []).filter((id) => id !== "0");
        let sum = 0, missing = 0, kdst = 0, kdstDelta = 0;
        for (const id of starters) {
          const c = bySid.get(id.toUpperCase());
          if (!c || c.actual_fantasy_points == null) { missing++; continue; }
          sum += c.actual_fantasy_points;
          if (c.position === "K" || c.position === "DEF") { kdst++; kdstDelta += c.actual_fantasy_points - (m.players_points?.[id] ?? c.actual_fantasy_points); }
        }
        const diff = Math.round((sum - (m.points as number)) * 100) / 100;
        const offenseDiff = Math.round((diff - kdstDelta) * 100) / 100;
        return { roster_id: m.roster_id, reported: m.points, ledger_sum: Math.round(sum * 100) / 100, diff, within_tolerance: Math.abs(diff) <= RECONCILIATION_TOLERANCE, starters: starters.length, starters_missing_from_ledger: missing, kdst_starters: kdst, diff_excluding_kdst_delta: offenseDiff, within_tolerance_excluding_kdst: Math.abs(offenseDiff) <= RECONCILIATION_TOLERANCE };
      });
      reconciliation[l.league_slug] = { status: out.length ? "CHECKED" : "NO_MATCHUPS", tolerance: RECONCILIATION_TOLERANCE, rosters: out.length, within_tolerance: out.filter((r) => r.within_tolerance).length, within_tolerance_excluding_kdst: out.filter((r) => r.within_tolerance_excluding_kdst).length, exceptions: out.filter((r) => !r.within_tolerance) };
    }

    (report.weeks_out as Record<string, unknown>)[String(week)] = {
      games_total: first.summary.games_total, games_final: first.summary.games_final, games_missing_kickoff: first.summary.games_missing_kickoff,
      games: first.games.map((g) => ({ id: g.nfl_game_id, matchup: `${g.away_team}@${g.home_team}`, kickoff_at: g.kickoff_at, status: g.status })),
      first_run: first.summary, second_run_idempotency: second ? { cases_built: second.summary.cases_built, cases_written: second.summary.writes.cases, unchanged: second.summary.unchanged } : null,
      ledger_rows_current: rows.length, status_counts: statusCounts(rows), by_league: perLeague, reconciliation,
    };
  }
  const json = JSON.stringify(report, null, 2);
  if (outFile) writeFileSync(outFile, json);
  else console.log(json);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
