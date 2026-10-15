/**
 * Yahoo Market State — the PURE builder. Deterministic, no network. Proves: availability comes ONLY from Yahoo's per-player status; "unrostered" is never
 * evidence; unknown stays unknown; K and D/ST are first-class; pool / transaction readiness are separate axes; every degraded state is visible.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildYahooMarketSnapshot, foldYahooPosition, yahooStartablePositions, type YahooMarketBuildInput, type YahooPoolRow, type YahooRosterTeam } from "../lib/market-state/yahoo-build";
import { validateMarketSnapshot } from "../lib/market-state/integrity";
import { buildFreeAgentPool, acquirablePlayers } from "../lib/market-state/pool";
import { compactMarketSnapshot } from "../lib/market-state/history";
import type { MarketSnapshot, SourceReport } from "../lib/market-state/contract";

const AS_OF = "2026-10-14T03:00:00.000Z";
const src = (status: SourceReport["status"] = "OK", at: string | null = AS_OF, detail: string | null = null): SourceReport => ({ status, source_class: status === "UNAVAILABLE" ? "UNAVAILABLE" : "PROVIDER_LIVE", fetched_at: status === "UNAVAILABLE" ? null : at, detail });
const row = (id: number, pos: string, team: string, status: "FA" | "W" | "T", o: Partial<YahooPoolRow> = {}): YahooPoolRow => ({ player_key: `471.p.${id}`, player_id: String(id), name: o.name ?? `Player ${id}`, display_position: pos, eligible_positions: [pos], team_abbr: team, status, waiver_clear_date: status === "W" ? "2026-10-14" : null, owner_team_key: status === "T" ? "471.l.1.t.1" : null, ownership_type: status === "T" ? "team" : status === "W" ? "waivers" : null, injury_status: null, bye_week: 7, ...o });
const rp = (id: number, pos: string, team: string, slot = "BN", name?: string) => ({ player_key: `471.p.${id}`, selected_position: slot, name: name ?? `Player ${id}`, display_position: pos, eligible_positions: [pos], team_abbr: team, injury_status: null });
const team = (id: number, players: ReturnType<typeof rp>[], o: Partial<YahooRosterTeam> = {}): YahooRosterTeam => ({ team_key: `471.l.1.t.${id}`, team_id: `team:t:${id}`, players, faab_balance: null, waiver_priority: id, ...o });
const sub = (returned: number, complete = true) => ({ returned, complete, pages_fetched: Math.max(1, Math.ceil(returned / 25)), stopped_reason: complete ? "end_of_pool" : "deadline" });

function input(over: Partial<YahooMarketBuildInput> = {}): YahooMarketBuildInput {
  const rows = [row(10, "WR", "LV", "FA"), row(11, "RB", "TB", "W"), row(12, "K", "GB", "FA"), row(13, "DEF", "JAX", "FA", { name: "Jacksonville" }), row(1, "QB", "BUF", "T"), row(2, "WR", "DAL", "T", { owner_team_key: "471.l.1.t.2" })];
  return {
    league_slug: "test", season: 2026, week: 6, as_of: AS_OF, request_id: "req:1", source_snapshot_id: null, scoring_fingerprint: "scoring:v1:abc",
    rules: { source: src(), roster_positions: [{ position: "QB", count: 1 }, { position: "RB", count: 2 }, { position: "WR", count: 2 }, { position: "TE", count: 1 }, { position: "W/R/T", count: 1 }, { position: "K", count: 1 }, { position: "DEF", count: 1 }, { position: "BN", count: 6 }, { position: "IR", count: 1 }], uses_faab: false, waiver_type: "FR", waiver_rule: "gametime", waiver_time_days: 2, max_adds_season: null, max_adds_weekly: null, raw: { waiver_type: "FR", waiver_rule: "gametime", waiver_time: 2 } },
    rosters: { source: src(), teams: [team(1, [rp(1, "QB", "BUF", "QB")]), team(2, [rp(2, "WR", "DAL", "WR")])], expected_teams: 2 },
    pool: { source: src(), rows, sub: { FA: sub(3), W: sub(1), T: sub(2) } },
    transactions: { source: src() }, schedule: { source: src(), games: [{ week: 6, home: "BUF", away: "NYJ", status: "pre_game" }] },
    pending_claims: { visibility: "UNAVAILABLE", reason: "the authenticated Yahoo account owns no team in this league", entries: [] },
    canonical_id: (p) => `player:sleeper:${p.player_key.split(".p.")[1]}`,
    team_id_for_key: (k) => { const m = /\.t\.(\d+)$/.exec(k); return m ? `team:t:${m[1]}` : null; },
    ...over,
  };
}
const by = (s: MarketSnapshot, id: number) => s.players.find((p) => p.provider_player_id === `471.p.${id}`);

describe("classification comes from Yahoo's per-player status", () => {
  it("FA -> AVAILABLE_FREE_AGENT with provider-status evidence; W -> ON_WAIVERS claimable with a DATE only", () => {
    const s = buildYahooMarketSnapshot(input());
    const fa = by(s, 10)!, w = by(s, 11)!;
    assert.equal(fa.status, "AVAILABLE_FREE_AGENT"); assert.equal(fa.eligible_to_add, true);
    assert.deepEqual(fa.availability_evidence, { basis: "PROVIDER_STATUS", provider_status: "FA", provider: "yahoo", observed_at: AS_OF });
    assert.equal(w.status, "ON_WAIVERS"); assert.equal(w.claimable, true); assert.equal(w.eligible_to_add, false);
    assert.equal(w.waiver_clears_on, "2026-10-14"); assert.equal(w.waiver_clears_at, null, "a date is never promoted to an instant");
    assert.equal(w.availability_evidence?.provider_status, "W");
    assert.equal(s.provider, "yahoo"); assert.deepEqual(validateMarketSnapshot(s), []);
  });
  it("rostered players (from every team's roster) are ROSTERED with their own owner; none is addable", () => {
    const s = buildYahooMarketSnapshot(input());
    assert.equal(by(s, 1)!.status, "ROSTERED"); assert.equal(by(s, 1)!.owner_team_id, "team:t:1");
    assert.equal(by(s, 2)!.owner_team_id, "team:t:2"); assert.ok([by(s, 1)!, by(s, 2)!].every((p) => !p.eligible_to_add));
  });
  it("UNROSTERED IS NOT EVIDENCE: a player who is on no roster and in no pool does not exist as a free agent", () => {
    const s = buildYahooMarketSnapshot(input());
    assert.equal(by(s, 999), undefined);
    assert.ok(s.players.filter((p) => p.status === "AVAILABLE_FREE_AGENT").every((p) => p.availability_evidence?.provider_status === "FA"));
  });
  it("every claim of availability is structurally impossible without Yahoo's own status (integrity rejects it)", () => {
    const s = buildYahooMarketSnapshot(input());
    const forged: MarketSnapshot = { ...s, players: s.players.map((p) => (p.provider_player_id === "471.p.10" ? { ...p, availability_evidence: undefined } : p)) };
    assert.ok(validateMarketSnapshot(forged).some((v) => v.code === "AVAILABLE_WITHOUT_PROVIDER_EVIDENCE"));
    const wrong: MarketSnapshot = { ...s, players: s.players.map((p) => (p.provider_player_id === "471.p.10" ? { ...p, availability_evidence: { ...p.availability_evidence!, provider_status: "W" } } : p)) };
    assert.ok(validateMarketSnapshot(wrong).some((v) => v.code === "AVAILABLE_WITHOUT_PROVIDER_EVIDENCE"));
  });
});

describe("ownership contradictions are UNKNOWN, never available", () => {
  it("a rostered player that Yahoo also lists as FA -> UNKNOWN_AVAILABILITY / OWNERSHIP_CONFLICT", () => {
    const s = buildYahooMarketSnapshot(input({ pool: { source: src(), rows: [...input().pool.rows, row(1, "QB", "BUF", "FA")], sub: { FA: sub(4), W: sub(1), T: sub(2) } } }));
    const p = by(s, 1)!; assert.equal(p.status, "UNKNOWN_AVAILABILITY"); assert.equal(p.reason, "OWNERSHIP_CONFLICT"); assert.equal(p.eligible_to_add, false);
    assert.ok(s.readiness.limitations.includes("OWNERSHIP_CONFLICT")); assert.equal(s.readiness.pool_actionable, true, "one contradiction does not erase the pool");
    assert.equal(buildFreeAgentPool(s).members.some((m) => m.provider_player_id === "471.p.1"), false);
  });
  it("a player in two pools (FA and W) is UNKNOWN", () => {
    const s = buildYahooMarketSnapshot(input({ pool: { source: src(), rows: [...input().pool.rows, row(10, "WR", "LV", "W")], sub: { FA: sub(3), W: sub(2), T: sub(2) } } }));
    assert.equal(by(s, 10)!.status, "UNKNOWN_AVAILABILITY");
  });
  it("two teams listing the same player -> UNKNOWN (never silently owned by one)", () => {
    const s = buildYahooMarketSnapshot(input({ rosters: { source: src(), teams: [team(1, [rp(1, "QB", "BUF", "QB")]), team(2, [rp(1, "QB", "BUF", "QB")])], expected_teams: 2 } }));
    assert.equal(by(s, 1)!.status, "UNKNOWN_AVAILABILITY");
  });
  it("rows Yahoo returned in an FA/W query while its own ownership said 'team' count as conflicts", () => {
    const s = buildYahooMarketSnapshot(input({ pool: { source: src(), rows: input().pool.rows, sub: { FA: { ...sub(3), dropped_rostered: 2 }, W: sub(1), T: sub(2) } } }));
    assert.ok(s.readiness.limitations.includes("OWNERSHIP_CONFLICT"));
  });
  it("T-pool player on no roster we read: with every roster read it is a CONFLICT; with a roster missing it is owned per Yahoo's pool", () => {
    const ghost = row(77, "WR", "SF", "T", { owner_team_key: "471.l.1.t.3" });
    const full = buildYahooMarketSnapshot(input({ pool: { source: src(), rows: [...input().pool.rows, ghost], sub: { FA: sub(3), W: sub(1), T: sub(3) } } }));
    assert.equal(by(full, 77)!.status, "UNKNOWN_AVAILABILITY");
    const missing = buildYahooMarketSnapshot(input({ rosters: { source: src("PARTIAL", AS_OF, "1 of 3 roster reads failed"), teams: input().rosters.teams, expected_teams: 3 }, pool: { source: src(), rows: [...input().pool.rows, ghost], sub: { FA: sub(3), W: sub(1), T: sub(3) } } }));
    assert.equal(by(missing, 77)!.status, "ROSTERED"); assert.equal(by(missing, 77)!.owner_team_id, "team:t:3");
    assert.ok(missing.readiness.limitations.includes("ROSTER_STATE_PARTIAL"));
  });
});

describe("the union of every roster read is reconciled against Yahoo's own rostered pool", () => {
  it("agreeing reads reconcile exactly and are marked comparable", () => {
    const s = buildYahooMarketSnapshot(input()); assert.deepEqual(s.ownership_reconciliation, { comparable: true, roster_union: 2, provider_rostered_pool: 2, in_both: 2, roster_only: 0, pool_only: 0, tolerance: 2 });
  });
  it("a large disagreement (players on rosters that Yahoo's COMPLETE rostered pool does not list) is surfaced as OWNERSHIP_CONFLICT, not ignored", () => {
    const many = Array.from({ length: 5 }, (_, i) => rp(300 + i, "WR", "DAL", "BN"));
    const s = buildYahooMarketSnapshot(input({ rosters: { source: src(), teams: [team(1, [rp(1, "QB", "BUF", "QB"), ...many]), team(2, [rp(2, "WR", "DAL", "WR")])], expected_teams: 2 } }));
    assert.equal(s.ownership_reconciliation!.roster_only, 5); assert.ok(s.readiness.limitations.includes("OWNERSHIP_CONFLICT"));
  });
  it("a one- or two-player difference is within tolerance (a claim can process between the two reads)", () => {
    const s = reconcileSmall();
    assert.equal(s.ownership_reconciliation!.roster_only, 1); assert.equal(s.readiness.limitations.includes("OWNERSHIP_CONFLICT"), false);
    function reconcileSmall() { return buildYahooMarketSnapshot(input({ rosters: { source: src(), teams: [team(1, [rp(1, "QB", "BUF", "QB"), rp(300, "WR", "DAL", "BN")]), team(2, [rp(2, "WR", "DAL", "WR")])], expected_teams: 2 } })); }
  });
  it("an incomplete rostered pool makes the comparison NOT comparable (it would prove nothing) and raises no conflict", () => {
    const many = Array.from({ length: 5 }, (_, i) => rp(300 + i, "WR", "DAL", "BN"));
    const s = buildYahooMarketSnapshot(input({ rosters: { source: src(), teams: [team(1, [rp(1, "QB", "BUF", "QB"), ...many]), team(2, [rp(2, "WR", "DAL", "WR")])], expected_teams: 2 }, pool: { source: src("PARTIAL"), rows: input().pool.rows, sub: { FA: sub(3), W: sub(1), T: sub(2, false) } } }));
    assert.equal(s.ownership_reconciliation!.comparable, false); assert.equal(s.readiness.limitations.includes("OWNERSHIP_CONFLICT"), false);
  });
});

describe("K and D/ST are first-class, with provider-neutral identity", () => {
  it("kickers and defenses available on Yahoo are in the pool", () => {
    const s = buildYahooMarketSnapshot(input()); const pool = buildFreeAgentPool(s);
    assert.ok(pool.members.some((m) => m.position === "K")); assert.ok(pool.members.some((m) => m.position === "DEF" && m.entity === "TEAM_DEFENSE"));
    assert.ok(pool.claimable.length >= 1); assert.equal(acquirablePlayers(pool).length, pool.members.length + pool.claimable.length);
  });
  it("D/ST identity is defense:nfl:<team> whatever alias Yahoo uses (JAX/JAC, WAS/WSH, LA -> LAR)", () => {
    const cases: Array<[string, string, string]> = [["Jacksonville", "JAX", "jax"], ["Jacksonville", "JAC", "jax"], ["Washington", "WSH", "was"], ["Washington", "Was", "was"], ["Los Angeles Rams", "LA", "lar"], ["Los Angeles Chargers", "LAC", "lac"], ["New York Giants", "NYG", "nyg"], ["New York Jets", "NYJ", "nyj"]];
    cases.forEach(([name, abbr, want], i) => {
      const s = buildYahooMarketSnapshot(input({ pool: { source: src(), rows: [row(900 + i, "DEF", abbr, "FA", { name })], sub: { FA: sub(1), W: sub(0), T: sub(0) } }, rosters: { source: src(), teams: [], expected_teams: 0 } , canonical_id: () => "SHOULD_NOT_BE_USED" }));
      const p = by(s, 900 + i)!; assert.equal(p.canonical_player_id, `defense:nfl:${want}`, `${name}/${abbr}`);
    });
  });
  it("an AMBIGUOUS defense ('New York', 'NY') is never mapped to a franchise: UNKNOWN / IDENTITY_UNRESOLVED", () => {
    const s = buildYahooMarketSnapshot(input({ pool: { source: src(), rows: [row(950, "DEF", "NY", "FA", { name: "New York" }), row(951, "DEF", "LA", "FA", { name: "Los Angeles" })], sub: { FA: sub(2), W: sub(0), T: sub(0) } }, rosters: { source: src(), teams: [], expected_teams: 0 } }));
    const a = by(s, 950)!; assert.equal(a.status, "UNKNOWN_AVAILABILITY"); assert.equal(a.reason, "IDENTITY_UNRESOLVED"); assert.equal(a.canonical_player_id, null);
    assert.ok(s.readiness.limitations.includes("IDENTITY_UNRESOLVED_PLAYERS"));
  });
  it("position vocabulary folds (DST/D/ST/PK) and flex slots expand to the positions they accept", () => {
    assert.equal(foldYahooPosition("D/ST"), "DEF"); assert.equal(foldYahooPosition("pk"), "K");
    assert.deepEqual(yahooStartablePositions([{ position: "QB", count: 1 }, { position: "W/R/T", count: 1 }, { position: "K", count: 1 }, { position: "DEF", count: 1 }, { position: "BN", count: 5 }, { position: "IR", count: 1 }]), ["DEF", "K", "QB", "RB", "TE", "WR"]);
    assert.deepEqual(yahooStartablePositions([{ position: "WR", count: 2 }, { position: "W/T", count: 1 }]), ["TE", "WR"]);
    assert.deepEqual(yahooStartablePositions([{ position: "QB", count: 1 }, { position: "Q/W/R/T", count: 1 }]), ["QB", "RB", "TE", "WR"]);
  });
  it("positions the league cannot start (IDP) are counted as ineligible, not enumerated", () => {
    const s = buildYahooMarketSnapshot(input({ pool: { source: src(), rows: [...input().pool.rows, row(970, "LB", "DAL", "FA"), row(971, "DB", "DAL", "FA")], sub: { FA: sub(5), W: sub(1), T: sub(2) } } }));
    assert.equal(by(s, 970), undefined); assert.equal(s.ineligible_counts.POSITION_NOT_IN_LEAGUE, 2);
  });
  it("a player with no resolvable canonical identity is STILL verified available (valuation cannot use him, availability can)", () => {
    const s = buildYahooMarketSnapshot(input({ canonical_id: () => null }));
    assert.equal(by(s, 10)!.status, "AVAILABLE_FREE_AGENT"); assert.equal(by(s, 10)!.canonical_player_id, null);
    assert.ok(s.readiness.limitations.includes("IDENTITY_UNRESOLVED_PLAYERS")); assert.equal(s.readiness.axes!.availability, "READY");
  });
});

describe("pool certainty is separate from transaction certainty (readiness axes)", () => {
  it("availability READY while transaction is PARTIAL (no pending-claim visibility, rules partial) — the pool is still actionable", () => {
    const s = buildYahooMarketSnapshot(input({ rules: { ...input().rules, source: src("UNAVAILABLE", null, "PROVIDER_ERROR: settings 500"), roster_positions: null, uses_faab: null, waiver_type: null, waiver_time_days: null, raw: null } }));
    assert.equal(s.readiness.pool_actionable, true); assert.equal(s.readiness.axes!.availability, "READY"); assert.equal(s.readiness.axes!.transaction, "PARTIAL");
    assert.notEqual(s.readiness.axes!.recommendation, "NOT_READY"); assert.ok(s.readiness.limitations.includes("WAIVER_RULES_PARTIAL")); assert.equal(s.acquisition.rules.system, "UNKNOWN");
    assert.ok(by(s, 10)!.status === "AVAILABLE_FREE_AGENT", "a missing acquisition setting does not erase the pool");
  });
  it("pending claims UNAVAILABLE is an INFO limitation, never a block", () => {
    const s = buildYahooMarketSnapshot(input());
    assert.equal(s.pending_claim_visibility!.status, "UNAVAILABLE"); assert.ok(s.readiness.reasons.some((r) => r.code === "PENDING_CLAIMS_UNAVAILABLE" && r.severity === "INFO"));
    assert.equal(s.readiness.pool_actionable, true); assert.deepEqual(s.readiness.blocks, []);
  });
  it("the connected account's OWN pending claim marks that player WAIVER_CLAIM_PENDING and removes him from the claimable pool", () => {
    const s = buildYahooMarketSnapshot(input({ pending_claims: { visibility: "AVAILABLE", reason: "read 1 owned team", entries: [{ team_key: "471.l.1.t.1", add_player_key: "471.p.11", drop_player_key: "471.p.1", bid: 7 }] } }));
    const p = by(s, 11)!; assert.equal(p.status, "WAIVER_CLAIM_PENDING"); assert.equal(p.claimable, false); assert.deepEqual(p.pending_claim, { team_key: "471.l.1.t.1", bid: 7, drop_player_key: "471.p.1" });
    assert.equal(buildFreeAgentPool(s).claimable.some((m) => m.provider_player_id === "471.p.11"), false); assert.deepEqual(validateMarketSnapshot(s), []);
    assert.equal(s.pending_claim_visibility!.status, "AVAILABLE");
  });
  it("game locks UNKNOWN (schedule unreadable) are reported per player and do not erase the pool", () => {
    const s = buildYahooMarketSnapshot(input({ schedule: { source: src("UNAVAILABLE", null, "PROVIDER_ERROR: schedule"), games: null } }));
    assert.ok(s.readiness.limitations.includes("GAME_LOCK_UNVERIFIABLE")); assert.equal(by(s, 10)!.lock, "UNKNOWN"); assert.equal(by(s, 10)!.status, "AVAILABLE_FREE_AGENT"); assert.equal(s.readiness.pool_actionable, true);
  });
  it("game state is a per-player FACT (OPEN / LOCKED), not an availability verdict", () => {
    const s = buildYahooMarketSnapshot(input({ schedule: { source: src(), games: [{ week: 6, home: "GB", away: "CHI", status: "complete" }, { week: 6, home: "LV", away: "DEN", status: "pre_game" }] } }));
    assert.equal(by(s, 12)!.lock, "LOCKED"); assert.equal(by(s, 12)!.status, "AVAILABLE_FREE_AGENT"); assert.equal(by(s, 10)!.lock, "OPEN");
    assert.match(s.game_lock_semantics!, /Yahoo's own per-player status/);
  });
  it("acquisition rules: FAAB vs priority, raw settings preserved verbatim, add limits when stated", () => {
    const faab = buildYahooMarketSnapshot(input({ rules: { ...input().rules, uses_faab: true, waiver_type: "FAAB", max_adds_season: 40, max_adds_weekly: 4 }, rosters: { source: src(), teams: [team(1, [rp(1, "QB", "BUF", "QB")], { faab_balance: 88 }), team(2, [rp(2, "WR", "DAL", "WR")], { faab_balance: 100 })], expected_teams: 2 } }));
    assert.equal(faab.acquisition.rules.system, "FAAB"); assert.deepEqual(faab.acquisition.rules.add_limits, { season: 40, weekly: 4 });
    assert.equal(faab.acquisition.teams.find((t) => t.team_id === "team:t:1")!.faab_remaining, 88); assert.equal(faab.acquisition.rules.provider_raw!.waiver_rule, "gametime");
    const pri = buildYahooMarketSnapshot(input()); assert.equal(pri.acquisition.rules.system, "PRIORITY"); assert.equal(pri.acquisition.teams.every((t) => t.faab_remaining === null), true);
    assert.equal(buildYahooMarketSnapshot(input({ rules: { ...input().rules, waiver_type: "continual" } })).acquisition.rules.priority_rule, "ROLLING");
  });
});

describe("failures are visible and never fabricate availability", () => {
  it("both FA and W pools unreadable -> BLOCKED (PLAYER_UNIVERSE_UNAVAILABLE), no player is available", () => {
    const s = buildYahooMarketSnapshot(input({ pool: { source: src("UNAVAILABLE", null, "PROVIDER_ERROR: player pools: AUTH"), rows: [], sub: {} } }));
    assert.equal(s.readiness.pool_actionable, false); assert.ok(s.readiness.blocks.includes("PLAYER_UNIVERSE_UNAVAILABLE")); assert.ok(s.readiness.blocks.includes("PROVIDER_ERROR"));
    assert.equal(s.counts.AVAILABLE_FREE_AGENT, 0); assert.equal(s.readiness.axes!.availability, "NOT_READY"); assert.equal(s.readiness.axes!.recommendation, "NOT_READY");
  });
  it("only the FA pool unreadable -> PARTIAL: waiver players still verified, FA list empty (never guessed)", () => {
    const s = buildYahooMarketSnapshot(input({ pool: { source: src("PARTIAL", AS_OF, "FA: RATE_LIMITED"), rows: input().pool.rows.filter((r) => r.status !== "FA"), sub: { W: sub(1), T: sub(2) } } }));
    assert.equal(s.counts.AVAILABLE_FREE_AGENT, 0); assert.equal(s.counts.ON_WAIVERS, 1); assert.ok(s.readiness.limitations.includes("PLAYER_UNIVERSE_PARTIAL")); assert.equal(s.readiness.axes!.availability, "PARTIAL"); assert.equal(s.readiness.pool_actionable, true);
  });
  it("a pool that stopped before its end is PARTIAL and says which", () => {
    const s = buildYahooMarketSnapshot(input({ pool: { source: src("PARTIAL", AS_OF, "FA stopped at deadline"), rows: input().pool.rows, sub: { FA: sub(3, false), W: sub(1), T: sub(2) } } }));
    assert.ok(s.readiness.reasons.find((r) => r.code === "PLAYER_UNIVERSE_PARTIAL")!.detail.includes("FA"));
    assert.equal(s.pool_evidence!.FA!.complete, false); assert.equal(by(s, 10)!.status, "AVAILABLE_FREE_AGENT", "players that WERE returned are individually verified");
  });
  it("no roster readable AND an incomplete rostered pool -> ownership unknowable -> BLOCKED", () => {
    const s = buildYahooMarketSnapshot(input({ rosters: { source: src("UNAVAILABLE", null, "PROVIDER_ERROR: rosters"), teams: [], expected_teams: 4 }, pool: { source: src(), rows: input().pool.rows, sub: { FA: sub(3), W: sub(1), T: sub(2, false) } } }));
    assert.ok(s.readiness.blocks.includes("ROSTER_STATE_UNAVAILABLE")); assert.equal(s.readiness.pool_actionable, false);
  });
  it("stale sources block: nothing older than the freshness ceiling is served as actionable", () => {
    const old = new Date(Date.parse(AS_OF) - 11 * 60_000).toISOString();
    const s = buildYahooMarketSnapshot(input({ pool: { source: src("OK", old), rows: input().pool.rows, sub: input().pool.sub } }));
    assert.ok(s.readiness.blocks.includes("STALE_MARKET_STATE")); assert.equal(s.freshness!.state, "STALE"); assert.equal(s.readiness.pool_actionable, false);
    const fresh = buildYahooMarketSnapshot(input({ evaluated_at: new Date(Date.parse(AS_OF) + 60_000).toISOString() })); assert.equal(fresh.freshness!.state, "FRESH"); assert.equal(fresh.freshness!.age_ms, 60_000);
  });
  it("transaction feed down is a LIMITATION (availability still comes from Yahoo's statuses)", () => {
    const s = buildYahooMarketSnapshot(input({ transactions: { source: src("UNAVAILABLE", null, "PROVIDER_ERROR: transactions") } }));
    assert.ok(s.readiness.limitations.includes("WAIVER_STATE_UNVERIFIABLE")); assert.equal(s.readiness.pool_actionable, true);
  });
});

describe("determinism, identity and history", () => {
  it("identical inputs -> byte-identical snapshot; content id ignores request id and read time but sees a market change", () => {
    const a = buildYahooMarketSnapshot(input()), b = buildYahooMarketSnapshot(input());
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    const c = buildYahooMarketSnapshot(input({ request_id: "req:other" }));
    assert.equal(a.identities.market_content_id, c.identities.market_content_id);
    const moved = buildYahooMarketSnapshot(input({ pool: { source: src(), rows: input().pool.rows.filter((r) => r.player_key !== "471.p.10"), sub: input().pool.sub } }));
    assert.notEqual(a.identities.market_content_id, moved.identities.market_content_id);
  });
  it("the exact scoring fingerprint travels with the market", () => assert.equal(buildYahooMarketSnapshot(input()).identities.scoring_fingerprint, "scoring:v1:abc"));
  it("a Yahoo snapshot compacts for history without throwing (waiver players carry no drop window)", () => {
    const c = compactMarketSnapshot(buildYahooMarketSnapshot(input()));
    assert.ok(c.waivers.length === 1 && c.available.length >= 3);
  });
});
