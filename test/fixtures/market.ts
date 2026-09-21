import type { MarketBuildInput } from "@/lib/market-state/build";
import type { UniversePlayer } from "@/lib/market-state/classify";
import type { SourceReport } from "@/lib/market-state/contract";

export const AS_OF = "2026-09-22T15:00:00.000Z";
export const okSrc = (at = AS_OF): SourceReport => ({ status: "OK", source_class: "PROVIDER_LIVE", fetched_at: at, detail: null });
export const badSrc = (detail = "PROVIDER_ERROR: boom"): SourceReport => ({ status: "UNAVAILABLE", source_class: "UNAVAILABLE", fetched_at: null, detail });
export const up = (id: string, o: Partial<UniversePlayer> = {}): UniversePlayer => ({ player_id: id, full_name: `P${id}`, position: "WR", fantasy_positions: ["WR"], team: "KC", status: "Active", injury_status: null, active: true, ...o });
export const FAAB_SETTINGS = { waiver_type: 2, waiver_budget: 100, waiver_bid_min: 0, waiver_clear_days: 2, waiver_day_of_week: 2, reserve_slots: 1, taxi_slots: 0 };
export const PRIORITY_SETTINGS = { waiver_type: 1, waiver_budget: 1000, waiver_clear_days: 2, waiver_day_of_week: 2, reserve_slots: 2, taxi_slots: 0 };
export const POSITIONS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "IR"];
const DAY = 86_400_000;
export const agoMs = (days: number): number => Date.parse(AS_OF) - days * DAY;

export function marketInput(o: Partial<MarketBuildInput> = {}): MarketBuildInput {
  return {
    league_slug: "bloodline-bowl", season: 2026, week: 3, as_of: AS_OF, request_id: "req:A", source_snapshot_id: "snap:A", scoring_fingerprint: "scoring:v1:x",
    rules: { source: okSrc(), settings: FAAB_SETTINGS, roster_positions: POSITIONS },
    rosters: { source: okSrc(), teams: [
      { team_id: "team:l:1", roster_id: 1, players: ["10", "11", "12", "0"], reserve: ["12"], taxi: [], faab_used: 12, waiver_position: 3 },
      { team_id: "team:l:2", roster_id: 2, players: ["20", "21"], reserve: [], taxi: [], faab_used: 0, waiver_position: 1 },
    ] },
    universe: { source: okSrc(), players: [
      up("10"), up("11", { position: "RB", fantasy_positions: ["RB"] }), up("12", { injury_status: "IR", status: "Injured Reserve" }), up("20"), up("21", { position: "QB", fantasy_positions: ["QB"] }),
      up("30", { position: "RB", fantasy_positions: ["RB"], team: "BUF" }), up("31", { position: "TE", fantasy_positions: ["TE"], team: "DAL", injury_status: "Questionable" }), up("32", { team: null }),
      up("KC", { player_id: "KC", position: "DEF", fantasy_positions: ["DEF"], status: null, full_name: null }), up("40", { position: "OL", fantasy_positions: ["OL"] }), up("41", { position: "XX", fantasy_positions: [] }),
      up("50", { status: "Practice Squad" }), up("51", { position: "K", fantasy_positions: ["K"], team: "SF" }),
    ] },
    transactions: { source: okSrc(), entries: [] },
    schedule: { source: okSrc(), games: [{ week: 3, home: "KC", away: "BUF", status: "pre_game" }, { week: 3, home: "DAL", away: "SF", status: "pre_game" }] },
    ...o,
  };
}
