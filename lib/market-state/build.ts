/**
 * Phase 4.5 — the PURE market-snapshot builder. No I/O, no clock, no randomness: every input (including `as_of`,
 * `request_id`) is passed in, so identical inputs produce a byte-identical snapshot and the semantic `market_content_id`
 * depends ONLY on what the market says (ownership, eligible universe, waiver window, rules, locks, readiness codes).
 *
 * How a player becomes AVAILABLE_FREE_AGENT — every one of these must hold (see `docs/...PHASE_4_5_MARKET_STATE.md` §2.6):
 *   roster state verified · rules verified · universe verified · identity eligible (classifier) · not on ANY roster ·
 *   no provable drop inside the league's waiver-clear window (transaction feed verified). Game lock is reported per player (`lock`) and in
 *   `lock_id` but is NOT part of `market_content_id` and does not remove a player from the pool (see the lock note below).
 */
import { MARKET_ELIGIBILITY_RULES_VERSION, MARKET_STATE_VERSION, PLAYER_MARKET_STATUSES, PROVIDER_LIMITATIONS, type AcquisitionContext, type LeagueAcquisitionRules, type LockState, type MarketReadiness, type MarketSnapshot, type MarketSources, type PlayerMarketState, type PlayerMarketStatus, type ReadinessReason, type RosterSlotKind, type SourceReport, BLOCKING_REASON_CODES } from "./contract";
import { classifyUniversePlayer, startablePositionsFor, type UniversePlayer } from "./classify";
import { hashOf } from "./hash";
import { validateMarketSnapshot } from "./integrity";

export interface RosterInput { team_id: string; roster_id: number; players: string[]; reserve: string[]; taxi: string[]; faab_used: number | null; waiver_position: number | null }
export interface TransactionInput { type: string; status: string; status_updated: number | null; adds: string[]; drops: string[] }
export interface ScheduleGameInput { week: number; home?: string | null; away?: string | null; status?: string | null }

export interface MarketBuildInput {
  league_slug: string; season: number; week: number;
  /** The read time (also the "now" used for waiver windows). */
  as_of: string;
  /** Per-read; excluded from every content identity. */
  request_id: string; source_snapshot_id: string | null; scoring_fingerprint: string | null;
  /** When the snapshot is being EVALUATED (defaults to as_of). Only staleness uses it. */
  evaluated_at?: string;
  stale_after_ms?: number;
  universe_stale_after_ms?: number;
  rules: { source: SourceReport; settings: Record<string, number> | null; roster_positions: string[] | null };
  rosters: { source: SourceReport; teams: RosterInput[] };
  universe: { source: SourceReport; players: UniversePlayer[] };
  transactions: { source: SourceReport; entries: TransactionInput[] };
  schedule: { source: SourceReport; games: ScheduleGameInput[] | null };
  /** Optional identity bridge to the canonical layer. Never required for ownership. */
  canonical_id?: (providerPlayerId: string) => string | null;
}

export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;
export const DEFAULT_UNIVERSE_STALE_AFTER_MS = 26 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const NON_ROSTER_SLOTS = new Set(["BN", "IR", "TAXI"]);

