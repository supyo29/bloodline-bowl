/**
 * Yahoo Market State — the PURE builder. No I/O, no clock, no randomness (every input, including `as_of` and `request_id`, is passed in), so identical
 * inputs produce a byte-identical snapshot and `market_content_id` depends only on what the market says.
 *
 * It produces the SAME `MarketSnapshot` contract as the Sleeper builder, so every consumer (Waiver 2.0, the legacy weekly engine, replacement value,
 * Book-Ready, the future Dynamic VOR) reads one provider-neutral substrate. What differs is the EVIDENCE:
 *
 *   Sleeper  availability is INFERRED: not on any roster + no drop inside the waiver window + verified universe/rules/transactions.
 *   Yahoo    availability is STATED per player by the provider: the league pool queries `status=FA`, `status=W`, `status=T` (+ ownership sub-resource).
 *
 * Rules that make a Yahoo player FREE_AGENT / ON_WAIVERS (all must hold, enforced by `integrity.ts`):
 *   - Yahoo itself returned him from the FA (or W) query for THIS league  -> `availability_evidence = { basis: PROVIDER_STATUS, provider_status }`
 *   - he is not on any league roster and not returned by the rostered (T) query                  -> otherwise OWNERSHIP_CONFLICT, status UNKNOWN
 *   - he appears in exactly one pool                                                              -> otherwise OWNERSHIP_CONFLICT, status UNKNOWN
 * "Not on a roster" alone NEVER makes a Yahoo player a free agent. Unknown stays unknown.
 *
 * POOL certainty is separate from TRANSACTION certainty: a verified available pool does not require the exact waiver-clear instant, pending claims, or
 * game-lock add rules. Those are separate readiness axes (`readiness.axes`) and degrade `transaction` / `recommendation`, never `availability`.
 */
import { MARKET_ELIGIBILITY_RULES_VERSION, MARKET_STATE_VERSION, PLAYER_MARKET_STATUSES, type AcquisitionContext, type LeagueAcquisitionRules, type LockState, type MarketReadiness, type MarketSnapshot, type MarketSources, type PendingClaimVisibility, type PlayerMarketState, type PlayerMarketStatus, type PlayerCaveat, type ReadinessAxes, type ReadinessReason, type SourceReport, type AxisStatus, type TeamAcquisitionContext } from "./contract";
import { lockByTeam, DEFAULT_STALE_AFTER_MS, type ScheduleGameInput } from "./build";
import { hashOf } from "./hash";
import { validateMarketSnapshot } from "./integrity";
import { isCanonicalTeam, normalizeTeamCode } from "@/lib/canonical/team-codes";
import { resolveDefenseTeam, teamDefenseId } from "@/lib/canonical/team-defense";

export type YahooPoolStatus = "FA" | "W" | "T";
export interface YahooPoolRow {
  player_key: string;
  player_id: string;
  name: string | null;
  display_position: string | null;
  eligible_positions: string[];
  team_abbr: string | null;
  status: YahooPoolStatus;
  /** Yahoo reports a DATE (YYYY-MM-DD), never an instant. */
  waiver_clear_date: string | null;
  owner_team_key: string | null;
  ownership_type: string | null;
  injury_status: string | null;
  bye_week: number | null;
}
export interface YahooSubPool { returned: number; complete: boolean; pages_fetched: number; stopped_reason: string; /** rows Yahoo returned from an FA/W query whose own ownership said 'team' (dropped by the reader; each is an ownership contradiction) */ dropped_rostered?: number }
export interface YahooRosterPlayer { player_key: string; selected_position: string; name: string | null; display_position: string | null; eligible_positions: string[]; team_abbr: string | null; injury_status: string | null }
export interface YahooRosterTeam { team_key: string; /** canonical team id (e.g. team:rogers-park:4) */ team_id: string; players: YahooRosterPlayer[]; faab_balance: number | null; waiver_priority: number | null }
export interface YahooRulesInput {
  source: SourceReport;
  roster_positions: Array<{ position: string; count: number }> | null;
  uses_faab: boolean | null;
  waiver_type: string | null;
  waiver_rule: string | null;
  /** days, only when Yahoo states a number */
  waiver_time_days: number | null;
  max_adds_season: number | null;
  max_adds_weekly: number | null;
  /** every acquisition-related setting verbatim */
  raw: Record<string, string | number | boolean | null> | null;
}
export interface YahooPendingClaimsInput { visibility: PendingClaimVisibility; reason: string; entries: Array<{ team_key: string; add_player_key: string | null; drop_player_key: string | null; bid: number | null }> }

