/**
 * W2.R1 Dynamic VOR decomposition. SHADOW ONLY.
 *
 * Distinct components (never one opaque number):
 *   weekly_roster_vor   optimal expected legal lineup WITH the player minus WITHOUT (full re-optimization; bench, IR returns, FLEX cascade, verified market)
 *   ros_vor             the same counterfactual summed over the remaining horizon with ONE held replacement (future byes, injury horizon, conflicts)
 *   hold_vor            cost of losing the asset regardless of this week's status: the focal player is valued at his UNDERLYING (healthy, playing) value;
 *                       a bye this week NEVER zeroes it
 *   streaming_adjusted_vor   weekly roster VOR summed with the market re-streamed every week (QB/TE/K/DEF matter most)
 *   weekly_league_vor / league_vor   roster-independent: value over the best VERIFIED pool alternative at the position
 *   scarcity_vor        roster-independent: value over the average of the top-5 verified alternatives (pool shape)
 *   market_value_input  roster-independent trade-market INPUT (scarcity basis, underlying values); explicitly NOT private roster value
 *
 * Acquisition realism: FREE_AGENT_ADD verified-addable = certain; WAIVER_CLAIM with unknown competition is NEVER assumed guaranteed. `value` uses only
 * candidates with a known success probability; `low` is the optimistic bound (unknown-probability waivers at 1.0); `high` is the roster-only bound.
 * UNKNOWN weekly values are excluded (never zero); coverage reports how much of the horizon was known.
 */
import { W2R1_LABEL, W2R1_MODEL_VERSION, W2R1_MODE } from "./version";
import type { LeagueRules, MarketCandidate, MarketPool, Pos, RosterAsset } from "./evidence";
import { chainBetween, scenarioLineup, topCandidates, weekValue, type ChainStep } from "./roster";

export interface VorComponent {
  value: number | null;
  /** most optimistic replacement (lowest VOR) */
  low: number | null;
  /** roster-only (no market) bound (highest VOR) */
  high: number | null;
  basis: string;
  /** fraction of horizon weeks with known values (1 = all) */
  coverage: number | null;
  unknown_reason: string | null;
}

export interface WeeklyDetail {
  week: number;
  with_total: number | null;
  without_roster_only: number | null;
  chosen_add: { player_id: string; method: string; success_probability: number | null; faab_cost: number | null } | null;
  chain: ChainStep[];
  activated_from_reserve: string[];
  empty_slots_without: string[];
  provisional: boolean;
  unknown_excluded: string[];
}

export interface DynamicVor {
  label: typeof W2R1_LABEL;
  mode: typeof W2R1_MODE;
  model_version: string;
  player_id: string;
  week: number;
  horizon: { from: number; to: number };
  scoring_fingerprint: string;
  weekly_roster_vor: VorComponent;
  ros_vor: VorComponent;
  hold_vor: VorComponent;
  streaming_adjusted_vor: VorComponent;
  weekly_league_vor: VorComponent;
  league_vor: VorComponent;
  scarcity_vor: VorComponent;
  market_value_input: VorComponent;
  weekly_detail: WeeklyDetail | null;
  market: { provider: string; verified: boolean; freshness: string; candidates_considered: number };
  flags: string[];
}

const TOP_K = 4;
const unknownComponent = (reason: string, basis: string): VorComponent => ({ value: null, low: null, high: null, basis, coverage: null, unknown_reason: reason });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

interface WeekCalc { week: number; withTotal: number; roster_only: number; value: number; low: number; chosen: MarketCandidate | null; detail: WeeklyDetail; known: boolean }

