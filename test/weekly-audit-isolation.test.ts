/**
 * Phase 9 Steps 10/54/58 — production isolation + Phase 8 negative-result durability. The weekly audit is
 * downstream telemetry: production/recommendation modules must never import it, and nothing in Phase 9 can ever
 * promote a CERTIFICATION_FAILED FI family.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fiRetestProgress, assertNoAutoPromotion, FI_PROSPECTIVE_GATE } from "@/lib/weekly-audit/gates";
import { loadFiCertification } from "@/lib/weekly/start-sit-fi/certification";
import { isValidTransition } from "@/lib/weekly/start-sit-fi/deployment";

const walk = (dir: string, out: string[] = []): string[] => { for (const n of readdirSync(dir)) { const f = join(dir, n); const s = statSync(f); if (s.isDirectory()) { if (!["node_modules", ".next", "data"].includes(n)) walk(f, out); } else if (/\.(ts|tsx)$/.test(n)) out.push(f); } return out; };

describe("production isolation — allowed direction is production/captures -> weekly audit, never the reverse", () => {
  const prod = ["lib", "app"].flatMap((d) => walk(join(process.cwd(), d))).filter((f) => !f.includes(join("lib", "weekly-audit")) && !f.includes(join("app", "api", "cron", "weekly-audit")) && !f.includes(join("lib", "book-ready", "families", "weekly-audit.ts")) && !f.endsWith(join("persistence", "supabase", "weekly-audit-store.ts")) && !f.endsWith(join("lib", "book-ready", "query.ts")));
  test("no production/recommendation module imports lib/weekly-audit (Book-Ready's own reader family is the one sanctioned exception, itself excluded above)", () => {
    const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const offenders = prod.filter((f) => /weekly-audit\//.test(code(f)) || /buildWeeklyModelAudit\(/.test(code(f)));
    assert.deepEqual(offenders, []);
  });
  test("lineup/start-sit/waivers/matchup/matchup2/orchestrator never reference weekly-audit calibration or research-candidate types", () => {
    const scoped = prod.filter((f) => /lib[\\/](weekly[\\/](lineup|start-sit|waivers|matchup|matchup-intelligence)|matchup2|orchestrator|waiver2)/.test(f));
    for (const f of scoped) assert.ok(!/ResearchCandidate|WeeklyModelAudit|weekly-audit/.test(readFileSync(f, "utf8")), f);
  });
  test("the Book-Ready weekly-audit family is a READER ONLY: it never IMPORTS the builder (which would let a request trigger a write)", () => {
    const src = readFileSync("lib/book-ready/families/weekly-audit.ts", "utf8");
    assert.ok(!/from ["']@\/lib\/weekly-audit\/build["']/.test(src) && !/import\(["']@\/lib\/weekly-audit\/build["']\)/.test(src));
  });
  test("the cron route is the only writer: no other route imports lib/weekly-audit/build", () => {
    const routes = walk(join(process.cwd(), "app", "api")).filter((f) => f.endsWith("route.ts") && !f.includes(join("cron", "weekly-audit")));
    for (const f of routes) assert.ok(!/weekly-audit\/build/.test(readFileSync(f, "utf8")), f);
  });
});

describe("Phase 8 negative-result durability — weekly audit can only MONITOR, never promote", () => {
  test("real committed certification: all 30 candidates stay CERTIFICATION_FAILED after computing retest progress", () => {
    const cert = loadFiCertification();
    const progress = fiRetestProgress(cert, 0, new Map());
    assert.equal(progress.length, 30);
    for (const p of progress) assert.equal(p.certification_state, "CERTIFICATION_FAILED");
    assertNoAutoPromotion(progress); // throws if any state is not FAILED/SHADOW_ONLY
  });
  test("even a hypothetical week with overwhelming prospective evidence only flips the SIGNAL, never the certification_state", () => {
    const cert = loadFiCertification();
    const huge = new Map<string, { count: number; weeks: Set<number> }>();
    for (const c of cert!.candidates) huge.set(`${c.position}|${c.family}`, { count: 10_000, weeks: new Set([1, 2, 3, 4, 5, 6, 7, 8]) });
    const progress = fiRetestProgress(cert, 10, huge);
    for (const p of progress) { assert.equal(p.certification_state, "CERTIFICATION_FAILED"); assert.equal(p.retest_signal, "RETEST_READY"); }
    assertNoAutoPromotion(progress);
  });
  test("assertNoAutoPromotion throws if a state were ever anything other than FAILED/SHADOW_ONLY — proves the guard is live, not vacuous", () => {
    assert.throws(() => assertNoAutoPromotion([{ family: "x", position: "WR", certification_state: "PRODUCTION_ACTIVE", qualifying_weeks: 0, live_decisions: 0, required_weeks: 4, required_decisions: 150, retest_signal: "RETEST_READY" }]));
  });
  test("FI_PROSPECTIVE_GATE reproduces Phase 8's pre-registered thresholds verbatim (4 weeks / 150 decisions / 3 weeks represented)", () => {
    assert.deepEqual(FI_PROSPECTIVE_GATE, { required_qualifying_weeks: 4, required_decisions_per_candidate: 150, required_distinct_weeks_represented: 3 });
  });
  test("no code path outside analysis/football_intel_phase8 writes the certification artifact (single-writer invariant, re-verified)", () => {
    const hits = walk(join(process.cwd(), "lib")).concat(walk(join(process.cwd(), "app"))).filter((f) => readFileSync(f, "utf8").includes("fi_certification_2026") && /writeFileSync|write_json/.test(readFileSync(f, "utf8")));
    assert.deepEqual(hits, []);
  });
  test("lifecycle transitions stay legal: CERTIFICATION_FAILED can only go to SHADOW_ONLY or RESEARCH_ELIGIBLE (a fresh re-certification), never PRODUCTION_ELIGIBLE/ACTIVE directly", () => {
    assert.equal(isValidTransition("CERTIFICATION_FAILED", "RESEARCH_ELIGIBLE"), true);
    assert.equal(isValidTransition("CERTIFICATION_FAILED", "PRODUCTION_ELIGIBLE"), false);
    assert.equal(isValidTransition("CERTIFICATION_FAILED", "PRODUCTION_ACTIVE"), false);
  });
});
