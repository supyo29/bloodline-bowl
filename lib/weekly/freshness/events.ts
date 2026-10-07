/**
 * W1.P4 — invalidation events. An event says "something material changed in the source world after your forecast's observation".
 * It is provider-neutral (identities are matched generically), carries the NARROWEST safe scope, and is data: nothing here fetches.
 *
 * Event SOURCES available today: (a) diffs between two source observations (the provider feed is the only live status source);
 * (b) the official-inactive seam below (no production feed implements it yet — see docs); (c) manual/ingested events. The contract
 * is extensible: a new source only needs to emit `InvalidationEvent`s.
 *
 * Scope hierarchy (narrow -> broad):  PLAYER  <  TEAM  <  GAME  <  SOURCE_SNAPSHOT.   LEAGUE_DERIVATIVE is orthogonal (one league's scored values).
 * Authority: OFFICIAL (team/league announced) > PROVIDER_STATUS (provider-reported designation) > DERIVED_FROM_OBSERVATION > MANUAL.
 */

import { contentHash } from "@/lib/bridge/hash";

export type InvalidationEventType =
  | "INJURY_STATUS_CHANGE"
  | "PLAYER_INACTIVE"
  | "OFFICIAL_INACTIVE"
  | "TRANSACTION_IR_PUP"
  | "TEAM_CHANGE"
  | "GAME_POSTPONED_OR_CANCELLED"
  | "OPPONENT_CHANGE"
  | "KICKOFF_CHANGE"
  | "PROJECTION_SOURCE_UPDATE"
  | "MATERIAL_PROJECTION_CHANGE"
  | "DEPTH_CHART_CHANGE"
  | "BYE_CORRECTION";

export type EventAuthority = "OFFICIAL" | "PROVIDER_STATUS" | "DERIVED_FROM_OBSERVATION" | "MANUAL";

export type InvalidationScope =
  | { kind: "PLAYER"; canonical_player_id?: string; provider?: string; provider_player_id?: string }
  | { kind: "TEAM"; nfl_team: string }
  | { kind: "GAME"; game_id?: string; teams?: [string, string] }
  | { kind: "SOURCE_SNAPSHOT"; provider: string; season: number; week: number }
  | { kind: "LEAGUE_DERIVATIVE"; league_slug: string };

export interface InvalidationEvent {
  event_id: string;
  type: InvalidationEventType;
  scope: InvalidationScope;
  /** when the football event became true, if the source says so. null = unknown (never invented). */
  effective_at: string | null;
  /** when BLOODLINE learned of it — the instant that decides whether an observation predates it */
  known_at: string;
  source: string;
  authority: EventAuthority;
  detail: Record<string, string | number | boolean | null>;
}

export function makeEvent(e: Omit<InvalidationEvent, "event_id">): InvalidationEvent {
  return { ...e, event_id: `evt:${contentHash({ t: e.type, s: e.scope, k: e.known_at, d: e.detail }).slice(0, 16)}` };
}

/** What an event is matched against: one forecast's identity and context. All provider ids are optional (Yahoo players have no sleeper id). */
export interface EventTarget {
  canonical_player_id: string;
  identifiers?: Partial<Record<"sleeper_id" | "yahoo_id" | "yahoo_player_key" | "gsis_id" | "espn_id" | "pfr_id", string>>;
  nfl_team?: string | null;
  game_id?: string | null;
  opponent?: string | null;
  league_slug?: string | null;
  provider?: string | null;
  season?: number;
  week?: number;
}

const PROVIDER_ID_KEYS: Record<string, Array<keyof NonNullable<EventTarget["identifiers"]>>> = {
  sleeper: ["sleeper_id"],
  yahoo: ["yahoo_id", "yahoo_player_key"],
  gsis: ["gsis_id"],
  nflverse: ["gsis_id"],
  espn: ["espn_id"],
};