export interface YahooMarketBuildInput {
  league_slug: string; season: number; week: number;
  as_of: string; request_id: string; source_snapshot_id: string | null; scoring_fingerprint: string | null;
  evaluated_at?: string; stale_after_ms?: number;
  rules: YahooRulesInput;
  rosters: { source: SourceReport; teams: YahooRosterTeam[]; expected_teams: number | null };
  pool: { source: SourceReport; rows: YahooPoolRow[]; sub: Partial<Record<YahooPoolStatus, YahooSubPool>> };
  transactions: { source: SourceReport };
  schedule: { source: SourceReport; games: ScheduleGameInput[] | null };
  pending_claims: YahooPendingClaimsInput;
  /** Identity bridge to the canonical layer (crosswalk). Never required for availability; null = unresolved. */
  canonical_id?: (p: { player_key: string; name: string | null; position: string | null; team: string | null; is_defense: boolean }) => string | null;
  /** Yahoo team key -> canonical team id (used for T-pool ownership when a roster read is missing). */
  team_id_for_key?: (teamKey: string) => string | null;
}

export const YAHOO_LIMITATIONS: Record<string, string> = {
  PENDING_CLAIMS_NOT_EXPOSED: "Yahoo exposes pending waiver claims only for a team the authenticated account owns; other managers' claims are never visible, so competing pending claims are UNKNOWN.",
  WAIVER_CLEAR_TIME_NOT_EXPOSED: "Yahoo exposes a waiver clear DATE (YYYY-MM-DD), not an instant; the exact processing time is unknown.",
  GAME_LOCK_ADD_RULE_NOT_PUBLISHED: "Yahoo applies its own game-time waiver rule: its W status already reflects it (a started game moves a dropped player to waivers). The raw league rule is preserved in the acquisition rules; Bloodline reports each player's game state as a fact and does not add its own lock verdict.",
};
export const YAHOO_GAME_LOCK_SEMANTICS = "Availability is Yahoo's own per-player status (FA = addable now, W = claim-only). Game state is reported per player as a fact (`lock`); the league's raw waiver rule is preserved verbatim; no additional lock is inferred.";

/** Yahoo flex slot labels -> the positions they accept. */
const YAHOO_FLEX: Record<string, string[]> = { "W/R/T": ["RB", "WR", "TE"], "W/R": ["RB", "WR"], "W/T": ["WR", "TE"], "Q/W/R/T": ["QB", "RB", "WR", "TE"], FLEX: ["RB", "WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"] };
const YAHOO_BASE = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
const YAHOO_IDP = new Set(["DL", "LB", "DB"]);
const YAHOO_POS_FOLD: Record<string, string> = { DST: "DEF", "D/ST": "DEF", D: "DEF", PK: "K", DE: "DL", DT: "DL", OLB: "LB", ILB: "LB", CB: "DB", S: "DB", SS: "DB", FS: "DB" };
export const foldYahooPosition = (p: string): string => { const u = p.trim().toUpperCase(); return YAHOO_POS_FOLD[u] ?? u; };

export function yahooStartablePositions(rosterPositions: Array<{ position: string; count: number }> | null): string[] {
  const out = new Set<string>();
  for (const rp of rosterPositions ?? []) {
    if (rp.count <= 0) continue;
    const u = rp.position.trim().toUpperCase();
    const f = foldYahooPosition(u);
    if (YAHOO_BASE.has(f) || YAHOO_IDP.has(f)) out.add(f);
    else if (YAHOO_FLEX[u]) for (const x of YAHOO_FLEX[u]!) out.add(x);
  }
  return [...out].sort();
}

const CAVEAT_BY_INJURY: Record<string, PlayerCaveat> = { IR: "NFL_INJURED_RESERVE_DESIGNATION", "IR-R": "NFL_INJURED_RESERVE_DESIGNATION", "IR-NFI": "PUP_OR_NFI", PUP: "PUP_OR_NFI", NFI: "PUP_OR_NFI", SUSP: "SUSPENDED", NA: "NFL_INACTIVE_DESIGNATION" };
const YAHOO_CAVEATS = (inj: string | null): PlayerCaveat[] => {
  const t = (inj ?? "").trim().toUpperCase(); if (!t) return [];
  const out = new Set<PlayerCaveat>(["INJURY_DESIGNATION_PRESENT"]); const c = CAVEAT_BY_INJURY[t]; if (c) out.add(c); return [...out].sort();
};

