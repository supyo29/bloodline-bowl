/** W2.P1 Role evidence coverage (descriptive; as-of profiles for DEV+VAL target weeks only; no outcome labels used). Run: node --import tsx scripts/w2p1/coverage.ts */
import { readFileSync } from "node:fs";
import { buildHistoricalForecasts } from "../../lib/game-distribution/fit";
import { loadInjuryReports, parseObservedCsv, parseProfileCsv } from "../../lib/role-calibration/data";
import { SPLIT_WEEKS } from "../lib/role-qualification";

const D = "lib/game-distribution/data/";
const weeks = [...SPLIT_WEEKS.DEV, ...SPLIT_WEEKS.VAL];
const observed = parseObservedCsv(readFileSync(D + "observed_role_game_2025.csv", "utf8")).filter((o) => o.season === 2025);
const profiles = parseProfileCsv(readFileSync(D + "role_profile_asof_2025.csv", "utf8")).filter((p) => weeks.includes(p.target_week));
const fs = buildHistoricalForecasts({ season: 2025, profiles, observed, injuries: loadInjuryReports(), weeks });
const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);
const out: Record<string, unknown> = {};
for (const pos of ["QB", "RB", "WR", "TE"]) {
  const f = fs.filter((x) => x.position === pos);
  const byConf = Object.fromEntries(["MEDIUM", "LOW", "INSUFFICIENT_SAMPLE"].map((c) => [c, f.filter((x) => x.confidence === c).length]));
  const early = f.filter((x) => (x.provenance as { games_before_target_season?: number }).games_before_target_season! < 3);
  const disc = f.filter((x) => Object.values(x.metrics).some((m) => (m?.discontinuity ?? "NONE") !== "NONE"));
  const routeAvail = pos === "QB" || pos === "RB" ? null : pct(f.filter((x) => x.metrics.route_participation?.value != null).length, f.length);
  out[pos] = { profiles: f.length, confidence: byConf, pct_with_applicable_evidence: pct(f.length - byConf.INSUFFICIENT_SAMPLE!, f.length), pct_early_season_lt3_games: pct(early.length, f.length), pct_with_discontinuity_flag: pct(disc.length, f.length), pct_route_participation_available: routeAvail, depth_chart_snapshot_available_pct: pct(f.filter((x) => x.depth.snapshot_at != null).length, f.length) };
}
console.log(JSON.stringify({ weeks, source: "role_profile_asof_2025.csv", note: "route participation exists for 2025 (nflverse participation published); depth charts do not exist before 2026-08-25", ...out }, null, 1));
