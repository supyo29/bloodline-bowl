/**
 * W1.P4 — Supabase persistence for source-observation history and final-pregame forecasts.
 *
 *   bridge_projection_source_observations      header per RECORDED observation (FULL anchor or DELTA)
 *   bridge_projection_source_observation_rows  changed players only (FULL: everyone), tombstones for players that left the feed
 *   bridge_projection_source_latest            mutable pointer: last observation seen/confirmed (+ last FULL anchor time)
 *   bridge_projection_source_events            derived invalidation events
 *   bridge_final_pregame_forecasts             league-scoped frozen pregame forecasts (DB CHECKs forbid post-kickoff observations)
 *
 * Reads are paginated in bounded pages (PostgREST caps responses at ~1000 rows) — the same discipline as the projection snapshot store.
 * Nothing here mutates league state or any production table.
 */

import {
  FULL_ANCHOR_INTERVAL_MS,
  type LatestSourceState,
  type RecordedPlayerRow,
  type SourceObservationHeader,
  type SourceObservationStore,
} from "@/lib/weekly/freshness/observation";
import type { InvalidationEvent } from "@/lib/weekly/freshness/events";
import { decideCandidate, type FinalPregameRecord, type FinalPregameStore, type FinalPregameWrite } from "@/lib/weekly/freshness/final-pregame";
import { loadSupabaseConfig, SupabaseRest } from "./rest";

const HEADERS = "bridge_projection_source_observations";
const ROWS = "bridge_projection_source_observation_rows";
const LATEST = "bridge_projection_source_latest";
const EVENTS = "bridge_projection_source_events";
const FINAL = "bridge_final_pregame_forecasts";
const PAGE = 1000;
const INSERT_CHUNK = 250;
const IN_CHUNK = 20;

interface HeaderRow extends Omit<SourceObservationHeader, "format"> {
  format: number;
}
interface LatestRow {
  provider: string;
  season: number;
  week: number;
  last_observation_id: string | null;
  last_observed_at: string;
  last_content_hash: string;
  last_full_at: string | null;
}
interface RowRow {
  observation_id: string;
  provider_player_id: string;
  player_hash: string;
  removed: boolean;
  row: RecordedPlayerRow["row"];
}
interface EventRow {
  event_id: string;
  provider: string;
  season: number;
  week: number;
  observation_id: string | null;
  type: InvalidationEvent["type"];
  scope: InvalidationEvent["scope"];
  effective_at: string | null;
  known_at: string;
  source: string;
  authority: InvalidationEvent["authority"];
  detail: InvalidationEvent["detail"];
}

const sf = (provider: string, season: number, week: number) => ({ provider: `eq.${provider}`, season: `eq.${season}`, week: `eq.${week}` });

