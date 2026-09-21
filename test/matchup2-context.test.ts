import test from "node:test";
import assert from "node:assert/strict";
import { buildLeagueContext, buildMatchupContext } from "@/lib/matchup2/context";
import { FEATURE_FAMILIES } from "@/lib/matchup2/registry";
import { mkSource } from "./fixtures/matchup2";

test("context: built once per source, deterministic identity, excludes volatile inputs", () => {
  const s = mkSource(); const a = buildMatchupContext(s, { offense_team: "T00", defense_team: "T05", week: 3 }); const b = buildMatchupContext(mkSource(), { offense_team: "t00", defense_team: "t05", week: 3 });
  assert.equal(a.context_identity, b.context_identity); assert.equal(buildLeagueContext(s), buildLeagueContext(s), "league context memoized per source: no per-player rebuild"); assert.equal(a.league.teams.length, 32);
  assert.notEqual(a.context_identity, buildMatchupContext(s, { offense_team: "T00", defense_team: "T06", week: 3 }).context_identity);
  assert.notEqual(a.context_identity, buildMatchupContext(s, { offense_team: "T00", defense_team: "T05", week: 4 }).context_identity);
  assert.notEqual(a.context_identity, buildMatchupContext(s, { offense_team: "T00", defense_team: "T05", week: 3, scoring_fingerprint: "scoring:v1:x" }).context_identity);
  const v = mkSource({ vintages: [{ source: "football-intelligence", version: "fi:NEW", season: 2026, through_week: 3, availability: "LIVE_CURRENT" }] });
  assert.notEqual(a.context_identity, buildMatchupContext(v, { offense_team: "T00", defense_team: "T05", week: 3 }).context_identity, "a new source vintage is a new context");
});
test("registry: every family is classified; unsupported/unsafe families are never fit-eligible; descriptive families never fit-eligible", () => {
  assert.ok(FEATURE_FAMILIES.length >= 14);
  for (const f of FEATURE_FAMILIES) { assert.ok(f.history_class && f.predictive_class && f.origin, f.id); if (f.predictive_class !== "PREDICTIVE_CANDIDATE_UNVALIDATED") assert.equal(f.fit_eligible, false, f.id); if (f.history_class === "UNSAFE_FOR_BACKTEST" || f.history_class === "RETROSPECTIVE_ONLY") assert.equal(f.fit_eligible, false, f.id); }
  for (const id of ["assignment.cornerback", "alignment.slot_boundary", "history.player_vs_defense"]) { const f = FEATURE_FAMILIES.find((x) => x.id === id)!; assert.equal(f.origin, "UNSUPPORTED"); assert.equal(f.predictive_class, "UNSUPPORTED"); }
});
import { normalizeTeam } from "@/lib/matchup2/stats";
test("team codes: Player-Scheme directory aliases normalize to Football Intelligence codes; free agents have no team", () => {
  assert.equal(normalizeTeam("KCC"), "KC"); assert.equal(normalizeTeam("gbp"), "GB"); assert.equal(normalizeTeam("JAC"), "JAX"); assert.equal(normalizeTeam("LA"), "LAR"); assert.equal(normalizeTeam("DAL"), "DAL"); assert.equal(normalizeTeam("FA"), null); assert.equal(normalizeTeam(""), null); assert.equal(normalizeTeam(null), null);
});
import { readFileSync as rf, readdirSync as rd, statSync as st } from "node:fs";
import { join as jn } from "node:path";
test("PRODUCTION ISOLATION: only the Book-Ready adapter layer, the persistence capture path and the cron route import lib/matchup2; production matchup/lineup/Start-Sit/waivers/trades never do; the substrate is read-only", () => {
  const walk = (d: string): string[] => rd(d).flatMap((f) => { const p = jn(d, f); return st(p).isDirectory() ? (f === "node_modules" || f === ".next" ? [] : walk(p)) : /\.tsx?$/.test(f) ? [p] : []; });
  const importers = [...walk("app"), ...walk("lib")].filter((f) => !f.startsWith("lib/matchup2/") && /@\/lib\/matchup2/.test(rf(f, "utf8"))).sort();
  assert.deepEqual(importers, ["lib/book-ready/families/matchup2.ts", "lib/book-ready/query.ts", "lib/persistence/supabase/matchup2-capture.ts"]);
  for (const dir of ["lib/weekly", "lib/canonical", "lib/orchestrator", "lib/trades", "lib/waiver2", "lib/team-state", "lib/roster-health", "lib/schedule-planning", "lib/providers"]) for (const g of walk(dir)) assert.doesNotMatch(rf(g, "utf8"), /lib\/matchup2/, g);
  for (const f of walk("lib/matchup2")) { const s = rf(f, "utf8"); assert.doesNotMatch(s, /\bfetch\(|supabase|process\.env|writeFileSync|\.insert\(/i, `${f}: the substrate performs no I/O beyond reading served artifacts`); assert.doesNotMatch(s, /@\/lib\/(weekly|trades|orchestrator|waiver2|book-ready|analysis-book|persistence)/, `${f}: depends on no consumer`); }
  const wk = rf("lib/weekly/matchup.ts", "utf8") + rf("lib/weekly/matchup-intelligence/build.ts", "utf8"); assert.doesNotMatch(wk, /matchup2/, "production matchup and Matchup Intelligence v1 are unchanged by Phase 5");
});
