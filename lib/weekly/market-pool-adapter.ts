/**
 * Phase 4.5 integration (waiver-readiness-contract fix) — the ONE place the LEGACY (production) weekly waiver
 * engine turns the canonical Market State snapshot into an updated free-agent-pool readiness + a certified
 * candidate list.
 *
 * Deliberately mirrors Waiver 2.0's own market-pool reduction: same `consumerActionability` / `buildFreeAgentPool`
 * pure functions from `lib/market-state/pool.ts`, same "match on provider sleeper id" technique. There is exactly
 * ONE acquisition truth (`lib/market-state/*`) and zero duplicated market-eligibility logic between the two engines —
 * this file only decides WHO gets to be a legacy-engine candidate and WHETHER the pool is certified; it never
 * re-implements readiness classification.
 *
 * `UNROSTERED != CERTIFIED_FREE_AGENT` still holds: when the market is not actionable, the raw canonical
 * unrostered list is returned unchanged (harmless — the readiness gate in `lib/weekly/waivers.ts` refuses to use
 * it), never upgraded to a certified pool.
 */
import type { MarketSnapshot, PlayerMarketState, ReadinessAxes, AxisStatus } from "@/lib/market-state/contract";
import { acquirablePlayers, buildFreeAgentPool, consumerActionability, type ConsumerPolicy } from "@/lib/market-state/pool";
import { FREE_AGENT_POOL_UNAVAILABLE, type FreeAgentPoolReadiness } from "@/lib/canonical/capabilities";
import type { AvailablePlayer, LeagueAvailability, MarketPoolSummary } from "./schema";

/**
 * The legacy engine's explicit stance toward canonical market-state readiness codes — same posture as Waiver 2.0's
 * own policy: only the snapshot's own BLOCKING set is respected, nothing extra. A distinct `consumer` label (audit
 * trails only; it changes no behavior) so a reasons dump can tell which engine asked.
 */
export const LEGACY_WAIVER_MARKET_POLICY: ConsumerPolicy = { consumer: "legacy-weekly-waiver-engine", also_blocking: [] };

export interface CertifiedFreeAgentPool {
  free_agent_pool_readiness: FreeAgentPoolReadiness;
  /** Original canonical Market State readiness; never inferred from ownership. */
  market_readiness: MarketSnapshot["readiness"];
  /**
   * `availability.free_agents` intersected with the certified Market State pool (matched by provider sleeper id).
   * Unchanged (still the raw canonical unrostered list) when the pool is not actionable — the readiness gate
   * blocks its use downstream regardless of what this array contains.
   */
  free_agents: AvailablePlayer[];
  /**
   * Provider-evidence markets (Yahoo) only: `availability.players` with every unrostered projected player RE-LABELED from the market's own per-player
   * evidence (free_agent / waiver) and everything the provider did not verify demoted to `locked_ineligible`. The replacement engine reads this, so
   * replacement level comes from the verified acquirable pool, never from "whoever is not on a roster". Undefined for inferred-availability providers.
   */
  players?: AvailablePlayer[];
  market_content_id: string;
  pool_id: string;
  /** Structured, client-readable evidence of the verified pool (valuation axis finalized here from projection coverage). */
  summary: MarketPoolSummary | null;
}

const positionsOf = (s: MarketSnapshot): string[] => s.acquisition.rules.startable_positions.filter((p) => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(p));

