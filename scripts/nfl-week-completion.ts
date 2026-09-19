/**
 * Phase 3.5A -- emit the authoritative per-week NFL completion artifact that the
 * R evidence gate (analysis/football_intel_startsit/eligibility.R) consumes.
 *
 *   npx tsx scripts/nfl-week-completion.ts [season] [outPath]
 *
 * R never re-derives "is the week complete"; it reads this file, produced by the
 * frozen Phase 1 completion predicate (lib/canonical/nfl-reality-frontier.ts).
 * On any fetch failure it writes `{ available: false }` -- the gate then fails
 * closed for every week.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadNflSeasonCompletion } from "../lib/canonical/nfl-reality-frontier";

async function main() {
  const season = Number(process.argv[2] ?? 2026);
  const out = process.argv[3] ?? join(process.cwd(), "outputs", "startsit-2026", "nfl_week_completion.json");
  const c = await loadNflSeasonCompletion(season);
  const payload = c ? { available: true, ...c } : { available: false, season, as_of: new Date().toISOString(), weeks: [] };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(payload, null, 2));
  console.log(`nfl_week_completion season=${season} available=${payload.available} weeks=${payload.weeks.length} -> ${out}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