async function paged<T>(rest: SupabaseRest, table: string, filter: Record<string, string>, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await rest.select<T>(table, { filter, order, limit: PAGE, offset });
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

export class SupabaseSourceObservationStore implements SourceObservationStore {
  readonly kind = "supabase";
  constructor(private readonly rest: SupabaseRest) {}

  async #headers(provider: string, season: number, week: number, extra: Record<string, string> = {}): Promise<HeaderRow[]> {
    return paged<HeaderRow>(this.rest, HEADERS, { ...sf(provider, season, week), ...extra }, "observed_at.asc");
  }

  async #rowsFor(ids: string[]): Promise<RowRow[]> {
    const out: RowRow[] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      out.push(...(await paged<RowRow>(this.rest, ROWS, { observation_id: `in.(${chunk.join(",")})` }, "observation_id.asc,provider_player_id.asc")));
    }
    return out;
  }

  async #replay(headers: HeaderRow[]): Promise<Map<string, RecordedPlayerRow>> {
    // replay from the last FULL anchor forward: bounded by the daily anchor, not by season length
    const lastFull = headers.map((h) => h.kind).lastIndexOf("FULL");
    const slice = lastFull < 0 ? headers : headers.slice(lastFull);
    const rows = await this.#rowsFor(slice.map((h) => h.observation_id));
    const byObs = new Map<string, RowRow[]>();
    for (const r of rows) (byObs.get(r.observation_id) ?? byObs.set(r.observation_id, []).get(r.observation_id)!).push(r);
    const players = new Map<string, RecordedPlayerRow>();
    for (const h of slice) {
      if (h.kind === "FULL") players.clear();
      for (const r of byObs.get(h.observation_id) ?? []) players.set(r.provider_player_id, { observation_id: r.observation_id, provider_player_id: r.provider_player_id, player_hash: r.player_hash, removed: r.removed, row: r.row });
    }
    return players;
  }

  async latestState(provider: string, season: number, week: number): Promise<LatestSourceState> {
    const [latest] = await this.rest.select<LatestRow>(LATEST, { filter: sf(provider, season, week), limit: 1 });
    const headers = await this.#headers(provider, season, week);
    const last = headers[headers.length - 1];
    const players = await this.#replay(headers);
    const fullAt = [...headers].reverse().find((h) => h.kind === "FULL")?.observed_at ?? null;
    return {
      last_observation_id: last?.observation_id ?? null,
      last_observed_at: latest?.last_observed_at ?? last?.observed_at ?? null,
      last_content_hash: latest?.last_content_hash ?? last?.content_hash ?? null,
      last_full_at: latest?.last_full_at ?? fullAt,
      players,
    };
  }

  async append(a: { header: SourceObservationHeader; rows: RecordedPlayerRow[]; events: InvalidationEvent[] }): Promise<void> {
    const h = a.header;
    await this.rest.insertIgnoreDuplicates(HEADERS, [{ ...h }], ["observation_id"]);
    for (let i = 0; i < a.rows.length; i += INSERT_CHUNK) {
      await this.rest.insertIgnoreDuplicates(
        ROWS,
        a.rows.slice(i, i + INSERT_CHUNK).map((r) => ({ observation_id: r.observation_id, provider_player_id: r.provider_player_id, player_hash: r.player_hash, removed: r.removed, row: r.row })),
        ["observation_id", "provider_player_id"],
      );
    }
    for (let i = 0; i < a.events.length; i += INSERT_CHUNK) {
      await this.rest.insertIgnoreDuplicates(
        EVENTS,
        a.events.slice(i, i + INSERT_CHUNK).map((e): EventRow => ({ event_id: e.event_id, provider: h.provider, season: h.season, week: h.week, observation_id: h.observation_id, type: e.type, scope: e.scope, effective_at: e.effective_at, known_at: e.known_at, source: e.source, authority: e.authority, detail: e.detail })),
        ["event_id"],
      );
    }
    const latest = { provider: h.provider, season: h.season, week: h.week, last_observation_id: h.observation_id, last_observed_at: h.observed_at, last_content_hash: h.content_hash, last_full_at: h.kind === "FULL" ? h.observed_at : null };
    const inserted = await this.rest.insertIgnoreDuplicates<LatestRow>(LATEST, [latest], ["provider", "season", "week"]);
    if (inserted.length === 0) {
      await this.rest.updateReturning(LATEST, { ...sf(h.provider, h.season, h.week), last_observed_at: `lt.${h.observed_at}` }, {
        last_observation_id: h.observation_id,
        last_observed_at: h.observed_at,
        last_content_hash: h.content_hash,
        ...(h.kind === "FULL" ? { last_full_at: h.observed_at } : {}),
        updated_at: new Date().toISOString(),
      });
    }
  }

  async touch(provider: string, season: number, week: number, observed_at: string, content_hash: string): Promise<void> {
    await this.rest.updateReturning(LATEST, { ...sf(provider, season, week), last_observed_at: `lt.${observed_at}` }, { last_observed_at: observed_at, last_content_hash: content_hash, updated_at: new Date().toISOString() });
  }

  async headers(provider: string, season: number, week: number): Promise<SourceObservationHeader[]> {
    return (await this.#headers(provider, season, week)) as SourceObservationHeader[];
  }

  async stateAsOf(provider: string, season: number, week: number, asOfIso: string) {
    const hs = await this.#headers(provider, season, week, { observed_at: `lte.${asOfIso}` });
    return { observation: (hs[hs.length - 1] as SourceObservationHeader | undefined) ?? null, players: await this.#replay(hs) };
  }

  async events(provider: string, season: number, week: number): Promise<InvalidationEvent[]> {
    const rows = await paged<EventRow>(this.rest, EVENTS, sf(provider, season, week), "known_at.asc");
    return rows.map((r) => ({ event_id: r.event_id, type: r.type, scope: r.scope, effective_at: r.effective_at, known_at: r.known_at, source: r.source, authority: r.authority, detail: r.detail }));
  }
}

interface FinalRow {
  league_slug: string;
  season: number;
  week: number;
  canonical_player_id: string;
  provider: string;
  kickoff_at: string;
  source_observed_at: string;
  confirmed_through: string;
  record: FinalPregameRecord;
}

export class SupabaseFinalPregameStore implements FinalPregameStore {
  readonly kind = "supabase";
  constructor(private readonly rest: SupabaseRest) {}

  #row(rec: FinalPregameRecord): FinalRow {
    return { league_slug: rec.league_slug, season: rec.season, week: rec.week, canonical_player_id: rec.canonical_player_id, provider: rec.provider, kickoff_at: rec.kickoff_at, source_observed_at: rec.source_observed_at, confirmed_through: rec.confirmed_through, record: rec };
  }

  async get(league_slug: string, season: number, week: number, canonical_player_id: string): Promise<FinalPregameRecord | null> {
    const [r] = await this.rest.select<FinalRow>(FINAL, { filter: { league_slug: `eq.${league_slug}`, season: `eq.${season}`, week: `eq.${week}`, canonical_player_id: `eq.${canonical_player_id}` }, limit: 1 });
    return r ? { ...r.record, confirmed_through: r.confirmed_through } : null;
  }

  async upsertCandidate(rec: FinalPregameRecord): Promise<FinalPregameWrite> {
    const out = await this.upsertMany([rec]);
    return (Object.entries(out).find(([, n]) => n > 0)?.[0] ?? "UNCHANGED") as FinalPregameWrite;
  }

  async upsertMany(recs: readonly FinalPregameRecord[]): Promise<Record<FinalPregameWrite, number>> {
    const out: Record<FinalPregameWrite, number> = { RECORDED: 0, CONFIRMED: 0, UNCHANGED: 0, REJECTED_POST_KICKOFF: 0, REJECTED_OLDER_OBSERVATION: 0, REJECTED_NO_KICKOFF: 0 };
    const groups = new Map<string, FinalPregameRecord[]>();
    for (const r of recs) (groups.get(`${r.league_slug}|${r.season}|${r.week}`) ?? groups.set(`${r.league_slug}|${r.season}|${r.week}`, []).get(`${r.league_slug}|${r.season}|${r.week}`)!).push(r);

    for (const [, group] of groups) {
      const first = group[0]!;
      // ONE paginated read of what is already frozen for this league/week
      const existingRows = await paged<FinalRow>(this.rest, FINAL, { league_slug: `eq.${first.league_slug}`, season: `eq.${first.season}`, week: `eq.${first.week}` }, "canonical_player_id.asc");
      const existing = new Map(existingRows.map((r) => [r.canonical_player_id, { ...r.record, confirmed_through: r.confirmed_through } as FinalPregameRecord]));
      const inserts: FinalPregameRecord[] = [];
      const replaces: FinalPregameRecord[] = [];
      const confirms: FinalPregameRecord[] = [];
      for (const rec of group) {
        const d = decideCandidate(existing.get(rec.canonical_player_id) ?? null, rec);
        out[d] += 1;
        if (d === "RECORDED") (existing.has(rec.canonical_player_id) ? replaces : inserts).push(rec);
        if (d === "CONFIRMED") confirms.push(rec);
      }
      for (let i = 0; i < inserts.length; i += INSERT_CHUNK) {
        await this.rest.insertIgnoreDuplicates(FINAL, inserts.slice(i, i + INSERT_CHUNK).map((r) => this.#row(r)), ["league_slug", "season", "week", "canonical_player_id"]);
      }
      for (const r of replaces) {
        await this.rest.updateReturning(FINAL, { league_slug: `eq.${r.league_slug}`, season: `eq.${r.season}`, week: `eq.${r.week}`, canonical_player_id: `eq.${r.canonical_player_id}`, confirmed_through: `lte.${r.source_observed_at}` }, this.#row(r));
      }
      if (confirms.length > 0) {
        // unchanged content confirmed by a newer valid observation: ONE batched update for the whole league/week (not one per player).
        // Rows already past kickoff are excluded by the filter, and the DB CHECK (confirmed_through <= kickoff_at) is the last line of defense.
        const at = confirms.reduce((m, r) => (Date.parse(r.confirmed_through) > Date.parse(m) ? r.confirmed_through : m), confirms[0]!.confirmed_through);
        const ids = confirms.map((r) => r.canonical_player_id);
        for (let i = 0; i < ids.length; i += 100) {
          await this.rest.updateReturning(FINAL, { league_slug: `eq.${first.league_slug}`, season: `eq.${first.season}`, week: `eq.${first.week}`, canonical_player_id: `in.(${ids.slice(i, i + 100).join(",")})`, kickoff_at: `gte.${at}`, confirmed_through: `lt.${at}` }, { confirmed_through: at });
        }
      }
    }
    return out;
  }
}

class NoopFinalPregameStore implements FinalPregameStore {
  readonly kind = "none";
  async upsertCandidate(): Promise<FinalPregameWrite> {
    return "UNCHANGED";
  }
  async upsertMany(): Promise<Record<FinalPregameWrite, number>> {
    return { RECORDED: 0, CONFIRMED: 0, UNCHANGED: 0, REJECTED_POST_KICKOFF: 0, REJECTED_OLDER_OBSERVATION: 0, REJECTED_NO_KICKOFF: 0 };
  }
  async get(): Promise<null> {
    return null;
  }
}

let cachedObs: SourceObservationStore | null = null;
let cachedFinal: FinalPregameStore | null = null;

/** Supabase when configured; otherwise null (the recorder then uses a process-local memory store so events still flow in-process). */
export function getSourceObservationStore(env: NodeJS.ProcessEnv = process.env): SourceObservationStore | null {
  if (env === process.env && cachedObs) return cachedObs;
  const cfg = loadSupabaseConfig(env);
  const store = cfg.configured && cfg.config ? new SupabaseSourceObservationStore(new SupabaseRest(cfg.config)) : null;
  if (env === process.env) cachedObs = store;
  return store;
}

export function getFinalPregameStore(env: NodeJS.ProcessEnv = process.env): FinalPregameStore {
  if (env === process.env && cachedFinal) return cachedFinal;
  const cfg = loadSupabaseConfig(env);
  const store: FinalPregameStore = cfg.configured && cfg.config ? new SupabaseFinalPregameStore(new SupabaseRest(cfg.config)) : new NoopFinalPregameStore();
  if (env === process.env) cachedFinal = store;
  return store;
}

export function __setObservationStores(obs: SourceObservationStore | null, fin: FinalPregameStore | null): void {
  cachedObs = obs;
  cachedFinal = fin;
}

/** retention note: FULL anchors bound replay; see docs for storage estimates */
export const OBSERVATION_FULL_ANCHOR_INTERVAL_MS = FULL_ANCHOR_INTERVAL_MS;