export function scopeCovers(scope: InvalidationScope, t: EventTarget): boolean {
  switch (scope.kind) {
    case "PLAYER": {
      if (scope.canonical_player_id && scope.canonical_player_id === t.canonical_player_id) return true;
      if (scope.provider && scope.provider_player_id) {
        const keys = PROVIDER_ID_KEYS[scope.provider] ?? [];
        return keys.some((k) => t.identifiers?.[k] === scope.provider_player_id);
      }
      return false;
    }
    case "TEAM":
      return !!t.nfl_team && t.nfl_team.toUpperCase() === scope.nfl_team.toUpperCase();
    case "GAME": {
      if (scope.game_id && t.game_id === scope.game_id) return true;
      if (scope.teams && t.nfl_team) {
        const team = t.nfl_team.toUpperCase();
        return scope.teams.some((x) => x.toUpperCase() === team);
      }
      return false;
    }
    case "SOURCE_SNAPSHOT":
      return (t.season == null || t.season === scope.season) && (t.week == null || t.week === scope.week);
    case "LEAGUE_DERIVATIVE":
      return !!t.league_slug && t.league_slug === scope.league_slug;
  }
}

/** The breadth of an event's scope (for diagnostics and the targeted-invalidation guard). */
export function scopeBreadth(scope: InvalidationScope): number {
  return { PLAYER: 1, TEAM: 2, GAME: 3, LEAGUE_DERIVATIVE: 4, SOURCE_SNAPSHOT: 5 }[scope.kind];
}

/** Process-local ledger of events learned this process lifetime. Persistence of events is done by the observation store. */
export class InvalidationLedger {
  #events = new Map<string, InvalidationEvent>();
  add(events: readonly InvalidationEvent[]): number {
    let added = 0;
    for (const e of events) {
      if (!this.#events.has(e.event_id)) {
        this.#events.set(e.event_id, e);
        added += 1;
      }
    }
    return added;
  }
  all(): InvalidationEvent[] {
    return [...this.#events.values()].sort((a, b) => (a.known_at < b.known_at ? -1 : a.known_at > b.known_at ? 1 : a.event_id < b.event_id ? -1 : 1));
  }
  /** events whose scope covers this target (the narrowest-scope rule is enforced by `scopeCovers`) */
  affecting(t: EventTarget): InvalidationEvent[] {
    return this.all().filter((e) => scopeCovers(e.scope, t));
  }
  clear(): void {
    this.#events.clear();
  }
}

/* ------------------------------------------------------------------------------------------------ official inactives (seam) */

export interface OfficialInactiveRecord {
  season: number;
  week: number;
  provider?: string;
  provider_player_id?: string;
  canonical_player_id?: string;
  nfl_team: string;
  game_id?: string | null;
  /** when the team/league announced it, if the source says */
  announced_at: string | null;
  /** when Bloodline observed the announcement */
  observed_at: string;
  source: string;
}

/**
 * The seam for a game-day inactive source. AUDIT RESULT: no currently supported source exposes official inactives
 * (Sleeper's feed carries designations such as "Out", not the 90-minute pregame inactive list; ESPN's scoreboard has none), so NO
 * production implementation exists and none is fabricated. Any future source implements this interface; its output is high-authority.
 */
export interface OfficialInactiveSource {
  readonly name: string;
  getInactives(season: number, week: number): Promise<OfficialInactiveRecord[]>;
}

export function officialInactiveEvents(records: readonly OfficialInactiveRecord[]): InvalidationEvent[] {
  return records.map((r) =>
    makeEvent({
      type: "OFFICIAL_INACTIVE",
      scope: { kind: "PLAYER", canonical_player_id: r.canonical_player_id, provider: r.provider, provider_player_id: r.provider_player_id },
      effective_at: r.announced_at,
      known_at: r.observed_at,
      source: r.source,
      authority: "OFFICIAL",
      detail: { nfl_team: r.nfl_team, game_id: r.game_id ?? null, week: r.week },
    }),
  );
}
