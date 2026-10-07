/**
 * W1.P4 — source projection OBSERVATION history.
 *
 * A "source observation" is one fetch of an upstream NFL-level projection feed, recorded as league-INDEPENDENT facts (stat lines,
 * injury designation, team/opponent, games-played flag) — never league-scored fantasy points. Five fantasy leagues therefore share
 * ONE observation per upstream fetch and each applies its own scoring downstream.
 *
 * `source_observed_at` means exactly: "Bloodline fetched this source state at this instant". It is NOT a claim about when the
 * upstream (RotoWire) changed a value, and it is never set from snapshot-creation time.
 *
 * Capture policy (change-only, snapshot + delta):
 *   - same upstream fetch seen again (another league, another request)  -> nothing written (process memo + per-fetch key)
 *   - payload unchanged since the last RECORDED state                    -> nothing written except a cheap confirmation touch
 *   - first observation of (provider, season, week), or >= 24h since the last FULL anchor -> FULL (every row; independently replayable)
 *   - otherwise                                                          -> DELTA (only players whose recorded state materially changed,
 *                                                                           plus tombstones for players that left the feed)
 * Materiality: a non-stat field change (injury_status, team, opponent, gp), a stat key added/removed, or any stat value moving by
 * >= STAT_EPSILON from the LAST RECORDED value (so sub-epsilon drift accumulates until it crosses the threshold rather than being lost).
 */

import { contentHash } from "@/lib/bridge/hash";
import { makeEvent, InvalidationLedger, type InvalidationEvent } from "./events";

export const OBSERVATION_FORMAT = 1 as const;
export const STAT_EPSILON = 0.05;
export const FULL_ANCHOR_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** league-independent materiality proxy only (NOT a scoring formula): a change this large in a standard-points proxy is "material". */
export const MATERIAL_PROXY_POINTS = 2;

export interface SourcePlayerObservation {
  provider: string;
  provider_player_id: string;
  position: string | null;
  nfl_team: string | null;
  opponent: string | null;
  /** verbatim from the provider */
  injury_status: string | null;
  gp: number | null;
  /** raw component stat projection (league-independent) */
  stats: Record<string, number>;
}

export interface SourceObservationInput {
  provider: string;
  season: number;
  week: number;
  /** oldest READY segment fetch instant: the conservative "when did we observe this source state" */
  observed_at: string;
  by_segment: Record<string, string>;
  fetch_path: "LIVE_FETCH" | "PROCESS_CACHE" | "MIXED";
  players: SourcePlayerObservation[];
}

export interface SourceObservationHeader {
  observation_id: string;
  format: typeof OBSERVATION_FORMAT;
  provider: string;
  season: number;
  week: number;
  observed_at: string;
  content_hash: string;
  kind: "FULL" | "DELTA";
  base_observation_id: string | null;
  row_count: number;
  changed_count: number;
  removed_count: number;
  fetch_path: SourceObservationInput["fetch_path"];
  segments: Record<string, string>;
}

export interface RecordedPlayerRow {
  observation_id: string;
  provider_player_id: string;
  player_hash: string;
  removed: boolean;
  row: Omit<SourcePlayerObservation, "provider" | "provider_player_id"> | null;
}

export interface LatestSourceState {
  last_observation_id: string | null;
  last_observed_at: string | null;
  last_content_hash: string | null;
  last_full_at: string | null;
  /** current recorded state per provider_player_id (replayed) */
  players: Map<string, RecordedPlayerRow>;
}

export interface SourceObservationStore {
  readonly kind: string;
  latestState(provider: string, season: number, week: number): Promise<LatestSourceState>;
  append(a: { header: SourceObservationHeader; rows: RecordedPlayerRow[]; events: InvalidationEvent[] }): Promise<void>;
  /** unchanged payload re-observed: advance the confirmation pointer only (no history rows) */
  touch(provider: string, season: number, week: number, observed_at: string, content_hash: string): Promise<void>;
  /** headers (ascending) for history queries */
  headers(provider: string, season: number, week: number): Promise<SourceObservationHeader[]>;
  /** per-player state as of an instant: replay of FULL anchor + deltas with observed_at <= asOf */
  stateAsOf(provider: string, season: number, week: number, asOfIso: string): Promise<{ observation: SourceObservationHeader | null; players: Map<string, RecordedPlayerRow> }>;
  events(provider: string, season: number, week: number): Promise<InvalidationEvent[]>;
}

