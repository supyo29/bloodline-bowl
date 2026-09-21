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