function summarize(market: MarketSnapshot, acq: PlayerMarketState[], projectedCanon: Set<string>, evaluated: number): MarketPoolSummary {
  const basis = market.provider === "yahoo" ? "PROVIDER_STATUS" as const : "INFERRED" as const;
  const by: MarketPoolSummary["by_position"] = {};
  for (const m of acq) {
    const k = m.position ?? "UNKNOWN"; const e = (by[k] ??= { free_agents: 0, waivers: 0, with_projection: 0 });
    if (m.status === "AVAILABLE_FREE_AGENT") e.free_agents += 1; else e.waivers += 1;
    if (m.canonical_player_id && projectedCanon.has(m.canonical_player_id)) e.with_projection += 1;
  }
  const unresolved = acq.filter((m) => !m.canonical_player_id).length;
  const noProjectionNames = acq.filter((m) => m.canonical_player_id && !projectedCanon.has(m.canonical_player_id)).slice(0, 25).map((m) => `${m.full_name ?? m.player_key} (${m.position ?? "?"}, ${m.team ?? "?"})`);
  const withoutProjection = acq.filter((m) => m.canonical_player_id && !projectedCanon.has(m.canonical_player_id)).length;
  // valuation axis: can the verified pool be ranked? every startable position needs >=3 projected acquirable players, and identities must resolve
  const need = positionsOf(market);
  const thin = need.filter((p) => (by[p]?.with_projection ?? 0) < 3);
  const valuation: AxisStatus = acq.length === 0 ? "UNKNOWN" : evaluated === 0 ? "NOT_READY" : thin.length === 0 && unresolved === 0 ? "READY" : "PARTIAL";
  const m0 = market.readiness.axes;
  const availability: AxisStatus = m0?.availability ?? (market.readiness.pool_actionable ? "READY" : "NOT_READY");
  const transaction: AxisStatus = m0?.transaction ?? "PARTIAL";
  const recommendation: AxisStatus = availability === "NOT_READY" || valuation === "NOT_READY" || transaction === "NOT_READY" ? "NOT_READY" : availability === "READY" && valuation === "READY" && transaction === "READY" ? "READY" : "PARTIAL";
  const axes: ReadinessAxes = { availability, valuation, transaction, recommendation };
  const r = market.acquisition.rules;
  return {
    provider: market.provider, basis, market_content_id: market.identities.market_content_id, pool_id: buildFreeAgentPool(market).pool_id,
    observed_at: market.freshness?.observed_at ?? market.as_of, age_ms: market.freshness?.age_ms ?? null, freshness: market.freshness?.state ?? "UNKNOWN",
    verified_free_agents: market.counts.AVAILABLE_FREE_AGENT, verified_waivers: acq.filter((m) => m.status === "ON_WAIVERS").length,
    unknown_availability: market.counts.UNKNOWN_AVAILABILITY + market.counts.SOURCE_UNAVAILABLE, rostered: market.counts.ROSTERED,
    evaluated_with_projection: evaluated, verified_without_projection: withoutProjection, verified_identity_unresolved: unresolved,
    by_position: by, axes, verified_without_projection_sample: noProjectionNames,
    rules: { system: r.system, waiver_type: (r.provider_raw?.waiver_type as string | null | undefined) ?? null, waiver_rule: (r.provider_raw?.waiver_rule as string | null | undefined) ?? null, waiver_time_days: r.waiver_clear_days, add_limits: r.add_limits ?? null },
    pending_claims: market.pending_claim_visibility ?? { status: "NOT_EXPOSED", reason: "provider does not expose pending claims" },
    game_lock_semantics: market.game_lock_semantics ?? null, pool_evidence: market.pool_evidence ?? null,
    limitations: [...market.limitations, ...(thin.length ? [`valuation is thin (fewer than 3 projected acquirable players) at: ${thin.join(", ")}`] : [])],
  };
}