export function deriveYahooRules(r: YahooRulesInput): LeagueAcquisitionRules {
  const startable = yahooStartablePositions(r.roster_positions);
  const system: LeagueAcquisitionRules["system"] = r.source.status === "UNAVAILABLE" ? "UNKNOWN" : r.uses_faab === true ? "FAAB" : r.uses_faab === false && r.waiver_type ? "PRIORITY" : "UNKNOWN";
  const pos = r.roster_positions ?? [];
  const count = (label: string) => pos.filter((p) => p.position.toUpperCase() === label).reduce((n, p) => n + p.count, 0);
  const wt = (r.waiver_type ?? "").toLowerCase();
  return {
    system,
    faab_budget: null, faab_min_bid: null,
    waiver_clear_days: r.waiver_time_days, waiver_day_of_week: null,
    priority_rule: system === "PRIORITY" ? (wt === "continual" ? "ROLLING" : null) : null,
    daily_waivers: null, daily_waivers_hour: null,
    reserve_slots: r.roster_positions ? count("IR") + count("IL") : null, taxi_slots: null,
    startable_positions: startable,
    provider_raw: r.raw ?? undefined,
    add_limits: r.max_adds_season != null || r.max_adds_weekly != null ? { season: r.max_adds_season, weekly: r.max_adds_weekly } : null,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function buildYahooMarketSnapshot(input: YahooMarketBuildInput): MarketSnapshot {
  const evaluatedMs = Date.parse(input.evaluated_at ?? input.as_of);
  const staleMs = input.stale_after_ms ?? DEFAULT_STALE_AFTER_MS;
  const rules = deriveYahooRules(input.rules);
  const startable = rules.startable_positions.length > 0 ? new Set(rules.startable_positions) : new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
  const rulesStructuralOk = input.rules.source.status !== "UNAVAILABLE" && rules.startable_positions.length > 0;
  const lockMap = input.schedule.source.status === "UNAVAILABLE" ? null : lockByTeam(input.schedule.games, input.week);

  const reasons: ReadinessReason[] = []; const add = (r: ReadinessReason) => { if (!reasons.some((x) => x.code === r.code)) reasons.push(r); };

  /* ---- source freshness ---- */
  const stale: string[] = []; let oldestFetched: number | null = null;
  for (const [name, src] of [["pool", input.pool.source], ["rosters", input.rosters.source], ["rules", input.rules.source]] as const) {
    if (!src.fetched_at) continue;
    const t = Date.parse(src.fetched_at); if (!Number.isFinite(t)) continue;
    oldestFetched = oldestFetched == null ? t : Math.min(oldestFetched, t);
    if (evaluatedMs - t > staleMs) stale.push(name);
  }
  const fresh = (name: string, s: SourceReport) => (s.status === "UNAVAILABLE" ? "UNKNOWN" as const : stale.includes(name) ? "STALE" as const : "FRESH" as const);

  /* ---- pool evidence ---- */
  const sub = input.pool.sub;
  const haveFA = !!sub.FA, haveW = !!sub.W, haveT = !!sub.T;
  const poolReadable = input.pool.source.status !== "UNAVAILABLE" && (haveFA || haveW);
  if (!poolReadable) add({ code: "PLAYER_UNIVERSE_UNAVAILABLE", severity: "BLOCKING", detail: input.pool.source.detail ?? "Yahoo's free-agent / waiver pools could not be read" });
  else {
    const missing = [!haveFA && "FA", !haveW && "W"].filter(Boolean) as string[];
    const incomplete = (["FA", "W", "T"] as const).filter((k) => sub[k] && !sub[k]!.complete);
    if (missing.length || incomplete.length) add({ code: "PLAYER_UNIVERSE_PARTIAL", severity: "LIMITING", detail: `${missing.length ? `pool(s) not read: ${missing.join(", ")}. ` : ""}${incomplete.length ? `pool(s) not read to the end: ${incomplete.join(", ")}. ` : ""}Listed players are individually verified; absence from the list proves nothing.` });
  }

  /* ---- rosters ---- */
  const rosterTeamsRead = input.rosters.teams.length;
  const rostersComplete = input.rosters.source.status === "OK" && (input.rosters.expected_teams == null || rosterTeamsRead >= input.rosters.expected_teams) && rosterTeamsRead > 0;
  const tPoolComplete = haveT && sub.T!.complete;
  if (!rostersComplete) {
    if (rosterTeamsRead === 0 && !tPoolComplete) add({ code: "ROSTER_STATE_UNAVAILABLE", severity: "BLOCKING", detail: input.rosters.source.detail ?? "no league roster could be read and Yahoo's rostered pool is incomplete; ownership is unknowable" });
    else add({ code: "ROSTER_STATE_PARTIAL", severity: "LIMITING", detail: `read ${rosterTeamsRead}${input.rosters.expected_teams != null ? ` of ${input.rosters.expected_teams}` : ""} league rosters; ownership of the rest comes from Yahoo's rostered pool${tPoolComplete ? "" : " (itself incomplete)"}` });
  }
  if (stale.length) add({ code: "STALE_MARKET_STATE", severity: "BLOCKING", detail: `stale source(s): ${stale.join(", ")}` });
  if (input.pool.source.status === "UNAVAILABLE" && /^PROVIDER_ERROR/.test(input.pool.source.detail ?? "")) add({ code: "PROVIDER_ERROR", severity: "BLOCKING", detail: "the Yahoo pool read failed" });
  if (!rulesStructuralOk || input.rules.waiver_time_days == null || input.rules.uses_faab == null || !input.rules.waiver_type) add({ code: "WAIVER_RULES_PARTIAL", severity: "LIMITING", detail: input.rules.source.detail ?? "some Yahoo acquisition settings could not be read or were not stated; the verified pool is unaffected" });
  if (!lockMap) add({ code: "GAME_LOCK_UNVERIFIABLE", severity: "LIMITING", detail: "the NFL schedule for this week could not be read; per-player game state is UNKNOWN (not assumed open)" });
  if (input.transactions.source.status === "UNAVAILABLE") add({ code: "WAIVER_STATE_UNVERIFIABLE", severity: "LIMITING", detail: input.transactions.source.detail ?? "the Yahoo transaction feed could not be read; recent processing is not cross-checked (availability still comes from Yahoo's own statuses)" });
  const pc = input.pending_claims;
  add(pc.visibility === "AVAILABLE"
    ? { code: "PENDING_CLAIMS_NOT_EXPOSED", severity: "INFO", detail: YAHOO_LIMITATIONS.PENDING_CLAIMS_NOT_EXPOSED! }
    : { code: pc.visibility === "UNAVAILABLE" ? "PENDING_CLAIMS_UNAVAILABLE" : "PENDING_CLAIMS_NOT_EXPOSED", severity: "INFO", detail: `${YAHOO_LIMITATIONS.PENDING_CLAIMS_NOT_EXPOSED} (${pc.reason})` });
  add({ code: "WAIVER_CLEAR_TIME_NOT_EXPOSED", severity: "INFO", detail: YAHOO_LIMITATIONS.WAIVER_CLEAR_TIME_NOT_EXPOSED! });
  add({ code: "GAME_LOCK_ADD_RULE_NOT_PUBLISHED", severity: "INFO", detail: YAHOO_LIMITATIONS.GAME_LOCK_ADD_RULE_NOT_PUBLISHED! });

  /* ---- ownership: authoritative rosters first, then Yahoo's rostered pool where a roster is missing ---- */
  const players: PlayerMarketState[] = [];
  const ownerByKey = new Map<string, string>(); // player_key -> canonical team id
  const rosterMeta = new Map<string, YahooRosterPlayer>();
  const slotByKey = new Map<string, string>();
  for (const t of input.rosters.teams) for (const p of t.players) {
    if (!p.player_key) continue;
    if (ownerByKey.has(p.player_key) && ownerByKey.get(p.player_key) !== t.team_id) { /* two owners: conflict handled below */ }
    ownerByKey.set(p.player_key, ownerByKey.has(p.player_key) && ownerByKey.get(p.player_key) !== t.team_id ? "__CONFLICT__" : t.team_id);
    rosterMeta.set(p.player_key, p); slotByKey.set(p.player_key, p.selected_position);
  }
  const poolByKey = new Map<string, YahooPoolRow[]>();
  for (const r of input.pool.rows) { const a = poolByKey.get(r.player_key) ?? []; a.push(r); poolByKey.set(r.player_key, a); }

  const evSrc = (basis: "PROVIDER_LIVE" | "PROVIDER_DERIVED", name: string, s: SourceReport) => ({ provider: "yahoo" as const, source_class: basis, freshness: fresh(name, s) });
  const classifyPosition = (display: string | null, eligible: string[]): { pos: string | null; reason: "NO_FANTASY_POSITION" | "POSITION_NOT_IN_LEAGUE" | null } => {
    const parts = [...(display ? display.split(",") : []), ...eligible].map(foldYahooPosition).filter((x) => x && !YAHOO_FLEX[x] && x !== "BN" && x !== "IR" && x !== "NA");
    if (!parts.length) return { pos: null, reason: "NO_FANTASY_POSITION" };
    const first = display ? foldYahooPosition(display.split(",")[0]!) : parts[0]!;
    const pick = startable.has(first) ? first : parts.find((x) => startable.has(x));
    return pick ? { pos: pick, reason: null } : { pos: first, reason: "POSITION_NOT_IN_LEAGUE" };
  };
  const identity = (key: string, name: string | null, pos: string | null, teamRaw: string | null): { canonical: string | null; team: string | null; entity: "PLAYER" | "TEAM_DEFENSE"; defenseUnresolved: boolean } => {
    const isDef = pos === "DEF";
    if (isDef) {
      const d = resolveDefenseTeam({ nfl_team: teamRaw, provider_player_id: null, full_name: name });
      if (d.status === "RESOLVED") return { canonical: teamDefenseId(d.team), team: d.team, entity: "TEAM_DEFENSE", defenseUnresolved: false };
      return { canonical: null, team: normalizeTeamCode(teamRaw), entity: "TEAM_DEFENSE", defenseUnresolved: true };
    }
    const team = normalizeTeamCode(teamRaw);
    return { canonical: input.canonical_id?.({ player_key: key, name, position: pos, team, is_defense: false }) ?? null, team, entity: "PLAYER", defenseUnresolved: false };
  };

  const ineligible: Record<string, number> = {};
  let unresolved = 0; let conflicts = 0;
  const mk = (key: string, o: Partial<PlayerMarketState> & Pick<PlayerMarketState, "status" | "ownership" | "acquisition" | "eligible_to_add">, meta: { name: string | null; pos: string | null; team: string | null; entity: "PLAYER" | "TEAM_DEFENSE"; canonical: string | null; injury: string | null }): PlayerMarketState => ({
    player_key: `yahoo:${key}`, provider: "yahoo", provider_player_id: key, entity: meta.entity, canonical_player_id: meta.canonical,
    full_name: meta.name, position: meta.pos, team: meta.team, league_slug: input.league_slug, season: input.season, week: input.week, as_of: input.as_of,
    owner_team_id: null, roster_slot: null, waiver_clears_at: null, waiver_window: null, reason: null, lock: "UNKNOWN", caveats: YAHOO_CAVEATS(meta.injury),
    injury_status: meta.injury, nfl_status: null, source: evSrc("PROVIDER_LIVE", "pool", input.pool.source), ...o,
  });
  const lockFor = (team: string | null): LockState => (lockMap && team ? (lockMap.get(team) ?? "OPEN") : "UNKNOWN");
  const seen = new Set<string>();

  // (1) rostered, from the team rosters
  for (const [key, owner] of [...ownerByKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const meta = rosterMeta.get(key)!; const prow = poolByKey.get(key) ?? [];
    const cp = classifyPosition(meta.display_position, meta.eligible_positions);
    const id = identity(key, meta.name, cp.pos, meta.team_abbr);
    seen.add(key);
    const nonOwnedPool = prow.filter((r) => r.status !== "T");
    if (owner === "__CONFLICT__" || nonOwnedPool.length > 0) {
      conflicts += 1;
      players.push(mk(key, { status: "UNKNOWN_AVAILABILITY", ownership: "UNKNOWN", acquisition: { status: "UNKNOWN", mechanism: "UNKNOWN" }, eligible_to_add: false, reason: "OWNERSHIP_CONFLICT" }, { name: meta.name, pos: cp.pos, team: id.team, entity: id.entity, canonical: id.canonical, injury: meta.injury_status }));
      continue;
    }
    if (!id.canonical) unresolved += 1;
    players.push(mk(key, { status: "ROSTERED", ownership: "ROSTERED", owner_team_id: owner, roster_slot: slotByKey.get(key) === "IR" || slotByKey.get(key) === "IL" ? "RESERVE" : slotByKey.get(key) === "NA" ? "TAXI" : "ACTIVE", acquisition: { status: "UNAVAILABLE", mechanism: "NONE" }, eligible_to_add: false, reason: "OWNED", provider_ownership_type: prow.find((r) => r.status === "T")?.ownership_type ?? "team", availability_evidence: { basis: "PROVIDER_STATUS", provider_status: "T", provider: "yahoo", observed_at: input.pool.source.fetched_at ?? input.as_of }, source: evSrc("PROVIDER_LIVE", "rosters", input.rosters.source), lock: lockFor(id.team) }, { name: meta.name, pos: cp.pos, team: id.team, entity: id.entity, canonical: id.canonical, injury: meta.injury_status }));
  }

  // (2) every pool row not already placed
  for (const [key, rows] of [...poolByKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (seen.has(key)) continue;
    const r0 = rows[0]!; const kinds = new Set(rows.map((r) => r.status));
    const cp = classifyPosition(r0.display_position, r0.eligible_positions);
    const id = identity(key, r0.name, cp.pos, r0.team_abbr);
    const metaOf = { name: r0.name, pos: cp.pos, team: id.team, entity: id.entity, canonical: id.canonical, injury: r0.injury_status };
    const conflictShape = kinds.size > 1;
    if (conflictShape) { conflicts += 1; players.push(mk(key, { status: "UNKNOWN_AVAILABILITY", ownership: "UNKNOWN", acquisition: { status: "UNKNOWN", mechanism: "UNKNOWN" }, eligible_to_add: false, reason: "OWNERSHIP_CONFLICT" }, metaOf)); continue; }
    if (r0.status === "T") {
      // rostered per Yahoo's pool but on no roster we read: ownership comes from the pool, or it is a conflict when every roster WAS read
      const ownerId = r0.owner_team_key ? input.team_id_for_key?.(r0.owner_team_key) ?? null : null;
      if (rostersComplete || !ownerId) { conflicts += 1; players.push(mk(key, { status: "UNKNOWN_AVAILABILITY", ownership: "UNKNOWN", acquisition: { status: "UNKNOWN", mechanism: "UNKNOWN" }, eligible_to_add: false, reason: "OWNERSHIP_CONFLICT" }, metaOf)); continue; }
      if (!id.canonical) unresolved += 1;
      players.push(mk(key, { status: "ROSTERED", ownership: "ROSTERED", owner_team_id: ownerId, roster_slot: "ACTIVE", acquisition: { status: "UNAVAILABLE", mechanism: "NONE" }, eligible_to_add: false, reason: "OWNED", provider_ownership_type: r0.ownership_type, availability_evidence: { basis: "PROVIDER_STATUS", provider_status: "T", provider: "yahoo", observed_at: input.pool.source.fetched_at ?? input.as_of }, lock: lockFor(id.team) }, metaOf));
      continue;
    }
    // FA or W
    if (cp.reason) { ineligible[cp.reason] = (ineligible[cp.reason] ?? 0) + 1; continue; }
    if (id.entity === "PLAYER" && !id.team) { ineligible.NO_NFL_TEAM = (ineligible.NO_NFL_TEAM ?? 0) + 1; continue; }
    if (id.defenseUnresolved || (id.entity === "PLAYER" && id.team && !isCanonicalTeam(id.team))) { unresolved += 1; players.push(mk(key, { status: "UNKNOWN_AVAILABILITY", ownership: "UNROSTERED", acquisition: { status: "UNKNOWN", mechanism: "UNKNOWN" }, eligible_to_add: false, reason: "IDENTITY_UNRESOLVED" }, metaOf)); continue; }
    if (!id.canonical) unresolved += 1;
    const ev = { basis: "PROVIDER_STATUS" as const, provider_status: r0.status, provider: "yahoo" as const, observed_at: input.pool.source.fetched_at ?? input.as_of };
    const lock = lockFor(id.team);
    if (r0.status === "FA") {
      players.push(mk(key, { status: "AVAILABLE_FREE_AGENT", ownership: "UNROSTERED", acquisition: { status: "FREE_AGENT", mechanism: "FREE_AGENT_ADD" }, eligible_to_add: true, reason: null, availability_evidence: ev, lock }, metaOf));
    } else {
      const d = r0.waiver_clear_date && DATE_ONLY.test(r0.waiver_clear_date) ? r0.waiver_clear_date : null;
      players.push(mk(key, { status: "ON_WAIVERS", ownership: "UNROSTERED", acquisition: { status: "WAIVER", mechanism: "WAIVER_CLAIM" }, eligible_to_add: false, claimable: true, reason: "IN_WAIVER_WINDOW", availability_evidence: ev, waiver_clears_on: d, lock }, metaOf));
    }
  }
  conflicts += (sub.FA?.dropped_rostered ?? 0) + (sub.W?.dropped_rostered ?? 0);

  /* ---- reconcile the union of every roster read with Yahoo's own rostered pool ---- */
  const rosterKeys = new Set(ownerByKey.keys()); const poolKeys = new Set(input.pool.rows.filter((r) => r.status === "T").map((r) => r.player_key));
  const inBoth = [...rosterKeys].filter((k) => poolKeys.has(k)).length;
  const comparable = rostersComplete && haveT && sub.T!.complete;
  const tolerance = Math.max(2, Math.ceil(rosterKeys.size * 0.02)); // a claim can process between the two reads
  const recon = { comparable, roster_union: rosterKeys.size, provider_rostered_pool: poolKeys.size, in_both: inBoth, roster_only: rosterKeys.size - inBoth, pool_only: poolKeys.size - inBoth, tolerance };
  if (comparable && recon.roster_only > tolerance) conflicts += recon.roster_only;
  if (conflicts > 0) add({ code: "OWNERSHIP_CONFLICT", severity: "LIMITING", detail: `${conflicts} player(s) have contradictory ownership evidence (e.g. rostered AND listed free/waivers, or in two pools); they are UNKNOWN, never available` });
  if (unresolved > 0) add({ code: "IDENTITY_UNRESOLVED_PLAYERS", severity: "LIMITING", detail: `${unresolved} player(s) have no canonical identity (still verified available/rostered by Yahoo's key; they cannot be valued until resolved)` });

  /* ---- the connected account's OWN pending claims: those players stay on waivers (Yahoo W) but are not re-recommended ---- */
  if (pc.visibility === "AVAILABLE" && pc.entries.length > 0) {
    const mine = new Map(pc.entries.filter((e) => e.add_player_key).map((e) => [e.add_player_key!, e] as const));
    for (let i = 0; i < players.length; i += 1) {
      const p = players[i]!; const e = p.provider_player_id ? mine.get(p.provider_player_id) : undefined;
      if (p.status === "ON_WAIVERS" && e) players[i] = { ...p, status: "WAIVER_CLAIM_PENDING", claimable: false, reason: "IN_WAIVER_WINDOW", pending_claim: { team_key: e.team_key, bid: e.bid, drop_player_key: e.drop_player_key } };
    }
  }

  /* ---- acquisition context (separate from availability) ---- */
  const teamsCtx: TeamAcquisitionContext[] = input.rosters.teams.map((t, i) => {
    const off = new Set(t.players.filter((p) => ["IR", "IL", "NA"].includes(p.selected_position)).map((p) => p.player_key));
    const rosterLimit = input.rules.roster_positions ? input.rules.roster_positions.filter((p) => !["IR", "IL", "NA"].includes(p.position.toUpperCase())).reduce((n, p) => n + p.count, 0) : null;
    return { team_id: t.team_id, roster_id: i + 1, faab_remaining: input.rules.uses_faab ? t.faab_balance : null, waiver_priority: t.waiver_priority, roster_size: t.players.filter((p) => !off.has(p.player_key)).length, roster_limit: rosterLimit };
  }).sort((a, b) => (a.team_id < b.team_id ? -1 : 1)).map((t, i) => ({ ...t, roster_id: i + 1 }));
  const acqStatus = !rostersComplete && rosterTeamsRead === 0 ? "UNAVAILABLE" : rules.system === "FAAB" && teamsCtx.some((t) => t.faab_remaining == null) ? "PARTIAL" : rules.system === "UNKNOWN" || !rostersComplete ? "PARTIAL" : "OK";
  if (rules.system === "FAAB" && acqStatus === "PARTIAL") add({ code: "FAAB_CONTEXT_UNAVAILABLE", severity: "LIMITING", detail: "FAAB balances could not be established for every team; availability is unaffected" });
  const acquisition: AcquisitionContext = { rules, teams: teamsCtx, visible_winning_bids: [], status: acqStatus, context_id: hashOf({ v: MARKET_STATE_VERSION, rules, teams: teamsCtx.map((t) => [t.team_id, t.faab_remaining, t.waiver_priority]) }) };

  /* ---- identities ---- */
  players.sort((a, b) => (a.player_key < b.player_key ? -1 : 1));
  const counts = Object.fromEntries(PLAYER_MARKET_STATUSES.map((k) => [k, 0])) as Record<PlayerMarketStatus, number>;
  for (const p of players) counts[p.status] += 1;
  const ownership_id = hashOf(players.filter((p) => p.status === "ROSTERED").map((p) => [p.player_key, p.owner_team_id]));
  const universe_id = hashOf({ rules_v: MARKET_ELIGIBILITY_RULES_VERSION, ineligible, entries: players.filter((p) => p.status !== "ROSTERED").map((p) => [p.player_key, p.status, p.position, p.team, p.reason, p.entity, p.waiver_clears_on ?? null]) });
  const transactions_id = hashOf(input.transactions.source.status);
  const rules_id = hashOf({ rules, ok: rulesStructuralOk });
  const lock_id = hashOf(lockMap ? [...lockMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)) : null);

  const blocks = reasons.filter((r) => r.severity === "BLOCKING").map((r) => r.code);
  const limitations = reasons.filter((r) => r.severity !== "BLOCKING").map((r) => r.code);
  const has = (c: string) => reasons.some((r) => r.code === c && r.severity !== "BLOCKING");
  const availability: AxisStatus = blocks.length ? "NOT_READY" : has("PLAYER_UNIVERSE_PARTIAL") || has("ROSTER_STATE_PARTIAL") || has("OWNERSHIP_CONFLICT") ? "PARTIAL" : "READY";
  const transaction: AxisStatus = blocks.length ? "NOT_READY" : (has("WAIVER_RULES_PARTIAL") || has("PENDING_CLAIMS_UNAVAILABLE") || has("PENDING_CLAIMS_NOT_EXPOSED") || has("GAME_LOCK_UNVERIFIABLE") || has("WAIVER_STATE_UNVERIFIABLE") || has("WAIVER_CLEAR_TIME_NOT_EXPOSED") || pc.visibility !== "AVAILABLE") ? "PARTIAL" : "READY";
  const axes: ReadinessAxes = { availability, valuation: "UNKNOWN", transaction, recommendation: availability === "NOT_READY" ? "NOT_READY" : "PARTIAL" };
  const sources: MarketSources = { rules: input.rules.source, rosters: input.rosters.source, universe: input.pool.source, transactions: input.transactions.source, schedule: input.schedule.source };
  const readiness: MarketReadiness = { status: blocks.length ? "NOT_READY" : reasons.some((r) => r.severity === "LIMITING") ? "PARTIAL" : "READY", pool_actionable: blocks.length === 0, reasons: reasons.sort((a, b) => (a.code < b.code ? -1 : 1)), blocks: blocks.sort() as MarketReadiness["blocks"], limitations: limitations.sort() as MarketReadiness["limitations"], axes };

  const ageMs = oldestFetched == null ? null : Math.max(0, evaluatedMs - oldestFetched);
  const snapshot: MarketSnapshot = {
    market_state_version: MARKET_STATE_VERSION, eligibility_rules_version: MARKET_ELIGIBILITY_RULES_VERSION, league_slug: input.league_slug, season: input.season, week: input.week, as_of: input.as_of, provider: "yahoo",
    identities: { request_id: input.request_id, source_snapshot_id: input.source_snapshot_id, ownership_id, universe_id, transactions_id, rules_id, lock_id, scoring_fingerprint: input.scoring_fingerprint, market_content_id: "" },
    history_class: blocks.length ? "UNSAFE" : "TRUE_AS_OF", sources, readiness, acquisition, players, ineligible_counts: ineligible, counts,
    limitations: reasons.filter((r) => r.severity === "INFO").map((r) => r.detail),
    pending_claim_visibility: { status: pc.visibility, reason: pc.reason },
    game_lock_semantics: YAHOO_GAME_LOCK_SEMANTICS,
    ownership_reconciliation: recon,
    pool_evidence: Object.fromEntries((["FA", "W", "T"] as const).filter((k) => sub[k]).map((k) => [k, { returned: sub[k]!.returned, complete: sub[k]!.complete, pages_fetched: sub[k]!.pages_fetched, stopped_reason: sub[k]!.stopped_reason }])),
    freshness: { observed_at: oldestFetched == null ? input.as_of : iso(oldestFetched), evaluated_at: iso(evaluatedMs), age_ms: ageMs ?? 0, ttl_ms: staleMs, state: oldestFetched == null ? "UNKNOWN" : stale.length ? "STALE" : "FRESH" },
  };
  const idOf = (r: MarketReadiness) => `mkt:${input.season}:w${String(input.week).padStart(2, "0")}:${hashOf({ v: MARKET_STATE_VERSION, league: input.league_slug, season: input.season, week: input.week, ownership_id, universe_id, transactions_id, rules_id, blocks: r.blocks, limitations: r.limitations })}`;
  snapshot.identities.market_content_id = idOf(readiness);

  const violations = validateMarketSnapshot(snapshot);
  if (violations.length) {
    snapshot.readiness = { ...readiness, status: "NOT_READY", pool_actionable: false, blocks: [...readiness.blocks, "OWNERSHIP_INTEGRITY_VIOLATION"].sort() as MarketReadiness["blocks"], reasons: [...readiness.reasons, { code: "OWNERSHIP_INTEGRITY_VIOLATION", severity: "BLOCKING", detail: `${violations.length} violation(s): ${violations.slice(0, 3).map((x) => x.code).join(", ")}` }], axes: { ...axes, availability: "NOT_READY", transaction: "NOT_READY", recommendation: "NOT_READY" } };
    snapshot.history_class = "UNSAFE";
    snapshot.identities.market_content_id = idOf(snapshot.readiness);
  }
  return snapshot;
}
