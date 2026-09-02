/**
 * Player identity crosswalk.
 *
 * Turns a provider's view of a player ("Sleeper player 4046", "yahoo player key
 * nfl.p.5479") into ONE canonical NFL identity that lines up across providers.
 *
 * Preference order for establishing identity:
 *   1. a stable cross-provider id (gsis id) via a {@link CrosswalkSource}
 *   2. the provider's own stable player id (stable within that provider)
 *   3. name + position + team   (fallback — flagged `high`)
 *   4. name + position          (fallback — flagged `low`)
 *   5. unresolved               (recorded, never guessed)
 *
 * The crosswalk source is optional and provider-independent: `NoCrosswalk` is
 * used in unit tests, a Supabase-backed implementation
 * (`lib/persistence/supabase/crosswalk-source.ts`) is used in production.
 */

import {
  normalizeName,
  playerId,
  playerNameKey,
} from "./ids";
import type {
  CanonicalPlayer,
  CanonicalPosition,
  PlayerIdentifiers,
  PlayerResolution,
  ProviderName,
  UnresolvedPlayer,
} from "./schema";

/** One row of a cross-provider identity table. Only known ids are populated. */
export interface CrosswalkRow {
  gsis_id?: string | null;
  sleeper_id?: string | null;
  yahoo_id?: string | null;
  yahoo_player_key?: string | null;
  espn_id?: string | null;
  pfr_id?: string | null;
  full_name: string;
  position: string | null;
  nfl_team: string | null;
}

export interface CrosswalkSource {
  readonly name: string;
  /** Load every known identity row. Implementations cache as appropriate. */
  load(): Promise<CrosswalkRow[]>;
}

/** No external identity data — provider ids and names only. */
export const NoCrosswalk: CrosswalkSource = {
  name: "none",
  load: async () => [],
};

const POSITION_MAP: Record<string, CanonicalPosition> = {
  QB: "QB",
  RB: "RB",
  FB: "RB",
  WR: "WR",
  TE: "TE",
  K: "K",
  PK: "K",
  DEF: "DEF",
  DST: "DEF",
  "D/ST": "DEF",
  DL: "DL",
  DE: "DL",
  DT: "DL",
  LB: "LB",
  ILB: "LB",
  OLB: "LB",
  DB: "DB",
  CB: "DB",
  S: "DB",
  SS: "DB",
  FS: "DB",
};

export function canonicalPosition(raw: string | null | undefined): CanonicalPosition {
  if (!raw) return "UNKNOWN";
  return POSITION_MAP[raw.toUpperCase().trim()] ?? "UNKNOWN";
}

/** A provider's raw observation of a player, before identity is established. */
export interface ObservedPlayer {
  provider: ProviderName;
  provider_player_id: string | null;
  full_name: string | null;
  first_name?: string | null;
  last_name?: string | null;
  position: string | null;
  nfl_team: string | null;
  status?: string | null;
  injury_status?: string | null;
  eligible_positions?: string[] | null;
  is_team_defense?: boolean;
  /** Ids the provider already handed us (Sleeper embeds several externally). */
  known_identifiers?: Partial<PlayerIdentifiers>;
}

export interface ResolvedIdentity {
  player: CanonicalPlayer;
  unresolved: UnresolvedPlayer | null;
}

interface CrosswalkIndex {
  bySleeper: Map<string, CrosswalkRow>;
  byYahoo: Map<string, CrosswalkRow>;
  /** name|position|team  -> rows */
  byNameKey: Map<string, CrosswalkRow[]>;
  /** name|position       -> rows */
  byNamePos: Map<string, CrosswalkRow[]>;
}

export class PlayerCrosswalk {
  private index: CrosswalkIndex = {
    bySleeper: new Map(),
    byYahoo: new Map(),
    byNameKey: new Map(),
    byNamePos: new Map(),
  };
  private loaded = false;

  constructor(private readonly source: CrosswalkSource = NoCrosswalk) {}

  static async create(source: CrosswalkSource = NoCrosswalk): Promise<PlayerCrosswalk> {
    const cw = new PlayerCrosswalk(source);
    await cw.ensureLoaded();
    return cw;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const rows = await this.source.load().catch(() => [] as CrosswalkRow[]);
    for (const row of rows) {
      if (row.sleeper_id) this.index.bySleeper.set(row.sleeper_id, row);
      if (row.yahoo_id) this.index.byYahoo.set(row.yahoo_id, row);
      if (row.yahoo_player_key) this.index.byYahoo.set(row.yahoo_player_key, row);
      const key = playerNameKey(row.full_name, row.position, row.nfl_team);
      const bucket = this.index.byNameKey.get(key) ?? [];
      bucket.push(row);
      this.index.byNameKey.set(key, bucket);
      const posKey = playerNameKey(row.full_name, row.position, null);
      const posBucket = this.index.byNamePos.get(posKey) ?? [];
      posBucket.push(row);
      this.index.byNamePos.set(posKey, posBucket);
    }
    this.loaded = true;
  }

