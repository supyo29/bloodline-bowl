/**
 * Phase 4.5 — the FreeAgentPool: an explicit, deterministic PRODUCT of one certified MarketSnapshot.
 *
 * League-level by construction (availability is the same for every manager); manager-specific facts (budget, priority, roster
 * room) come from `managerAcquisitionContext`, never from a per-manager pool. Positional views are slices of the SAME snapshot.
 * The pool never ranks or values anyone: replacement-value math stays with the consumers (Phase 4 owns valuation); this module
 * only answers "who can be acquired".
 */
import type { MarketReadiness, MarketSnapshot, PlayerMarketState, ReadinessReasonCode, TeamAcquisitionContext } from "./contract";
import { hashOf } from "./hash";

export interface FreeAgentPool {
  market_content_id: string;
  /** Identity of the pool itself (= its members under one market content id). Stable across reads of an unchanged market. */
  pool_id: string;
  league_slug: string; season: number; week: number;
  readiness: MarketReadiness;
  /** true only when the snapshot has no BLOCKING reason. */
  actionable: boolean;
  /** AVAILABLE_FREE_AGENT members, deterministic order (player_key ascending). Empty when the market is not actionable. */
  members: PlayerMarketState[];
  by_position: Record<string, string[]>;
  /** Not addable now, but listed so consumers can explain absences. */
  on_waivers: PlayerMarketState[];
  locked: PlayerMarketState[];
  unknown: PlayerMarketState[];
  exclusions: { ineligible: Record<string, number>; on_waivers: number; locked: number; unknown: number; rostered: number };
}

export function buildFreeAgentPool(s: MarketSnapshot): FreeAgentPool {
  const actionable = s.readiness.pool_actionable;
  const members = actionable ? s.players.filter((p) => p.status === "AVAILABLE_FREE_AGENT") : [];
  const by_position: Record<string, string[]> = {};
  for (const m of members) (by_position[m.position ?? "UNKNOWN"] ??= []).push(m.player_key);
  return {
    market_content_id: s.identities.market_content_id, pool_id: `pool:${hashOf({ m: s.identities.market_content_id, k: members.map((x) => x.player_key) })}`, league_slug: s.league_slug, season: s.season, week: s.week,
    readiness: s.readiness, actionable, members, by_position,
    on_waivers: s.players.filter((p) => p.status === "ON_WAIVERS"), locked: s.players.filter((p) => p.status === "LOCKED"),
    unknown: s.players.filter((p) => p.status === "UNKNOWN_AVAILABILITY" || p.status === "SOURCE_UNAVAILABLE"),
    exclusions: { ineligible: s.ineligible_counts, on_waivers: s.counts.ON_WAIVERS, locked: s.counts.LOCKED, unknown: s.counts.UNKNOWN_AVAILABILITY + s.counts.SOURCE_UNAVAILABLE, rostered: s.counts.ROSTERED },
  };
}

export const poolPositionView = (pool: FreeAgentPool, position: string): PlayerMarketState[] => { const keys = new Set(pool.by_position[position] ?? []); return pool.members.filter((m) => keys.has(m.player_key)); };
/** Availability-only support for replacement-level queries: how many acquirable players exist at a position, and who they are (unranked). */
export const replacementAvailability = (pool: FreeAgentPool, position: string): { position: string; available: number; player_keys: string[] } => ({ position, available: pool.by_position[position]?.length ?? 0, player_keys: pool.by_position[position] ?? [] });

/** Availability-only supply per position (positional depth + scarcity as available-per-team). Valuation stays with the consumer. */
export function positionalSupply(pool: FreeAgentPool, teamCount: number): Array<{ position: string; available: number; per_team: number | null }> {
  return Object.entries(pool.by_position).sort(([a], [b]) => (a < b ? -1 : 1)).map(([position, keys]) => ({ position, available: keys.length, per_team: teamCount > 0 ? Math.round((keys.length / teamCount) * 100) / 100 : null }));
}

export interface ManagerAcquisitionContext {
  team_id: string; system: MarketSnapshot["acquisition"]["rules"]["system"];
  faab_remaining: number | null; waiver_priority: number | null; roster_size: number; roster_limit: number | null; open_roster_slots: number | null; requires_drop: boolean | null;
  waiver_clear_days: number | null; status: MarketSnapshot["acquisition"]["status"];
}
export function managerAcquisitionContext(s: MarketSnapshot, team_id: string): ManagerAcquisitionContext | null {
  const t: TeamAcquisitionContext | undefined = s.acquisition.teams.find((x) => x.team_id === team_id); if (!t) return null;
  const open = t.roster_limit != null ? Math.max(0, t.roster_limit - t.roster_size) : null;
  return { team_id, system: s.acquisition.rules.system, faab_remaining: t.faab_remaining, waiver_priority: t.waiver_priority, roster_size: t.roster_size, roster_limit: t.roster_limit, open_roster_slots: open, requires_drop: open == null ? null : open === 0, waiver_clear_days: s.acquisition.rules.waiver_clear_days, status: s.acquisition.status };
}

/** A consumer states which readiness codes it refuses to tolerate beyond the snapshot's own BLOCKING set. Explicit, never implicit. */
export interface ConsumerPolicy { consumer: string; also_blocking: ReadinessReasonCode[] }
export function consumerActionability(s: MarketSnapshot, policy: ConsumerPolicy): { actionable: boolean; blocked_by: ReadinessReasonCode[]; tolerated: ReadinessReasonCode[] } {
  const extra = s.readiness.limitations.filter((c) => policy.also_blocking.includes(c));
  const blocked_by = [...s.readiness.blocks, ...extra];
  return { actionable: blocked_by.length === 0, blocked_by, tolerated: s.readiness.limitations.filter((c) => !policy.also_blocking.includes(c)) };
}
