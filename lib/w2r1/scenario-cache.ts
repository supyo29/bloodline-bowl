/**
 * W2.R1 S9: per-request memoization of the pure roster-scenario optimizer. Dynamic VOR evaluates the SAME scenarios many times (the "with everyone" lineup is identical for
 * every focal player and for the weekly / streaming / ROS / hold passes). Results are keyed by the exact scenario content, scoped to the (rules, roster) object identity of ONE
 * request (WeakMap: nothing survives the request, so freshness is never traded for speed). Equivalence with the uncached frozen implementation is test-enforced.
 * CONTRACT: callers treat the returned objects as read-only and do not mutate rules / roster / candidates during a request.
 */
import { activeLimit, scenarioLineup, topCandidates, type ScenarioInput } from "./roster";
import type { LeagueRules, MarketCandidate, RosterAsset } from "./evidence";

type Res = ReturnType<typeof scenarioLineup>;
const scen = new WeakMap<LeagueRules, WeakMap<RosterAsset[], Map<string, Res>>>();
export const cacheStats = { scenarioHits: 0, scenarioMisses: 0, topHits: 0, topMisses: 0 };

export function cachedScenarioLineup(s: ScenarioInput): Res {
  let byRoster = scen.get(s.rules); if (!byRoster) scen.set(s.rules, (byRoster = new WeakMap()));
  let m = byRoster.get(s.roster); if (!m) byRoster.set(s.roster, (m = new Map()));
  // canonical key: only the adds that can actually ENTER (an open active spot is required) matter; the rest are ignored by scenarioLineup (it only reports them in dropped_for_capacity, which Dynamic VOR never reads)
  const kept = s.roster.filter((a) => a.player_id !== s.removeId); const active = kept.filter((a) => a.status === "STARTER" || a.status === "BENCH").length;
  const room = Math.max(0, activeLimit(s.rules) - active); const entering = (s.adds ?? []).filter((c) => !kept.some((a) => a.player_id === c.player_id)).slice(0, room);
  const key = `${s.week}|${s.kind}|${s.removeId ?? ""}|${entering.map((c) => c.player_id).join(",")}|${s.valueOverride ? `${s.valueOverride.id}:${s.valueOverride.kind}` : ""}`;
  const hit = m.get(key); if (hit) { cacheStats.scenarioHits++; return hit; }
  cacheStats.scenarioMisses++; const r = scenarioLineup(s); m.set(key, r); return r;
}
const tops = new WeakMap<MarketCandidate[], Map<string, MarketCandidate[]>>();
export function cachedTopCandidates(pool: MarketCandidate[], week: number, k: number): MarketCandidate[] {
  let m = tops.get(pool); if (!m) tops.set(pool, (m = new Map()));
  const key = `${week}|${k}`; const hit = m.get(key); if (hit) { cacheStats.topHits++; return hit; }
  cacheStats.topMisses++; const r = topCandidates(pool, week, k); m.set(key, r); return r;
}
