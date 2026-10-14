/**
 * W2.R1 live adapter: canonical weekly context (Sleeper OR Yahoo — provider neutral) -> S1 evidence / S2 roster / verified market.
 *
 * What it reads is exactly what production consumes (canonical forecasts, ROS signal, byes, the certified market pool). It adds NOTHING to production
 * and re-applies NO availability: `lineup` = the Wave-1 canonical `expected_points` (injury model already applied once), `underlying` = Wave-1
 * `conditional_active_points`. Future weeks are an EXPLICIT proxy (ROS per-game rate, verified byes, long-term injury horizon) tagged LOW confidence.
 */
import { scoringFingerprint } from "@/lib/canonical/scoring-fingerprint";
import type { CanonicalPlayer } from "@/lib/canonical/schema";
import type { CanonicalWeeklyPlayerForecast } from "@/lib/weekly/forecast/schema";
import type { WeeklyTeamContext } from "@/lib/weekly/schema";
import { holdHorizonWeeks } from "@/lib/weekly/forecast/bye";
import type { AssetEvidence, Confidence, LeagueRules, MarketCandidate, MarketPool, Pos, RosterAsset, WeekState, WeekValue } from "./evidence";
import { W2R1_EVIDENCE_VERSION } from "./version";

const POS_OK = new Set<string>(["QB", "RB", "WR", "TE", "K", "DEF"]);
const toPos = (p: string | null | undefined): Pos | null => (p === "DST" ? "DEF" : p && POS_OK.has(p) ? (p as Pos) : null);

export interface EarlyInputs {
  rules: LeagueRules;
  roster: RosterAsset[];
  market: MarketPool;
  notes: string[];
  names: Map<string, string>;
  excluded: Array<{ player_id: string; reason: string }>;
}

function buildAsset(p: CanonicalPlayer, f: CanonicalWeeklyPlayerForecast | undefined, ctx: WeeklyTeamContext, fp: string, lastWeek: number, byeWeek: number | null): AssetEvidence | null {
  const pos = toPos(p.position);
  if (!pos) return null;
  const week = ctx.league.week;
  const missing: string[] = [];
  const weeks: Record<number, WeekValue> = {};
  const cw = f?.weekly_value.current_week_state;
  const exp = f?.projection.expected_points ?? null;
  const cond = f?.projection.conditional_active_points ?? exp;
  const asset = f?.asset_value;
  const ros = asset?.forward_value.ros_points ?? null;
  const horizon = holdHorizonWeeks(week);
  const outWeeks = asset?.forward_value.forward_weeks_out ?? 0;
  // current week
  if (!f) { weeks[week] = { state: "UNKNOWN", lineup: null, underlying: null }; missing.push("NO_CANONICAL_FORECAST"); }
  else if (cw === "BYE" || f.game_status.is_bye) weeks[week] = { state: "BYE", lineup: 0, underlying: 0 };
  else if (cw === "OUT") weeks[week] = { state: "OUT", lineup: 0, underlying: cond ?? asset?.asset_value.hold_points_per_week ?? null };
  else if (cw === "UNKNOWN" || exp == null) { weeks[week] = { state: "UNKNOWN", lineup: null, underlying: cond ?? null }; missing.push("CURRENT_WEEK_PROJECTION_UNKNOWN"); }
  else weeks[week] = { state: "ACTIVE", lineup: exp, underlying: cond ?? exp };
  // future weeks: explicit ROS per-game proxy (verified byes; long-term injury horizon). Never zero-filled when unknown.
  const futureBye = byeWeek != null && byeWeek > week && byeWeek <= lastWeek;
  const gamesInHorizon = Math.max(1, horizon - (futureBye ? 1 : 0) - (weeks[week]?.state === "BYE" ? 1 : 0));
  const perGame = ros == null ? null : Math.round((ros / gamesInHorizon) * 100) / 100;
  if (perGame == null) missing.push("ROS_UNAVAILABLE_FUTURE_WEEKS_UNKNOWN");
  for (let w = week + 1; w <= lastWeek; w++) {
    if (byeWeek === w) weeks[w] = { state: "BYE", lineup: 0, underlying: 0 };
    else if (w < week + outWeeks) weeks[w] = { state: "OUT", lineup: 0, underlying: 0 };
    else if (perGame == null) weeks[w] = { state: "UNKNOWN", lineup: null, underlying: null };
    else weeks[w] = { state: "ACTIVE", lineup: perGame, underlying: perGame };
  }
  if (!ctx.byes.by_player || ctx.byes.bye_status !== "VERIFIED") missing.push("BYE_SCHEDULE_UNVERIFIED");
  const observed = f?.freshness.source_observed_at ?? ctx.generated_at;
  const confidence: Confidence = f?.certification.state === "PRODUCTION" && perGame != null ? "MEDIUM" : "LOW";
  return {
    player_id: p.canonical_player_id, name: p.full_name, position: pos, eligible_positions: ([...(p.eligible_positions ?? [])].map(toPos).filter(Boolean) as Pos[]), team: p.nfl_team ?? null,
    scoring_fingerprint: fp, weeks, bye_week: byeWeek, confidence,
    provenance: { source: f?.provenance.projection_provider ?? "unknown", observed_at: observed, source_at: observed, evidence_age_ms: f?.freshness.age_ms ?? null, version: `${f?.provenance.source_version ?? "unknown"}|${W2R1_EVIDENCE_VERSION}` },
    missing_evidence: missing,
  };
}