/* ------------------------------------------------------------------------------------------------------------ hashing / diff */

const round = (v: number): number => Math.round(v * 1e6) / 1e6;

export function playerHash(p: SourcePlayerObservation): string {
  const stats = Object.fromEntries(Object.entries(p.stats).map(([k, v]) => [k, round(v)]).sort(([a], [b]) => String(a).localeCompare(String(b))));
  return contentHash({ pos: p.position, team: p.nfl_team, opp: p.opponent, inj: p.injury_status, gp: p.gp, stats }).slice(0, 24);
}

export function observationContentHash(players: readonly SourcePlayerObservation[]): string {
  return contentHash(
    [...players].map((p) => [p.provider_player_id, playerHash(p)]).sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

const STD_PROXY: Record<string, number> = { pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2, fgm: 3, xpm: 1 };
const proxyPoints = (stats: Record<string, number>): number => Object.entries(stats).reduce((s, [k, v]) => s + (STD_PROXY[k] ?? 0) * v, 0);

export interface PlayerChange {
  provider_player_id: string;
  fields: string[];
  injury: { from: string | null; to: string | null } | null;
  team: { from: string | null; to: string | null } | null;
  opponent: { from: string | null; to: string | null } | null;
  gp: { from: number | null; to: number | null } | null;
  proxy_delta: number | null;
  max_stat_delta: number;
  stat_keys_changed: boolean;
}

/** Material change of `next` versus the last RECORDED row, or null if none. */
export function materialChange(prev: RecordedPlayerRow["row"], next: SourcePlayerObservation, id: string): PlayerChange | null {
  if (!prev) {
    return { provider_player_id: id, fields: ["NEW_PLAYER"], injury: null, team: null, opponent: null, gp: null, proxy_delta: null, max_stat_delta: 0, stat_keys_changed: false };
  }
  const fields: string[] = [];
  const injury = prev.injury_status !== next.injury_status ? { from: prev.injury_status, to: next.injury_status } : null;
  const team = prev.nfl_team !== next.nfl_team ? { from: prev.nfl_team, to: next.nfl_team } : null;
  const opponent = prev.opponent !== next.opponent ? { from: prev.opponent, to: next.opponent } : null;
  const gp = prev.gp !== next.gp ? { from: prev.gp, to: next.gp } : null;
  if (injury) fields.push("injury_status");
  if (team) fields.push("nfl_team");
  if (opponent) fields.push("opponent");
  if (gp) fields.push("gp");
  const keys = new Set([...Object.keys(prev.stats), ...Object.keys(next.stats)]);
  let maxDelta = 0;
  let keyChange = false;
  for (const k of keys) {
    const a = prev.stats[k];
    const b = next.stats[k];
    if (a === undefined || b === undefined) {
      keyChange = true;
      maxDelta = Math.max(maxDelta, Math.abs((b ?? 0) - (a ?? 0)));
    } else maxDelta = Math.max(maxDelta, Math.abs(b - a));
  }
  const statsMaterial = keyChange || maxDelta >= STAT_EPSILON;
  if (statsMaterial) fields.push("stats");
  if (fields.length === 0) return null;
  return { provider_player_id: id, fields, injury, team, opponent, gp, proxy_delta: statsMaterial ? round(proxyPoints(next.stats) - proxyPoints(prev.stats)) : null, max_stat_delta: round(maxDelta), stat_keys_changed: keyChange };
}

const UNAVAILABLE_LIST = /^(ir|injured reserve|pup|nfi|sus|dnr)/i;

export function eventsFromChange(provider: string, observedAt: string, c: PlayerChange): InvalidationEvent[] {
  const scope = { kind: "PLAYER" as const, provider, provider_player_id: c.provider_player_id };
  const out: InvalidationEvent[] = [];
  const mk = (type: InvalidationEvent["type"], authority: InvalidationEvent["authority"], detail: InvalidationEvent["detail"]) =>
    out.push(makeEvent({ type, scope, effective_at: null, known_at: observedAt, source: provider, authority, detail }));
  if (c.fields.includes("NEW_PLAYER")) return out; // appearing in the feed is not an invalidation
  if (c.injury) {
    mk("INJURY_STATUS_CHANGE", "PROVIDER_STATUS", { from: c.injury.from, to: c.injury.to });
    if (c.injury.to && UNAVAILABLE_LIST.test(c.injury.to)) mk("TRANSACTION_IR_PUP", "PROVIDER_STATUS", { to: c.injury.to });
  }
  if (c.gp && c.gp.to === 0) mk("PLAYER_INACTIVE", "PROVIDER_STATUS", { gp_from: c.gp.from, gp_to: 0 });
  if (c.team) mk("TEAM_CHANGE", "PROVIDER_STATUS", { from: c.team.from, to: c.team.to });
  if (c.opponent) mk("OPPONENT_CHANGE", "PROVIDER_STATUS", { from: c.opponent.from, to: c.opponent.to });
  if (c.fields.includes("stats")) {
    mk("PROJECTION_SOURCE_UPDATE", "DERIVED_FROM_OBSERVATION", { max_stat_delta: c.max_stat_delta, proxy_delta: c.proxy_delta });
    if (c.proxy_delta != null && Math.abs(c.proxy_delta) >= MATERIAL_PROXY_POINTS) mk("MATERIAL_PROJECTION_CHANGE", "DERIVED_FROM_OBSERVATION", { proxy_delta: c.proxy_delta });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ recorder */

export type CaptureOutcome =
  | { status: "SKIPPED_SAME_FETCH" }
  | { status: "UNCHANGED_CONFIRMED"; content_hash: string }
  | { status: "RECORDED"; header: SourceObservationHeader; events: InvalidationEvent[] }
  | { status: "ERROR"; error: string };

export class SourceObservationRecorder {
  #seen = new Set<string>();
  constructor(
    private readonly store: SourceObservationStore,
    private readonly ledger: InvalidationLedger = new InvalidationLedger(),
  ) {}
  get invalidations(): InvalidationLedger {
    return this.ledger;
  }

  async record(input: SourceObservationInput): Promise<CaptureOutcome> {
    const fetchKey = `${input.provider}|${input.season}|${input.week}|${input.observed_at}`;
    if (this.#seen.has(fetchKey)) return { status: "SKIPPED_SAME_FETCH" };
    this.#seen.add(fetchKey);
    try {
      const hash = observationContentHash(input.players);
      const state = await this.store.latestState(input.provider, input.season, input.week);
      const changes: PlayerChange[] = [];
      const rows: RecordedPlayerRow[] = [];
      const events: InvalidationEvent[] = [];
      const seenIds = new Set<string>();
      const needFull =
        state.last_observation_id == null ||
        state.last_full_at == null ||
        Date.parse(input.observed_at) - Date.parse(state.last_full_at) >= FULL_ANCHOR_INTERVAL_MS;

      const obsId = `srcobs:${contentHash({ p: input.provider, s: input.season, w: input.week, t: input.observed_at, h: hash }).slice(0, 20)}`;
      for (const p of input.players) {
        seenIds.add(p.provider_player_id);
        const prev = state.players.get(p.provider_player_id);
        const change = prev && !prev.removed ? materialChange(prev.row, p, p.provider_player_id) : materialChange(null, p, p.provider_player_id);
        const { provider: _p, provider_player_id: _id, ...rest } = p;
        void _p;
        void _id;
        if (change) {
          changes.push(change);
          events.push(...eventsFromChange(input.provider, input.observed_at, change));
        }
        if (needFull || change) rows.push({ observation_id: obsId, provider_player_id: p.provider_player_id, player_hash: playerHash(p), removed: false, row: rest });
      }
      let removed = 0;
      for (const [id, prev] of state.players) {
        if (!seenIds.has(id) && !prev.removed) {
          removed += 1;
          rows.push({ observation_id: obsId, provider_player_id: id, player_hash: "REMOVED", removed: true, row: null });
        }
      }

      if (!needFull && changes.length === 0 && removed === 0) {
        await this.store.touch(input.provider, input.season, input.week, input.observed_at, hash);
        return { status: "UNCHANGED_CONFIRMED", content_hash: hash };
      }
      const header: SourceObservationHeader = {
        observation_id: obsId,
        format: OBSERVATION_FORMAT,
        provider: input.provider,
        season: input.season,
        week: input.week,
        observed_at: input.observed_at,
        content_hash: hash,
        kind: needFull ? "FULL" : "DELTA",
        base_observation_id: needFull ? null : state.last_observation_id,
        row_count: rows.length,
        changed_count: changes.length,
        removed_count: removed,
        fetch_path: input.fetch_path,
        segments: input.by_segment,
      };
      await this.store.append({ header, rows, events });
      this.ledger.add(events);
      return { status: "RECORDED", header, events };
    } catch (e) {
      this.#seen.delete(fetchKey); // a failed capture may be retried; it must never block projections
      return { status: "ERROR", error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/* ------------------------------------------------------------------------------------------------------------- memory store */

export class MemorySourceObservationStore implements SourceObservationStore {
  readonly kind = "memory";
  #headers: SourceObservationHeader[] = [];
  #rows = new Map<string, RecordedPlayerRow[]>();
  #events: Array<InvalidationEvent & { provider: string; season: number; week: number }> = [];
  #latest = new Map<string, { id: string; at: string; hash: string }>();
  touches = 0;
  appends = 0;

  #k = (p: string, s: number, w: number) => `${p}|${s}|${w}`;

  async latestState(provider: string, season: number, week: number): Promise<LatestSourceState> {
    const hs = this.#headers.filter((h) => h.provider === provider && h.season === season && h.week === week).sort((a, b) => (a.observed_at < b.observed_at ? -1 : 1));
    const players = new Map<string, RecordedPlayerRow>();
    let lastFull: string | null = null;
    for (const h of hs) {
      if (h.kind === "FULL") {
        players.clear();
        lastFull = h.observed_at;
      }
      for (const r of this.#rows.get(h.observation_id) ?? []) {
        if (r.removed) players.set(r.provider_player_id, r);
        else players.set(r.provider_player_id, r);
      }
    }
    const l = this.#latest.get(this.#k(provider, season, week));
    const last = hs[hs.length - 1];
    return {
      last_observation_id: last?.observation_id ?? null,
      last_observed_at: l?.at ?? last?.observed_at ?? null,
      last_content_hash: l?.hash ?? last?.content_hash ?? null,
      last_full_at: lastFull,
      players,
    };
  }
  async append(a: { header: SourceObservationHeader; rows: RecordedPlayerRow[]; events: InvalidationEvent[] }): Promise<void> {
    if (this.#headers.some((h) => h.observation_id === a.header.observation_id)) return; // idempotent
    this.appends += 1;
    this.#headers.push(a.header);
    this.#rows.set(a.header.observation_id, a.rows);
    for (const e of a.events) if (!this.#events.some((x) => x.event_id === e.event_id)) this.#events.push({ ...e, provider: a.header.provider, season: a.header.season, week: a.header.week });
    this.#latest.set(this.#k(a.header.provider, a.header.season, a.header.week), { id: a.header.observation_id, at: a.header.observed_at, hash: a.header.content_hash });
  }
  async touch(provider: string, season: number, week: number, observed_at: string, content_hash: string): Promise<void> {
    this.touches += 1;
    const k = this.#k(provider, season, week);
    const cur = this.#latest.get(k);
    this.#latest.set(k, { id: cur?.id ?? "", at: observed_at, hash: content_hash });
  }
  async headers(provider: string, season: number, week: number): Promise<SourceObservationHeader[]> {
    return this.#headers.filter((h) => h.provider === provider && h.season === season && h.week === week).sort((a, b) => (a.observed_at < b.observed_at ? -1 : 1));
  }
  async stateAsOf(provider: string, season: number, week: number, asOfIso: string) {
    const hs = (await this.headers(provider, season, week)).filter((h) => h.observed_at <= asOfIso);
    const players = new Map<string, RecordedPlayerRow>();
    for (const h of hs) {
      if (h.kind === "FULL") players.clear();
      for (const r of this.#rows.get(h.observation_id) ?? []) players.set(r.provider_player_id, r);
    }
    return { observation: hs[hs.length - 1] ?? null, players };
  }
  async events(provider: string, season: number, week: number): Promise<InvalidationEvent[]> {
    return this.#events.filter((e) => e.provider === provider && e.season === season && e.week === week);
  }
  /** test/diagnostic: total rows persisted */
  totalRows(): number {
    return [...this.#rows.values()].reduce((s, r) => s + r.length, 0);
  }
}
