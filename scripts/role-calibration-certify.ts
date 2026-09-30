/**
 * Projection Calibration Phase 2 — materialize + certify Role & Opportunity evidence against production.
 *
 *   ENV_FILE=/path/.env.prod SCORING_SOURCE_BASE_URL=https://<deployment> npx tsx scripts/role-calibration-certify.ts <season> <weeks,csv> [--write] [--out file.json]
 *
 * Reconstructs labeled AS_OF forecasts for completed weeks that predate this system, persists them (insert-only) with --write, joins them to the
 * Phase-1 ledger into analysis rows, re-runs to prove idempotency, reads back, and emits the full report. Secrets come from ENV_FILE; never printed.
 */
import { readFileSync, writeFileSync } from "node:fs";
function loadEnv(file: string | undefined) { if (!file) return; for (const l of readFileSync(file, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !l.trim().startsWith("#")) process.env[m[1]!] = m[2]!; } }
async function main() {
  loadEnv(process.env.ENV_FILE);
  const args = process.argv.slice(2); const season = Number(args[0] ?? 2026); const weeks = (args[1] ?? "3").split(",").map(Number);
  const write = args.includes("--write"); const oi = args.indexOf("--out"); const outFile = oi >= 0 ? args[oi + 1] : null;
  const { defaultWeeklyAuditRest } = await import("../lib/persistence/supabase/weekly-audit-store");
  const { listLeagueTargets } = await import("../lib/leagues/registry");
  const { materializeRoleAnalysis, forecastsForWeek } = await import("../lib/role-calibration/materialize");
  const { readCurrentAnalysis } = await import("../lib/role-calibration/store");
  const { roleReport } = await import("../lib/role-calibration/report");
  const rest = defaultWeeklyAuditRest(); if (!rest) throw new Error("Supabase env missing");
  const base = process.env.SCORING_SOURCE_BASE_URL?.replace(/\/$/, ""); if (!base) throw new Error("SCORING_SOURCE_BASE_URL required");
  const leagues = await Promise.all(listLeagueTargets().map(async (t) => {
    const j = (await (await fetch(`${base}/api/league/${t.key}/state`)).json()) as { state?: { league?: { raw_scoring?: Record<string, number>; scoring_fingerprint?: string } } };
    const lg = j.state?.league;
    return lg?.raw_scoring && lg.scoring_fingerprint ? { league_slug: t.key, provider: t.provider, scoring_fingerprint: lg.scoring_fingerprint, raw_scoring: lg.raw_scoring } : { league_slug: t.key, provider: t.provider, scoring_fingerprint: null, raw_scoring: null, note: "no scoring" };
  }));
  const out: Record<string, unknown> = { generated_at: new Date().toISOString(), season, weeks, write, weeks_out: {} };
  for (const week of weeks) {
    const fw = await forecastsForWeek(rest, season, week);
    const first = await materializeRoleAnalysis({ season, week, leagues, rest, write, reconstructMissing: true });
    const second = write ? await materializeRoleAnalysis({ season, week, leagues, rest, write: true, reconstructMissing: true }) : null;
    const persisted = await readCurrentAnalysis(rest, season, week);
    (out.weeks_out as Record<string, unknown>)[String(week)] = { forecasts_before_run: { persisted: fw.persisted, reconstructed_needed: fw.reconstructed }, first_run: first.summary, second_run_idempotency: second?.summary ?? null, persisted_current_rows: persisted.length, report: roleReport(persisted.length ? persisted : first.rows) };
  }
  const json = JSON.stringify(out, null, 2); if (outFile) writeFileSync(outFile, json); else console.log(json);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
