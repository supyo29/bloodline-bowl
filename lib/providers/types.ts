/**
 * The provider abstraction.
 *
 * A `FantasyProvider` is the ONLY thing that talks to a fantasy platform's API.
 * Everything it returns is already in the canonical schema — a Sleeper roster
 * object or a Yahoo `<team>` collection never escapes this layer.
 *
 * Providers do not fabricate. A capability the provider cannot serve returns an
 * explicit degraded `ProviderResult` (`status: "AUTH_REQUIRED"`, `data: null`),
 * never a plausible-looking empty success.
 */

import type {
  CanonicalDraftPick,
  CanonicalFantasyTeam,
  CanonicalLeague,
  CanonicalManager,
  CanonicalMatchup,
  CanonicalPlayer,
  CanonicalRoster,
  CanonicalStanding,
  CanonicalTransaction,
  CanonicalWaiverState,
  CanonicalWarning,
  DegradedStatus,
  ProviderName,
  UnresolvedPlayer,
} from "@/lib/canonical/schema";
import type { PlayerCrosswalk } from "@/lib/canonical/players";

/** What a provider was asked about. */
export interface ProviderLeagueContext {
  /** Registry slug — the canonical league identity. */
  league_slug: string;
  /** Provider-native league id (Sleeper numeric id, Yahoo league key/id). */
  external_league_id: string;
  season: number;
  /** Shared identity resolver so every provider produces aligned player ids. */
  crosswalk: PlayerCrosswalk;
}

export interface TransactionQuery {
  /** Limit to a single fantasy week, else the provider sweeps the season. */
  week?: number | null;
  /** Cap on returned rows (providers may page internally). */
  limit?: number;
}

/**
 * Every provider call returns this envelope. `status` and `data` together tell
 * the caller exactly how much to trust the payload.
 */
export interface ProviderResult<T> {
  status: DegradedStatus;
  data: T | null;
  warnings: CanonicalWarning[];
  /** When the provider's copy of this data was last known-good. */
  provider_synced_at: string | null;
}

export function ok<T>(
  data: T,
  opts: { warnings?: CanonicalWarning[]; provider_synced_at?: string | null; status?: DegradedStatus } = {},
): ProviderResult<T> {
  return {
    status: opts.status ?? (opts.warnings && opts.warnings.length > 0 ? "PARTIAL" : "READY"),
    data,
    warnings: opts.warnings ?? [],
    provider_synced_at: opts.provider_synced_at ?? new Date().toISOString(),
  };
}

export function degraded<T>(
  status: DegradedStatus,
  code: string,
  message: string,
): ProviderResult<T> {
  return {
    status,
    data: null,
    warnings: [{ code, message }],
    provider_synced_at: null,
  };
}

/** Bundled league state — the shape the `/state` route and snapshots consume. */
export interface CanonicalLeagueStateBundle {
  league: CanonicalLeague;
  managers: CanonicalManager[];
  teams: CanonicalFantasyTeam[];
  rosters: CanonicalRoster[];
  standings: CanonicalStanding[];
  draft_picks: CanonicalDraftPick[];
  /** Every player referenced by the rosters above. */
  players: CanonicalPlayer[];
  unresolved_players: UnresolvedPlayer[];
}

export interface ProviderCapabilities {
  league: boolean;
  settings: boolean;
  managers: boolean;
  standings: boolean;
  rosters: boolean;
  matchups: boolean;
  transactions: boolean;
  players: boolean;
  free_agents: boolean;
  waivers: boolean;
  draft_results: boolean;
  /** True only once the provider can make authenticated calls for private data. */
  live_authenticated_access: boolean;
}

export interface ProviderHealth {
  provider: ProviderName;
  status: DegradedStatus;
  authentication: "NONE" | "OAUTH";
  detail: string;
  checked_at: string;
}

export interface FantasyProvider {
  readonly name: ProviderName;
  readonly authentication: "NONE" | "OAUTH";

  capabilities(): ProviderCapabilities;
  healthCheck(): Promise<ProviderHealth>;

  /** The bundled current-state read (league + managers + teams + rosters + standings + draft). */
  getLeagueState(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalLeagueStateBundle>>;

  /** Granular reads — conceptually the FantasyProvider surface from the spec. */
  getLeague(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalLeague>>;
  getManagers(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalManager[]>>;
  getStandings(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalStanding[]>>;
  getRosters(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalRoster[]>>;
  getMatchups(ctx: ProviderLeagueContext, week: number): Promise<ProviderResult<CanonicalMatchup[]>>;
  getTransactions(
    ctx: ProviderLeagueContext,
    query?: TransactionQuery,
  ): Promise<ProviderResult<CanonicalTransaction[]>>;
  getDraftResults(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalDraftPick[]>>;
  getWaiverState(ctx: ProviderLeagueContext): Promise<ProviderResult<CanonicalWaiverState>>;
}
