/**
 * Phase 3.5A Checkpoint F -- export VALID captured evidence (LIVE_CAPTURED only) + outcomes for the R
 * candidate evaluation (analysis/football_intel_startsit/reevaluate.R). Read-only.
 *   npx tsx scripts/startsit-export-captured-evidence.ts [outDir]
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Without them nothing is written and it exits non-zero,
 * so the evaluation fails closed (no evidence => no candidate run).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSupabaseConfig, SupabaseRest } from "../lib/persistence/supabase/rest";
import { SupabaseShadowCaptureStore } from "../lib/persistence/supabase/shadow-capture";

async function main() {
  const cfg = loadSupabaseConfig();
  if (!cfg.configured || !cfg.config) { console.error("durable store not configured; nothing exported"); process.exitCode = 2; return; }
  const out = process.argv[2] ?? join(process.cwd(), "outputs", "startsit-2026");
  const { records, outcomes } = await new SupabaseShadowCaptureStore(new SupabaseRest(cfg.config)).exportLiveEvidence();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "captured_records.json"), JSON.stringify(records));
  writeFileSync(join(out, "captured_outcomes.json"), JSON.stringify(outcomes));
  console.log(`exported ${records.length} LIVE_CAPTURED records, ${outcomes.length} outcomes`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
