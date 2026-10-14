/**
 * W2.R1 roster-state + replacement-chain simulator.
 *
 * "If this player disappears from the roster, what actually happens?" — answered by re-optimizing the ENTIRE legal lineup (starters, bench, FLEX /
 * SUPERFLEX, IR returns, K, DEF) with and without the player, never one slot in isolation and never against a generic positional cutoff.
 * UNKNOWN weekly values are excluded from the optimization (never treated as 0) and surfaced.
 */
import { hungarianMaxWeight } from "@/lib/weekly/lineup";
import { slotEligiblePositions } from "@/lib/weekly/slots";
import type { AssetEvidence, LeagueRules, MarketCandidate, Pos, RosterAsset } from "./evidence";

export interface LineupSlotResult { slot: string; player_id: string | null; value: number }
export interface LineupValue {
  total: number;
  slots: LineupSlotResult[];
  empty_slots: string[];
  /** players excluded because their value this week is UNKNOWN (not zero) */
  unknown_excluded: string[];
  /** true when an excluded unknown could change the optimum (the total is a lower bound on the truth) */
  provisional: boolean;
}

export type ValueKind = "lineup" | "underlying";

const eligibleFor = (slot: string, p: { position: Pos; eligible_positions: Pos[] }): boolean => {
  const allowed = slotEligiblePositions(slot);
  return allowed.includes(p.position) || p.eligible_positions.some((q) => allowed.includes(q));
};

/** the value an asset contributes in `week` (null = unknown). */
export function weekValue(a: AssetEvidence, week: number, kind: ValueKind): number | null {
  const w = a.weeks[week];
  if (!w || w.state === "UNKNOWN") return null;
  return kind === "lineup" ? w.lineup : w.underlying;
}

export interface OptimizeInput {
  slots: string[];
  /** players that may start this week with their value (null = unknown) */
  players: Array<{ id: string; position: Pos; eligible_positions: Pos[]; value: number | null }>;
}

export function optimizeLineup(input: OptimizeInput): LineupValue {
  const known = input.players.filter((p) => p.value != null).sort((a, b) => (a.id < b.id ? -1 : 1)) as Array<{ id: string; position: Pos; eligible_positions: Pos[]; value: number }>;
  const unknown = input.players.filter((p) => p.value == null).map((p) => p.id).sort();
  const NEG = Number.NEGATIVE_INFINITY;
  const weight = input.slots.map((s) => known.map((p) => (eligibleFor(s, p) ? p.value : NEG)));
  const assign = known.length && input.slots.length ? hungarianMaxWeight(weight) : input.slots.map(() => -1);
  const slots: LineupSlotResult[] = []; const empty: string[] = []; let total = 0;
  input.slots.forEach((s, i) => {
    const j = assign[i] ?? -1;
    if (j < 0 || weight[i]![j] === NEG) { slots.push({ slot: s, player_id: null, value: 0 }); empty.push(s); }
    else { slots.push({ slot: s, player_id: known[j]!.id, value: known[j]!.value }); total += known[j]!.value; }
  });
  // an unknown can matter only if it is eligible for some slot (it could occupy it or displace a lower value)
  const unknownEligible = input.players.filter((p) => p.value == null && input.slots.some((s) => eligibleFor(s, p))).map((p) => p.id);
  return { total, slots, empty_slots: empty, unknown_excluded: unknown, provisional: unknownEligible.length > 0 };
}

export interface ActiveCapacity { limit: number; used: number }

/** Roster legality: ACTIVE = STARTER + BENCH. IR/PUP/NFI/RESERVE cannot start unless activated (needs `returns_in_week <= week` AND an open active spot). */
export function activeLimit(rules: LeagueRules): number { return rules.slots.length + rules.bench_size; }

export interface ScenarioInput {
  rules: LeagueRules;
  week: number;
  kind: ValueKind;
  roster: RosterAsset[];
  removeId?: string | null;
  adds?: MarketCandidate[];
  /** override the value of ONE asset (hold VOR values the focal player at `underlying` while everyone else stays realistic) */
  valueOverride?: { id: string; kind: ValueKind };
}

export function scenarioLineup(s: ScenarioInput): LineupValue & { activated_from_reserve: string[]; dropped_for_capacity: string[] } {
  const kept = s.roster.filter((a) => a.player_id !== s.removeId);
  const active = kept.filter((a) => a.status === "STARTER" || a.status === "BENCH");
  const wanted = (s.adds ?? []).filter((c) => !kept.some((a) => a.player_id === c.player_id));
  // an acquisition needs an open ACTIVE spot (a drop is a different scenario): removing an IR/reserve player frees no active spot, so no add can enter
  const room = Math.max(0, activeLimit(s.rules) - active.length);
  const adds = wanted.slice(0, room);
  const reservists = kept.filter((a) => a.status !== "STARTER" && a.status !== "BENCH" && a.returns_in_week != null && a.returns_in_week <= s.week);
  let space = room - adds.length;
  const activated: string[] = [];
  const pool: Array<{ id: string; position: Pos; eligible_positions: Pos[]; value: number | null }> = [];
  const val = (a: AssetEvidence) => weekValue(a, s.week, s.valueOverride && s.valueOverride.id === a.player_id ? s.valueOverride.kind : s.kind);
  for (const a of active) pool.push({ id: a.player_id, position: a.position, eligible_positions: a.eligible_positions, value: val(a) });
  for (const c of adds) pool.push({ id: c.player_id, position: c.position, eligible_positions: c.eligible_positions, value: val(c) });
  // IR/PUP/NFI returns: only into an open active spot, best value first (deterministic)
  for (const r of [...reservists].sort((a, b) => (weekValue(b, s.week, s.kind) ?? -1) - (weekValue(a, s.week, s.kind) ?? -1) || (a.player_id < b.player_id ? -1 : 1))) {
    if (space <= 0) break;
    space -= 1; activated.push(r.player_id);
    pool.push({ id: r.player_id, position: r.position, eligible_positions: r.eligible_positions, value: val(r) });
  }
  const lv = optimizeLineup({ slots: s.rules.slots, players: pool });
  return { ...lv, activated_from_reserve: activated, dropped_for_capacity: wanted.slice(room).map((c) => c.player_id) };
}

export interface ChainStep { slot: string; before: string | null; after: string | null }

/** who moves where when the focal player disappears (slot-by-slot difference of the two optimal assignments) */
export function chainBetween(withLineup: LineupValue, withoutLineup: LineupValue): ChainStep[] {
  const out: ChainStep[] = [];
  withLineup.slots.forEach((s, i) => {
    const o = withoutLineup.slots[i];
    if (o && s.player_id !== o.player_id) out.push({ slot: s.slot, before: s.player_id, after: o.player_id });
  });
  return out;
}

/** top-k market candidates per position for a week (by lineup value; unknown-value candidates are NEVER dropped from the market, only from valuation) */
export function topCandidates(pool: MarketCandidate[], week: number, k: number): MarketCandidate[] {
  const byPos = new Map<Pos, MarketCandidate[]>();
  for (const c of pool) {
    if (c.acquisition.available_from_week != null && c.acquisition.available_from_week > week) continue;
    (byPos.get(c.position) ?? byPos.set(c.position, []).get(c.position)!).push(c);
  }
  const out: MarketCandidate[] = [];
  for (const list of byPos.values()) {
    const ranked = list.filter((c) => weekValue(c, week, "lineup") != null).sort((a, b) => (weekValue(b, week, "lineup") as number) - (weekValue(a, week, "lineup") as number) || (a.player_id < b.player_id ? -1 : 1));
    out.push(...ranked.slice(0, k));
  }
  return out;
}
