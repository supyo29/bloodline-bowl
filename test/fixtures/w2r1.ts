import type { Acquisition, AssetEvidence, LeagueRules, MarketCandidate, MarketPool, Pos, RosterAsset, RosterStatus, WeekValue } from "@/lib/w2r1/evidence";

export const FP = "HALF-TEST-FP";
export const PROV = { source: "test", observed_at: "2026-10-14T12:00:00.000Z", source_at: "2026-10-14T11:00:00.000Z", evidence_age_ms: 3_600_000, version: "test-1" };
export const RULES: LeagueRules = { league_id: "L1", scoring_fingerprint: FP, slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"], bench_size: 6, ir_slots: 1, teams: 12, last_week: 17 };

export interface AssetOpts { bye?: number | null; out?: number[]; unknown?: number[]; underlying?: number | ((w: number) => number); lineupOverride?: Record<number, number>; fp?: string; eligible?: Pos[]; from?: number }
/** `value` = healthy per-week points; weeks `from..17` are defined (default 1) */
export function weeks(value: number | ((w: number) => number), o: AssetOpts = {}): Record<number, WeekValue> {
  const out: Record<number, WeekValue> = {};
  for (let w = o.from ?? 1; w <= 17; w++) {
    const v = typeof value === "function" ? value(w) : value;
    const u = o.underlying == null ? v : typeof o.underlying === "function" ? o.underlying(w) : o.underlying;
    if (o.unknown?.includes(w)) out[w] = { state: "UNKNOWN", lineup: null, underlying: null };
    else if (o.bye === w) out[w] = { state: "BYE", lineup: 0, underlying: 0 };
    else if (o.out?.includes(w)) out[w] = { state: "OUT", lineup: 0, underlying: u };
    else out[w] = { state: "ACTIVE", lineup: o.lineupOverride?.[w] ?? v, underlying: u };
  }
  return out;
}
export function asset(id: string, position: Pos, value: number | ((w: number) => number), o: AssetOpts = {}): AssetEvidence {
  const w = weeks(value, o);
  return { player_id: id, name: id, position, eligible_positions: o.eligible ?? [position], team: "TST", scoring_fingerprint: o.fp ?? FP, weeks: w, bye_week: o.bye ?? null, confidence: "MEDIUM", provenance: PROV, missing_evidence: o.unknown?.length ? ["unknown week values"] : [] };
}
export function onRoster(a: AssetEvidence, status: RosterStatus = "BENCH", returns: number | null = null): RosterAsset { return { ...a, status, returns_in_week: returns }; }
export const fa = (a: AssetEvidence, from: number | null = 1): MarketCandidate => ({ ...a, acquisition: { method: "FREE_AGENT_ADD", success_probability: 1, faab_cost: null, waiver_priority: null, available_from_week: from } as Acquisition });
export const waiver = (a: AssetEvidence, p: number | null, faab: number | null = 5): MarketCandidate => ({ ...a, acquisition: { method: "WAIVER_CLAIM", success_probability: p, faab_cost: faab, waiver_priority: 3, available_from_week: 1 } });
export const market = (candidates: MarketCandidate[], verified = true, freshness: "FRESH" | "STALE" | "UNKNOWN" = "FRESH"): MarketPool => ({ provider: "yahoo", verified, observed_at: PROV.observed_at, freshness, candidates });

/** a standard full roster (starters + bench) */
export function standardRoster(): RosterAsset[] {
  return [
    onRoster(asset("qb1", "QB", 20), "STARTER"), onRoster(asset("rb1", "RB", 16), "STARTER"), onRoster(asset("rb2", "RB", 12), "STARTER"),
    onRoster(asset("wr1", "WR", 15), "STARTER"), onRoster(asset("wr2", "WR", 11), "STARTER"), onRoster(asset("te1", "TE", 9), "STARTER"),
    onRoster(asset("wr3", "WR", 10), "STARTER"), onRoster(asset("k1", "K", 8), "STARTER"), onRoster(asset("d1", "DEF", 7), "STARTER"),
    onRoster(asset("rb3", "RB", 8), "BENCH"), onRoster(asset("wr4", "WR", 7), "BENCH"), onRoster(asset("te2", "TE", 5), "BENCH"), onRoster(asset("qb2", "QB", 15), "BENCH"),
  ];
}