export function certifyFreeAgentPool(market: MarketSnapshot, availability: Pick<LeagueAvailability, "free_agents"> & Partial<Pick<LeagueAvailability, "players">>): CertifiedFreeAgentPool {
  const verdict = consumerActionability(market, LEGACY_WAIVER_MARKET_POLICY);
  const marketPool = buildFreeAgentPool(market);

  if (!verdict.actionable) {
    const reasons = market.readiness.reasons
      .filter((r) => verdict.blocked_by.includes(r.code))
      .map((r) => `${r.code}: ${r.detail}`);
    return {
      free_agent_pool_readiness: {
        actionable: false,
        status: "UNAVAILABLE",
        reason_code: FREE_AGENT_POOL_UNAVAILABLE,
        reasons: reasons.length ? reasons : ["market state is not actionable for waiver/free-agent recommendations"],
        missing_inputs: verdict.blocked_by,
      },
      market_readiness: market.readiness,
      free_agents: availability.free_agents,
      market_content_id: market.identities.market_content_id,
      pool_id: marketPool.pool_id,
      summary: null,
    };
  }

  // Provider-evidence market (Yahoo): match on CANONICAL identity (Yahoo has no Sleeper id of its own), keep FA and claimable W distinct, never trust "unrostered".
  if (market.provider === "yahoo") {
    const acq = acquirablePlayers(marketPool);
    const byCanon = new Map<string, PlayerMarketState>();
    for (const m of acq) if (m.canonical_player_id) byCanon.set(m.canonical_player_id, m);
    const relabel = (ap: AvailablePlayer): AvailablePlayer => {
      if (ap.ownership !== "free_agent") return ap;
      const m = byCanon.get(ap.canonical_player_id);
      if (!m) return { ...ap, ownership: "locked_ineligible", unresolved_note: "unrostered, but not verified available by Yahoo's own free-agent / waiver status" };
      const method = m.status === "AVAILABLE_FREE_AGENT" ? "FREE_AGENT_ADD" as const : "WAIVER_CLAIM" as const;
      return { ...ap, ownership: method === "FREE_AGENT_ADD" ? "free_agent" : "waiver", acquisition: { method, provider_status: m.availability_evidence?.provider_status ?? "?", waiver_clears_on: m.waiver_clears_on ?? null } };
    };
    const players = (availability.players ?? availability.free_agents).map(relabel);
    const certified = players.filter((p) => p.ownership === "free_agent" || p.ownership === "waiver");
    const projectedCanon = new Set(certified.map((p) => p.canonical_player_id));
    return {
      free_agent_pool_readiness: { actionable: true, status: "HEALTHY", reason_code: null, reasons: [], missing_inputs: [] },
      market_readiness: market.readiness,
      free_agents: certified,
      players: availability.players ? players : undefined,
      market_content_id: market.identities.market_content_id,
      pool_id: marketPool.pool_id,
      summary: summarize(market, acq, projectedCanon, certified.length),
    };
  }

  const availableSleeperIds = new Set(marketPool.members.map((m) => m.provider_player_id));
  const certified = availability.free_agents.filter((fa) => availableSleeperIds.has(String(fa.player.identifiers.sleeper_id ?? "")));

  return {
    free_agent_pool_readiness: { actionable: true, status: "HEALTHY", reason_code: null, reasons: [], missing_inputs: [] },
    market_readiness: market.readiness,
    free_agents: certified,
    market_content_id: market.identities.market_content_id,
    pool_id: marketPool.pool_id,
    summary: null,
  };
}

/**
 * Scoring compatibility of a pool's valuation. Pure. The K / D-ST warning is the weekly projection layer's own (`k_dst_weekly_approximated`): it is surfaced
 * here, never hidden, so a client sees that K / D-ST WEEKLY values are not re-scored with the league's rules while the pool's AVAILABILITY is exact.
 */
export function scoringCompatibility(fingerprint: string | null, projectionWarningCodes: readonly string[]): NonNullable<MarketPoolSummary["scoring"]> {
  const approx = projectionWarningCodes.includes("k_dst_weekly_approximated");
  return {
    fingerprint,
    k_dst_weekly_projection: approx ? "APPROXIMATED_FROM_PROVIDER_STANDARD_POINTS" : "NOT_FLAGGED",
    note: approx
      ? "K and D/ST weekly projections use the provider's standard precomputed points, not the league's scoring rules (a dedicated K/DST forecast is a later phase). Offensive positions are scored with the league's exact rules. Availability of K / D/ST is unaffected."
      : "No K / D/ST approximation warning on this context.",
  };
}
