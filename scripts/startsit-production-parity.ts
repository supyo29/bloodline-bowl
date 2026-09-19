/**
 * Phase 3.5A — production-parity snapshot (read-only).
 *
 *   npx tsx scripts/startsit-production-parity.ts <out.json> [league manager]
 *
 * Runs the real weekly-intelligence builder for one league/manager and hashes
 * ONLY the production sections (lineup, start_sit, waivers, matchup,
 * matchup_leverage, positional_needs). start_sit_shadow is deliberately excluded:
 * it is the shadow surface. Run before and after a change; equal hashes prove the
 * production output is value-identical. Volatile timestamps are stripped.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { buildWeeklyIntelligence } from "../lib/weekly/intelligence";
import { MemoryShadowCaptureStore, setShadowCaptureStore, getCaptureHealth } from "../lib/weekly/start-sit-fi";

// PARITY_STORE=memory|boom|slow exercises the live capture path with an injectable store.
const mode = process.env.PARITY_STORE;
const mem = new MemoryShadowCaptureStore();
if (mode === "memory") setShadowCaptureStore(mem);
if (mode === "boom") setShadowCaptureStore({ kind: "boom", durable: true, record: () => { throw new Error("simulated store outage"); } });
if (mode === "slow") setShadowCaptureStore({ kind: "slow", durable: true, record: () => new Promise(() => undefined) });

const VOLATILE = new Set(["generated_at", "decision_generated_at", "as_of", "fetched_at", "captured_at"]);
function strip(v: unknown): unknown {
  if (v instanceof Map) return strip(Object.fromEntries(v));
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) if (!VOLATILE.has(k) && !k.endsWith("_at")) o[k] = strip((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}
const h = (x: unknown) => createHash("sha256").update(JSON.stringify(strip(x))).digest("hex").slice(0, 16);

async function main() {
  const [out, league = "bloodline-bowl", manager = "supyo29"] = process.argv.slice(2);
  const r = await buildWeeklyIntelligence(league, manager);
  const i = r.intelligence;
  const snap = {
    league, manager, ok: r.ok, status: r.status, code: r.code ?? null,
    week: i?.week ?? null,
    hashes: i ? {
      lineup: h(i.lineup), start_sit: h(i.start_sit), waivers: h(i.waivers),
      matchup: h(i.matchup), matchup_leverage: h(i.matchup_leverage), positional_needs: h(i.positional_needs),
    } : null,
    lineup_total: i?.lineup?.optimal_total ?? null,
    shadow_deployment: i?.start_sit_shadow?.lineage.deployment ?? null,
    capture: { mode: mode ?? "default", health: getCaptureHealth(), memory_records: [...mem.records.values()].map((r) => ({ id: r.capture_id, kind: r.capture_kind, verdict: r.lock_evidence?.verdict, reason: r.lock_evidence?.reason })) },
    shadow_eligible_to_influence: i?.start_sit_shadow?.shadow_football_intelligence.eligible_to_influence_production ?? null,
  };
  if (out) writeFileSync(out, JSON.stringify(snap, null, 2));
  console.log(JSON.stringify(snap, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