export function buildEarlyInputs(ctx: WeeklyTeamContext, opts: { lastWeek?: number } = {}): EarlyInputs {
  const week = ctx.league.week;
  const lastWeek = opts.lastWeek ?? 17;
  const fp = scoringFingerprint(ctx.league.raw_scoring);
  const c = ctx.league.roster_constraints;
  const notes: string[] = [];
  const excluded: EarlyInputs["excluded"] = [];
  const names = new Map<string, string>();
  const rules: LeagueRules = { league_id: ctx.league.slug, scoring_fingerprint: fp, slots: [...c.starting_slots], bench_size: c.bench_slots, ir_slots: c.ir_slots, teams: null, last_week: lastWeek };
  const byeOf = (id: string): number | null => (ctx.byes.bye_status === "VERIFIED" ? ctx.byes.by_player[id] ?? null : null);
  // reads CANONICAL FORECASTS only (never the legacy projection batch): the W1.P1 ratchet's intent
  const forecastById = ctx.forecasts?.by_player;
  const fOf = (id: string) => forecastById?.get(id);

  const roster: RosterAsset[] = [];
  const push = (pl: CanonicalPlayer[], status: RosterAsset["status"]) => {
    for (const p of pl) {
      const a = buildAsset(p, fOf(p.canonical_player_id), ctx, fp, lastWeek, byeOf(p.canonical_player_id));
      names.set(p.canonical_player_id, p.full_name);
      if (!a) { excluded.push({ player_id: p.canonical_player_id, reason: `UNSUPPORTED_POSITION_${p.position}` }); continue; }
      let returns: number | null = null;
      if (status === "IR" || status === "RESERVE") {
        const out = fOf(p.canonical_player_id)?.asset_value.forward_value.forward_weeks_out ?? 0;
        // ASSUMPTION (Wave 1): a long-term designation misses at least the NFL minimum stint. An IR-slot player with NO known designation is NOT assumed
        // activatable: unknown availability is never treated as available (live defect: a benched-IR player was silently activated into every lineup).
        returns = status === "IR" && out > 0 ? week + out : null;
        if (status === "IR") a.missing_evidence.push(out > 0 ? "IR_RETURN_WEEK_ASSUMED_FROM_MINIMUM_STINT" : "IR_SLOT_WITH_NO_LONG_TERM_DESIGNATION_RETURN_UNKNOWN");
      }
      roster.push({ ...a, status, returns_in_week: returns });
    }
  };
  push(ctx.starters, "STARTER"); push(ctx.bench, "BENCH"); push(ctx.reserve_ir, "IR"); push(ctx.taxi, "RESERVE");

  const verified = ctx.free_agent_pool_readiness.actionable === true;
  const candidates: MarketCandidate[] = [];
  const rosteredIds = new Set(roster.map((r) => r.player_id));
  for (const ap of ctx.availability.free_agents) {
    if (rosteredIds.has(ap.canonical_player_id)) continue;
    const a = buildAsset(ap.player, fOf(ap.canonical_player_id), ctx, fp, lastWeek, byeOf(ap.canonical_player_id));
    names.set(ap.canonical_player_id, ap.player.full_name);
    if (!a) continue;
    const method = ap.acquisition?.method ?? (ap.ownership === "waiver" ? "WAIVER_CLAIM" : "FREE_AGENT_ADD");
    // FREE_AGENT_ADD verified by provider status (Yahoo FA) = addable now (1). Everything else: probability UNKNOWN (never invented).
    const providerVerifiedFa = ap.acquisition?.method === "FREE_AGENT_ADD";
    candidates.push({ ...a, acquisition: { method, success_probability: providerVerifiedFa ? 1 : null, faab_cost: null, waiver_priority: null, available_from_week: week } });
  }
  const mp = ctx.market_pool;
  if (mp?.basis === "INFERRED") notes.push("SLEEPER_ACQUISITION_METHOD_AND_PROBABILITY_INFERRED: availability is inferred from rosters+transactions, so acquisition success is UNKNOWN (never assumed). Free-agent adds appear in the optimistic bound, not in the expected value.");
  // Sleeper has no market-state summary: its pool is INFERRED from the league snapshot read in THIS request. We report that snapshot's TIME and leave the freshness
  // STATE unknown (a TTL verdict belongs to lib/weekly/freshness/policy.ts, not to a private threshold here): never assumed FRESH.
  const observedAt = mp?.observed_at ?? ctx.lineage?.snapshot?.generated_at ?? null;
  const freshness: MarketPool["freshness"] = mp?.freshness ?? "UNKNOWN";
  if (!mp && observedAt) notes.push("MARKET_OBSERVED_AT_IS_THE_LEAGUE_SNAPSHOT_TIME (no market-state summary for this provider; freshness state not asserted)");
  const market: MarketPool = { provider: ctx.league.provider === "yahoo" ? "yahoo" : "sleeper", verified, observed_at: observedAt, freshness, candidates };
  if (!verified) notes.push("REPLACEMENT_MARKET_NOT_CERTIFIED: the free-agent pool is not an actionable certified pool; replacements come from the roster only.");
  if (ctx.byes.bye_status !== "VERIFIED") notes.push("BYE_SCHEDULE_UNVERIFIED: future byes unknown; ROS/Hold do not reflect future byes.");
  notes.push("FUTURE_WEEKS_ARE_A_PROXY: weeks after the current week use the ROS per-game rate (verified byes, long-term injury horizon). Confidence capped LOW; no schedule/matchup/game-plan adjustment yet (S5).");
  return { rules, roster, market, notes, names, excluded };
}
