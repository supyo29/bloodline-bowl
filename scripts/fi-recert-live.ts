/**
 * Phase 8 Step 21 — live 2026 FI re-certification snapshot (READ-ONLY; writes nothing, changes no state).
 *   npx tsx scripts/fi-recert-live.ts
 * Compares the served FI snapshot to the LIVE NFL completed-game frontier via the canonical Phase 1 evaluator, then shows, per model
 * family x position, whether each freshness dependency is usable and why the numeric gate is (correctly) closed.
 */
import { loadFootballIntelligence } from "../lib/football-intel";
import { buildFootballIntelligenceLineage } from "../lib/football-intel/lineage";
import { loadNflRealityFrontier } from "../lib/canonical/nfl-reality-frontier";
import { assessIntelligenceFreshness } from "../lib/canonical/intelligence-freshness";
import { loadStartSitModel } from "../lib/weekly/start-sit-fi";
import { evaluateFamilyGate } from "../lib/weekly/start-sit-fi/family-gate";
import { getNflState } from "../lib/sleeper/client";

async function main() {
  const fi = loadFootballIntelligence(); const lin = buildFootballIntelligenceLineage(fi); const model = loadStartSitModel(true);
  if (!fi || !lin || !model) throw new Error("FI or model unavailable");
  const state = await getNflState().catch(() => null); const season = lin.season; const reality = await loadNflRealityFrontier(season);
  const snapshot = { league_snapshot_id: "live", snapshot_schema_version: 3, content_hash: "live", generated_at: new Date().toISOString(), provider: "sleeper", league_slug: "bloodline-bowl", league_id: "1", season, week: state?.week ?? lin.through_week, scoring_fingerprint: "scoring:v1:live", roster_fingerprint: "r", player_data_version: "p", crosswalk_version: null };
  const lineage = { snapshot, projections: [], football_intelligence: lin, engine_versions: { fi_recert: "1" } } as never;
  const withReality = assessIntelligenceFreshness({ lineage, operation: "START_SIT", ...(reality ? { nfl_reality: reality } : {}) });
  const noReality = assessIntelligenceFreshness({ lineage, operation: "START_SIT" });
  console.log(JSON.stringify({ fi_version: lin.version, through_week: lin.through_week, week_state: lin.week_completion?.week_state, games: `${lin.week_completion?.games_completed_in_latest_week}/${lin.week_completion?.games_scheduled_in_latest_week}`, data_cutoff: lin.data_cutoff, provider_nominal_week: state?.week ?? null,
    live_frontier: reality, freshness_with_frontier: { overall: withReality.overall_status, usable: withReality.usable, fallback_required: withReality.fallback_required, confidence_cap: withReality.confidence_cap, reasons: withReality.reasons.map((r) => `${r.code}:${r.severity}`) },
    freshness_without_frontier_as_shadow_path_calls_it: { overall: noReality.overall_status, reasons: noReality.reasons.map((r) => `${r.code}:${r.severity}`) },
    families: withReality.feature_families.map((f) => `${f.family}:${f.availability}/${f.lag_classification}(cutoff ${f.data_cutoff_week})`) }, null, 1));
  const decisionWeek = (state?.week ?? lin.through_week + 1);
  const rows: string[] = []; let allowed = 0;
  for (const [pos, mp] of Object.entries(model.positions)) for (const f of mp.families) {
    const g = evaluateFamilyGate(model, f.family, pos, { operation: "START_SIT", freshness: withReality, scoring_fingerprint: "scoring:v1:live", temporal_membership_resolved: true, decision_week: decisionWeek, fi_through_week: lin.through_week });
    if (g.allowed) allowed++;
    rows.push(`${pos} ${f.family.padEnd(38)} sources_ok=${g.freshness_dependencies.every((d) => d.ok)} [${g.freshness_dependencies.map((d) => `${d.family}:${d.lag_classification}`).join(",")}] blocked_by=${g.reasons.join(",")}`);
  }
  console.log(rows.join("\n")); console.log(`\nfamily x position served-model gates evaluated: ${rows.length}; ALLOWED: ${allowed}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