function calcWeek(rules: LeagueRules, roster: RosterAsset[], focal: RosterAsset, week: number, market: MarketPool | null, opts: { focalKind: "lineup" | "underlying"; heldAdd?: MarketCandidate | null }): WeekCalc | null {
  const base = { rules, week, kind: "lineup" as const, roster };
  const focalVal = weekValue(focal, week, opts.focalKind);
  if (focalVal == null) return null; // the focal player's own value is unknown this week: not computable, NEVER zero
  const override = opts.focalKind === "underlying" ? { id: focal.player_id, kind: "underlying" as const } : undefined;
  const withL = scenarioLineup({ ...base, valueOverride: override });
  const withoutL = scenarioLineup({ ...base, removeId: focal.player_id });
  const rosterOnly = withL.total - withoutL.total;
  let value = rosterOnly, low = rosterOnly; let chosen: MarketCandidate | null = null; let chosenLineup = withoutL;
  const cands = opts.heldAdd ? [opts.heldAdd] : market && market.verified ? topCandidates(market.candidates, week, TOP_K) : [];
  const knownP: Array<{ c: MarketCandidate; l: ReturnType<typeof scenarioLineup>; p: number }> = [];
  for (const c of cands) {
    const l = scenarioLineup({ ...base, removeId: focal.player_id, adds: [c] });
    const pr = c.acquisition.success_probability;
    low = Math.min(low, withL.total - l.total); // optimistic: every candidate acquired
    if (pr != null) knownP.push({ c, l, p: pr });
  }
  let bestExpected = withoutL.total;
  for (const k of knownP) {
    const exp = k.p * k.l.total + (1 - k.p) * withoutL.total;
    if (exp > bestExpected + 1e-12) { bestExpected = exp; chosen = k.c; chosenLineup = k.l; }
  }
  value = withL.total - bestExpected;
  const detail: WeeklyDetail = {
    week, with_total: withL.total, without_roster_only: withoutL.total,
    chosen_add: chosen ? { player_id: chosen.player_id, method: chosen.acquisition.method, success_probability: chosen.acquisition.success_probability, faab_cost: chosen.acquisition.faab_cost } : null,
    chain: chainBetween(withL, chosen ? chosenLineup : withoutL), activated_from_reserve: (chosen ? chosenLineup : withoutL).activated_from_reserve,
    empty_slots_without: withoutL.empty_slots, provisional: withL.provisional || withoutL.provisional, unknown_excluded: [...new Set([...withL.unknown_excluded, ...withoutL.unknown_excluded])],
  };
  return { week, withTotal: withL.total, roster_only: rosterOnly, value, low, chosen, detail, known: true };
}

function component(calcs: Array<WeekCalc | null>, horizonLen: number, basis: string): VorComponent {
  const ok = calcs.filter((c): c is WeekCalc => c != null);
  if (ok.length === 0) return unknownComponent("no week of the horizon has a known value for this player", basis);
  return { value: sum(ok.map((c) => c.value)), low: sum(ok.map((c) => Math.min(c.low, c.value))), high: sum(ok.map((c) => c.roster_only)), basis, coverage: ok.length / horizonLen, unknown_reason: ok.length < horizonLen ? "some horizon weeks have unknown values and are excluded (not zero-filled)" : null };
}

function poolLevels(market: MarketPool | null, pos: Pos, week: number): { best: number | null; top5: number | null } {
  if (!market || !market.verified) return { best: null, top5: null };
  const vals = market.candidates.filter((c) => c.position === pos && (c.acquisition.available_from_week == null || c.acquisition.available_from_week <= week))
    .map((c) => weekValue(c, week, "lineup")).filter((v): v is number => v != null).sort((a, b) => b - a);
  if (vals.length === 0) return { best: null, top5: null };
  const t = vals.slice(0, 5);
  return { best: vals[0]!, top5: sum(t) / t.length };
}