  /** Establish (or fail to establish) a canonical identity for one observation. */
  resolve(observed: ObservedPlayer): ResolvedIdentity {
    const composed = [observed.first_name, observed.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    const name = observed.full_name ?? (composed.length > 0 ? composed : null);
    const isDef =
      observed.is_team_defense ||
      canonicalPosition(observed.position) === "DEF" ||
      (observed.provider === "sleeper" && /^[A-Z]{2,4}$/.test(observed.provider_player_id ?? ""));

    const identifiers: PlayerIdentifiers = { ...observed.known_identifiers };
    if (observed.provider === "sleeper" && observed.provider_player_id) {
      identifiers.sleeper_id = observed.provider_player_id;
    }
    if (observed.provider === "yahoo" && observed.provider_player_id) {
      identifiers.yahoo_player_key = observed.provider_player_id;
    }

    // 1. Cross-provider row via a stable provider id.
    let row: CrosswalkRow | undefined;
    if (identifiers.sleeper_id) row = this.index.bySleeper.get(identifiers.sleeper_id);
    if (!row && identifiers.yahoo_id) row = this.index.byYahoo.get(identifiers.yahoo_id);
    if (!row && identifiers.yahoo_player_key) row = this.index.byYahoo.get(identifiers.yahoo_player_key);

    // 2/3. Name-based fallback against the crosswalk.
    let method: PlayerResolution["method"] = "unresolved";
    let confidence: PlayerResolution["confidence"] = "none";

    if (row) {
      method = "stable_id";
      confidence = "exact";
    } else if (name && this.index.byNameKey.size > 0) {
      const exact = this.index.byNameKey.get(
        playerNameKey(name, observed.position, observed.nfl_team),
      );
      if (exact && exact.length === 1) {
        row = exact[0];
        method = "name_position_team";
        confidence = "high";
      } else {
        const posOnly = this.index.byNamePos.get(
          playerNameKey(name, observed.position, null),
        );
        if (posOnly && posOnly.length === 1) {
          row = posOnly[0];
          method = "name_position";
          confidence = "low";
        }
      }
    }

    if (row) {
      if (row.gsis_id) identifiers.gsis_id = row.gsis_id;
      if (row.sleeper_id) identifiers.sleeper_id = row.sleeper_id;
      if (row.yahoo_id) identifiers.yahoo_id = row.yahoo_id;
      if (row.yahoo_player_key) identifiers.yahoo_player_key = row.yahoo_player_key;
      if (row.espn_id) identifiers.espn_id = row.espn_id;
      if (row.pfr_id) identifiers.pfr_id = row.pfr_id;
    }

    // 4. Provider's own id, when there is no crosswalk hit at all.
    if (method === "unresolved" && (identifiers.sleeper_id || identifiers.yahoo_player_key || identifiers.yahoo_id)) {
      method = "stable_id";
      // Stable WITHIN the provider, not proven cross-provider.
      confidence = "high";
    }

    if (name) {
      identifiers.name_key = playerNameKey(name, observed.position, observed.nfl_team);
    }

    const resolvedName = row?.full_name ?? name;
    if (!resolvedName || method === "unresolved") {
      const unresolved: UnresolvedPlayer = {
        provider: observed.provider,
        provider_player_id: observed.provider_player_id,
        observed_name: name,
        observed_position: observed.position,
        observed_team: observed.nfl_team,
        reason: !resolvedName
          ? "no usable name or stable id"
          : "no stable id and name did not match a unique crosswalk row",
      };
      const canonicalId = playerId({
        gsisId: identifiers.gsis_id,
        sleeperId: identifiers.sleeper_id,
        yahooId: identifiers.yahoo_id ?? identifiers.yahoo_player_key,
        nameKey: identifiers.name_key,
      });
      return {
        player: buildPlayer(canonicalId, resolvedName ?? "Unknown player", observed, identifiers, {
          method: "unresolved",
          confidence: "none",
          note: unresolved.reason,
        }, isDef),
        unresolved,
      };
    }

    const canonicalId = playerId({
      gsisId: identifiers.gsis_id,
      sleeperId: identifiers.sleeper_id,
      yahooId: identifiers.yahoo_id ?? identifiers.yahoo_player_key,
      nameKey: identifiers.name_key,
    });

    return {
      player: buildPlayer(
        canonicalId,
        resolvedName,
        observed,
        identifiers,
        { method, confidence, note: null },
        isDef,
        row,
      ),
      unresolved: null,
    };
  }
}

function buildPlayer(
  canonicalId: string,
  fullName: string,
  observed: ObservedPlayer,
  identifiers: PlayerIdentifiers,
  resolution: PlayerResolution,
  isDef: boolean,
  row?: CrosswalkRow,
): CanonicalPlayer {
  const position = canonicalPosition(row?.position ?? observed.position);
  const eligible = (observed.eligible_positions ?? [])
    .map(canonicalPosition)
    .filter((p) => p !== "UNKNOWN");
  const parts = fullName.split(/\s+/);
  return {
    canonical_player_id: canonicalId,
    full_name: fullName,
    first_name: observed.first_name ?? (parts.length > 1 ? parts[0] ?? null : null),
    last_name: observed.last_name ?? (parts.length > 1 ? parts.slice(1).join(" ") : null),
    position: isDef ? "DEF" : position,
    eligible_positions: eligible.length > 0 ? eligible : [isDef ? "DEF" : position],
    nfl_team: row?.nfl_team ?? observed.nfl_team,
    is_team_defense: isDef,
    status: observed.status ?? null,
    injury_status: observed.injury_status ?? null,
    identifiers,
    resolution,
  };
}

/** Deterministic canonical name normalization, re-exported for tests. */
export { normalizeName };
