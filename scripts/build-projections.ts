/**
 * Build the 2026 Roster Intel projections and write the audit artifacts.
 *
 *   npx tsx scripts/build-projections.ts [--league <slug,slug>] [--season 2026]
 *
 * Outputs under outputs/projections-<season>/:
 *   player_projections.csv            Layer 1, scoring-neutral, one row per player
 *   projection_comparison.csv         RI vs Sleeper per player + primary_driver
 *   projection_disagreement.csv       per-position aggregate disagreement
 *   projection_disagreement_report.md
 *   team_reconciliation.csv           residual team-level reconciliation (as served)
 *   league_projections_<slug>.csv     Layer 2 for each requested league
 *   projection_backtest.csv           RI core vs baselines, genuinely out-of-sample
 *   projection_source_coverage.csv    Sleeper benchmark provider diagnostics
 *   FINAL_PROJECTION_AUDIT.md         human-readable summary + freeze inputs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildBaseProjections, buildLeagueProjections } from "@/lib/projections/build";
import { loadLeagueConfig } from "@/lib/projections/service";
import { loadSeasonActuals } from "@/lib/projections/actuals";
import { buildBacktestRows, scoreBacktest } from "@/lib/projections/backtest";
import { getPlayerIndex } from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";

const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const season = Number(argValue("--season") ?? 2026);
const leagueSlugs = (argValue("--league") ?? "bloodline-bowl,devoted-to-the-game").split(",").map((s) => s.trim());
const OUT_DIR = join("outputs", `projections-${season}`);

function csv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n") + "\n";
}
function write(name: string, content: string): void {
  writeFileSync(join(OUT_DIR, name), content);
  console.log("  wrote", join(OUT_DIR, name));
}
const round = (v: unknown) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Building Roster Intel projections for ${season}…`);
  const base = await buildBaseProjections({ season });
  console.log(`  ${base.projections.size} player projections, benchmark ${base.benchmark.status}`);

  write("player_projections.csv", csv([...base.projections.values()]
    .sort((a, b) => b.neutral_points - a.neutral_points)
    .map((p) => ({
      player_id: p.player_id, name: p.full_name, position: p.position, team: p.team,
      age: p.age, years_exp: p.years_exp,
      neutral_points: p.neutral_points, neutral_ppg: p.neutral_ppg,
      floor: p.outcome.floor, median: p.outcome.median, ceiling: p.outcome.ceiling, sd: p.outcome.sd,
      expected_games: p.availability.expected_games, availability_p: p.availability.availability_probability,
      confidence: p.confidence.bucket, confidence_score: p.confidence.score,
      snap_share: p.components.snap_share, target_share: p.components.target_share, carry_share: p.components.carry_share,
      pass_att: p.stats.pass_att, pass_yd: p.stats.pass_yd, pass_td: p.stats.pass_td, pass_int: p.stats.pass_int,
      rush_att: p.stats.rush_att, rush_yd: p.stats.rush_yd, rush_td: p.stats.rush_td,
      targets: p.stats.targets, rec: p.stats.rec, rec_yd: p.stats.rec_yd, rec_td: p.stats.rec_td,
      warnings: p.warnings.join(" | "),
    }))));

  write("projection_comparison.csv", csv([...base.comparisons.values()]
    .filter((c) => c.has_benchmark)
    .sort((a, b) => Math.abs(b.neutral_delta_pct ?? 0) - Math.abs(a.neutral_delta_pct ?? 0))
    .map((c) => ({
      player_id: c.player_id, name: c.full_name, position: c.position, team: c.team,
      ri_neutral_points: c.ri_neutral_points, sleeper_ppr_points: c.sleeper_ppr_points,
      neutral_delta: c.neutral_delta, neutral_delta_pct: c.neutral_delta_pct,
      direction: c.direction, primary_driver: c.primary_driver,
      ...Object.fromEntries(c.stat_deltas.flatMap((d) => [[`${d.stat}_ri`, d.ri], [`${d.stat}_sl`, d.sleeper]])),
    }))));

  write("projection_disagreement.csv", csv(base.disagreement_by_position.map((d) => ({
    position: d.position, n: d.n, n_with_benchmark: d.n_with_benchmark,
    mean_abs_delta_pct: d.mean_abs_delta_pct, mean_signed_delta_pct: d.mean_signed_delta_pct,
    material_n: d.material_n, material_mean_abs_delta_pct: d.material_mean_abs_delta_pct,
    material_median_abs_delta_pct: d.material_median_abs_delta_pct, material_mean_signed_delta_pct: d.material_mean_signed_delta_pct,
    ri_above: d.ri_above, ri_below: d.ri_below, agrees: d.agrees,
  }))));

  write("projection_disagreement_report.md", [
    `# Roster Intel vs Sleeper — ${season} disagreement report`, ``,
    `Generated ${base.generated_at}. Sleeper is a BENCHMARK, never a model input.`,
    `"Closer to Sleeper" is not treated as "better" — divergence is a signal, not a correction.`, ``,
    `Benchmark status: **${base.benchmark.status}**, ${base.benchmark.players_matched} players matched.`, ``,
    `"Material" = players Sleeper projects for >= 60 PPR points (the fantasy-relevant set).`,
    `The all-players columns are inflated by deep players Sleeper scores near zero.`, ``,
    `| Pos | material n | material mean \\|Δ%\\| | material median \\|Δ%\\| | material signed Δ% | RI above | RI below | agrees | all-players mean \\|Δ%\\| |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...base.disagreement_by_position.map((d) =>
      `| ${d.position} | ${d.material_n} | ${d.material_mean_abs_delta_pct}% | ${d.material_median_abs_delta_pct}% | ${d.material_mean_signed_delta_pct}% | ${d.ri_above} | ${d.ri_below} | ${d.agrees} | ${d.mean_abs_delta_pct}% |`),
    ``, `## Largest disagreements (material players only)`, ``,
    ...base.disagreement_by_position.flatMap((d) => [
      `### ${d.position}`, ``,
      ...d.biggest_gaps.map((g) => `- **${g.full_name}** ${g.delta_pct > 0 ? "+" : ""}${g.delta_pct}% — ${g.primary_driver}`),
      ``,
    ]),
  ].join("\n"));

  write("team_reconciliation.csv", csv(base.reconciliation_rows.map((r) => ({
    team: r.team, metric: r.metric, team_expectation: round(r.team_expectation),
    player_sum: round(r.player_sum), ratio: r.ratio, tolerance: r.tolerance, status: r.status,
  }))));

  for (const slug of leagueSlugs) {
    try {
      const leagueId = slug === "bloodline-bowl" ? resolveLeagueId()
        : slug === "devoted-to-the-game" ? "1389735763649761280" : slug;
      const cfg = await loadLeagueConfig(slug, leagueId);
      const lp = buildLeagueProjections(base, cfg);
      write(`league_projections_${slug}.csv`, csv(lp.projections.map((p) => ({
        player_id: p.player_id, name: p.full_name, position: p.position, team: p.team,
        league_points: p.league_points, league_ppg: p.league_ppg, sleeper_league_points: p.sleeper_league_points,
        vs_sleeper_delta: p.vs_sleeper.delta_points, vs_sleeper_delta_pct: p.vs_sleeper.delta_pct,
        ri_rank: p.vs_sleeper.ri_rank, sleeper_rank: p.vs_sleeper.sleeper_rank, rank_delta: p.vs_sleeper.rank_delta,
        replacement_points: p.replacement_points, value_over_replacement: p.value_over_replacement,
        position_rank: p.position_rank, overall_rank: p.overall_rank, tier: p.tier, confidence: p.confidence,
        primary_driver: p.vs_sleeper.primary_driver,
      }))));
      console.log(`  ${slug}: scoring_hash ${lp.scoring_hash}, ${lp.projections.length} players`);
    } catch (e) {
      console.warn(`  ${slug}: SKIPPED (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  console.log("Running out-of-sample backtest…");
  const playerIndex = await getPlayerIndex();
  const posAge = new Map<string, { position: "QB" | "RB" | "WR" | "TE" | "K" | "DEF" | null; age: number | null }>();
  const posByPlayer = new Map<string, { position: string | null; team: string | null }>();
  for (const [pid, p] of playerIndex) {
    const raw = (p.position ?? "") as "QB" | "RB" | "WR" | "TE" | "K" | "DEF";
    posAge.set(pid, { position: ["QB", "RB", "WR", "TE", "K", "DEF"].includes(raw) ? raw : null, age: p.age ?? null });
    posByPlayer.set(pid, { position: p.position, team: p.team });
  }
  const seasonsByYear = new Map<number, Awaited<ReturnType<typeof loadSeasonActuals>>>();
  for (const y of [2020, 2021, 2022, 2023, 2024, 2025]) {
    try {
      seasonsByYear.set(y, await loadSeasonActuals(y, posByPlayer));
    } catch {
      console.warn(`  actuals ${y} unavailable`);
    }
  }
  const btRows = buildBacktestRows(seasonsByYear, posAge, [2023, 2024, 2025].filter((y) => seasonsByYear.has(y)));
  const bt = scoreBacktest(btRows);
  write("projection_backtest.csv", csv(bt.metrics.map((m) => ({ ...m }))));
  console.log("  " + bt.sleeper_historical);

  write("projection_source_coverage.csv", csv([{
    provider: "sleeper", role: "BENCHMARK_ONLY", status: base.benchmark.status,
    players_returned: base.benchmark.players_returned, players_usable: base.benchmark.players_usable,
    players_matched: base.benchmark.players_matched, players_unmatched: base.benchmark.players_unmatched,
    source_updated_from: base.benchmark.source_updated_at_range[0], source_updated_to: base.benchmark.source_updated_at_range[1],
    retrieved_at: base.benchmark.retrieved_at, source_schema_version: base.benchmark.source_schema_version,
    missing_expected_keys: base.benchmark.missing_expected_keys.join(" "), warnings: base.benchmark.warnings.join(" | "),
    ...Object.fromEntries(Object.entries(base.benchmark.coverage_by_position).map(([k, v]) => [`coverage_${k}`, v])),
  }]));

  write("FINAL_PROJECTION_AUDIT.md", [
    `# FINAL PROJECTION AUDIT — Roster Intel ${season}`, ``,
    `- projection_version: \`${base.projection_version}\``,
    `- model_version: \`${base.model_version}\`  schema: \`${base.schema_version}\``,
    `- generated_at: ${base.generated_at}`,
    `- data_as_of (historical actuals): ${base.data_as_of}`,
    `- player projections: ${base.projections.size}`, ``,
    `## External benchmark (Sleeper / RotoWire)`, ``,
    `- role: **BENCHMARK_ONLY** — not a model input, not an ensemble member`,
    `- status: **${base.benchmark.status}**`,
    `- returned ${base.benchmark.players_returned}, usable ${base.benchmark.players_usable}, matched ${base.benchmark.players_matched}`,
    `- coverage: ${Object.entries(base.benchmark.coverage_by_position).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    `- source updated ${base.benchmark.source_updated_at_range.join(" … ")}`,
    `- missing expected keys: ${base.benchmark.missing_expected_keys.join(", ") || "none"}`, ``,
    `## Team reconciliation`, ``,
    `- teams checked: ${base.reconciliation.teams_checked}`,
    `- raw model (pre-normalization): ${base.reconciliation_raw.hard_misses.length} HARD, ${base.reconciliation_raw.soft_misses.length} SOFT`,
    `- residual (post-normalization, as served): ${base.reconciliation.hard_misses.length} HARD, ${base.reconciliation.soft_misses.length} SOFT, ${base.reconciliation.ok_count} OK`, ``,
    `## RI vs Sleeper (league-neutral PPR)`, ``,
    `| Pos | material n | material mean |Δ%| | material median |Δ%| | material signed Δ% | all-players mean |Δ%| |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...base.disagreement_by_position.map((d) => `| ${d.position} | ${d.material_n} | ${d.material_mean_abs_delta_pct}% | ${d.material_median_abs_delta_pct}% | ${d.material_mean_signed_delta_pct}% | ${d.mean_abs_delta_pct}% |`),
    ``,
    `A non-zero signed delta is expected — RI is independent of Sleeper. See`,
    `\`projection_disagreement_report.md\` for driver-level detail.`, ``,
    `## Out-of-sample backtest (RI core)`, ``,
    `Fair-backtest rule enforced: season Y projected from seasons ≤ Y-1 only.`, ``,
    `| Method | n | MAE | RMSE | bias | Spearman | beat prev-year |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    ...bt.metrics.map((m) => `| ${m.method} | ${m.n} | ${m.mae} | ${m.rmse} | ${m.bias} | ${m.spearman} | ${m.beat_prev_year_rate ?? "—"} |`),
    ``, `**${bt.sleeper_historical}**`, ``,
    `## Build warnings`, ``,
    ...(base.warnings.length ? base.warnings.map((w) => `- ${w}`) : ["- none"]), ``,
  ].join("\n"));

  console.log("Done →", OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