export function computeDynamicVor(args: { rules: LeagueRules; roster: RosterAsset[]; playerId: string; week: number; market: MarketPool | null; horizonWeeks?: number }): DynamicVor {
  const { rules, roster, playerId, week, market } = args;
  const focal = roster.find((a) => a.player_id === playerId);
  const to = Math.min(rules.last_week, week + (args.horizonWeeks ?? rules.last_week) - 1);
  const weeks = Array.from({ length: Math.max(0, to - week + 1) }, (_, i) => week + i);
  const flags: string[] = [];
  const mk = (reason: string): DynamicVor => ({
    label: W2R1_LABEL, mode: W2R1_MODE, model_version: W2R1_MODEL_VERSION, player_id: playerId, week, horizon: { from: week, to }, scoring_fingerprint: rules.scoring_fingerprint,
    weekly_roster_vor: unknownComponent(reason, "UNAVAILABLE"), ros_vor: unknownComponent(reason, "UNAVAILABLE"), hold_vor: unknownComponent(reason, "UNAVAILABLE"), streaming_adjusted_vor: unknownComponent(reason, "UNAVAILABLE"),
    weekly_league_vor: unknownComponent(reason, "UNAVAILABLE"), league_vor: unknownComponent(reason, "UNAVAILABLE"), scarcity_vor: unknownComponent(reason, "UNAVAILABLE"), market_value_input: unknownComponent(reason, "UNAVAILABLE"),
    weekly_detail: null, market: { provider: market?.provider ?? "none", verified: market?.verified ?? false, freshness: market?.freshness ?? "UNKNOWN", candidates_considered: 0 }, flags: [reason],
  });
  if (!focal) return mk("PLAYER_NOT_ON_ROSTER");
  if (focal.scoring_fingerprint !== rules.scoring_fingerprint) return mk("SCORING_FINGERPRINT_MISMATCH");
  const mismatch = roster.filter((a) => a.scoring_fingerprint !== rules.scoring_fingerprint).length + (market?.candidates.filter((c) => c.scoring_fingerprint !== rules.scoring_fingerprint).length ?? 0);
  if (mismatch > 0) return mk("SCORING_FINGERPRINT_MISMATCH");
  if (!market || !market.verified) flags.push("REPLACEMENT_MARKET_UNVERIFIED");
  else if (market.freshness !== "FRESH") flags.push(`MARKET_${market.freshness}`);

  // ---- weekly roster VOR (this week) ----
  const w0 = calcWeek(rules, roster, focal, week, market, { focalKind: "lineup" });
  const weeklyRoster: VorComponent = w0 ? { value: w0.value, low: Math.min(w0.low, w0.value), high: w0.roster_only, basis: market?.verified ? "ROSTER_CASCADE_WITH_VERIFIED_MARKET" : "ROSTER_CASCADE_ONLY", coverage: 1, unknown_reason: null }
    : unknownComponent("this week's value for the player is UNKNOWN (never treated as 0)", "UNAVAILABLE");

  // ---- streaming-adjusted: market re-streamed every week ----
  const streamCalcs = weeks.map((w) => calcWeek(rules, roster, focal, w, market, { focalKind: "lineup" }));
  const streaming = component(streamCalcs, weeks.length, market?.verified ? "SUM_OF_WEEKLY_VOR_WITH_WEEKLY_RESTREAMING" : "SUM_OF_WEEKLY_VOR_ROSTER_ONLY");

  // ---- ROS: ONE held replacement chosen by total horizon value (known probability only) ----
  let held: MarketCandidate | null = null;
  if (market?.verified) {
    let bestExp = 0; const base = weeks.map((w) => scenarioLineup({ rules, week: w, kind: "lineup", roster, removeId: focal.player_id }).total);
    const cands = new Map<string, MarketCandidate>(); for (const w of weeks) for (const c of topCandidates(market.candidates, w, TOP_K)) cands.set(c.player_id, c);
    for (const c of cands.values()) {
      const p = c.acquisition.success_probability; if (p == null) continue;
      const gain = sum(weeks.map((w, i) => p * (scenarioLineup({ rules, week: w, kind: "lineup", roster, removeId: focal.player_id, adds: [c] }).total - base[i]!)));
      if (gain > bestExp + 1e-12) { bestExp = gain; held = c; }
    }
  }
  const rosCalcs = weeks.map((w) => calcWeek(rules, roster, focal, w, market, { focalKind: "lineup", heldAdd: held }));
  // calcWeek with heldAdd only evaluates the held candidate; with none it is roster-only
  const ros = component(rosCalcs, weeks.length, held ? "HELD_REPLACEMENT_ACROSS_HORIZON" : market?.verified ? "ROSTER_ONLY_NO_ACQUIRABLE_REPLACEMENT" : "ROSTER_CASCADE_ONLY");
  if (held) ros.low = component(streamCalcs, weeks.length, "").low ?? ros.low; // optimistic bound uses best available every week

  // ---- hold: the focal player valued at his underlying value; a bye never zeroes the asset ----
  const holdCalcs = weeks.map((w) => calcWeek(rules, roster, focal, w, market, { focalKind: "underlying", heldAdd: held }));
  const hold = component(holdCalcs, weeks.length, "UNDERLYING_VALUE_OVER_HORIZON_REGARDLESS_OF_CURRENT_WEEK_STATUS");

  // ---- roster-independent components (a week with no game contributes exactly 0: neither negative nor a replacement penalty) ----
  const overLevel = (w: number, kind: "lineup" | "underlying", level: "best" | "top5"): number | null => {
    const wk = focal.weeks[w]; if (!wk || wk.state === "UNKNOWN") return null;
    if (wk.state === "BYE" || (wk.state === "OUT" && kind === "lineup")) return 0;
    const v = weekValue(focal, w, kind); const lv = poolLevels(market, focal.position, w)[level];
    return v == null || lv == null ? null : v - lv;
  };
  const lw = weeks.map((w) => overLevel(w, "lineup", "best"));
  const sw = weeks.map((w) => overLevel(w, "lineup", "top5"));
  const mw = weeks.map((w) => overLevel(w, "underlying", "top5"));
  const lc = (xs: Array<number | null>, basis: string): VorComponent => { const ok = xs.filter((x): x is number => x != null); return ok.length === 0 ? unknownComponent(market?.verified ? "no known weekly values" : "REPLACEMENT_MARKET_UNVERIFIED", basis) : { value: sum(ok), low: null, high: null, basis, coverage: ok.length / xs.length, unknown_reason: null }; };
  const weeklyLeague = lw[0] != null ? { value: lw[0], low: null, high: null, basis: "VALUE_OVER_BEST_VERIFIED_POOL_ALTERNATIVE", coverage: 1, unknown_reason: null } : unknownComponent(market?.verified ? "player or pool value unknown this week" : "REPLACEMENT_MARKET_UNVERIFIED", "VALUE_OVER_BEST_VERIFIED_POOL_ALTERNATIVE");

  return {
    label: W2R1_LABEL, mode: W2R1_MODE, model_version: W2R1_MODEL_VERSION, player_id: playerId, week, horizon: { from: week, to }, scoring_fingerprint: rules.scoring_fingerprint,
    weekly_roster_vor: weeklyRoster, ros_vor: ros, hold_vor: hold, streaming_adjusted_vor: streaming,
    weekly_league_vor: weeklyLeague, league_vor: lc(lw, "SUM_OVER_HORIZON_VALUE_OVER_BEST_VERIFIED_POOL_ALTERNATIVE"), scarcity_vor: lc(sw, "SUM_OVER_HORIZON_VALUE_OVER_TOP5_VERIFIED_POOL_MEAN"),
    market_value_input: lc(mw, "MARKET_INPUT_UNDERLYING_VALUE_OVER_TOP5_VERIFIED_POOL_MEAN (roster-independent; not a price; not private value)"),
    weekly_detail: w0?.detail ?? null,
    market: { provider: market?.provider ?? "none", verified: market?.verified ?? false, freshness: market?.freshness ?? "UNKNOWN", candidates_considered: market?.candidates.length ?? 0 },
    flags,
  };
}