export function deriveRules(rules: MarketBuildInput["rules"], rosters: RosterInput[]): LeagueAcquisitionRules {
  const s = rules.settings; const pos = rules.roster_positions;
  if (rules.source.status === "UNAVAILABLE" || !s || !pos) return { system: "UNKNOWN", faab_budget: null, faab_min_bid: null, waiver_clear_days: null, waiver_day_of_week: null, reserve_slots: null, taxi_slots: null, startable_positions: [] };
  const wt = s.waiver_type; const system = wt === 2 ? "FAAB" : wt === 0 || wt === 1 ? "PRIORITY" : "UNKNOWN";
  const num = (k: string): number | null => (typeof s[k] === "number" && Number.isFinite(s[k]) ? (s[k] as number) : null);
  void rosters;
  return {
    system,
    // A stray waiver_budget in a priority league is NOT a currency (Devoted carries budget 1000 with reverse-standings waivers).
    faab_budget: system === "FAAB" ? (num("waiver_budget") ?? null) : null, faab_min_bid: system === "FAAB" ? (num("waiver_bid_min") ?? 0) : null,
    waiver_clear_days: num("waiver_clear_days"), waiver_day_of_week: num("waiver_day_of_week"),
    reserve_slots: num("reserve_slots") ?? pos.filter((p) => p === "IR").length, taxi_slots: num("taxi_slots") ?? pos.filter((p) => p === "TAXI").length,
    startable_positions: startablePositionsFor(pos),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function lockByTeam(games: ScheduleGameInput[] | null, week: number): Map<string, LockState> | null {
  if (!games || !games.length) return null; const wk = games.filter((g) => g.week === week); if (!wk.length) return null;
  const m = new Map<string, LockState>();
  for (const g of wk) {
    const st = (g.status ?? "").trim().toLowerCase(); const state: LockState = st === "pre_game" ? "OPEN" : st === "in_game" || st === "complete" ? "LOCKED" : "UNKNOWN";
    for (const t of [g.home, g.away]) if (t) m.set(t.toUpperCase(), state);
  }
  return m;
}

export function buildMarketSnapshot(input: MarketBuildInput): MarketSnapshot {
  const evaluatedMs = Date.parse(input.evaluated_at ?? input.as_of); const asOfMs = Date.parse(input.as_of);
  const staleMs = input.stale_after_ms ?? DEFAULT_STALE_AFTER_MS; const uniStaleMs = input.universe_stale_after_ms ?? DEFAULT_UNIVERSE_STALE_AFTER_MS;
  const rules = deriveRules(input.rules, input.rosters.teams);
  const rulesOk = input.rules.source.status !== "UNAVAILABLE" && rules.waiver_clear_days != null && rules.system !== "UNKNOWN" && rules.startable_positions.length > 0;
  const rostersOk = input.rosters.source.status === "OK";
  const universeOk = input.universe.source.status === "OK" && input.universe.players.length > 0;
  const txOk = input.transactions.source.status === "OK";
  const lockMap = input.schedule.source.status === "UNAVAILABLE" ? null : lockByTeam(input.schedule.games, input.week);
  const reasons: ReadinessReason[] = []; const add = (r: ReadinessReason) => { if (!reasons.some((x) => x.code === r.code)) reasons.push(r); };

  const ageMs = (s: SourceReport, ceil: number) => { if (!s.fetched_at) return null; const a = evaluatedMs - Date.parse(s.fetched_at); return Number.isFinite(a) ? { age: a, stale: a > ceil } : null; };
  const stale: string[] = [];
  for (const [name, src, ceil] of [["rosters", input.rosters.source, staleMs], ["rules", input.rules.source, staleMs], ["transactions", input.transactions.source, staleMs], ["universe", input.universe.source, uniStaleMs]] as const) { const a = ageMs(src, ceil); if (a?.stale) stale.push(name); }
  const freshness = (name: string, s: SourceReport) => (s.status === "UNAVAILABLE" ? "UNKNOWN" as const : stale.includes(name) ? "STALE" as const : "FRESH" as const);

  if (!input.universe.source.status || input.universe.source.status === "UNAVAILABLE" || !universeOk) add({ code: "PLAYER_UNIVERSE_UNAVAILABLE", severity: "BLOCKING", detail: input.universe.source.detail ?? "player universe could not be read" });
  if (!rostersOk) add({ code: "ROSTER_STATE_UNAVAILABLE", severity: "BLOCKING", detail: input.rosters.source.detail ?? "league rosters could not be read; ownership is unknowable" });
  if (!rulesOk) add({ code: "ACQUISITION_RULES_UNKNOWN", severity: "BLOCKING", detail: input.rules.source.detail ?? "league waiver rules could not be established" });
  if (!txOk) add({ code: "WAIVER_STATE_UNVERIFIABLE", severity: "BLOCKING", detail: input.transactions.source.detail ?? "the transaction feed could not be read; recently dropped players cannot be identified" });
  if ([input.universe, input.rosters, input.rules, input.transactions].some((x) => x.source.status === "UNAVAILABLE" && /^PROVIDER_ERROR/.test(x.source.detail ?? ""))) add({ code: "PROVIDER_ERROR", severity: "BLOCKING", detail: "one or more provider reads failed" });
  if (stale.length) add({ code: "STALE_MARKET_STATE", severity: "BLOCKING", detail: `stale source(s): ${stale.join(", ")}` });
  if (!lockMap) add({ code: "GAME_LOCK_UNVERIFIABLE", severity: "LIMITING", detail: "the NFL schedule for this week could not be read; game locks are UNKNOWN (not assumed open)" });
  add({ code: "PENDING_CLAIMS_NOT_EXPOSED", severity: "INFO", detail: PROVIDER_LIMITATIONS.PENDING_CLAIMS_NOT_EXPOSED! });
  add({ code: "WAIVER_CLEAR_TIME_NOT_EXPOSED", severity: "INFO", detail: PROVIDER_LIMITATIONS.WAIVER_CLEAR_TIME_NOT_EXPOSED! });

  /* ---- ownership (authoritative, from rosters) ---- */
  const src = (klass: "PROVIDER_LIVE" | "PROVIDER_DERIVED" | "INFERRED", name: string, s: SourceReport) => ({ provider: "sleeper" as const, source_class: klass, freshness: freshness(name, s) });
  const players: PlayerMarketState[] = []; const rosteredIds = new Set<string>(); const universeById = new Map(input.universe.players.map((p) => [p.player_id, p] as const));
  let identityIncomplete = 0;
  const mk = (id: string, u: UniversePlayer | undefined, o: Partial<PlayerMarketState> & Pick<PlayerMarketState, "status" | "ownership" | "acquisition" | "eligible_to_add">): PlayerMarketState => {
    const isDef = (u?.position ?? "").toUpperCase() === "DEF";
    return { player_key: `sleeper:${id}`, provider: "sleeper", provider_player_id: id, entity: isDef ? "TEAM_DEFENSE" : "PLAYER", canonical_player_id: input.canonical_id?.(id) ?? null, full_name: u?.full_name ?? null, position: u ? (isDef ? "DEF" : u.position) : null, team: u?.team ?? (isDef ? id : null), league_slug: input.league_slug, season: input.season, week: input.week, as_of: input.as_of, owner_team_id: null, roster_slot: null, waiver_clears_at: null, waiver_window: null, reason: null, lock: "UNKNOWN", caveats: [], injury_status: u?.injury_status ?? null, nfl_status: u?.status ?? null, source: src("PROVIDER_DERIVED", "rosters", input.rosters.source), ...o };
  };
  if (rostersOk) {
    for (const t of input.rosters.teams) {
      const slotOf = (id: string): RosterSlotKind => (t.reserve.includes(id) ? "RESERVE" : t.taxi.includes(id) ? "TAXI" : "ACTIVE");
      for (const id of t.players) { if (!id || id === "0") continue; rosteredIds.add(id); const u = universeById.get(id); if (!u) identityIncomplete += 1;
        players.push(mk(id, u, { status: "ROSTERED", ownership: "ROSTERED", owner_team_id: t.team_id, roster_slot: slotOf(id), acquisition: { status: "UNAVAILABLE", mechanism: "NONE" }, eligible_to_add: false, reason: "OWNED", source: src("PROVIDER_LIVE", "rosters", input.rosters.source) })); }
    }
  }
  if (identityIncomplete) add({ code: "IDENTITY_INCOMPLETE", severity: "LIMITING", detail: `${identityIncomplete} rostered provider id(s) are absent from the player universe (still owned; identity/position unknown)` });

  /* ---- waiver window (provable drops only) ---- */
  const windowByPlayer = new Map<string, number>();
  if (txOk && rules.waiver_clear_days != null) {
    const windowMs = rules.waiver_clear_days * DAY_MS;
    for (const tx of input.transactions.entries) {
      if (tx.status !== "complete" || !["free_agent", "waiver", "commissioner"].includes(tx.type) || tx.status_updated == null) continue;
      if (tx.status_updated > asOfMs || asOfMs - tx.status_updated >= windowMs) continue;
      for (const id of tx.drops) { const prev = windowByPlayer.get(id); if (prev == null || tx.status_updated > prev) windowByPlayer.set(id, tx.status_updated); }
    }
  }

  /* ---- unrostered universe ---- */
  const startable = new Set(rulesOk ? rules.startable_positions : ["QB", "RB", "WR", "TE", "K", "DEF"]);
  const ineligible: Record<string, number> = {};
  if (universeOk) {
    for (const u of [...input.universe.players].sort((a, b) => (a.player_id < b.player_id ? -1 : 1))) {
      if (rosteredIds.has(u.player_id)) continue;
      const v = classifyUniversePlayer(u, startable);
      if (v.kind === "INELIGIBLE") { ineligible[v.reason] = (ineligible[v.reason] ?? 0) + 1; continue; }
      if (v.kind === "UNKNOWN") { players.push(mk(u.player_id, u, { status: "UNKNOWN_AVAILABILITY", ownership: rostersOk ? "UNROSTERED" : "UNKNOWN", acquisition: { status: "UNKNOWN", mechanism: "UNKNOWN" }, eligible_to_add: false, reason: v.reason, source: src("INFERRED", "universe", input.universe.source) })); continue; }
      const common = { position: v.position, team: v.team, caveats: v.caveats, source: src("INFERRED", "universe", input.universe.source) };
      if (!rostersOk) { players.push(mk(u.player_id, u, { ...common, status: "SOURCE_UNAVAILABLE", ownership: "UNKNOWN", acquisition: { status: "UNKNOWN", mechanism: "UNKNOWN" }, eligible_to_add: false, reason: "ROSTER_STATE_UNAVAILABLE" })); continue; }
      if (!rulesOk) { players.push(mk(u.player_id, u, { ...common, status: "UNKNOWN_AVAILABILITY", ownership: "UNROSTERED", acquisition: { status: "UNKNOWN", mechanism: "UNKNOWN" }, eligible_to_add: false, reason: "ACQUISITION_RULES_UNKNOWN" })); continue; }
      if (!txOk) { players.push(mk(u.player_id, u, { ...common, status: "UNKNOWN_AVAILABILITY", ownership: "UNROSTERED", acquisition: { status: "UNKNOWN", mechanism: "UNKNOWN" }, eligible_to_add: false, reason: "WAIVER_WINDOW_UNVERIFIABLE" })); continue; }
      const lock: LockState = lockMap ? (lockMap.get(v.team) ?? "OPEN") : "UNKNOWN"; // a team with no game this week is on bye: nothing to lock
      const dropped = windowByPlayer.get(u.player_id);
      if (dropped != null) { players.push(mk(u.player_id, u, { ...common, status: "ON_WAIVERS", ownership: "UNROSTERED", acquisition: { status: "WAIVER", mechanism: "WAIVER_CLAIM" }, waiver_window: { dropped_at: iso(dropped), clear_days: rules.waiver_clear_days! }, eligible_to_add: false, reason: "IN_WAIVER_WINDOW", lock })); continue; }
      // A started/complete game is a FACT about this week's points (`lock`), not proof the player cannot be added: Sleeper does not publish an
      // add-lock rule, and players are routinely added after their game ends (claims process Wednesday). So it is never a status.
      players.push(mk(u.player_id, u, { ...common, status: "AVAILABLE_FREE_AGENT", ownership: "UNROSTERED", acquisition: { status: "FREE_AGENT", mechanism: "FREE_AGENT_ADD" }, eligible_to_add: true, reason: null, lock }));
    }
  }

  /* ---- acquisition context: separate from availability ---- */
  const rosterLimit = input.rules.roster_positions ? input.rules.roster_positions.filter((p) => !NON_ROSTER_SLOTS.has(p) || p === "BN").length : null;
  const teamsCtx = input.rosters.teams.map((t) => {
    const off = new Set([...t.reserve, ...t.taxi]);
    return { team_id: t.team_id, roster_id: t.roster_id, faab_remaining: rules.system === "FAAB" && rules.faab_budget != null && t.faab_used != null ? rules.faab_budget - t.faab_used : null, waiver_priority: t.waiver_position, roster_size: t.players.filter((p) => p && p !== "0" && !off.has(p)).length, roster_limit: rosterLimit };
  }).sort((a, b) => a.roster_id - b.roster_id);
  const acqStatus = !rostersOk || !rulesOk ? "UNAVAILABLE" : rules.system === "FAAB" && teamsCtx.some((t) => t.faab_remaining == null) ? "PARTIAL" : "OK";
  if (rules.system === "FAAB" && acqStatus !== "OK") add({ code: "FAAB_CONTEXT_UNAVAILABLE", severity: "LIMITING", detail: "FAAB balances could not be established for every team; availability is unaffected" });
  const acquisition: AcquisitionContext = { rules, teams: teamsCtx, status: acqStatus, context_id: hashOf({ v: MARKET_STATE_VERSION, rules, teams: teamsCtx.map((t) => [t.team_id, t.faab_remaining, t.waiver_priority]) }) };

  /* ---- identities (request id / source snapshot id are carried, never hashed) ---- */
  players.sort((a, b) => (a.player_key < b.player_key ? -1 : 1));
  const counts = Object.fromEntries(PLAYER_MARKET_STATUSES.map((k) => [k, 0])) as Record<PlayerMarketStatus, number>;
  for (const p of players) counts[p.status] += 1;
  const ownership_id = hashOf(players.filter((p) => p.status === "ROSTERED").map((p) => [p.player_key, p.owner_team_id]));
  const universe_id = hashOf({ rules_v: MARKET_ELIGIBILITY_RULES_VERSION, ineligible, entries: players.filter((p) => p.status !== "ROSTERED").map((p) => [p.player_key, p.position, p.team, p.nfl_status, p.reason === "IN_WAIVER_WINDOW" ? null : p.reason, p.entity]) });
  const transactions_id = hashOf([...windowByPlayer.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const rules_id = hashOf({ rules, ok: rulesOk });
  const lock_id = hashOf(lockMap ? [...lockMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)) : null);

  const blocks = reasons.filter((r) => r.severity === "BLOCKING").map((r) => r.code); const limitations = reasons.filter((r) => r.severity !== "BLOCKING").map((r) => r.code);
  const sources: MarketSources = { rules: input.rules.source, rosters: input.rosters.source, universe: input.universe.source, transactions: input.transactions.source, schedule: input.schedule.source };
  const readiness: MarketReadiness = { status: blocks.length ? "NOT_READY" : reasons.some((r) => r.severity === "LIMITING") ? "PARTIAL" : "READY", pool_actionable: blocks.length === 0, reasons: reasons.sort((a, b) => (a.code < b.code ? -1 : 1)), blocks: blocks.sort() as MarketReadiness["blocks"], limitations: limitations.sort() as MarketReadiness["limitations"] };
  void BLOCKING_REASON_CODES;

  const snapshot: MarketSnapshot = {
    market_state_version: MARKET_STATE_VERSION, eligibility_rules_version: MARKET_ELIGIBILITY_RULES_VERSION, league_slug: input.league_slug, season: input.season, week: input.week, as_of: input.as_of, provider: "sleeper",
    identities: { request_id: input.request_id, source_snapshot_id: input.source_snapshot_id, ownership_id, universe_id, transactions_id, rules_id, lock_id, scoring_fingerprint: input.scoring_fingerprint, market_content_id: "" },
    history_class: blocks.length ? "UNSAFE" : "TRUE_AS_OF", sources, readiness, acquisition, players, ineligible_counts: ineligible, counts,
    limitations: reasons.filter((r) => r.severity === "INFO").map((r) => r.detail),
  };
  // Content identity: semantic only. Readiness CODES participate (a blocked market is a different market); details/timestamps do not.
  snapshot.identities.market_content_id = `mkt:${input.season}:w${String(input.week).padStart(2, "0")}:${hashOf({ v: MARKET_STATE_VERSION, league: input.league_slug, season: input.season, week: input.week, ownership_id, universe_id, transactions_id, rules_id, blocks: readiness.blocks, limitations: readiness.limitations })}`;

  const violations = validateMarketSnapshot(snapshot);
  if (violations.length) {
    snapshot.readiness = { ...readiness, status: "NOT_READY", pool_actionable: false, blocks: [...readiness.blocks, "OWNERSHIP_INTEGRITY_VIOLATION"].sort() as MarketReadiness["blocks"], reasons: [...readiness.reasons, { code: "OWNERSHIP_INTEGRITY_VIOLATION", severity: "BLOCKING", detail: `${violations.length} violation(s): ${violations.slice(0, 3).map((x) => x.code).join(", ")}` }] };
    snapshot.history_class = "UNSAFE";
    snapshot.identities.market_content_id = `mkt:${input.season}:w${String(input.week).padStart(2, "0")}:${hashOf({ v: MARKET_STATE_VERSION, league: input.league_slug, ownership_id, universe_id, transactions_id, rules_id, blocks: snapshot.readiness.blocks, limitations: snapshot.readiness.limitations })}`;
  }
  return snapshot;
}
