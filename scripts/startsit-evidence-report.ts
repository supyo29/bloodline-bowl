/**
 * Phase 3.5A -- write the machine-readable evidence report + the slim capture summary the R
 * evidence gate consumes.
 *
 *   npx tsx scripts/startsit-evidence-report.ts [outDir]
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to read the durable store; without them the
 * summary is written with `available:false` and the gate correctly fails closed on the baseline.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildStartSitEvidenceReport, gateSummary } from "../lib/weekly/start-sit-fi/evidence-report";

async function main() {
  const out = process.argv[2] ?? join(process.cwd(), "outputs", "startsit-2026");
  mkdirSync(out, { recursive: true });
  const report = await buildStartSitEvidenceReport();
  writeFileSync(join(out, "startsit_evidence_report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "shadow_capture_summary.json"), JSON.stringify(gateSummary(report), null, 2));
  console.log(JSON.stringify({ store: report.capture_store, gate: report.evidence_gate?.status, totals: report.evidence_by_class.totals_by_kind }, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
